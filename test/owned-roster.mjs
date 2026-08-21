/**
 * Live gate for client-owned worker access.
 *
 * The daemon hides a client-owned worker (and every RLM subagent under it) from
 * `list`, and refuses `attach` on it with "Unknown active session", unless the
 * caller names the worker's `ownerClientId`. Our RPC session is client-owned, so
 * without that identity a running agent reads as stopped, the subagent strip is
 * empty, and clicking a subagent fails.
 *
 * This proves every leg against a REAL daemon, with no model calls:
 *   list:   `list all`                       -> our client-owned session is absent
 *           `list all` + includeClientOwned   -> still absent (flag alone is not enough)
 *           + owner identity                  -> present
 *   attach: as a stranger                     -> rejected
 *           as the owner                      -> snapshot returned
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

/** A connection carrying a chosen identity — exactly what the sidecar does. */
async function connectAs(clientId) {
	const client = new DaemonSidecar();
	client.impersonateClientId = clientId;
	await client.connect(8_000);
	return client;
}

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

	// --- the identity is recoverable from what the daemon wrote ---------------
	const resolved = resolveOwnerClientId({ sessionFile, activeSessionId: createdId });
	check("resolveOwnerClientId recovers the owner id from the live descriptor", resolved === ownerClientId, `got ${resolved ?? "undefined"}`);
	if (sessionFile) {
		check(
			"the owner id resolves from the session file alone (the production key)",
			resolveOwnerClientId({ sessionFile }) === ownerClientId,
		);
	}

	// --- listing: a second client is what the extension's sidecar is ----------
	const stranger = await connectAs(null);
	const owned = await connectAs(ownerClientId);
	try {
		check("a plain `list all` cannot see the client-owned session", !has(await stranger.list(true), createdId));
		check(
			"`includeClientOwned` alone is still not enough",
			!has(await stranger.list(true, { includeClientOwned: true }), createdId),
		);

		const ownedRows = await owned.list(true, { includeClientOwned: true });
		check("the owner identity sees the client-owned session", has(ownedRows, createdId));
		check("the owned roster stays a superset of the plain one", ownedRows.length >= (await stranger.list(true)).length);

		// --- attaching: this is what "view ›" on a subagent does ---------------
		let strangerAttachError = "";
		try {
			await stranger.attach(createdId);
			strangerAttachError = "";
		} catch (error) {
			strangerAttachError = error?.message ?? String(error);
		}
		check(
			"attach without the owner identity is refused",
			strangerAttachError.includes("Unknown active session"),
			strangerAttachError || "attach unexpectedly succeeded",
		);

		const attached = await owned.attach(createdId);
		check("attach with the owner identity returns a snapshot", !!attached?.snapshot);
		await owned.request({ type: "detach", activeSessionId: createdId }, 10_000).catch(() => {});
	} finally {
		stranger.dispose();
		owned.dispose();
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
