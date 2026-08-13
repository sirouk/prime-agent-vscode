# Changelog

All notable changes to this extension are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
Maintainers: keep entries under [Unreleased] as flat bullets starting on the line right after
the blank one. release.sh promotes that heading into the new version section and only detects
entries within two lines of it, so a `### Added` sub-heading makes a release ship unlabelled.
After a cut, add the new version's compare link at the bottom and re-point [Unreleased].
-->

## [Unreleased]

## [1.0.11]

- The "/" menu is back in resumed threads. A session boundary discards the composer's per-session state — including the slash catalog — but the host only ever sent that catalog in answer to a webview's first `ready`, so every thread after the first one a panel showed opened an empty menu. The webview now re-asks for what the boundary discarded, and the host answers while attached, observing, or restoring: the catalog describes the agent build, not the session on screen. Asking for it also no longer pops "Please wait while your session view is restored…" at the operator — that guard exists to refuse mutations, not read-only queries.

## [1.0.10]

- A long thread no longer loses its middle silently. The two windowing mechanisms — messages never rendered, and rendered rows later trimmed — are independent, and only the first of them was ever stated. With both live, "Load earlier" spliced old messages straight onto a tail that was missing hundreds in between, reading as continuous history. The trimmed stretch is now marked in place, the loaded batch lands above that marker, and the count no longer includes the notice itself.
- A dropped daemon connection can no longer re-attach twice and then detach itself. Two callers arriving while the socket was down both issued an attach; the loser released the registration the winner had just installed, leaving a session that accepted prompts and never received another event. Re-attach is now serialized, waits for any pending release of the same handle, and never detaches a handle the current view holds.
- A navigation superseded mid-attach is rolled back instead of left half-installed. The stale attachment used to keep the daemon viewer AND wedge the newer navigation, stranding the window in "switching sessions…" with every action refused until another history row was clicked.
- The restore lock can no longer latch. A failed restore of this window's own session (subprocess gone, daemon socket dead, refused hand-off) now retries the agent once and then releases the lock, instead of leaving a blank panel that neither Restart nor New Session could recover.
- Markdown links now mean what they say: only absolute http/https/mailto targets are clickable, and the host is asked to open exactly the URL that was rendered. Relative and protocol-relative targets are shown inert rather than silently resolved against the webview origin and then refused.
- Inline markdown is no longer quadratic. An unmatched delimiter ("[", "**", a stray backtick) rescanned to the end of the message from every position, and the transcript re-renders on every streaming delta — a long reply containing bare "[" froze the panel for seconds (measured 7.4s at 80k occurrences, now 64ms).
- Locked all of the above behind two new regression layers (transcript windowing and attach/restore lifecycle) that fail on the previous build, and repaired the host end-to-end harness: it pre-started the private daemon that RPC mode insists on owning, so that gate could not run at all against a current agent.
- Fixed a batch of smaller correctness bugs: the per-turn cost badge no longer lands on a message from the top of the transcript after loading earlier history; spawn cards reappear after watching another session; the auto-compact flyout no longer leaks a document listener per open; a selection-only prompt that the host refuses gives the attachments back; drafts persist for sessions the agent identifies only by file; a session lease held by another user reads as live rather than stale; short file reads no longer skip subagent edits or corrupt a rename append; every id-bearing extension UI request is answered; the CSP nonce comes from a real random source; and a git failure in the diff view says so instead of showing the whole file as newly added.

## [1.0.9]

- Hardened the extension boundary and session lifecycle: webview messages now use host-issued session and child capabilities; workspace links cannot expose files outside the selected folder; malformed or oversized daemon/RPC frames fail safely; image and prompt payloads are bounded; and sensitive command/prompt data is no longer logged by default.
- Fixed live-session correctness across restarts, reconnects, nested subagent browsing, history actions, observing, and rapid navigation. The visible transcript, controls, status, child strip, exports, model pickers, and optimistic prompt rows now stay bound to the session the operator is actually viewing.
- Made release and packaging gates portable and complete, including Node 22 CI, portable build revisions, production package checks, accessibility-safe webview controls, and focused host/transport regressions.

