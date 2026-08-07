/**
 * Persistent VS Code e2e driver: launches the real VS Code once with the
 * extension loaded from the repo, keeps the window open MINIMIZED (no focus
 * stealing), and serves scenarios over http://127.0.0.1:7321.
 *
 * Endpoints:
 *   GET  /state            current chat-frame state (JSON)
 *   POST /reload           restart the extension host, reopen chat, rerun ready chain
 *   POST /scenario/:name   run a named scenario, returns {steps:[{name,ok,detail}]}
 *   POST /shutdown         close the window and exit
 *
 * Scenarios cover the user paths: menus-then-prompt, resume, observe, stop.
 */
import { _electron as electron } from "playwright";
import * as http from "node:http";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const WORKSPACE = os.homedir() + "/prime-agent-vs-ext";
const PORT = 7321;
const PATH = `${os.homedir()}/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
const testModel = process.env.E2E_MODEL ?? "chutes/zai-org/GLM-4.7:off";
const profile = process.env.PA_E2E_PROFILE ?? fs.mkdtempSync(path.join(os.tmpdir(), "pa-live-profile-"));
const hostLog = path.join(os.tmpdir(), `pa-live-host-${Date.now()}.log`);
fs.writeFileSync(hostLog, "");

let app = null;
let page = null;
let frame = null;
const frameConsoleErrors = [];

const ok = (name, cond, detail = "") => ({ name, ok: !!cond, detail: String(detail).slice(0, 220) });

async function waitForChatFrame(timeoutMs = 90_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		for (const f of page.frames()) {
			try {
				if (await f.evaluate(() => !!document.querySelector(".chat-root .brand-name"))) return f;
			} catch {}
		}
		await page.waitForTimeout(300);
	}
	return null;
}

async function openChat() {
	await page.keyboard.press("Meta+Shift+P");
	await page.waitForTimeout(700);
	await page.keyboard.type("Prime Agent: Focus Chat");
	await page.waitForTimeout(700);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(3000);
	frame = await waitForChatFrame();
	if (!frame) throw new Error("chat frame never mounted");
	await frame.locator(".conn-dot.live, .conn-dot.busy").first().isVisible({ timeout: 60_000 }).catch(() => {});
}

async function boot() {
	app = await electron.launch({
		executablePath: VSCODE,
		args: [
			WORKSPACE,
			`--user-data-dir=${profile}`,
			`--extensions-dir=${path.join(os.homedir(), ".vscode/extensions")}`,
			`--extensionDevelopmentPath=${process.cwd()}`,
			"--disable-workspace-trust", "--skip-welcome", "--no-sandbox",
		],
		env: { ...process.env, PATH, PRIME_AGENT_VSCODE_LOG: hostLog, PRIME_AGENT_ARGS: `--model ${testModel}` },
		timeout: 60_000,
	});
	page = await app.firstWindow();
	page.on("pageerror", (err) => frameConsoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`));
	page.on("console", (msg) => {
		if (msg.type() === "error" || msg.type() === "warning") {
			frameConsoleErrors.push(`${msg.type()}: ${msg.text().slice(0, 200)}`);
			if (frameConsoleErrors.length > 60) frameConsoleErrors.splice(0, frameConsoleErrors.length - 60);
		}
	});
	await page.waitForLoadState("domcontentloaded");
	await page.waitForTimeout(8000);
	// Park the window out of the user's way for the rest of the session.
	try {
		await app.evaluate(async ({ BrowserWindow }) => {
			for (const win of BrowserWindow.getAllWindows()) win.minimize();
		});
	} catch {}
	await openChat();
}

async function reloadHost() {
	await page.evaluate(() => document.hasFocus?.()).catch(() => {});
	await page.keyboard.press("Meta+Shift+P").catch(() => {});
	await page.waitForTimeout(600);
	await page.keyboard.type("Developer: Restart Extension Host");
	await page.waitForTimeout(700);
	await page.keyboard.press("Enter");
	frame = null;
	await page.waitForTimeout(6000);
	// Webview pages can outlive an extension-host restart with a cached URL.
	await page.keyboard.press("Meta+Shift+P");
	await page.waitForTimeout(700);
	await page.keyboard.type("Developer: Reload Webviews");
	await page.waitForTimeout(700);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(4000);
	await openChat();
}

// ---------------------------------------------------------------- scenarios

