#!/usr/bin/env bun
/** Launch the opt-in harness profile from this checkout without changing Codex. */
import * as os from "node:os";
import * as path from "node:path";

const cli = process.env.HARNESS_RUNTIME_PATH;
if (!cli || !path.isAbsolute(cli)) {
	console.error("Set HARNESS_RUNTIME_PATH to the absolute path of harness-runtime/scripts/harness.mjs");
	process.exit(1);
}
const profile = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "harness-profile", "agent");
const state = process.env.HARNESS_STATE_DIR || path.join(profile, "harness-runtime");
if (!path.isAbsolute(profile) || !path.isAbsolute(state)) {
	console.error("PI_CODING_AGENT_DIR and HARNESS_STATE_DIR must be absolute paths");
	process.exit(1);
}
const root = path.resolve(import.meta.dir, "..");
const child = Bun.spawn(
	[
		path.join(root, "packages/coding-agent/scripts/omp"),
		"--extension",
		path.join(root, "packages/coding-agent/examples/extensions/harness-runtime.ts"),
		...process.argv.slice(2),
	],
	{
		cwd: process.cwd(),
		env: {
			...process.env,
			PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
			HARNESS_STATE_DIR: state,
			PI_CODING_AGENT_DIR: profile,
		},
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	},
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
