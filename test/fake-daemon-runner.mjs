// Stand-in for `prime-agent --mode daemon --daemon-socket <path>`: binds the fake daemon there and stays up.
import { startFakeDaemon } from "./fake-daemon.mjs";

const flag = process.argv.indexOf("--daemon-socket");
const socketPath = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!socketPath) {
	console.error("no --daemon-socket");
	process.exit(2);
}
await startFakeDaemon({ socketPath });
setInterval(() => {}, 1 << 30);
