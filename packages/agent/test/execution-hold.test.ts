import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

describe("Agent host execution admission", () => {
	it("rejects direct prompt and continue without consuming queues", async () => {
		const provider = createMockModel({ responses: [{ content: ["done"] }] });
		const agent = new Agent({ initialState: { model: provider.model }, streamFn: provider.stream });
		agent.steer({ role: "user", content: "retained", timestamp: 0 });
		agent.setExecutionAdmissionGuard(() => {
			throw new Error("held");
		});
		await expect(agent.prompt("blocked")).rejects.toThrow("held");
		await expect(agent.continue()).rejects.toThrow("held");
		expect(agent.peekSteeringQueue()).toHaveLength(1);
		expect(agent.state.messages).toHaveLength(0);
		expect(provider.calls).toHaveLength(0);
	});

	it("restores queued input when a hold crosses asynchronous preparation", async () => {
		const provider = createMockModel({ responses: [{ content: ["done"] }] });
		const agent = new Agent({ initialState: { model: provider.model }, streamFn: provider.stream });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let held = false;
		agent.setExecutionAdmissionGuard(() => {
			if (held) throw new Error("held");
		});
		agent.prepareQueuedMessages = async () => {
			entered.resolve();
			await release.promise;
			return undefined;
		};
		agent.steer({ role: "user", content: "retained", timestamp: 0 });
		const continuing = agent.continue();
		await entered.promise;
		held = true;
		release.resolve();
		await expect(continuing).rejects.toThrow("held");
		expect(agent.peekSteeringQueue()).toHaveLength(1);
		expect(agent.state.isStreaming).toBe(false);
		expect(provider.calls).toHaveLength(0);
		held = false;
		await agent.continue();
		expect(provider.calls).toHaveLength(1);
	});
});
