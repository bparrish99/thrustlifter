# THRUSTLIFTER

Browser game (TypeScript + Vite, Canvas2D). "Thrust, with a helicopter." Read `DESIGN.md`
first: it records decisions the owner has made. Don't silently change them; raise it if one seems wrong.

The owner directs design and playtests but does not read or edit code. Explain changes in
terms of how the game plays, not implementation.

## How we work (owner preferences)
- **I run the dev server**, in the background: `npx vite --port 5173 --strictPort`, then give the owner http://localhost:5173. Check first whether one is already running (`ps aux | grep "[v]ite --port 5173"`). Vite hot-reloads, so edits show up live.
- **Tuning:** the owner tunes with the in-game panel (T) and pastes the "copy settings JSON". Bake the values into `DEFAULTS` in `src/config.ts` and report what changed in a table. The browser saves *all* tuning values, so when you deliberately change a default the owner already has saved, add an entry to `MIGRATIONS` in `config.ts` or the change won't reach them.
- **Verify, don't guess:** run `npm test` and `npx tsc --noEmit` after changes, and look at screenshots (`npm run shots`, or a small playwright script in the scratchpad) for anything visual. You can't hear audio, so measure sound levels in the browser and say so.
- **Commit and push only when asked** (remote: github.com/bparrish99/thrustlifter, branch `main`; commits use the owner's GitHub no-reply email).
- **Show, don't tell:** no text on level elements; minimal centre messages (see DESIGN.md). The one exception is the level-1 tutorial hints.
- Keep `DESIGN.md` current with every decision, including what was tried and rejected.

## Builds
- Dev server: everything, including the editor (E), tuning (T), level jumps (1-9). `?play` skips the front page (screenshot scripts use it).
- `npm run build` → `dist/`: the public build, **no editor/tuning/jumps** (gated on `import.meta.env.DEV`). The owner deploys it to Netlify (`netlify.toml`).
- **Deploying:** Netlify (tl.booze-elroy.com) builds only the `release` branch, and each deploy costs the owner credits. Never push to `release` unless the owner says "deploy"; then `git push origin main:release`. Day-to-day pushes go to `main` only.

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
- `src/camera.ts`: the follow camera (framing, smoothing), kept pure so tests can fly it around
- `src/input.ts`: keyboard + gamepad → `FrameInput`, using the remappable `src/bindings.ts` (actions, defaults, saved bindings, key/button names, `controlLabel` for hints)
- `src/menu.ts`: front page (PLAY, starting-level picker, CONTROLS) and the Controls/remapping screen, an HTML overlay
- `src/levels/*.json`: level data (polygons, pads, orb, bowl, turrets, gates, tanks, balloons, survivors, checkpoints); play order in `src/levels/order.json` (index.ts globs the folder; files not in order.json are "shelved": kept and editable, not played). Tests check new levels are flyable by walking planned routes for clearance (see the Deep Caverns tests).
- `src/editor/`: in-game level editor (E). `tools.ts` = pure helpers (snapping, validation, JSON formatting, tight-spot analysis, tested); `editor.ts` = UI. `vite.config.ts` adds dev-only endpoints: `POST /__editor/save` writes level files, `POST /__editor/order` rewrites the play order.
- `src/minimap.ts`: which part of a level the minimap frames (drawn by `drawMinimap` in render.ts)
- `src/tutorial.ts`: first-level hints (which, when, where they point); drawn by `drawTip` in render.ts
- `src/audio.ts`: procedural rotor sound and event sound effects (game pushes `GameEvent`s; `main.ts` drains them each frame)

## Where things stand
- **Live** at tl.booze-elroy.com (Netlify, deploys from the `release` branch only; see Builds). Friends are playing it.
- Five levels in play, all built by the owner in the editor: WELCOME TO THE JUGGLE (tutorial), GOING DOWN, UNWELCOME PARTY, TECHNIQUE, LAYUP (big bowl, lob the orb in). Proving Ground and Deep Caverns are shelved.
- Recently added: front page + remappable controls; editor Join/Cut rock, Clear level, bowl size; overlapping rocks act as one; unbreakable-on-bowl orb; smoothed camera (`camera.ts`); no launch-pad respawn after delivery; solid stocky hostages; glass-break sound.
- Open ideas mentioned but not done: auto-return to the title after the last level (players get no hint after YOU IS WIN); making big bowls soak up bounce if long lobs bounce out too often; gamepad B on mission complete and gamepad menu navigation/rebinding untested with a real pad.
- Milestones and open questions: see `DESIGN.md`.

Conventions: y points down; tilt > 0 = rotor tilted right; `window.game` is exposed for console poking and the screenshot script.
