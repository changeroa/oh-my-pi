import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";
import type { ExtensionLiveStartOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";
import * as liveTransport from "@oh-my-pi/pi-coding-agent/live/transport";
import type { LiveTransportOptions } from "@oh-my-pi/pi-coding-agent/live/transport";
import { LiveVisualizer } from "@oh-my-pi/pi-tui/apps/live-visualizer";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

/** Fake InteractiveModeContext plus typed capture channels for focus/mount traffic. */
interface ContextHarness {
	ctx: InteractiveModeContext;
	/** The editor stub the controller must restore after live mode ends. */
	editor: unknown;
	/** Every component handed to `ui.setFocus`, in order. */
	focused: unknown[];
	/** Every component handed to `editorContainer.addChild`, in order. */
	mounted: unknown[];
	/** Resolves when `ui.setFocus` sees the original editor again. */
	editorRefocused: Promise<void>;
}

function createContext(): ContextHarness {
	const editor = {
		getUseTerminalCursor: vi.fn(() => true),
		setUseTerminalCursor: vi.fn(),
	};
	const focused: unknown[] = [];
	const mounted: unknown[] = [];
	const refocused = Promise.withResolvers<void>();
	const ctx = {
		settings: Settings.isolated({ "live.voice": "vale" }),
		keybindings: { getKeys: vi.fn(() => ["ctrl+l"]) },
		session: { addExecutionHoldBlocker: () => () => {}, isExecutionHeld: false },
		extractAssistantText: vi.fn(() => ""),
		editor,
		editorContainer: {
			clear: vi.fn(),
			addChild: vi.fn((component: unknown) => {
				mounted.push(component);
			}),
		},
		ui: {
			getShowHardwareCursor: vi.fn(() => true),
			setShowHardwareCursor: vi.fn(),
			setFocus: vi.fn((component: unknown) => {
				focused.push(component);
				if (component === editor) refocused.resolve();
			}),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
		showError: vi.fn(),
		chatContainer: { children: [] },
		present: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, editor, focused, mounted, editorRefocused: refocused.promise };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

function createHoldContext() {
	const auth = createInMemoryAuthStorage();
	const provider = createMockModel({ responses: [] });
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5"), tools: [] },
			streamFn: provider.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	cleanups.push(async () => {
		await session.dispose();
		auth.close();
	});
	const harness = createContext();
	harness.ctx.session = session;
	return { ...harness, session };
}

describe("LiveCommandController", () => {
	it("forwards the selected voice across the live-session boundary", async () => {
		const { ctx } = createContext();
		let receivedVoice: string | undefined;
		const controller = new LiveCommandController(ctx, options => {
			receivedVoice = options.voice;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			expect(receivedVoice).toBe("vale");
		} finally {
			await controller.stop();
		}
	});

	it("stops the session and restores the editor when the live-toggle chord hits the focused visualizer", async () => {
		const { ctx, editor, focused, mounted, editorRefocused } = createContext();
		const stop = vi.fn(async () => {});
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockImplementation(stop);
			return session;
		});

		await controller.handleCommand();
		expect(controller.active).toBe(true);

		// The controller replaces and focuses the editor with the visualizer;
		// Ctrl+L must end the call from there, not just from the editor.
		const visualizer = focused[0];
		if (!(visualizer instanceof LiveVisualizer)) {
			throw new Error("expected the controller to focus a LiveVisualizer");
		}
		visualizer.handleInput("\x0c"); // Ctrl+L — the keypress alone must drive teardown
		await editorRefocused;

		expect(stop).toHaveBeenCalled();
		expect(mounted.at(-1)).toBe(editor);
		expect(focused.at(-1)).toBe(editor);
		// `active` stays true until #finish's fire-and-forget settling promise
		// clears; drain microtasks deterministically instead of sleeping.
		for (let i = 0; controller.active && i < 20; i++) await Promise.resolve();
		expect(controller.active).toBe(false);
	});

	it("gives an extension session its SDP answer, its events, and one end when `/live` stops it", async () => {
		const { ctx } = createContext();
		let receivedOffer: string | undefined;
		const controller = new LiveCommandController(ctx, options => {
			receivedOffer = options.sdpOffer;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockImplementation(async () => {
				options.callbacks.onPhase("listening");
				options.callbacks.onTranscript({ role: "user", turn: 1, text: "list files", final: true });
			});
			Object.defineProperty(session, "sdpAnswer", { value: "v=0 answer" });
			// Like the real controller: the terminal callback fires once, however often stop() runs.
			let ended = false;
			vi.spyOn(session, "stop").mockImplementation(async () => {
				if (ended) return;
				ended = true;
				options.callbacks.onTerminal();
			});
			return session;
		});
		const phases: string[] = [];
		const transcripts: string[] = [];
		const ends: (Error | undefined)[] = [];

		const live = await controller.startRemote({
			sdpOffer: "v=0 offer",
			onPhase: phase => {
				phases.push(phase);
				throw new Error("observer bug");
			},
			onTranscript: transcript => transcripts.push(transcript.text),
			onEnd: error => ends.push(error),
		});

		expect(receivedOffer).toBe("v=0 offer");
		expect(live).toMatchObject({ sdpAnswer: "v=0 answer", voice: "vale" });
		expect(phases).toEqual(["listening"]);
		expect(transcripts).toEqual(["list files"]);
		// A throwing observer must not end the call.
		expect(controller.active).toBe(true);
		await expect(controller.startRemote({ sdpOffer: "v=0 again" })).rejects.toThrow("already active");

		await controller.handleCommand();
		await live.stop();
		expect(ends).toEqual([undefined]);
	});

	it("lets exactly one of two starts queued behind a closing session win", async () => {
		const { ctx } = createContext();
		const cleanup = Promise.withResolvers<void>();
		const created: { session: LiveSessionController; options: LiveSessionControllerOptions }[] = [];
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			Object.defineProperty(session, "sdpAnswer", { value: `answer ${created.length}` });
			vi.spyOn(session, "start").mockResolvedValue();
			// The first session's teardown stays pending, so later starts wait on its cleanup.
			const isFirst = created.length === 0;
			vi.spyOn(session, "stop").mockImplementation(() => (isFirst ? cleanup.promise : Promise.resolve()));
			created.push({ session, options });
			return session;
		});

		await controller.startRemote({ sdpOffer: "first" });
		// The call drops on its own: the slot frees at once, its cleanup does not.
		created[0]!.options.callbacks.onTerminal(new Error("sideband closed"));
		const a = controller.startRemote({ sdpOffer: "a" });
		const b = controller.startRemote({ sdpOffer: "b" });
		cleanup.resolve();
		const results = await Promise.allSettled([a, b]);

		expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(results.find(result => result.status === "rejected")).toMatchObject({
			reason: expect.objectContaining({ message: expect.stringContaining("already active") }),
		});
		expect(created).toHaveLength(2);
		expect(controller.active).toBe(true);
	});

	it("rejects an extension start without an SDP offer before creating a session", async () => {
		const { ctx, mounted } = createContext();
		const factory = vi.fn((options: LiveSessionControllerOptions) => new LiveSessionController(options));
		const controller = new LiveCommandController(ctx, factory);
		const untyped = { sdpOffer: undefined } as unknown as ExtensionLiveStartOptions;

		await expect(controller.startRemote(untyped)).rejects.toThrow("non-empty sdpOffer");
		await expect(controller.startRemote({ sdpOffer: "  " })).rejects.toThrow("non-empty sdpOffer");
		expect(factory).not.toHaveBeenCalled();
		expect(mounted).toEqual([]);
		expect(controller.active).toBe(false);
	});

	it("surfaces a session factory failure from `/live` and puts the editor back", async () => {
		const { ctx, editor, mounted } = createContext();
		const controller = new LiveCommandController(ctx, () => {
			throw new Error("factory broke");
		});
		await expect(controller.handleCommand()).rejects.toThrow("factory broke");
		expect(mounted.at(-1)).toBe(editor);
		expect(controller.active).toBe(false);
	});
});

