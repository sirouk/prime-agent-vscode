# Prime Agent for VS Code

Chat with [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) directly from VS Code.
The extension runs the Prime Agent CLI as a headless RPC subprocess (`prime-agent --mode rpc`)
and renders the full agent stream — assistant text, thinking, and every tool call — in a
sidebar chat view.

The agent keeps its own runtime: daemon-backed sessions, skills, the persistent IPython
kernel, subagents, schedules, and the continual harness all behave exactly as in the
terminal client. The extension is a UI over the RPC protocol, not a reimplementation.

## Features

- **Streaming chat** with markdown rendering, collapsible thinking blocks, and live tool-call
  cards (ipython, edit, bash, ...) with input/result inspection and copy buttons.
- **Prime Intellect accent**: deep-neutral surfaces with the signature green used sparingly —
  the butterfly mark, the send button, live indicators. Respects light and dark themes.
- **Live sessions**: agent sessions stay resident after you close the view ("live" indicator +
  session id in the status strip); reopen and the full transcript, tools, and usage rebuild.
- **Steer while working**: send messages while the agent runs; the *steer/queue* pill in the
  composer rail chooses mid-turn steering or end-of-run delivery. Stop button aborts the run.
- **Editor context**: `@` mentions with file autocomplete, attach the current selection with a
  click or `Cmd+Alt+K`/`Alt+K` (the snippet is sent as context), paste or drop images.
- **Composer rail**: searchable model menu with ★ favorites (persisted), reasoning badges and
  context-window sizes; thinking menu that disables for non-reasoning models; steer/queue
  toggle (default configurable via `primeAgent.defaultStreamingBehavior`); and a live
  context-window meter that warms up near the model's limit.
- **Tool rendering built for agents**: edit calls render as red/green diff hunks with a
  jump-to-file button; shell calls render as terminal cards with live streaming output.
- **Session control**: new session, in-webview history grouped by *This workspace* / *Other
  folders* (prime-agent sessions resume from any directory), manual compact, export the chat
  as HTML, restart the agent process.
- **Changes strip**: files the agent touched during the last run, one click to open or diff
  against git HEAD.

## Requirements

- The [`prime-agent` CLI](https://github.com/PrimeIntellect-ai/prime-agent) installed and
  authenticated (`/login` in the terminal client, once).
- VS Code 1.90+.

If `prime-agent` is not on `PATH`, set `primeAgent.command` to an absolute path, e.g.
`/path/to/prime-agent/prime-agent.sh` for a source checkout.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `primeAgent.command` | `prime-agent` | Command used to launch the agent. |
| `primeAgent.args` | `[]` | Extra CLI args appended after `--mode rpc` (e.g. `["--provider", "chutes"]`). |
| `primeAgent.model` | `""` | Model passed as `--model` on start. |
| `primeAgent.maxFileSearchResults` | `40` | Max `@` mention search results. |
| `primeAgent.sendSelectionSnippet` | `true` | Include the selected code when attaching a selection. |
| `primeAgent.defaultStreamingBehavior` | `steer` | Delivery for messages sent mid-run: `steer` (interrupt after current turn) or `followUp` (run to completion first). |

## Commands

All under the `Prime Agent:` prefix, e.g. `Prime Agent: Focus Chat`, `New Session`,
`Compact Context`, `Export Chat as HTML`, `Resume Recent Session…`, `Restart Agent Process`,
`Add Selection to Chat`, `Add Active File to Chat`, `Open Chat in Editor Tab`, `Stop Agent`.

Editor context menu: *Prime Agent: Add Selection to Chat*.

## How it works

```
VS Code extension host                Prime Agent CLI
┌──────────────────────┐   JSONL/stdin   ┌────────────────────────┐
│ sidebar/editor webview│───────────────▶│ prime-agent --mode rpc │
│   (chat UI, markdown) │◀───────────────│  events: message_update │
│ SessionController     │   events/stdout│  tool_execution_*      │
│   RpcClient (JSONL)   │                │  extension_ui_request  │
└──────────────────────┘                └────────────────────────┘
```

- Commands/responses are correlated by `id`; framing splits on `\n` only (Unicode line
  separators are valid inside JSON strings — see `docs/rpc.md` in prime-agent).
- Extension UI requests (`select`, `confirm`, `input`, …) are answered with native
  VS Code quick picks, input boxes, and notifications.
- Session history is read from `~/.prime/agent/sessions/*.jsonl` and filtered by workspace
  cwd; resuming uses the `switch_session` command.

## Development

```bash
npm install
npm run compile        # esbuild: dist/extension.js + media/main.js
npm run typecheck      # tsc --noEmit
npm run test           # activation harness with a stubbed vscode module
npm run smoke          # spawns a real prime-agent --mode rpc and round-trips a prompt
npm run package        # produce prime-agent-vscode-<version>.vsix
```

Test layers:

- `test/webview.test.mjs` — happy-dom harness driving the built `media/main.js`
  (rendering, menus, history, streaming states). Fully headless.
- `test/host-e2e.mjs` — real `SessionController` + stubbed vscode vs. a real CLI.
- `test/smoke.mjs` — RPC protocol round-trip (`--session-dir` temp store).
- `test/vscode-e2e.mjs` — **real-shell trace**: Playwright drives actual VS Code
  (minimized window, throwaway `--user-data-dir`, extension loaded from the repo via
  `--extensionDevelopmentPath`). Covers the sidebar mount, tooltips, model/thinking
  menus, prompt round-trip, grouped history, session resume, the observe fallback for
  sessions already live elsewhere, and abort. Note: Electron can't run headless on
  macOS; the suite minimizes the window instead. Uninstall the packaged extension
  before running it so the dev-path build wins resolution.
- `test/live-driver.mjs` — persistent http driver on `127.0.0.1:7321` that keeps one
  backgrounded VS Code open and reloads the extension host in place for iterative runs.

Set `PRIME_AGENT_VSCODE_LOG=/path/to/file` to get the env-gated host debug log
(spawn config, wire summaries, prompt lifecycle) — useful when diagnosing in the field.

To try it in VS Code without packaging: open this folder and press `F5` to launch an
Extension Development Host, or install the built `.vsix` via the Extensions view
("Install from VSIX…").
