/**
 * Where the Prime Agent background service (the daemon) listens, and how to
 * make sure one is running.
 *
 * Why this is not a constant: the installer's `prime-agent` launcher pins
 * `PRIME_AGENT_DAEMON_SOCKET` to `<tmp>/prime-agent-rust-<uid>/daemon.sock` for
 * the agent it starts, so the Rust build and the old TypeScript build never
 * fight over one socket. That variable lives in the launcher's environment, not
 * in this editor's, so computing `<tmp>/prime-agent-<uid>/daemon.sock` here
 * (the TypeScript-era default) looks in the wrong place on every machine that
 * installed through the launcher. The agent itself is the authority:
 * `prime-agent status --json` names the socket it would use, launcher
 * environment included.
 *
 * No vscode dependency: the endpoint logic is exercised headless.
 */

import { execFile, spawn } from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { DaemonSidecar, type DaemonHello } from "./daemon-sidecar.js";
import { launchSpec } from "./rpc-client.js";

/** How to run the agent CLI: the resolved command and the environment to give it. */
export interface AgentLaunch {
	command: string;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}

/**
 * The environment for a helper or the daemon itself. VS Code's extension host runs
 * with `ELECTRON_RUN_AS_NODE` set, which would make every Electron-based tool the
 * agent later starts behave as plain Node; the subprocess transport strips it for the
 * same reason.
 */
function childEnv(launch: AgentLaunch): NodeJS.ProcessEnv {
	const env = { ...process.env, ...launch.env };
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}

export interface DaemonEndpoint {
	socketPath: string;
	hello: DaemonHello;
	/** True when this call started the daemon (as opposed to finding one running). */
	started: boolean;
}

/** `sockaddr_un.sun_path` is 104 bytes on macOS/BSD (103 + NUL); the agent falls back to /tmp past it. */
const MAX_UNIX_SOCKET_PATH_BYTES = 103;
const STATUS_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 1_500;
const DAEMON_START_TIMEOUT_MS = 30_000;
const DAEMON_START_POLL_MS = 100;

function currentUid(): string {
	return String(process.getuid?.() ?? "user");
}

function shortenForUnixSocket(candidate: string, fallbackDir: string): string {
	if (process.platform === "linux" || process.platform === "win32") return candidate;
	return Buffer.byteLength(candidate, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES ? fallbackDir : candidate;
}

/**
 * The sockets a Prime Agent daemon can be on without asking the agent, most
 * likely first. `PRIME_AGENT_DAEMON_SOCKET` always wins: it is the operator's
 * explicit statement, and the launcher honours it the same way.
 */
export function defaultSocketCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
	const explicit = env.PRIME_AGENT_DAEMON_SOCKET?.trim();
	if (explicit) return [explicit];
	if (process.platform === "win32") return ["\\\\.\\pipe\\prime-agent-daemon"];
	const uid = currentUid();
	const tmp = env.TMPDIR?.trim() || os.tmpdir();
	const launcher = shortenForUnixSocket(
		path.join(tmp, `prime-agent-rust-${uid}`, "daemon.sock"),
		path.join("/tmp", `prime-agent-rust-${uid}`, "daemon.sock"),
	);
	const native = shortenForUnixSocket(
		path.join(tmp, `prime-agent-${uid}`, "daemon.sock"),
		path.join("/tmp", `prime-agent-${uid}`, "daemon.sock"),
	);
	return launcher === native ? [launcher] : [launcher, native];
}

/**
 * Ask the agent which socket it would use (`prime-agent status --json`, the row
 * marked `isDefault`). Undefined when the agent cannot answer — an older build
 * without `--json`, a missing binary — in which case the caller falls back to
 * the computed candidates.
 */
