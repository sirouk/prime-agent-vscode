/**
 * Retained webview documents must match the host build, but a visibility toggle
 * must not mint a new nonce or reload a current document. Compile two real host
 * variants in memory; no dist rebuild or shared temporary bundle is required.
 */
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;
const { vscodeStub } = require("./vscode-stub.cjs");
const root = fileURLToPath(new URL("..", import.meta.url));
const PRIOR_A = "PRIOR_A";
const CURRENT_B = "current_B";
let passed = 0;
let failed = 0;

async function loadProvider(revision) {
	const result = await esbuild.build({
		entryPoints: [join(root, "src/chat-view.ts")],
		bundle: true,
		format: "cjs",
		platform: "node",
		target: "node18",
		external: ["vscode"],
		define: { PRIME_AGENT_BUILD_REV: JSON.stringify(revision) },
		write: false,
		logLevel: "silent",
	});
	const filename = join(root, "test", `webview-revision-${revision}.cjs`);
	const bundle = new Module(filename);
	bundle.filename = filename;
	bundle.paths = Module._nodeModulePaths(join(root, "test"));
	bundle._compile(result.outputFiles[0].text, filename);
	return bundle.exports.ChatViewProvider;
}

function event() {
	const listeners = new Set();
	const registrations = [];
	return {
		listeners,
		registrations,
		subscribe(callback, thisArg, bag) {
			const record = { callback: callback.bind(thisArg), disposeCalls: 0 };
			const disposable = {
				dispose() {
					record.disposeCalls += 1;
					listeners.delete(record);
				},
			};
			listeners.add(record);
			registrations.push(record);
			bag?.push(disposable);
			return disposable;
		},
		fire(value) {
			for (const record of [...listeners]) record.callback(value);
		},
	};
}

function webview(initialHtml = "") {
	let html = initialHtml;
	const received = event();
	return {
		received,
		writes: [],
		posts: [],
		options: {},
		cspSource: "vscode-webview://revision-test",
		asWebviewUri: (uri) => `vscode-webview://asset${uri.fsPath}`,
		get html() { return html; },
		set html(value) {
			this.writes.push(value);
			html = value;
		},
		postMessage(message) {
			this.posts.push(message);
			return Promise.resolve(true);
		},
		onDidReceiveMessage: received.subscribe,
	};
}

function view(webviewObject) {
	const visibility = event();
	const disposal = event();
	return {
		webview: webviewObject,
		visible: true,
		visibility,
		disposal,
		onDidChangeVisibility: visibility.subscribe,
		onDidDispose: disposal.subscribe,
		setVisible(visible) {
			this.visible = visible;
			visibility.fire();
		},
	};
}

function controllerSpy() {
	const calls = [];
	const attachments = [];
	const active = new Set();
	const controller = {
		calls,
		attachments,
		active,
		attach(sink) {
			calls.push({ method: "attach", args: [sink] });
			const attachment = { sink, disposeCalls: 0 };
			attachments.push(attachment);
			active.add(attachment);
			return {
				dispose() {
					attachment.disposeCalls += 1;
					active.delete(attachment);
				},
			};
		},
		broadcast(message) {
			for (const attachment of active) attachment.sink.post(message);
		},
		async refreshSnapshot() {
			calls.push({ method: "refreshSnapshot", args: [] });
			controller.broadcast({ type: "state", state: { sessionId: "revision-test" } });
		},
	};
	// Do not hide unexpected work behind a generic no-op controller. Record all
	// start, navigation and error APIs that resolving/reloading could touch.
	for (const method of [
		"ensureStarted", "listModels", "listCommands", "sendFavorites", "reload",
		"restart", "newSession", "switchSession", "browseChild", "backToParent",
		"stopObserving", "showErrorNotice", "debugPostFailure",
	]) {
		controller[method] = (...args) => {
			calls.push({ method, args });
			return Promise.resolve();
		};
	}
	return controller;
}

function fixture(Provider, initialHtml = "") {
	const controller = controllerSpy();
	const document = webview(initialHtml);
	const sidebar = view(document);
	return {
		controller,
		document,
		sidebar,
		documents: [document],
		views: [sidebar],
		provider: new Provider(vscodeStub.Uri.file(root), controller),
	};
}

function assertNoNavigation(controller) {
	assert.deepEqual(
		controller.calls.filter(({ method }) => method !== "attach" && method !== "refreshSnapshot"),
		[],
		"resolving/visibility changes must not start, reload, navigate or report errors",
	);
	assert.equal(controller.attachments.length, 1, "one controller sink survives all rewiring");
	assert.equal(controller.attachments[0].disposeCalls, 0, "rewiring does not detach the sink");
}

