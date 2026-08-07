# Changelog

## [Unreleased]

- Session history: recent-descending within each bucket by true activity time (renames/forks resurface at the top with current dates)

- Live-view parity for attached sessions proved end-to-end (host e2e dual phase: independent writer client streams into the extension transcript live)
- Composer caret mirrors scroll exactly when the field hits max-height (native scrollbar hidden so the caret stays truthful at the end of input)

- Session title in the header (ellipsis-wrapped) with a hover pencil -> inline rename (Enter commits; RPC or daemon-sidecar for attached sessions); history rows gain a pencil for offline renames (session_info entries, live sessions refused)
- Menus survive streaming responses (pill label span, guarded updates) — menu-open-during-stream regression covered live
- ipython tool cards summarize the real first line (skips %%magics, shebangs, comments)

- Brain is a rail pill now (right of the model pill): the thinking picker opens per model, filtered to what the model supports; model menus stay open while replies stream
- Dual-client guarantee (CLI + extension): writer + viewer on the same resident session both see prompts and answers — covered by the headless parity suite (17 checks)
- Context gauge is the opener for the auto-compact flyout (hover gear removed); reset is a circle-arrow icon
- Kebab menu's "Visit Prime Intellect" uses the butterfly mark
- Scroll-up affordance is a round down-arrow ("Jump to bottom" tooltip, always subtle)
- User message footers (estimated tokens, copy, fork) sit under the bubble like the assistant usage line

- Terminal-session parity: sessions live in a terminal attach through the daemon sidecar (full writer, not just observer).
- Subagents strip above the composer: lists active/finished subagents, browse into them, back-to-parent.
- Thread diff panel: expandable hunks from edit/write/bash during this thread, per file, above the composer.
- @-mentions are inline-styled in the composer (files AND folders with trailing `/`), chips in transcripts, folders reveal in Explorer.
- Per-model brain popout for thinking levels; per-reply / per-thinking / per-tool copy buttons; fork from user messages.
- Auto-compact threshold override per session behind the context meter's hover gear; sticky composer drafts; scroll-lock escape with jump-to-latest; selection preserved across collapse; boot splash during connect; stateful history with search; send gated to content.

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
