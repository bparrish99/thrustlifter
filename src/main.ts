import { Game, type SaveState } from './game';
import { Input, firstGamepad } from './input';
import { LEVELS, LEVEL_FILES } from './levels';
import { Editor } from './editor/editor';
import { Renderer } from './render';
import { Sound } from './audio';
import { createTuningPanel } from './tuning';
import { Menu } from './menu';
import { ACTIONS, bindings, keyName, padName } from './bindings';

/**
 * Developer tools (level editor E, tuning panel T, number keys 1-9 to jump levels) exist only when
 * running the dev server. A deployed build (`npm run build`) has none of them: players get the
 * front page, where they pick the starting level.
 */
const DEV = import.meta.env.DEV;

const canvas = document.getElementById('game') as HTMLCanvasElement;
let levelIndex = 0;
const makeGame = (i: number, carry?: { score: number }) =>
  new Game(LEVELS[i], { levelNumber: i + 1, hasNextLevel: i + 1 < LEVELS.length, finalLevel: i + 1 === LEVELS.length, score: carry?.score, tutorial: i === 0 });
let game = makeGame(levelIndex);
const renderer = new Renderer(canvas);
const input = new Input(window);
const sound = new Sound(window);
const tuning = DEV ? createTuningPanel() : null;
tuning?.hide();
/** Dev: just loaded a save state; the game waits for a control before it runs. */
let loadHold = false;
const setGame = (g: Game) => {
  game = g;
  loadHold = false;
  (window as unknown as { game: Game }).game = game;
};

// ---------------------------------------------------------------- front page

const menu = new Menu(LEVELS.map((l) => l.name));
menu.onListening = (on) => (input.suspended = on);
/** Behind the front page: the picked level, idling (no HUD, no intro message). */
const showBackdrop = (i: number) => {
  setGame(makeGame(i));
  game.message = null;
  renderer.showHud = false;
};
menu.onPlay = (i) => {
  levelIndex = i;
  setGame(makeGame(i));
  renderer.showHud = true;
  paused = false;
  input.flush();
};
let backdropLevel = -1;

/** Back to the front page (from the pause screen). */
function quitToTitle(): void {
  paused = false;
  testing = false;
  menu.level = levelIndex;
  menu.show('title');
}

// ---------------------------------------------------------------- level editor (dev only)

const editor = new Editor(canvas, renderer);
/** Flying a level straight from the editor (E goes back to it). */
let testing = false;
editor.onTest = (data) => {
  testing = true;
  paused = false;
  // test-flying level 1 shows its tutorial hints too
  setGame(new Game(data, { levelNumber: levelIndex + 1, tutorial: editor.file !== null && editor.file === LEVEL_FILES[0] }));
};
editor.onExit = () => {
  editor.close();
  // leaving the editor plays the level you were editing, if it's in the game
  const i = LEVEL_FILES.indexOf(editor.file ?? '');
  if (i >= 0) levelIndex = i;
  testing = false;
  setGame(makeGame(levelIndex));
};
// dev: reopen the editor if it was open before a page reload (e.g. after saving a level), or skip
// the front page with ?play (the screenshot scripts use this)
if (DEV && editor.resumeSaved()) {
  const i = LEVEL_FILES.indexOf(editor.file ?? '');
  if (i >= 0) levelIndex = i;
  menu.hide();
} else if (DEV && new URLSearchParams(location.search).has('play')) {
  menu.hide();
}

// ---------------------------------------------------------------- F: fullscreen (fixed key, not remappable)
// Handled right in the key event: browsers only allow fullscreen from a real key press or click
// (so a gamepad button can't do it). F means "frame all" in the editor, and if the player has bound F
// to an action on the Controls screen, their binding wins.
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyF' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (editor.active || input.suspended) return;
  if (Object.values(bindings).some((b) => b.keys.includes('KeyF'))) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => {});
});

