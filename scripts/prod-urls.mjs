// Prints where the production server (`npm run prod`) can be reached: this
// machine, the local network, and the ngrok tunnel if one is running.
import { networkInterfaces } from "node:os";

const PORT = process.env.PORT ?? "2570";

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((net) => net && net.family === "IPv4" && !net.internal)
  .map((net) => `http://${net.address}:${PORT}`);

/** The public URL of an ngrok tunnel to our port, from ngrok's local API; null when none runs. */
async function ngrokUrl() {
  try {
    const response = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(1000) });
    const { tunnels } = await response.json();
    return tunnels.find((tunnel) => tunnel.config?.addr?.endsWith(`:${PORT}`))?.public_url ?? null;
  } catch {
    return null;
  }
}

const tunnel = await ngrokUrl();

console.log("Ligma prod is running:");
console.log(`  Local:    http://localhost:${PORT}`);
for (const url of lan) { console.log(`  Network:  ${url}`); }
console.log(`  Internet: ${tunnel ?? `not tunnelled (run: ngrok http ${PORT})`}`);
console.log("  Logs:     /tmp/ligma-2570.log");
