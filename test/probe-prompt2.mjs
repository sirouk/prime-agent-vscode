import { _electron as electron } from "playwright";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pa-probe-prompt-"));
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

const ta = frame.locator(".composer-card textarea");
await ta.click();
await ta.fill("Reply with exactly: OMEGA-42. Do not use any tools.");
await page.keyboard.press("Enter");
for (let t = 0; t <= 150; t += 10) {
	await page.waitForTimeout(t === 0 ? 2000 : 10000);
	const st = await frame.evaluate(() => ({
		rows: document.querySelectorAll(".messages .row").length,
		working: !!document.querySelector(".working-row"),
		notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent.slice(0, 100)),
		live: document.querySelector(".live-label")?.textContent,
		ta: document.querySelector(".composer-card textarea")?.value,
	}));
	console.log(`t+${t + 2}s`, JSON.stringify(st));
	if (st.rows > 0 && !st.working) break;
}
await page.screenshot({ path: "test/e2e-shots/probe-prompt2.png" });
await app.close().catch(() => {});
fs.rmSync(profile, { recursive: true, force: true });
