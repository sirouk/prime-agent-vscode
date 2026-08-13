/**
 * Per-thread diff panel: cumulative tracking of what the agent edited.
 *
 * The hunks come from prime-agent itself, not from us: its bundled `edit` skill
 * publishes {path, oldStr, newStr} over display_data, and the ipython tool
 * forwards them on `tool_execution_end.result.details.diffs` (and on the
 * persisted toolResult message). That is the ONLY structured change record the
 * agent exposes — keying on a tool literally named "edit"/"write" can never fire
 * against the real CLI, which registers `ipython` and nothing else.
 *
 * State lives host-side so a reloaded webview rebuilds from the push that
 * follows every snapshot. The tracker owns that state; the four hooks below are
 * everything it needs from the controller, which keeps the daemon roster and the
 * webview transport on the controller's side of the line.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentEvent, AgentMessage, ThreadDiffFile, ThreadDiffHunk, ThreadDiffSource, ThreadDiffsMessage, ToolResultMessage } from "./protocol.js";
import type { SessionSummaryRef } from "./daemon-sidecar.js";

export interface ThreadDiffHost {
	/** Read at call time, never captured: the workspace can change under us. */
	workspaceRoot(): string;
	/** Transcript of the session on screen; child files must be its siblings. */
	currentSessionFile(): string | undefined;
	post(message: ThreadDiffsMessage): void;
	isDisposed(): boolean;
}

export class ThreadDiffTracker {
	constructor(private readonly host: ThreadDiffHost) {}

	/** Edits made by the session being viewed. */
	private threadDiffFiles = new Map<string, ThreadDiffAccum>();
	/** Edits harvested from this session's subagents, kept apart so a rebuild of
	 *  the parent's own history cannot drop them. */
	private subagentDiffFiles = new Map<string, ThreadDiffAccum>();
	/** Bytes already parsed per child session file, so a refresh reads only new ones. */
	private subagentDiffOffsets = new Map<string, number>();
	private subagentHarvestInFlight = false;
	/** Bumped on every reset. A harvest awaiting a file read when the operator
	 *  switches sessions must not write the old thread's rows into the new one. */
	private threadDiffGeneration = 0;
	/** Staged tool_execution_start payloads keyed by toolCallId until the end event. */
	private threadDiffPendings = new Map<string, ThreadDiffPending>();
	private threadDiffsTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Commit the tool-call changes an execution actually reported. Called from
	 * onAgentEvent alongside trackChangedFilesDone.
	 */
	track(event: AgentEvent): void {
		if (!event || typeof event.type !== "string") return;
		if (event.type === "agent_start") {
			// Pendings left over from an aborted run never got an end event: drop.
			this.threadDiffPendings.clear();
			return;
		}
		if (event.type === "agent_end") {
			// End events missing (abort edge): commit best effort, then reset.
			for (const pending of this.threadDiffPendings.values()) this.commitThreadDiff(pending);
			this.threadDiffPendings.clear();
			return;
		}
		if (event.type === "tool_execution_start") {
			if (typeof event.toolCallId !== "string" || !event.toolCallId) return;
			const pending = this.parseThreadDiffToolCall(event.toolName, event.args);
			if (!pending) return;
			// Evict the oldest, never the whole map: a busy turn would otherwise
			// discard every staged edit that was about to be committed.
			while (this.threadDiffPendings.size >= THREAD_DIFF_MAX_PENDING) {
				const oldest = this.threadDiffPendings.keys().next();
				if (oldest.done) break;
				this.threadDiffPendings.delete(oldest.value);
			}
			this.threadDiffPendings.set(event.toolCallId, pending);
			return;
		}
		if (event.type === "tool_execution_end") {
			if (typeof event.toolCallId !== "string") return;
			const pending = this.threadDiffPendings.get(event.toolCallId);
			this.threadDiffPendings.delete(event.toolCallId);
			if (event.isError) return;
			// The real source: prime-agent's own diff payloads, which ride on the
			// result details regardless of what the tool is called.
			const details = (event.result as { details?: { diffs?: unknown } } | undefined)?.details;
			if (this.commitKernelDiffs(details?.diffs, this.threadDiffFiles)) this.queueThreadDiffsBroadcast();
			if (pending) this.commitThreadDiff(pending);
		}
	}

