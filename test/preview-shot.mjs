import { chromium } from "playwright";

const browser = await chromium.launch();
const scenario = process.argv[2];
for (const [mode, file, height] of scenario
	? [[scenario, `preview-${scenario}.png`, scenario === "modelmenu" ? 560 : 760]]
	: [
			["chat", "preview-chat.png", 760],
			["welcome", "preview-welcome.png", 560],
			["modelmenu", "preview-modelmenu.png", 560],
			["history", "preview-history.png", 560],
		]) {
	const page = await browser.newPage({ viewport: { width: 420, height } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`file://${process.cwd()}/media/preview.html?mode=${mode}`);
	await page.waitForTimeout(700);
	await page.screenshot({ path: `test/${file}` });
	if (errors.length) console.log(`[${mode}] page errors:`, errors);
	else console.log(`[${mode}] ok -> test/${file}`);
	await page.close();
}
await browser.close();
