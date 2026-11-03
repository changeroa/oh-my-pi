import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-tui/overlays/ask-dialog";

export interface NativeUserInteraction {
	id: string;
	sessionId: string;
	kind: "ask" | "select" | "confirm" | "input" | "editor" | "approval" | "plan-review";
	title: string;
	message?: string;
	questions?: ExtensionAskDialogQuestion[];
	options?: { id: string; label: string; description?: string; disabled?: boolean }[];
	placeholder?: string;
	defaultValue?: string;
	secret?: boolean;
	tiers?: { role: string; provider: string; model: string; thinkingLevel?: string }[];
	sourceEntryId?: string;
	sourceOperationHash?: string;
	toolCallId?: string;
	createdAt: string;
	expiresAt?: string;
}

export type NativeUserInteractionResponse =
	| {
			kind: "submit";
			answers?: { id: string; selectedOptions: string[]; customInput?: string; note?: string }[];
			value?: string | boolean;
			choice?: string;
			feedback?: string;
			role?: string;
	  }
	| { kind: "cancel" };
export interface NativeInteractionReceipt {
	status: "applied" | "stale";
	requestId: string;
	operationId: string;
	responseHash: string;
}
export interface NativeInteractionStatus {
	status: "missing" | "pending" | "applied" | "stale";
	requestId?: string;
	operationId: string;
	responseHash?: string;
}
export interface NativeUserInteractions {
	list(): NativeUserInteraction[];
	respond(
		requestId: string,
		response: NativeUserInteractionResponse,
		operationId: string,
	): Promise<NativeInteractionReceipt>;
	responseStatus(operationId: string): NativeInteractionStatus;
}
export interface UserInteractionRequestedEvent {
	type: "user_interaction_requested";
	request: NativeUserInteraction;
}
export interface UserInteractionResolvedEvent {
	type: "user_interaction_resolved";
	requestId: string;
	sessionId: string;
	by: "local" | "remote" | "cancelled";
}
export type NativeInteractionEvent = UserInteractionRequestedEvent | UserInteractionResolvedEvent;
export type NativeInteractionDraft = Omit<NativeUserInteraction, "id" | "sessionId" | "createdAt">;

interface PendingInteraction {
	request: NativeUserInteraction;
	apply(response: NativeUserInteractionResponse): boolean;
	cancel(): void;
}

/** Session-owned pending native resolvers. No transport, history or model-turn submission. */
export class NativeInteractionBroker implements NativeUserInteractions {
	#pending = new Map<string, PendingInteraction>();
	#operations = new Map<string, NativeInteractionReceipt>();
	#sessionId: string | undefined;
	#closed = false;
	constructor(
		readonly getSessionId: () => string,
		readonly getSource: () => { sourceEntryId?: string; sourceOperationHash?: string },
		readonly emit: (event: NativeInteractionEvent) => void = () => {},
	) {}

	#sync(): void {
		const sessionId = this.getSessionId();
		if (this.#sessionId !== undefined && this.#sessionId !== sessionId) this.invalidate();
		this.#sessionId = sessionId;
	}

