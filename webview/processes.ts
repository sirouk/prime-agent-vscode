/**
 * Processes panel: commands the agent started that are still alive.
 *
 * Sits above the subagents strip because it is the lane whose absence lies. A
 * missing Changes panel means "no diffs"; until this panel existed a missing
 * process indicator meant "we have no idea", and an agent that had just left a
 * twelve-minute job running read as completely idle.
 *
 * Rows are host-observed (src/process-tracker.ts). Clicking one asks the host
 * for the tail of whatever that command writes to a file — the running
 * command's own stdout lives in the agent's kernel buffer and cannot be read
 * without stealing it from the agent, so a row that has nothing readable says
 * so rather than showing an empty box.
 */

import { el, icon } from "./dom.js";
import type { ProcessOutputPreview, SessionProcess } from "../src/protocol.js";

export interface ProcessesPanelDeps {
	onPreview: (ref: string) => void;
	onKill: (ref: string) => void;
}

interface PreviewState {
	loading: boolean;
	preview?: ProcessOutputPreview;
}

/**
 * How a finished job ended.
 *
 * Only a job the agent extension owned can answer this: the OS handed it the
 * exit code. A row reconstructed from the outside knows a process stopped and
 * never how, so it says "finished" rather than inventing a status.
 */
function outcome(entry: SessionProcess): string {
	if (entry.state === "running") return "running";
	if (entry.signal) return `stopped (${entry.signal})`;
	if (entry.exitCode !== undefined) return `exit ${entry.exitCode}`;
	return "finished";
}

/** Elapsed for a running row, total for a finished one. */
function duration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

export class ProcessesPanel {
	readonly root: HTMLElement;
	private processes: SessionProcess[] = [];
	private expanded = false;
	/** A collapse by hand is an instruction; it survives until they open it again. */
	private autoExpandSuppressed = false;
	private historicalExpanded = false;
	private readonly openRefs = new Set<string>();
	private readonly previews = new Map<string, PreviewState>();
	private ticker: ReturnType<typeof setInterval> | null = null;
	/** Whether the agent was streaming at the last update, to spot the transition. */
	private wasStreaming = false;

	constructor(private readonly deps: ProcessesPanelDeps) {
		this.root = el("div", "pr-panel");
	}

	/**
	 * Replace the panel state from a host `processes` payload.
	 *
	 * `streaming` is what decides whether to open the panel by itself. The moment
	 * worth interrupting for is a command that OUTLIVES a turn: while the agent is
	 * working, a long command is already implied by the run; when the run ends and
	 * something is still going, nothing else on screen says so.
	 */
	setProcesses(processes: SessionProcess[], streaming: boolean): void {
		const previousRunning = this.processes.some((entry) => entry.state === "running");
		this.processes = processes;
		const running = processes.some((entry) => entry.state === "running");
		const survivedTurn = running && !streaming && (this.wasStreaming || !previousRunning);
		this.wasStreaming = streaming;
		if (survivedTurn && !this.expanded && !this.autoExpandSuppressed) this.expanded = true;
		for (const ref of [...this.openRefs]) {
			if (!processes.some((entry) => entry.ref === ref)) {
				this.openRefs.delete(ref);
				this.previews.delete(ref);
			}
		}
		this.syncTicker();
		this.render();
	}

	/** Fill in a preview the host answered with. */
	setPreview(preview: ProcessOutputPreview): void {
		if (!this.openRefs.has(preview.ref)) return;
		this.previews.set(preview.ref, { loading: false, preview });
		this.render();
	}

	dispose(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = null;
	}

	/** Rows on screen carry a live clock, so tick only while one is running. */
	private syncTicker(): void {
		const running = this.processes.some((entry) => entry.state === "running");
		if (running && !this.ticker) {
			this.ticker = setInterval(() => this.render(), 1000);
		} else if (!running && this.ticker) {
			clearInterval(this.ticker);
			this.ticker = null;
		}
	}

	private render(): void {
		const root = this.root;
		root.textContent = "";
		root.classList.toggle("visible", this.processes.length > 0);
		if (this.processes.length === 0) return;

		const running = this.processes.filter((entry) => entry.state === "running");
		const finished = this.processes.filter((entry) => entry.state !== "running");

		const header = el("button", "pr-header") as HTMLButtonElement;
		const parts: string[] = [];
		if (running.length > 0) parts.push(`${running.length} running`);
		if (finished.length > 0) parts.push(`${finished.length} finished`);
		header.append(el("span", "pr-caret", this.expanded ? "▾" : "▸"), `Processes (${parts.join(" · ")})`);
		header.title =
			"Commands this agent started, observed from the worker's process journal — " +
			"click to expand, click a row for its output";
		header.addEventListener("click", () => {
			this.expanded = !this.expanded;
			this.autoExpandSuppressed = !this.expanded;
			this.render();
		});
		root.appendChild(header);
		if (!this.expanded) return;

		if (running.length > 0) {
			const list = el("div", "pr-list");
			for (const entry of running) list.appendChild(this.renderRow(entry));
			root.appendChild(list);
		}
		if (finished.length > 0) {
			const subhead = el("button", "pr-subhead") as HTMLButtonElement;
			// A failure counted in the collapsed header is the difference between
			// noticing a job died and having to go looking. Only agent-owned jobs can
			// be counted here: an observed row has no exit status to fail with.
			const failedCount = finished.filter((entry) => entry.signal !== undefined || (entry.exitCode ?? 0) !== 0).length;
			subhead.append(
				el("span", "pr-caret", this.historicalExpanded ? "▾" : "▸"),
				`Finished (${finished.length}${failedCount > 0 ? ` · ${failedCount} failed` : ""})`,
			);
			if (failedCount > 0) subhead.classList.add("has-failure");
			subhead.title = "Commands that ended during this thread — kept so a row does not just vanish";
			subhead.addEventListener("click", (event) => {
				event.stopPropagation();
				this.historicalExpanded = !this.historicalExpanded;
				this.render();
			});
			root.appendChild(subhead);
			if (this.historicalExpanded) {
				const list = el("div", "pr-list finished");
				for (const entry of finished) list.appendChild(this.renderRow(entry));
				root.appendChild(list);
			}
		}
	}