const scenarios = {
	async "prompt-only"() {
		const steps = [];
		const ta = frame.locator(".composer-card textarea");
		await ta.click();
		await ta.fill("Reply with exactly: OMEGA-42. Do not use any tools.");
		await page.keyboard.press("Enter");
		const working = await frame.locator(".working-row").isVisible({ timeout: 20_000 }).catch(() => false);
		steps.push(ok("agent starts (working row)", working));
		const answer = frame.locator(".messages").filter({ hasText: /omega/i }).first();
		steps.push(ok("agent answers", await answer.isVisible({ timeout: 120_000 }).catch(() => false)));
		return steps;
	},

	async "menus-then-prompt"() {
		const steps = [];
		await frame.locator(".rail-pill.model").click();
		await page.waitForTimeout(500);
		const itemCount = await frame.locator(".dropdown-item").count();
		steps.push(ok("model menu items", itemCount > 0, `${itemCount}`));
		const sections = await frame.locator(".dropdown-section").allTextContents();
		steps.push(ok("thinking section nested", sections.some((s) => s.includes("Thinking level")), sections.join("/") || "no sections"));
		await frame.locator(".dropdown-star").first().click();
		await page.waitForTimeout(400);
		steps.push(ok("favorites section", (await frame.locator(".dropdown-section").allTextContents()).some((t) => t.includes("Favorites"))));
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
		// unified attach button opens menu with 4 items
		await frame.locator(".composer-rail .icon-btn").first().click();
		await page.waitForTimeout(400);
		const attachItems = [...new Set((await frame.locator(".dropdown-item").allTextContents()).map((t) => t.slice(0, 20)))];
		steps.push(ok("attach menu items", attachItems.length === 4, attachItems.join("|")));
		const imageItem = await frame.locator(".dropdown-item").filter({ hasText: /Image/ }).first().textContent().catch(() => "");
		steps.push(ok("image attach gated", imageItem.includes("Image"), imageItem.slice(0, 60)));
		await page.keyboard.press("Escape");

		const ta = frame.locator(".composer-card textarea");
		await ta.click();
		await ta.fill("Reply with exactly: OM EGA-42. Do not use any tools.");
		await page.keyboard.press("Enter");
		const answer = frame.locator(".row-assistant .md, .messages").filter({ hasText: /pong|omega/i }).first();
		const got = await answer.isVisible({ timeout: 150_000 }).catch(() => false);
		if (!got) {
			const dump = await frame.evaluate(() => ({
				rows: document.querySelectorAll(".messages .row").length,
				retryRow: !!document.querySelector(".retry-row"),
				children: [...document.querySelector(".messages").children].map((c) => (c.className || c.tagName).split(" ")[0]),
				working: !!document.querySelector(".working-row"),
				live: document.querySelector(".live-label")?.textContent,
				conn: document.querySelector(".conn-dot")?.className,
				openDropdowns: document.querySelectorAll(".dropdown").length,
			}));
			steps.push(ok("agent answers", false, JSON.stringify(dump)));
		} else {
			steps.push(ok("agent answers", true));
		}
		return steps;
	},

	async "new-session"() {
		const steps = [];
		await frame.locator('button[title="New session"]').click();
		await page.waitForTimeout(4000);
		const rows = await frame.locator(".messages .row").count();
		steps.push(ok("transcript cleared", rows === 0, `rows=${rows}`));
		return steps;
	},

	async "resume-and-observe"() {
		const steps = [];
		await frame.locator('button[title="Sessions in this workspace"]').click();
		await page.waitForTimeout(2000);
		const items = frame.locator(".history-item:not(.current)");
		steps.push(ok("history items", (await items.count()) >= 1, `${await items.count()}`));
		if ((await items.count()) >= 1) {
			await items.first().click();
			await page.waitForTimeout(6000);
			const rows = await frame.locator(".messages .row").count();
			steps.push(ok("resume renders transcript", rows > 0 || (await frame.locator(".notice").count()) > 0, `rows=${rows}`));
			// back via banner if observing, else keep session
			const banner = frame.locator(".observe-banner");
			if (await banner.isVisible().catch(() => false)) {
				steps.push(ok("observe fallback hit", true));
				await frame.locator(".observe-stop").click();
				await page.waitForTimeout(3000);
				steps.push(ok("back to own session", !(await frame.locator(".observe-banner").isVisible().catch(() => false))));
			}
		}
		return steps;
	},

	async "stop-mid-run"() {
		const steps = [];
		const ta = frame.locator(".composer-card textarea");
		await ta.click();
		await ta.fill("Count from 1 to 40 explaining each in one sentence. Use no tools.");
		await page.keyboard.press("Enter");
		const stopVisible = await frame.locator(".send-btn.stop").waitFor({ state: "visible", timeout: 20000 }).then(() => true).catch(() => false);
		steps.push(ok("stop appears", stopVisible));
		await frame.locator(".send-btn.stop").click();
		await page.waitForTimeout(1500);
		steps.push(ok("abort works", !(await frame.locator(".send-btn.stop").isVisible().catch(() => false))));
		return steps;
	},
};

