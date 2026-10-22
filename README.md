# Prime Agent for VS Code

Chat with [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) directly from VS Code.
The extension drives the Prime Agent CLI and renders the full agent stream — assistant text,
thinking, and every tool call — in a sidebar chat view.

The agent keeps its own runtime: daemon-backed sessions, skills, the persistent Python
kernel, subagents, schedules, and the continual harness all behave exactly as in the
terminal client. The extension is a UI over the agent's own protocols, not a reimplementation.

It works with both generations of the agent. **Prime Agent 0.10 and later (the Rust build)**:
the window's session is hosted on the agent's background service, because the build's own
`--mode rpc` is an in-process engine that cannot spawn subagents, run schedules or heartbeats,
message other agents, or run bash. **Prime Agent 0.9.x and earlier (the TypeScript build)**:
`prime-agent --mode rpc`, whose RPC mode is already a client of that service.

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
- **Processes**: collapsible panel above the subagents strip listing commands the agent
  started that are still alive — the lane nothing else on screen could show, since a command
  that outlives its turn leaves the header reading plain "live". The panel opens itself when
  something survives a turn, names the command rather than the shell wrapper it runs inside,
  keeps a finished command as a receipt instead of letting the row vanish, and shows the last
  ~100 lines of its output on click. It has two sources, and says which one a row came from:
  - **Jobs owned by the bundled agent extension** (TypeScript agent only; see below) — real exit codes, the job's
    own stdout and stderr, and a Stop button that signals the job's process group. These are
    also the jobs that wake the agent when they finish.
  - **Anything else the agent left running**, reconstructed locally from the worker's process
    journal and `ps` — never from the daemon, so it keeps updating after the turn ends. Such
    a row knows a process ended but not how, so it claims no exit status and offers no Stop.
    Its output preview can only show a file the command redirects to: a bare `bash()` command's
    stdout is buffered inside the agent's kernel and cannot be read without taking it from the
    agent, which the panel says rather than showing an empty box. POSIX only.
- **Background jobs agent extension** (Prime Agent 0.9.x and earlier only — the Rust build has no
  extension loader, and the command says so instead of installing something inert): run **Prime
  Agent: Install Background Jobs Agent Extension…** from the command palette to copy the bundled extension into
  `~/.prime/agent/extensions/`, then start a new session. It gives the agent a `background`
  tool for commands that outlive a turn and a `/jobs` command for you. Prime Agent's own
  `bash()` keeps a command's output inside the IPython kernel and notifies nobody when it
  ends, so a job the agent stops awaiting has no exit code, no reachable output and no way to
  be stopped. A job run through this tool is a child of the agent process instead: the OS
  delivers its exit code, its output goes to a file any client can read, stopping it is a
  signal to a process group, and when it finishes the agent is woken with the result rather
  than left idle beside work it forgot about.
- **Thread diffs**: collapsible "Changes" panel above the composer stitches the real diff
  payloads Prime Agent publishes when its bundled `edit` skill rewrites a file — for the
  current thread *and* its subagents, per file, expandable, with an Open-file shortcut and
  the contributing subagent named on each hunk. It rebuilds from the session's own history,
  so resuming a thread or stepping back out of a subagent keeps the list intact. Nothing is
  inferred: a file the agent rewrote from a shell or raw Python cell publishes no diff and
  therefore appears only in the coarse changed-files strip above the transcript, which the
  panel says out loud. Prime Agent 0.10.1's `python_repl` publishes no diffs at all, so there
  the panel stays empty and the strip reads "N files changed" (not "N *other* files") — it
  cannot tell the agent's edits from yours, and says so.
- **Steer while working**: send messages while the agent runs; the *steer/queue* pill in the
  composer rail chooses mid-turn steering or end-of-run delivery. Stop button aborts the run.
- **Compact run timer**: an animated butterfly and elapsed seconds sit in the bottom status
  strip beside tokens and the agent state. The count stays continuous across text and tool
  updates. While reading older messages, **New messages** remains a floating return button.
  The timer never floats over the transcript and stops animating with reduced-motion enabled.
- **Editor context**: `+` attach menu — mention files and **folders** (`@` with indexed
  autocomplete; folders carry a trailing `/`), attach the active file or the current selection,
  or attach images on vision-capable models. Image paste and drag-drop work too, and are
  gently refused on text-only models. Mentions render inline-styled inside the composer
  and as clickable chips in your messages; folders reveal in the Explorer.
