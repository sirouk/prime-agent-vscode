/**
 * A throwaway agent directory for live tests.
 *
 * The agent writes to its state directory while it runs: settings (`/model`
 * persists the default model and thinking level), worker descriptors, logs,
 * session leases, telemetry. A live test that points the agent at the operator's
 * real `~/.prime/agent` therefore edits the operator's configuration — a test
 * that sets a model once rewrote a real `settings.json`. So tests get their own
 * directory, with only what they need to be able to talk to a model linked
 * through read-only: credentials, custom model/endpoint definitions, and the
 * already-built Python kernel (rebuilding it per test would need the network and
 * half a minute).
 *
 * Paths are canonicalised on purpose. On macOS `os.tmpdir()` lies under the
 * `/var -> /private/var` symlink, and the daemon's session lease compares a
 * canonical path with the one it was handed, refusing every append when they
 * differ ("session lease does not own append target").
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LINKED = ["auth.json", "models.json", "endpoints.json", "endpoints"];

export function realTempDir(prefix) {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Remove a directory a daemon may still be writing into. A supervisor that has
 * just been told to stop flushes worker descriptors, logs and telemetry on its way
 * out, and its workers outlive it by a few seconds (a worker writes its kernel
 * snapshot last), so a single `rmSync` can leave files behind, fail with ENOTEMPTY,
 * or be undone by a write that lands afterwards. Remove until the directory has
 * stayed gone for a full second.
 */
export async function removeDir(dir) {
	let goneSince = 0;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// a late write raced the removal; try again
		}
		if (fs.existsSync(dir)) goneSince = 0;
		else if (goneSince === 0) goneSince = Date.now();
		else if (Date.now() - goneSince >= 1_000) return;
		await sleep(150);
	}
}

function processCommand(pid) {
	try {
		return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

/**
 * Stop the agent workers recorded under this agent directory. Their descriptors live
 * inside the throwaway directory, so these are exactly the workers this test's own
 * daemon started; a pid is only signalled while it is still a prime-agent process.
 */
export async function stopWorkers(agentDir) {
	const root = path.join(agentDir, "daemon-workers");
	const pids = new Set();
	let groups = [];
	try {
		groups = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	} catch {
		return;
	}
	for (const group of groups) {
		for (const name of fs.readdirSync(path.join(root, group.name))) {
			if (!name.endsWith(".json") || name.includes(".recovery.") || name.includes(".orphans.")) continue;
			try {
				const pid = JSON.parse(fs.readFileSync(path.join(root, group.name, name), "utf8")).pid;
				if (Number.isInteger(pid) && pid > 1 && /prime-agent/.test(processCommand(pid))) pids.add(pid);
			} catch {
				// unreadable descriptor: nothing to stop
			}
		}
	}
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	const deadline = Date.now() + 4_000;
	while (Date.now() < deadline && [...pids].some((pid) => /prime-agent/.test(processCommand(pid)))) await sleep(100);
	for (const pid of pids) {
		if (!/prime-agent/.test(processCommand(pid))) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

export function isolatedAgent(prefix = "prime-agent-iso-") {
	const real = process.env.PRIME_AGENT_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".prime", "agent");
	const dir = realTempDir(prefix);
	for (const name of LINKED) {
		const source = path.join(real, name);
		if (fs.existsSync(source)) fs.symlinkSync(source, path.join(dir, name));
	}
	const env = {
		PRIME_AGENT_CODING_AGENT_DIR: dir,
		PRIME_AGENT_KERNEL_VENV: process.env.PRIME_AGENT_KERNEL_VENV || path.join(real, "kernel-venv"),
	};
	return {
		dir,
		env,
		/** Point this process, and everything it spawns, at the throwaway directory. */
		apply() {
			Object.assign(process.env, env);
		},
		async cleanup() {
			await stopWorkers(dir);
			await removeDir(dir);
		},
	};
}
