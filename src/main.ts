import { Game } from './game';
import { Input } from './input';
import { LEVELS } from './levels';
import { Renderer } from './render';
import { Sound } from './audio';
import { createTuningPanel } from './tuning';

const canvas = document.getElementById('game') as HTMLCanvasElement;
let levelIndex = 0;
const makeGame = (i: number) => new Game(LEVELS[i], { levelNumber: i + 1, hasNextLevel: i + 1 < LEVELS.length });
let game = makeGame(levelIndex);
const renderer = new Renderer(canvas);
const input = new Input(window);
const sound = new Sound(window);
const tuning = createTuningPanel();
tuning.hide();

let last = performance.now();
let paused = false;

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const { game: gi, meta } = input.poll();
  if (meta.pause) paused = !paused;
  if (meta.toggleTuning) tuning._hidden ? tuning.show() : tuning.hide();
  if (meta.toggleHelp) renderer.helpVisible = !renderer.helpVisible;
  if (meta.toggleMute) sound.toggleMute();
  const goTo = meta.jumpLevel >= 0 && meta.jumpLevel < LEVELS.length ? meta.jumpLevel : meta.nextLevel && game.phase === 'complete' && game.hasNextLevel ? levelIndex + 1 : -1;
  if (goTo >= 0) {
    levelIndex = goTo;
    game = makeGame(levelIndex);
    (window as unknown as { game: Game }).game = game;
  }
  renderer.paused = paused;
  if (!paused) game.update(gi, dt);
  renderer.render(game, paused ? 0 : dt);
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
