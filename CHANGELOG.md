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

- A compacted thread no longer opens mid-conversation with nothing above it. When a session is compacted, the agent keeps only what survived — 84 messages of 12,257 on one real thread — and the single record of everything before is a `compactionSummary` entry. The transcript recognised four message roles and silently dropped anything else, so that record vanished and the thread appeared to begin abruptly, with no "load earlier" affordance because there was genuinely nothing earlier left to load. The boundary is now a row of its own: "Context compacted · 255.8k tokens summarized · 84 messages kept", collapsed by default, with the summary itself inside. This is the missing-button report; the button was right about the data it had, and the data was missing its beginning.
- Agent-authored notes are shown instead of discarded. Messages a subagent sends back to its parent arrive as `custom` entries carrying their own `display` flag, and they were dropped by the same unknown-role path — so a subagent's reply never reached the transcript at all. They now render as a labelled note, and an entry the agent marked `display: false` still stays out.
- Reading back through a long thread loads itself. Scrolling near the top pulls in the next batch with no click, and the row you are reading does not move while older ones arrive above it — measured in a real browser, the anchor row holds its exact offset across a load. The bar stays as the marker of where the rendered window starts and remains clickable, because a thread whose rows do not fill the viewport can never scroll to trigger anything.

## [1.0.23]

- The transcript stops juddering while the agent works. The token/cost line under a reply is only meant for a finished message, but it was gated on "this frame is not a delta" rather than on the message actually being done — and a snapshot repaint mid-turn renders the live reply as non-partial. So the line kept being stamped under a reply that was still being written and removed again on its next delta, a row growing and shrinking many times a second, which reads as every message on screen jumping. It now waits for the signal that the numbers are final: a `stopReason` (or an `errorMessage`, since a failed reply is equally finished). Nothing else about the line changed — a completed reply still shows its tokens and cost, and a failed one still says why.
- The notice stack no longer costs you the bottom of the transcript. Those messages sit above the transcript rather than over it, so each one that arrives or auto-dismisses resizes the scroller underneath. Adding and retiring one now gives the tail back the same way the subagents strip already does, which only moves a reader who was already following along and does nothing to one parked mid-history.
- The subagents header counts each state instead of lumping them together. prime-agent's roster has exactly three — running, idle, inactive — so "N live · N finished" was hiding the difference between an agent that is working and one sitting idle. It now reads "2 running · 1 idle · 2 finished", drops empty buckets rather than printing zeros, and the hover title always spells all three out. Rows use the same words the header counts, so a running child is no longer badged "active" while the header calls it something else.
- Those statuses are now decided exactly the way the daemon decides them. Our own rule added streaming, compacting, bash and queued-message bits on top of the daemon's verdict, which promoted to "running" sessions the CLI calls idle — the header could disagree with its own dots, and a queued follow-up counted as a run in progress. The rule now mirrors `classifySessionRosterStatus` term for term, with the raw bits kept only as a fallback for a daemon too old to report `activity` at all. History rows and the subagent strip share that one source of truth.

## [1.0.22]

- Sessions stop disappearing. prime-agent marks a session `archived` whenever its worker closes for any reason other than a clean shutdown or an update — a kill, a worker swap, an update that did not land cleanly — so "archived" was never only the Archive button. The extension hid every archived session from the list AND from search, which is how real threads with thousands of messages ("Airship Simplification", "AI Security Pipeline Work") vanished from their own folder and were findable only from the CLI. Archived sessions are listed again, in the folder they belong to, and search can reach them. Drafts still stay out: a session with no message has nothing to resume.
- History rows now carry the same three-state status the CLI names, not just a running flag. A green pulse is running, a solid grey dot is idle — loaded and waiting for work — and a hollow ring is inactive, meaning no worker is loaded and resuming it starts one. Only the live state animates: a pulsing dot on every row would make a list of finished work look busy. A host that sends no status reads as inactive rather than quietly claiming a liveness nobody checked, and the on-disk fallback scan says the same, because a bounded file read cannot know whether a worker exists.

## [1.0.21]