## [1.0.8]

- Long threads open instantly and stay light. Only the newest ~150 messages are built on open,
  with the exact number of earlier ones stated above them and a button to walk backwards a batch
  at a time — loading earlier messages leaves the row you were reading exactly where it was.
  A 3000-message thread went from ~330ms and ~102,000 DOM nodes to ~16ms and ~5,100, and the cost
  no longer grows with the thread
- A session left running for hours no longer grows without bound: once the rendered window passes
  600 rows it trims from the top back to 400, dropping the tool blocks that went with them so
  nothing outlives the DOM. Trimming happens only while you are parked at the bottom — never
  under a reader who has scrolled up — and the transcript says how many rows it has trimmed
  rather than appearing to start part-way through

## [1.0.7]

- Scrolling no longer fights you during a reply. Auto-follow now sticks only while you are
  actually parked at the bottom; the moment you scroll up you hold your place and the new output
  piles up below, reachable with the jump-to-bottom arrow. Intent is read from the wheel/touch
  gesture rather than the scroll position, which arrives a frame later — long enough for a frame
  to drag you back down — and the old 48px deadzone that swallowed short scrolls is gone
- Expanded thinking blocks and tool cards keep their place while the reply streams. Each frame
  used to rebuild the whole assistant row, which detached every tool card and recreated the
  thinking block: inner scrollbars snapped to the top several times a second, blocks you had
  collapsed sprang open, and text selections were lost. Rows are now repainted in place, and the
  panes that are rewritten each frame keep their scroll offset (or keep following the tail if
  that is where you were)

- Tool cards fill in as their arguments stream. The first frame prime-agent sends for a tool call
  carries no arguments at all — the card was built from that frame and never rebuilt, so the
  collapsed summary stayed empty and the expanded call showed a bare `{}` for the rest of the
  session. Cards now re-render when fuller arguments arrive, and only ever upgrade, so a late
  partial frame cannot blank a card that is already complete

## [1.0.6]

- Release publishing runs end to end from CI again: the publish job now declares the `CI`
  environment, without which `secrets.VSCE_PAT` resolved to an empty string and every release
  stopped at the credential guard. 1.0.4 never reached the Marketplace for this reason

## [1.0.5]

- History row actions are ordered stop, rename, archive, delete — archive sits beside delete as the non-destructive retire, and delete stays last, furthest from a stray click
- The composer arms only once the agent has actually answered an RPC round-trip. A binary that
  spawns and then never replies (stale daemon socket, half-finished install, a build that does
  not understand `--mode rpc`) no longer reads as connected, and a spawn failure no longer
  latches "running" over a child that never existed
- Prime Agent not reachable now says so: a dismissible card names the reason, links the upstream
  quickstart and offers Retry. A spawn error raises it immediately instead of behind the 25s
  watchdog, and dismissing it hides the recommendation, not the failure
- Hiding the sidebar keeps its DOM: toggling the activity bar no longer reloads the webview and
  blanks the transcript, the draft and the scroll position
- Drafts are flushed before a session switch, so the last keystrokes stay with the session they
  were typed in
- Subagent strip separates live from finished: running/idle/finished status comes from the daemon's own roster classification (not `isStreaming` alone), and finished subagents sit in their own collapsed "Historical" group instead of padding the live count
- Browsing into a subagent keeps it in the list and highlights it green; siblings and the "‹ parent" row stay reachable, and a browse that fails now leaves the strip and the current session exactly where they were
- Going back to the parent (or stopping an observe) restores the strip instead of emptying it, and no longer re-announces the parent's existing subagents as freshly spawned
- Subagent strip refresh is genuinely throttled (700 ms, one in flight) and skips repaints when the roster hasn't changed, so a 40-tool-call turn no longer triggers 40 disk-walking daemon list reads
- "Changes" panel is built from prime-agent's own diff payloads and nothing else: it now covers
  the thread *and* its subagents, rebuilds from the session's own history (so a resumed thread
  or a return from a subagent keeps its rows), names the contributing subagent on each hunk, and
  says out loud that shell and raw-Python rewrites publish no diff and therefore cannot appear