export function queryAgentSocket(launch: AgentLaunch, timeoutMs = STATUS_TIMEOUT_MS): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		try {
			const spec = launchSpec(launch.command, ["status", "--json"]);
			execFile(
				spec.command,
				spec.args,
				{ env: childEnv(launch), cwd: launch.cwd, timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments },
				(error, stdout) => {
					if (error) return finish(undefined);
					try {
						const rows: unknown = JSON.parse(stdout);
						const list = Array.isArray(rows) ? rows : [];
						const row =
							list.find((entry) => (entry as { isDefault?: unknown })?.isDefault === true) ?? list[0];
						const socketPath = (row as { socketPath?: unknown } | undefined)?.socketPath;
						finish(typeof socketPath === "string" && socketPath ? socketPath : undefined);
					} catch {
						finish(undefined);
					}
				},
			);
		} catch {
			finish(undefined);
		}
	});
}

/** The agent's reported version (`prime-agent --version`), e.g. "0.10.1"; undefined when it cannot say. */
export function queryAgentVersion(launch: AgentLaunch, timeoutMs = 8_000): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			const spec = launchSpec(launch.command, ["--version"]);
			execFile(
				spec.command,
				spec.args,
				{ env: childEnv(launch), cwd: launch.cwd, timeout: timeoutMs, maxBuffer: 1 << 16, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments },
				(error, stdout) => {
					if (error) return resolve(undefined);
					const match = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(stdout);
					resolve(match?.[0]);
				},
			);
		} catch {
			resolve(undefined);
		}
	});
}

/**
 * Whether `--mode rpc` of this agent is an in-process engine with no daemon
 * behind it. 0.10.0 is the first Rust release; 0.9.8 and earlier were the
 * TypeScript agent, whose RPC mode was itself a daemon client. An unknown
 * version is treated as the older, proven behaviour.
 */
export function hasInProcessRpc(version: string | undefined): boolean {
	const match = version ? /^(\d+)\.(\d+)\./.exec(version) : null;
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 0 || minor >= 10;
}

/**
 * The environment a daemon session's worker should run in: this process's, as a
 * terminal client would forward its own, minus what must not travel. The
 * daemon-internal `PRIME_AGENT_INTERNAL_*` variables are stamped by the
 * supervisor and are never inherited from a client; `ELECTRON_RUN_AS_NODE` would
 * make every Electron-based tool the agent starts behave as plain Node.
 */
export function collectLaunchEnv(overrides: NodeJS.ProcessEnv = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
		if (value === undefined) continue;
		if (key.startsWith("PRIME_AGENT_INTERNAL_") || key === "ELECTRON_RUN_AS_NODE") continue;
		env[key] = value;
	}
	return env;
}

/** Telemetry opt-out the environment expresses; a settings opt-out stays live in the daemon. */
export function telemetryDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const falsy = (value: string | undefined): boolean => value !== undefined && /^(0|false|off|no)$/i.test(value.trim());
	const truthy = (value: string | undefined): boolean => value !== undefined && /^(1|true|on|yes)$/i.test(value.trim());
	return truthy(env.DO_NOT_TRACK) || truthy(env.PI_OFFLINE) || falsy(env.PRIME_AGENT_TELEMETRY);
}

/** Every socket to try, in order, without duplicates. */
export async function socketCandidates(launch: AgentLaunch): Promise<string[]> {
	const explicit = process.env.PRIME_AGENT_DAEMON_SOCKET?.trim();
	if (explicit) return [explicit];
	const reported = await queryAgentSocket(launch);
	return [...new Set([...(reported ? [reported] : []), ...defaultSocketCandidates(process.env)])];
}

/** Whether something is accepting connections on the path at all (cheap pre-check before a handshake). */
function canConnect(socketPath: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ path: socketPath });
		const done = (ok: boolean): void => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