- A subagent that starts now opens the Subagents strip for you. Work that begins inside a collapsed strip was invisible until you went looking for it, which is the wrong default for the one event you most want to notice. It fires for a fresh spawn and for an existing subagent going back to work, once per burst rather than once per subagent.
- Everything else about it is restraint. It only ever opens — nothing auto-collapses, so it can never shut a list you are reading, and the finished group keeps its own state. It stays out of the way while you are inside a subagent, where the strip is how you get back out and opening it would move the row you were reaching for. Collapsing it by hand is treated as an instruction and respected until you open it by hand again, so a busy thread cannot keep reopening a panel you deliberately shut; a new thread starts fresh. It says nothing on the first roster of a session, because resuming a thread that already has live subagents is not something starting now. And it never takes the scroll: expanding shrinks the transcript, so a reader parked mid-history keeps their place and only a reader already following the tail is re-pinned to it.

## [1.0.20]

- "‹ parent" works again. Browsing from this window's own session into a subagent leaves that child attached and records an "rpc" breadcrumb, but unwinding refused to run whenever an attachment existed — which is exactly the state browsing always leaves behind. The back row was a silent no-op for the commonest path there is: root, into a child, back. It now releases the child and restores this window's session, and a newer navigation is still rejected by the epoch guard that actually means it. Broken since 1.0.9; the regression test fails four ways against the old guard.
- A refused compaction now offers a way out instead of just naming the verdict. The notice carries a "Compact with <model>" button that runs the compaction on another model and puts your model back afterwards — compaction is a summary, not the work, so it should not cost you your model choice. Nothing about which model is hard-coded: the candidate is chosen from the agent's own catalogue by the only property that can be checked in advance, a context window at least as large as the current one, preferring the roomiest. A model that already refused this thread is never offered again, so the button cannot loop, and when nothing qualifies the notice says what to do instead of showing a button that would fail. The offer is a host-issued capability like a subagent's browse reference — the webview can only hand back an id the host minted, never compose one.

## [1.0.19]

- A compaction failure now says what to do about it. Two of them are about the model rather than the thread, and the provider's own words never say so. A refusal is the model declining this thread's content: measured on a real 6,500-message thread, `claude-opus-5` refused it in about two seconds through two different providers, while `claude-sonnet-5` and a non-Anthropic model summarized the very same content without complaint — so retrying the same model only reproduces it, and the fix is to pick another one. "Prompt is too long" is a context window smaller than the thread rather than a fault in the request (`claude-haiku-4-5` rejected 484,555 tokens against its 200,000 ceiling on that thread). Both now carry the provider's exact text plus the one gesture that resolves them. Every other failure is relayed unchanged — no invented advice.

## [1.0.18]

- Large sessions can be resumed again. Opening one asks the agent for its transcript, and that reply arrives as a single JSONL record: for a 6,479-message session it is 4.6 MiB. The extension capped an inbound record at 4 MiB and treated the overflow as a protocol violation, so it destroyed the connection and killed the agent process mid-resume — the session simply never opened, and nothing on screen said why. The cap exists to stop a peer that never sends a newline from growing the extension host forever, which is a different thing from a legitimately large record; it is now 64 MiB, shared by both transports, with roughly an order of magnitude of headroom over the largest transcript observed. Sessions below the old limit were never affected, which is why only the long-running threads looked broken.
- A protocol fault now says so. `protocolError` was emitted and nothing listened, so the one failure mode that kills the agent outright was invisible outside the output channel. It now surfaces as an error notice naming the fault.
- Unnamed sessions get a readable label in the history list. The fallback is the session's first prompt, and a first prompt is very often a pasted block — a sentence, a blank line, then a markdown heading — which rendered as one run-on smear: "Written to `…/HANDOFF.md` first.Now for your ultimate mission:# HANDOFF". The label is now the first line that carries words, with leading markdown ornament removed and a cut on a word boundary, so a row stays one glanceable line. The subtitle collapses its whitespace for the same reason.
- Not a bug, recorded because it looks like one: a session's id and its transcript filename can genuinely differ (prime-agent writes the id into the file, and a resumed or forked session keeps its own). Resume is keyed on the file path, so this never affected it, and the history row already carries both.

## [1.0.17]

