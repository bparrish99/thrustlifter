// Screenshots of Level 2 (Deep Caverns): a zoomed-out overview plus in-cave views.
// Usage: node scripts/shot-caverns.mjs  -> shots/cav-*.png
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = `${homedir()}/.cache/ms-playwright`;
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
    const exe = `${root}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`;
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const server = await createServer({ server: { port: 5198, strictPort: true }, logLevel: 'error' });
await server.listen();
mkdirSync('shots', { recursive: true });
const browser = await chromium.launch({ executablePath: findChrome() });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5198/');
await page.waitForTimeout(500);
await page.keyboard.press('Digit2');
await page.keyboard.press('KeyH');
await page.waitForTimeout(300);

// Park the heli somewhere (pinned) and frame it.
async function at(name, x, y, viewHeight, setup = '') {
  await page.evaluate(([x, y, vh, setup]) => {
    const g = window.game;
    g.cfg.viewHeight = vh;
    g.heli.landed = false;
    g.turrets.forEach((t) => (t.cooldown = 99)); // hold fire for clean shots
    // eslint-disable-next-line no-new-func
    new Function('g', setup)(g);
    clearInterval(window.__pin);
    window.__pin = setInterval(() => {
      g.heli.pos = { x, y };
      g.heli.vel = { x: 0, y: 0 };
      g.heli.throttle = 0.5;
      g.turrets.forEach((t) => (t.cooldown = 99));
    }, 5);
  }, [x, y, viewHeight, setup]);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `shots/cav-${name}.png` });
}

await at('1-overview', 2200, 1300, 3100);
await at('2-orb-chamber', 1000, 1250, 900);
await at('3-carry-passage', 1550, 1262, 900, `g.orb.attached = true; g.orb.pos = { x: 1540, y: 1388 };`);
await at('4-drop-shaft', 2025, 1650, 900, `g.orb.attached = true; g.orb.pos = { x: 2025, y: 1776 };`);
await at('5-lower-tunnel', 2600, 1800, 900, `g.orb.attached = true; g.orb.pos = { x: 2590, y: 1926 };`);
await at('6-bowl-chamber', 3720, 1650, 900, `g.orb.attached = true; g.orb.pos = { x: 3715, y: 1776 };`);
await at('7-exit-open', 4090, 1250, 900, `g.orb.attached = false; g.orb.pos = { x: -99999, y: -99999 }; g.level.gates[1].open = true;`);
await at('8-turret-closeup', 1150, 420, 500);

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
await server.close();
