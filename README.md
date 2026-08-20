# Prime Agent for VS Code

Chat with [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) directly from VS Code.
The extension runs the Prime Agent CLI as a headless RPC subprocess (`prime-agent --mode rpc`)
and renders the full agent stream — assistant text, thinking, and every tool call — in a
sidebar chat view.

The agent keeps its own runtime: daemon-backed sessions, skills, the persistent IPython
kernel, subagents, schedules, and the continual harness all behave exactly as in the
terminal client. The extension is a UI over the RPC protocol, not a reimplementation.

**Community project.** Built and published by [sirouk](https://github.com/sirouk); it is not an
official Prime Intellect release and is not affiliated with them. The Prime Agent name and the
butterfly mark are Prime Intellect's, used here to identify the CLI this extension drives.

## Install

### From the Marketplace

Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`) → search **Prime Agent**, or from a terminal:

```sh
code --install-extension sirouk.prime-agent-vscode
```

Listing: [marketplace.visualstudio.com/items?itemName=sirouk.prime-agent-vscode](https://marketplace.visualstudio.com/items?itemName=sirouk.prime-agent-vscode)

> The command above installs **this extension**. The Prime Agent CLI it drives is a separate,
> upstream install — see [Requirements](#requirements).

### From source

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

Building from source requires `git`, `node` >= 22, `npm`, and the `code` CLI on `PATH` (macOS:
run *Shell Command: Install 'code' command in PATH* from the Command Palette). The extension
usually activates without a window reload; otherwise run *Developer: Reload Window*.

## Features

- **Streaming chat** with markdown rendering, collapsible thinking blocks, and live tool-call
  cards carrying the call itself and every output section, each with its own copy button. The
  CLI's default toolset is `ipython` alone, so a shell run arrives as a `%%bash` cell: those
  get terminal chrome and copy as shell, Python cells copy as Python, and the collapsed card
  shows the same one-line cell preview the terminal client shows.
- **Honest connection state**: the composer arms only once the agent has actually answered an
  RPC round-trip — not merely when a process exists. If `prime-agent` can't be reached (never
  installed, wrong `primeAgent.command`, or a binary that starts and then never replies), a
  dismissible card names the reason and offers the install guide and a Retry.
- **Prime Intellect accent**: deep-neutral surfaces with the signature green used sparingly —
  the butterfly mark, the send button, live indicators. Respects light and dark themes.
- **Live sessions & terminal parity**: sessions stay resident after you close the view; opening
  a session that is *already live in a terminal* attaches through the daemon so both clients
  see and steer the same stream (read-only observe when the daemon can't attach, and Stop is
  addressed to the session that owns the run).
- **Subagents**: collapsible strip above the composer lists the session's subagents with
  activity pulse — running, idle, or (in their own collapsed "Historical" group) finished;
  browse inside any of them, the one you are reading stays listed and highlighted, siblings
  stay one click away, and back-to-parent returns.
- **Thread diffs**: collapsible "Changes" panel above the composer stitches the real diff
  payloads Prime Agent publishes when its bundled `edit` skill rewrites a file — for the
  current thread *and* its subagents, per file, expandable, with an Open-file shortcut and
  the contributing subagent named on each hunk. It rebuilds from the session's own history,
  so resuming a thread or stepping back out of a subagent keeps the list intact. Nothing is
  inferred: a file the agent rewrote from a shell or raw Python cell publishes no diff and
  therefore appears only in the coarse changed-files strip above the transcript, which the
  panel says out loud.
- **Steer while working**: send messages while the agent runs; the *steer/queue* pill in the
  composer rail chooses mid-turn steering or end-of-run delivery. Stop button aborts the run.
- **Editor context**: `+` attach menu — mention files and **folders** (`@` with indexed
  autocomplete; folders carry a trailing `/`), attach the active file or the current selection,
  or attach images on vision-capable models. Paste and drag-drop work too, and are gently
  refused on text-only models. Mentions render inline-styled inside the composer and as
  clickable chips in your messages; folders reveal in the Explorer.
- **Composer rail**: searchable model menu holds ★ favorites (persisted), reasoning and vision
  (`img`) badges, context-window sizes, and full model ids on hover. Immediately right of the
  model pill, a **brain pill** opens the thinking levels — scoped to what the selected model
  actually supports, read from the model's own level map, so it never offers a level the agent
  would silently swap. Next to it: the steer/queue toggle (default via
  `primeAgent.defaultStreamingBehavior`) and a live context meter you click to set the
  per-session **auto-compact threshold** override — the slider runs from 20% to the agent's own
  default ceiling (at least 80%, higher on a big context window) and reads out the token count
  each percentage means.
- **Session control**: history grouped by *This workspace* / *Other folders*, with an instant
  client-side filter and a host-side search of the conversations themselves — rows found that
  way carry the snippet that matched. A pulsing dot marks a session that is running right now
  (including the one you are in). Hover a row for stop, archive, rename, and delete; archive
  and delete ask for a one-tap inline confirm, delete refuses a session that is live in another
  client, and archive keeps the transcript and resumability while dropping the row from the
  list. New session and history live in the header; compact, export, and agent restart in the
  *⋯* menu.
- **Export & copy**: *Export chat…* offers Markdown with summarized tool calls, Markdown
  without them, or the agent's own HTML transcript; the transcript header copies the whole
  conversation as Markdown. Per-reply, per-thinking, and per-tool-call copy buttons;
  **fork** the session from any user message (mirrors `/fork`); user-message footers show an
  estimated token count and the metered cost of the reply that message opened.
- **Composer care**: drafts are kept per session and survive reloads and session switches;
  selection preserves across collapse/expansion of thinking and tool cards; streaming follows
  the bottom by default but never fights your scrolling (jump-to-latest pill appears when
  you're reading up).

## Requirements

- The [`prime-agent` CLI](https://github.com/PrimeIntellect-ai/prime-agent) installed and
  authenticated (`/login` in the terminal client, once). Install it with Prime Intellect's
  own installer:

  ```sh
  curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
  ```

- VS Code 1.90+.

If `prime-agent` is not on `PATH`, set `primeAgent.command` to an absolute path, e.g.
`/path/to/prime-agent/prime-agent.sh` for a source checkout. When the extension can't reach the
CLI it says so in the chat view and links the upstream install guide.

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

Editor context menu: *Prime Agent: Add Selection to Chat* with a selection, *Add Active File to
Chat* without one. `Cmd+Alt+K` sends the selection on macOS; on Windows and Linux use the
context menu or bind *Add Selection to Chat* to a chord of your own (the shipped chord uses the
meta key there, which the window manager usually swallows).

Header links: the butterfly / title opens the [Prime Agent blog post](https://www.primeintellect.ai/blog/prime-agent#article-top);
the *⋯* menu links to [app.primeintellect.ai](https://app.primeintellect.ai).

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
- Session history is read from the daemon's own catalog when it answers, and from
  `~/.prime/agent/sessions/*.jsonl` when it doesn't; both are filtered by workspace cwd and
  resuming uses the `switch_session` command.
- A session that is already live elsewhere is never driven over our own subprocess — RPC mode
  owns its session and cannot attach to one. For those, the extension speaks the daemon
  protocol itself over the daemon's socket (unix socket, named pipe on Windows), which is what
  makes attach — rather than a second, competing session — possible.

## Development

TypeScript + esbuild, no framework, no runtime npm dependencies in the shipped bundle.
The webview is hand-written TS compiled to a single `media/main.js`.

```bash
npm install
npm run compile        # esbuild: dist/extension.js + media/main.js (+ test bundles)
npm run typecheck      # tsc --noEmit
npm run test           # activation harness with a stubbed vscode module
npm run smoke          # spawns a real prime-agent --mode rpc and round-trips a prompt
npm run package        # produce prime-agent-vscode-<version>.vsix
```

Test layers:

- `test/webview.test.mjs` — happy-dom harness driving the built `media/main.js`
  (rendering, menus, history, streaming states). Fully headless.
- `test/export-md.test.mjs` — markdown export harness.
- `test/thread-diffs.test.mjs` — the "Changes" panel against real diff payloads.
- `test/recent-sessions-tail.test.mjs` — the on-disk history fallback (renames and
  archive entries that live at the tail of a session file).
- `test/host-e2e.mjs` — real `SessionController` + stubbed vscode vs. a real CLI.
- `test/daemon-parity.mjs` — CLI + extension on the same resident session, both seeing
  the same prompts and answers.
- `test/smoke.mjs` — RPC protocol round-trip (`--session-dir` temp store). Built from
  `test/smoke.ts` by esbuild; the bundle is generated, not committed.
- `test/preview-shot.mjs` — headless Chromium screenshots + DOM assertions.
- `test/vscode-e2e.mjs` — **real-shell trace**: Playwright drives actual VS Code
  (minimized window, throwaway `--user-data-dir`, extension loaded from the repo via
  `--extensionDevelopmentPath`). Covers the sidebar mount, tooltips, model/thinking
  menus, prompt round-trip, grouped history, session resume, the observe fallback for
  sessions already live elsewhere, and abort. Note: Electron can't run headless on
  macOS; the suite minimizes the window instead. Uninstall the packaged extension
  before running it so the dev-path build wins resolution.
- `test/live-driver.mjs` — persistent http driver on `127.0.0.1:7321` that keeps one
  backgrounded VS Code open and reloads the extension host in place for iterative runs.
  It exposes scenario endpoints (`/scenario/menus-then-prompt`, `/scenario/stop-mid-run`,
  `/scenario/new-session`, `/scenario/resume-and-observe` …), `/eval?expr=…` to evaluate
  expressions inside the webview, and `/state` for DOM status. Request a bogus scenario
  name to get the list.

Set `PRIME_AGENT_VSCODE_LOG=/path/to/file` to get the env-gated host debug log
(spawn config, wire summaries, prompt lifecycle) — useful when diagnosing in the field.

To try it in VS Code without packaging: open this folder and press `F5` to launch an
Extension Development Host, or install the built `.vsix` via the Extensions view
("Install from VSIX…").

### Cutting a release

`./release.sh` runs the full gate (clean tree, branch/remote alignment, version/tag
consistency, the test battery) before it commits, tags, pushes, and creates the GitHub
release. `.github/workflows/publish.yml` then publishes to the Marketplace on any GitHub
release (and on manual dispatch). To enable publishing once:

1. Azure DevOps → Personal Access Token with scope `Marketplace > Manage`, all organizations.
2. GitHub → repo secrets: add `VSCE_PAT` with that value.

## Privacy

The extension talks only to the local `prime-agent` process over stdio and reads sessions and
workspace files on your machine. Everything else — providers, tools, skills, subagents — is the
agent's own runtime, governed by your `prime-agent` configuration and the providers you choose
there. Session history and favorites are stored locally (globalState + your
`~/.prime/agent` directory) and never leave the machine except through the model providers
you configured.

## License

MIT — copyright sirouk. See [LICENSE](LICENSE). The butterfly mark and the Prime Agent name
are Prime Intellect's trademarks, used here only to identify the CLI this extension drives.