	/**
	 * Commit prime-agent's own diff payloads (KernelDiffDisplay:
	 * {path, oldStr, newStr, startLine}). `agent` names the subagent when the
	 * record was harvested from a child session; returns whether anything landed.
	 */
	commitKernelDiffs(raw: unknown, into: Map<string, ThreadDiffAccum>, agent?: string): boolean {
		if (!Array.isArray(raw)) return false;
		let committed = false;
		for (const entry of raw) {
			if (!entry || typeof entry !== "object") continue;
			const diff = entry as { path?: unknown; oldStr?: unknown; newStr?: unknown };
			if (typeof diff.oldStr !== "string" || typeof diff.newStr !== "string") continue;
			const display = normalizeToolPath(diff.path, this.host.workspaceRoot());
			if (!display || !isThreadDiffPathWorthy(display)) continue;
			const hunk = capHunkSides(splitCleanLines(diff.oldStr), splitCleanLines(diff.newStr), THREAD_DIFF_SIDE_CAP);
			const accum = this.ensureThreadDiffFile(display, into);
			if (!accum) continue;
			accum.source = "edit";
			if (accum.hunks.length >= THREAD_DIFF_MAX_HUNKS_PER_FILE) accum.hunks.shift();
			accum.hunks.push(agent ? { ...hunk, agent } : hunk);
			committed = true;
		}
		return committed;
	}

	/**
	 * Fallback for tools an extension registered itself. The stock CLI emits
	 * neither name (its single tool is `ipython`), so this path is dead against
	 * a plain install — it exists so a host that DOES register an edit/write tool
	 * still lands on the panel. There is deliberately no `bash` arm: a shell
	 * command carries no before/after content, so every row it could produce
	 * would be a guess about a file the agent may only have read.
	 */
	private parseThreadDiffToolCall(toolName: unknown, args: Record<string, unknown> | undefined): ThreadDiffPending | null {
		const name = typeof toolName === "string" ? toolName.toLowerCase() : "";
		if (!args || typeof args !== "object") return null;
		if (name === "edit") {
			const display = normalizeToolPath(args.path, this.host.workspaceRoot());
			if (!display || !isThreadDiffPathWorthy(display)) return null;
			const edits = Array.isArray(args.edits)
				? args.edits
				: typeof args.oldText === "string" || typeof args.newText === "string"
					? [args]
					: [];
			let removed: string[] = [];
			let added: string[] = [];
			for (const rawEdit of edits) {
				if (!rawEdit || typeof rawEdit !== "object") continue;
				const edit = rawEdit as { oldText?: unknown; newText?: unknown };
				if (typeof edit.oldText === "string") removed = removed.concat(splitCleanLines(edit.oldText));
				if (typeof edit.newText === "string") added = added.concat(splitCleanLines(edit.newText));
			}
			if (removed.length === 0 && added.length === 0) return null;
			return { path: display, source: "edit", hunks: [capHunkSides(removed, added, THREAD_DIFF_SIDE_CAP)] };
		}
		if (name === "write") {
			const display = normalizeToolPath(args.path, this.host.workspaceRoot());
			if (!display || !isThreadDiffPathWorthy(display)) return null;
			if (typeof args.content !== "string") return null;
			return { path: display, source: "write", hunks: [capHunkSides([], splitCleanLines(args.content), THREAD_DIFF_WRITE_CAP)] };
		}
		return null;
	}

	/** Merge a staged tool call into the cumulative per-thread state. */
	private commitThreadDiff(pending: ThreadDiffPending): void {
		const accum = this.ensureThreadDiffFile(pending.path, this.threadDiffFiles);
		if (!accum) return;
		accum.source = pending.source;
		for (const hunk of pending.hunks) {
			if (accum.hunks.length >= THREAD_DIFF_MAX_HUNKS_PER_FILE) accum.hunks.shift();
			accum.hunks.push(hunk);
		}
		this.queueThreadDiffsBroadcast();
	}

	private ensureThreadDiffFile(path: string, into: Map<string, ThreadDiffAccum>): ThreadDiffAccum | null {
		const existing = into.get(path);
		if (existing) return existing;
		if (into.size >= THREAD_DIFF_MAX_FILES) return null;
		const accum: ThreadDiffAccum = { source: "edit", hunks: [] };
		into.set(path, accum);
		return accum;
	}

	/**
	 * Rebuild the panel from a thread's own history. Live events only ever cover
	 * what arrives from now on, so resuming yesterday's thread — or coming back
	 * from a subagent — used to show an empty "Changes" panel on a thread the
	 * agent demonstrably rewrote. The persisted toolResult records carry the same
	 * `details.diffs` the live events do, so a full recompute is exact and
	 * idempotent (safe to run again after every snapshot and catch-up frame).
	 */
	rebuildFromMessages(messages: AgentMessage[] | undefined): void {
		this.threadDiffFiles.clear();
		for (const message of messages ?? []) {
			if (!message || (message as { role?: unknown }).role !== "toolResult") continue;
			const record = message as ToolResultMessage;
			if (record.isError === true) continue;
			this.commitKernelDiffs(record.details?.diffs, this.threadDiffFiles);
		}
		this.post();
	}

