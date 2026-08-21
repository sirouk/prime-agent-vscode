/**
 * Live gate for the client-owned roster hole.
 *
 * The daemon lists a worker's sessions only when the worker is visible
 * (`ownerClientId === undefined`) or when the caller passes
 * `includeClientOwned: true` AND is the client that owns it. Our RPC session is
 * client-owned, so a plain `list all` from the sidecar returns neither our live
 * root nor any of its subagents — the regression that made a running agent read
 * as stopped with an empty subagent strip.
 *
 * This proves all three legs against a REAL daemon, with no model calls:
 *   1. `list all`                          -> our client-owned session is absent
 *   2. `list all` + includeClientOwned     -> still absent (flag alone is not enough)
 *   3. listAsOwner(ownerClientId)          -> present
 * plus that resolveOwnerClientId() recovers that owner id from the descriptor
 * the daemon actually wrote.
 *
 * Safety: creates, inspects and kills exactly one session of its own, rooted in
 * an isolated mkdtemp directory. Sessions from `list` are never touched.
 *
 * No daemon running? Skip-exits 0 so CI never hangs — unless PA_REQUIRE_DAEMON=1
 * or --require-daemon, which turns the skip into a failure.
 *
 * Run: node test/owned-roster.mjs
 */

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const { DaemonSidecar, resolveOwnerClientId } = require("../dist/daemon-sidecar.cjs");

const REQUIRE_DAEMON = process.env.PA_REQUIRE_DAEMON === "1" || process.argv.includes("--require-daemon");
const WATCHDOG_MS = 90_000;

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const watchdog = setTimeout(() => {
	console.log("FAIL  owned-roster watchdog expired");
	process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-owned-roster-"));
const sessionDir = path.join(workRoot, "sessions");
fs.mkdirSync(sessionDir, { recursive: true });

const ownerClientId = `daemon-client:${randomUUID()}`;
const producer = new DaemonSidecar();
producer.impersonateClientId = ownerClientId;

const rowId = (row) => row.activeSessionId ?? row.id ?? "";
const has = (rows, id) => rows.some((row) => rowId(row) === id);

let createdId = "";

async function main() {
	try {
		await producer.connect(8_000);
	} catch (error) {
		clearTimeout(watchdog);
		const message = `no daemon available: ${String(error)}`;
		if (REQUIRE_DAEMON) {
			console.log(`FAIL  ${message}`);
			process.exit(1);
		}
		console.log(`SKIP  owned-roster — ${message}`);
		process.exit(0);
	}

	// A client-owned session is exactly what `--mode rpc` creates for us.
	const summary = await producer.request(
		{ type: "create", lifecycle: "client_owned", config: { cwd: workRoot, sessionDir } },
		30_000,
	);
	createdId = summary?.activeSessionId ?? summary?.id ?? "";
	if (!createdId) throw new Error(`create returned no session id: ${JSON.stringify(summary)}`);
	const sessionFile = summary?.sessionFile;

	// 1. The owner id must be recoverable from the descriptor the daemon wrote.
	const resolved = resolveOwnerClientId({ sessionFile, activeSessionId: createdId });
	check("resolveOwnerClientId recovers the owner id from the live descriptor", resolved === ownerClientId, `got ${resolved ?? "undefined"}`);
	if (sessionFile) {
		check(
			"the owner id resolves from the session file alone (the production key)",
			resolveOwnerClientId({ sessionFile }) === ownerClientId,
		);
	}

	// 2. A second client is what the extension's sidecar actually is.
	const observer = new DaemonSidecar();
	await observer.connect(8_000);
	try {
		check("a plain `list all` cannot see the client-owned session", !has(await observer.list(true), createdId));
		check(
			"`includeClientOwned` alone is still not enough",
			!has(await observer.list(true, { includeClientOwned: true }), createdId),
		);

		const owned = await DaemonSidecar.listAsOwner(ownerClientId);
		check("listAsOwner sees the client-owned session", has(owned, createdId));
		check("listAsOwner stays a superset of the plain roster", owned.length >= (await observer.list(true)).length);

		// Repeatable: each call must stand up its own connection and tear it down.
		check("listAsOwner is repeatable", has(await DaemonSidecar.listAsOwner(ownerClientId), createdId));

		// A foreign identity must not open the door to somebody else's worker.
		const stranger = await DaemonSidecar.listAsOwner(`daemon-client:${randomUUID()}`);
		check("an unrelated owner id sees nothing extra", !has(stranger, createdId));
	} finally {
		observer.dispose();
	}
}

async function cleanup() {
	if (createdId) {
		try {
			await producer.request({ type: "kill", activeSessionId: createdId }, 15_000);
		} catch (error) {
			console.log(`note: could not kill ${createdId}: ${String(error)}`);
		}
	}
	producer.dispose();
	try {
		fs.rmSync(workRoot, { recursive: true, force: true });
	} catch {
		// a worker may still hold the dir briefly; the tmp sweeper gets it
	}
}

main()
	.catch((error) => {
		console.log(`FAIL  owned-roster threw — ${String(error)}`);
		failed += 1;
	})
	.finally(async () => {
		await cleanup();
		clearTimeout(watchdog);
		console.log(failed === 0 ? "\nPASS owned-roster" : `\nFAIL owned-roster (${failed})`);
		process.exit(failed === 0 ? 0 : 1);
	});
