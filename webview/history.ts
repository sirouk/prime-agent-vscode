/**
 * History view: recent workspace sessions, resumable in place.
 */

import { el, icon } from "./dom.js";
import type { RecentSession } from "../src/protocol.js";

export interface HistoryDeps {
	onResume: (path: string, sessionId: string) => void;
	onBack: () => void;
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
		this.listEl = el("div", "history-list");
		this.root.append(header, this.listEl);
	}

	showLoading(): void {
		this.listEl.textContent = "";
		this.listEl.appendChild(el("div", "history-empty", "Loading…"));
	}

	render(sessions: RecentSession[], currentId?: string): void {
		this.listEl.textContent = "";
		if (sessions.length === 0) {
			this.listEl.appendChild(el("div", "history-empty", "No previous sessions found."));
			return;
		}
		this.currentId = currentId;
		const inWorkspace = sessions.filter((s) => s.inWorkspace);
		const others = sessions.filter((s) => !s.inWorkspace);
		if (inWorkspace.length > 0) {
			this.listEl.appendChild(el("div", "history-group", "This workspace"));
			for (const session of inWorkspace) this.listEl.appendChild(this.buildItem(session, false));
		}
		if (others.length > 0) {
			this.listEl.appendChild(el("div", "history-group", inWorkspace.length > 0 ? "Other folders" : "Sessions"));
			for (const session of others) this.listEl.appendChild(this.buildItem(session, true));
		}
	}

	private currentId?: string;

	private buildItem(session: RecentSession, showFolder: boolean): HTMLButtonElement {
		const item = el("button", "history-item") as HTMLButtonElement;
		item.title = session.cwd;
		const isCurrent = session.id === this.currentId;
		if (isCurrent) item.classList.add("current");
		const top = el("div", "history-item-top");
		const name = session.name || session.firstPrompt || "(untitled session)";
		top.appendChild(el("span", "history-item-name", isCurrent ? `${name} (current)` : name));
		top.appendChild(el("span", "history-item-time", relativeTime(session.timestamp)));
		item.appendChild(top);
		const sub = session.name && session.firstPrompt ? session.firstPrompt.slice(0, 110) : showFolder ? session.cwd : undefined;
		if (sub) item.appendChild(el("div", "history-item-sub", sub));
		if (!isCurrent) {
			item.addEventListener("click", () => this.deps.onResume(session.path, session.id));
		}
		return item;
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
