# Changelog

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
