# Prime Agent for VS Code

Chat with [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) directly from VS Code.
The extension runs the Prime Agent CLI as a headless RPC subprocess (`prime-agent --mode rpc`)
and renders the full agent stream — assistant text, thinking, and every tool call — in a
sidebar chat view.

The agent keeps its own runtime: daemon-backed sessions, skills, the persistent IPython
kernel, subagents, schedules, and the continual harness all behave exactly as in the
terminal client. The extension is a UI over the RPC protocol, not a reimplementation.

### Install from source (quick)

One-liner — clones to a temp dir, builds, installs, cleans up:

```sh
curl -fsSL https://raw.githubusercontent.com/sirouk/prime-agent-vscode/master/install.sh | sh
```

Manual:

```sh
git clone https://github.com/sirouk/prime-agent-vscode
cd prime-agent-vscode
npm ci
npm run package
code --install-extension prime-agent-vscode-<version>.vsix
```

Requires `git`, `node` >= 20, `npm`, and the `code` CLI on `PATH` (macOS: run *Shell
Command: Install 'code' command in PATH* from the Command Palette). The extension
usually activates without a window reload; otherwise run *Developer: Reload Window*.

## Features

- **Streaming chat** with markdown rendering, collapsible thinking blocks, and live tool-call
  cards (ipython renders preview code, bash shows a terminal card) with input/result
  inspection and copy buttons.
- **Prime Intellect accent**: deep-neutral surfaces with the signature green used sparingly —
  the butterfly mark, the send button, live indicators. Respects light and dark themes.
- **Live sessions & terminal parity**: sessions stay resident after you close the view; opening
  a session that is *already live in a terminal* attaches through the daemon so both clients
  see and steer the same stream (read-only observe when the daemon can't attach).
- **Subagents**: collapsible strip above the composer lists the session's subagents with
  activity pulse; browse inside any of them, back-to-parent returns.
- **Thread diffs**: collapsible "Changes" panel above the composer stitches the hunks from
  the agent's edit/write/bash calls for the current thread — per file, expandable, with
  an Open-file shortcut. Files changed strip above the transcript remains coarse.
- **Steer while working**: send messages while the agent runs; the *steer/queue* pill in the
  composer rail chooses mid-turn steering or end-of-run delivery. Stop button aborts the run.
- **Editor context**: `+` attach menu — mention files and **folders** (`@` with indexed
  autocomplete; folders carry a trailing `/`), attach the active file or the current selection
  (`Cmd+Alt+K` / `Alt+K` sends the snippet as context), or attach images on vision-capable
  models. Paste and drag-drop work too, and are gently refused on text-only models. Mentions
  render inline-styled inside the composer and as clickable chips in your messages; folders
  reveal in the Explorer.
- **Composer rail**: searchable model menu holds ★ favorites (persisted), reasoning and vision
  (`img`) badges, context-window sizes, and a **brain popout per model row** for the six
  thinking levels. Next to it: the steer/queue toggle (default via
  `primeAgent.defaultStreamingBehavior`) and a live context meter with a hover gear that
  opens the per-session **auto-compact threshold** override (20–80%).
- **Session control**: history grouped by *This workspace* / *Other folders* with client-side
  search and smooth stateful refresh; hover a session to delete with a one-tap inline confirm
  (trash-first, live/current sessions are refused); new session, compact, markdown export,
  and agent restart from the *⋯* menu.
- **Export & copy**: conversation markdown to clipboard or file with summarized tool calls;
  per-reply, per-thinking, per-tool-call, and per-message copy buttons; **fork** the session
  from any user message (mirrors `/fork`); per-message footers show estimated tokens.
- **Composer care**: drafts detected per session survive reloads; selection preserves across
  collapse/expansion of thinking and tool cards; streaming follows the bottom by default but
  never fights your scrolling (jump-to-latest pill appears when you're reading up).

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
`Compact Context`, `Export Chat…`, `Resume Recent Session…`, `Restart Agent Process`,
`Add Selection to Chat`, `Add Active File to Chat`, `Open Chat in Editor Tab`, `Stop Agent`.

Header links: the butterfly / title opens the [Prime Agent blog post](https://www.primeintellect.ai/blog/prime-agent#article-top);
the *⋯* menu links to [app.primeintellect.ai](https://app.primeintellect.ai).

## Development

TypeScript + esbuild, no framework, no runtime npm dependencies in the shipped bundle.
The webview is hand-written TS compiled to a single `media/main.js`.

```bash
npm install
node esbuild.config.mjs        # build host (dist/) + webview (media/)
npx tsc --noEmit               # type check
node test/webview.test.mjs     # webview DOM harness (happy-dom)
node test/export-md.test.mjs   # markdown export harness
node test/activate.test.mjs    # activation harness
node test/smoke.mjs            # confidence smoke
node test/host-e2e.mjs         # extension-host e2e (stubbed vscode API)
node test/preview-shot.mjs     # headless Chromium screenshots + DOM assertions
```

For a real VS Code shell without window-focus stealing, run the persistent live driver:

```bash
node test/live-driver.mjs      # listens on 127.0.0.1:7321, keeps one minimized window
```

It exposes scenario endpoints (`/scenario/menus-then-prompt`, `/scenario/stop-mid-run`,
`/scenario/new-session`, `/scenario/resume-and-observe` …), `/eval?expr=…` to evaluate
expressions inside the webview, and `/state` for DOM status. Get available scenario names
by requesting a bogus one.

Package a `.vsix` with `npm run package`.

## Privacy

The extension talks only to the local `prime-agent` process over stdio and reads sessions and
workspace files on your machine. Everything else — providers, tools, skills, subagents — is the
agent's own runtime, governed by your `prime-agent` configuration and the providers you choose
there. Session history and favorites are stored locally (globalState + your
`~/.prime/agent` directory) and never leave the machine except through the model providers
you configured.

## License

MIT. The butterfly mark and the Prime Agent name belong to Prime Intellect.

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
