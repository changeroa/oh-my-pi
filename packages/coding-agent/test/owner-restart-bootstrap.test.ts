import { describe, expect, it } from "bun:test";
import { extractProfileFlags } from "../src/cli/profile-bootstrap";
import { parseArgs } from "../src/cli/args";

describe("owner restart structured startup arguments", () => {
	it("extracts isolated settings and bootstrap before native launch parsing without introducing a prompt", () => {
		const extracted = extractProfileFlags([
			"--agent-dir", "/private/settings", "--iyen-omp-bootstrap", "/private/restart.json",
			"--model", "fixture/exact-model", "--thinking", "medium", "--approval-mode", "yolo",
			"--start-held",
			"--resume", "/private/exact-session.jsonl",
		]);
		expect(extracted.agentDir).toBe("/private/settings");
		expect(extracted.iyenOmpBootstrap).toBe("/private/restart.json");
		const launch = parseArgs(extracted.argv);
		expect(launch.resume).toBe("/private/exact-session.jsonl");
		expect(launch.model).toBe("fixture/exact-model");
		expect(launch.startHeld).toBe(true);
		expect(launch.messages).toEqual([]);
		expect(launch.unknownFlags.size).toBe(0);
	});

	it("does not steal flag-looking prompt values, literal arguments or subcommand options", () => {
		const prompt = extractProfileFlags(["--system-prompt", "--agent-dir", "keep this text"]);
		expect(prompt.agentDir).toBeUndefined();
		expect(parseArgs(prompt.argv).systemPrompt).toBe("--agent-dir");
		const literal = extractProfileFlags(["--", "--iyen-omp-bootstrap", "/literal"]);
		expect(literal.iyenOmpBootstrap).toBeUndefined();
		expect(literal.argv).toEqual(["--", "--iyen-omp-bootstrap", "/literal"]);
		const subcommand = extractProfileFlags(["grep", "--agent-dir", "/literal"]);
		expect(subcommand.agentDir).toBeUndefined();
		expect(subcommand.argv).toEqual(["grep", "--agent-dir", "/literal"]);
	});

	it("refuses ambiguous settings, relative paths and conflicting private bootstrap targets", () => {
		expect(() => extractProfileFlags(["--agent-dir", "relative"])).toThrow("absolute");
		expect(() => extractProfileFlags(["--iyen-omp-bootstrap", "relative"])).toThrow("absolute");
		expect(() => extractProfileFlags(["--agent-dir", "/settings", "--profile", "other"])).toThrow("cannot be combined");
		expect(() => extractProfileFlags(["--agent-dir", "/settings", "--agent-dir", "/replacement"])).toThrow("Conflicting");
		expect(() => extractProfileFlags(["--iyen-omp-bootstrap=/one", "--iyen-omp-bootstrap=/two"])).toThrow("Conflicting");
	});
});

it("an extension cannot shadow the native constructor-time execution fence", () => {
	const launch = parseArgs(["--start-held", "--resume", "/private/exact.jsonl"], new Map([["start-held", { type: "string" }]]));
	expect(launch.startHeld).toBe(true);
	expect(launch.resume).toBe("/private/exact.jsonl");
	expect(launch.messages).toEqual([]);
});