- Renaming a session is now a double-click on its name in the header, and the pencil button is gone. Enter keeps the new name, Escape discards it, and clicking away keeps it — an editor that throws away what you just typed because you clicked somewhere else is the clunky part of inline renaming, and Escape already says "discard" without ambiguity. Nothing is sent unless the text actually changed, so a stray double-click costs nothing, and a rename still in flight when the session changes underneath it is discarded rather than landing on whatever replaced it. The name itself now carries the affordance: it lights up on hover, and the double-click no longer leaves the text selected behind the input.
- Emptying the name box means "leave it alone" instead of failing. The daemon refuses an empty name on both the attached and the RPC path, so a cleared field could only ever produce a failed round-trip and an error notice — sitting under a message that claimed the name had been cleared. Both the editor and the host now treat an emptied field the way Escape is treated.
- The bottom of the panel now reads in the order the work does: subagents, then changes made outside this thread, then the changes the agent and its subagents made, then the composer. Outside changes used to be rendered inside the transcript view, which put them *above* the subagent strip and pushed the agent's own changes furthest from the box you type in. The strip also picks up the border and surface of the two panels it now sits between, so the three read as one stack rather than a transparent gap between two raised panels.

## [1.0.16]

- Clicking a subagent works. 1.0.15 made subagents *visible* by naming our worker's owner id on roster reads, but `attach` is gated by the same ownership rule and was still going out unnamed, so every "view ›" ended in "Could not attach to that subagent session (it may be gone)" — the daemon's `Unknown active session`, reported as a missing session. Attach cannot borrow the trick 1.0.15 used, either: a roster read is one round-trip and could name the owner on a throwaway connection, while an attachment is a live event stream that has to stay open. The identity now rides on the sidecar connection itself, so listing, attaching, prompting, aborting and compacting a subagent all speak as the client that owns it. It also removes the connection-per-refresh that the throwaway read implied.
- The identity is given up the moment the agent process exits. That is the one hazard of holding a claim on a long-lived connection: the daemon refuses to reap a client-owned worker while any connected client still answers to its owner id, so a stale claim would leave a dead agent's worker and its IPython kernels running for as long as the window stayed open. Dropping the socket is what releases it. The claim is only ever taken up or switched — a descriptor caught mid-rewrite resolves to nothing, and that must never be read as "let go", or a live attachment would be torn down for no reason.
- Sharing an identity with the live agent connection is safe by construction, and now says so where it matters: the daemon dedupes mutating commands on (client id, command id), our command ids are `side-<n>` where prime-agent's own client issues `daemon_<n>`, and `list` and `attach` are read-only and never journaled at all.
- The live gate now covers attach, not just listing: it proves an unnamed client is refused with `Unknown active session` and that the owner identity gets a snapshot back. Three more unit checks pin the release rule — a claim is dropped on exit, a connection that never claimed anything is left alone, and an unresolvable lookup keeps the claim it already had.

## [1.0.15]

- Subagents are visible, attachable and controllable again, and a running agent stops reading as stopped. prime-agent 0.3.2 moved every RPC client onto a *client-owned* daemon worker and, in the same change, hid client-owned workers from the daemon's `list` unless the caller both asks for them and *is* the client that owns them. The extension's sidecar is a second socket connection, so it is not that client: our own live root fell back to its stale on-disk row — `isSessionActive: false`, no `rlmDepth`, no `parentActiveSessionId` — and every subagent under it disappeared from the roster entirely, which is what emptied the strip and left a working agent looking finished while its children kept running in the background. The extension now recovers the owning client id from the worker descriptor the daemon itself writes, and names it on roster reads. Nothing upstream is patched and no daemon state is mutated: this is our own worker, read back with the identity it already has.
- That identity is claimed on a throwaway connection that is closed before each roster read returns. A client holding an owner id open stops the daemon from ever reaping that worker, so a persistent claim would have traded an invisible subagent for a leaked one — an exited agent whose worker and IPython kernels stayed alive for as long as the window did. A transient claim can at most postpone a reap by the daemon's own 30-second grace window. An identity is never borrowed from a worker that is stopping, that is dead, or that is already visible to everyone, the lookup is keyed by session file so a switch or fork cannot reuse the previous worker's id, and a lookup that finds nothing degrades to exactly the previous behaviour.
- Both halves are gated. A unit layer pins the descriptor shape we depend on and every reason to decline an identity: no owner, stop intent, dead process, reused session file, sibling journals and damaged JSON. A live layer stands up a real client-owned session against a running daemon and proves the three legs in order — a plain `list all` cannot see it, `list all` with `includeClientOwned` still cannot, and naming the owner id can — then kills only the session it made. Both run in `release.sh`'s battery.

## [1.0.14]

