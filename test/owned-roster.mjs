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
const { DaemonSidecar, resolveOwnerClientId, resolveWorkerDescriptor, promoteClientOwnedSession } = require("../dist/daemon-sidecar.cjs");

import { startPrivateDaemon } from "./private-daemon.mjs";
import { realTempDir } from "./isolated-agent.mjs";

const REQUIRE_DAEMON = process.env.PA_REQUIRE_DAEMON === "1" || process.argv.includes("--require-daemon");
let privateDaemon = null;
try {
	privateDaemon = await startPrivateDaemon();
} catch (error) {
	console.log(`${REQUIRE_DAEMON ? "FAIL" : "SKIP"}  owned-roster — could not start a private daemon: ${error.message}`);
	process.exit(REQUIRE_DAEMON ? 1 : 0);
}
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

const workRoot = realTempDir("prime-agent-owned-roster-");
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
		// The two daemon generations disagree on who may see a client-owned session.
		// TypeScript hides it (and its whole subagent tree) from everyone but the
		// owner; the Rust daemon lists every resident and ignores `includeClientOwned`.
		// Both are supported; each is asserted for what it promises, and the
		// invariants that matter on either — the owner always sees it, promotion
		// clears the owner, a promoted session is visible to all — are asserted on both.
		const strangerSees = has(await stranger.list(true), createdId);
		console.log(`  daemon visibility model: ${strangerSees ? "shared (Rust)" : "owner-only (TypeScript)"}`);

		const ownedRows = await owned.list(true, { includeClientOwned: true });
		check("the owner identity sees the client-owned session", has(ownedRows, createdId));
		check("the owned roster stays a superset of the plain one", ownedRows.length >= (await stranger.list(true)).length);

		let strangerAttachError = "";
		try {
			await stranger.attach(createdId);
		} catch (error) {
			strangerAttachError = error?.message ?? String(error);
		}
		if (strangerSees) {
			check("[shared] a stranger can attach without the owner identity", strangerAttachError === "", strangerAttachError);
			await stranger.request({ type: "detach", activeSessionId: createdId }, 10_000).catch(() => {});
		} else {
			check("[owner-only] `includeClientOwned` alone is still not enough", !has(await stranger.list(true, { includeClientOwned: true }), createdId));
			check("[owner-only] attach without the owner identity is refused", strangerAttachError.includes("Unknown active session"), strangerAttachError || "attach unexpectedly succeeded");
		}

		const attached = await owned.attach(createdId);
		check("attach with the owner identity returns a snapshot", !!attached?.snapshot);
		await owned.request({ type: "detach", activeSessionId: createdId }, 10_000).catch(() => {});

		// --- the owner is recorded where the extension reads it --------------------
		check("the worker descriptor names this client as owner", resolveWorkerDescriptor({ activeSessionId: createdId })?.ownerClientId === ownerClientId);

		// --- sharing: another window clicking this session in its history -------
		// `create` for the file is how the extension resumes a saved session. The
		// owner-only daemon answers an owned file with "already active" (and the
		// extension promotes it, even though the owner's own connections already
		// spent `side-<n>` ids under this identity — the journal replays an old answer
		// for a repeated id and would report success without promoting). The shared
		// daemon simply reuses the worker, so the extension promotes before following.
		let refusal;
		let reusedBeforePromotion;
		try {
			reusedBeforePromotion = await stranger.create({ sessionPath: sessionFile, cwd: workRoot });
		} catch (error) {
			refusal = error;
		}
		if (strangerSees) {
			check("[shared] create for an owned session's file reuses its worker", reusedBeforePromotion && rowId(reusedBeforePromotion) === createdId, refusal?.message ?? rowId(reusedBeforePromotion ?? {}));
		} else {
			check(
				"[owner-only] create for an owned session's file is refused with the structured code",
				refusal?.code === "session_already_active" && refusal?.activeSessionId === createdId,
				refusal ? `${refusal.code} ${refusal.activeSessionId}` : "create unexpectedly succeeded",
			);
		}
		await promoteClientOwnedSession(ownerClientId, createdId);
		check("promotion clears the owner in the descriptor, so the session outlives its window", resolveWorkerDescriptor({ activeSessionId: createdId })?.ownerClientId === undefined);
		check("after promotion no owner id can be resolved to impersonate", resolveOwnerClientId({ sessionFile, activeSessionId: createdId }) === undefined);
		check("after promotion a stranger's list sees the session", has(await stranger.list(true), createdId));
		check("after promotion a stranger can attach", !!(await stranger.attach(createdId))?.snapshot);
		const reused = await stranger.create({ sessionPath: sessionFile, cwd: workRoot });
		check("after promotion create reuses the same worker", rowId(reused) === createdId, rowId(reused));
		// Detaching the last viewer of an empty draft evicts it, so only now.
		await stranger.request({ type: "detach", activeSessionId: createdId }, 10_000).catch(() => {});
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
	await privateDaemon?.stop();
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
