# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ligma is a 3D browser multiplayer magic-battle game: each player picks an element (fire, water, earth, wind), each element has a kit of four skills, and players fight in rooms they create or browse (no auto-matchmaking). It's an npm-workspaces monorepo:

- `apps/backend`: authoritative Colyseus 0.18 server (`@ligma/backend`)
- `apps/frontend`: Vite + Three.js first-person client (`@ligma/frontend`)

Colyseus 0.18 APIs (`defineServer`, `defineRoom`, `defineInput`, `setFixedTimestep`, `Rewind`, `@colyseus/sdk`) differ from older versions. Check docs.colyseus.io before writing Colyseus code instead of relying on memory.

## Commands

Run these from the repo root (Node >= 22):

```bash
npm start                          # backend in watch mode (tsx) on :2567, with /monitor and the playground
npm run dev -w apps/frontend       # Vite client on :3000 (second terminal)
npm test                           # all backend mocha tests
npm run typecheck                  # tsc --noEmit for both workspaces
npm run build                      # build both (frontend -> apps/frontend/dist, backend -> apps/backend/build)
npm run prod                       # build, then (re)start a detached production server on :2570 (log: /tmp/ligma-2570.log)
npm run prod:fly                   # typecheck + deploy to Fly.io (app "cast-io", see fly.toml / Dockerfile)
```

To run one test file or one test (run from `apps/backend`):

```bash
cd apps/backend && npx mocha -r tsx test/fireball.test.ts --exit --timeout 15000
cd apps/backend && npx mocha -r tsx 'test/**.test.ts' --exit --timeout 15000 -g "some test name"
```

There is no linter configured.

### Local servers

The user usually plays on the **production build at localhost:2570**, not on the Vite dev page. In production the backend serves `apps/frontend/dist` from the same origin. After any backend change, run `npm run prod` so the :2570 server picks it up. Otherwise the rebuilt client sends messages the old server doesn't know, and players get kicked with 4002 ("onMessage not registered").

## Architecture

### Shared code: the frontend imports backend source

`apps/backend/package.json` exports `"./*": "./src/*.ts"`, so the frontend imports backend modules directly, e.g. `@ligma/backend/shared/messages` or `@ligma/backend/skills/leap/leapConfig`. It uses this for types, constants, message names, and the client-side prediction code. Anything under `backend/src/shared/` and every `*Config.ts` is bundled into the client, so these files **must stay pure**: no Colyseus server imports, no clocks, no randomness, no I/O.

Import style differs by side. Backend files use NodeNext ESM with `.js` extensions (`"../shared/skills.js"`). Frontend files use extensionless imports. Backend `tsconfig` has `strictNullChecks: false`.

### Simulation and netcode

- The server is authoritative and simulates on an x/y plane with z up. The client maps that to Three.js space. At yaw 0, forward is -y.
- `MyRoom` (`backend/src/rooms/MyRoom.ts`) is the only room type (`my_room`, plus a `lobby` `LobbyRoom` for the live room list). It runs `setFixedTimestep` at `TICK_RATE`, and each step advances exactly one fixed `dt`.
- Each client sends a flat `MoveInput` through `defineInput`, which sanitises every field. `InputPacer` feeds inputs into the steps at a steady pace. `shared/movement.ts` (`stepEntity`) is the one movement function that both the server and the client's reconciler run, so client prediction and the server agree only while it stays deterministic.
- Skill presses that **move the caster** (leap, skyfall, burrow) travel inside the input as `MoveInput.act` (`shared/actions.ts`), not as messages. That way the server applies them on the exact step the client predicted. `frontend/src/net/actionPrediction.ts` predicts them on the client, and `MyRoom.test.ts` runs that client code against the real server.
- Every other skill casts with its own message. All message names live in `shared/messages.ts` (`CLIENT_MESSAGE` / `SERVER_MESSAGE`).
- Lag compensation: `Rewind` keeps recent positions. Skills call `seenBy` / `lagOf` / `seenAgo` to judge hits by what the caster saw (up to `MAX_REWIND_MS`).
- Health only goes down through `MyRoom.damage()`. A hit that has a `source` also applies that ability's on-hit status effects.

### Skills: one folder per skill on each side

`shared/skills.ts` is the registry. It holds `SKILL_IDS`, the four `SKILL_SLOTS` (main, second, third, ultimate; keys bind to slots, not skills), and `ELEMENT_KITS`, which maps each element to its skills. The server checks `hasSkill` on every cast.

For skill `foo`:

- `backend/src/skills/foo/fooConfig.ts`: tuning numbers, payload types, and pure geometry/math helpers. Both sides import it.
- `backend/src/skills/foo/foo.ts`: a `FooSkill` class that implements `ServerSkill` (`remove`, `reset`, and optionally `step` and `afterInput`). It receives a `SkillRoom` (`skills/skillRoom.ts`), the narrow slice of the room a skill may touch. It never gets the room itself.
- `frontend/src/skills/foo/foo.ts`: a `FooController` that implements `SlotSkill` (input routing) and `ArenaSkillController` (per-frame `update(ArenaFrame)`, `reset`, `dispose`).
- `frontend/src/skills/foo/fooIcon.ts`: an SVG icon.
- `backend/test/foo.test.ts`: unit tests against a hand-built fake `SkillRoom` (real `MyRoomState`, a hand-moved clock, recorded broadcasts and damage). They open no port, so they're fast and can run in parallel.

A new skill also needs wiring in several shared places: `SKILL_IDS` and a kit, `CLIENT_MESSAGE`/`SERVER_MESSAGE`, the construction and `messages` handler in `MyRoom`, `frontend/src/skills/catalog.ts` (name, hint, icon), and the controller in `frontend/src/arena/playArena.ts`. If it adds status effects, add them to `effects/effectConfig.ts`. If it moves the caster, add it to `shared/actions.ts` and `actionPrediction.ts`.

When several skills are built at once, lay this shared wiring down first. Then each skill's work only touches its own folders and test file.

### Status effects, zones, and modes

- `effects/effectConfig.ts` defines effects in `EFFECTS`: duration, damage scale, DoT, speed scale, no-cast, and so on. `ABILITY_EFFECTS` lists what each ability applies on hit. `statusEffects.ts` runs them, and `groundZones.ts` handles areas that apply effects to whoever stands in them.
- `modes/` holds the game modes (`freeForAll`, `duel`, `battleRoyale`), which implement `GameMode`. They get a `ModeRoom` slice. The mode owns the rules (spawns, deaths, rounds, `canDamage`), and `MyRoom` owns the simulation. Mode settings and limits live in `shared/gameModes.ts`.
- `shared/maps.ts` + `shared/terrain.ts` define the maps and heightmap ground (`groundHeight`). `shared/obstacles.ts` holds the collision shapes.

### Frontend layout

`main.ts` runs the lobby (room list from the `lobby` room, element picker, key settings) and calls `arena/playArena.ts` when the player joins a room. `playArena` builds every skill controller, routes keyboard and mouse input to slots, and drives the per-frame update. `render/` holds the Three.js scene and effects, `hud/` the DOM HUD, and `net/` the client, prediction, and remote-player smoothing.

## Working in this repo

Other Claude sessions often edit this working tree at the same time. Never run `git stash`, `git checkout -- .`, or `git reset`. To compare against a baseline, use `git worktree add /tmp/...`. Expect unrelated modified files or failing tests that belong to another session, and leave them alone.
