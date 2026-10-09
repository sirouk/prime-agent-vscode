/**
 * Large-paste host contract against real TypeScript, bundled entirely in memory.
 * No daemon, worker, model call, settings write, generated bundle, or userFocus.
 *
 * GREEN: node test/large-paste-host.test.mjs
 * RED: SOURCE_REF=v1.0.52 LARGE_PASTE_HOST_ONLY='invalid prompt rejection|unexpected prompt rejection' node test/large-paste-host.test.mjs
 * Reports: /tmp/prime-large-paste/host/{current|source-ref}.json
 * Only this test's mkdtemp directories are removed. Reports are never removed.
 */
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
const { vscodeStub } = require("./vscode-stub.cjs");
const git = promisify(execFile);
const sourceRef = process.env.SOURCE_REF;
const only = process.env.LARGE_PASTE_HOST_ONLY ? new RegExp(process.env.LARGE_PASTE_HOST_ONLY) : null;
const artifactDir = process.env.LARGE_PASTE_HOST_ARTIFACTS ?? "/tmp/prime-large-paste/host";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const SESSION = "large-paste-session-A";
const OTHER_SESSION = "large-paste-session-B";
const INLINE = 200_000;
const FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 4;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sources = new Map();
const sourceHashes = {};
const fsHooks = new Map();
const fsCalls = [];
const ownedDirectories = new Set();
const reports = [];
let passed = 0;
let failed = 0;
let requestSequence = 100;
let sourceCommit;
let runtime;
let bundleHash;
const originalLog = process.env.PRIME_AGENT_VSCODE_LOG;
delete process.env.PRIME_AGENT_VSCODE_LOG;
const originalWorkspace = vscodeStub.workspace.workspaceFolders;
const originalPanelFactory = vscodeStub.window.createWebviewPanel;
const originalOpenDocument = vscodeStub.workspace.openTextDocument;
const originalShowDocument = vscodeStub.window.showTextDocument;
const originalWorkspaceStat = vscodeStub.workspace.fs.stat;
const originalFileType = vscodeStub.FileType;
const opened = [];
vscodeStub.FileType = { File: 1, Directory: 2, SymbolicLink: 64 };
vscodeStub.workspace.fs.stat = async (uri) => {
	const stat = await fsp.stat(uri.fsPath);
	return { type: stat.isDirectory() ? vscodeStub.FileType.Directory : vscodeStub.FileType.File, size: stat.size };
};
vscodeStub.workspace.openTextDocument = async (uri) => { opened.push(uri.fsPath); return { uri }; };
vscodeStub.window.showTextDocument = async () => ({});