- Shell runs read as shell: the CLI's only tool is `ipython`, so a `%%bash` cell now gets
  terminal chrome, a shell section label and a shell fence when copied, instead of rendering and
  pasting as Python. Collapsed cards use prime-agent's own cell-preview scorer, ported verbatim
- Copying an assistant reply carries the whole reply — thinking and tool calls as markdown, in
  reading order — and a copied tool call carries the call plus every captured output section
- Selection survives collapsing or expanding a thinking block or tool card (captured on the way
  in, rebuilt by position afterwards)
- User-message footers show the estimated token count and the metered cost of the reply that
  message opened
- Rendering a session snapshot lands at the bottom, and the jump-to-latest pill resets with it
- History searches the conversations themselves, not just the visible rows: matching sessions
  come back with the snippet that matched, deduped by path, and "This workspace" keeps its own
  quota so other folders can never crowd it out
- History rows gained Archive — the CLI's non-destructive retire (transcript kept, session still
  resumable, row leaves the list) — behind the same one-tap inline confirm as delete
- Renaming a session that is live in another client works through the daemon instead of being
  refused, and history rows resolve by session-file uuid so the row you are browsing is never
  mistaken for someone else's
- Reopening the sidebar replays the last history answer instead of flashing "Loading…"
- The on-disk history fallback reads the tail of each session file, so renames and archives that
  the daemon would have reported are still seen when the daemon is down
- Attached (daemon-brokered) sessions are driven only through the daemon: model, thinking level,
  abort, fork and compact all address the session on screen instead of our own idle background
  session, and a failed Stop says so instead of leaving the operator clicking
- The daemon handshake is memoized, so a second connect arriving mid-handshake no longer steals
  the first one's socket and makes history report "nothing is running"
- Thinking levels come from the selected model's own level map (the way the agent derives them),
  are cleared on a model switch, and treat `max` as the distinct level it is — the picker never
  offers a level the agent would silently swap
- Command Palette export is `Prime Agent: Export Chat…` and opens the three-way picker
  (Markdown with summarized tool calls, Markdown without them, HTML); it used to jump straight
  to HTML
- Packaging cannot leak the Marketplace token: `.env`, `release.sh`, `install.sh` and
  `.github/` are excluded from the `.vsix`, and every release cut proves it with `vsce ls`
- `install.sh` installs the `.vsix` for the exact version just built (not the newest by mtime)
  and points at the Marketplace one-liner for people who do not need a source build
- `npm run compile` also builds `dist/daemon-sidecar.cjs`, which the host e2e gate requires, so
  a clean checkout can run the full battery
- GitHub release publishing checks that the tag matches `package.json` and that `VSCE_PAT` is
  present, instead of failing halfway through `vsce publish`
- README rewritten to describe the shipped UI, lead with the Marketplace install, and state
  plainly that this is a community build; LICENSE copyright corrected to the actual author with
  the Prime Intellect trademark note kept separate

## [1.0.4] - 2026-08-07

- Attached-session event routing uses the daemon's canonical activeSessionId (streaming from CLI continues to flow through the extension thread — the uuid/active-window mismatch is gone)
- Spawn cards seed only for currently-running subagents; historical ones stay in the collapsible strip (no resume spam)
- release.sh publishes to the Marketplace from a gitignored `.env` (VSCE_PAT), guarded by token presence and the `VSCE_PUBLISH` flag
- The compiled smoke bundle is generated by esbuild instead of committed, and no longer folded into release commits

## [1.0.3] - 2026-08-07

- Publisher is `sirouk` — the account that owns the Marketplace listing

## [1.0.2] - 2026-08-07

