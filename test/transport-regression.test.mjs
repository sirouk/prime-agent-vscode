/**
 * Headless regression coverage for the two JSONL transports.
 *
 * This deliberately uses local fixture peers instead of a real prime-agent
 * daemon so it can force packet splits, delayed exits, malformed records, and
 * unbounded frames deterministically.  It builds the source modules directly
 * to make stale dist artifacts unable to hide a transport regression.
 */
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// A deliberately tiny cap. The guard exists to bound a peer that never sends a
// newline; proving it does not require pushing the real 64 MiB through a pipe,
// and the production default is asserted separately below.
const TEST_FRAME_CAP = 64 * 1024;
const require = createRequire(import.meta.url);
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-transport-"));

let failed = 0;
let total = 0;
function check(name, condition, detail = "") {
	total += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectQuickRejection(promise, label, timeoutMs = 2_000) {
	const started = Date.now();
	try {
		await Promise.race([
			promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("test deadline exceeded")), timeoutMs)),
		]);
		check(label, false, "resolved unexpectedly");
		return null;
	} catch (error) {
		const elapsed = Date.now() - started;
		const message = error instanceof Error ? error.message : String(error);
		check(label, message !== "test deadline exceeded" && elapsed < timeoutMs, `${elapsed}ms: ${message}`);
		return error;
	}
}

function writeFakeRpcPeer(file) {
	fs.writeFileSync(
		file,
		String.raw`#!/usr/bin/env node
const mode = process.env.PA_TRANSPORT_MODE || "normal";
let buffer = "";
let sentMalformed = false;

function send(payload) {
  const bytes = Buffer.from(JSON.stringify(payload) + "\n", "utf8");
  const euro = bytes.indexOf(Buffer.from("€", "utf8"));
  if (euro >= 0) {
    process.stdout.write(bytes.subarray(0, euro + 1));
    setTimeout(() => process.stdout.write(bytes.subarray(euro + 1)), 0);
    return;
  }
  process.stdout.write(bytes);
}

process.on("SIGTERM", () => setTimeout(() => process.exit(0), 80));

if (mode === "oversized") {
  process.stdout.write("x".repeat(Number(process.env.PA_TEST_FRAME_CAP ?? 65536) + 1024));
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      const command = JSON.parse(line);
      if (mode !== "stdin_error") {
        if (mode === "malformed" && !sentMalformed) {
          sentMalformed = true;
          process.stdout.write("null\n");
        }
        if (mode === "bad_response_shape" && !sentMalformed) {
          sentMalformed = true;
          process.stdout.write(JSON.stringify({ type: "response", success: "yes" }) + "\n");
        }
        send({ type: "response", id: command.id, command: command.type, success: true, data: { text: "€" } });
      }
    }
    newline = buffer.indexOf("\n");
  }
});
`,
		{ encoding: "utf8", mode: 0o755 },
	);
}

function createFixtureDaemon(socketPath) {
	const sockets = new Set();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		socket.setEncoding("utf8");

		const send = (payload, splitUtf8 = false) => {
			const bytes = Buffer.from(JSON.stringify(payload) + "\n", "utf8");
			const euro = splitUtf8 ? bytes.indexOf(Buffer.from("€", "utf8")) : -1;
			if (euro >= 0) {
				socket.write(bytes.subarray(0, euro + 1));
				setTimeout(() => {
					if (!socket.destroyed) socket.write(bytes.subarray(euro + 1));
				}, 0);
				return;
			}
			socket.write(bytes);
		};

		send({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 } });
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.trim()) {
					const request = JSON.parse(line);
					const command = request.command ?? {};
					if (command.type === "oversize") {
						socket.write("x".repeat(TEST_FRAME_CAP + 1024));
					} else {
						if (command.type === "malformed_then_echo") socket.write("null\n");
						if (command.type === "bad_response_shape") socket.write(JSON.stringify({ type: "response", id: request.id, success: "yes" }) + "\n");
						send({ type: "response", id: request.id, success: true, data: { text: "€" } }, true);
					}
				}
				newline = buffer.indexOf("\n");
			}
		});
	});
	return {
		server,
		sockets,
		listen: () => new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		}),
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

