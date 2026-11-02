/** Opt-in bridge to harness-runtime. See docs/harness-runtime.md. */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ptree } from "@oh-my-pi/pi-utils";

export interface HarnessSession {
	id: string;
	file?: string;
	cwd: string;
}
export interface HarnessPayload {
	runtime: "omp";
	session_id: string;
	session_path?: string;
	cwd: string;
	turn_id?: string;
	hook_event_name: string;
	prompt?: string;
	tool_name?: string;
	tool_input?: unknown;
	stop_hook_active?: boolean;
}
export interface HarnessResponse {
	hookSpecificOutput?: {
		additionalContext?: string;
		permissionDecision?: string;
		permissionDecisionReason?: string;
	};
	decision?: string;
	reason?: string;
	systemMessage?: string;
}
export type HarnessHook = (payload: HarnessPayload) => Promise<HarnessResponse>;

export function createHarnessHook(cli: string, state: string): HarnessHook {
	if (!path.isAbsolute(cli) || !path.isAbsolute(state)) {
		throw new Error("Harness CLI and state directory must be absolute paths");
	}
	return async payload => {
		const result = await ptree.exec(["node", cli, "hook"], {
			input: JSON.stringify(payload),
			cwd: payload.cwd,
			env: { ...process.env, HARNESS_STATE_DIR: state },
			timeout: 5000,
		});
		if (result.stdout.length > 65536) throw new Error("Harness hook response exceeds 64 KiB");
		const response: unknown = JSON.parse(result.stdout || "{}");
		if (!response || typeof response !== "object" || Array.isArray(response)) {
			throw new Error("Invalid harness hook response");
		}
		return response as HarnessResponse;
	};
}

/** Session switches drain the old identity before the new identity can receive hooks. */
export class HarnessBridge {
	#hook: HarnessHook;
	#session?: HarnessSession;
	#turn?: string;
	#pending: string[] = [];
	#queue: Promise<unknown> = Promise.resolve();

	constructor(hook: HarnessHook) {
		this.#hook = hook;
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(operation, operation);
		this.#queue = result.catch(() => undefined);
		return result;
	}

	async #send(event: string, extra: Partial<HarnessPayload> = {}): Promise<HarnessResponse> {
		const session = this.#session;
		if (!session) return {};
		return this.#hook({
			...extra,
			runtime: "omp",
			session_id: session.id,
			session_path: session.file,
			cwd: session.cwd,
			turn_id: this.#turn,
			hook_event_name: event,
		});
	}

	async #select(session: HarnessSession) {
		if (this.#session?.id === session.id && this.#session.file === session.file && this.#session.cwd === session.cwd)
			return;
		if (this.#session) await this.#send("SessionEnd");
		this.#session = session;
		this.#turn = undefined;
		this.#pending = [];
		const result = await this.#send("SessionStart");
		const context = result.hookSpecificOutput?.additionalContext;
		if (context) this.#pending.push(context);
	}

	start(session: HarnessSession): Promise<void> {
		return this.#serialize(() => this.#select(session));
	}

	prompt(session: HarnessSession, prompt: string): Promise<string | undefined> {
		return this.#serialize(async () => {
			await this.#select(session);
			this.#turn = crypto.randomUUID();
			const result = await this.#send("UserPromptSubmit", { prompt });
			const context = result.hookSpecificOutput?.additionalContext;
			if (context) this.#pending.push(context);
			const combined = this.#pending.join("\n");
			this.#pending = [];
			return combined || undefined;
		});
	}

	tool(session: HarnessSession, name: string, input: unknown): Promise<HarnessResponse> {
		return this.#serialize(async () => {
			await this.#select(session);
			// OMP supplies the effective cwd; retain it in the harness's lossless command shape.
			const toolName =
				name === "bash" ? "exec_command" : name === "edit" ? "Edit" : name === "write" ? "Write" : name;
			const bash = input && typeof input === "object" ? (input as { command?: unknown; cwd?: unknown }) : {};
			const toolInput =
				name === "bash"
					? {
							cmd: bash.command,
							workdir: path.resolve(session.cwd, typeof bash.cwd === "string" ? bash.cwd : "."),
						}
					: input;
			return this.#send("PreToolUse", { tool_name: toolName, tool_input: toolInput });
		});
	}

	stop(active: boolean): Promise<HarnessResponse> {
		return this.#serialize(() => this.#send("Stop", { stop_hook_active: active }));
	}

	interrupt(): Promise<HarnessResponse> {
		return this.#serialize(() => this.#send("Interrupt"));
	}

	shutdown(): Promise<void> {
		return this.#serialize(async () => {
			await this.#send("SessionEnd");
			this.#session = undefined;
			this.#turn = undefined;
			this.#pending = [];
		});
	}
}

function sessionRef(ctx: ExtensionContext): HarnessSession {
	return { id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd };
}

export function registerHarnessRuntime(pi: ExtensionAPI, hook: HarnessHook) {
	const bridge = new HarnessBridge(hook);
	const main = (ctx: ExtensionContext) => ctx.agent.kind === "main";

	pi.on("session_start", async (_event, ctx) => {
		if (main(ctx)) await bridge.start(sessionRef(ctx));
	});
	pi.on("session_switch", async (_event, ctx) => {
		if (main(ctx)) await bridge.start(sessionRef(ctx));
	});
	pi.on("before_agent_start", async (event, ctx) => {
		if (!main(ctx) || event.reason !== "prompt") return;
		const content = await bridge.prompt(sessionRef(ctx), event.prompt);
		if (content) return { message: { customType: "harness-runtime", content, display: false } };
	});
	pi.on("tool_call", async (event, ctx) => {
		if (!main(ctx)) return;
		try {
			const result = await bridge.tool(sessionRef(ctx), event.toolName, event.input);
			const output = result.hookSpecificOutput;
			if (output?.permissionDecision === "deny") return { block: true, reason: output.permissionDecisionReason };
			if (output?.additionalContext) return { additionalContext: output.additionalContext };
		} catch (error) {
			pi.logger.warn("Harness pre-tool check failed", { error: String(error) });
			return {
				block: true,
				reason: "Harness pre-tool check unavailable; inspect the harness configuration and retry.",
			};
		}
	});
	pi.on("session_stop", async (event, ctx) => {
		if (!main(ctx)) return;
		const result = await bridge.stop(event.stop_hook_active);
		const warning = result.reason || result.systemMessage;
		if (warning) {
			pi.logger.warn("Harness completion verification", { warning });
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
		}
		// Phase one records verification, but does not request automatic continuation.
	});
	pi.on("agent_end", async (event, ctx) => {
		if (!main(ctx)) return;
		const last = event.messages.findLast(message => message.role === "assistant");
		if (last?.role === "assistant" && last.stopReason === "aborted") await bridge.interrupt();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (main(ctx)) await bridge.shutdown();
	});
}

export default function harnessRuntime(pi: ExtensionAPI) {
	const cli = process.env.HARNESS_RUNTIME_PATH;
	const state = process.env.HARNESS_STATE_DIR;
	if (!cli && !state) return;
	if (!cli || !state) throw new Error("Set both HARNESS_RUNTIME_PATH and a dedicated HARNESS_STATE_DIR");
	registerHarnessRuntime(pi, createHarnessHook(cli, state));
}
