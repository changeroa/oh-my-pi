import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

async function harness() {
	initTheme();
	resetSettingsForTest();
	const dir = TempDir.createSync("@omp-execution-hold-");
	cleanups.push(() => dir.removeSync());
	await Settings.init({ inMemory: true, cwd: dir.path() });
	const auth = createInMemoryAuthStorage();
	cleanups.push(() => auth.close());
	auth.keys.setRuntime("anthropic", "test-key");
	let api: ExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	const { session } = await createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		modelRegistry: new ModelRegistry(auth),
		model: getBundledModel("anthropic", "claude-sonnet-4-5"),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		disableExtensionDiscovery: true,
		extensions: [
			pi => {
				api = pi;
				pi.on("session_start", (_event, ctx) => {
					context = ctx;
				});
			},
		],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
		cacheWarming: false,
		workspaceTree: { rootPath: dir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});
	cleanups.push(async () => {
		await session.executionHold.hold();
		await session.dispose();
	});
	const provider = createMockModel({ handler: () => ({ content: ["done"] }) });
	session.agent.streamFn = provider.stream;
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
	vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
	if (typeof process.stdin.setRawMode === "function")
		vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
	const mode = new InteractiveMode(session, "test");
	vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	cleanups.push(() => mode.stop());
	await mode.init();
	if (!api || !context) throw new Error("Extension did not initialize");
	return { api, context, session, provider, mode, dir };
}

