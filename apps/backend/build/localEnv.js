import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
/**
 * Local secrets (OAuth credentials, `JWT_SECRET`) from `apps/backend/.env.local`,
 * which git ignores — unlike the committed `.env.development` / `.env.production`
 * that Colyseus loads. Never overrides what the environment already sets, so on
 * Fly the secrets set there win. Resolves the same from `src/` and `build/`.
 */
const LOCAL_ENV = fileURLToPath(new URL("../.env.local", import.meta.url));
if (existsSync(LOCAL_ENV)) {
    process.loadEnvFile(LOCAL_ENV);
}
