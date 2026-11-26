import { Game } from './game';
import { Input } from './input';
import { LEVELS, LEVEL_FILES } from './levels';
import { Editor } from './editor/editor';
import { Renderer } from './render';
import { Sound } from './audio';
import { createTuningPanel } from './tuning';

const canvas = document.getElementById('game') as HTMLCanvasElement;
let levelIndex = 0;
const makeGame = (i: number, carry?: { lives: number; score: number }) =>
  new Game(LEVELS[i], { levelNumber: i + 1, hasNextLevel: i + 1 < LEVELS.length, lives: carry?.lives, score: carry?.score });
let game = makeGame(levelIndex);
const renderer = new Renderer(canvas);
const input = new Input(window);
const sound = new Sound(window);
const tuning = createTuningPanel();
tuning.hide();

const editor = new Editor(canvas, renderer);
/** Flying a level straight from the editor (E goes back to it). */
let testing = false;
editor.onTest = (data) => {
  testing = true;
  paused = false;
  game = new Game(data, { levelNumber: levelIndex + 1 });
  (window as unknown as { game: Game }).game = game;
};
editor.onExit = () => {
  editor.close();
  testing = false;
  game = makeGame(levelIndex);
  (window as unknown as { game: Game }).game = game;
};
// reopen the editor if it was open before a page reload (e.g. after saving a level)
if (editor.resumeSaved()) {
  const i = LEVEL_FILES.indexOf(editor.file ?? '');
  if (i >= 0) levelIndex = i;
}

let last = performance.now();
let paused = false;

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const { game: gi, meta } = input.poll();
  if (meta.toggleEditor) {
    if (editor.active) editor.onExit?.();
    else if (testing) {
      testing = false;
      editor.resume();
    } else editor.open(LEVELS[levelIndex], LEVEL_FILES[levelIndex] ?? null);
  }
  if (meta.toggleTuning) tuning._hidden ? tuning.show() : tuning.hide();
  if (editor.active) {
    editor.frame(dt);
    sound.update(editor.game, true);
    editor.game.events.length = 0;
    requestAnimationFrame(frame);
    return;
  }
  if (meta.pause) paused = !paused;
  if (meta.toggleMute) sound.toggleMute();
  const goTo = testing
    ? -1
    : meta.jumpLevel >= 0 && meta.jumpLevel < LEVELS.length
      ? meta.jumpLevel
      : (game.readyForNext || (meta.nextLevel && game.phase === 'complete')) && game.hasNextLevel
        ? levelIndex + 1
        : -1;
  if (goTo >= 0) {
    // N (next level) carries lives and score over; number-key jumps start fresh
    const carry = meta.jumpLevel < 0 ? { lives: game.lives, score: game.score } : undefined;
    levelIndex = goTo;
    game = makeGame(levelIndex, carry);
    (window as unknown as { game: Game }).game = game;
  }
  renderer.paused = paused;
  if (!paused) game.update(gi, dt);
  renderer.render(game, paused ? 0 : dt);
  if (testing) {
    renderer.withScreen((ctx, w, h) => {
      ctx.font = 'bold 14px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,210,63,0.85)';
      ctx.fillText('TEST FLIGHT  ·  E back to the editor  ·  R restart', w / 2, h - 108);
    });
  }
  sound.update(game, paused);
  for (const e of game.events) sound.play(e, game.heli.pos);
  game.events.length = 0;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// handy for poking at things from the browser console
(window as unknown as { game: Game; sound: Sound }).game = game;
(window as unknown as { sound: Sound }).sound = sound;
(window as unknown as { renderer: Renderer }).renderer = renderer;
(window as unknown as { __editor: Editor; __editorRenderer: Renderer }).__editor = editor;
(window as unknown as { __editorRenderer: Renderer }).__editorRenderer = renderer;