describe("native extension execution hold", () => {
	it("is usable in the TUI, including rebound contexts, and disappears on headless rebind", async () => {
		const { session, context } = await harness();
		const hold = context.executionHold;
		expect(
			session.extensionRunner?.createContext(undefined, undefined, {
				kind: "sub",
				id: "child",
				name: "sub",
				depth: 0,
			}).executionHold,
		).toBeUndefined();
		if (!hold) throw new Error("TUI must advertise executionHold");
		const held = await hold.hold();
		await expect(session.newSession()).rejects.toThrow("held");
		await hold.release(held);
		await session.newSession();
		const rebound = session.extensionRunner?.createContext();
		expect(rebound?.executionHold?.getState().sessionId).toBe(session.sessionManager.getSessionId());
		await expect(hold.release(held)).rejects.toThrow("Stale");
		await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });
		expect(session.extensionRunner?.createContext().executionHold).toBeUndefined();
		expect(context.executionHold).toBeUndefined();
	});

	it("keeps admission closed when an already-admitted switch changes session during hold", async () => {
		const { session, api, context, provider } = await harness();
		const entered = Promise.withResolvers<void>();
		const releaseSwitch = Promise.withResolvers<void>();
		api.on("session_before_switch", async () => {
			entered.resolve();
			await releaseSwitch.promise;
		});
		const previousId = session.sessionManager.getSessionId();
		const switching = session.newSession();
		await entered.promise;
		const holding = context.executionHold!.hold();
		const oldToken = context.executionHold!.getState();
		await expect(holding).rejects.toThrow("unsettled");
		releaseSwitch.resolve();
		await switching;
		expect(session.sessionManager.getSessionId()).not.toBe(previousId);
		expect(context.executionHold!.getState().status).toBe("holding");
		await expect(session.prompt("must stay blocked")).rejects.toThrow("held");
		await expect(context.executionHold!.release(oldToken)).rejects.toThrow("Stale");
		expect(provider.calls).toHaveLength(0);
	});

	it("cancels and settles supported exec, then refuses exec and native delegation while held", async () => {
		const { session, api, context, dir } = await harness();
		const hold = context.executionHold!;
		const started = dir.join("started");
		const execution = api.exec("/bin/sh", ["-c", 'printf started > "$1"; sleep 60', "sh", started]);
		for (let i = 0; i < 200 && !(await Bun.file(started).exists()); i++) await Bun.sleep(5);
		expect(await Bun.file(started).text()).toBe("started");
		const held = await hold.hold();
		expect((await execution).killed).toBe(true);
		await expect((async () => api.exec("/bin/sh", ["-c", "exit 99"]))()).rejects.toThrow("held");
		let invoked = false;
		session.extensionRunner?.setNativeToolResolver(() => ({
			tool: {
				name: "native",
				label: "Native",
				description: "Native",
				parameters: type({}),
				async execute() {
					invoked = true;
					return { content: [{ type: "text", text: "bad" }] };
				},
			},
			makeContext: () => ({
				sessionManager: session.sessionManager,
				modelRegistry: session.modelRegistry,
				model: session.model,
				isIdle: () => true,
				hasQueuedMessages: () => false,
				abort: () => {},
			}),
		}));
		await expect(session.extensionRunner!.invokeNativeTool("native", {})).rejects.toThrow("held");
		expect(invoked).toBe(false);
		await hold.release(held);
	});

	it("does not run a tool when its approval completes after hold began", async () => {
		const { session, context } = await harness();
		const entered = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<void>();
		vi.spyOn(session.extensionRunner!, "getUIContext").mockReturnValue({
			...session.extensionRunner!.getUIContext(),
			approve: async () => {
				entered.resolve();
				await answer.promise;
				return "once";
			},
		});
		let executed = false;
		const wrapper = new ExtensionToolWrapper(
			{
				name: "hold-approval",
				label: "Hold approval",
				description: "Hold approval",
				parameters: type({}),
				approval: "exec",
				async execute() {
					executed = true;
					return { content: [{ type: "text", text: "ran" }] };
				},
			},
			session.extensionRunner!,
		);
		const executing = wrapper
			.execute("approval-1", {}, undefined, undefined, {
				sessionManager: session.sessionManager,
				modelRegistry: session.modelRegistry,
				model: session.model,
				isIdle: () => true,
				hasQueuedMessages: () => false,
				abort: () => {},
				settings: Settings.isolated({ "tools.approvalMode": "always-ask" }),
			})
			.catch(error => error);
		await Promise.race([
			entered.promise,
			executing.then(result => {
				throw new Error(`Approval did not open: ${String(result)}`);
			}),
		]);
		const holding = context.executionHold!.hold();
		await Bun.sleep(0);
		expect(context.executionHold!.getState().status).toBe("holding");
		answer.resolve();
		await executing;
		const held = await holding;
		expect(executed).toBe(false);
		await context.executionHold!.release(held);
		await Bun.sleep(0);
		expect(executed).toBe(false);
	});

	it("cancels bash hook setup before spawn and waits for that setup to settle", async () => {
		const { session, api, context, dir } = await harness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		api.on("user_bash", async () => {
			entered.resolve();
			await release.promise;
		});
		const resultPath = dir.join("must-not-exist");
		const running = session.executeBash(`touch ${resultPath}`).catch(error => error);
		await entered.promise;
		const holding = context.executionHold!.hold();
		await Bun.sleep(0);
		expect(context.executionHold!.getState().status).toBe("holding");
		release.resolve();
		expect(await running).toBeInstanceOf(Error);
		await holding;
		expect(await Bun.file(resultPath).exists()).toBe(false);
	});

	it("lets an extension command hold without waiting on its own command handler", async () => {
		const { api, session, provider } = await harness();
		let status: string | undefined;
		api.registerCommand("test-hold", {
			description: "Hold this session",
			handler: async (_args, ctx) => {
				status = (await ctx.executionHold!.hold()).status;
			},
		});
		await session.prompt("/test-hold");
		await Bun.sleep(0);
		expect(status).toBe("held");
		expect(provider.calls).toHaveLength(0);
	});

	it("can be awaited by before_agent_start without waiting on its own handler", async () => {
		const { api, session, context, provider } = await harness();
		let status: string | undefined;
		api.on("before_agent_start", async () => {
			status = (await context.executionHold!.hold()).status;
		});
		await session.prompt("intercepted");
		await Bun.sleep(0);
		expect(status).toBe("held");
		expect(provider.calls).toHaveLength(0);
	});
});