describe("realtime execution hold boundary", () => {
	it("refuses local and remote starts while held before creating or mounting a session", async () => {
		const { ctx, session, mounted } = createHoldContext();
		const factory = vi.fn((options: LiveSessionControllerOptions) => {
			const live = new LiveSessionController(options);
			vi.spyOn(live, "start").mockResolvedValue();
			vi.spyOn(live, "stop").mockResolvedValue();
			return live;
		});
		const controller = new LiveCommandController(ctx, factory);
		try {
			const held = await session.executionHold.hold();
			await expect(controller.handleCommand()).rejects.toThrow("held");
			await expect(controller.startRemote({ sdpOffer: "offer" })).rejects.toThrow("held");
			expect(factory).not.toHaveBeenCalled();
			expect(mounted).toEqual([]);
			await session.executionHold.release(held);
			await controller.handleCommand();
			expect(factory).toHaveBeenCalledTimes(1);
		} finally {
			await controller.stop();
			controller.dispose();
		}
	});

	it("requires explicit voice stop and actual cleanup before a held confirmation", async () => {
		const { ctx, session } = createHoldContext();
		const cleanup = Promise.withResolvers<void>();
		const stop = vi.fn(() => cleanup.promise);
		let starts = 0;
		const controller = new LiveCommandController(ctx, options => {
			const live = new LiveSessionController(options);
			vi.spyOn(live, "start").mockImplementation(async () => {
				starts++;
			});
			vi.spyOn(live, "stop").mockImplementation(stop);
			return live;
		});
		try {
			await controller.handleCommand();
			await expect(session.executionHold.hold()).rejects.toThrow("Realtime voice");
			expect(session.executionHold.getState().status).toBe("holding");
			expect(stop).not.toHaveBeenCalled();
			// The same /live toggle remains a stop operation while the latch is closed.
			const stopping = controller.handleCommand();
			await expect(session.executionHold.hold()).rejects.toThrow("Realtime voice");
			cleanup.resolve();
			await stopping;
			const held = await session.executionHold.hold();
			expect(held.status).toBe("held");
			await session.executionHold.release(held);
			expect(starts).toBe(1);
		} finally {
			cleanup.resolve();
			await controller.stop();
			controller.dispose();
		}
	});

	it("keeps an admitted connecting start visible even after its slot was stopped", async () => {
		const { ctx, session } = createHoldContext();
		const connect = Promise.withResolvers<void>();
		const controller = new LiveCommandController(ctx, options => {
			const live = new LiveSessionController(options);
			vi.spyOn(live, "start").mockImplementation(() => connect.promise);
			vi.spyOn(live, "stop").mockResolvedValue();
			Object.defineProperty(live, "sdpAnswer", { value: "answer" });
			return live;
		});
		const starting = controller.startRemote({ sdpOffer: "offer" });
		try {
			await expect(session.executionHold.hold()).rejects.toThrow("Realtime voice");
			await controller.stop();
			await expect(session.executionHold.hold()).rejects.toThrow("Realtime voice");
			connect.resolve();
			await starting;
			expect((await session.executionHold.hold()).status).toBe("held");
		} finally {
			connect.resolve();
			await starting;
			await controller.stop();
			controller.dispose();
		}
	});

	it("refuses both start paths queued behind closing cleanup after hold closes admission", async () => {
		const { ctx, session } = createHoldContext();
		const cleanup = Promise.withResolvers<void>();
		const created: LiveSessionControllerOptions[] = [];
		const controller = new LiveCommandController(ctx, options => {
			created.push(options);
			const live = new LiveSessionController(options);
			vi.spyOn(live, "start").mockResolvedValue();
			vi.spyOn(live, "stop").mockImplementation(() => cleanup.promise);
			Object.defineProperty(live, "sdpAnswer", { value: "answer" });
			return live;
		});
		try {
			await controller.startRemote({ sdpOffer: "first" });
			created[0]!.callbacks.onTerminal();
			const local = controller.handleCommand().catch(error => error);
			const remote = controller.startRemote({ sdpOffer: "queued" }).catch(error => error);
			await expect(session.executionHold.hold()).rejects.toThrow("Realtime voice");
			cleanup.resolve();
			expect(String(await local)).toContain("held");
			expect(String(await remote)).toContain("held");
			expect(created).toHaveLength(1);
			const held = await session.executionHold.hold();
			await session.executionHold.release(held);
			await Promise.resolve();
			expect(created).toHaveLength(1);
		} finally {
			cleanup.resolve();
			await controller.stop();
			controller.dispose();
		}
	});

	it("never confirms held after voice cleanup fails", async () => {
		const { ctx, session } = createHoldContext();
		const controller = new LiveCommandController(ctx, options => {
			const live = new LiveSessionController(options);
			vi.spyOn(live, "start").mockResolvedValue();
			vi.spyOn(live, "stop").mockRejectedValue(new Error("cleanup failed"));
			return live;
		});
		try {
			await controller.handleCommand();
			await expect(session.executionHold.hold()).rejects.toThrow("Realtime voice");
			await controller.stop();
			await expect(session.executionHold.hold()).rejects.toThrow("cleanup is unconfirmed");
			expect(session.executionHold.getState().status).toBe("holding");
		} finally {
			controller.dispose();
		}
	});

	it("rechecks admission immediately before the factory after a reentrant hold during mounting", async () => {
		const { ctx, session } = createHoldContext();
		let holding: Promise<unknown> | undefined;
		vi.spyOn(ctx.ui, "setFocus").mockImplementation(component => {
			if (component instanceof LiveVisualizer) holding = session.executionHold.hold();
		});
		const factory = vi.fn((options: LiveSessionControllerOptions) => new LiveSessionController(options));
		const controller = new LiveCommandController(ctx, factory);
		try {
			await expect(controller.startRemote({ sdpOffer: "offer" })).rejects.toThrow("held");
			await holding;
			expect(factory).not.toHaveBeenCalled();
			expect(session.executionHold.getState().status).toBe("held");
		} finally {
			controller.dispose();
		}
	});
});