	private renderRow(entry: SessionProcess): HTMLElement {
		const wrap = el("div", "pr-item");
		const open = this.openRefs.has(entry.ref);
		const row = el("div", `pr-row${entry.state === "running" ? " running" : ""}`);
		row.setAttribute("role", "button");
		row.setAttribute("tabindex", "0");
		row.setAttribute("aria-expanded", String(open));
		const dot = el("span", `pr-dot ${entry.state === "running" ? "active" : "done"}`);
		const pid = entry.pid === undefined ? "" : ` · pid ${entry.pid}`;
		dot.title = entry.state === "running" ? `running${pid}` : `${outcome(entry)}${pid}`;
		const label = el("span", "pr-command", entry.command);
		row.append(dot, label);
		const elapsed =
			entry.state === "running"
				? duration(Date.now() - entry.startedMs)
				: duration((entry.endedMs ?? entry.startedMs) - entry.startedMs);
		// The status only appears when it is known. A bare "finished" on an observed
		// row is the honest reading of a journal that records that a process ended
		// and nothing about how.
		if (entry.state !== "running" && (entry.exitCode !== undefined || entry.signal)) {
			const failed = entry.signal !== undefined || entry.exitCode !== 0;
			row.append(el("span", `pr-status${failed ? " bad" : ""}`, outcome(entry)));
		}
		const time = el("span", "pr-time", elapsed);
		time.title =
			entry.state === "running"
				? `started ${new Date(entry.startedMs).toLocaleTimeString()}`
				: `ran ${new Date(entry.startedMs).toLocaleTimeString()} – ${new Date(entry.endedMs ?? entry.startedMs).toLocaleTimeString()}`;
		row.title = `${entry.fullCommand}${pid ? `\n\npid ${entry.pid}` : ""}`;
		row.append(time);
		// Stop is offered only where it is real. An extension-owned job is a process
		// group the agent created and will signal on request; an observed process
		// belongs to a kernel this host has no supported way to interrupt.
		if (entry.killable) {
			const stop = el("button", "pr-kill") as HTMLButtonElement;
			stop.title = "Stop this job";
			stop.appendChild(icon("stop", 9));
			stop.addEventListener("click", (event) => {
				event.stopPropagation();
				this.deps.onKill(entry.ref);
			});
			row.appendChild(stop);
		}
		row.append(el("span", "pr-caret", open ? "▾" : "▸"));
		row.addEventListener("click", (event) => {
			event.stopPropagation();
			this.toggle(entry);
		});
		row.addEventListener("keydown", (event) => {
			const key = (event as KeyboardEvent).key;
			if (key !== "Enter" && key !== " ") return;
			event.preventDefault();
			this.toggle(entry);
		});
		wrap.appendChild(row);
		if (open) wrap.appendChild(this.renderPreview(entry));
		return wrap;
	}

	private toggle(entry: SessionProcess): void {
		if (this.openRefs.has(entry.ref)) {
			this.openRefs.delete(entry.ref);
			this.render();
			return;
		}
		this.openRefs.add(entry.ref);
		this.previews.set(entry.ref, { loading: true });
		this.deps.onPreview(entry.ref);
		this.render();
	}

	private renderPreview(entry: SessionProcess): HTMLElement {
		const box = el("div", "pr-preview");
		const state = this.previews.get(entry.ref);
		if (!state || state.loading) {
			box.appendChild(el("div", "pr-note", "Reading output…"));
			return box;
		}
		const preview = state.preview;
		if (!preview || preview.lines.length === 0) {
			box.appendChild(el("div", "pr-note", preview?.note ?? "No output to show."));
			return box;
		}
		const head = el("div", "pr-preview-head");
		head.appendChild(el("span", "pr-source", preview.source ?? "output"));
		if (preview.truncated) head.appendChild(el("span", "pr-trunc", "tail"));
		const refresh = el("button", "pr-refresh") as HTMLButtonElement;
		refresh.title = "Read the file again";
		refresh.appendChild(icon("refresh", 10));
		refresh.addEventListener("click", (event) => {
			event.stopPropagation();
			this.previews.set(entry.ref, { loading: true });
			this.deps.onPreview(entry.ref);
			this.render();
		});
		head.appendChild(refresh);
		box.appendChild(head);
		const pre = el("pre", "pr-output");
		pre.textContent = preview.lines.join("\n");
		box.appendChild(pre);
		// The panel reads a file the command writes, which is not the same thing as
		// the command's whole output. Saying so is the difference between a useful
		// preview and one that is quietly wrong.
		box.appendChild(
			el(
				"div",
				"pr-foot",
				entry.source === "agent"
					? "The job's own stdout and stderr, captured by the agent that started it."
					: "Last lines of a file this command writes. Anything it printed instead stays in the agent's kernel buffer until the agent reads it.",
			),
		);
		return box;
	}
}