- **Large pasted text**: a plain-text paste of 32,000 UTF-16 units or more becomes a local
  UTF-8 `.txt` attachment, leaving your short instructions in the composer. Text files
  work on text-only models too. Paste the text, wait for the file chip to be ready, add
  instructions such as “Read this file in sections and summarize the errors,” then press
  Send. Preparing or failed files block Send; use **Retry**, **Open**, or **Remove** on the
  chip. A send never happens automatically. Up to four text files share an 8 MiB UTF-8
  limit. Oversized clipboard text is refused without changing the current draft. Input
  above the 200,000-unit inline limit, or containing NUL, uses the same preparation path;
  press Send again after readiness. Malformed Unicode is refused rather than changed.
- **Composer rail**: searchable model menu holds ★ favorites (persisted), reasoning and vision
  (`img`) badges, context-window sizes, and full model ids on hover. Immediately right of the
  model pill, a **brain pill** opens the thinking levels — scoped to what the selected model
  actually supports, read from the model's own level map, so it never offers a level the agent
  would silently swap — taken from the agent's own `availableThinkingLevels` when it sends one
  (the Rust build does), else derived from the model's level map. Next to it: the steer/queue toggle (default via
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

- The [`prime-agent` CLI](https://github.com/PrimeIntellect-ai/prime-agent) — 0.10 or later
  (the Rust build, recommended) or 0.9.x (the TypeScript build) — installed and
  authenticated (`/login` in the terminal client, once). Install it with Prime Intellect's
  own installer:

  ```sh
  curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
  ```

- VS Code 1.90+.

Nothing else should be needed: the installer above and this extension are meant to be the
whole setup. An editor launched from the Dock or Finder inherits the system `PATH`, which never
contains npm's global bin — where that installer puts `prime-agent` — so the extension looks
beyond it: the inherited `PATH` first, then the `PATH` your login shell actually has, then the
usual install locations (the installer's own bundled-node prefix, an nvm prefix, Homebrew).
Whatever it finds, that directory goes on the agent's own `PATH` too, so the `node` beside it is
reachable. The lookup runs fresh on every start, so installing the CLI and pressing **Retry**
works without restarting the window.

Set `primeAgent.command` to an absolute path only for a setup none of that can find — e.g.
`/path/to/prime-agent/prime-agent.sh` for a source checkout. When the extension still can't
reach the CLI it says so in the chat view, names where it looked, and links the upstream install
guide.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `primeAgent.command` | `prime-agent` | Command used to launch the agent. |
| `primeAgent.transport` | `auto` | How the window's session is carried. `auto` hosts it on the background service for agents whose own `--mode rpc` has none (0.10+) and uses `--mode rpc` otherwise; `daemon` and `rpc` force one. |
| `primeAgent.args` | `[]` | Extra CLI args (e.g. `["--provider", "chutes"]`). With `--mode rpc` they are passed through; a service-hosted session applies the ones that describe a session (`--provider`, `--model`, `--thinking`, `--system-prompt`, `--append-system-prompt`, `--skill`, `--prompt-template`, `--session-dir`, `--cwd`, `--daemon-socket`) and tells you which others it ignored. |
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
VS Code extension host                        Prime Agent
┌───────────────────────────┐                ┌────────────────────────────────┐
│ webview (chat UI)         │                │ background service (daemon)     │
│ SessionController         │  daemon socket │  ├─ this window's session        │
│   DaemonRpcClient ────────┼───────────────▶│  ├─ its subagents (rlm.spawn)    │
│   DaemonSidecar (roster,  │◀───────────────┤  └─ sessions other clients run   │
│     history, attach)      │  session_event └────────────────────────────────┘
│   RpcClient (0.9.x agent) ┼──▶ prime-agent --mode rpc  (a daemon client itself)
└───────────────────────────┘
```

- **Which transport.** The extension asks the agent for its version. 0.10 and later has an
  in-process `--mode rpc`, so the window's session is *created on the background service*
  (client-owned: it ends with the window, like the subprocess did) and driven through
  `DaemonRpcClient`, which exposes the same interface as `RpcClient`. Everything above that
  line — chat, history, the strip, steering, compaction, export — is unchanged. Earlier
  agents keep `--mode rpc`, which is itself a client of the service. If the service cannot
  be started or reached, the window falls back to the in-process transport and says what
  that costs.
- **Where the service is.** The installer's launcher pins `PRIME_AGENT_DAEMON_SOCKET` for the
  agent it starts, so the socket location is the agent's to say: `prime-agent status --json`
  names it, `--daemon-socket` and `PRIME_AGENT_DAEMON_SOCKET` override it, and a service that
  is not running is started the way the CLI starts it (`--mode daemon`, detached).
- Commands/responses are correlated by `id`; subprocess framing splits on `\n` only (Unicode
  line separators are valid inside JSON strings — see `docs/rpc.md` in prime-agent).
- Extension UI requests (`select`, `confirm`, `input`, …) from a TypeScript agent are answered
  with native VS Code quick picks, input boxes, and notifications.
- Session history is read from the daemon's own catalog when it answers, and from the agent's
  sessions directory (`PRIME_AGENT_SESSION_DIR`, else `<PRIME_AGENT_CODING_AGENT_DIR>/sessions`,
  else `~/.prime/agent/sessions`) when it doesn't; both are filtered by workspace cwd. Opening
  a session never disturbs the one you leave: the daemon either already has it resident
  (attach) or resumes it under a fresh worker.
- A session that is live in another client is followed over the daemon protocol too (attach).
  Following another window's session promotes it first, so it does not end when that window
  closes.

## Troubleshooting

- **"Failed to set up the Python kernel runtime … removing …/kernel-venv: Operation not
  permitted".** That is the agent, not the extension: a new release (or another build sharing
  `~/.prime/agent`) invalidated its Python environment, and deleting the old one failed — the
  usual causes are an immutable flag (`lsattr -d ~/.prime/agent/kernel-venv`), files owned by
  another user, or a locked-down filesystem or container. Run `prime-agent` in a terminal on
  the same machine to confirm it reproduces there. To get going, point the agent at a
  writable location with `PRIME_AGENT_KERNEL_VENV=/some/writable/dir` (it builds a fresh
  environment there without deleting the old one), or at a Python that already has a current
  `prime-agent-runtime` with `PRIME_AGENT_KERNEL_PYTHON`.
- **The chat says the background service is unavailable.** The session then runs in-process
  and cannot spawn subagents or run schedules. `prime-agent status` shows what is listening;
  `prime-agent shutdown` stops a service from another build that holds the socket.
- **A turn stops with "No API key found for …".** Run `/login` in a terminal `prime-agent`, once,
  or choose a model whose provider you have credentials for.

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
- `test/daemon-endpoint.test.mjs`, `test/session-config.test.mjs`,
  `test/daemon-rpc-client.test.mjs` — the service-hosted transport, headless: socket discovery
  and daemon start against fake launchers, flag-to-config translation, and the client itself
  against a scriptable fake daemon (`test/fake-daemon.mjs`) that records every envelope —
  reconnect as the same owner (waiting out a restarting daemon, adopting a replaced worker's
  handle), rebinding a re-issued handle, shutdown, bounded stop-while-starting.
- `test/controller-rust.test.mjs` — the controller's Rust-generation behaviour with no agent at
  all: the login offer, following a re-issued handle, promotion before following another
  window's session, and the hosted-session lifecycle edges.
- `test/webview-rust-rows.test.mjs` — the transcript rows only the Rust agent writes, and the
  placeholder for a record the renderer cannot read.
- Live gates (need a configured model; each runs on a *private* daemon with a throwaway agent
  directory, `test/private-daemon.mjs` + `test/isolated-agent.mjs`, so they never touch your
  settings or your running service): `test/host-e2e.mjs` — real `SessionController` + stubbed
  vscode vs. a real CLI, including a subagent reaching the strip; `test/daemon-hosted-live.mjs`
  — the service-hosted client against a real agent (tools, subagents, queueing, abort,
  lifecycle, promotion); `test/daemon-parity.mjs` — CLI + extension on the same resident
  session; `test/owned-roster.mjs` — client-owned visibility and promotion, for whichever
  daemon generation it finds; `test/smoke.mjs` — subprocess RPC round-trip, built from
  `test/smoke.ts` by esbuild (generated, not committed). `npm run test:live` runs them all.
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

Pasted-text attachments are stored in the extension's private local storage, not your
workspace. The prompt contains file references and instructions for the agent to read them,
not their full contents. Files remain readable after sending or removing a chip, so queued
agent reads can complete. Removing a chip revokes its send reference; it does not delete the
file. Local attachment storage is bounded to 512 files and 256 MiB and must have room before
another file can be prepared. Unsent attachment chips are not restored after a window reload.

## License

MIT — copyright sirouk. See [LICENSE](LICENSE). The butterfly mark and the Prime Agent name
are Prime Intellect's trademarks, used here only to identify the CLI this extension drives.
