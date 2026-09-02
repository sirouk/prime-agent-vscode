/**
 * History view: recent workspace sessions, resumable in place.
 */

import { el, icon } from "./dom.js";
import type { RecentSession } from "../src/protocol.js";

export interface HistoryDeps {
	onResume: (path: string, sessionId: string) => void;
	onDelete: (path: string, sessionId: string) => void;
	onArchive: (path: string, sessionId: string) => void;
	onRename: (path: string, sessionId: string, name: string) => void;
	onStop: (path: string, sessionId: string) => void;
	/** Ask the host to search the conversations themselves, not just these rows. */
	onSearch: (query: string) => void;
	onBack: () => void;
}

/** Host round-trip debounce: long enough to not search every keystroke, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 220;

/** Longest derived label before it is cut on a word boundary. */
const MAX_DERIVED_LABEL_CHARS = 80;

/**
 * A readable row label for a session that was never named.
 *
 * The fallback is the first prompt, and a first prompt is very often a pasted
 * block: a sentence, a blank line, then a markdown heading. Rendered raw it
 * arrives as one run-on smear — "Written to `…/HANDOFF.md` first.Now for your
 * ultimate mission:# HANDOFF" — which is both unreadable and unhelpful. Take
 * the first line that carries words, drop the markdown ornament in front of it,
 * and cut on a word boundary so the row stays one glanceable line.
 */
