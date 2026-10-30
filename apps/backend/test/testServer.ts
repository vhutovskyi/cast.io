import { boot, type ColyseusTestServer } from "@colyseus/testing";
import appConfig from "../src/app.config.js";

let server: Promise<ColyseusTestServer<typeof appConfig>> | undefined;

/**
 * The one test server for the whole run, booted on first use: @colyseus/testing
 * (0.18) can't boot another in the same process once one has shut down.
 */
export function testServer() {
  return server ??= boot(appConfig);
}

// A root hook: once every file's tests are done. Rooms are torn down first: a shutdown alone
// would play out a ranked match still under way, as a deploy does.
after(async () => {
  if (!server) { return; }
  const colyseus = await server;
  await colyseus.cleanup();
  await colyseus.shutdown();
});