	list(): NativeUserInteraction[] {
		this.#sync();
		for (const pending of this.#pending.values()) {
			if (pending.request.expiresAt && Date.parse(pending.request.expiresAt) <= Date.now()) pending.cancel();
		}
		return structuredClone([...this.#pending.values()].map(pending => pending.request));
	}

	/** Invalidate before a session identity/branch rewrite, including same-id reloads. */
	invalidate(close = false): void {
		this.#closed ||= close;
		for (const pending of this.#pending.values()) pending.cancel();
	}

	responseStatus(operationId: string): NativeInteractionStatus {
		this.#sync();
		return { ...(this.#operations.get(operationId) ?? { status: "missing" }), operationId };
	}

	async respond(
		requestId: string,
		response: NativeUserInteractionResponse,
		operationId: string,
	): Promise<NativeInteractionReceipt> {
		if (typeof operationId !== "string" || !operationId || typeof requestId !== "string" || !requestId)
			throw new Error("Interaction and operation IDs are required");
		if (!response || typeof response !== "object" || (response.kind !== "submit" && response.kind !== "cancel"))
			throw new Error("Invalid native interaction response");
		this.#sync();
		if (this.#pending.get(requestId)?.request.secret) throw new Error("Secret interaction requires local input");
		// Hash the exact wire object, before any normalization. Synchronous hashing keeps admission atomic.
		const responseHash = new Bun.CryptoHasher("sha256").update(JSON.stringify(response)).digest("hex");
		const previous = this.#operations.get(operationId);
		if (previous) {
			if (previous.requestId !== requestId || previous.responseHash !== responseHash)
				throw new Error("Interaction operation ID reused with a different request or response");
			return { ...previous };
		}
		const pending = this.#pending.get(requestId);
		let applied = false;
		if (pending) {
			if (pending.request.expiresAt && Date.parse(pending.request.expiresAt) <= Date.now()) pending.cancel();
			else applied = pending.apply(response);
		}
		const receipt: NativeInteractionReceipt = {
			status: applied ? "applied" : "stale",
			requestId,
			operationId,
			responseHash,
		};
		this.#operations.set(operationId, receipt);
		if (this.#operations.size > 1024) this.#operations.delete(this.#operations.keys().next().value!);
		return { ...receipt };
	}

	/** Resolve the caller's real UI promise; abort removes its local/guest surface before returning. */
	run<T>(
		draft: NativeInteractionDraft,
		local: (signal: AbortSignal, settled: (value: T) => void) => Promise<T>,
		decode: (response: NativeUserInteractionResponse) => T,
		cancelled: T,
		signal?: AbortSignal,
	): Promise<T> {
		this.#sync();
		if (this.#closed || signal?.aborted) return Promise.resolve(cancelled);
		const controller = new AbortController();
		const request: NativeUserInteraction = structuredClone({
			...draft,
			...this.getSource(),
			id: crypto.randomUUID(),
			sessionId: this.getSessionId(),
			createdAt: new Date().toISOString(),
		});
		if (request.secret) {
			request.title = "Local secret input required";
			delete request.message;
			delete request.placeholder;
			delete request.defaultValue;
		}
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let settled = false;
		let applying = false;
		const finish = (value: T, by: UserInteractionResolvedEvent["by"]): boolean => {
			if (settled) return false;
			settled = true;
			this.#pending.delete(request.id);
			signal?.removeEventListener("abort", cancel);
			if (by !== "local") controller.abort();
			resolve(value);
			// Publish after atomic admission records the receipt, so resolved handlers can reconcile it.
			queueMicrotask(() =>
				this.emit({ type: "user_interaction_resolved", requestId: request.id, sessionId: request.sessionId, by }),
			);
			return true;
		};
		const cancel = () => {
			finish(cancelled, "cancelled");
		};
		this.#pending.set(request.id, {
			request,
			cancel,
			apply: response => {
				applying = true;
				let value: T;
				try {
					value = decode(response);
				} finally {
					applying = false;
				}
				return finish(value, "remote");
			},
		});
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			const localPromise = local(controller.signal, value => {
				if (!applying) finish(value, "local");
			});
			void localPromise.then(
				value => finish(value, "local"),
				error => {
					if (settled) return;
					settled = true;
					this.#pending.delete(request.id);
					signal?.removeEventListener("abort", cancel);
					controller.abort();
					reject(error);
					this.emit({
						type: "user_interaction_resolved",
						requestId: request.id,
						sessionId: request.sessionId,
						by: "cancelled",
					});
				},
			);
			if (!settled) this.emit({ type: "user_interaction_requested", request: structuredClone(request) });
		} catch (error) {
			settled = true;
			this.#pending.delete(request.id);
			signal?.removeEventListener("abort", cancel);
			controller.abort();
			reject(error);
		}
		return promise;
	}
}
