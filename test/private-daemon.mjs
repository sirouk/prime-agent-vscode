/**
 * A private daemon for live gates.
 *
 * A live gate that talks to "whatever daemon is running" depends on the
 * operator's machine (which build, which socket, what else is on it) and can
 * disturb a service they are using. This starts a daemon of its own on a socket
 * only the gate knows, with its own throwaway agent directory (see
 * isolated-agent.mjs), points `PRIME_AGENT_DAEMON_SOCKET` at it for the gate and
 * everything it spawns, and removes all of it afterwards.
 *
 * `PA_LIVE_DAEMON_SOCKET` opts back in to an existing daemon for diagnosis.
 */

import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isolatedAgent, realTempDir, removeDir } from "./isolated-agent.mjs";

export async function startPrivateDaemon({ command = process.env.PRIME_AGENT_COMMAND || "prime-agent", timeoutMs = 20_000 } = {}) {
	const existing = process.env.PA_LIVE_DAEMON_SOCKET;
	if (existing) {
		process.env.PRIME_AGENT_DAEMON_SOCKET = existing;
		return { socket: existing, owned: false, stop: async () => {} };
	}
	const agent = isolatedAgent("pa-live-agent-");
	agent.apply();
	const dir = realTempDir("pa-live-");
	const socket = path.join(dir, "d.sock");
	const child = spawn(command, ["--mode", "daemon", "--daemon-socket", socket], { cwd: dir, detached: true, stdio: "ignore", env: process.env });
	let spawnError = null;
	child.on("error", (error) => (spawnError = error));
	child.unref();
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(socket)) {
		if (spawnError) throw new Error(`could not start ${command}: ${spawnError.message}`);
		if (Date.now() > deadline) throw new Error(`the daemon did not create ${socket} within ${timeoutMs / 1000}s`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	process.env.PRIME_AGENT_DAEMON_SOCKET = socket;
	return {
		socket,
		owned: true,
		agentDir: agent.dir,
		async stop() {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				// already gone
			}
			try {
				execFileSync("pkill", ["-f", socket], { stdio: "ignore" });
			} catch {
				// nothing matched
			}
			await new Promise((resolve) => setTimeout(resolve, 400));
			delete process.env.PRIME_AGENT_DAEMON_SOCKET;
			await removeDir(dir);
			await agent.cleanup();
		},
	};
}
