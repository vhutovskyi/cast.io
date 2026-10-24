import { ColyseusSDK } from "@colyseus/sdk";
import type { default as server } from "@ligma/backend/app.config";

// In dev the backend runs on its own port; in production the backend serves
// this page, so the WebSocket lives on the same origin.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? (import.meta.env.DEV
  ? "ws://localhost:2567"
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);

// The backend package is a *type-only* dependency for `server`: it checks room
// names and options at compile time; none of the server ends up in the bundle.
export const client = new ColyseusSDK<typeof server>(SERVER_URL);
