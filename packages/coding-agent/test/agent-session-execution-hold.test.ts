import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(responses: MockResponseSource = [{ content: ["done"] }], manager?: AsyncJobManager) {
	const auth = createInMemoryAuthStorage();
	cleanups.push(() => auth.close());
	auth.keys.setRuntime("anthropic", "test-key");
	const provider = createMockModel({ responses });
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5"), systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: provider.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
		agentId: "hold-owner",
		asyncJobManager: manager,
	});
	cleanups.push(() => session.dispose());
	return { session, provider };
}

describe("AgentSession execution hold", () => {
	it("closes admission synchronously, rejects stale releases and reopens without replay", async () => {
		const { session, provider } = harness();
		const holding = session.executionHold.hold();
		const state = session.executionHold.getState();
		expect(state.status).toBe("holding");
		expect(session.executionHold.hold()).toBe(holding);
		await expect(session.executionHold.release(state)).rejects.toThrow("not settled");
		for (const run of [
			() => session.prompt("blocked"),
			() => session.steer("blocked"),
			() => session.followUp("blocked"),
			() => session.resume(),
			() => session.executeBash("exit 99"),
			() => session.executePython("raise Exception()"),
			() => session.compact(),
			() => session.runEphemeralTurn({ promptText: "blocked" }),
			() => session.newSession(),
			() => session.agent.prompt("direct"),
			() => session.agent.continue(),
		])
			await expect((async () => run())()).rejects.toThrow("held");
		const held = await holding;
		expect(held.status).toBe("held");
		await expect(session.executionHold.release({ ...held, generation: held.generation - 1 })).rejects.toThrow(
			"Stale",
		);
		await expect(session.executionHold.release({ ...held, sessionId: "other" })).rejects.toThrow("Stale");
		expect((await session.executionHold.release(held)).status).toBe("open");
		expect((await session.executionHold.release(held)).status).toBe("open");
		await Bun.sleep(5);
		expect(provider.calls).toHaveLength(0);
		expect(session.messages).toHaveLength(0);
		await session.prompt("explicit input");
		expect(provider.calls).toHaveLength(1);
		const next = await session.executionHold.hold();
		expect(next.generation).toBe(held.generation + 1);
	});

	it("waits for real tool settlement and parks queued input across release", async () => {
		const entered = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		let aborted = false;
		const { session, provider } = harness([
			{ content: [{ type: "toolCall", id: "wait-1", name: "wait", arguments: {} }] },
			{ content: ["done"] },
		]);
		session.agent.setTools([
			{
				name: "wait",
				label: "Wait",
				description: "Wait",
				parameters: type({}),
				async execute(_id, _params, signal) {
					signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
						},
						{ once: true },
					);
					entered.resolve();
					await releaseTool.promise;
					return { content: [{ type: "text", text: "settled" }] };
				},
			},
		]);
		const running = session.prompt("start");
		await entered.promise;
		await session.followUp("retained follow-up");
		const holding = session.executionHold.hold();
		await Bun.sleep(0);
		expect(aborted).toBe(true);
		expect(session.executionHold.getState().status).toBe("holding");
		releaseTool.resolve();
		const held = await holding;
		await running;
		expect(session.getQueuedMessages().followUp).toEqual(["retained follow-up"]);
		expect(provider.calls).toHaveLength(1);
		await session.executionHold.release(held);
		await Bun.sleep(5);
		expect(provider.calls).toHaveLength(1);
		expect(session.getQueuedMessages().followUp).toEqual(["retained follow-up"]);
	});

	it("waits for admitted image setup and prevents its late dispatch", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, provider } = harness();
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			entered.resolve();
			await release.promise;
			return images;
		});
		const prompting = session.prompt("late", { images: [{ type: "image", mimeType: "image/png", data: "AA==" }] });
		await entered.promise;
		const holding = session.executionHold.hold();
		await Bun.sleep(0);
		expect(session.executionHold.getState().status).toBe("holding");
		release.resolve();
		await prompting;
		const held = await holding;
		await session.executionHold.release(held);
		expect(provider.calls).toHaveLength(0);
		expect(session.hasAdmittedSubmission).toBe(false);
	});

	it("fences synthetic follow-up setup across hold and release without replay", async () => {
		const { session, provider } = harness([{ content: ["first answer"] }, { content: ["must not run"] }]);
		await session.prompt("establish assistant tail");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			entered.resolve();
			await release.promise;
			return images;
		});
		const followUp = session
			.followUp("late synthetic directive", [{ type: "image", mimeType: "image/png", data: "AA==" }], {
				synthetic: true,
			})
			.catch(error => error);
		await entered.promise;
		const holding = session.executionHold.hold();
		const token = session.executionHold.getState();
		await Bun.sleep(0);
		expect(session.executionHold.getState().status).toBe("holding");
		await expect(session.executionHold.release(token)).rejects.toThrow("not settled");
		release.resolve();
		expect(await followUp).toBeInstanceOf(Error);
		const held = await holding;
		expect(session.getQueuedMessages().followUp).toEqual([]);
		await session.executionHold.release(held);
		await Bun.sleep(5);
		expect(provider.calls).toHaveLength(1);
		expect(session.getQueuedMessages().followUp).toEqual([]);
	});

	it("reaps even suppressed owner jobs, refuses late registrations and leaves other owners running", async () => {
		const manager = new AsyncJobManager({});
		cleanups.push(async () => {
			await manager.dispose();
		});
		const { session } = harness(undefined, manager);
		const own = Promise.withResolvers<string>();
		const other = Promise.withResolvers<string>();
		const id = manager.register("bash", "owned", () => own.promise, { ownerId: "hold-owner" });
		manager.watchJobs([id]);
		const unrelated = manager.register("bash", "other", () => other.promise, { ownerId: "other-owner" });
		const holding = session.executionHold.hold();
		await Bun.sleep(0);
		expect(manager.getJob(id)?.abortController.signal.aborted).toBe(true);
		expect(manager.getJob(unrelated)?.abortController.signal.aborted).toBe(false);
		let ran = false;
		expect(() =>
			manager.register(
				"bash",
				"late",
				async () => {
					ran = true;
					return "bad";
				},
				{ ownerId: "hold-owner" },
			),
		).toThrow("held");
		expect(ran).toBe(false);
		expect(session.executionHold.getState().status).toBe("holding");
		own.resolve("cancelled result");
		const held = await holding;
		expect(manager.getJob(id)?.resultText).toBe("cancelled result");
		expect(manager.getJob(unrelated)?.status).toBe("running");
		await session.executionHold.release(held);
		other.resolve("other result");
		await manager.waitForOwnerJobs("other-owner");
	});

	it("parks scheduled yield results and hidden context without acknowledging or replaying them", async () => {
		const { session, provider } = harness();
		session.yieldQueue.register<string>("hold-result", {
			build: entries => ({
				role: "custom",
				customType: "hold-result",
				content: entries.join("\n"),
				display: false,
				timestamp: 0,
			}),
		});
		let received = false;
		const receipt = session.yieldQueue.enqueueWithReceipt("hold-result", "retained result").then(() => {
			received = true;
		});
		const held = await session.executionHold.hold();
		session.queueDeferredMessage({
			role: "custom",
			customType: "retained-hidden",
			content: "retained hidden",
			display: false,
			timestamp: 0,
		});
		expect(session.yieldQueue.has("hold-result")).toBe(true);
		expect(received).toBe(false);
		await session.executionHold.release(held);
		await Bun.sleep(5);
		expect(provider.calls).toHaveLength(0);
		expect(received).toBe(false);
		await session.prompt("explicit next input");
		await receipt;
		expect(received).toBe(true);
		expect(JSON.stringify(provider.calls.map(call => call.context.messages))).toContain("retained result");
		expect(JSON.stringify(provider.calls[0]?.context.messages)).toContain("retained hidden");
	});

	it("waits for a thinking shake to finish its transcript rewrite before confirming hold", async () => {
		const { session, provider } = harness();
		const message = createAssistantMessage("answer");
		message.content.unshift({ type: "thinking", thinking: "reasoning to remove" });
		session.sessionManager.appendMessage(message);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const rewrite = session.sessionManager.rewriteEntries.bind(session.sessionManager);
		vi.spyOn(session.sessionManager, "rewriteEntries").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			await rewrite();
		});
		const shaking = session.shake("thinking");
		await entered.promise;
		const holding = session.executionHold.hold();
		await Bun.sleep(0);
		expect(session.executionHold.getState().status).toBe("holding");
		release.resolve();
		expect((await shaking).thinkingBlocksDropped).toBe(1);
		const held = await holding;
		expect(held.status).toBe("held");
		expect(
			session.messages.some(
				item => item.role === "assistant" && item.content.some(block => block.type === "thinking"),
			),
		).toBe(false);
		await session.executionHold.release(held);
		expect(provider.calls).toHaveLength(0);
	});

	it("preserves active and owner-paused goals without resuming either on release", async () => {
		const { session, provider } = harness();
		await session.goalRuntime.createGoal({ objective: "Keep my goal", tokenBudget: 1000 });
		const active = structuredClone(session.getGoalModeState());
		const held = await session.executionHold.hold();
		expect(session.getGoalModeState()?.goal.status).toBe("active");
		expect(session.getGoalModeState()?.goal.objective).toBe(active?.goal.objective);
		expect(session.getGoalModeState()?.goal.tokenBudget).toBe(1000);
		await session.executionHold.release(held);
		await session.goalRuntime.pauseGoal();
		const paused = structuredClone(session.getGoalModeState());
		const heldAgain = await session.executionHold.hold();
		await session.executionHold.release(heldAgain);
		expect(session.getGoalModeState()).toEqual(paused);
		expect(provider.calls).toHaveLength(0);
	});
});