describe("LiveSessionController with a caller-owned peer", () => {
	it("mutes by phase only and reports no levels", () => {
		const phases: string[] = [];
		const levels: number[][] = [];
		const session = new LiveSessionController({
			session: {} as unknown as LiveSessionControllerOptions["session"],
			extractAssistantText: () => "",
			sdpOffer: "v=0 offer",
			callbacks: {
				onPhase: phase => phases.push(phase),
				onLevels: (input, output) => levels.push([input, output]),
				onTranscript: () => {},
				onTerminal: () => {},
			},
		});
		session.toggleMute();
		expect(phases.at(-1)).toBe("muted");
		expect(session.muted).toBe(true);
		expect(levels).toEqual([]);
	});

	it("keeps a muted call muted when the server starts the session or delegates work", async () => {
		let onEvent: ((event: LiveServerEvent) => void) | undefined;
		// bun's spyOn types a class export's implementation as `never`; the controller only needs
		// a constructible stand-in, so a plain function (not an arrow: it is called with `new`) suffices.
		const transportSpy = vi.spyOn(liveTransport, "CodexLiveTransport") as unknown as {
			mockImplementation(implementation: (options: LiveTransportOptions) => object): void;
		};
		transportSpy.mockImplementation(function (options: LiveTransportOptions) {
			onEvent = options.callbacks.onEvent;
			return {
				connect: async () => {},
				setMuted: async () => {},
				send: async () => {},
				close: async () => {},
				sdpAnswer: "v=0 answer",
			};
		});
		const delegated: string[] = [];
		const phases: string[] = [];
		const agentSession = {
			modelRegistry: { authStorage: {} },
			sessionId: "s1",
			subscribe: () => () => {},
			sendCustomMessage: async (message: { content: string }) => {
				delegated.push(message.content);
			},
		} as unknown as LiveSessionControllerOptions["session"];
		const session = new LiveSessionController({
			session: agentSession,
			extractAssistantText: () => "",
			sdpOffer: "v=0 offer",
			callbacks: {
				onPhase: phase => phases.push(phase),
				onLevels: () => {},
				onTranscript: () => {},
				onTerminal: () => {},
			},
		});
		await session.start();
		session.toggleMute();
		onEvent!({ type: "session.started", session: { id: "rtc_1" } });
		onEvent!({
			type: "delegation.created",
			item: {
				type: "delegation",
				target: "client",
				id: "d1",
				content: [{ type: "input_text", text: "list files" }],
			},
		});

		expect(delegated).toEqual(["list files"]);
		// A remote peer re-enables its microphone on any phase but `muted`.
		expect(phases.slice(phases.indexOf("muted"))).toEqual(["muted"]);
		session.toggleMute();
		expect(phases.at(-1)).toBe("working");
		await session.stop();
	});
});
