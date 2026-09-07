/**
 * Live gate: does the background-jobs extension actually load into Prime Agent?
 *
 * Everything the Processes panel now prefers rests on one assumption — that
 * `agent-extension/background-jobs` is a valid Prime Agent extension, that its
 * tool and command reach a client, and that the command runs without a model
 * call. Nothing in the unit tests can establish that: it is a fact about the
 * agent, not about our code. So this starts a real `prime-agent --mode rpc`
 * with the extension loaded and asks it.
 *
 * No LLM call is made: `get_commands` and `get_tool_definition` are answered
 * locally, and a slash command is dispatched by the agent before the model is
 * ever consulted. Requires the prime-agent CLI; skips cleanly without one, so
 * `npm test` stays runnable on a machine that has no agent installed.
 */

import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.cwd() + "/");

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

function locateAgent() {
	for (const candidate of ["prime-agent", path.join(os.homedir(), ".hermes/node/bin/prime-agent")]) {
		try {
			execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 20_000 });
			return candidate;
		} catch {
			// try the next one
		}
	}
	return undefined;
}

const agent = locateAgent();
if (!agent) {
	console.log("SKIP  prime-agent CLI not found — extension load gate not run");
	process.exit(0);
}

const extensionDir = fileURLToPath(new URL("../agent-extension/background-jobs", import.meta.url));
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-extload-"));

const child = spawn(agent, ["--mode", "rpc", "-e", extensionDir], {
	cwd: workdir,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, NO_COLOR: "1" },
});

let buffer = "";
const pending = new Map();
const stderr = [];
let nextId = 1;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		const resolve = pending.get(message.id);
		if (resolve) {
			pending.delete(message.id);
			resolve(message);
		}
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderr.push(chunk));

function request(type, extra = {}, timeoutMs = 60_000) {
	const id = String(nextId++);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			resolve({ success: false, error: `timed out after ${timeoutMs}ms` });
		}, timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
	});
}

const state = await request("get_state");
check("the agent answers over RPC with the extension loaded", state.success === true, JSON.stringify(state).slice(0, 200));
if (state.success !== true) {
	console.log(stderr.join("").slice(-2000));
}

const commands = await request("get_commands");
const names = (commands?.data?.commands ?? []).map((entry) => entry.name);
check("the extension's /jobs command is registered", names.includes("jobs"), JSON.stringify(names).slice(0, 400));
const jobsCommand = (commands?.data?.commands ?? []).find((entry) => entry.name === "jobs");
check("it is reported as coming from an extension", jobsCommand?.source === "extension", JSON.stringify(jobsCommand));

// A slash command is dispatched before the model ever sees it, so this costs no
// tokens — and it is the exact path the panel's Stop button uses.
const before = Date.now();
const ran = await request("prompt", { message: "/jobs" });
check("a slash command is accepted over RPC", ran.success === true, JSON.stringify(ran).slice(0, 200));
check("it is answered without a model call", Date.now() - before < 20_000, `${Date.now() - before}ms`);

// The whole loop with no model in it: start a job through the command, let it
// end, and read back the message the extension injects. That message is the
// contract src/agent-jobs.ts parses, so this is the one place the two codebases
// are checked against each other rather than against fixtures each side wrote.
const marker = path.join(workdir, "done.txt");
await request("prompt", { message: `/jobs start printf 'alpha\\nbeta\\n' > '${marker}'; sleep 1; exit 3` });

async function latestJobMessage() {
	const messages = await request("get_messages");
	const list = messages?.data?.messages ?? [];
	return list.filter((entry) => entry.role === "custom" && entry.customType === "background-job").at(-1);
}
const deadline = Date.now() + 30_000;
let completion;
while (Date.now() < deadline) {
	completion = await latestJobMessage();
	if (completion?.details?.job?.state === "exited") break;
	await new Promise((resolve) => setTimeout(resolve, 500));
}

check("the job actually ran", fs.existsSync(marker));
check("a completion message is injected into the session", !!completion, JSON.stringify(completion ?? null).slice(0, 250));
check("it carries the customType the panel keys on", completion?.customType === "background-job");
check("it is displayed rather than hidden", completion?.display === true);
const record = completion?.details?.job;
check("it carries a structured job record", !!record?.id && !!record?.logPath, JSON.stringify(record ?? null).slice(0, 250));
check("the record carries the real exit code", record?.exitCode === 3, JSON.stringify(record?.exitCode));
check("the record is marked exited", record?.state === "exited");
check("the published log path is readable by a client", record?.logPath ? fs.existsSync(record.logPath) : false, record?.logPath);

// The panel's own parser, run against what the extension actually produced.
const { parseJobRecord } = require("./dist/agent-jobs.cjs");
const parsed = record ? parseJobRecord(record) : undefined;
check(
	"the host parser accepts the real record",
	parsed?.exitCode === 3 && parsed?.state === "exited",
	JSON.stringify(parsed ?? null).slice(0, 250),
);

// The headline claim: a finished job wakes an idle agent. The message above was
// injected with `triggerTurn: true` while nothing was running, so if the option
// does what it says, the session is now streaming. The turn is aborted the
// instant it is observed — this gate proves the wake, it does not buy a reply.
let woke = false;
const wakeDeadline = Date.now() + 20_000;
while (Date.now() < wakeDeadline) {
	const state = await request("get_state", {}, 15_000);
	if (state?.data?.isStreaming === true) {
		woke = true;
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 400));
}
await request("abort", {}, 15_000);
check("a finished job wakes the idle agent into a turn", woke, woke ? "" : "no turn observed within 20s");

child.stdin.end();
child.kill("SIGTERM");
fs.rmSync(workdir, { recursive: true, force: true });
console.log(failed === 0 ? "\nextension-load: all checks passed" : `\nextension-load: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
