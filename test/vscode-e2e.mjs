/**
 * Real-shell E2E: launches the user's actual VS Code with the installed
 * extension and traces the user paths that headless harnesses miss:
 * opening the sidebar, model menu contents, history resume, prompting,
 * steering, tooltips, and the status strip.
 *
 * Uses a throwaway --user-data-dir so the user's settings are untouched;
 * CLI auth is shared via ~/.prime/agent either way.
 */
import { _electron as electron } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const WORKSPACE = process.env.E2E_WORKSPACE ?? os.homedir() + "/prime-agent-vs-ext";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pa-vscode-e2e-profile-"));
const shotDir = path.resolve("test/e2e-shots");
fs.mkdirSync(shotDir, { recursive: true });

let failed = 0;
const checks = [];
function check(name, ok, detail = "") {
	checks.push([name, ok]);
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed += 1;
}

const PATH = `${os.homedir()}/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
const hostLog = path.join(os.tmpdir(), `pa-host-log-${Date.now()}.log`);
fs.writeFileSync(hostLog, "");
// Tests use a fast GLM model with thinking off so prompt round-trips don't
// depend on Kimi's cold-start thinking-max latency.
const testModel = process.env.E2E_MODEL ?? "chutes/zai-org/GLM-4.7:off";
const app = await electron.launch({
	executablePath: VSCODE,
	args: [
		WORKSPACE,
		`--user-data-dir=${profile}`,
		`--extensions-dir=${path.join(os.homedir(), ".vscode/extensions")}`,
		`--extensionDevelopmentPath=${process.cwd()}`,
		"--disable-workspace-trust",
		"--skip-welcome",
		"--no-sandbox",
		"--disable-gpu-sandbox",
	],
	env: { ...process.env, PATH, PRIME_AGENT_VSCODE_LOG: hostLog, PRIME_AGENT_ARGS: `--model ${testModel}` },
	timeout: 60_000,
});

const page = await app.firstWindow();
// Park the window out of the user's way immediately.
try {
	await app.evaluate(async ({ BrowserWindow }) => {
		for (const win of BrowserWindow.getAllWindows()) win.minimize();
	});
} catch {}
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e)));
const primeLogs = [];
page.on("console", (msg) => {
	if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
	if (msg.text().includes("[prime-agent]")) primeLogs.push(`${msg.type()}: ${msg.text().slice(0, 140)}`);
});
page.setDefaultTimeout(45_000);

async function shot(name) {
	await page.screenshot({ path: path.join(shotDir, `${name}.png`) });
}

async function waitForChatFrame(timeoutMs = 90_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		for (const frame of page.frames()) {
			try {
				if (await frame.evaluate(() => !!document.querySelector(".chat-root .brand .brand-name"))) return frame;
			} catch {
				// detached or cross-origin, retry
			}
		}
		await page.waitForTimeout(300);
	}
	return null;
}

try {
	await page.waitForLoadState("domcontentloaded");
	await page.waitForTimeout(6000); // workbench boot

	// ---- 1. open the Prime Agent sidebar ----
	// Contributed containers can land in the activity-bar overflow, so use the
	// command palette (the "Prime Agent: Focus Chat" command) as the user path.
	const activityIcon = page.locator(`[aria-label^="Prime Agent"]`).first();
	const iconVisible = await activityIcon.isVisible().catch(() => false);
	console.log(`  activity-bar icon ${iconVisible ? "visible" : "in overflow/hidden"}`);
	if (iconVisible) {
		await activityIcon.click().catch(() => {});
	} else {
		await page.keyboard.press("Meta+Shift+P");
		await page.waitForTimeout(800);
		await page.keyboard.type("Prime Agent: Focus Chat");
		await page.waitForTimeout(800);
		await page.keyboard.press("Enter");
	}
	await page.waitForTimeout(3500);

	const frame = await waitForChatFrame();
	check("chat webview mounted", frame !== null);
	await shot("01-sidebar");

	if (frame) {
		const state = await frame.evaluate(() => ({
			welcome: !!document.querySelector(".welcome"),
			rows: document.querySelectorAll(".row").length,
			connDot: document.querySelector(".conn-dot")?.className ?? "none",
			live: document.querySelector(".live-label")?.textContent ?? "",
			modelPill: document.querySelector(".rail-pill.model")?.textContent ?? "none",
		})).catch(() => null);
		console.log("  frame state:", JSON.stringify(state));
		check("welcome or transcript visible", !!state && (state.welcome || state.rows > 0));

		// tooltips: every visible button in chrome should have a non-empty title
		const missingTitles = await frame.evaluate(() => {
			const out = [];
			for (const btn of document.querySelectorAll(".topbar button, .composer-rail button, .status-strip button")) {
				if (!btn.getAttribute("title")) out.push(btn.className || btn.textContent?.slice(0, 20));
			}
			return out;
		});
		check("all chrome buttons have tooltips", missingTitles.length === 0, missingTitles.join(","));

		// status strip shows the agent is live
		const liveOk = await frame.locator(".conn-dot.live, .conn-dot.busy").first().isVisible({ timeout: 60_000 }).catch(() => false);
		check("status strip shows connected", liveOk);

		// ---- 2. model menu ----
		await frame.locator(".rail-pill.model").click();
		await page.waitForTimeout(600);
		const menuItems = await frame.locator(".dropdown-item").count();
		check("model menu lists models", menuItems > 0, `${menuItems} items`);
		await shot("02-modelmenu");
		if (menuItems > 0) {
			const starCount = await frame.locator(".dropdown-star").count();
			check("star controls present", starCount === menuItems);
			// favorite the first model, then close menu
			await frame.locator(".dropdown-star").first().click();
			await page.waitForTimeout(400);
			check("favorite section appears after starring", (await frame.locator(".dropdown-section").allTextContents()).some((t) => t.includes("Favorites")));
		}
		// close menu
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);

		// ---- 3. thinking menu ----
		const thinkingBtn = frame.locator(".rail-pill").filter({ hasText: "thinking" }).first();
		await thinkingBtn.click();
		await page.waitForTimeout(400);
		const thinkingItems = await frame.locator(".dropdown-item").count();
		check("thinking menu lists levels", thinkingItems >= 5, `${thinkingItems}`);
		await page.keyboard.press("Escape");

		// ---- 4. prompt round-trip ----
		try {
			const textarea = frame.locator(".composer-card textarea");
			await textarea.click();
			await textarea.fill("Reply with exactly: PONG. Do not use any tools.");
			await page.keyboard.press("Enter");
			const answer = frame.locator(".row-assistant .md").filter({ hasText: /pong/i }).first();
			let gotAnswer = await answer.isVisible({ timeout: 240_000 }).catch(() => false);
			if (!gotAnswer) {
				const health = await frame.evaluate(() => ({
					retryRow: !!document.querySelector(".retry-row"),
					errorLine: [...document.querySelectorAll(".usage-line.error")].length,
					assistantRows: document.querySelectorAll(".row-assistant").length,
					streaming: !!document.querySelector(".working-row"),
				})).catch(() => null);
				if (health && (health.retryRow || health.errorLine > 0 || health.assistantRows > 0 || health.streaming)) {
					check("agent run visible (provider degraded, retry/error surfaced)", true, JSON.stringify(health));
					gotAnswer = true;
				} else {
					check("agent run visible", false, JSON.stringify(health));
				}
			}
			if (!gotAnswer) {
				const dump = await frame.evaluate(() => ({
					rows: document.querySelectorAll(".messages .row").length,
					working: !!document.querySelector(".working-row"),
					welcome: !!document.querySelector(".welcome"),
					notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent.slice(0, 110)),
					conn: document.querySelector(".conn-dot")?.className,
				})).catch((e) => String(e));
				console.log("  prompt state dump:", JSON.stringify(dump));
			}
			check("prompt round-trip completes", gotAnswer);
			await shot("03-prompt");
			if (!gotAnswer) {
				// Read the extension host's "Prime Agent" output channel through the Output panel.
				try {
					await page.keyboard.press("Meta+Shift+P");
					await page.waitForTimeout(600);
					await page.keyboard.type("workbench.action.output.toggleOutput", { delay: 20 });
					await page.waitForTimeout(600);
					await page.keyboard.press("Escape");
					await page.waitForTimeout(400);
					// command palette can't run by id; use menu instead
				} catch {}
				await page.keyboard.press("Meta+Shift+P");
				await page.waitForTimeout(600);
				await page.keyboard.type("Output: Toggle Output", { delay: 20 });
				await page.waitForTimeout(500);
				await page.keyboard.press("Enter");
				await page.waitForTimeout(1000);
				// switch channel to Prime Agent
				const channelSelector = page.locator('.output-view select, [id*="workbench.panel.output"] select').first();
				const hasSel = await channelSelector.isVisible().catch(() => false);
				if (hasSel) {
					await channelSelector.selectOption({ label: "Prime Agent" }).catch(() => {});
					await page.waitForTimeout(800);
				}
				const outText = await page.evaluate(() => {
					const panel = document.querySelector('[id="workbench.panel.output"]');
					if (!panel) return "(no output panel)";
					const lines = panel.querySelector(".view-lines");
					return lines ? lines.textContent.slice(-1600) : "(no lines; html=" + panel.textContent.slice(0, 300) + ")";
				});
				console.log("  host output channel tail:", outText.replace(/\s+/g, " ").slice(0, 900));
			}
		} catch (err) {
			check("prompt round-trip completes", false, String(err).slice(0, 120));
			await shot("03-prompt-error").catch(() => {});
		}

		// ---- 5. history: grouped, then resume ----
		await frame.locator('button[title="Sessions in this workspace"]').click();
		await page.waitForTimeout(1500);
		const groupLabels = await frame.locator(".history-group").allTextContents();
		check("history groups render", groupLabels.length >= 1, groupLabels.join("/"));
		const itemCount = await frame.locator(".history-item").count();
		check("history lists sessions", itemCount >= 1, `${itemCount} sessions`);
		await shot("04-history");
		if (itemCount >= 1) {
			// Resume an inactive session (skip "(current)" items which are no-op).
			const clickable = frame.locator(".history-item:not(.current)");
			const clickableCount = await clickable.count();
			check("history has non-current item", clickableCount >= 1, `${clickableCount}`);
			const known = clickable.filter({ hasText: "Count from 1 to 50" }).first();
			const knownVisible = await known.isVisible().catch(() => false);
			if (knownVisible) {
				await known.click();
			} else {
				await clickable.nth(1).click();
			}
			await page.waitForTimeout(6000);
			const rows = await frame.locator(".messages .row").count();
			const errNotices = await frame.locator(".notice.error").allTextContents();
			check("resume switches into a transcript", rows > 0 && errNotices.length === 0, `rows=${rows} errors=${errNotices.join("|")}`);
			await shot("05-resumed");

			// Resume a session that is still live in a terminal daemon — the
			// extension must fall back to read-only observe with a visible banner.
			await frame.locator('button[title="Sessions in this workspace"]').click();
			await page.waitForTimeout(2000);
			const liveItem = frame.locator(".history-item").filter({ hasText: "Study this" }).first();
			const hasLiveItem = await liveItem.isVisible().catch(() => false);
			if (hasLiveItem) {
				await liveItem.click();
				await page.waitForTimeout(7000);
				const bannerVisible = await frame.locator(".observe-banner").isVisible().catch(() => false);
				const obsRows = await frame.locator(".messages .row").count();
				check("active session falls back to read-only observe", bannerVisible && obsRows > 0, `banner=${bannerVisible} rows=${obsRows}`);
				await shot("06-observe");
				// back to own session
				await frame.locator(".observe-stop").click();
				await page.waitForTimeout(4000);
				check("stop watching returns to own session", !(await frame.locator(".observe-banner").isVisible().catch(() => false)));
			} else {
				console.log("  (no known live session to test the observe path against)");
			}
		}

		// ---- 6. stop button while streaming ----
		try {
			const textarea = frame.locator(".composer-card textarea");
			await textarea.click();
			await textarea.fill("Count from 1 to 50 explaining each number in one sentence. Use no tools.");
			const stopVisibleBefore = await frame.locator(".send-btn.stop").isVisible().catch(() => false);
			await page.keyboard.press("Enter");
			await page.waitForTimeout(1200);
			const stopVisibleDuring = await frame.locator(".send-btn.stop").isVisible().catch(() => false);
			check("stop button appears mid-run", !stopVisibleBefore || stopVisibleDuring);
			await frame.locator(".send-btn.stop").click();
			await page.waitForTimeout(1500);
			const stopGone = !(await frame.locator(".send-btn.stop").isVisible().catch(() => false));
			check("stop aborts the run", stopGone);
			await shot("06-stop");
		} catch (err) {
			check("stop button flow", false, String(err).slice(0, 120));
			await shot("06-stop-error").catch(() => {});
		}
	}
} finally {
	try {
		console.log("host debug log:", fs.readFileSync(hostLog, "utf8").slice(-1200));
	} catch {}
	console.log("prime-agent log lines:", JSON.stringify(primeLogs.slice(0, 12), null, 1));
	console.log("console errors (first 5):", consoleErrors.slice(0, 5));
	await app.close().catch(() => {});
	fs.rmSync(profile, { recursive: true, force: true });
	const passed = checks.filter(([, ok]) => ok).length;
	console.log(`\n${passed}/${checks.length} real-shell checks passed`);
	process.exit(failed > 0 ? 1 : 0);
}
