/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL of the Colyseus backend, e.g. ws://localhost:2567 */
  readonly VITE_SERVER_URL?: string;
}