	/**
	 * Subagent edits, which the parent's own message list knows nothing about:
	 * a subagent is a separate session with a separate file (the daemon roster
	 * hands us its `sessionFile`). We tail each child for the same diff records
	 * the parent's edits produce, so "Changes" is main + subagents combined.
	 * Byte offsets make every refresh after the first read only the new bytes.
	 */
	async harvestSubagents(children: SessionSummaryRef[]): Promise<void> {
		if (this.subagentHarvestInFlight) return;
		this.subagentHarvestInFlight = true;
		const generation = this.threadDiffGeneration;
		let committed = false;
		try {
			for (const child of children.slice(0, THREAD_DIFF_MAX_CHILD_FILES)) {
				if (this.threadDiffGeneration !== generation) return;
				const file = await this.validChildSessionFile(child.sessionFile);
				if (!file) continue;
				const label = child.sessionName?.trim() || (child.sessionId ?? child.activeSessionId ?? child.id ?? "").slice(0, 8);
				if (await this.harvestChildDiffFile(file, label || "subagent", generation)) committed = true;
			}
		} finally {
			this.subagentHarvestInFlight = false;
		}
		if (committed && this.threadDiffGeneration === generation) this.post();
	}

	/**
	 * A daemon roster is transport data, not authority to read arbitrary local
	 * files. Child transcripts share the current transcript directory; reject
	 * paths outside it, symlinks, and non-session files before opening anything.
	 */
	private async validChildSessionFile(candidate: string | undefined): Promise<string | null> {
		// `??` is not enough: browseChild attaches with `child.sessionFile ?? ""`,
		// and an empty string is not nullish — it would disable this check (and
		// therefore every subagent diff) instead of falling through.
		const current = this.host.currentSessionFile();
		if (!candidate || !current || !candidate.endsWith(".jsonl") || !current.endsWith(".jsonl")) return null;
		const directory = path.dirname(path.resolve(current));
		const file = path.resolve(candidate);
		if (path.dirname(file) !== directory) return null;
		try {
			const stat = await fs.lstat(file);
			return stat.isFile() && !stat.isSymbolicLink() ? file : null;
		} catch {
			return null;
		}
	}

	private async harvestChildDiffFile(file: string, agent: string, generation: number): Promise<boolean> {
		let handle: fs.FileHandle | null = null;
		try {
			const start = this.subagentDiffOffsets.get(file) ?? 0;
			const { size } = await fs.stat(file);
			if (size <= start) return false;
			handle = await fs.open(file, "r");
			const length = Math.min(size - start, THREAD_DIFF_CHILD_READ_BYTES);
			const buffer = Buffer.alloc(length);
			// A short read is legal. Advancing by the REQUESTED length would skip
			// bytes we never looked at, losing those subagent edits permanently.
			const { bytesRead } = await handle.read(buffer, 0, length, start);
			if (bytesRead <= 0) return false;
			// The read is where we can lose the race with a session switch.
			if (this.threadDiffGeneration !== generation) return false;
			const window = buffer.subarray(0, bytesRead);
			const lastNewline = window.lastIndexOf(0x0a);
			if (lastNewline < 0) {
				// One record longer than the whole window: step past it rather than
				// re-reading the same bytes on every refresh forever. The next window
				// resumes mid-record, whose fragment simply fails to parse.
				this.subagentDiffOffsets.set(file, start + bytesRead);
				return false;
			}
			this.subagentDiffOffsets.set(file, start + lastNewline + 1);
			let committed = false;
			for (const line of window.subarray(0, lastNewline).toString("utf8").split("\n")) {
				// Cheap gate: session files are mostly multi-KB message rows and
				// parsing them all would cost more than the read did.
				if (!line.includes('"diffs"')) continue;
				try {
					const entry = JSON.parse(line) as { type?: string; message?: ToolResultMessage };
					if (entry.type !== "message" || entry.message?.role !== "toolResult" || entry.message.isError === true) continue;
					if (this.commitKernelDiffs(entry.message.details?.diffs, this.subagentDiffFiles, agent)) committed = true;
				} catch {
					// malformed or half-written line — the next refresh reads past it
				}
			}
			return committed;
		} catch {
			// The child just spawned and has no file yet, or the daemon named a path
			// we cannot read. Silence is right: the strip already reports the child.
			return false;
		} finally {
			await handle?.close();
		}
	}

