// First: secrets from the gitignored `.env.local`, before anything reads `process.env`.
import "./localEnv.js";
import {
  defineServer,
  defineRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
  LobbyRoom,
} from "colyseus";
import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The built 3D client (`npm run build -w apps/frontend`). Resolves the same from
 * `src/` (tsx) and `build/` (compiled), both one level below `apps/backend`.
 */
const FRONTEND_DIST = process.env.FRONTEND_DIST
  ?? fileURLToPath(new URL("../../frontend/dist", import.meta.url));

/**
 * Import your Room files
 */
import { MyRoom } from "./rooms/MyRoom.js";
import { RankedQueueRoom } from "./rooms/RankedQueueRoom.js";
import { signInEndpoints } from "./accounts/oauth.js";

const server = defineServer({

  /**
   * Define your room handlers:
   */
  rooms: {
    // Quick Play (`joinOrCreate`): only into a Quick Play room of the same mode, the fullest first.
    // Matched against the room's metadata, so a room made from the browser (`quickPlay: false`) is never picked.
    my_room: defineRoom(MyRoom).enableRealtimeListing().filterBy(["mode", "quickPlay"]).sortBy({ clients: -1 }),
    lobby: defineRoom(LobbyRoom),
    // One queue for everyone: being in it is searching. It makes ranked `my_room`s itself.
    ranked_queue: defineRoom(RankedQueueRoom),
  },

  /**
   * Experimental: Define API routes. Built-in integration with the "playground" and SDK.
   *
   * Usage from SDK:
   *   client.http.get("/api/hello").then((response) => {})
   *
   */
  routes: createRouter({
    api_hello: createEndpoint("/api/hello", { method: "GET" }, async (ctx) => {
      return { message: "Hello World" };
    }),
    // Sign-in with Discord / Google, for ranked play: `/auth/...`.
    ...signInEndpoints,
  }),

  /**
   * Bind your custom express routes here:
   * Read more: https://expressjs.com/en/starter/basic-routing.html
   */
  express: (app) => {

    // Liveness probe for the host's health checks (see fly.toml).
    app.get("/hi", (_, res) => {
      res.send("ok");
    });

    /**
     * Use @colyseus/monitor
     * If you expose it in production, make sure to protect it with a password:
     * https://docs.colyseus.io/tools/monitoring#password-protection
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
    }

    /**
     * Use @colyseus/playground
     * (It is not recommended to expose this route in a production environment)
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/", playground());
    }

    /**
     * In production the game client is served from this same origin, so the
     * page and its WebSocket share one host, one port and one TLS certificate.
     */
    if (process.env.NODE_ENV === "production" && existsSync(FRONTEND_DIST)) {
      app.use(express.static(FRONTEND_DIST));
    }
  }
});

export default server;

