/**
 * Per-thread diff panel: a collapsible strip floating above the composer
 * (sibling of the subagents strip) listing the files the agent changed in the
 * current thread via edit/write/bash tool calls.
 *
 * The host accumulates hunks (session-controller) and pushes the full
 * cumulative state on every `threadDiffs` message, so this view is a pure
 * render: no message history is kept here beyond the latest payload.
 */

import { el } from "./dom.js";
import type { ThreadDiffFile, ThreadDiffHunk } from "../src/protocol.js";

export interface ThreadDiffsDeps {
	onOpenFile: (path: string) => void;
}

export class ThreadDiffsPanel {
	readonly root: HTMLElement;
	private files: ThreadDiffFile[] = [];
	private expanded = false;
	private readonly openPaths = new Set<string>();

	constructor(private readonly deps: ThreadDiffsDeps) {
		this.root = el("div", "td-panel");
	}

	/** Replace the full state from a host `threadDiffs` payload (defensively sanitized). */
	setFiles(files: unknown): void {
		this.files = sanitizeThreadDiffFiles(files);
		for (const open of [...this.openPaths]) {
			if (!this.files.some((file) => file.path === open)) this.openPaths.delete(open);
		}
		this.render();
	}

	private render(): void {
		const root = this.root;
		root.textContent = "";
		root.classList.toggle("visible", this.files.length > 0);
		if (this.files.length === 0) return;

		const header = el("button", "td-header") as HTMLButtonElement;
		header.append(el("span", "td-caret", this.expanded ? "▾" : "▸"), `Changes (${this.files.length})`);
		const totals = countLines(this.files);
		if (totals.added > 0 || totals.removed > 0) {
			const counts = el("span", "td-counts");
			counts.append(el("span", "add", `+${totals.added}`), el("span", "del", `−${totals.removed}`));
			header.appendChild(counts);
		}
		header.title = "Files Prime Agent changed in this thread — click to expand";
		header.addEventListener("click", () => {
			this.expanded = !this.expanded;
			this.render();
		});
		root.appendChild(header);
		if (!this.expanded) return;

		const list = el("div", "td-list");
		for (const file of this.files) list.appendChild(this.renderFile(file));
		root.appendChild(list);
	}

	private renderFile(file: ThreadDiffFile): HTMLElement {
		const wrap = el("div", "td-file");
		const open = this.openPaths.has(file.path);
		const row = el("button", "td-row") as HTMLButtonElement;
		row.title = `${file.path} — click to ${open ? "hide" : "show"} changes`;
		row.append(
			el("span", "td-row-caret", open ? "▾" : "▸"),
			el("span", `td-via ${file.viaSource}`, file.viaSource),
			el("span", "td-path", file.path),
		);

		const counts = countLines([file]);
		if (counts.added > 0 || counts.removed > 0) {
			const badge = el("span", "td-counts");
			badge.append(el("span", "add", `+${counts.added}`), el("span", "del", `−${counts.removed}`));
			row.appendChild(badge);
		}
		const openBtn = el("button", "td-open", "Open file") as HTMLButtonElement;
		openBtn.title = `Open ${file.path}`;
		openBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			this.deps.onOpenFile(file.path);
		});
		row.appendChild(openBtn);
		row.addEventListener("click", () => {
			if (this.openPaths.has(file.path)) this.openPaths.delete(file.path);
			else this.openPaths.add(file.path);
			this.render();
		});
		wrap.appendChild(row);
		if (open) wrap.appendChild(this.renderDetail(file));
		return wrap;
	}

	private renderDetail(file: ThreadDiffFile): HTMLElement {
		const detail = el("div", "td-detail");
		let rendered = 0;
		for (const hunk of file.hunks) {
			if (rendered > 0) detail.appendChild(el("div", "td-gap", "…"));
			for (const line of hunk.removed) detail.appendChild(diffLine("del", "−", line));
			for (const line of hunk.added) detail.appendChild(diffLine("add", "+", line));
			if (hunk.note) detail.appendChild(el("div", "td-note", hunk.note));
			rendered += 1;
		}
		for (const hint of file.shellHints ?? []) {
			const row = el("div", "td-shell");
			row.appendChild(document.createTextNode("touched via shell command: "));
			row.appendChild(el("code", "td-shell-cmd", hint));
			detail.appendChild(row);
		}
		if (rendered === 0 && (file.shellHints ?? []).length === 0) {
			detail.appendChild(el("div", "td-empty", "changed — no captured content"));
		}
		return detail;
	}
}

/** A single red/green line, visually identical to transcript edit hunks. */
function diffLine(kind: "del" | "add", sign: string, text: string): HTMLElement {
	const row = el("div", `diff-line ${kind}`);
	row.appendChild(el("span", "diff-sign", sign));
	const body = el("span", "diff-text", text);
	if (text === "") body.innerHTML = "&nbsp;";
	row.appendChild(body);
	return row;
}

function countLines(files: ThreadDiffFile[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const file of files) {
		for (const hunk of file.hunks) {
			added += hunk.added.length;
			removed += hunk.removed.length;
		}
	}
	return { added, removed };
}

function sanitizeThreadDiffFiles(input: unknown): ThreadDiffFile[] {
	if (!Array.isArray(input)) return [];
	const files: ThreadDiffFile[] = [];
	for (const raw of input) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		const path = typeof entry.path === "string" ? entry.path : "";
		if (!path) continue;
		const hunks = sanitizeHunks(entry.hunks);
		const hints = Array.isArray(entry.shellHints)
			? entry.shellHints.filter((hint): hint is string => typeof hint === "string" && hint.length > 0)
			: [];
		if (hunks.length === 0 && hints.length === 0) continue;
		const viaSource =
			entry.viaSource === "edit" || entry.viaSource === "write" || entry.viaSource === "shell" ? entry.viaSource : "shell";
		files.push({ path, viaSource, hunks, ...(hints.length > 0 ? { shellHints: hints } : {}) });
	}
	return files;
}

function sanitizeHunks(input: unknown): ThreadDiffHunk[] {
	if (!Array.isArray(input)) return [];
	const hunks: ThreadDiffHunk[] = [];
	for (const raw of input) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		const removed = sanitizeLineArray(entry.removed);
		const added = sanitizeLineArray(entry.added);
		const note = typeof entry.note === "string" && entry.note.length > 0 ? entry.note : undefined;
		hunks.push({ removed, added, ...(note ? { note } : {}) });
	}
	return hunks;
}

function sanitizeLineArray(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	return input.filter((line): line is string => typeof line === "string");
}