// ---------------------------------------------------------------- pause screen: Q (or gamepad Y) quits to the title

let quitRequested = false;
/** Esc on a mission-complete screen goes back to the title (whatever key pause is bound to). */
let escRequested = false;
addEventListener('keydown', (e) => {
  if (paused && !menu.open && e.code === 'KeyQ') quitRequested = true;
  if (!menu.open && e.code === 'Escape') escRequested = true;
});
let prevY = false;
let prevB = false;

function drawPauseExtras(): void {
  renderer.withScreen((ctx, w, h) => {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 16px ui-monospace, Menlo, Consolas, monospace';
    const lines = ACTIONS.map((a) => {
      const b = bindings[a.id];
      const keys = b.keys.filter(Boolean).map(keyName).join(' / ') || '—';
      const pad = b.pad >= 0 ? `   ·   ${padName(b.pad)}` : '';
      return `${a.label.toUpperCase()}:  ${keys}${pad}`;
    });
    const y0 = h / 2 + 70;
    ctx.fillStyle = 'rgba(207,233,255,0.8)';
    lines.forEach((l, i) => ctx.fillText(l, w / 2, y0 + i * 22));
    ctx.fillStyle = '#ffd23f';
    ctx.fillText(`${keyName(bindings.pause.keys[0]) || 'ESC'} RESUME   ·   Q QUIT TO TITLE   ·   F FULLSCREEN${firstGamepad() ? '   ·   GAMEPAD: START RESUME, Y QUIT' : ''}`, w / 2, y0 + lines.length * 22 + 20);
    ctx.restore();
  });
}

// ---------------------------------------------------------------- main loop

