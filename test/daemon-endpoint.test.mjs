/**
 * Daemon endpoint discovery (src/daemon-endpoint.ts): where the background
 * service listens, whether the agent has an in-process RPC, and how a daemon is
 * found or started — all against fake launchers and a fake daemon, so the
 * contract is pinned without an agent installed.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./bundle.mjs";
import { startFakeDaemon } from "./fake-daemon.mjs";
import { realTempDir, removeDir } from "./isolated-agent.mjs";

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const { mod, dispose } = bundle("src/daemon-endpoint.ts");
const { defaultSocketCandidates, hasInProcessRpc, collectLaunchEnv, telemetryDisabledByEnv, queryAgentVersion, queryAgentSocket, socketCandidates, probeDaemon, ensureDaemon } = mod;

const work = realTempDir("pa-endpoint-");
const savedEnv = { ...process.env };
const resetEnv = () => {
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	delete process.env.PRIME_AGENT_DAEMON_SOCKET;
};
resetEnv();

function fakeAgent(name, body) {
	const file = path.join(work, name);
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	fs.chmodSync(file, 0o755);
	return file;
}

// ---- default candidates ------------------------------------------------------
const uid = String(process.getuid?.() ?? "user");
let c = defaultSocketCandidates({ PRIME_AGENT_DAEMON_SOCKET: "/explicit/d.sock", TMPDIR: "/tmp" });
check("an explicit PRIME_AGENT_DAEMON_SOCKET is the only candidate", JSON.stringify(c) === JSON.stringify(["/explicit/d.sock"]), JSON.stringify(c));
c = defaultSocketCandidates({ TMPDIR: "/var/tmp/x" });
if (process.platform !== "win32") {
	check("the launcher's socket is tried before the native default", c[0] === `/var/tmp/x/prime-agent-rust-${uid}/daemon.sock` && c[1] === `/var/tmp/x/prime-agent-${uid}/daemon.sock`, JSON.stringify(c));
}
if (process.platform === "darwin") {
	const long = `/private/var/folders/${"a".repeat(60)}/T`;
	c = defaultSocketCandidates({ TMPDIR: long });
	check("a TMPDIR too deep for sun_path falls back to /tmp, as the agent does", c.every((p) => p.startsWith("/tmp/prime-agent")), JSON.stringify(c));
}

// ---- version gate ------------------------------------------------------------
check("0.9.8 (TypeScript) has a daemon-backed RPC of its own", hasInProcessRpc("0.9.8") === false);
check("0.10.0 is the first Rust release", hasInProcessRpc("0.10.0") === true);
check("a beta of the Rust line counts", hasInProcessRpc("0.10.1-beta.52") === true);
check("a later major counts", hasInProcessRpc("1.2.3") === true);
check("an unknown version keeps the proven behaviour", hasInProcessRpc(undefined) === false && hasInProcessRpc("garbage") === false);

// ---- environment hand-over -----------------------------------------------------
process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN = "secret";
process.env.ELECTRON_RUN_AS_NODE = "1";
process.env.PA_MARKER = "kept";
const env = collectLaunchEnv({ PATH: "/a:/b" });
check("the client's environment travels, with the overrides applied", env.PA_MARKER === "kept" && env.PATH === "/a:/b");
check("daemon-internal identity and ELECTRON_RUN_AS_NODE never travel", !("PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN" in env) && !("ELECTRON_RUN_AS_NODE" in env));
delete process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN;
delete process.env.ELECTRON_RUN_AS_NODE;
check("DO_NOT_TRACK=1 opts the session out", telemetryDisabledByEnv({ DO_NOT_TRACK: "1" }) === true);
check("PRIME_AGENT_TELEMETRY=off opts the session out", telemetryDisabledByEnv({ PRIME_AGENT_TELEMETRY: "off" }) === true);
check("an empty environment does not", telemetryDisabledByEnv({}) === false && telemetryDisabledByEnv({ DO_NOT_TRACK: "0" }) === false);

// ---- asking the agent ------------------------------------------------------------
const statusAgent = fakeAgent(
	"agent-ok",
	`case "$1" in
  --version) echo "prime-agent 0.10.1" ;;
  status) echo '[{"socketPath":"/other/d.sock","isDefault":false},{"socketPath":"${path.join(work, "reported", "d.sock")}","status":"unreachable","isDefault":true}]' ;;
esac`,
);
check("the version comes from --version", (await queryAgentVersion({ command: statusAgent })) === "0.10.1");
check("the socket comes from the isDefault row of status --json", (await queryAgentSocket({ command: statusAgent })) === path.join(work, "reported", "d.sock"));
// VS Code's extension host runs with ELECTRON_RUN_AS_NODE; the agent and everything it
// starts must not inherit it (the subprocess transport strips it for the same reason).
process.env.ELECTRON_RUN_AS_NODE = "1";
const envAgent = fakeAgent("agent-env", `[ "$1" = status ] && echo '[{"socketPath":"/x/'"\${ELECTRON_RUN_AS_NODE:-unset}"'.sock","isDefault":true}]'`);
check("ELECTRON_RUN_AS_NODE is not handed to the agent's helpers", (await queryAgentSocket({ command: envAgent })) === "/x/unset.sock", String(await queryAgentSocket({ command: envAgent })));
delete process.env.ELECTRON_RUN_AS_NODE;

const brokenAgent = fakeAgent("agent-broken", "exit 3");
check("a failing agent yields no version and no socket", (await queryAgentVersion({ command: brokenAgent })) === undefined && (await queryAgentSocket({ command: brokenAgent })) === undefined);
const junkAgent = fakeAgent("agent-junk", 'echo "not json"');
check("non-JSON status output yields no socket", (await queryAgentSocket({ command: junkAgent })) === undefined);
check("a missing agent yields none, without throwing", (await queryAgentSocket({ command: path.join(work, "nope") })) === undefined);

let candidates = await socketCandidates({ command: statusAgent });
check("the agent's own answer is tried first, then the computed defaults", candidates[0] === path.join(work, "reported", "d.sock") && candidates.length >= 2 && new Set(candidates).size === candidates.length, JSON.stringify(candidates));
process.env.PRIME_AGENT_DAEMON_SOCKET = "/operator/chose.sock";
candidates = await socketCandidates({ command: statusAgent });
check("the operator's explicit socket short-circuits everything", JSON.stringify(candidates) === JSON.stringify(["/operator/chose.sock"]));
delete process.env.PRIME_AGENT_DAEMON_SOCKET;

// ---- probing -------------------------------------------------------------------------
const running = await startFakeDaemon({});
const hello = await probeDaemon(running.socketPath);
check("a compatible daemon answers the probe", hello?.protocol?.name === "prime-agent.daemon" && hello?.appVersion === "0.0.0-fake");
check("nothing listening probes as null", (await probeDaemon(path.join(work, "no-socket"))) === null);

const foreignPath = path.join(work, "foreign.sock");
const foreign = net.createServer((socket) => {
	socket.write(`${JSON.stringify({ type: "daemon_hello", protocol: { name: "some.other.protocol", version: 1 } })}\n`);
	socket.on("error", () => {});
});
await new Promise((resolve) => foreign.listen(foreignPath, resolve));
check("a socket speaking another protocol probes as null", (await probeDaemon(foreignPath)) === null);

// ---- ensure ------------------------------------------------------------------------------
process.env.PRIME_AGENT_DAEMON_SOCKET = running.socketPath;
let ensured = await ensureDaemon({ command: statusAgent });
check("a running daemon is found, not restarted", ensured.socketPath === running.socketPath && ensured.started === false);
delete process.env.PRIME_AGENT_DAEMON_SOCKET;

const explicit = await ensureDaemon({ command: brokenAgent }, { socketPath: running.socketPath });
check("an explicit socketPath (--daemon-socket) selects the endpoint", explicit.socketPath === running.socketPath && explicit.started === false);

const runner = fileURLToPath(new URL("./fake-daemon-runner.mjs", import.meta.url));
const startable = path.join(work, "start", "d.sock");
const launcher = fakeAgent("agent-launcher", `exec "${process.execPath}" "${runner}" "$@"`);
ensured = await ensureDaemon({ command: launcher }, { socketPath: startable });
check("with none running, one is started through the launcher at the chosen socket", ensured.socketPath === startable && ensured.started === true && (await probeDaemon(startable)) !== null, JSON.stringify(ensured.socketPath));

const began = Date.now();
let refused = null;
try {
	await ensureDaemon({ command: launcher }, { socketPath: foreignPath });
} catch (error) {
	refused = error;
}
check("a socket owned by another build is refused, by name", refused instanceof Error && /did not complete a compatible/.test(refused.message), refused ? `${refused.message.slice(0, 90)} (${Date.now() - began}ms)` : "no error");

const dying = fakeAgent("agent-dies", "exit 7");
const diedAt = Date.now();
let died = null;
try {
	await ensureDaemon({ command: dying }, { socketPath: path.join(work, "dies", "d.sock") });
} catch (error) {
	died = error;
}
check("a daemon that exits at once fails the start immediately, with its exit code", died instanceof Error && /exited immediately \(exit 7\)/.test(died.message) && Date.now() - diedAt < 5_000, died ? `${died.message.slice(0, 100)} (${Date.now() - diedAt}ms)` : "no error");

let cancelled = null;
try {
	await ensureDaemon({ command: fakeAgent("agent-silent", "sleep 30") }, { socketPath: path.join(work, "never", "d.sock"), signal: { cancelled: true } });
} catch (error) {
	cancelled = error;
}
check("a cancelled start stops waiting", cancelled instanceof Error && /cancelled/.test(cancelled.message), cancelled?.message ?? "no error");

// ---- cleanup -----------------------------------------------------------------------------
foreign.close();
await running.stop();
try {
	const { execFileSync } = await import("node:child_process");
	execFileSync("pkill", ["-f", `${runner}`], { stdio: "ignore" });
} catch {
	// nothing left running
}
resetEnv();
dispose();
await removeDir(work);
console.log(failed === 0 ? "\nPASS daemon-endpoint" : `\n${failed} daemon-endpoint checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