// Snapshot ALL production source before building. An old release must never
// resolve a newly added module from the checkout or load a current dist bundle.
async function snapshotSources() {
	let names;
	if (sourceRef) {
		sourceCommit = (await git("git", ["rev-parse", `${sourceRef}^{commit}`], { cwd: root })).stdout.trim();
		names = (await git("git", ["ls-tree", "-r", "--name-only", sourceCommit, "--", "src"], { cwd: root })).stdout.trim().split("\n").filter((name) => name.endsWith(".ts"));
	} else {
		names = (await fsp.readdir(path.join(root, "src"))).filter((name) => name.endsWith(".ts")).map((name) => `src/${name}`);
	}
	await Promise.all(names.map(async (name) => {
		const bytes = sourceRef
			? Buffer.from((await git("git", ["show", `${sourceCommit}:${name}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 })).stdout)
			: await fsp.readFile(path.join(root, name));
		sources.set(name, bytes.toString("utf8"));
		sourceHashes[name] = sha256(bytes);
	}));
}

const nativePromises = require("node:fs/promises");
const instrumentedFs = Object.fromEntries(Object.entries(nativePromises).map(([name, value]) => [name, typeof value !== "function" ? value : (...args) => {
	if (name === "mkdir" || name === "writeFile") fsCalls.push({ method: name, args });
	const native = (...nextArgs) => value.apply(nativePromises, nextArgs);
	return fsHooks.has(name) ? fsHooks.get(name)(native, ...args) : native(...args);
}]));
const nativeProcesses = require("node:child_process");
const forbiddenProcess = () => { throw new Error("Host fixture must not start any process or contact a daemon/model"); };
Module._load = function (request, ...args) {
	if (request === "vscode") return vscodeStub;
	if (request === "node:fs/promises") return instrumentedFs;
	if (request === "node:child_process") return { ...nativeProcesses, spawn: forbiddenProcess, exec: forbiddenProcess, execFile: forbiddenProcess, fork: forbiddenProcess };
	return originalLoad.call(this, request, ...args);
};

async function loadHost() {
	await snapshotSources();
	const entry = [
		'export { ChatViewProvider, ChatPanel, parseWebviewMessage } from "./src/chat-view.ts";',
		'export { SessionController } from "./src/session-controller.ts";',
		sources.has("src/prompt-input.ts") ? 'export * as promptInput from "./src/prompt-input.ts";' : "export const promptInput = {};",
	].join("\n");
	const built = await esbuild.build({
		absWorkingDir: root, stdin: { contents: entry, resolveDir: root, sourcefile: "large-paste-host-memory.ts", loader: "ts" },
		bundle: true, write: false, platform: "node", format: "cjs", target: "node18", external: ["vscode"],
		define: { PRIME_AGENT_BUILD_REV: JSON.stringify("large-paste-host-test") }, logLevel: "silent",
		plugins: [{ name: "complete-source-snapshot", setup(api) {
			api.onResolve({ filter: /^\.{1,2}\// }, (args) => {
				const name = path.relative(root, path.resolve(args.resolveDir, args.path)).split(path.sep).join("/").replace(/\.js$/, ".ts");
				if (!sources.has(name)) throw new Error(`Source snapshot has no ${name}; disk fallback is forbidden`);
				return { path: name, namespace: "large-paste-source" };
			});
			api.onLoad({ filter: /.*/, namespace: "large-paste-source" }, ({ path: name }) => ({
				contents: sources.get(name), loader: "ts", resolveDir: path.dirname(path.join(root, name)),
			}));
		} }],
	});
	bundleHash = sha256(built.outputFiles[0].contents);
	const filename = path.join(root, "test", "large-paste-host-in-memory.cjs");
	const bundle = new Module(filename);
	bundle.filename = filename;
	bundle.paths = Module._nodeModulePaths(path.join(root, "test"));
	bundle._compile(built.outputFiles[0].text, filename);
	return bundle.exports;
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
async function bounded(promise, label, milliseconds = 2500) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds); })]);
	} finally { clearTimeout(timer); }
}
const settleDispatch = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
function event() {
	const listeners = new Set();
	return {
		listeners,
		subscribe(callback, thisArg, bag) {
			const listener = callback.bind(thisArg);
			listeners.add(listener);
			const disposable = { dispose: () => listeners.delete(listener) };
			bag?.push(disposable);
			return disposable;
		},
		fire(value) { for (const callback of [...listeners]) callback(value); },
	};
}
function document() {
	const received = event();
	const posts = [];
	const waiters = new Set();
	return {
		received, posts, html: "", options: {}, cspSource: "vscode-webview://large-paste-host-test",
		asWebviewUri: (uri) => `vscode-webview://asset${uri.fsPath}`,
		onDidReceiveMessage: received.subscribe,
		postMessage(message) {
			posts.push(message);
			for (const waiter of [...waiters]) if (waiter.predicate(message)) {
				waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(message);
			}
			return Promise.resolve(true);
		},
		nextPost(predicate) {
			return new Promise((resolve, reject) => {
				const waiter = { predicate, resolve, timer: null };
				waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error("No correlated host reply")); }, 2500);
				waiters.add(waiter);
			});
		},
	};
}
function view(doc) {
	const visibility = event();
	const disposal = event();
	return {
		webview: doc, visible: true, visibility, disposal,
		onDidChangeVisibility: visibility.subscribe, onDidDispose: disposal.subscribe,
		setVisible(value) { this.visible = value; visibility.fire(); },
	};
}
function payload(patch = {}) {
	return { text: "Read this local text file.", images: [], selections: [], streamingBehavior: "steer", sessionId: SESSION, clientRequestId: `host-prompt-${++requestSequence}`, ...patch };
}
function promptCommands(f) { return f.rpc.filter((command) => command.type === "prompt"); }
function correlated(posts, type, id) { return posts.filter((message) => message.type === type && message.clientRequestId === id); }
function assertRejected(posts, id) {
	const messages = correlated(posts, "promptRejected", id);
	assert.equal(messages.length, 1, "one rejection settles the exact originating clientRequestId");
	assert.equal(typeof messages[0].error, "string");
	assert.ok(messages[0].error.length > 0);
}
function assertStagedError(message, id) {
	assert.equal(message.type, "textAttachmentStaged");
	assert.equal(message.requestId, id, "stage errors retain the validated numeric requestId");
	assert.equal(message.attachment, undefined, "failure must not offer a file capability");
	assert.equal(typeof message.error, "string");
	assert.ok(message.error.length > 0);
}
function assertNoPrompt(f) {
	assert.deepEqual(promptCommands(f), [], "no RPC prompt/model body was sent");
	assert.deepEqual(f.daemonPrompts, [], "no sidecar prompt/model body was sent");
}
function dispatch(doc, message, predicate) {
	const response = doc.nextPost(predicate);
	// Gated races first wait for a native await boundary. A historical host may
	// have no such API, so retain the reply failure without an unhandled reject.
	response.catch(() => {});
	doc.received.fire(message);
	return response;
}
function dispatchPrompt(doc, value) {
	return dispatch(doc, { type: "prompt", payload: value }, (message) => (message.type === "promptAccepted" || message.type === "promptRejected") && message.clientRequestId === value.clientRequestId);
}
function dispatchStage(doc, text, patch = {}) {
	const requestId = ++requestSequence;
	return dispatch(doc, { type: "stageTextAttachment", text, name: "pasted-text.txt", requestId, sessionId: SESSION, ...patch }, (message) => message.type === "textAttachmentStaged" && message.requestId === requestId);
}
function dispatchChunk(doc, text, requestId, index, totalChunks, patch = {}) {
	return dispatch(doc, { type: "stageTextAttachmentChunk", text, name: "chunked-text.txt", requestId, sessionId: SESSION, index, totalChunks, ...patch }, (message) => (message.type === "textAttachmentChunkAccepted" || message.type === "textAttachmentStaged") && message.requestId === requestId);
}
async function stage(f, text, patch = {}) {
	assert.equal(typeof f.controller.stageTextAttachment, "function", "host implements text-file staging");
	const requestId = ++requestSequence;
	const before = f.directPosts.length;
	await bounded(f.controller.stageTextAttachment(text, patch.name ?? "pasted-text.txt", requestId, patch.sessionId ?? SESSION, patch.reply ?? f.reply, ...(patch.source === undefined ? [] : [patch.source])), "native text staging");
	const posts = patch.posts ?? f.directPosts;
	const message = posts.slice(patch.posts ? 0 : before).find((entry) => entry.type === "textAttachmentStaged" && entry.requestId === requestId);
	assert.ok(message, "native staging must settle its request");
	return message;
}
function attachment(message) {
	assert.equal(message.error, undefined, "valid staging must not fail");
	assert.ok(message.attachment, "valid staging returns a host-issued file capability");
	assert.match(message.attachment.ref, UUID, "file ref is a host-generated UUID, not a path");
	return message.attachment;
}

async function withFixture(run, mode = "rpc") {
	const temporary = fs.mkdtempSync(path.join(tmpdir(), "prime-large-paste-host-owned-"));
	ownedDirectories.add(temporary);
	const workspace = path.join(temporary, "workspace");
	const storage = path.join(temporary, "private-storage");
	fs.mkdirSync(workspace, { mode: 0o700 });
	fs.mkdirSync(storage, { mode: 0o700 });
	vscodeStub.workspace.workspaceFolders = [{ uri: vscodeStub.Uri.file(workspace), name: "large-paste-host-fixture", index: 0 }];
	const memory = new Map();
	const updates = [];
	const state = { get: (key, fallback) => memory.has(key) ? memory.get(key) : fallback, update: async (key, value) => { updates.push({ key, value }); memory.set(key, value); } };
	const context = { subscriptions: [], extensionUri: vscodeStub.Uri.file(root), globalStorageUri: vscodeStub.Uri.file(storage), globalState: state, workspaceState: state };
	const controller = new runtime.SessionController(context, { append: () => {}, appendLine: () => {} });
	if (controller.processTimer) clearTimeout(controller.processTimer);
	controller.processTimer = null;
	controller.scheduleProcessRefresh = () => {};
	controller.scheduleChildrenRefresh = () => {};
	controller.threadDiffs.harvestSubagents = async () => {};
	controller.ensureStarted = async () => {};
	controller.refreshSnapshot = async () => true;
	controller.listModels = async () => {};
	controller.listCommands = async () => {};
	controller.sendFavorites = () => {};
	controller.state = { sessionId: SESSION, sessionFile: path.join(workspace, `${SESSION}.jsonl`), isStreaming: false };
	controller.reachable = true;
	const f = {
		temporary, workspace, storage, context, controller, memory, updates,
		rpc: [], daemonPrompts: [], directPosts: [], broadcasts: [], providers: [], documents: [], panels: [], notices: [],
		liveSessionId: SESSION, rpcVerdict: { success: true }, sidecarError: null, sidecarLookups: 0,
	};
	f.reply = (message) => f.directPosts.push(message);
	controller.attach({ post: (message) => f.broadcasts.push(message) });
	const showErrorNotice = controller.showErrorNotice.bind(controller);
	controller.showErrorNotice = (message) => { f.notices.push(message); showErrorNotice(message); };
	controller.client = {
		running: true, stop: () => {},
		request: async (command) => {
			f.rpc.push(structuredClone(command));
			if (command.type === "get_state") return { success: true, data: { sessionId: f.liveSessionId, isStreaming: false } };
			if (command.type === "prompt") {
				if (f.rpcVerdict instanceof Error) throw f.rpcVerdict;
				return f.rpcVerdict;
			}
			throw new Error(`Unexpected RPC work: ${command.type}`);
		},
	};
	f.sidecar = {
		connected: true, dispose: () => {},
		prompt: async (activeSessionId, text, behavior, images) => {
			f.daemonPrompts.push({ activeSessionId, text, behavior, images: structuredClone(images) });
			if (f.sidecarError) throw f.sidecarError;
		},
	};
	controller.ensureSidecar = async () => { f.sidecarLookups += 1; return f.sidecar; };
	if (mode === "attached") {
		controller.attached = { activeSessionId: "attached-large-paste-live", sessionId: SESSION, sessionPath: path.join(workspace, `${SESSION}.jsonl`) };
		controller.attachedEpoch = controller.viewEpoch;
		controller.state = { sessionId: "hidden-background-rpc" };
		controller.rentedState = { sessionId: SESSION };
	}
	f.sidebar = () => {
		const doc = document();
		const sidebar = view(doc);
		const provider = new runtime.ChatViewProvider(vscodeStub.Uri.file(root), controller);
		provider.resolveWebviewView(sidebar);
		f.providers.push(provider); f.documents.push(doc);
		return { doc, sidebar, provider };
	};
	f.panel = () => {
		const doc = document();
		const disposal = event();
		const panel = { webview: doc, onDidDispose: disposal.subscribe, reveal: () => { throw new Error("No user focus/reveal allowed in host fixture"); }, dispose: () => disposal.fire() };
		vscodeStub.window.createWebviewPanel = () => panel;
		runtime.ChatPanel.createOrShow(vscodeStub.Uri.file(root), controller);
		f.documents.push(doc); f.panels.push(panel);
		return { doc, panel };
	};
	try {
		return await run(f);
	} finally {
		fsHooks.clear();
		for (const panel of f.panels) panel.dispose();
		for (const provider of f.providers) provider.dispose();
		controller.dispose();
		for (const doc of f.documents) {
			assert.equal(doc.received.listeners.size, 0, "fixture releases all native webview receivers");
			assert.ok(doc.posts.every((message) => message.type !== "userFocus"), "no userFocus message in this test");
		}
		vscodeStub.window.createWebviewPanel = originalPanelFactory;
		// Strict ownership guard. Never remove shared report/evidence directories.
		assert.ok(ownedDirectories.has(temporary) && path.basename(temporary).startsWith("prime-large-paste-host-owned-"));
		fs.rmSync(temporary, { recursive: true, force: true });
		ownedDirectories.delete(temporary);
	}
}

async function check(name, run) {
	if (only && !only.test(name)) return;
	const report = { name, pass: false };
	reports.push(report);
	try {
		report.evidence = await run();
		report.pass = true; passed += 1; console.log(`PASS ${name}`);
	} catch (error) {
		failed += 1; report.error = error.stack ?? String(error); console.error(`FAIL ${name}\n${report.error}`);
	}
}

try {
	runtime = await loadHost();
	const parse = runtime.parseWebviewMessage;
	await check("shared text limits and UTF-8 accounting match the native byte oracle", () => {
		const input = runtime.promptInput;
		assert.equal(input.MAX_PROMPT_TEXT_CHARS, INLINE);
		assert.equal(input.PASTE_FILE_THRESHOLD_CHARS, 32_000);
		assert.equal(input.MAX_TEXT_ATTACHMENT_BYTES, FILE_BYTES);
		assert.equal(input.MAX_TEXT_ATTACHMENTS, MAX_FILES);
		const texts = ["", "ASCII\0file\r\n", "é中😀🧑‍💻", "\ud800", "\udc00", "\ud800\udc00", "\ud800x\udc00", "😀".repeat(FILE_BYTES / 4)];
		for (const text of texts) assert.equal(input.utf8ByteLength(text), Buffer.byteLength(text, "utf8"), "UTF-16/surrogate handling matches the filesystem's UTF-8 encoder");
		assert.equal(input.shouldAttachPastedText("x".repeat(31_999)), false);
		assert.equal(input.shouldAttachPastedText("x".repeat(32_000)), true);
		assert.equal(input.shouldAttachPastedText("short\0text"), true);
		return { inlineChars: INLINE, textBytes: FILE_BYTES, maxFiles: MAX_FILES, oracleCases: texts.length };
	});

	await check("prompt and draft inline envelopes accept exactly 200000 UTF-16 units, not 200001 or NUL", () => {
		for (const text of ["x".repeat(INLINE), "😀".repeat(INLINE / 2)]) {
			assert.equal(parse({ type: "prompt", payload: payload({ text }) }).payload.text, text);
			assert.equal(parse({ type: "draftChanged", text, sessionId: SESSION }).text, text);
		}
		for (const text of ["x".repeat(INLINE + 1), "😀".repeat(INLINE / 2) + "x", "short\0text"]) {
			assert.equal(parse({ type: "prompt", payload: payload({ text }) }), undefined);
			assert.equal(parse({ type: "draftChanged", text, sessionId: SESSION }), undefined);
		}
		return { accepted: [INLINE], refused: [INLINE + 1, "NUL"], unit: "UTF-16" };
	});

	await check("stage parser permits exact 8 MiB Unicode and NUL, strips caller paths, and rejects byte overflow", () => {
		const exact = "😀".repeat(FILE_BYTES / 4);
		const message = { type: "stageTextAttachment", text: exact, name: "unicode.txt", requestId: 42, sessionId: SESSION, path: "/caller-chosen.txt", ref: "caller-ref" };
		const parsed = parse(message);
		assert.ok(parsed, "8 MiB is accepted, not one byte less");
		assert.equal(parsed.text, exact);
		assert.equal(parsed.path, undefined, "caller paths cannot become write authority");
		assert.equal(parsed.ref, undefined, "caller cannot select a capability");
		assert.ok(parse({ ...message, text: "Unicode 中\0😀\r\n" }));
		for (const patch of [{ text: exact + "x" }, { text: "é".repeat(FILE_BYTES / 2) + "é" }, { text: "" }, { text: 7 }, { requestId: -1 }, { requestId: 1.5 }, { requestId: Number.MAX_SAFE_INTEGER + 1 }, { requestId: "42" }, { name: "bad\0name" }, { name: "x".repeat(257) }, { sessionId: "../../thread" }]) {
			assert.equal(parse({ ...message, ...patch }), undefined, `stage refuses malformed ${Object.keys(patch)[0]}`);
		}
		return { utf16Units: exact.length, utf8Bytes: Buffer.byteLength(exact), overflowBytes: Buffer.byteLength(exact + "x") };
	});

	await check("chunk parser bounds each Unicode-safe envelope and rejects malformed order metadata", () => {
		const message = { type: "stageTextAttachmentChunk", text: "😀".repeat(32_000), name: "chunk.txt", requestId: 77, sessionId: SESSION, index: 0, totalChunks: 2, path: "/forged.txt" };
		const parsed = parse(message);
		assert.ok(parsed, "64,000 UTF-16-unit chunk is accepted");
		assert.equal(parsed.text.length, 64_000);
		assert.equal(parsed.path, undefined);
		for (const patch of [{ text: message.text + "x" }, { text: "unpaired\ud800" }, { text: "unpaired\udc00" }, { text: "" }, { index: -1 }, { index: 1.5 }, { index: 2 }, { totalChunks: 0 }, { totalChunks: 257 }, { requestId: "77" }, { name: "bad\0name" }]) {
			assert.equal(parse({ ...message, ...patch }), undefined);
		}
		for (const text of ["\ud800", "\udc00", "x\ud800y", "\udc00\ud800"]) {
			assert.equal(parse({ type: "stageTextAttachment", text, name: "invalid-surrogate.txt", requestId: 78, sessionId: SESSION }), undefined, "host refuses UTF-8 replacement rather than mutating the exact pasted body");
		}
		assert.deepEqual(parse({ type: "cancelTextAttachment", requestId: 77, path: "/forged.txt" }), { type: "cancelTextAttachment", requestId: 77 });
	});

	await check("ordered chunk upload joins exact Unicode and control characters before staging a private file", () => withFixture(async (f) => {
		const owner = f.sidebar().doc;
		const sibling = f.panel().doc;
		const requestId = ++requestSequence;
		const chunks = ["START\r\n" + "😀中é\0\t".repeat(4000), "\0MIDDLE\r\n" + "🧑‍💻🇬🇧".repeat(3000), "END\n\0\r\n"];
		const before = fsCalls.length;
		for (let index = 0; index < chunks.length; index += 1) {
			const response = await dispatchChunk(owner, chunks[index], requestId, index, chunks.length);
			if (index + 1 < chunks.length) {
				assert.deepEqual(response, { type: "textAttachmentChunkAccepted", requestId, index });
				assert.equal(fsCalls.length, before, "intermediate chunks do not write or offer a file");
			} else {
				const file = attachment(response);
				const body = chunks.join("");
				assert.equal(file.byteLength, Buffer.byteLength(body));
				assert.deepEqual(await fsp.readFile(file.path), Buffer.from(body));
				assertNoPrompt(f);
				const value = payload({ textFiles: [file.ref] });
				assert.equal((await dispatchPrompt(owner, value)).type, "promptAccepted");
				assert.ok(promptCommands(f)[0].message.includes(file.path));
				assert.ok(!promptCommands(f)[0].message.includes("MIDDLE"));
			}
		}
		assert.deepEqual(sibling.posts, [], "chunk acknowledgements and final staging remain source scoped");
		return { chunks: chunks.length, exactByteLength: Buffer.byteLength(chunks.join("")), exactSha256: sha256(Buffer.from(chunks.join(""))), bodyInlined: false };
	}));

	await check("out-of-order or parser-invalid chunks return a source error and release upload reservations", () => withFixture(async (f) => {
		const owner = f.sidebar().doc;
		const sibling = f.panel().doc;
		const before = fsCalls.length;
		for (const invalid of ["starts-at-one", "duplicate-zero", "skips-index", "changes-name", "unpaired-surrogate"]) {
			const requestId = ++requestSequence;
			let response;
			if (invalid === "starts-at-one") response = await dispatchChunk(owner, "second", requestId, 1, 2);
			else {
				assert.equal((await dispatchChunk(owner, "first\0中😀", requestId, 0, 3)).type, "textAttachmentChunkAccepted");
				response = await dispatchChunk(owner, invalid === "unpaired-surrogate" ? "bad\ud800" : "second", requestId, invalid === "duplicate-zero" ? 0 : invalid === "skips-index" ? 2 : 1, 3, invalid === "changes-name" ? { name: "different.txt" } : {});
			}
			assertStagedError(response, requestId);
			const retry = await dispatchChunk(owner, "retry exact\0中😀", requestId, 0, 1);
			const file = attachment(retry);
			owner.received.fire({ type: "releaseTextAttachment", ref: file.ref });
			await settleDispatch();
		}
		assert.equal(fsCalls.slice(before).filter((call) => call.method === "writeFile").length, 5, "only successful retries write files");
		assert.deepEqual(sibling.posts, []);
		assertNoPrompt(f);
	}));

	await check("chunk cancellation, document reset, epoch changes, and source forgery cannot transfer pending uploads", () => withFixture(async (f) => {
		const owner = f.sidebar().doc;
		const attacker = f.panel().doc;
		const requestId = ++requestSequence;
		assert.equal((await dispatchChunk(owner, "owner first\0中😀", requestId, 0, 2)).type, "textAttachmentChunkAccepted");
		attacker.received.fire({ type: "cancelTextAttachment", requestId });
		await settleDispatch();
		assertStagedError(await dispatchChunk(attacker, "forged second", requestId, 1, 2), requestId);
		const file = attachment(await dispatchChunk(owner, "owner second\0中😀", requestId, 1, 2));
		assert.deepEqual(await fsp.readFile(file.path), Buffer.from("owner first\0中😀owner second\0中😀"));
		owner.received.fire({ type: "releaseTextAttachment", ref: file.ref });
		await settleDispatch();
		for (const invalidation of ["cancel", "document", "epoch"]) {
			const id = ++requestSequence;
			assert.equal((await dispatchChunk(owner, "pending first", id, 0, 2)).type, "textAttachmentChunkAccepted");
			if (invalidation === "cancel") owner.received.fire({ type: "cancelTextAttachment", requestId: id });
			if (invalidation === "document") owner.received.fire({ type: "ready" });
			if (invalidation === "epoch") f.controller.viewEpoch += 1;
			await settleDispatch();
			assertStagedError(await dispatchChunk(owner, "stale final", id, 1, 2), id);
			const fresh = attachment(await dispatchChunk(owner, "fresh after invalidation", id, 0, 1));
			owner.received.fire({ type: "releaseTextAttachment", ref: fresh.ref });
			await settleDispatch();
		}
		assertNoPrompt(f);
	}));

	await check("text-file refs are copied, bounded to four, and support file-only prompts without path authority", () => {
		const refs = ["opaque-ref-a", "opaque-ref-b", "opaque-ref-c", "opaque-ref-d"];
		const original = payload({ text: "", textFiles: refs });
		const parsed = parse({ type: "prompt", payload: original });
		assert.deepEqual(parsed.payload.textFiles, refs);
		refs[0] = "mutated-after-parse";
		assert.equal(parsed.payload.textFiles[0], "opaque-ref-a", "untrusted arrays are not retained by reference");
		assert.equal(parse({ type: "prompt", payload: payload({ text: "", textFiles: [] }) }), undefined);
		for (const textFiles of [["ref", "ref"], Array.from({ length: 5 }, (_, i) => `ref-${i}`), ["/tmp/forged.txt"], ["../forged.txt"], ["bad\0ref"], [{ ref: "safe-ref", path: "/tmp/forged.txt" }], "safe-ref"]) {
			assert.equal(parse({ type: "prompt", payload: payload({ textFiles }) }), undefined);
		}
		assert.equal(parse({ type: "prompt", payload: payload({ textFiles: ["safe-ref"], sessionId: undefined }) }), undefined);
		for (const type of ["releaseTextAttachment", "openTextAttachment"]) {
			assert.deepEqual(parse({ type, ref: "safe-ref", path: "/forged.txt" }), { type, ref: "safe-ref" });
			assert.equal(parse({ type, ref: "/forged.txt" }), undefined);
		}
	});

	await check("invalid prompt rejection goes only to origin and cannot leave a generic wedge latch", () => withFixture(async (f) => {
		const origin = f.sidebar().doc;
		const sibling = f.panel().doc;
		const invalid = [
			{ text: "x".repeat(INLINE + 1) }, { text: "short\0body" },
			{ images: [{ data: "not base64", mimeType: "image/png" }] },
			{ selections: [{ path: "x.ts", text: "x", languageId: "typescript", startLine: 2, endLine: 1 }] },
			{ textFiles: ["/tmp/forged.txt"] }, { textFiles: ["same-ref", "same-ref"] },
		];
		for (const patch of invalid) {
			const value = payload(patch);
			const response = await dispatchPrompt(origin, value);
			assert.equal(response.type, "promptRejected");
			assertRejected(origin.posts, value.clientRequestId);
			assert.equal(correlated(sibling.posts, "promptRejected", value.clientRequestId).length, 0);
		}
		assertNoPrompt(f);
		assert.deepEqual(f.notices, [], "correlated invalid prompts do not use a generic broadcast error");
		assert.deepEqual(sibling.posts, [], "another pane sees no invalid-send rejection or generic notice");
		assert.equal(f.controller.observationRestoring, false);
		assert.equal(f.controller.streaming, false);
		const valid = payload({ text: "A short follow-up still works." });
		assert.equal((await dispatchPrompt(origin, valid)).type, "promptAccepted", "invalid transport cannot latch the next valid Send");
		assert.equal(promptCommands(f).length, 1);
		assert.deepEqual(sibling.posts, [], "acceptance is also source scoped");
		return { refusedInputs: invalid.length, recoveredSends: 1, sourceScoped: true };
	}));

	await check("invalid prompt correlation ids are not reflected into a source-scoped rejection", () => withFixture(async (f) => {
		const origin = f.sidebar().doc;
		const sibling = f.panel().doc;
		for (const id of ["../../forged", "x\0id", "x".repeat(257), 42, { id: "forged" }, undefined]) {
			const next = origin.nextPost((message) => message.type === "promptRejected");
			origin.received.fire({ type: "prompt", payload: payload({ text: "x".repeat(INLINE + 1), clientRequestId: id }) });
			const response = await next;
			assert.equal(response.clientRequestId, undefined, "only a validated bounded identifier may be reflected");
			assert.deepEqual(Object.keys(response).sort(), ["error", "type"]);
		}
		assert.deepEqual(sibling.posts, []);
		assert.deepEqual(f.notices, []);
		assertNoPrompt(f);
	}));

	await check("invalid staging returns a correlated source-only error without writing or sending", () => withFixture(async (f) => {
		const origin = f.sidebar().doc;
		const sibling = f.panel().doc;
		const before = fsCalls.length;
		const invalid = [{ text: "" }, { text: 99 }, { text: "😀".repeat(FILE_BYTES / 4) + "x" }, { name: "bad\0name" }, { sessionId: "../../forged" }];
		for (const patch of invalid) {
			const requestId = ++requestSequence;
			const response = await dispatch(origin, { type: "stageTextAttachment", text: "valid", name: "pasted.txt", sessionId: SESSION, requestId, ...patch }, (message) => message.type === "textAttachmentStaged" && message.requestId === requestId);
			assertStagedError(response, requestId);
		}
		assert.equal(fsCalls.length, before, "parser-invalid stages never reach disk");
		assert.deepEqual(sibling.posts, []);
		assert.deepEqual(f.notices, []);
		assertNoPrompt(f);
		return { invalidStages: invalid.length, filesystemWrites: 0 };
	}));

	await check("unexpected prompt rejection settles origin and the next send remains usable", () => withFixture(async (f) => {
		const origin = f.sidebar().doc;
		const sibling = f.panel().doc;
		const nativePrompt = f.controller.prompt;
		f.controller.prompt = async () => { throw new Error("injected unexpected prompt failure"); };
		const value = payload({ text: "short unexpected failure" });
		const response = await dispatchPrompt(origin, value);
		assert.equal(response.type, "promptRejected");
		assert.match(response.error, /injected unexpected prompt failure/);
		assertRejected(origin.posts, value.clientRequestId);
		assert.deepEqual(sibling.posts, []);
		assert.deepEqual(f.notices, [], "catch path is not a generic broadcast error");
		assertNoPrompt(f);
		f.controller.prompt = nativePrompt;
		assert.equal((await dispatchPrompt(origin, payload({ text: "recovered" }))).type, "promptAccepted");
		assert.equal(f.controller.observationRestoring, false);
	}));

	await check("host writes exact Unicode and NUL to an exclusive 0600 UUID file in a private 0700 folder", () => withFixture(async (f) => {
		const origin = f.sidebar().doc;
		const text = "SECRET_RAW_PASTE_BEGIN\r\n" + "é 中 😀 🧑‍💻\0literal NUL\r\n".repeat(2000) + "SECRET_RAW_PASTE_END\n";
		const name = "../../caller-path-\"<bad>.txt";
		const before = fsCalls.length;
		const file = attachment(await dispatchStage(origin, text, { name, path: path.join(f.workspace, "must-not-write.txt") }));
		assert.equal(file.name, name, "display name is metadata, not a write path");
		assert.equal(file.byteLength, Buffer.byteLength(text, "utf8"));
		assert.equal(path.dirname(file.path), path.join(f.storage, "pasted-text"));
		assert.match(path.basename(file.path), /^[a-f0-9-]{36}\.txt$/i);
		assert.notEqual(path.basename(file.path, ".txt"), file.ref, "opaque authority is separate from the readable path");
		assert.deepEqual(await fsp.readFile(file.path), Buffer.from(text, "utf8"), "no newline, Unicode, or NUL mutation");
		if (process.platform !== "win32") {
			assert.equal((await fsp.stat(file.path)).mode & 0o777, 0o600);
			assert.equal((await fsp.stat(path.dirname(file.path))).mode & 0o777, 0o700);
		}
		const calls = fsCalls.slice(before);
		const write = calls.find((entry) => entry.method === "writeFile");
		assert.equal(write.args[0], file.path);
		assert.equal(write.args[2].flag, "wx");
		assert.equal(write.args[2].mode, 0o600);
		assert.equal(write.args[2].encoding, "utf8");
		assert.equal(calls.find((entry) => entry.method === "mkdir").args[1].mode, 0o700);
		assert.deepEqual(await fsp.readdir(f.workspace), [], "large pastes never write into the workspace");
		assertNoPrompt(f);
		return { byteLength: file.byteLength, contentSha256: sha256(await fsp.readFile(file.path)), permissions: "0600/0700", exclusiveCreate: true };
	}));

	await check("filesystem storage failures are source scoped, send nothing, and allow exact-text retry", () => withFixture(async (f) => {
		const origin = f.sidebar().doc;
		const sibling = f.panel().doc;
		const text = "retry exact 中😀\0text\r\n".repeat(2000);
		for (const method of ["mkdir", "writeFile"]) {
			fsHooks.set(method, async () => { throw Object.assign(new Error(`injected ${method} storage failure`), { code: "EACCES" }); });
			const response = await dispatchStage(origin, text);
			assertStagedError(response, response.requestId);
			assert.match(response.error, new RegExp(method));
			assertNoPrompt(f);
			assert.deepEqual(sibling.posts, []);
			fsHooks.delete(method);
		}
		const file = attachment(await dispatchStage(origin, text));
		assert.deepEqual(await fsp.readFile(file.path), Buffer.from(text));
		assertNoPrompt(f);
		return { failures: ["mkdir", "writeFile"], retryByteLength: file.byteLength };
	}));

	await check("non-file storage and symlinked attachment folders cannot become host write paths", async () => {
		await withFixture(async (f) => {
			f.context.globalStorageUri = { scheme: "https", fsPath: f.storage };
			const response = await stage(f, "valid staged text");
			assertStagedError(response, response.requestId);
			assertNoPrompt(f);
		});
		if (process.platform !== "win32") await withFixture(async (f) => {
			const target = path.join(f.temporary, "symlink-target");
			fs.mkdirSync(target, { mode: 0o700 });
			fs.symlinkSync(target, path.join(f.storage, "pasted-text"));
			const response = await stage(f, "must not cross a symlink");
			assertStagedError(response, response.requestId);
			assert.deepEqual(await fsp.readdir(target), []);
			assertNoPrompt(f);
		});
	});

	await check("pre-existing attachment folders remain private or fail closed", () => withFixture(async (f) => {
		if (process.platform === "win32") return { skippedModeAssertion: true };
		const directory = path.join(f.storage, "pasted-text");
		fs.mkdirSync(directory, { mode: 0o700 });
		fs.chmodSync(directory, 0o777);
		const response = await stage(f, "private text must not enter a public folder");
		if (response.attachment) assert.equal((await fsp.stat(directory)).mode & 0o777, 0o700, "mkdir mode alone does not fix an existing public directory");
		else assertStagedError(response, response.requestId);
		assertNoPrompt(f);
	}));

	await check("exact 8 MiB Unicode stages to disk, one additional byte is refused with no prompt", () => withFixture(async (f) => {
		const exact = "😀".repeat(FILE_BYTES / 4);
		const file = attachment(await stage(f, exact));
		assert.equal(file.byteLength, FILE_BYTES);
		const bytes = await fsp.readFile(file.path);
		assert.equal(bytes.length, FILE_BYTES);
		assert.equal(sha256(bytes), sha256(Buffer.from(exact)));
		f.controller.releaseTextAttachment(file.ref, f.reply);
		const before = (await fsp.readdir(path.dirname(file.path))).length;
		const rejected = await stage(f, exact + "x");
		assertStagedError(rejected, rejected.requestId);
		assert.equal((await fsp.readdir(path.dirname(file.path))).length, before);
		assertNoPrompt(f);
		return { exactBytes: bytes.length, exactSha256: sha256(bytes), overLimitBytes: Buffer.byteLength(exact + "x") };
	}));

	await check("RPC receives only short file references, never pasted body, and keeps image and selection semantics", () => withFixture(async (f) => {
		const body = "DO_NOT_INLINE_SECRET_BODY 中😀\0\r\n".repeat(3000);
		const first = attachment(await stage(f, body, { name: 'quoted-"<name>.txt' }));
		const second = attachment(await stage(f, "SECOND_BODY_DO_NOT_INLINE\n".repeat(2000)));
		const value = payload({ text: "Compare these two files.", textFiles: [first.ref, second.ref], images: [{ data: "aGVsbG8=", mimeType: "image/png", name: "example.png" }], selections: [{ path: "example.ts", startLine: 1, endLine: 2, text: "const selection = true;", languageId: "typescript" }] });
		await bounded(f.controller.prompt(value, f.reply), "RPC file send");
		const commands = promptCommands(f);
		assert.equal(commands.length, 1);
		const sent = commands[0];
		assert.ok(sent.message.startsWith(value.text));
		for (const file of [first, second]) assert.ok(sent.message.includes(`<attachment file="${file.path}"`), "recognized attachment appendix contains the actual readable path");
		assert.ok(sent.message.includes('name="quoted-&quot;&lt;name&gt;.txt"'), "metadata cannot inject an attachment tag");
		assert.ok(sent.message.includes('<attachment file="example.ts" lines="1-2">\nconst selection = true;'));
		assert.ok(sent.message.length < 4096, "reference message stays short independent of paste size");
		assert.ok(!sent.message.includes("DO_NOT_INLINE_SECRET_BODY") && !sent.message.includes("SECOND_BODY_DO_NOT_INLINE"));
		assert.ok(!sent.message.includes(first.ref) && !sent.message.includes(second.ref), "host authority tokens are not file paths/model context");
		assert.deepEqual(sent.images, [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
		assert.equal(sent.streamingBehavior, "steer");
		assert.equal(correlated(f.directPosts, "promptAccepted", value.clientRequestId).length, 1);
		assert.deepEqual(f.broadcasts, [], "accepted file sends settle only their source, not every pane");
		return { pastedBytes: first.byteLength + second.byteLength, promptCharacters: sent.message.length, promptSha256: sha256(sent.message), bodyInlined: false };
	}));

	await check("attached daemon receives only its file references and never touches hidden RPC", () => withFixture(async (f) => {
		const text = "SIDECAR_BODY_NOT_INLINE 中😀\0\n".repeat(2000);
		const file = attachment(await stage(f, text));
		const value = payload({ text: "Read the attached document.", textFiles: [file.ref] });
		await bounded(f.controller.prompt(value, f.reply), "attached file send");
		assert.deepEqual(f.rpc, [], "attached send cannot query or prompt the hidden RPC session");
		assert.equal(f.daemonPrompts.length, 1);
		const sent = f.daemonPrompts[0];
		assert.equal(sent.activeSessionId, "attached-large-paste-live");
		assert.ok(sent.text.includes(file.path));
		assert.ok(sent.text.startsWith(value.text));
		assert.ok(!sent.text.includes("SIDECAR_BODY_NOT_INLINE"));
		assert.ok(sent.text.length < 2048);
		assert.deepEqual(await fsp.readFile(file.path), Buffer.from(text));
		assert.equal(correlated(f.directPosts, "promptAccepted", value.clientRequestId).length, 1);
		return { target: sent.activeSessionId, pastedBytes: file.byteLength, promptCharacters: sent.text.length, hiddenRpcRequests: 0 };
	}, "attached"));

	for (const mode of ["rpc", "attached"]) await check(`${mode} failed send keeps capability for retry; acceptance consumes it but retains the readable file`, () => withFixture(async (f) => {
		const file = attachment(await stage(f, "RETRY_FILE_CONTENT\0中😀\n".repeat(1000)));
		const failures = mode === "rpc" ? [{ success: false, error: "injected prompt refusal" }, new Error("injected transport failure")] : [new Error("injected sidecar failure")];
		for (const failure of failures) {
			if (mode === "rpc") f.rpcVerdict = failure; else f.sidecarError = failure;
			const value = payload({ textFiles: [file.ref] });
			await bounded(f.controller.prompt(value, f.reply), "failed prompt");
			assertRejected(f.directPosts, value.clientRequestId);
			const before = opened.length;
			await f.controller.openTextAttachment(file.ref, f.reply);
			assert.deepEqual(opened.slice(before), [file.path], "failed send keeps the exact owner capability");
		}
		f.rpcVerdict = { success: true }; f.sidecarError = null;
		const accepted = payload({ textFiles: [file.ref] });
		await bounded(f.controller.prompt(accepted, f.reply), "retry prompt");
		assert.equal(correlated(f.directPosts, "promptAccepted", accepted.clientRequestId).length, 1);
		const beforePrompts = mode === "rpc" ? promptCommands(f).length : f.daemonPrompts.length;
		const duplicate = payload({ textFiles: [file.ref] });
		await bounded(f.controller.prompt(duplicate, f.reply), "consumed capability prompt");
		assertRejected(f.directPosts, duplicate.clientRequestId);
		assert.equal(mode === "rpc" ? promptCommands(f).length : f.daemonPrompts.length, beforePrompts, "consumed capability is not re-sent");
		assert.ok(fs.existsSync(file.path), "the model/transcript can still read a delivered file");
		const beforeOpen = opened.length;
		await f.controller.openTextAttachment(file.ref, f.reply);
		assert.equal(opened.length, beforeOpen, "consumed capability cannot reopen through the draft API");
		return { failures: failures.length, acceptedRetries: 1, duplicateRejected: true, fileRetained: true };
	}, mode));

	await check("file-only prompt acceptance is correlated and scoped to the originating pane", () => withFixture(async (f) => {
		const origin = f.sidebar().doc;
		const sibling = f.panel().doc;
		const file = attachment(await dispatchStage(origin, "FILE_ONLY_BODY_NOT_INLINE\0中😀\n".repeat(2000)));
		const value = payload({ text: "", textFiles: [file.ref] });
		const response = await dispatchPrompt(origin, value);
		assert.equal(response.type, "promptAccepted");
		assert.equal(response.clientRequestId, value.clientRequestId);
		assert.deepEqual(sibling.posts, []);
		assert.ok(promptCommands(f)[0].message.includes(file.path));
		assert.ok(!promptCommands(f)[0].message.includes("FILE_ONLY_BODY_NOT_INLINE"));
	}));

	await check("another pane cannot forge, open, or release an owner file capability even when it knows the ref", () => withFixture(async (f) => {
		const owner = f.sidebar().doc;
		const attacker = f.panel().doc;
		const file = attachment(await dispatchStage(owner, "OWNER_ONLY_BODY_NOT_INLINE\n".repeat(2000)));
		const ownerPostCount = owner.posts.length;
		const beforeOpen = opened.length;
		attacker.received.fire({ type: "openTextAttachment", ref: file.ref });
		attacker.received.fire({ type: "releaseTextAttachment", ref: file.ref });
		await settleDispatch();
		assert.equal(opened.length, beforeOpen, "forged open cannot read another source's private file");
		const forged = payload({ textFiles: [file.ref] });
		assert.equal((await dispatchPrompt(attacker, forged)).type, "promptRejected");
		assertRejected(attacker.posts, forged.clientRequestId);
		assert.equal(owner.posts.length, ownerPostCount, "attacker rejection never reaches the owner");
		assertNoPrompt(f);
		const ownerOpened = deferred();
		const openDocument = vscodeStub.workspace.openTextDocument;
		vscodeStub.workspace.openTextDocument = async (uri) => {
			const document = await openDocument(uri);
			ownerOpened.resolve(uri.fsPath);
			return document;
		};
		try {
			owner.received.fire({ type: "openTextAttachment", ref: file.ref });
			assert.equal(await bounded(ownerOpened.promise, "owner file open"), file.path);
			assert.deepEqual(opened.slice(beforeOpen), [file.path]);
		} finally { vscodeStub.workspace.openTextDocument = openDocument; }
		assert.equal((await dispatchPrompt(owner, payload({ textFiles: [file.ref] }))).type, "promptAccepted", "attacker release did not revoke the owner's cap");
	}));

	await check("raw paths, unknown UUID refs, duplicate refs, and unstamped refs cannot send", () => withFixture(async (f) => {
		const file = attachment(await stage(f, "valid owner body"));
		for (const patch of [{ textFiles: [file.path] }, { textFiles: ["00000000-0000-4000-8000-000000000000"] }, { textFiles: [file.ref, file.ref] }, { textFiles: [file.ref], sessionId: undefined }, { textFiles: [{ ...file }] }]) {
			const value = payload(patch);
			await bounded(f.controller.prompt(value, f.reply), "forged file capability prompt");
			assertRejected(f.directPosts, value.clientRequestId);
			assertNoPrompt(f);
		}
		const valid = payload({ textFiles: [file.ref] });
		await bounded(f.controller.prompt(valid, f.reply), "valid owner prompt after forgeries");
		assert.equal(correlated(f.directPosts, "promptAccepted", valid.clientRequestId).length, 1);
	}));

	await check("owner release revokes the ref without deleting its readable file", () => withFixture(async (f) => {
		const file = attachment(await stage(f, "release me but keep a readable file"));
		f.controller.releaseTextAttachment(file.ref, f.reply);
		const value = payload({ textFiles: [file.ref] });
		await bounded(f.controller.prompt(value, f.reply), "released capability prompt");
		assertRejected(f.directPosts, value.clientRequestId);
		assert.ok(fs.existsSync(file.path));
		assertNoPrompt(f);
	}));

	await check("same document visibility rewiring retains capabilities but ready resets only that source", () => withFixture(async (f) => {
		const { doc: owner, sidebar } = f.sidebar();
		const other = f.panel().doc;
		const retained = attachment(await dispatchStage(owner, "survives a visibility toggle"));
		sidebar.setVisible(false); sidebar.setVisible(true);
		assert.equal((await dispatchPrompt(owner, payload({ textFiles: [retained.ref] }))).type, "promptAccepted", "closure changes are not document identity changes");
		const stale = attachment(await dispatchStage(owner, "old document generation"));
		const unrelated = attachment(await dispatchStage(other, "other source generation"));
		owner.received.fire({ type: "ready" });
		await settleDispatch();
		assert.equal((await dispatchPrompt(owner, payload({ textFiles: [stale.ref] }))).type, "promptRejected");
		assert.equal((await dispatchPrompt(other, payload({ textFiles: [unrelated.ref] }))).type, "promptAccepted", "ready revokes only the initiating document");
		assert.ok(fs.existsSync(stale.path));
	}));

	await check("disposed source revokes existing refs and cannot publish an in-flight stage capability", async () => {
		for (const kind of ["view", "provider", "panel"]) await withFixture(async (f) => {
			const wired = kind === "panel" ? f.panel() : f.sidebar();
			const source = wired.doc;
			const file = attachment(await dispatchStage(source, "closed source owns this file"));
			const entered = deferred(); const release = deferred();
			fsHooks.set("writeFile", async (native, ...args) => { entered.resolve(); await release.promise; return native(...args); });
			const pending = dispatchStage(source, "must not publish after source disposal".repeat(2000));
			try {
				await bounded(entered.promise, "closed-source stage entered");
				if (kind === "view") wired.sidebar.disposal.fire();
				if (kind === "provider") wired.provider.dispose();
				if (kind === "panel") wired.panel.dispose();
			} finally { release.resolve(); }
			const response = await pending;
			assertStagedError(response, response.requestId);
			assert.equal(source.received.listeners.size, 0, "disposed source cannot request more host work");
			const value = payload({ textFiles: [file.ref] });
			await bounded(f.controller.prompt(value, f.reply, source), "closed-source capability prompt");
			assertRejected(f.directPosts, value.clientRequestId);
			assertNoPrompt(f);
			assert.ok(fs.existsSync(file.path), "source disposal does not delete retained files");
		});
		return { disposedSources: ["view", "provider", "panel"], staleCapabilitiesPublished: 0 };
	});

	await check("replacement webview cannot inherit outgoing file refs and stale receivers are released", () => withFixture(async (f) => {
		const { doc: outgoing, sidebar } = f.sidebar();
		const file = attachment(await dispatchStage(outgoing, "old webview owns this ref"));
		const replacement = document();
		f.documents.push(replacement);
		sidebar.setVisible(false); sidebar.webview = replacement; sidebar.setVisible(true);
		assert.equal(outgoing.received.listeners.size, 0);
		assert.equal(replacement.received.listeners.size, 1);
		const oldPostCount = outgoing.posts.length;
		assert.equal((await dispatchPrompt(replacement, payload({ textFiles: [file.ref] }))).type, "promptRejected");
		assert.equal(outgoing.posts.length, oldPostCount);
		assertNoPrompt(f);
		const before = f.rpc.length;
		outgoing.received.fire({ type: "prompt", payload: payload({ textFiles: [file.ref] }) });
		await settleDispatch();
		assert.equal(f.rpc.length, before, "outgoing document cannot dispatch any host work");
		const fresh = attachment(await dispatchStage(replacement, "fresh replacement source"));
		assert.equal((await dispatchPrompt(replacement, payload({ textFiles: [fresh.ref] }))).type, "promptAccepted");
	}));

	await check("canonical session identity rejects foreign file refs even across view epochs", async () => {
		await withFixture(async (f) => {
			const file = attachment(await stage(f, "old session body"));
			f.controller.viewEpoch += 1;
			f.controller.state = { sessionId: OTHER_SESSION }; f.liveSessionId = OTHER_SESSION;
			const value = payload({ sessionId: OTHER_SESSION, textFiles: [file.ref] });
			await bounded(f.controller.prompt(value, f.reply), "foreign-session file prompt");
			assertRejected(f.directPosts, value.clientRequestId);
			assertNoPrompt(f);
			assert.deepEqual(f.rpc, [], "foreign file refs fail before hidden session lookup or startup");
			assert.equal(f.sidecarLookups, 0);
			const before = opened.length;
			await f.controller.openTextAttachment(file.ref, f.reply);
			assert.equal(opened.length, before, "foreign-session ref cannot be opened");
		});
		await withFixture(async (f) => {
			const before = fsCalls.length;
			const response = await stage(f, "stale composed-in session", { sessionId: OTHER_SESSION });
			assertStagedError(response, response.requestId);
			assert.equal(fsCalls.length, before, "stale session staging fails before disk I/O");
			assertNoPrompt(f);
		});
	});

	await check("cancelled navigation and failed New Session retain ready file capabilities for the same canonical session", async () => {
		for (const mode of ["rpc", "attached"]) for (const navigation of ["cancelled", "failed-new-session"]) await withFixture(async (f) => {
			const file = attachment(await stage(f, "same canonical session retry body\0中😀"));
			const epoch = f.controller.viewEpoch;
			if (navigation === "cancelled") {
				const priorAttachment = f.controller.attached;
				const cancelledEpoch = f.controller.beginNavigation();
				f.controller.restoreAttachedView(priorAttachment, cancelledEpoch);
			} else {
				const nativeRequest = f.controller.client.request;
				f.controller.client.request = async (command) => {
					if (command.type === "new_session") return { success: false, error: "injected session creation failure" };
					return nativeRequest(command);
				};
				await bounded(f.controller.newSession(), "failed New Session navigation");
			}
			assert.ok(f.controller.viewEpoch > epoch, "navigation advanced the view epoch");
			assert.equal(f.controller.buildStatus().sessionId, SESSION, "the failed or cancelled action kept the canonical displayed session");
			const value = payload({ textFiles: [file.ref] });
			await bounded(f.controller.prompt(value, f.reply), "same canonical session retry");
			assert.equal(correlated(f.directPosts, "promptAccepted", value.clientRequestId).length, 1, `${mode}/${navigation}: a still-visible ready chip must remain sendable after navigation settles; ${JSON.stringify(f.directPosts.filter((post) => post.clientRequestId === value.clientRequestId))}`);
			const sent = mode === "rpc" ? promptCommands(f)[0].message : f.daemonPrompts[0].text;
			assert.ok(sent.includes(file.path));
			assert.ok(!sent.includes("retry body"));
		}, mode);
		return { transports: ["rpc", "attached"], navigations: ["cancelled", "failed-new-session"], acceptedReadyFiles: 4 };
	});

	await check("observed, restoring, stale attached, and reconnecting views cannot stage or send into hidden RPC", async () => {
		for (const mode of ["observed", "restoring", "stale-attached", "reconnecting"]) await withFixture(async (f) => {
			if (mode === "observed") f.controller.observingId = "read-only-observed-session";
			if (mode === "restoring") f.controller.observationRestoring = true;
			if (mode === "stale-attached") {
				f.controller.attached = { activeSessionId: "stale-live", sessionId: SESSION, sessionPath: path.join(f.workspace, `${SESSION}.jsonl`) };
				f.controller.attachedEpoch = f.controller.viewEpoch - 1;
			}
			if (mode === "reconnecting") {
				f.controller.attachAttempt = { activeSessionId: "pending-live", sessionId: SESSION, sessionPath: path.join(f.workspace, `${SESSION}.jsonl`) };
				f.controller.attachAttemptEpoch = f.controller.viewEpoch;
			}
			const before = fsCalls.length;
			const response = await stage(f, "cannot attach in this mode");
			assertStagedError(response, response.requestId);
			assert.equal(fsCalls.length, before, `${mode} staging fails before disk I/O`);
			const value = payload({ text: "cannot send in this mode", textFiles: ["not-a-cap"] });
			await bounded(f.controller.prompt(value, f.reply), "read-only or reconnecting prompt");
			assertRejected(f.directPosts, value.clientRequestId);
			assertNoPrompt(f);
		});
	});

	await check("file prompt fails closed on live session lookup refusal or transport failure and retains retry capability", async () => {
		for (const failure of [{ success: false, error: "injected live lookup refusal" }, new Error("injected live lookup transport failure")]) await withFixture(async (f) => {
			const file = attachment(await stage(f, "lookup failure must not inline or misroute this body\0中😀"));
			const nativeRequest = f.controller.client.request;
			f.controller.client.request = async (command) => {
				if (command.type !== "get_state") return nativeRequest(command);
				f.rpc.push(structuredClone(command));
				if (failure instanceof Error) throw failure;
				return failure;
			};
			const value = payload({ textFiles: [file.ref] });
			await bounded(f.controller.prompt(value, f.reply), "unverified live identity prompt");
			assertRejected(f.directPosts, value.clientRequestId);
			assert.match(correlated(f.directPosts, "promptRejected", value.clientRequestId)[0].error, /verify.*session/i);
			assertNoPrompt(f);
			assert.deepEqual(f.broadcasts, [], "lookup refusal is source scoped");
			assert.equal(f.controller.observationRestoring, false, "identity failure must not latch the composer");
			f.controller.client.request = nativeRequest;
			const retry = payload({ textFiles: [file.ref] });
			await bounded(f.controller.prompt(retry, f.reply), "verified live identity retry");
			assert.equal(correlated(f.directPosts, "promptAccepted", retry.clientRequestId).length, 1);
			assert.equal(promptCommands(f).length, 1, "only the verified retry is transmitted");
			assert.ok(promptCommands(f)[0].message.includes(file.path));
		});
		return { unverifiedLookups: ["refused", "transport failure"], unverifiedPromptsSent: 0, verifiedRetries: 2 };
	});

	await check("file prompt fails closed on successful lookup without identity while ordinary short text stays compatible", async () => {
		for (const data of [{}, { sessionId: undefined }, null]) await withFixture(async (f) => {
			const file = attachment(await stage(f, "missing identity must not route this body\0中😀"));
			const nativeRequest = f.controller.client.request;
			f.controller.client.request = async (command) => {
				if (command.type !== "get_state") return nativeRequest(command);
				f.rpc.push(structuredClone(command));
				return { success: true, data };
			};
			const value = payload({ textFiles: [file.ref] });
			await bounded(f.controller.prompt(value, f.reply), "successful unidentified lookup prompt");
			assertRejected(f.directPosts, value.clientRequestId);
			assert.match(correlated(f.directPosts, "promptRejected", value.clientRequestId)[0].error, /verify.*session/i);
			assertNoPrompt(f);
			assert.deepEqual(f.broadcasts, []);
			const plain = payload({ text: "ordinary short text", textFiles: undefined });
			await bounded(f.controller.prompt(plain, f.reply), "legacy short-text prompt");
			assert.equal(correlated(f.directPosts, "promptAccepted", plain.clientRequestId).length, 1, "new file authority rules do not block legacy short text");
			assert.equal(promptCommands(f).length, 1);
			// The successful short-text lookup supplied no cached identity. Restore
			// the host's displayed state and make the child prove it on the retry.
			f.controller.state = { sessionId: SESSION };
			f.controller.client.request = nativeRequest;
			const retry = payload({ textFiles: [file.ref] });
			await bounded(f.controller.prompt(retry, f.reply), "identified file retry");
			assert.equal(correlated(f.directPosts, "promptAccepted", retry.clientRequestId).length, 1);
			assert.equal(promptCommands(f).length, 2, "file capability survived refusal and unrelated short-text send");
		});
		return { unidentifiedSuccesses: 3, unverifiedFilePromptsSent: 0, legacyShortTextAccepted: 3, verifiedFileRetries: 3 };
	});

	await check("startup-delayed file prompt rejects after newer navigation without sending to the new RPC view", () => withFixture(async (f) => {
		const file = attachment(await stage(f, "startup race file"));
		const entered = deferred(); const release = deferred();
		f.controller.ensureStarted = async () => { entered.resolve(); await release.promise; };
		const value = payload({ textFiles: [file.ref] });
		const pending = f.controller.prompt(value, f.reply);
		try {
			await bounded(entered.promise, "startup entered");
			f.controller.viewEpoch += 1; f.controller.state = { sessionId: OTHER_SESSION }; f.liveSessionId = OTHER_SESSION;
		} finally { release.resolve(); }
		await bounded(pending, "startup race completion");
		assertRejected(f.directPosts, value.clientRequestId);
		assertNoPrompt(f);
	}));

	await check("live get_state-delayed success or failure rejects after navigation instead of silently wedging", async () => {
		for (const verdict of ["success", "failure"]) await withFixture(async (f) => {
			const file = attachment(await stage(f, "live state race file"));
			const entered = deferred(); const release = deferred();
			const native = f.controller.client.request;
			f.controller.client.request = async (command) => {
				if (command.type === "get_state") { entered.resolve(); return release.promise; }
				return native(command);
			};
			const value = payload({ textFiles: [file.ref] });
			const pending = f.controller.prompt(value, f.reply);
			try {
				await bounded(entered.promise, "live state lookup entered");
				f.controller.viewEpoch += 1; f.controller.state = { sessionId: OTHER_SESSION }; f.liveSessionId = OTHER_SESSION;
			} finally {
				if (verdict === "success") release.resolve({ success: true, data: { sessionId: SESSION } });
				else release.reject(new Error("late get_state failure"));
			}
			await bounded(pending, "live state race completion");
			assertRejected(f.directPosts, value.clientRequestId);
			assertNoPrompt(f);
		});
	});

	await check("attached startup-delayed file prompt cannot route to a newer attachment", () => withFixture(async (f) => {
		const file = attachment(await stage(f, "attached lookup race file"));
		const entered = deferred(); const release = deferred();
		f.controller.ensureSidecar = async () => { entered.resolve(); return release.promise; };
		const value = payload({ textFiles: [file.ref] });
		const pending = f.controller.prompt(value, f.reply);
		try {
			await bounded(entered.promise, "sidecar lookup entered");
			f.controller.viewEpoch += 1;
			f.controller.attached = { activeSessionId: "newer-attached-live", sessionId: OTHER_SESSION, sessionPath: path.join(f.workspace, `${OTHER_SESSION}.jsonl`) };
			f.controller.attachedEpoch = f.controller.viewEpoch;
		} finally { release.resolve(f.sidecar); }
		await bounded(pending, "attached lookup race completion");
		assertRejected(f.directPosts, value.clientRequestId);
		assertNoPrompt(f);
	}, "attached"));

	await check("late attached startup failure still settles the original prompt only", () => withFixture(async (f) => {
		const origin = f.sidebar().doc;
		const sibling = f.panel().doc;
		const file = attachment(await dispatchStage(origin, "attached late failure"));
		const entered = deferred(); const release = deferred();
		f.controller.ensureSidecar = async () => { entered.resolve(); return release.promise; };
		const value = payload({ textFiles: [file.ref] });
		const response = dispatchPrompt(origin, value);
		try {
			await bounded(entered.promise, "failing sidecar entered");
			f.controller.viewEpoch += 1;
			f.controller.attached = { activeSessionId: "newer-failure-live", sessionId: OTHER_SESSION, sessionPath: path.join(f.workspace, `${OTHER_SESSION}.jsonl`) };
			f.controller.attachedEpoch = f.controller.viewEpoch;
		} finally { release.reject(new Error("late original sidecar failure")); }
		assert.equal((await response).type, "promptRejected");
		assertRejected(origin.posts, value.clientRequestId);
		assert.deepEqual(sibling.posts, []);
		assertNoPrompt(f);
	}, "attached"));

	for (const gateMethod of ["mkdir", "writeFile"]) await check(`in-flight ${gateMethod} staging cannot publish capability after epoch or document reset`, async () => {
		for (const invalidation of ["epoch", "document", "read-only", "disposed"]) await withFixture(async (f) => {
			const entered = deferred(); const release = deferred();
			fsHooks.set(gateMethod, async (native, ...args) => { entered.resolve(); await release.promise; return native(...args); });
			const requestId = ++requestSequence;
			const pending = f.controller.stageTextAttachment("STAGING_RACE_BODY\0中😀".repeat(2000), "race.txt", requestId, SESSION, f.reply);
			try {
				await bounded(entered.promise, `${gateMethod} staging entered`);
				if (invalidation === "epoch") f.controller.viewEpoch += 1;
				if (invalidation === "document") f.controller.resetTextAttachments(f.reply);
				if (invalidation === "read-only") f.controller.observingId = "observed-during-staging";
				if (invalidation === "disposed") f.controller.dispose();
			} finally { release.resolve(); }
			await bounded(pending, `${gateMethod} staging completed`);
			const response = f.directPosts.find((message) => message.type === "textAttachmentStaged" && message.requestId === requestId);
			assertStagedError(response, requestId);
			assertNoPrompt(f);
			fsHooks.delete(gateMethod);
		});
		return { gate: gateMethod, invalidations: ["epoch", "document", "read-only", "disposed"], staleCapabilitiesPublished: 0 };
	});

	await check("in-flight stage reply stays with outgoing document and replacement cannot use its result", () => withFixture(async (f) => {
		const { doc: outgoing, sidebar } = f.sidebar();
		const entered = deferred(); const release = deferred();
		fsHooks.set("writeFile", async (native, ...args) => { entered.resolve(); await release.promise; return native(...args); });
		const pending = dispatchStage(outgoing, "old source asynchronous stage".repeat(2000));
		const replacement = document(); f.documents.push(replacement);
		try {
			await bounded(entered.promise, "outgoing stage entered");
			sidebar.setVisible(false); sidebar.webview = replacement; sidebar.setVisible(true);
		} finally { release.resolve(); }
		const response = await pending;
		assert.deepEqual(replacement.posts, [], "stage reply must not jump to the current dynamic sink");
		if (response.attachment) {
			assert.equal((await dispatchPrompt(replacement, payload({ textFiles: [response.attachment.ref] }))).type, "promptRejected");
		} else assertStagedError(response, response.requestId);
		assertNoPrompt(f);
	}));

	await check("concurrent stage reservations enforce four files and release failed reservations for retry", () => withFixture(async (f) => {
		const requests = Array.from({ length: MAX_FILES + 1 }, () => ++requestSequence);
		await bounded(Promise.all(requests.map((id) => f.controller.stageTextAttachment(`concurrent-${id} 中😀`, `file-${id}.txt`, id, SESSION, f.reply))), "concurrent stages");
		const results = f.directPosts.filter((message) => message.type === "textAttachmentStaged" && requests.includes(message.requestId));
		assert.equal(results.length, MAX_FILES + 1);
		const good = results.filter((message) => message.attachment).map(attachment);
		assert.equal(good.length, MAX_FILES);
		const refused = results.find((message) => message.error);
		assertStagedError(refused, refused.requestId);
		assertNoPrompt(f);
		f.controller.releaseTextAttachment(good[0].ref, f.reply);
		assert.ok(attachment(await stage(f, "slot reused after a release")));
		return { concurrentRequests: requests.length, capabilities: good.length, refused: 1, retryWorked: true };
	}));

	await check("combined UTF-8 stage bytes are capped at 8 MiB across concurrent files", () => withFixture(async (f) => {
		const half = "😀".repeat(FILE_BYTES / 8);
		const ids = [++requestSequence, ++requestSequence];
		await bounded(Promise.all(ids.map((id) => f.controller.stageTextAttachment(half, `half-${id}.txt`, id, SESSION, f.reply))), "combined byte cap stages");
		const files = f.directPosts.filter((message) => ids.includes(message.requestId)).map(attachment);
		assert.equal(files.reduce((total, file) => total + file.byteLength, 0), FILE_BYTES);
		const rejected = await stage(f, "x");
		assertStagedError(rejected, rejected.requestId);
		f.controller.releaseTextAttachment(files[0].ref, f.reply);
		assert.ok(attachment(await stage(f, "x")), "a quota refusal does not leak a reservation");
		assertNoPrompt(f);
		return { heldBytes: FILE_BYTES, refusedExtraBytes: 1 };
	}));
} catch (error) {
	failed += 1;
	reports.push({ name: "in-memory host fixture setup", pass: false, error: error.stack ?? String(error) });
	console.error(error.stack ?? String(error));
} finally {
	Module._load = originalLoad;
	vscodeStub.workspace.workspaceFolders = originalWorkspace;
	vscodeStub.window.createWebviewPanel = originalPanelFactory;
	vscodeStub.workspace.openTextDocument = originalOpenDocument;
	vscodeStub.window.showTextDocument = originalShowDocument;
	vscodeStub.workspace.fs.stat = originalWorkspaceStat;
	vscodeStub.FileType = originalFileType;
	if (originalLog === undefined) delete process.env.PRIME_AGENT_VSCODE_LOG; else process.env.PRIME_AGENT_VSCODE_LOG = originalLog;
	await fsp.mkdir(artifactDir, { recursive: true });
	const tag = sourceRef ? sourceRef.replace(/[^a-z0-9_.-]/gi, "_") : "current";
	const reportPath = path.join(artifactDir, `${tag}.json`);
	await fsp.writeFile(reportPath, JSON.stringify({ suite: "large-paste-host", sourceRef: sourceRef ?? null, sourceCommit: sourceCommit ?? null, testSha256: sha256(await fsp.readFile(fileURLToPath(import.meta.url))), bundleSha256: bundleHash ?? null, sourceHashes, passed, failed, reports, safety: { inMemoryBundle: true, sourceSnapshotComplete: true, daemonCalls: 0, modelCalls: 0, generatedBundles: 0, settingsWrites: 0, userFocus: 0, remainingOwnedDirectories: [...ownedDirectories] } }, null, 2) + "\n");
	console.log(`large-paste host: ${passed} passed, ${failed} failed${sourceRef ? ` (source ${sourceRef})` : ""}; ${reportPath}`);
	if (failed) process.exitCode = 1;
}
