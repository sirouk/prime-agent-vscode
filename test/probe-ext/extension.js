const vscode = require("vscode");
let count = 0;
function activate(context) {
	const provider = new (class {
		resolveWebviewView(view) {
			view.webview.options = { enableScripts: true };
			view.webview.html = `<!DOCTYPE html><html><body>probe<script>
				window.addEventListener("message", (e) => console.info("[probe] webview got:", JSON.stringify(e.data)));
			</script></body></html>`;
			console.info("[probe] webview resolved");
			setInterval(() => {
				count += 1;
				view.webview.postMessage({ n: count }).then((ok) => console.info(`[probe] post n=${count} -> ${ok}`));
			}, 500);
		}
	})();
	context.subscriptions.push(vscode.window.registerWebviewViewProvider("paProbe.view", provider));
}
module.exports = { activate };
