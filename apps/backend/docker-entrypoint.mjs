/**
 * The container's entry point. Starts as root only because Fly mounts the
 * data volume owned by root: hands its directory to the `node` user, drops to
 * that user for good, then starts the server in this same process (so it
 * still gets the platform's shutdown signals).
 */
import { chownSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const dataDir = dirname(process.env.DB_FILE ?? "/data/ligma.db");
const [, , uid, gid] = readFileSync("/etc/passwd", "utf8").split("\n").find((line) => line.startsWith("node:")).split(":").map(Number);

mkdirSync(dataDir, { recursive: true });
chownSync(dataDir, uid, gid);
for (const name of readdirSync(dataDir)) { chownSync(join(dataDir, name), uid, gid); }

process.setgroups([gid]);
process.setgid(gid);
process.setuid(uid);

await import("./build/index.js");