	/** Reset per-thread diff state (new session / switch / attach / agent exit). */
	clear(): void {
		if (this.threadDiffsTimer) {
			clearTimeout(this.threadDiffsTimer);
			this.threadDiffsTimer = null;
		}
		this.threadDiffGeneration += 1;
		const had = this.threadDiffFiles.size > 0 || this.subagentDiffFiles.size > 0;
		this.threadDiffFiles.clear();
		this.subagentDiffFiles.clear();
		// Offsets go with the rows: the next children refresh re-reads each child
		// from byte 0, which is what restores the panel after a subagent round trip.
		this.subagentDiffOffsets.clear();
		this.threadDiffPendings.clear();
		if (had) this.post();
	}

	private queueThreadDiffsBroadcast(): void {
		if (this.host.isDisposed()) return;
		if (this.threadDiffsTimer) return;
		this.threadDiffsTimer = setTimeout(() => {
			this.threadDiffsTimer = null;
			this.post();
		}, 200);
	}

	post(): void {
		if (this.host.isDisposed()) return;
		// One row per file, own edits first then each subagent's — the hunks carry
		// their own author, so a file both touched reads as one file, not two.
		const byPath = new Map<string, { source: ThreadDiffSource; hunks: ThreadDiffHunk[] }>();
		for (const source of [this.threadDiffFiles, this.subagentDiffFiles]) {
			for (const [path, accum] of source) {
				const existing = byPath.get(path);
				if (existing) existing.hunks.push(...accum.hunks);
				else byPath.set(path, { source: accum.source, hunks: [...accum.hunks] });
			}
		}
		const files: ThreadDiffFile[] = [];
		for (const [path, entry] of byPath) {
			files.push({
				path,
				viaSource: entry.source,
				hunks: entry.hunks.map((hunk) => ({
					removed: [...hunk.removed],
					added: [...hunk.added],
					...(hunk.note ? { note: hunk.note } : {}),
					...(hunk.agent ? { agent: hunk.agent } : {}),
				})),
			});
		}
		this.host.post({ type: "threadDiffs", files });
	}
}

const THREAD_DIFF_MAX_FILES = 200;
const THREAD_DIFF_MAX_HUNKS_PER_FILE = 60;
const THREAD_DIFF_SIDE_CAP = 400;
const THREAD_DIFF_WRITE_CAP = 240;
const THREAD_DIFF_MAX_PENDING = 200;
/** Child session files tailed per refresh; beyond this the strip is unusable anyway. */
const THREAD_DIFF_MAX_CHILD_FILES = 24;
/** Bytes read from one child session file per refresh. */
const THREAD_DIFF_CHILD_READ_BYTES = 2 * 1024 * 1024;

/** Per-file accumulated state (append-ordered, chronologically). */
interface ThreadDiffAccum {
	source: ThreadDiffSource;
	hunks: ThreadDiffHunk[];
}

/** Staged data from tool_execution_start, committed on a non-error end event. */
interface ThreadDiffPending {
	path: string;
	source: ThreadDiffSource;
	hunks: ThreadDiffHunk[];
}

function splitCleanLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Workspace-relative display form when the path resolves inside the root. */
function normalizeToolPath(rawPath: unknown, workspaceRoot: string): string | null {
	if (typeof rawPath !== "string" || !workspaceRoot) return null;
	let display = rawPath.trim();
	if (display.startsWith("./")) display = display.slice(2);
	if (!display) return null;
	if (path.isAbsolute(display)) {
		const rel = path.relative(workspaceRoot, display);
		if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
			display = rel.split(path.sep).join("/");
		} else return null;
	}
	if (display.split(/[\\/]+/).some((part) => part === "..")) return null;
	return display;
}

/** Watcher parity: never surface vendored or git-internal paths on the panel. */
function isThreadDiffPathWorthy(display: string): boolean {
	return !display.includes("node_modules/") && display !== ".git" && !display.includes("/.git/") && !display.startsWith(".git/");
}

/** Truncate a hunk side and produce the gutter note when truncated. */
function capHunkSides(removed: string[], added: string[], sideCap: number): ThreadDiffHunk {
	const notes: string[] = [];
	let keptRemoved = removed;
	let keptAdded = added;
	if (keptRemoved.length > sideCap) {
		notes.push(`… (${keptRemoved.length - sideCap} more removed lines)`);
		keptRemoved = keptRemoved.slice(0, sideCap);
	}
	if (keptAdded.length > sideCap) {
		const note = `… (+${keptAdded.length - sideCap} more lines)`;
		notes.push(note);
		keptAdded = keptAdded.slice(0, sideCap);
	}
	return { removed: keptRemoved, added: keptAdded, ...(notes.length > 0 ? { note: notes.join(" ") } : {}) };
}
