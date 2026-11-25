// Headless screenshots of a few staged moments, for checking visuals.
// Usage: node scripts/shot.mjs   -> writes PNGs to ./shots/
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
mkdirSync('shots', { recursive: true });

// Use CHROME_PATH, else any cached Playwright headless shell, else Playwright's default.
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
const browser = await chromium.launch({ executablePath: findChrome() });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto('http://localhost:5199/');
await page.waitForTimeout(800);
await page.screenshot({ path: 'shots/1-start.png' });

// Fly with the orb on the rod, tilted, mid-swing.
await page.evaluate(() => {
  const g = window.game;
  const o = g.orb;
  g.heli.landed = false;
  g.heli.throttle = 0.9;
  g.heli.pos = { x: o.home.x + 40, y: o.home.y - 260 };
  g.heli.tilt = g.heli.tiltTarget = 0.4;
  o.attached = true;
  o.pos = { x: g.heli.pos.x - 70, y: g.heli.pos.y + 100 };
  g.heli.vel = { x: 120, y: -20 };
  o.vel = { x: 200, y: -40 };
});
await page.keyboard.down('ArrowUp');
await page.keyboard.down('KeyZ');
await page.waitForTimeout(350);
await page.screenshot({ path: 'shots/2-carrying.png' });
await page.keyboard.up('KeyZ');
await page.keyboard.up('ArrowUp');

// Crash.
await page.evaluate(() => {
  const g = window.game;
  g.heli.vel = { x: 0, y: 900 };
});
await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/3-crash.png' });

// Orb bowl approach with the orb on the rod, plus tuning panel.
await page.keyboard.press('KeyR');
await page.keyboard.press('KeyT');
await page.evaluate(() => {
  const g = window.game;
  const b = g.level.bowl;
  g.heli.landed = false;
  g.heli.throttle = 0;
  g.heli.pos = { x: b.cx - 30, y: b.rimY - 200 };
  g.heli.vel = { x: 0, y: 0 };
  g.orb.attached = true;
  g.orb.pos = { x: b.cx - 30, y: b.rimY - 200 + 16 + 110 };
  g.orb.vel = { x: 0, y: 0 };
});
await page.waitForTimeout(250);
await page.screenshot({ path: 'shots/4-bowl-tuning.png' });

// Close-ups of the helicopter: hovering at full rotor, then flipped and tilted.
await page.keyboard.press('KeyR');
await page.keyboard.press('KeyT');
await page.keyboard.press('KeyH');
await page.evaluate(() => {
  const g = window.game;
  g.cfg.viewHeight = 260;
  g.heli.landed = false;
  g.heli.pos = { x: 1300, y: 500 };
  g.heli.vel = { x: 0, y: 0 };
  g.heli.tilt = g.heli.tiltTarget = 0.2;
});
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(700);
await page.screenshot({ path: 'shots/5-closeup-thrust.png' });
await page.keyboard.up('ArrowUp');
await page.evaluate(() => {
  const g = window.game;
  g.heli.facing = -1;
  g.heli.pos = { x: 1300, y: 500 };
  g.heli.vel = { x: 0, y: 0 };
  g.heli.tilt = g.heli.tiltTarget = 0.35;
});
await page.waitForTimeout(300);
await page.screenshot({ path: 'shots/6-closeup-flipped-idle.png' });
await page.evaluate(() => {
  const g = window.game;
  g.cfg.viewHeight = 600;
  g.heli.vel = { x: 60, y: 600 };
  g.heli.pos = { x: 1300, y: 780 };
});
await page.waitForTimeout(700);
await page.screenshot({ path: 'shots/7-debris.png' });
await page.evaluate(() => { window.game.cfg.viewHeight = 900; });

// Turret charging up and firing at the heli (heli pinned in place for the shot).
await page.keyboard.press('KeyR');
await page.evaluate(() => {
  const g = window.game;
  g.cfg.viewHeight = 560;
  g.heli.landed = false;
  g.turrets[0].cooldown = 0.9;
  const pin = setInterval(() => {
    g.heli.pos = { x: 1090, y: 470 };
    g.heli.vel = { x: 0, y: 0 };
    g.heli.throttle = 0.4;
  }, 5);
  setTimeout(() => clearInterval(pin), 1400);
});
await page.waitForTimeout(650);
await page.screenshot({ path: 'shots/8-turret-charge.png' });
await page.waitForTimeout(450);
await page.screenshot({ path: 'shots/9-turret-shot.png' });
await page.waitForTimeout(400);
await page.evaluate(() => { window.game.cfg.viewHeight = 900; });

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
await server.close();
