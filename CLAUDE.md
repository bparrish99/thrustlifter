# THRUSTLIFTER

Browser game (TypeScript + Vite, Canvas2D). "Thrust, with a helicopter." Read `DESIGN.md`
first: it records decisions the owner has made. Don't silently change them; raise it if one seems wrong.

The owner directs design and playtests but does not read or edit code. Explain changes in
terms of how the game plays, not implementation.

## Commands
- `npm run dev`: play at http://localhost:5173
- `npm test`: vitest (physics + game-rule tests)
- `npm run typecheck`
- `npm run shots`: headless screenshots of staged moments into `shots/` (gitignored). Use it to check visuals.
- `node scripts/shot-caverns.mjs`: overview and in-cave screenshots of Level 2

## Layout
- `src/config.ts`: every feel tunable (also editable live in-game with **T**, persisted to localStorage)
- `src/physics.ts`: heli geometry, controls, integration, rigid rod constraint (pure, tested)
- `src/game.ts`: game state and rules: collision, landing, pickup, delivery, weapons, particles. Fixed 240 Hz substeps.
- `src/render.ts`: all drawing (faux-vector glow). No game logic.
- `src/input.ts`: keyboard + gamepad → `FrameInput`
- `src/levels/*.json`: level data (polygons, pads, orb, bowl, turrets, gates); play order in `src/levels/index.ts`. Tests check new levels are flyable by walking planned routes for clearance (see the Deep Caverns tests).
- `src/audio.ts`: procedural rotor sound and event sound effects (game pushes `GameEvent`s; `main.ts` drains them each frame)

Conventions: y points down; tilt > 0 = rotor tilted right; `window.game` is exposed for console poking and the screenshot script.
