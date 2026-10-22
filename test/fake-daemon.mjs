/**
 * A scriptable stand-in for the Prime Agent daemon, speaking just enough of the
 * wire protocol (prime-agent.daemon v7: `daemon_hello`, command envelopes,
 * `response` frames, pushed `session_event` frames) to test the extension's
 * clients without an agent, a model, or the network.
 *
 * It records every command envelope it receives (with the `clientId` the
 * envelope claimed), answers each through a handler table, and lets a test push
 * frames or drop connections on demand.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export async function startFakeDaemon({ handlers = {}, hello = {}, socketPath: requested } = {}) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pa-fake-daemon-")));
	if (requested) fs.mkdirSync(path.dirname(requested), { recursive: true });
	const socketPath = requested ?? path.join(dir, "d.sock");
	const received = [];
	const connections = new Set();
	let nextClient = 1;

	const server = net.createServer((socket) => {
		const clientId = `fake-client-${nextClient++}`;
		const conn = { socket, clientId, claimed: undefined };
		connections.add(conn);
		socket.setEncoding("utf8");
		socket.on("close", () => connections.delete(conn));
		socket.on("error", () => {});
		const send = (frame) => {
			if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
		};
		conn.send = send;
		send({
			type: "daemon_hello",
			protocol: { name: "prime-agent.daemon", version: 7 },
			schemaRevision: 30,
			appVersion: "0.0.0-fake",
			clientId,
			serverCapabilities: ["attach_snapshot", "client_owned_sessions"],
			...hello,
		});
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			let index;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (!line.trim()) continue;
				const envelope = JSON.parse(line);
				const command = envelope.command ?? {};
				conn.claimed = envelope.clientId ?? conn.claimed;
				received.push({ id: envelope.id, clientId: envelope.clientId, command, connection: conn.clientId });
				const handler = handlers[command.type];
				Promise.resolve().then(() => (handler ? handler(command, { conn, envelope, daemon }) : undefined)).then(
					(data) => send({ type: "response", id: envelope.id, command: command.type, success: true, ...(data === undefined ? {} : { data }) }),
					(error) =>
						send({
							type: "response",
							id: envelope.id,
							command: command.type,
							success: false,
							error: error.message,
							...(error.errorInfo ? { errorInfo: error.errorInfo } : {}),
						}),
				);
			}
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});

	const daemon = {
		socketPath,
		received,
		/** Commands of one type, in arrival order. */
		commands: (type) => received.filter((entry) => entry.command.type === type),
		/** Push a frame to every connection (or one, by fake client id). */
		push(frame, only) {
			for (const conn of connections) if (!only || conn.clientId === only) conn.send(frame);
		},
		/** Drop every connection without a goodbye, as a crashed or restarted daemon does. */
		dropAll() {
			for (const conn of [...connections]) conn.socket.destroy();
		},
		connectionCount: () => connections.size,
		async stop() {
			for (const conn of [...connections]) conn.socket.destroy();
			await new Promise((resolve) => server.close(resolve));
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
	return daemon;
}

/** An error whose `errorInfo` the fake daemon forwards, like a real refusal. */
export function refusal(message, errorInfo) {
	const error = new Error(message);
	error.errorInfo = errorInfo;
	return error;
}