/** Handshake with a daemon on `socketPath`; null when nothing compatible answers. */
export async function probeDaemon(socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<DaemonHello | null> {
	if (!(await canConnect(socketPath, timeoutMs))) return null;
	const probe = new DaemonSidecar();
	probe.socketOverride = socketPath;
	try {
		await probe.connect(timeoutMs);
		return probe.hello;
	} catch {
		return null;
	} finally {
		probe.dispose();
	}
}

/**
 * Start a detached supervisor the way the CLI's own client does
 * (`prime-agent --mode daemon --daemon-socket <path>`): it must outlive this
 * window, so it gets its own session and no inherited stdio.
 */
function spawnDaemon(launch: AgentLaunch, socketPath: string): { exitCode: () => number | null | undefined } {
	const spec = launchSpec(launch.command, ["--mode", "daemon", "--daemon-socket", socketPath]);
	const child = spawn(spec.command, spec.args, {
		cwd: launch.cwd,
		env: childEnv(launch),
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		windowsVerbatimArguments: spec.windowsVerbatimArguments,
	});
	// A daemon that dies the instant it starts (a held lock, an unwritable directory)
	// would otherwise be polled for the whole start timeout with its cause lost.
	let exitCode: number | null | undefined;
	child.on("error", () => {
		exitCode = -1;
	});
	child.on("exit", (code) => {
		exitCode = code ?? -1;
	});
	child.unref();
	return { exitCode: () => exitCode };
}

/**
 * Find a running daemon, or start one, and return where it is.
 *
 * Only a daemon that answers a compatible handshake counts. A socket that
 * accepts connections but speaks another protocol is left strictly alone: it
 * belongs to some other build of the agent, and replacing it is the operator's
 * decision (`prime-agent shutdown`), not an editor's.
 */
export async function ensureDaemon(
	launch: AgentLaunch,
	options: { socketPath?: string; signal?: { cancelled: boolean }; log?: (line: string) => void } = {},
): Promise<DaemonEndpoint> {
	const log = options.log ?? (() => {});
	// An explicit `--daemon-socket` is the operator naming the endpoint, as it is for the CLI.
	const candidates = options.socketPath ? [options.socketPath] : await socketCandidates(launch);
	for (const socketPath of candidates) {
		const hello = await probeDaemon(socketPath);
		if (hello) {
			log(`[prime-agent] daemon found at ${socketPath} (${hello.appVersion ?? "unknown version"})`);
			return { socketPath, hello, started: false };
		}
	}
	const target = candidates[0];
	if (!target) throw new Error("No daemon socket location could be determined");
	// Something accepts connections there but did not give a compatible handshake.
	// Waiting out the start timeout would only end in the same refusal thirty seconds
	// later, so say so now — but a busy service is slow, not foreign, so give it a
	// longer chance to say hello before calling it another build.
	if (await canConnect(target, 500)) {
		const late = await probeDaemon(target, 6_000);
		if (late) return { socketPath: target, hello: late, started: false };
		throw new Error(
			`Something is listening on ${target} but did not complete a compatible Prime Agent handshake — a busy service, or one from another build. Try \`prime-agent shutdown\` in a terminal (or wait a moment), then Restart.`,
		);
	}
	log(`[prime-agent] no daemon running; starting one at ${target}`);
	const spawned = spawnDaemon(launch, target);
	const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (options.signal?.cancelled) throw new Error("Daemon start was cancelled");
		await new Promise((resolve) => setTimeout(resolve, DAEMON_START_POLL_MS));
		const hello = await probeDaemon(target);
		if (hello) return { socketPath: target, hello, started: true };
		const exited = spawned.exitCode();
		if (exited !== undefined) {
			throw new Error(`The Prime Agent background service exited immediately (exit ${exited}) instead of starting on ${target}. Run \`prime-agent --mode daemon --daemon-socket ${target}\` in a terminal to see why.`);
		}
	}
	throw new Error(`The Prime Agent background service did not start on ${target} within ${DAEMON_START_TIMEOUT_MS / 1000}s. Try \`prime-agent shutdown --force\` in a terminal, then Restart.`);
}
