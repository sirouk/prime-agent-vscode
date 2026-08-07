
const { chromium } = require("playwright");
(async () => {
  let svg = require("fs").readFileSync("media/icon.svg", "utf8");
  svg = svg.replaceAll("#C5C5C5", "#85ED75").replace('width="24"', 'width="560"').replace('height="24"', 'height="560"');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <div style="width:1024px;height:1024px;background:#0f0f0f;border-radius:160px;display:flex;align-items:center;justify-content:center">${svg}</div>
  </body></html>`);
  await page.screenshot({ path: "media/icon.png", omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
  await browser.close();
  console.log("rendered");
})();
