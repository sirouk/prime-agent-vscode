import { _electron as electron } from "playwright";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pa-probe2b-"));
const PATH = `${os.homedir()}/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
const app = await electron.launch({
	executablePath: VSCODE,
	args: [
		os.homedir() + "/prime-agent-vs-ext",
		`--user-data-dir=${profile}`,
		`--extensions-dir=${path.join(os.homedir(), ".vscode/extensions")}`,
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
			try {
				if (await frame.evaluate(() => !!document.querySelector(".chat-root .brand-name"))) return frame;
			} catch {}
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
if (!frame) { console.log("NO CHAT FRAME"); process.exit(1); }

// resume the INACTIVE "Count from 1 to 50" session (title = workspace, firstPrompt known)
await frame.locator('button[title="Sessions in this workspace"]').click();
await page.waitForTimeout(2000);
const idx = await frame.locator(".history-item").evaluateAll((els) =>
	els.findIndex((el) => el.textContent.includes("Count from 1")),
);
console.log("resume target index:", idx);
await frame.locator(".history-item").nth(idx).click();
await page.waitForTimeout(7000);
let state = await frame.evaluate(() => ({
	rows: document.querySelectorAll(".messages .row").length,
	notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent.slice(0, 120)),
	stick: document.querySelector(".live-label")?.textContent,
}));
console.log("AFTER RESUME INACTIVE:", JSON.stringify(state));
await page.screenshot({ path: "test/e2e-shots/probe-resume-inactive.png" });

// now prompt instrumented
const ta = frame.locator(".composer-card textarea");
await ta.click();
await ta.fill("Reply with exactly: PONG");
await page.keyboard.press("Enter");
await page.waitForTimeout(8000);
state = await frame.evaluate(() => ({
	rows: document.querySelectorAll(".messages .row").length,
	notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent.slice(0, 120)),
	working: !!document.querySelector(".working-row"),
	live: document.querySelector(".live-label")?.textContent,
}));
console.log("AFTER PROMPT 8s:", JSON.stringify(state));
await page.waitForTimeout(12000);
state = await frame.evaluate(() => ({
	rows: document.querySelectorAll(".messages .row").length,
	notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent.slice(0, 120)),
	working: !!document.querySelector(".working-row"),
	lastText: document.querySelector(".messages .row:last-child .md")?.textContent?.slice(0, 80) ?? null,
}));
console.log("AFTER PROMPT 20s:", JSON.stringify(state));
await page.screenshot({ path: "test/e2e-shots/probe-prompt.png" });
await app.close().catch(() => {});
fs.rmSync(profile, { recursive: true, force: true });
