/**
 * History view: recent workspace sessions, resumable in place.
 */

import { el, icon } from "./dom.js";
import type { RecentSession } from "../src/protocol.js";

export interface HistoryDeps {
	onResume: (path: string) => void;
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

	render(sessions: RecentSession[]): void {
		this.listEl.textContent = "";
		if (sessions.length === 0) {
			this.listEl.appendChild(el("div", "history-empty", "No previous sessions here yet."));
			return;
		}
		for (const session of sessions) {
			const item = el("button", "history-item");
			const top = el("div", "history-item-top");
			top.appendChild(el("span", "history-item-name", session.name || session.firstPrompt || "(untitled session)"));
			top.appendChild(el("span", "history-item-time", relativeTime(session.timestamp)));
			item.appendChild(top);
			if (session.name && session.firstPrompt) {
				item.appendChild(el("div", "history-item-sub", session.firstPrompt.slice(0, 110)));
			}
			item.addEventListener("click", () => this.deps.onResume(session.path));
			this.listEl.appendChild(item);
		}
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