- Compaction no longer reports a failure it cannot know about. prime-agent's own daemon client gives up on a request after 30 seconds and says so — with a socket path and a log file — and compaction on a long thread routinely outlives that. The extension relayed it as "Compaction failed" while the compaction was still running. It now asks the session whether it is still compacting before calling anything a failure, and the transcript refresh is driven by the compaction_end event instead of by the reply, which also picks up a compaction another client started on a shared session. Our own timeouts no longer manufacture a second, shorter deadline on top of the agent's.
- Up/Down prompt recall works at any point in a thread. It already ran during a turn, but any host-side write to the composer — a restored draft, an inserted mention, an accepted autocomplete — left the browse position pointing at text that was no longer there, so the next Up appeared to do nothing. Every such write now resets it, recall re-anchors if the box no longer holds what it put there, and a box holding only whitespace counts as empty.
- The changed-files strip counts correctly in four more situations. Detaching from a session no longer re-lists the agent's own edits as somebody else's. Attribution is now per-run like the strip it filters, so your own save of a file the agent edited in an *earlier* run is reported instead of silently hidden. A compaction or fork that rewrites the transcript no longer re-inflates the strip. And a separator or letter-case difference between what the agent wrote and what the watcher saw is recognised as the same file.
- A background refresh no longer overwrites what you are typing, one unreadable session file no longer empties the whole history list, and the "CLI not detected" card only claims it copied the install command when it did.
- Prime Agent's commands now carry the `Prime Agent:` category the README always claimed, so typing "Prime Agent" in the Command Palette finds them.
- Packaging: `graphify-out/` was gitignored but not vscodeignored, and vsce never reads `.gitignore` — so locally built .vsix files (the ones attached to the GitHub releases for 1.0.12 and 1.0.13) carried 4 MB of knowledge-graph output, including a symbol map of the sources `.vscodeignore` exists to exclude. Marketplace builds were never affected; they are packaged from a clean checkout. Both release assets have been rebuilt and replaced. The guard that should have caught it checked for exactly one filename, so it is now an allowlist assertion over the whole vsix file set, in both `release.sh` and CI. `release.sh` also fixes the changelog compare links before tagging, instead of leaving every shipped changelog with a dangling reference.

## [1.0.13]

- The changed-files strip above the composer now lists only what this session cannot claim, and it folds away. Both the main agent's edits and its subagents' count as the session's own work and come out of the strip — they are already in the Changes panel with attribution, and listing them twice invited the reading that something else had touched them. What is left is genuinely outside: your saves, another thread, a build step. A late subagent harvest re-files a path the strip already showed. The strip is collapsed by default behind a header, like the Changes panel, so a run that touches thirty files no longer walls off the composer with an unfoldable chip wall.
- Up and Down in an empty composer walk this thread's previous prompts, the way a shell does. History is seeded from the thread's own transcript, so it survives a reload or a resume, and a prompt you just sent is recalled first. It deliberately only starts from an empty box: once there is text you wrote, the arrows belong to the caret, and an open autocomplete keeps them for its own selection.
- An empty "Thought process" box is no longer drawn. A reasoning model emits the thinking slot before its first delta; the box now appears with the content instead of sitting empty above the reply. Streaming is untouched by design — the part is skipped before its key advances, so the block that appears with the first delta is the same node that keeps growing, and it keeps its open/closed state instead of being rebuilt every frame.

## [1.0.12]

- Split the three self-contained regions out of `session-controller.ts` — the per-thread diff engine (`thread-diffs.ts`), the Markdown exporter (`markdown-export.ts`), and the git HEAD document provider (`git-head-provider.ts`). No behavior change: the whole suite, including the thread-diff harness, passed unmodified against the extraction before any test was touched. The controller drops from 4,074 to 3,535 lines and the diff engine now states its dependencies as four hooks instead of reaching into controller state. The export harness also stops slicing the exporter out of the controller by string offset — it imports a real module now, so it can no longer break when something moves below it in the file.

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

[Unreleased]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.23...HEAD
[1.0.23]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.22...v1.0.23
[1.0.22]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.21...v1.0.22
[1.0.21]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.20...v1.0.21
[1.0.20]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.19...v1.0.20
[1.0.19]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.18...v1.0.19
[1.0.18]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.17...v1.0.18
[1.0.17]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.16...v1.0.17
[1.0.16]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.15...v1.0.16
[1.0.15]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.13...v1.0.14
[1.0.13]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.12...v1.0.13
[1.0.12]: https://github.com/sirouk/prime-agent-vscode/compare/v1.0.11...v1.0.12
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