let last = performance.now();
/** Dev save state (F2 saves, F4 loads; any number of times). Lives in memory: a page reload clears it. */
let savedState: SaveState | null = null;
/** Dev: small confirmation line at the top of the screen. */
let devNote: { text: string; t: number } | null = null;
let paused = false;

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (menu.open) {
    menu.frame();
    if (backdropLevel !== menu.level) {
      backdropLevel = menu.level;
      showBackdrop(menu.level);
    }
    const { meta: m } = input.poll(); // keep key state fresh, but the game doesn't act on it
    // dev tools work from the front page too: E edits the level picked there, T toggles tuning
    if (DEV && m.toggleTuning && tuning) tuning._hidden ? tuning.show() : tuning.hide();
    if (DEV && m.toggleEditor) {
      levelIndex = menu.level;
      menu.hide();
      renderer.showHud = true;
      editor.open(LEVELS[levelIndex], LEVEL_FILES[levelIndex] ?? null);
      requestAnimationFrame(frame);
      return;
    }
    renderer.paused = false;
    renderer.render(game, dt);
    sound.update(game, true);
    game.events.length = 0;
    requestAnimationFrame(frame);
    return;
  }
  backdropLevel = -1;

  const { game: gi, meta } = input.poll();
  if (DEV && meta.toggleEditor) {
    if (editor.active) editor.requestExit();
    else if (testing) {
      testing = false;
      editor.resume();
    } else editor.open(LEVELS[levelIndex], LEVEL_FILES[levelIndex] ?? null);
  }
  if (DEV && meta.toggleTuning && tuning) tuning._hidden ? tuning.show() : tuning.hide();
  if (editor.active) {
    escRequested = false; // Esc belongs to the editor here
    editor.frame(dt);
    sound.update(editor.game, true);
    editor.game.events.length = 0;
    requestAnimationFrame(frame);
    return;
  }
  // the end of the game (last level's results, tally finished): Esc, the pause button, or gamepad B
  // goes back to the title, since nothing else happens there. Anywhere else, pause just pauses (it
  // used to quit to the title on every mission-complete screen, throwing the run away).
  const padNow = firstGamepad();
  const bNow = !!padNow?.buttons[1]?.pressed;
  const bHit = bNow && !prevB;
  prevB = bNow;
  const esc = escRequested;
  escRequested = false;
  if (game.phase === 'complete' && !game.hasNextLevel && game.tally?.stage === 'done' && !testing && !paused && (esc || meta.pause || bHit)) {
    quitToTitle();
    requestAnimationFrame(frame);
    return;
  }
  if (meta.pause) paused = !paused;
  if (meta.toggleMute) sound.toggleMute();
  const pad = firstGamepad();
  const yNow = !!pad?.buttons[3]?.pressed;
  if (paused && yNow && !prevY) quitRequested = true;
  prevY = yNow;
  if (quitRequested) {
    quitRequested = false;
    if (paused) {
      quitToTitle();
      requestAnimationFrame(frame);
      return;
    }
  }
  const jump = DEV ? meta.jumpLevel : -1;
  const goTo = testing
    ? -1
    : jump >= 0 && jump < LEVELS.length
      ? jump
      : (game.readyForNext || (meta.nextLevel && game.phase === 'complete')) && game.hasNextLevel
        ? levelIndex + 1
        : -1;
  if (goTo >= 0) {
    // N (next level) carries the score over; number-key jumps start fresh
    const carry = jump < 0 ? { score: game.score } : undefined;
    levelIndex = goTo;
    setGame(makeGame(levelIndex, carry));
  }
  if (DEV && meta.saveState && game.alive) {
    savedState = game.saveState();
    devNote = { text: 'STATE SAVED', t: 1.2 };
  }
  if (DEV && meta.loadState) {
    if (savedState && game.loadState(savedState)) {
      paused = false;
      renderer.snapCamera();
      input.flush(); // keys held when you loaded don't carry into the restored moment
      gi.rotor = gi.dive = gi.tiltAxis = 0;
      loadHold = true;
    } else devNote = { text: savedState ? 'SAVED STATE IS FROM ANOTHER LEVEL' : 'NO SAVED STATE (F2 TO SAVE)', t: 1.6 };
  }
  // after a load, everything stays frozen (momentum and all) until you touch a flight control
  if (loadHold && (gi.restart || gi.rotor > 0 || gi.dive > 0 || gi.tiltAxis !== 0 || gi.fire || gi.flip || gi.pickup)) {
    loadHold = false;
    devNote = { text: 'STATE LOADED', t: 0.6 };
  }
  if (loadHold) devNote = { text: 'STATE LOADED  ·  FROZEN UNTIL YOU TOUCH A CONTROL', t: 1 };
  const frozen = paused || loadHold;
  renderer.paused = paused;
  if (!frozen) game.update(gi, dt);
  renderer.render(game, frozen ? 0 : dt);
  if (paused) drawPauseExtras();
  if (testing) {
    renderer.withScreen((ctx, w, h) => {
      ctx.font = 'bold 14px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,210,63,0.85)';
      ctx.fillText('TEST FLIGHT  ·  E back to the editor  ·  R restart', w / 2, h - 30);
    });
  }
  if (devNote) {
    const n = devNote;
    n.t -= dt;
    if (n.t <= 0) devNote = null;
    else
      renderer.withScreen((ctx, w) => {
        ctx.font = 'bold 14px ui-monospace, Menlo, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = `rgba(255,210,63,${Math.min(1, n.t * 2) * 0.9})`;
        ctx.fillText(n.text, w / 2, 60);
      });
  }
  sound.update(game, frozen);
  for (const e of game.events) sound.play(e, game.heli.pos);
  game.events.length = 0;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// handy for poking at things from the browser console
(window as unknown as { game: Game; sound: Sound }).game = game;
(window as unknown as { sound: Sound }).sound = sound;
(window as unknown as { renderer: Renderer }).renderer = renderer;
(window as unknown as { menu: Menu }).menu = menu;
(window as unknown as { __editor: Editor; __editorRenderer: Renderer }).__editor = editor;
(window as unknown as { __editorRenderer: Renderer }).__editorRenderer = renderer;
