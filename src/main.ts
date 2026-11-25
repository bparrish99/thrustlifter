import { Game } from './game';
import { Input } from './input';
import provingGround from './levels/proving-ground.json';
import type { LevelData } from './level';
import { Renderer } from './render';
import { Sound } from './audio';
import { createTuningPanel } from './tuning';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(provingGround as LevelData);
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
  renderer.paused = paused;
  if (!paused) game.update(gi, dt);
  renderer.render(game, paused ? 0 : dt);
  sound.update(game, paused);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// handy for poking at things from the browser console
(window as unknown as { game: Game; sound: Sound }).game = game;
(window as unknown as { sound: Sound }).sound = sound;