export function deriveSessionLabel(session: { name?: string; firstPrompt?: string }): string {
	if (session.name) return session.name;
	const line = (session.firstPrompt ?? "")
		.split(/\r?\n/)
		.map((entry) => entry.replace(/^[\s>#*\-]+/, "").replace(/\s+/g, " ").trim())
		.find((entry) => entry.length > 0);
	if (!line) return "(untitled session)";
	if (line.length <= MAX_DERIVED_LABEL_CHARS) return line;
	const cut = line.slice(0, MAX_DERIVED_LABEL_CHARS);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > MAX_DERIVED_LABEL_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export class HistoryView {
	readonly root: HTMLElement;
	private listEl: HTMLElement;

	constructor(private readonly deps: HistoryDeps) {
		this.root = el("div", "history-view");
		const header = el("div", "history-header");
		const backBtn = document.createElement("button");
		backBtn.className = "icon-btn";
		backBtn.title = "Back to chat";
		backBtn.appendChild(icon("back", 15));
		backBtn.addEventListener("click", () => this.deps.onBack());
		header.append(backBtn, el("span", "history-title", "Sessions in this workspace"));
		// Search bar. The local filter is the instant layer; the host searches the
		// conversation bodies in parallel and hands back the extra rows with a
		// snippet, so a phrase the operator only half-remembers still finds them.
		this.searchEl = document.createElement("input");
		this.searchEl.className = "history-search";
		this.searchEl.placeholder = "Search sessions…";
		this.searchEl.setAttribute("spellcheck", "false");
		this.searchEl.addEventListener("input", () => {
			this.query = this.searchEl.value;
			this.render(this.lastSessions ?? [], this.currentId);
			if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
			const query = this.query;
			this.searchTimer = setTimeout(() => this.deps.onSearch(query), SEARCH_DEBOUNCE_MS) as unknown as number;
		});
		this.headerEl = header;
		this.listEl = el("div", "history-list");
		this.root.append(header, this.searchEl, this.listEl);
	}

	private searchEl: HTMLInputElement;
	private headerEl: HTMLElement;
	private lastSessions: RecentSession[] | null = null;
	private query = "";
	private fetching = false;
	private searchTimer: number | undefined;

	/** Keep the last render on screen while a fresh list arrives; mark subtly. */
	showLoading(): void {
		this.fetching = true;
		this.root.classList.add("refreshing");
		if (!this.lastSessions || this.lastSessions.length === 0) {
			this.listEl.textContent = "";
			this.listEl.appendChild(el("div", "history-empty", "Loading…"));
		}
	}

	render(sessions: RecentSession[], currentId?: string): void {
		const needle = this.query.trim().toLowerCase();
		// matchSnippet is the host's evidence that the conversation itself matched;
		// without it in the haystack the local filter would drop the very rows the
		// host just searched the transcripts to find.
		const haystackFields = (s: RecentSession): string[] =>
			[s.name, s.firstPrompt, s.cwd, s.matchSnippet]
				.filter((v): v is string => typeof v === "string" && v.length > 0)
				.map((v) => v.toLowerCase());

		/** Rank: 3 exact substring · 2 all-tokens match · 1 subsequence fuzzy · 0/no hit. */
		const rankOf = (s: RecentSession): number => {
			if (!needle) return 1;
			const fields = haystackFields(s);
			const joined = fields.join(" ");
			if (fields.some((f) => f.includes(needle))) return 3;
			const tokens = needle.split(/\s+/).filter(Boolean);
			if (tokens.length > 1 && tokens.every((tok) => joined.includes(tok))) return 2;
			// subsequence: all chars of needle appear in order somewhere
			const compressed = joined.replace(/[^a-z0-9./_-]/g, "");
			let pos = 0;
			const compactNeedle = needle.replace(/[^a-z0-9./_-]/g, "");
			for (const ch of compressed) {
				if (pos < compactNeedle.length && ch === compactNeedle[pos]) pos += 1;
				else if (pos >= compactNeedle.length) break;
			}
			return pos >= Math.min(compactNeedle.length, 3) && pos === compactNeedle.length && compactNeedle.length > 0 ? 1 : 0;
		};

		// Dedupe by path: a host-side search appends rows the roster had capped
		// away, and the operator must never see the same session twice.
		const seen = new Set<string>();
		const withRanks: Array<{ s: RecentSession; rank: number }> = [];
		for (const s of sessions) {
			if (seen.has(s.path)) continue;
			seen.add(s.path);
			const rank = rankOf(s);
			if (needle !== "" && rank === 0) continue;
			withRanks.push({ s, rank });
		}
		// Always keep the full list: the search box re-filters from `lastSessions`,
		// so skipping this while a needle was active froze the list at whatever
		// arrived before the operator started typing.
		this.lastSessions = sessions;
		this.currentId = currentId;
		this.fetching = false;
		this.root.classList.remove("refreshing");
		this.listEl.textContent = "";
		if (withRanks.length === 0) {
			this.listEl.appendChild(el("div", "history-empty", needle ? `No sessions match "${needle}".` : "No previous sessions found."));
			return;
		}
		const activityOf = (s: RecentSession): number =>
			s.modifiedMs ?? (Number.isFinite(Date.parse(s.timestamp)) ? Date.parse(s.timestamp) : 0);
		// Best hit first WITHIN each bucket, recency only as the tie-break — the
		// ranks used to be computed and then thrown away by an unconditional
		// re-sort on activity, so a name match lost to anything touched later.
		const byRankThenActivity = (a: { s: RecentSession; rank: number }, b: { s: RecentSession; rank: number }) =>
			b.rank - a.rank || activityOf(b.s) - activityOf(a.s);
		const inWorkspace = withRanks.filter(({ s }) => s.inWorkspace).sort(byRankThenActivity);
		const others = withRanks.filter(({ s }) => !s.inWorkspace).sort(byRankThenActivity);
		if (inWorkspace.length > 0) {
			this.listEl.appendChild(el("div", "history-group", "This workspace"));
			for (const { s } of inWorkspace) this.listEl.appendChild(this.buildItem(s, false));
		}
		if (others.length > 0) {
			this.listEl.appendChild(el("div", "history-group", inWorkspace.length > 0 ? "Other folders" : "Sessions"));
			for (const { s } of others) this.listEl.appendChild(this.buildItem(s, true));
		}
	}

	private currentId?: string;

	private buildItem(session: RecentSession, showFolder: boolean): HTMLElement {
		// Keep the row container non-interactive: the inline management controls and
		// rename input must never become descendants of the resume control.
		const item = el("div", "history-item");
		item.title = session.cwd;
		item.dataset.showFolder = showFolder ? "1" : "0";
		const isCurrent = session.id === this.currentId;
		if (isCurrent) item.classList.add("current");
		const top = el("div", "history-item-top");
		const name = deriveSessionLabel(session);
		const resume = isCurrent ? el("div", "history-resume") : document.createElement("button");
		resume.className = "history-resume";
		resume.title = isCurrent ? `${name} (current session)` : `Resume ${name}`;
		if (!isCurrent) resume.setAttribute("aria-label", resume.title);
		resume.appendChild(el("span", "history-item-name", isCurrent ? `${name} (current)` : name));
		resume.appendChild(
			el(
				"span",
				"history-item-time",
				relativeTime(session.modifiedMs != null ? new Date(session.modifiedMs).toISOString() : session.timestamp),
			),
		);
		// Status dot next to the name, the same three the CLI names. Shown for the
		// current session too — attaching to a live run must not make the run look
		// finished on the next visit to history. Older hosts send only `running`,
		// so fall back to it rather than inventing a liveness we were not told.
		const status = session.status ?? (session.running ? "running" : "inactive");
		const mark = el("span", `running-mark ${status}`) as HTMLElement;
		mark.title =
			session.statusLabel != null
				? `${status === "running" ? "Running" : status === "idle" ? "Idle" : "Inactive"} — flagged by the daemon as ${session.statusLabel}`
				: status === "running"
					? "Running right now"
					: status === "idle"
						? "Idle — loaded and waiting for work"
						: "Inactive — not loaded; resuming it starts a worker";
		mark.appendChild(el("span", "running-dot"));
		resume.appendChild(mark);
		const actions = el("div", "history-actions");
		if (!isCurrent) {
			if (session.running) {
				const stop = document.createElement("button");
				stop.className = "history-action";
				stop.title = "Stop this session (aborts the live run)";
				stop.appendChild(icon("stop", 10));
				stop.addEventListener("click", (event) => {
					event.stopPropagation();
					this.deps.onStop(session.path, session.id);
				});
				actions.appendChild(stop);
			}
			// Archive is the CLI's non-destructive retire (kill + session_state
			// archived): the transcript is kept, the row just leaves the list.
			const archive = document.createElement("button");
			archive.className = "history-action";
			archive.title = "Archive session (keeps the transcript, removes it from this list)";
			archive.appendChild(icon("archive", 11));
			archive.addEventListener("click", (event) => {
				event.stopPropagation();
				this.armConfirm(item, session, actions, {
					label: "Archive",
					className: "history-action",
					run: () => this.deps.onArchive(session.path, session.id),
				});
			});
			const rename = document.createElement("button");
			rename.className = "history-action";
			rename.title = "Rename session";
			rename.appendChild(icon("pencil", 11));
			rename.addEventListener("click", (event) => {
				event.stopPropagation();
				this.armRename(item, session);
			});
			const del = document.createElement("button");
			del.className = "history-action";
			del.title = "Delete (moves to Trash when possible, also removes session data)";
			del.appendChild(icon("close", 11));
			del.addEventListener("click", (event) => {
				event.stopPropagation();
				this.armConfirm(item, session, actions, {
					label: "Delete",
					className: "history-action destructive",
					run: () => this.deps.onDelete(session.path, session.id),
				});
			});
			// Order is the one the operator asked for — stop, rename, delete — with
			// archive slotted next to delete as the non-destructive neighbour of the
			// two retire actions. Delete stays last: the furthest from a stray click.
			actions.append(rename, archive, del);
		}
		top.append(resume, actions);
		item.appendChild(top);
		// A row surfaced by a transcript hit shows the hit, so the operator can see
		// why it matched instead of having to guess.
		if (session.matchSnippet) {
			item.appendChild(el("div", "history-item-sub match", session.matchSnippet.slice(0, 160)));
		} else {
			const sub = session.name && session.firstPrompt
			? session.firstPrompt.replace(/\s+/g, " ").trim().slice(0, 110)
			: showFolder
				? session.cwd
				: undefined;
			if (sub) item.appendChild(el("div", "history-item-sub", sub));
		}
		if (!isCurrent) {
			const resumeSession = (): void => this.deps.onResume(session.path, session.id);
			resume.addEventListener("click", resumeSession);
			// Preserve click-anywhere row behavior without stealing clicks intended
			// for a nested action or rename input.
			item.addEventListener("click", (event) => {
				const target = event.target as HTMLElement | null;
				if (target?.closest?.("button, input, select, textarea, a, [contenteditable='true']")) return;
				resumeSession();
			});
		}
		return item;
	}

	/** Inline rename: pencil swaps the name for a small input; Enter commits, Esc cancels. */
	private armRename(item: HTMLElement, session: RecentSession): void {
		if (item.classList.contains("renaming") || item.classList.contains("confirming")) return;
		item.classList.add("renaming");
		const resume = item.querySelector(".history-resume") as HTMLElement | null;
		if (!resume) {
			item.classList.remove("renaming");
			return;
		}
		const currentText = session.name || deriveSessionLabel(session);
		const input = document.createElement("input");
		input.className = "history-rename-input";
		input.value = currentText;
		input.spellcheck = false;
		const restore = (): void => {
			item.classList.remove("renaming");
			input.replaceWith(resume);
		};
		input.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Enter") {
				restore();
				this.deps.onRename(session.path, session.id, input.value.trim());
			} else if (event.key === "Escape") {
				restore();
			} else {
				input.style.width = `${Math.min(320, Math.max(120, input.value.length * 8 + 16))}px`;
			}
		});
		input.addEventListener("blur", () => restore());
		resume.replaceWith(input);
		input.focus();
		input.select();
	}

	/** Inline one-tap confirm: swaps the subtle buttons for ✓ <label> / ✕ for a few seconds. */
	private armConfirm(
		item: HTMLElement,
		session: RecentSession,
		actions: HTMLElement,
		action: { label: string; className: string; run: () => void },
	): void {
		if (item.classList.contains("confirming")) return;
		item.classList.add("confirming");
		actions.textContent = "";
		const confirm = document.createElement("button");
		confirm.className = action.className;
		confirm.title = `Confirm ${action.label.toLowerCase()}`;
		confirm.appendChild(icon("check", 12));
		confirm.appendChild(document.createTextNode(action.label));
		confirm.addEventListener("click", (event) => {
			event.stopPropagation();
			item.classList.remove("confirming");
			action.run();
		});
		const cancel = document.createElement("button");
		cancel.className = "history-action";
		cancel.title = "Cancel";
		cancel.appendChild(icon("close", 11));
		cancel.addEventListener("click", (event) => {
			event.stopPropagation();
			if (!item.isConnected) return;
			item.classList.remove("confirming");
			item.parentElement?.insertBefore(this.buildItem(session, item.dataset.showFolder === "1"), item);
			item.remove();
		});
		actions.append(confirm, cancel);
		setTimeout(() => {
			if (item.isConnected && item.classList.contains("confirming")) {
				cancel.click();
			}
		}, 6000);
	}
}

function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return "";
	const diff = Date.now() - then;
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(then).toLocaleDateString();
}
