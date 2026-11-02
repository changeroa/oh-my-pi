import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createHarnessHook,
	HarnessBridge,
	type HarnessPayload,
	registerHarnessRuntime,
} from "../examples/extensions/harness-runtime";

describe("harness-runtime bridge", () => {
	it("drains the previous session before a racing switch and never attributes new tools to the old turn", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const events: HarnessPayload[] = [];
		const bridge = new HarnessBridge(async payload => {
			events.push(payload);
			if (payload.hook_event_name === "UserPromptSubmit") {
				entered.resolve();
				await release.promise;
			}
			return {};
		});
		const old = { id: "old", file: "/sessions/old.jsonl", cwd: "/repo" };
		const next = { id: "next", file: "/sessions/next.jsonl", cwd: "/repo" };
		const prompt = bridge.prompt(old, "test");
		await entered.promise;
		const switched = bridge.start(next);
		const tool = bridge.tool(next, "bash", { command: "pwd", cwd: "sub" });
		release.resolve();
		await Promise.all([prompt, switched, tool]);
		expect(events.map(event => [event.hook_event_name, event.session_id])).toEqual([
			["SessionStart", "old"],
			["UserPromptSubmit", "old"],
			["SessionEnd", "old"],
			["SessionStart", "next"],
			["PreToolUse", "next"],
		]);
		expect(events[2]?.turn_id).toBe(events[1]?.turn_id);
		expect(events[4]?.turn_id).toBeUndefined();
		expect(events[4]?.tool_input).toEqual({ cmd: "pwd", workdir: "/repo/sub" });
	});

	it("sends JSON through a real hook process with isolated state and propagates malformed replies", async () => {
		using temp = TempDir.createSync("@omp-harness-hook-");
		const cli = temp.join("hook.mjs");
		await Bun.write(
			cli,
			`let raw='';for await(const part of process.stdin)raw+=part;const p=JSON.parse(raw);process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:process.env.HARNESS_STATE_DIR+'|'+p.session_id+'|'+p.prompt}}));`,
		);
		const state = temp.join("separate state");
		const hook = createHarnessHook(cli, state);
		const result = await hook({
			runtime: "omp",
			session_id: "a",
			cwd: temp.path(),
			hook_event_name: "UserPromptSubmit",
			prompt: "quotes ' \" $()\n한글",
		});
		expect(result.hookSpecificOutput?.additionalContext).toBe(`${state}|a|quotes ' " $()\n한글`);
		await Bun.write(cli, "process.stdout.write('not json')");
		await expect(
			hook({ runtime: "omp", session_id: "a", cwd: temp.path(), hook_event_name: "Stop" }),
		).rejects.toThrow();
	});

	it("blocks a native tool when the hook process exits unsuccessfully even with a JSON error body", async () => {
		using temp = TempDir.createSync("@omp-harness-failure-");
		const cli = temp.join("failed-hook.mjs");
		await Bun.write(
			cli,
			'let raw="";for await(const part of process.stdin)raw+=part;const p=JSON.parse(raw);if(p.hook_event_name==="PreToolUse"){process.stdout.write(JSON.stringify({systemMessage:"Harness hook unavailable: fixture"}));process.exitCode=1;}else{process.stdout.write("{}");}',
		);
		let handler:
			| ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>)
			| undefined;
		const api = {
			on(name: string, callback: typeof handler) {
				if (name === "tool_call") handler = callback;
			},
			logger: { warn() {} },
		} as unknown as ExtensionAPI;
		registerHarnessRuntime(api, createHarnessHook(cli, temp.join("isolated")));
		const ctx = {
			agent: { kind: "main" },
			cwd: temp.path(),
			sessionManager: { getSessionId: () => "failure-test", getSessionFile: () => temp.join("session.jsonl") },
		} as unknown as ExtensionContext;
		if (!handler) throw new Error("Missing tool_call handler");
		const result = await handler(
			{ type: "tool_call", toolName: "bash", toolCallId: "blocked", input: { command: "touch forbidden" } },
			ctx,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Harness pre-tool check unavailable");
	});

	it("runs native OMP lifecycle hooks, injects context, and records an unverified stop without starting another model turn", async () => {
		using temp = TempDir.createSync("@omp-harness-sdk-");
		const auth = await AuthStorage.create(temp.join("auth.db"));
		auth.keys.setRuntime("openai", "test-only");
		const registry = new ModelRegistry(auth, temp.join("models.yml"));
		const events: HarnessPayload[] = [];
		const model = getBundledModel("openai", "gpt-4o-mini");
		const mock = createMockModel({ handler: { content: ["finished"] } });
		const { session } = await createAgentSession({
			cwd: temp.path(),
			agentDir: temp.path(),
			authStorage: auth,
			modelRegistry: registry,
			model,
			sessionManager: SessionManager.create(temp.path(), temp.join("sessions")),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "async.enabled": false }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
			extensions: [
				pi =>
					registerHarnessRuntime(pi, async payload => {
						events.push(payload);
						if (payload.hook_event_name === "SessionStart")
							return { hookSpecificOutput: { additionalContext: "harness context marker" } };
						if (payload.hook_event_name === "Stop") return { decision: "block", reason: "unverified fixture" };
						return {};
					}),
			],
		});
		try {
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: error => {
					throw error;
				},
			});
			session.agent.streamFn = mock.stream;
			await session.prompt("Run the fixture");
			await session.waitForIdle();
			expect(mock.calls).toHaveLength(1);
			expect(JSON.stringify(mock.calls[0]?.context)).toContain("harness context marker");
			const submitted = events.find(event => event.hook_event_name === "UserPromptSubmit");
			const stopped = events.find(event => event.hook_event_name === "Stop");
			expect(stopped?.turn_id).toBe(submitted?.turn_id);
			expect(stopped?.session_id).toBe(session.sessionId);
			expect(path.isAbsolute(stopped?.session_path || "")).toBe(true);
		} finally {
			await session.dispose();
			auth.close();
		}
		expect(events.at(-1)?.hook_event_name).toBe("SessionEnd");
	}, 20000);
});
