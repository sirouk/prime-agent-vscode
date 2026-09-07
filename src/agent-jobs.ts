/**
 * Background jobs reported by the Prime Agent `background-jobs` extension.
 *
 * This is the first-class half of the Processes panel. The extension owns the
 * child process inside the agent, so what arrives here is not inferred from
 * anything: the exit code came from the OS, the log path was published by the
 * process's owner, and the job id is a handle the extension will act on. Where
 * process-tracker.ts reconstructs a fraction of the truth from a journal and
 * `ps`, this receives the whole of it.
 *
 * Two channels carry it, both of which this extension already consumes:
 *
 * - the tool result of a `background` call (`details.job`), which is how a job
 *   announces that it started;
 * - a `role: "custom"` message with `customType: "background-job"`, which is how
 *   the extension announces that one finished — the same message that wakes an
 *   idle agent.
 *
 * Nothing here is a new protocol. A session with no extension installed simply
 * never produces these, and the panel falls back to the observed rows.
 */

import { randomUUID } from "node:crypto";

import type { AgentEvent, AgentMessage, SessionProcess } from "./protocol.js";

/** The wire contract with agent-extension/background-jobs. */
export const BACKGROUND_JOB_TYPE = "background-job";
const BACKGROUND_TOOL = "background";

/** A job record as the extension publishes it (agent-extension/.../jobs.ts). */
export interface AgentJobRecord {
	id: string;
	command: string;
	cwd?: string;
	pid?: number;
	state: "running" | "exited";
	startedMs: number;
	endedMs?: number;
	exitCode?: number;
	signal?: string;
	logPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

/**
 * Parse a job record off the wire. It crosses a process boundary from code that
 * can be a different version of the extension, so every field is checked and a
 * record that fails is dropped rather than half-rendered.
 */
export function parseJobRecord(value: unknown): AgentJobRecord | undefined {
	if (!isRecord(value)) return undefined;
	const { id, command, state, startedMs, logPath } = value;
	if (typeof id !== "string" || !id || id.length > 64) return undefined;
	if (typeof command !== "string" || !command) return undefined;
	if (state !== "running" && state !== "exited") return undefined;
	if (typeof startedMs !== "number" || !Number.isFinite(startedMs)) return undefined;
	if (typeof logPath !== "string" || !logPath) return undefined;
	return {
		id,
		command: command.length > 4_000 ? `${command.slice(0, 4_000)}…` : command,
		...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
		...(typeof value.pid === "number" && Number.isInteger(value.pid) ? { pid: value.pid } : {}),
		state,
		startedMs,
		...(typeof value.endedMs === "number" && Number.isFinite(value.endedMs) ? { endedMs: value.endedMs } : {}),
		...(typeof value.exitCode === "number" && Number.isInteger(value.exitCode) ? { exitCode: value.exitCode } : {}),
		...(typeof value.signal === "string" && value.signal.length <= 32 ? { signal: value.signal } : {}),
		logPath,
	};
}

/** Pull a job record out of whichever shape the payload arrived in. */
function jobFromDetails(details: unknown): AgentJobRecord | undefined {
	if (!isRecord(details)) return undefined;
	return parseJobRecord(details.job);
}

/** Every message an event carries, whichever shape it uses. */
function messagesOf(event: AgentEvent): AgentMessage[] {
	const record = event as unknown as Record<string, unknown>;
	const found: AgentMessage[] = [];
	if (isRecord(record.message)) found.push(record.message as AgentMessage);
	for (const key of ["messages", "toolResults"]) {
		const list = record[key];
		if (Array.isArray(list)) {
			for (const item of list) if (isRecord(item)) found.push(item as AgentMessage);
		}
	}
	return found;
}

/** One line for the row: the command, flattened. */
function label(command: string, max = 96): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export class AgentJobIndex {
	private readonly jobs = new Map<string, AgentJobRecord>();
	/** Opaque host-issued capability per job, stable for as long as the job is known. */
	private readonly refByJobId = new Map<string, string>();
	private readonly jobIdByRef = new Map<string, string>();

	/** True when the index changed and the panel should be republished. */
	track(event: AgentEvent): boolean {
		if (event.type === "tool_execution_end" && event.toolName === BACKGROUND_TOOL) {
			const result = event.result;
			const job = isRecord(result) ? jobFromDetails(result.details) : undefined;
			if (job && this.apply(job)) return true;
		}
		// A completion notice is a message the extension injected, and which event
		// delivers it is not ours to assume — `message_end`, `turn_end` and
		// `agent_end` all carry messages. Reading whichever one arrives keeps the
		// panel live instead of waiting for the next snapshot to notice.
		const carried = messagesOf(event);
		return carried.length > 0 ? this.rebuildFromMessages(carried) : false;
	}

	/**
	 * Rebuild from the transcript. A resumed session, a reopened sidebar or a
	 * switch back from a subagent all arrive as messages with no events, so the
	 * panel has to be able to reconstruct itself from the thread alone.
	 */
	rebuildFromMessages(messages: readonly AgentMessage[]): boolean {
		let changed = false;
		for (const message of messages) {
			const record = message as unknown as Record<string, unknown>;
			if (record.role === "custom") {
				if (record.customType !== BACKGROUND_JOB_TYPE) continue;
				const job = jobFromDetails(record.details);
				if (job && this.apply(job)) changed = true;
				continue;
			}
			if (record.role !== "toolResult" || record.toolName !== BACKGROUND_TOOL) continue;
			const job = jobFromDetails(record.details);
			if (job && this.apply(job)) changed = true;
		}
		return changed;
	}

	clear(): void {
		this.jobs.clear();
		this.refByJobId.clear();
		this.jobIdByRef.clear();
	}

	/** Drop the finished receipts at the start of a turn, keeping live jobs. */
	clearFinished(): boolean {
		let changed = false;
		for (const [id, job] of [...this.jobs]) {
			if (job.state !== "exited") continue;
			this.jobs.delete(id);
			const ref = this.refByJobId.get(id);
			if (ref) {
				this.refByJobId.delete(id);
				this.jobIdByRef.delete(ref);
			}
			changed = true;
		}
		return changed;
	}

	/**
	 * Pids we already describe, so an observed row cannot duplicate a job.
	 *
	 * Running jobs only. A pid belongs to us for exactly as long as the process
	 * lives; holding it past the exit would let a finished job suppress the row of
	 * an unrelated process that the OS later handed the same number.
	 */
	knownPids(): Set<number> {
		const pids = new Set<number>();
		for (const job of this.jobs.values()) {
			if (job.state === "running" && job.pid !== undefined) pids.add(job.pid);
		}
		return pids;
	}

	jobIdForRef(ref: string): string | undefined {
		return this.jobIdByRef.get(ref);
	}

	logPathForRef(ref: string): string | undefined {
		const id = this.jobIdByRef.get(ref);
		return id ? this.jobs.get(id)?.logPath : undefined;
	}

	recordForRef(ref: string): AgentJobRecord | undefined {
		const id = this.jobIdByRef.get(ref);
		return id ? this.jobs.get(id) : undefined;
	}

	snapshot(): SessionProcess[] {
		return [...this.jobs.values()]
			.sort((a, b) => {
				if ((a.state === "running") !== (b.state === "running")) return a.state === "running" ? -1 : 1;
				return a.state === "running" ? a.startedMs - b.startedMs : (b.endedMs ?? 0) - (a.endedMs ?? 0);
			})
			.map((job) => ({
				ref: this.refFor(job.id),
				...(job.pid === undefined ? {} : { pid: job.pid }),
				command: label(job.command),
				fullCommand: job.command,
				state: job.state === "running" ? ("running" as const) : ("exited" as const),
				startedMs: job.startedMs,
				...(job.endedMs === undefined ? {} : { endedMs: job.endedMs }),
				...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
				...(job.signal === undefined ? {} : { signal: job.signal }),
				// The extension owns the process, so both of these are real offers
				// rather than best-effort attempts: a published log and a job id it
				// will act on.
				hasOutput: true as const,
				...(job.state === "running" ? { killable: true as const } : {}),
				source: "agent" as const,
			}));
	}

	private apply(job: AgentJobRecord): boolean {
		const existing = this.jobs.get(job.id);
		// A start can arrive after its own completion when a snapshot replays the
		// thread out of order. Never let it resurrect a job that already ended.
		if (existing?.state === "exited" && job.state === "running") return false;
		if (existing && JSON.stringify(existing) === JSON.stringify(job)) return false;
		this.jobs.set(job.id, job);
		this.refFor(job.id);
		return true;
	}

	private refFor(jobId: string): string {
		let ref = this.refByJobId.get(jobId);
		if (!ref) {
			ref = randomUUID();
			this.refByJobId.set(jobId, ref);
			this.jobIdByRef.set(ref, jobId);
		}
		return ref;
	}
}
