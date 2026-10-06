/**
 * Real Chromium regression for the OUTER chat scroller during live output.
 * Usage: node test/scroll-anchor.test.mjs
 *
 * Bundle source in memory: this does not depend on a stale media/main.js or
 * change build artifacts. The original preview harness supplies the fake host;
 * all output below is controlled MessageEvents, never a paid agent run.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
	absWorkingDir: root,
	entryPoints: ["webview/main.ts"],
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	target: "es2022",
	define: { PRIME_AGENT_BUILD_REV: JSON.stringify("scroll-anchor-test") },
	logLevel: "silent",
});
const assets = new Map([
	["/preview.html", ["text/html", await readFile(`${root}media/preview.html`)]],
	["/main.css", ["text/css", await readFile(`${root}media/main.css`)]],
	["/main.js", ["text/javascript", bundle.outputFiles[0].contents]],
]);
const server = createServer((req, res) => {
	const asset = assets.get(new URL(req.url, "http://localhost").pathname);
	res.writeHead(asset ? 200 : 404, { "Content-Type": asset?.[0] ?? "text/plain" });
	res.end(asset?.[1] ?? "Not found");
});
await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolve);
});
let browser;
let failures = 0;

const frames = (page, count = 4) => page.evaluate(async (n) => {
	for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
}, count);
const metrics = (page) => page.$eval(".messages", (e) => ({
	top: e.scrollTop, max: e.scrollHeight - e.clientHeight,
	gap: e.scrollHeight - e.clientHeight - e.scrollTop,
}));
const indicator = (page) => page.evaluate(() => {
	const e = document.querySelector(".jump-to-latest");
	return {
		visible: !!e && e.classList.contains("visible") && getComputedStyle(e).display !== "none",
		label: e?.textContent.trim() ?? "",
	};
});
async function expectNewMessages(page) {
	assert.deepEqual(await indicator(page), { visible: true, label: "New messages" });
}

async function seed(page) {
	await page.goto(`http://127.0.0.1:${server.address().port}/preview.html?mode=welcome`);
	await page.waitForSelector(".messages");
	await page.evaluate(() => {
		const messages = [];
		for (let i = 0; i < 12; i++) {
			messages.push({ role: "user", content: `History question ${i}` });
			messages.push({ role: "assistant", stopReason: "stop", content: [{
				type: "text", text: `History reply ${i}. ` + "Earlier transcript prose. ".repeat(20),
			}] });
		}
		host({ type: "snapshot", messages, state: null, status: { ...baseStatus, streaming: true }, steerDefault: "steer" });
		window.__event = (event) => host({ type: "event", event });
		window.__tick = 0;
		window.__reply = "Initial live reply.\n\n";
		window.__code = "print('initial')\n";
		window.__output = "initial output\n";
		window.__withTool = false;
		window.__message = () => ({ role: "assistant", content: [
			{ type: "text", text: window.__reply },
			...(window.__withTool ? [{ type: "toolCall", id: "anchor-tool", name: "ipython", arguments: { code: window.__code } }] : []),
		] });
		window.__push = (kind) => {
			const n = ++window.__tick;
			if (kind === "text") {
				window.__reply += `Animated token chunk ${n}. ` + "Live streamed words. ".repeat(12) + "\n\n";
				window.__event({ type: "message_update", message: window.__message(), assistantMessageEvent: {
					type: "text_delta", contentIndex: 0, delta: `chunk ${n}`,
				} });
			} else if (kind === "custom") {
				window.__event({ type: "message_start", message: {
					role: "custom", customType: "agent_message", display: true,
					content: `Worker message ${n}. ` + "New agent output below the reader. ".repeat(10),
				} });
			} else {
				window.__code += `value_${n} = compute(${n})\n`;
				window.__output += `streamed result ${n}\n`;
				window.__event({ type: "message_update", message: window.__message(), assistantMessageEvent: {
					type: "toolcall_delta", contentIndex: 1, delta: `value_${n}\n`,
				} });
				window.__event({ type: "tool_execution_update", toolCallId: "anchor-tool", toolName: "ipython",
					args: { code: window.__code }, partialResult: { output: window.__output } });
			}
		};
		window.__event({ type: "agent_start" });
		window.__event({ type: "message_start", message: window.__message() });
	});
	await frames(page);
	const m = await metrics(page);
	assert.ok(m.max > 1500, `fixture must overflow: ${JSON.stringify(m)}`);
	assert.ok(m.gap <= 2, `fixture must land at bottom: ${JSON.stringify(m)}`);
}

async function detachWithWheel(page) {
	// Hover visible history, not a nested tool <pre>, to exercise outer wheel input.
	const box = await page.locator(".messages").boundingBox();
	await page.mouse.move(box.x + 12, box.y + box.height / 2);
	await page.mouse.wheel(0, -300);
	await page.waitForFunction(() => {
		const e = document.querySelector(".messages");
		return e.scrollHeight - e.clientHeight - e.scrollTop > 200;
	});
	await frames(page);
	return metrics(page);
}

async function beginSamples(page) {
	await page.evaluate(() => {
		const e = document.querySelector(".messages");
		const box = e.getBoundingClientRect();
		const anchor = [...e.querySelectorAll(":scope > .row")].find((r) => {
			const b = r.getBoundingClientRect();
			return b.top >= box.top && b.top < box.bottom;
		});
		window.__samples = [];
		window.__sampling = true;
		window.__sample = () => window.__samples.push({
			top: e.scrollTop, max: e.scrollHeight - e.clientHeight,
			gap: e.scrollHeight - e.clientHeight - e.scrollTop,
			anchor: anchor ? anchor.getBoundingClientRect().top - e.getBoundingClientRect().top : null,
		});
		const loop = () => {
			if (!window.__sampling) return;
			window.__sample();
			requestAnimationFrame(loop);
		};
		loop();
	});
}
async function stream(page, kind, count = 18, batch = 1) {
	// Every task contains a rapid batch of host events; batches arrive on real
	// animation frames, so sampling catches a transient snap, not just the end.
	await page.evaluate(async ({ kind, count, batch }) => {
		for (let i = 0; i < count; i++) {
			await new Promise(requestAnimationFrame);
			for (let j = 0; j < batch; j++) window.__push(kind);
			window.__sample?.();
		}
	}, { kind, count, batch });
	await frames(page, 6);
}
async function heldSamples(page, before) {
	const samples = await page.evaluate(() => {
		window.__sampling = false;
		return window.__samples;
	});
	assert.ok(samples.length >= 20, `must sample each animation frame, got ${samples.length}`);
	assert.ok(samples.at(-1).max > before.max + 50, "live output must really grow the outer transcript");
	const drift = Math.max(...samples.map((s) => Math.abs(s.top - before.top)));
	assert.ok(drift <= 1, `outer position moved during a frame: max drift ${drift}px`);
	const anchor = samples[0].anchor;
	assert.notEqual(anchor, null, "fixture needs a visible history row as visual anchor");
	assert.ok(samples.every((s) => s.anchor !== null && Math.abs(s.anchor - anchor) <= 1), "visible history row moved during live output");
}
async function resumeWithWheel(page) {
	await page.mouse.wheel(0, 100000);
	await page.waitForFunction(() => {
		const e = document.querySelector(".messages");
		return e.scrollHeight - e.clientHeight - e.scrollTop <= 2;
	});
	await frames(page);
	assert.equal((await indicator(page)).visible, false, "scrolling bottom must hide indicator");
	await stream(page, "text", 8, 3);
	assert.ok((await metrics(page)).gap <= 2, "scrolling bottom must resume live following");
}

async function run(name, test) {
	const page = await browser.newPage({ viewport: { width: 420, height: 620 } });
	page.setDefaultTimeout(5000);
	const errors = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	try {
		await seed(page);
		await test(page);
		assert.deepEqual(errors, [], "webview page errors");
		console.log(`PASS  ${name}`);
	} catch (error) {
		failures++;
		console.error(`FAIL  ${name}\n  ${error.stack}`);
	} finally {
		await page.close();
	}
}

try {
	browser = await chromium.launch();
	await run("animated token chunks hold outer position on every frame and wheel-to-bottom resumes", async (page) => {
		const before = await detachWithWheel(page);
		await beginSamples(page);
		await stream(page, "text", 24, 4);
		await heldSamples(page, before);
		assert.ok(await page.locator(".messages").textContent().then((t) => t.includes("Animated token chunk 96")), "all chunks rendered");
		await expectNewMessages(page);
		await resumeWithWheel(page);
	});
	await run("custom agent-message blocks and rapid event batches stay below held position", async (page) => {
		const before = await detachWithWheel(page);
		await beginSamples(page);
		await stream(page, "custom", 18, 3);
		await heldSamples(page, before);
		assert.equal(await page.locator(".custom-note").count(), 54, "custom events must actually render blocks");
		await expectNewMessages(page);
		await resumeWithWheel(page);
	});
	await run("streamed tool-call args, partial results, and final result preserve outer position", async (page) => {
		await page.evaluate(() => {
			window.__withTool = true;
			window.__event({ type: "message_update", message: window.__message() });
			window.__event({ type: "tool_execution_start", toolCallId: "anchor-tool", toolName: "ipython", args: { code: window.__code } });
			document.querySelector('[data-part="tool-anchor-tool"] .tool-toggle').click();
		});
		await frames(page);
		const before = await detachWithWheel(page);
		await beginSamples(page);
		await stream(page, "tool", 20, 3);
		await page.evaluate(() => window.__event({ type: "tool_execution_end", toolCallId: "anchor-tool", toolName: "ipython",
			result: { output: window.__output + "Final result complete\n" }, isError: false }));
		await frames(page);
		await heldSamples(page, before);
		assert.ok((await page.locator(".tool-body").textContent()).includes("value_60 = compute(60)"), "streamed args rendered");
		assert.ok((await page.locator(".tool-result").textContent()).includes("Final result complete"), "final streamed result rendered");
		await expectNewMessages(page);
		await resumeWithWheel(page);
	});
	for (const gap of [49, 51]) {
		await run(`${gap}px bottom gap is ${gap < 50 ? "following" : "detached"} at the 50px boundary`, async (page) => {
			await page.$eval(".messages", (e, gap) => {
				e.scrollTop = e.scrollHeight - e.clientHeight - gap;
				e.dispatchEvent(new Event("scroll"));
			}, gap);
			await frames(page);
			const before = await metrics(page);
			assert.equal(Math.round(before.gap), gap, "exact boundary setup");
			await beginSamples(page);
			await stream(page, "text", 18, 2);
			if (gap < 50) {
				await page.evaluate(() => { window.__sampling = false; });
				assert.ok((await metrics(page)).gap <= 2, "49px must resume following on content growth");
				assert.equal((await indicator(page)).visible, false);
			} else {
				await heldSamples(page, before);
				await expectNewMessages(page);
			}
		});
	}
	for (const gap of [49, 51]) {
		await run(`${gap}px same-task gap before rapid growth respects the 50px boundary`, async (page) => {
			await beginSamples(page);
			const before = await page.evaluate((gap) => {
				const e = document.querySelector(".messages");
				e.scrollTop = e.scrollHeight - e.clientHeight - gap;
				// No synthetic scroll and no frame yield: the render sees geometry
				// before the browser can deliver the user's native scroll event.
				window.__samples.length = 0;
				window.__sample();
				const before = { top: e.scrollTop, max: e.scrollHeight - e.clientHeight,
					gap: e.scrollHeight - e.clientHeight - e.scrollTop };
				for (let i = 0; i < 20; i++) {
					window.__push("text");
					window.__push("custom");
					window.__sample();
				}
				return before;
			}, gap);
			assert.equal(Math.round(before.gap), gap, "exact same-task boundary setup");
			await stream(page, "text", 18, 2);
			if (gap < 50) {
				await page.evaluate(() => { window.__sampling = false; });
				assert.ok((await metrics(page)).gap <= 2, "49px same-task movement must keep following after delayed scroll");
				assert.equal((await indicator(page)).visible, false);
			} else {
				await heldSamples(page, before);
				await expectNewMessages(page);
			}
		});
	}
	await run("pruning old rows at the tail keeps following", async (page) => {
		await page.evaluate(() => {
			for (let i = 0; i < 630; i++) window.__push("custom");
		});
		await frames(page);
		assert.ok(await page.locator(".pruned-bar").count(), "fixture actually pruned old rows");
		assert.ok((await metrics(page)).gap <= 2, "pruning-induced scroll adjustment is not reader intent");
		await stream(page, "text", 8, 2);
		assert.ok((await metrics(page)).gap <= 2, "following survives subsequent updates");
		assert.equal((await indicator(page)).visible, false);
	});
	await run("rapid growth before the reader's scroll event arrives preserves the off-tail position", async (page) => {
		await beginSamples(page);
		const before = await page.evaluate(() => {
			const e = document.querySelector(".messages");
			e.scrollTop -= 240;
			// Native scroll notification is deferred. Do not dispatch one here:
			// render must inspect pre-growth geometry before its first snap.
			window.__samples.length = 0;
			window.__sample();
			const before = { top: e.scrollTop, max: e.scrollHeight - e.clientHeight };
			for (let i = 0; i < 20; i++) {
				window.__push("text");
				window.__push("custom");
				window.__sample();
			}
			return before;
		});
		await stream(page, "text", 18, 3);
		await heldSamples(page, before);
		await expectNewMessages(page);
		// Also cover the explicit indicator action, independent of wheel resume.
		await page.locator(".jump-to-latest").click();
		await frames(page);
		assert.ok((await metrics(page)).gap <= 2, "indicator jumps to latest output");
		await stream(page, "text", 8, 2);
		assert.ok((await metrics(page)).gap <= 2, "indicator click resumes following");
		assert.equal((await indicator(page)).visible, false);
	});
	await run("delayed scroll event after content growth does not release following", async (page) => {
		await page.evaluate(() => {
			window.__withTool = true;
			window.__event({ type: "message_update", message: window.__message() });
			// A snap creates a scroll event queued for the next frame. Grow layout
			// in the SAME task, without another host event, before it is delivered.
			window.__push("text");
			document.querySelector('[data-part="tool-anchor-tool"] .tool-toggle').click();
			const e = document.querySelector(".messages");
			const input = document.querySelector('[data-part="tool-anchor-tool"] .tool-body pre');
			input.textContent += "\n" + "Delayed layout growth\n".repeat(12);
			window.__delayedGap = e.scrollHeight - e.clientHeight - e.scrollTop;
			requestAnimationFrame(() => e.dispatchEvent(new Event("scroll")));
		});
		assert.ok(await page.evaluate(() => window.__delayedGap > 50), "must grow beyond boundary before queued scroll event");
		await frames(page);
		await stream(page, "text", 18, 3);
		assert.ok((await metrics(page)).gap <= 2, "late snap event must not mistake growth for reader intent");
		assert.equal((await indicator(page)).visible, false, "following must not expose a new messages indicator");
	});
} finally {
	await browser?.close();
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log(`\n${failures ? `${failures} failing` : "All 10 passing"} outer-scroll browser scenarios`);
process.exitCode = failures ? 1 : 0;
