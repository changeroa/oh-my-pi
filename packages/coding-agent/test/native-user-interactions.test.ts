import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Settings } from "../src/config/settings";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import { nativeTextResponse } from "../src/session/user-interaction-responses";
import { NativeInteractionBroker, type NativeInteractionEvent } from "../src/session/user-interactions";
import { AskTool } from "../src/tools/ask";
import type { ToolSession } from "../src/tools";

/** Real native dialog components and their existing resolver/cleanup paths; no terminal process. */
function harness() {
	let sessionId = "session-a";
	const events: NativeInteractionEvent[] = [];
	const broker = new NativeInteractionBroker(
		() => sessionId,
		() => ({ sourceEntryId: "user-entry", sourceOperationHash: "a".repeat(64) }),
		event => events.push(event),
	);
	const editor = Object.assign(new Text("", 0, 0), {
		getText: () => "",
		pendingImages: [],
		pasteInFlight: false,
		handleDraftEdit: () => {},
		focused: false,
	});
	const container = new Container();
	container.addChild(editor);
	const agent = new Agent();
	const ctx = {
		editor,
		editorContainer: container,
		ui: { terminal: { rows: 40, columns: 100 }, setFocus: vi.fn(), requestRender: vi.fn() },
		session: {
			userInteractions: broker,
			agent,
			getQueuedMessages: () => ({ steering: agent.peekSteeringQueue(), followUp: [] }),
			subscribe: (listener: (event: { type: string; steering: readonly unknown[] }) => void) =>
				agent.onQueueChange(() => listener({ type: "queue_update", steering: agent.peekSteeringQueue() })),
		},
	} as unknown as InteractiveModeContext;
	const controller = new ExtensionUiController(ctx);
	return {
		broker,
		controller,
		ctx,
		editor,
		container,
		events,
		agent,
		switchSession: () => {
			sessionId = "session-b";
		},
	};
}

beforeAll(() => initTheme());
afterEach(() => vi.restoreAllMocks());

