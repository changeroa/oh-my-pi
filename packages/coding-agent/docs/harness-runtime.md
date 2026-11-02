# Harness Runtime pilot

This fork can run an opt-in harness-runtime bridge alongside an existing Codex installation. The bridge is an extension; OMP's core agent loop is unchanged.

## Run from source

This pilot was validated on macOS arm64. The launcher uses the repository's existing Unix development wrapper.

Use Bun >= 1.4.4, install dependencies with `bun install --frozen-lockfile`, and build the native addon with `bun run build:native` as described by the repository setup. A matching published `@oh-my-pi/pi-natives-darwin-arm64` package can supply the unchanged addon for macOS development.

Set the harness script path to the checkout containing OMP support, then run from the project you want to work on:

```sh
HARNESS_RUNTIME_PATH=/absolute/path/harness-runtime/scripts/harness.mjs \
  bun /absolute/path/oh-my-pi/scripts/omp-harness.ts
```

The launcher uses a separate profile at `~/.omp/harness-profile/agent` and a separate state directory beneath it. It does not copy credentials, conversations, or settings from Codex. Configure a provider/model in that profile using OMP's normal setup. Override `PI_CODING_AGENT_DIR` and `HARNESS_STATE_DIR` with absolute paths when needed; never share the Codex harness state directory.

For Herdr monitoring, install Herdr's existing OMP integration into that profile:

```sh
mkdir -p "$HOME/.omp/harness-profile/agent"
env -u PI_CODING_AGENT_DIR PI_CONFIG_DIR=.omp/harness-profile herdr integration install omp
```

Launch inside a Herdr pane so its socket and pane environment are inherited by the OMP client. Herdr reports the selected OMP session file; the harness matches that exact path (or an exact OMP session ID). Focus, working directory, or pane hints alone do not establish session identity. Outside Herdr, harness context and local evidence still work; monitor coverage is unavailable.

## What the pilot supports

- Session startup and switching, prompt context, pre-tool checks, completion records, interrupt and shutdown cleanup.
- Separate OMP state and unchanged Codex hook entry points for side-by-side validation.
- The harness CLI shown in the model context points to the chosen checkout and carries the correct state directory. Use its `run` and `verify` commands for recorded execution and evidence.
- Only the main OMP session participates. OMP subagents do not inherit main-session ownership through the extension.

OMP's `session_stop` event supplies the completion boundary; intermediate `agent_end` events are not treated as completed tasks. Verification warnings are surfaced without requesting an automatic follow-up turn. OMP task continuation and the Codex app-server queue are not connected in this phase. OMP transcripts are not parsed as Codex transcripts, so unsupported command-outcome coverage is reported as unavailable.

## Validate and roll back

Run the focused OMP extension test and the harness checkout's verification suite:

```sh
bun test packages/coding-agent/test/harness-runtime.test.ts
# In the harness-runtime checkout:
npm run verify
```

Then compare session start, normal prompt, session switch, interrupt, and exit under both runtimes. Confirm the OMP state directory, exact Herdr identity, completion evidence, and cleanup. A model fixture checks event integration without an external model call; it does not establish provider compatibility or real-model task quality.

Stop launching through `omp-harness.ts` to leave the pilot. The existing Codex launcher and installed runtime remain available; the OMP profile is independent. This source pilot is not a deployment or a replacement of the production runtime.