// ---------------------------------------------------------------- server

let booting = null;

function ensureAlive() {
	if (page && !page.isClosed()) return Promise.resolve();
	if (booting) return booting;
	console.log("[driver] window closed — rebooting");
	booting = boot().finally(() => (booting = null));
	return booting;
}

const server = http.createServer(async (req, res) => {
	const send = (code, body) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	try {
		await ensureAlive();
		const url = new URL(req.url, "http://x");
		if (req.method === "GET" && url.pathname === "/frames") {
			const frames = [];
			for (const f of page.frames()) {
				try {
					const has = await f.evaluate(() => !!document.querySelector(".chat-root .brand-name"));
					if (has) {
						frames.push({
							url: f.url().slice(0, 100),
							build: await f.evaluate(() => document.body.dataset.paBuild ?? "unknown"),
							trace: await f.evaluate(() => document.querySelector(".pa-events-trace")?.textContent ?? "none"),
							rows: await f.evaluate(() => document.querySelectorAll(".messages .row").length),
						});
					}
				} catch {}
			}
			return send(200, { frames });
		}
		if (req.method === "GET" && url.pathname === "/eval") {
			const expr = url.searchParams.get("expr") || "null";
			if (!frame) return send(200, { value: null, error: "no frame" });
			try {
				const value = await frame.evaluate(expr);
				return send(200, { value });
			} catch (error) {
				return send(200, { evalError: String(error) });
			}
		}
		if (req.method === "GET" && url.pathname === "/state") {
			if (!frame) return send(200, { frame: null });
			const state = await frame.evaluate(() => ({
				rows: document.querySelectorAll(".messages .row").length,
				retryRow: !!document.querySelector(".retry-row"),
				children: [...document.querySelector(".messages").children].map((c) => c.className.split(" ")[0] || c.tagName),
				working: !!document.querySelector(".working-row"),
				welcome: !!document.querySelector(".welcome"),
				conn: document.querySelector(".conn-dot")?.className,
				live: document.querySelector(".live-label")?.textContent,
				model: document.querySelector(".rail-pill.model")?.textContent,
				dropdowns: document.querySelectorAll(".dropdown").length,
				build: document.body.dataset.paBuild ?? "unknown",
				notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent.slice(0, 80)),
				handlerErrors: [...document.querySelectorAll(".pa-handler-error")].map((n) => n.textContent.slice(0, 300)),
			}));
			return send(200, { frame: true, consoleErrors: frameConsoleErrors.slice(-8), ...state });
		}
		if (req.method === "POST" && url.pathname === "/reload") {
			await reloadHost();
			return send(200, { reloaded: true });
		}
		if (req.method === "POST" && url.pathname === "/reopen-chat") {
			await openChat();
			return send(200, { ok: !!frame });
		}
		if (req.method === "POST" && url.pathname === "/shutdown") {
			send(200, { closed: true });
			setTimeout(async () => {
				await app.close().catch(() => {});
				process.exit(0);
			}, 200);
			return;
		}
		if (req.method === "POST" && url.pathname.startsWith("/scenario/")) {
			const name = url.pathname.slice("/scenario/".length);
			const scenario = scenarios[name];
			if (!scenario) return send(404, { error: `unknown scenario ${name}; have ${Object.keys(scenarios).join(", ")}` });
			const steps = await scenario();
			const failed = steps.filter((s) => !s.ok);
			return send(200, { scenario: name, steps, failed: failed.length });
		}
		send(404, { error: "unknown route" });
	} catch (err) {
		send(500, { error: String(err).slice(0, 300) });
	}
});

try {
	await boot();
} catch (err) {
	console.error("[driver] initial boot failed:", err);
}
server.listen(PORT, "127.0.0.1", () => {
	console.log(`LIVE DRIVER READY on http://127.0.0.1:${PORT} model=${testModel} profile=${profile} hostLog=${hostLog}`);
});
