import { _electron as electron } from "playwright";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pa-probe-resume-"));
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

// history
await frame.locator('button[title="Sessions in this workspace"]').click();
await page.waitForTimeout(2000);
const items = await frame.locator(".history-item").evaluateAll((els) =>
	els.map((el) => ({ text: el.textContent.slice(0, 60), title: el.getAttribute("title") })),
);
console.log("HISTORY ITEMS:", JSON.stringify(items, null, 1));

// click the first item from "Other folders" (has a folder sub-line), else 2nd item
const otherIdx = items.findIndex((i) => i.title && !i.title.includes("prime-agent-vs-ext"));
console.log("resuming other session idx:", otherIdx, JSON.stringify(items[otherIdx]));
await frame.locator(".history-item").nth(otherIdx >= 0 ? otherIdx : 0).click();
await page.waitForTimeout(6000);

const state = await frame.evaluate(() => ({
	rows: document.querySelectorAll(".messages .row").length,
	notices: [...document.querySelectorAll(".notice")].map((n) => n.className + "|" + n.textContent.slice(0, 160)),
	sessionTitle: document.querySelector(".session-title")?.textContent ?? "",
	status: document.querySelector(".live-label")?.textContent ?? "",
	connDot: document.querySelector(".conn-dot")?.className ?? "",
}));
console.log("AFTER RESUME:", JSON.stringify(state, null, 1));
await page.screenshot({ path: "test/e2e-shots/probe-resume.png" });
await app.close().catch(() => {});
fs.rmSync(profile, { recursive: true, force: true });