function nonce(html) {
	const script = html.match(/<script\b[^>]*\bnonce="([^"]+)"/);
	assert.ok(script, "the actual rendered script has a CSP nonce");
	assert.ok(script[1].length >= 24, "the nonce is nonempty and not a placeholder");
	assert.ok(html.includes(`script-src 'nonce-${script[1]}'`), "CSP and script use the same nonce");
	return script[1];
}

function assertBuild(html, revision) {
	const htmlTag = html.match(/<html\b[^>]*>/)?.[0];
	assert.ok(htmlTag?.includes(`data-pa-build="${revision}"`), "root HTML carries the exact host build revision");
	assert.deepEqual(
		[...html.matchAll(/(?:href|src)="[^"]+\?v=([^"&]+)"/g)].map((match) => match[1]),
		[revision, revision],
		"both stylesheet and script assets use the same build revision",
	);
	nonce(html);
}

function toggle(sidebar, count = 3) {
	for (let i = 0; i < count; i += 1) {
		sidebar.setVisible(false);
		sidebar.setVisible(true);
	}
}

async function assertReceiver(f, document = f.document) {
	const before = f.controller.calls.filter(({ method }) => method === "refreshSnapshot").length;
	const posts = document.posts.length;
	document.received.fire({ type: "requestState" });
	await Promise.resolve();
	assert.equal(f.controller.calls.filter(({ method }) => method === "refreshSnapshot").length, before + 1,
		"one active receiver handles the request exactly once");
	assert.equal(document.posts.length, posts + 1, "the attached controller sink reaches the current webview");
	assert.equal(document.posts.at(-1).type, "state");
}

async function withFixture(Provider, initialHtml, run) {
	const f = fixture(Provider, initialHtml);
	try {
		await run(f);
		assertNoNavigation(f.controller);
	} finally {
		f.provider.dispose();
		assert.equal(f.controller.active.size, 0, "provider disposal releases the controller sink");
		for (const attachment of f.controller.attachments) {
			assert.equal(attachment.disposeCalls, 1, "the attachment is disposed exactly once");
		}
		for (const e of [
			...f.documents.map((document) => document.received),
			...f.views.flatMap((sidebar) => [sidebar.visibility, sidebar.disposal]),
		]) {
			assert.equal(e.listeners.size, 0, "no receiver or view event listener survives provider disposal");
			for (const record of e.registrations) assert.equal(record.disposeCalls, 1);
		}
	}
}

async function check(name, run) {
	try {
		await run();
		passed += 1;
		console.log(`PASS ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`FAIL ${name}\n${error.stack}`);
	}
}

try {
	const [ProviderA, ProviderB] = await Promise.all([loadProvider(PRIOR_A), loadProvider(CURRENT_B)]);
	let actualA;
	let actualB;
	await withFixture(ProviderA, "", ({ provider, sidebar, document }) => {
		provider.resolveWebviewView(sidebar);
		actualA = document.html;
	});
	await withFixture(ProviderB, "", ({ provider, sidebar, document }) => {
		provider.resolveWebviewView(sidebar);
		actualB = document.html;
	});
	// Missing marker means an unknown/legacy document, even if its asset URLs
	// happen to contain the current revision. A URL match is not a build stamp.
	const legacy = actualB.replace(/\sdata-pa-build="[^"]*"/, "");

	await check("blank webview renders current_B once, with a matching HTML/JS/CSS build stamp", () =>
		withFixture(ProviderB, "", async (f) => {
			f.provider.resolveWebviewView(f.sidebar);
			const rendered = f.document.html;
			assert.equal(f.document.writes.length, 1);
			assertBuild(rendered, CURRENT_B);
			assert.equal(f.document.options.enableScripts, true);
			assert.deepEqual(f.document.options.localResourceRoots, [vscodeStub.Uri.joinPath(vscodeStub.Uri.file(root), "media")]);
			toggle(f.sidebar);
			assert.equal(f.document.writes.length, 1, "visibility toggles do not navigate the document");
			assert.equal(f.document.html, rendered, "the nonce and HTML remain byte-identical");
			await assertReceiver(f);
		}));

	await check("retained current_B HTML survives same-view resolves and visibility toggles byte-for-byte", () =>
		withFixture(ProviderB, `${actualB}\n<!-- retained transcript and unsent draft -->`, async (f) => {
			const retained = f.document.html;
			const retainedNonce = nonce(retained);
			f.provider.resolveWebviewView(f.sidebar);
			toggle(f.sidebar);
			f.provider.resolveWebviewView(f.sidebar);
			toggle(f.sidebar);
			assert.equal(f.document.writes.length, 0, "current nonempty HTML is never assigned again");
			assert.equal(f.document.html, retained);
			assert.equal(nonce(f.document.html), retainedNonce);
			assert.equal(f.sidebar.visibility.listeners.size, 1, "re-resolve replaces the old visibility subscription");
			assert.equal(f.document.received.listeners.size, 1);
			await assertReceiver(f);
		}));

	for (const [name, cached] of [["real PRIOR_A document", actualA], ["unknown unstamped legacy document", legacy]]) {
		await check(`${name} refreshes to current_B exactly once`, () =>
			withFixture(ProviderB, cached, async (f) => {
				const oldNonce = nonce(cached);
				assert.ok(cached.length > 0);
				f.provider.resolveWebviewView(f.sidebar);
				assert.equal(f.document.writes.length, 1, "nonempty obsolete/unknown HTML must be invalidated");
				const refreshed = f.document.html;
				assert.notEqual(refreshed, cached);
				assertBuild(refreshed, CURRENT_B);
				assert.notEqual(nonce(refreshed), oldNonce, "an actual refresh mints one fresh nonce");
				toggle(f.sidebar);
				f.provider.resolveWebviewView(f.sidebar);
				toggle(f.sidebar);
				assert.equal(f.document.writes.length, 1, "the upgraded document is not refreshed a second time");
				assert.equal(f.document.html, refreshed);
				await assertReceiver(f);
			}));
	}

	for (const [name, cached, expectedWrites] of [
		["empty", "", 1], ["current_B", actualB, 0], ["PRIOR_A", actualA, 1], ["legacy", legacy, 1],
	]) {
		await check(`replacement inner webview (${name}) keeps one attachment and uses the current object`, () =>
			withFixture(ProviderB, "", async (f) => {
				f.provider.resolveWebviewView(f.sidebar);
				const outgoing = f.document;
				const oldHtml = outgoing.html;
				const first = { type: "focusComposer" };
				f.controller.broadcast(first);
				assert.deepEqual(outgoing.posts, [first]);
				f.sidebar.setVisible(false);
				const replacement = webview(cached);
				f.documents.push(replacement);
				f.sidebar.webview = replacement;
				assert.equal(replacement.writes.length, 0, "a hidden replacement has not been wired yet");
				f.sidebar.setVisible(true);
				assert.equal(replacement.writes.length, expectedWrites);
				assertBuild(replacement.html, CURRENT_B);
				const stable = replacement.html;
				toggle(f.sidebar);
				assert.equal(replacement.writes.length, expectedWrites);
				assert.equal(replacement.html, stable);
				assert.equal(outgoing.html, oldHtml, "rewiring does not alter the outgoing document");
				assert.equal(outgoing.received.listeners.size, 0, "old webview receiver is released");
				assert.equal(replacement.received.listeners.size, 1);
				const before = f.controller.calls.length;
				outgoing.received.fire({ type: "requestState" });
				assert.equal(f.controller.calls.length, before, "a replaced document cannot dispatch requests");
				await assertReceiver(f, replacement);
				assert.deepEqual(outgoing.posts, [first], "broadcasts no longer target the old webview");
			}));
	}

	await check("a separate replacement view transfers listeners and the dynamic sink without reloading current HTML", () =>
		withFixture(ProviderB, "", async (f) => {
			f.provider.resolveWebviewView(f.sidebar);
			const replacement = webview(actualB);
			const replacementView = view(replacement);
			f.documents.push(replacement);
			f.views.push(replacementView);
			f.provider.resolveWebviewView(replacementView);
			assert.equal(replacement.writes.length, 0);
			assert.equal(replacement.html, actualB);
			assert.equal(f.sidebar.visibility.listeners.size, 0);
			assert.equal(f.sidebar.disposal.listeners.size, 0);
			assert.equal(f.document.received.listeners.size, 0);
			assert.equal(replacementView.visibility.listeners.size, 1);
			const receiverCount = replacement.received.registrations.length;
			toggle(f.sidebar);
			f.sidebar.disposal.fire();
			assert.equal(replacement.received.registrations.length, receiverCount,
				"stale view visibility/disposal events cannot affect the current view");
			toggle(replacementView);
			assert.equal(replacement.writes.length, 0);
			await assertReceiver(f, replacement);
			assert.equal(f.document.posts.length, 0, "the same attached sink follows the newly resolved view");
			replacementView.disposal.fire();
			assert.equal(replacement.received.listeners.size, 0, "disposing the view releases its receiver");
			const posted = replacement.posts.length;
			f.controller.broadcast({ type: "focusComposer" });
			assert.equal(replacement.posts.length, posted, "the dynamic sink does not target a disposed view");
		}));
} finally {
	Module._load = originalLoad;
}

console.log(`webview revision: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
