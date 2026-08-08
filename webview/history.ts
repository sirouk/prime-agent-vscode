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

	private buildItem(session: RecentSession, showFolder: boolean): HTMLButtonElement {
		const item = el("button", "history-item") as HTMLButtonElement;
		item.title = session.cwd;
		item.dataset.showFolder = showFolder ? "1" : "0";
		const isCurrent = session.id === this.currentId;
		if (isCurrent) item.classList.add("current");
		const top = el("div", "history-item-top");
		const name = session.name || session.firstPrompt || "(untitled session)";
		top.appendChild(el("span", "history-item-name", isCurrent ? `${name} (current)` : name));
		top.appendChild(
			el(
				"span",
				"history-item-time",
				relativeTime(session.modifiedMs != null ? new Date(session.modifiedMs).toISOString() : session.timestamp),
			),
		);
		// Running session: animated status dot next to its name. Shown for the
		// current session too — attaching to a live run must not make the run
		// look finished on the next visit to history.
		if (session.running) {
			const run = el("span", "running-mark") as HTMLElement;
			run.title = "Running right now";
			run.appendChild(el("span", "running-dot"));
			top.appendChild(run);
		}
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
		top.appendChild(actions);
		item.appendChild(top);
		// A row surfaced by a transcript hit shows the hit, so the operator can see
		// why it matched instead of having to guess.
		if (session.matchSnippet) {
			item.appendChild(el("div", "history-item-sub match", session.matchSnippet.slice(0, 160)));
		} else {
			const sub = session.name && session.firstPrompt ? session.firstPrompt.slice(0, 110) : showFolder ? session.cwd : undefined;
			if (sub) item.appendChild(el("div", "history-item-sub", sub));
		}
		if (!isCurrent) {
			item.addEventListener("click", () => this.deps.onResume(session.path, session.id));
		}
		return item;
	}

	/** Inline rename: pencil swaps the name for a small input; Enter commits, Esc cancels. */
	private armRename(item: HTMLElement, session: RecentSession): void {
		if (item.classList.contains("renaming") || item.classList.contains("confirming")) return;
		item.classList.add("renaming");
		const nameSpan = item.querySelector(".history-item-name") as HTMLElement | null;
		if (!nameSpan) return;
		const currentText = session.name || session.firstPrompt || "";
		const input = document.createElement("input");
		input.className = "history-rename-input";
		input.value = currentText;
		input.spellcheck = false;
		const restore = (): void => {
			item.classList.remove("renaming");
			input.replaceWith(nameSpan);
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
		nameSpan.replaceWith(input);
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