let rpcClients = [];
let daemon = null;
let sidecar = null;
try {
	const rpcBundle = path.join(workdir, "rpc-client.cjs");
	const daemonBundle = path.join(workdir, "daemon-sidecar.cjs");
	esbuild.buildSync({ entryPoints: ["src/rpc-client.ts"], outfile: rpcBundle, bundle: true, format: "cjs", platform: "node", target: "node20" });
	esbuild.buildSync({ entryPoints: ["src/daemon-sidecar.ts"], outfile: daemonBundle, bundle: true, format: "cjs", platform: "node", target: "node20" });
	const { RpcClient } = require(rpcBundle);
	const { DaemonSidecar, MAX_JSONL_FRAME_BYTES } = require(daemonBundle);
	check("transport modules bundle from source", typeof RpcClient === "function" && typeof DaemonSidecar === "function");

	if (process.platform === "win32") {
		check("local unix-socket and shebang fixtures skipped on Windows", true);
	} else {
		const peer = path.join(workdir, "fake-rpc.mjs");
		writeFakeRpcPeer(peer);

		const rpc = new RpcClient({ command: peer, env: { PA_TRANSPORT_MODE: "normal" } });
		rpcClients.push(rpc);
		rpc.start();
		const firstReply = await rpc.request({ type: "ping" }, 2_000);
		check("RPC starts and decodes a UTF-8 character split between stdout chunks", firstReply.success && firstReply.data?.text === "€", JSON.stringify(firstReply));

		let staleExitEvents = 0;
		rpc.on("exit", () => {
			staleExitEvents += 1;
		});
		rpc.stop();
		rpc.start();
		const replacementReply = await rpc.request({ type: "replacement_ping" }, 2_000);
		await delay(160);
		check(
			"late exit from a stopped RPC child cannot take its replacement offline",
			rpc.running && replacementReply.success && staleExitEvents === 0,
			`running=${rpc.running} exits=${staleExitEvents}`,
		);

		// Keep the request pending until the synthetic broken-pipe notification.
		// A normal echo peer can answer before that notification on a fast CI host,
		// turning a transport-lifecycle assertion into a scheduler race.
		const stdinErrorRpc = new RpcClient({ command: peer, env: { PA_TRANSPORT_MODE: "stdin_error" } });
		rpcClients.push(stdinErrorRpc);
		stdinErrorRpc.start();
		const stdinErrorPromise = stdinErrorRpc.request({ type: "stdin_break" }, 10_000);
		stdinErrorRpc.process?.stdin?.emit("error", new Error("fixture EPIPE"));
		const stdinError = await expectQuickRejection(stdinErrorPromise, "stdin failure rejects pending RPC work promptly");
		check(
			"stdin failure tears down the unusable RPC transport",
			/fixture EPIPE/.test(String(stdinError?.message ?? stdinError)) && !stdinErrorRpc.running,
			String(stdinError?.message ?? stdinError),
		);

		const malformedRpc = new RpcClient({ command: peer, env: { PA_TRANSPORT_MODE: "malformed" } });
		rpcClients.push(malformedRpc);
		malformedRpc.start();
		const rpcErrors = [];
		malformedRpc.on("protocolError", (error) => rpcErrors.push(String(error)));
		const malformedRpcError = await expectQuickRejection(
			malformedRpc.request({ type: "ping_after_bad_record" }, 10_000),
			"malformed RPC record rejects pending work promptly",
		);
		check(
			"malformed RPC record reports a framing error and tears down the transport",
			rpcErrors.length === 1 && /malformed JSONL/.test(String(malformedRpcError?.message ?? malformedRpcError)) && !malformedRpc.running,
			`errors=${rpcErrors.length} running=${malformedRpc.running}`,
		);

		const badShapeRpc = new RpcClient({ command: peer, env: { PA_TRANSPORT_MODE: "bad_response_shape" } });
		rpcClients.push(badShapeRpc);
		badShapeRpc.start();
		const badShapeRpcError = await expectQuickRejection(
			badShapeRpc.request({ type: "ping_after_bad_response" }, 10_000),
			"invalid RPC response envelope rejects pending work promptly",
		);
		check(
			"invalid RPC response envelope tears down the transport",
			/invalid response envelope/.test(String(badShapeRpcError?.message ?? badShapeRpcError)) && !badShapeRpc.running,
			String(badShapeRpcError?.message ?? badShapeRpcError),
		);

		const oversizedRpc = new RpcClient({ command: peer, env: { PA_TRANSPORT_MODE: "oversized", PA_TEST_FRAME_CAP: String(TEST_FRAME_CAP) }, maxFrameBytes: TEST_FRAME_CAP });
		rpcClients.push(oversizedRpc);
		oversizedRpc.start();
		const frameError = await expectQuickRejection(oversizedRpc.request({ type: "will_not_reply" }, 10_000), "oversized unterminated RPC frame rejects pending work promptly");
		check("RPC frame cap reports the framing violation", /frame exceeded \d+ bytes/.test(String(frameError?.message ?? frameError)));

		// The production default must clear a real transcript, not just a toy one.
		// `get_messages` for a 6,479-message session is a single 4.6 MiB frame; the
		// old 4 MiB cap tore the connection down mid-resume and killed the agent,
		// which is what made large sessions permanently unopenable.
		const OBSERVED_LARGE_TRANSCRIPT_BYTES = 4_827_774;
		check(
			"the shipped frame cap clears a real large transcript with headroom",
			MAX_JSONL_FRAME_BYTES >= OBSERVED_LARGE_TRANSCRIPT_BYTES * 4,
			`cap=${MAX_JSONL_FRAME_BYTES} observed=${OBSERVED_LARGE_TRANSCRIPT_BYTES}`,
		);
		await delay(30);
		check("RPC frame violation tears down the unusable transport", !oversizedRpc.running);

		const socketPath = path.join(workdir, "daemon.sock");
		daemon = createFixtureDaemon(socketPath);
		await daemon.listen();
		sidecar = new DaemonSidecar();
		sidecar.maxFrameBytes = TEST_FRAME_CAP;
		sidecar.socketPath = () => socketPath;
		await sidecar.connect(2_000);
		const daemonReply = await sidecar.request({ type: "echo" }, 2_000);
		check("daemon sidecar decodes UTF-8 split between socket chunks", daemonReply?.text === "€", JSON.stringify(daemonReply));
		const malformedDaemonError = await expectQuickRejection(
			sidecar.request({ type: "malformed_then_echo" }, 10_000),
			"malformed daemon record rejects pending work promptly",
		);
		check(
			"malformed daemon record tears down the unusable socket",
			/daemon socket closed/.test(String(malformedDaemonError?.message ?? malformedDaemonError)) && !sidecar.connected,
			String(malformedDaemonError?.message ?? malformedDaemonError),
		);
		await sidecar.connect(2_000);
		const badShapeDaemonError = await expectQuickRejection(
			sidecar.request({ type: "bad_response_shape" }, 10_000),
			"invalid daemon response envelope rejects pending work promptly",
		);
		check(
			"invalid daemon response envelope tears down the unusable socket",
			/daemon socket closed/.test(String(badShapeDaemonError?.message ?? badShapeDaemonError)) && !sidecar.connected,
			String(badShapeDaemonError?.message ?? badShapeDaemonError),
		);

		const oldSocket = sidecar.socket;
		await sidecar.connect(2_000);
		oldSocket?.emit("close");
		await delay(25);
		const reconnectReply = await sidecar.request({ type: "after_reconnect" }, 2_000);
		check(
			"late close from a replaced daemon socket cannot disconnect the new socket",
			sidecar.connected && reconnectReply?.text === "€",
			`connected=${sidecar.connected}`,
		);

		const daemonFrameError = await expectQuickRejection(sidecar.request({ type: "oversize" }, 10_000), "oversized daemon frame rejects pending work promptly");
		check("daemon frame cap reports socket closure", /daemon socket closed/.test(String(daemonFrameError?.message ?? daemonFrameError)));
		check("daemon frame violation tears down the unusable socket", !sidecar.connected);
	}
} catch (error) {
	check("transport regression harness completes", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
	for (const client of rpcClients) client.stop();
	sidecar?.dispose();
	if (daemon) await daemon.close();
	fs.rmSync(workdir, { recursive: true, force: true });
}

console.log(failed === 0 ? `\nPASS transport-regression (${total} checks)` : `\n${failed}/${total} checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