describe("native user interaction bridge", () => {
	it("settles the real AskTool result with ordered multi-select, custom text and notes", async () => {
		const h = harness();
		const tool = new AskTool({
			hasUI: true,
			settings: Settings.isolated({ "ask.notify": "off", "speech.enabled": false }),
			getPlanModeState: () => ({ enabled: true }),
		} as unknown as ToolSession);
		const result = tool.execute(
			"ask-call",
			{
				questions: [
					{ id: "storage", question: "Storage?", options: [{ label: "SQLite" }, { label: "Postgres" }] },
					{ id: "features", question: "Features?", multi: true, options: [{ label: "Read" }, { label: "Write" }] },
				],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: { askDialog: h.controller.showAskDialog.bind(h.controller) },
				abort: vi.fn(),
			} as unknown as AgentToolContext,
		);
		const request = h.broker.list()[0]!;
		expect(request).toMatchObject({ kind: "ask", sourceEntryId: "user-entry", sourceOperationHash: "a".repeat(64) });
		const response = {
			kind: "submit" as const,
			answers: [
				{ id: "storage", selectedOptions: [], customInput: "  embedded store\nwith migrations  " },
				{ id: "features", selectedOptions: ["Read", "Write"], customInput: "audit", note: "  preserve note\n" },
			],
		};
		expect((await h.broker.respond(request.id, response, "owner-message-1")).status).toBe("applied");
		const actual = await result;
		expect(actual.details).toMatchObject({
			results: [
				{ id: "storage", selectedOptions: [], customInput: "  embedded store\nwith migrations  " },
				{ id: "features", selectedOptions: ["Read", "Write"], customInput: "audit", note: "  preserve note\n" },
			],
		});
		expect(actual.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("embedded store") }),
		]);
		expect(h.container.children).toEqual([h.editor]);
		expect(h.broker.list()).toEqual([]);
	});

	it("rejects reordered IDs, unknown labels and multiple single choices without closing the ask; accepts an empty multi answer", async () => {
		const h = harness();
		const waiting = h.controller.showAskDialog([
			{ id: "one", question: "One?", options: [{ label: "A" }, { label: "B" }] },
			{ id: "many", question: "Many?", multi: true, options: [{ label: "C" }] },
		]);
		const id = h.broker.list()[0]!.id;
		for (const answers of [
			[
				{ id: "many", selectedOptions: [] },
				{ id: "one", selectedOptions: ["A"] },
			],
			[
				{ id: "one", selectedOptions: ["unknown"] },
				{ id: "many", selectedOptions: [] },
			],
			[
				{ id: "one", selectedOptions: ["A", "B"] },
				{ id: "many", selectedOptions: [] },
			],
			[
				{ id: "one", selectedOptions: ["A"], customInput: "also custom" },
				{ id: "many", selectedOptions: [] },
			],
			[
				{ id: "one", selectedOptions: [], customInput: " \n " },
				{ id: "many", selectedOptions: [] },
			],
		])
			await expect(
				h.broker.respond(id, { kind: "submit", answers }, `invalid:${JSON.stringify(answers)}`),
			).rejects.toThrow();
		expect(h.broker.list().map(request => request.id)).toEqual([id]);
		await h.broker.respond(
			id,
			{
				kind: "submit",
				answers: [
					{ id: "one", selectedOptions: ["A"] },
					{ id: "many", selectedOptions: [] },
				],
			},
			"valid",
		);
		expect(await waiting).toMatchObject({
			kind: "submit",
			results: [{ selectedOptions: ["A"] }, { selectedOptions: [] }],
		});
	});

	it("enforces exactly the approval scopes actually offered and closes the native approval composer", async () => {
		const h = harness();
		const waiting = h.controller.showCollabAwareApproval({
			compact: "Write file",
			full: "Write notes.txt",
			toolCallId: "write-call",
			grants: [{ scope: "target", label: "Approve File", alwaysLabel: "Always Approve File" }],
		});
		const request = h.broker.list()[0]!;
		expect(request.toolCallId).toBe("write-call");
		expect(request.options?.map(option => option.id)).toEqual([
			"grant:target:once",
			"grant:target:always",
			"once",
			"deny",
		]);
		await expect(h.broker.respond(request.id, { kind: "submit", choice: "session" }, "no-session")).rejects.toThrow();
		await expect(
			h.broker.respond(request.id, { kind: "submit", choice: "grant:folder:always" }, "no-folder"),
		).rejects.toThrow();
		await h.broker.respond(request.id, { kind: "submit", choice: "grant:target:once" }, "exact-target");
		expect(await waiting).toEqual({ grant: "target", always: false });
		expect(h.ctx.approvalOwnsComposer).toBe(false);
		expect(h.container.children).toEqual([h.editor]);
	});

	it("does not let a remote approval override a same-tick native steering denial", async () => {
		const h = harness();
		const waiting = h.controller.showCollabAwareApproval({ compact: "Write file", full: "Write notes.txt" });
		const id = h.broker.list()[0]!.id;
		h.agent.steer({ role: "user", content: "Stop; preserve the file.", timestamp: 1 });
		const receipt = await h.broker.respond(id, { kind: "submit", choice: "once" }, "late-approval");
		expect(receipt.status).toBe("stale");
		expect(await waiting).toBe("deny");
		expect(h.container.children).toEqual([h.editor]);
	});

	it("lets a synchronous local selection win before remote delivery, and a remote winner cannot be overwritten locally", async () => {
		const h = harness();
		const local = h.controller.showHookSelector("Choose", ["A", "B"]);
		const localId = h.broker.list()[0]!.id;
		h.ctx.hookSelector!.handleInput("\r");
		expect((await h.broker.respond(localId, { kind: "submit", choice: "1" }, "late-remote")).status).toBe("stale");
		expect(await local).toBe("A");
		const remote = h.controller.showHookSelector("Choose again", ["A", "B"]);
		const oldComponent = h.ctx.hookSelector!;
		const remoteId = h.broker.list()[0]!.id;
		await h.broker.respond(remoteId, { kind: "submit", choice: "1" }, "first-remote");
		oldComponent.handleInput("\r");
		expect(await remote).toBe("B");
		expect(h.events.filter(event => event.type === "user_interaction_resolved").map(event => event.by)).toEqual([
			"local",
			"remote",
		]);
	});

	it("validates disabled selectors, confirmations and text editors while preserving native cleanup", async () => {
		const h = harness();
		const select = h.controller.showCollabAwareSelector("Settings", ["Session", "Once", "Deny"], {
			disabledIndices: [0],
		});
		let id = h.broker.list()[0]!.id;
		const detached = h.broker.list()[0]!;
		detached.options![0]!.disabled = false;
		await expect(h.broker.respond(id, { kind: "submit", choice: "0" }, "disabled")).rejects.toThrow();
		await h.broker.respond(id, { kind: "submit", choice: "1" }, "setting-once");
		expect(await select).toBe("Once");
		const confirm = h.controller.showHookConfirm("Confirm", "Proceed?");
		id = h.broker.list()[0]!.id;
		await expect(h.broker.respond(id, { kind: "submit", value: "true" }, "not-boolean")).rejects.toThrow();
		await h.broker.respond(id, { kind: "submit", value: false }, "confirm-no");
		expect(await confirm).toBe(false);
		const input = h.controller.showHookInput("Text", "placeholder");
		id = h.broker.list()[0]!.id;
		await h.broker.respond(id, { kind: "submit", value: "typed text" }, "input");
		expect(await input).toBe("typed text");
		const editor = h.controller.showCollabAwareEditor("Edit", "original");
		id = h.broker.list()[0]!.id;
		await h.broker.respond(id, { kind: "submit", value: "  line one\nline two\n" }, "editor");
		expect(await editor).toBe("  line one\nline two\n");
		expect(h.container.children).toEqual([h.editor]);
	});

	it("redacts secret metadata and refuses all remote secret answers without consuming the local dialog", async () => {
		const h = harness();
		const abort = new AbortController();
		const waiting = h.controller.showHookInput("Secret title", "sensitive placeholder", {
			secret: true,
			signal: abort.signal,
		});
		const request = h.broker.list()[0]!;
		expect(request.title).toBe("Local secret input required");
		expect(request.placeholder).toBeUndefined();
		await expect(h.broker.respond(request.id, { kind: "submit", value: "remote-secret" }, "secret")).rejects.toThrow(
			"local input",
		);
		expect(h.broker.list().map(item => item.id)).toEqual([request.id]);
		expect(JSON.stringify(h.events)).not.toContain("remote-secret");
		abort.abort();
		expect(await waiting).toBeUndefined();
	});

	it("makes duplicate operations idempotent, refuses mismatched reuse, and retains unknown/stale receipts", async () => {
		const h = harness();
		const waiting = h.controller.showHookInput("Name");
		const id = h.broker.list()[0]!.id;
		const response = { kind: "submit" as const, value: "Owner" };
		const first = await h.broker.respond(id, response, "message-id");
		expect(await waiting).toBe("Owner");
		expect(first.responseHash).toBe(new Bun.CryptoHasher("sha256").update(JSON.stringify(response)).digest("hex"));
		expect(await h.broker.respond(id, response, "message-id")).toEqual(first);
		expect(h.broker.responseStatus("message-id")).toEqual(first);
		await expect(h.broker.respond(id, { kind: "submit", value: "Different" }, "message-id")).rejects.toThrow(
			"reused",
		);
		await expect(h.broker.respond("another-request", response, "message-id")).rejects.toThrow("reused");
		expect(h.broker.responseStatus("not-delivered").status).toBe("missing");
		const unknown = await h.broker.respond("unknown", response, "unknown-operation");
		expect(unknown.status).toBe("stale");
		expect(await h.broker.respond("unknown", response, "unknown-operation")).toEqual(unknown);
	});

	it("rejects expired, aborted, session-switched and shutdown requests and never answers the replacement session", async () => {
		const h = harness();
		const local = Promise.withResolvers<string | undefined>();
		const expired = h.broker.run(
			{ kind: "input", title: "Expired", expiresAt: new Date(0).toISOString() },
			() => local.promise,
			nativeTextResponse,
			undefined,
		);
		const expiredEvent = h.events.find(event => event.type === "user_interaction_requested");
		if (!expiredEvent || expiredEvent.type !== "user_interaction_requested")
			throw new Error("No expired request event");
		expect(
			(await h.broker.respond(expiredEvent.request.id, { kind: "submit", value: "late" }, "expired")).status,
		).toBe("stale");
		expect(await expired).toBeUndefined();
		const caller = new AbortController();
		const aborted = h.controller.showHookInput("Abort", undefined, { signal: caller.signal });
		const abortedId = h.broker.list()[0]!.id;
		caller.abort();
		expect(await aborted).toBeUndefined();
		expect((await h.broker.respond(abortedId, { kind: "submit", value: "late" }, "aborted")).status).toBe("stale");
		const old = h.controller.showHookInput("Old session");
		const oldId = h.broker.list()[0]!.id;
		h.switchSession();
		expect((await h.broker.respond(oldId, { kind: "submit", value: "wrong session" }, "switch")).status).toBe(
			"stale",
		);
		expect(await old).toBeUndefined();
		const replacement = h.controller.showHookInput("Replacement");
		const replacementId = h.broker.list()[0]!.id;
		expect(h.broker.list()[0]!.sessionId).toBe("session-b");
		expect((await h.broker.respond(oldId, { kind: "submit", value: "still old" }, "switch-again")).status).toBe(
			"stale",
		);
		h.broker.invalidate(true);
		expect(await replacement).toBeUndefined();
		expect((await h.broker.respond(replacementId, { kind: "submit", value: "closed" }, "shutdown")).status).toBe(
			"stale",
		);
		expect(await h.controller.showHookInput("After shutdown")).toBeUndefined();
	});

	it("cancels queued surfaces on same-session epoch invalidation and bounds operation receipts", async () => {
		const h = harness();
		const first = h.controller.showHookInput("First");
		const queued = h.controller.showHookInput("Queued");
		const ids = h.broker.list().map(request => request.id);
		h.broker.invalidate();
		expect(await first).toBeUndefined();
		expect(await queued).toBeUndefined();
		expect(h.broker.list()).toEqual([]);
		for (const id of ids) expect((await h.broker.respond(id, { kind: "cancel" }, id)).status).toBe("stale");
		for (let index = 0; index < 1025; index++)
			await h.broker.respond("unknown", { kind: "cancel" }, `operation-${index}`);
		expect(h.broker.responseStatus("operation-0").status).toBe("missing");
		expect(h.broker.responseStatus("operation-1024").status).toBe("stale");
	});
});
