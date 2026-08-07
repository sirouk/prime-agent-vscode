import { _electron as electron } from "playwright";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pa-probe3-"));
const PATH = `${os.homedir()}/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
const app = await electron.launch({
	executablePath: VSCODE,
	args: [
		os.homedir() + "/prime-agent-vs-ext",
		`--user-data-dir=${profile}`,
		`--extensions-dir=${path.join(os.homedir(), ".vscode/extensions")}`,
		`--extensionDevelopmentPath=${process.cwd()}`,
		"--disable-workspace-trust", "--skip-welcome", "--no-sandbox",
	],
	env: { ...process.env, PATH },
	timeout: 60_000,
});
const page = await app.firstWindow();
await page.waitForTimeout(9000);
async function waitForChatFrame(timeoutMs = 90_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		for (const frame of page.frames()) {
			try { if (await frame.evaluate(() => !!document.querySelector(".chat-root .brand-name"))) return frame; } catch {}
		}
		await page.waitForTimeout(300);
	}
	return null;
}
await page.keyboard.press("Meta+Shift+P");
await page.waitForTimeout(600);
await page.keyboard.type("Prime Agent: Focus Chat");
await page.waitForTimeout(600);
await page.keyboard.press("Enter");
await page.waitForTimeout(4000);
const frame = await waitForChatFrame();
if (!frame) { console.log("NO FRAME"); process.exit(1); }

// EXACT suite sequence: model menu, star, escape, thinking menu, escape
await frame.locator(".rail-pill.model").click();
await page.waitForTimeout(500);
const stars = await frame.locator(".dropdown-star").count();
console.log("menu items/star count:", stars);
await frame.locator(".dropdown-star").first().click();
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await frame.locator(".rail-pill").filter({ hasText: "thinking" }).first().click();
await page.waitForTimeout(400);
console.log("thinking items:", await frame.locator(".dropdown-item").count());
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

const ta = frame.locator(".composer-card textarea");
await ta.click();
await ta.fill("Reply with exactly: OMEGA-42. Do not use any tools.");
await page.keyboard.press("Enter");
for (let t = 0; t <= 60; t += 5) {
	await page.waitForTimeout(t === 0 ? 2000 : 5000);
	const st = await frame.evaluate(() => ({
		rows: document.querySelectorAll(".messages .row").length,
		working: !!document.querySelector(".working-row"),
		notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent.slice(0, 100)),
		live: document.querySelector(".live-label")?.textContent,
		conn: document.querySelector(".conn-dot")?.className,
	}));
	console.log(`t+${t + 2}s`, JSON.stringify(st));
	if (st.rows > 1 && !st.working) break;
}
await page.screenshot({ path: "test/e2e-shots/probe3.png" });

// read Prime Agent output channel logs: open output via command palette
await page.keyboard.press("Meta+Shift+P");
await page.waitForTimeout(600);
await page.keyboard.type("Output: Show Output Channels");
await page.waitForTimeout(600);
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
await page.keyboard.type("Prime Agent");
await page.waitForTimeout(500);
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
const outText = await page.evaluate(() => {
	const el = document.querySelector(".output-view .monaco-editor, .output-scrollable, [class*=output] .view-lines");
	return el ? el.textContent.slice(-1500) : "(no output element)";
});
console.log("HOST LOG TAIL:", outText.replace(/\s+/g, " ").slice(0, 1200));

await app.close().catch(() => {});
fs.rmSync(profile, { recursive: true, force: true });