- Subagent spawn cards announce each new subagent inline in the transcript (ordered by start time), clickable to browse into it; the strip refresh stays cheap and realtime via traffic-throttled daemon reads
- Attach keepalive: session keeps following across daemon restarts (seamless re-anchor, re-attach notice)
- Running-state reads are consistent on every history visit (sidecar auto-reconnect; running strictly from isStreaming)

## [1.0.1] - 2026-08-07

- Session names always surface from the end of the session file (renames anywhere show up immediately)
- Session history search ranks hits: exact substring > token-set > subsequence, recency breaks ties
- Model pill mid-truncates (chutes/…/Model) with the full name on hover; title edits and CLI-side renames propagate to attached sessions and refresh the history
- Auto-compact flyout shows abbreviated token counts next to percentages (`94% · 246k`)
- History rows show a subtle pulsing dot when a session is actively running, ordered hover actions: stop → rename → delete
- release.sh strict gate: clean tree, master+remote alignment, tag consistency, full battery, then commit+tag+push+GitHub release

## [1.0.0] - 2026-08-07

- Session history: recent-descending within each bucket by true activity time (renames/forks resurface at the top with current dates)

- Live-view parity for attached sessions proved end-to-end (host e2e dual phase: independent writer client streams into the extension transcript live)
- Composer caret mirrors scroll exactly when the field hits max-height (native scrollbar hidden so the caret stays truthful at the end of input)

- Session title in the header (ellipsis-wrapped) with a hover pencil -> inline rename (Enter commits; RPC or daemon-sidecar for attached sessions); history rows gain a pencil for offline renames (session_info entries, live sessions refused)
- Menus survive streaming responses (pill label span, guarded updates) — menu-open-during-stream regression covered live
- ipython tool cards summarize the real first line (skips %%magics, shebangs, comments)

- Thinking levels live on a brain pill right of the model pill, filtered to what the selected model supports; model menus stay open while replies stream
- Dual-client guarantee (CLI + extension): writer + viewer on the same resident session both see prompts and answers — covered by the headless parity suite (17 checks)
- The context gauge itself opens the auto-compact flyout; reset is a circle-arrow icon
- Kebab menu's "Visit Prime Intellect" uses the butterfly mark
- Scroll-up affordance is a round down-arrow ("Jump to bottom" tooltip, always subtle)
- User message footers (estimated tokens, copy, fork) sit under the bubble like the assistant usage line

- Terminal-session parity: sessions live in a terminal attach through the daemon sidecar (full writer, not just observer).
- Subagents strip above the composer: lists active/finished subagents, browse into them, back-to-parent.
- Thread diff panel: expandable hunks from edit/write/bash during this thread, per file, above the composer.
- @-mentions are inline-styled in the composer (files AND folders with trailing `/`), chips in transcripts, folders reveal in Explorer.
- Per-reply / per-thinking / per-tool copy buttons; fork from user messages.
- Auto-compact threshold override per session behind the context meter; sticky composer drafts; scroll-lock escape with jump-to-latest; selection preserved across collapse; boot splash during connect; stateful history with search; send gated to content.

## [0.0.1]

- Initial public release.
- Sidebar chat over the `prime-agent --mode rpc` protocol: streaming text, collapsible thinking,
  live tool-call cards (diffs, terminal cards, ipython), and a changes strip for touched files.
- Live sessions: closing the view keeps the agent resident; reopen to rebuild the full transcript,
  tools, and usage. In-webview history grouped by workspace, with inline-confirm session deletion.
- Composer rail: searchable model menu with persisted favorites, reasoning/vision (`img`) badges,
  context sizes, and nested thinking levels; steer/queue toggle; live context-window meter.
- Attach menu: `@` file mentions with indexed autocomplete rendered as clickable chips, active
  file and selection attach, vision-gated image attach/paste/drop.
- Markdown export with summarized tool calls; session compaction and agent restart controls.
- Test layers: webview DOM harness, export harness, activation harness, smoke, host e2e, headless
  screenshot matrix, and a persistent live-shell driver for real VS Code verification.

[Unreleased]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.11...HEAD
[1.0.11]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/sirouk/prime-agent-vscode/releases/tag/v1.0.0
