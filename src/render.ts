import { config } from './config';
import { BALLOON_R, COLORS, FUEL_TICKS, POINTS, SHIELD_RADIUS, balloonGun, TANK_H, TANK_W, TURRET_BARREL, TURRET_RADIUS, toWorldPoint, turretCentre, type Game } from './game';
import { clamp, lerp, type Vec } from './math';
import { ANCHOR, BODY, MAST, NOSE, ROTOR_R, ROTOR_Y, SKID, SKID_TOE, SKID_Y, STRUTS, TAIL_ROTOR_HUB, TAIL_ROTOR_R, toWorld } from './physics';

const P = (x: number, y: number): Vec => ({ x, y });
/** Decorative helicopter detail (local space, facing right). Collision shapes are in physics.ts. */
const HELI = {
  boom: [P(-14, -4), P(-44, -4.5), P(-44, -1.5), P(-15, 3)],
  fin: [P(-38, -3.5), P(-46, -13), P(-50, -13), P(-45, -1.5)],
  ventral: [P(-42, -1.5), P(-46, 4)] as [Vec, Vec],
  stab: [P(-36, -0.5), P(-30, 0.5)] as [Vec, Vec],
  hump: [P(-10, -8.5), P(-7, -12), P(6, -12), P(9, -9)],
  canopy: [P(5, -8.6), P(13, -6.2), P(18, -1.5), P(20.4, 3), P(11, 3), P(7, -2)],
  window: [P(-9, -5.5), P(-1, -6.5), P(-1, -0.5), P(-9, -0.5)],
  door: [P(2, -7), P(1, 8)] as [Vec, Vec],
  exhaust: [P(-10, -10), P(-14, -9)] as [Vec, Vec],
  beacon: P(-49, -13.5),
  strobe: P(1, 10.5),
  nav: P(17, 7),
};

interface HeliPalette {
  line: string;
  canopy: string;
  fillTop: string;
  fillBottom: string;
  tailFill: string;
}
const HELI_PLAYER: HeliPalette = { line: COLORS.heli, canopy: '#7ffcff', fillTop: 'rgba(60,44,8,0.95)', fillBottom: 'rgba(14,10,2,0.95)', tailFill: 'rgba(26,18,4,0.95)' };
const HELI_ENEMY: HeliPalette = { line: '#ff3d6e', canopy: '#ffb0c8', fillTop: 'rgba(70,8,24,0.95)', fillBottom: 'rgba(16,2,6,0.95)', tailFill: 'rgba(30,4,10,0.95)' };

const BALLOON_LINE = '#ff3d6e';

const SUPPORTS_FILTER = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

/*
 * "Faux vector": everything is stroked lines drawn several times with additive
 * blending at decreasing widths (fake bloom), plus a white-hot core.
 * Canvas2D for now; the draw calls are isolated here so a WebGL bloom pass
 * can replace this later without touching game logic.
 */

const C = {
  bgTop: '#020109',
  bgBottom: '#120630',
  terrain: '#22e6ff',
  startPad: '#3dff8a',
  bowl: '#ffb020',
  fuelPad: '#ffe14d',
  padEnemy: '#ff3b3b',
  padSafe: '#ffd23f',
  shield: '#7ffcff',
  gate: '#ff3d8b',
  rotor: '#e8f6ff',
  rod: '#ffffff',
  hud: '#9fe8ff',
  far: '#7a3cff',
};

const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private overlay: HTMLCanvasElement | null = null;
  private bloomCanvas: HTMLCanvasElement | null = null;
  private stars: { x: number; y: number; z: number; b: number }[] = [];
  private far: Vec[] = [];
  private terrainPaths: Path2D[] = [];
  private terrainAll: Path2D | null = null;
  private rockPattern: CanvasPattern | null = null;
  private nebula: HTMLCanvasElement | null = null;
  private terrainFor: unknown = null;
  private cam = { x: 0, y: 0, init: false };
  private groundY: number | null = null;
  paused = false;
  private clock = 0;
  private frameDt = 0;
  private fuelNeedle = 1;
  private scorePop = 0;
  private lastScore = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unsupported');
    this.ctx = ctx;
    let seed = 1337;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 260; i++) this.stars.push({ x: rnd(), y: rnd(), z: 0.03 + rnd() * 0.15, b: 0.3 + rnd() * 0.7 });
    let y = 0;
    for (let x = -1500; x <= 3500; x += 60) {
      y = clamp(y + (rnd() - 0.5) * 140, -260, 60);
      this.far.push({ x, y });
    }
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.overlay = this.buildOverlay();
  }

  private buildOverlay(): HTMLCanvasElement {
    const o = document.createElement('canvas');
    o.width = this.canvas.width;
    o.height = this.canvas.height;
    const g = o.getContext('2d')!;
    const vg = g.createRadialGradient(o.width / 2, o.height / 2, o.height * 0.35, o.width / 2, o.height / 2, o.height * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = vg;
    g.fillRect(0, 0, o.width, o.height);
    g.fillStyle = 'rgba(0,0,0,0.13)';
    const step = Math.max(2, Math.round(3 * this.dpr));
    for (let y = 0; y < o.height; y += step) g.fillRect(0, y, o.width, Math.max(1, step / 3));
    return o;
  }

  // -------------------------------------------------------------- frame

  render(game: Game, dt: number): void {
    this.clock += dt;
    this.frameDt = dt;
    const ctx = this.ctx;
    if (this.terrainFor !== game.level) {
      this.buildTerrain(game);
      this.terrainFor = game.level;
      this.cam.init = false;
      this.groundY = null;
    }
    const scale = (this.h / config.viewHeight) * 1;
    this.updateCamera(game, dt, scale);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const bg = ctx.createLinearGradient(0, 0, 0, this.h);
    bg.addColorStop(0, C.bgTop);
    bg.addColorStop(1, C.bgBottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawStars();
    this.drawNebula();

    const shake = game.shake * game.shake * 14;
    const sx = (Math.random() - 0.5) * shake;
    const sy = (Math.random() - 0.5) * shake;

    // distant parallax ridge
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.w / 2, this.h / 2);
    ctx.scale(scale * 0.8, scale * 0.8);
    ctx.translate(-this.cam.x * 0.35, -this.cam.y * 0.25 + 420);
    const ridge = new Path2D();
    this.far.forEach((p, i) => (i ? ridge.lineTo(p.x, p.y) : ridge.moveTo(p.x, p.y)));
    ctx.save();
    const ridgeFill = new Path2D(ridge);
    ridgeFill.lineTo(this.far[this.far.length - 1].x, 2000);
    ridgeFill.lineTo(this.far[0].x, 2000);
    ctx.fillStyle = 'rgba(20,6,50,0.55)';
    ctx.fill(ridgeFill);
    ctx.restore();
    glow(ctx, ridge, C.far, 1.5, 0.35 * config.glow);

    // world
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.w / 2 + sx, this.h / 2 + sy);
    ctx.scale(scale, scale);
    ctx.translate(-this.cam.x, -this.cam.y);

    this.drawBackdrop(game);
    this.drawPedestal(game); // before the rock, so its buried foot is hidden
    this.drawTerrain(game);
    this.drawGates(game);
    this.drawBowl(game);
    this.drawTurrets(game);
    this.drawSurvivors(game);
    this.drawFuelTanks(game);
    this.drawBalloons(game);
    this.drawOrb(game);
    for (const e of game.enemies) {
      this.drawHeliShape(e, HELI_ENEMY);
      if (e.charge > 0) {
        const m = toWorldPoint(e, NOSE);
        dot(this.ctx, m.x, m.y, 1.5 + e.charge * 4, COLORS.enemyShot);
      }
    }
    if (game.alive) this.drawHeli(game);
    if (game.alive && game.shield) this.drawShield(game);
    this.drawProjectiles(game);
    this.drawShards(game);
    this.drawParticles(game);
    this.drawRings(game);

    if (config.glow > 0) this.bloom();
    if (game.screenFlash > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = game.screenFlash * 0.3;
      ctx.fillStyle = '#ffe6c0';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalAlpha = 1;
    }

    // screen-space
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (this.overlay) ctx.drawImage(this.overlay, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawHud(game);
  }

  private updateCamera(game: Game, dt: number, scale: number): void {
    const h = game.heli;
    let tx = h.pos.x + h.vel.x * config.camLookahead;
    const vh = config.viewHeight;
    const base = h.pos.y + h.vel.y * config.camLookahead;

    // Ground under you: the HIGHEST of several probes across a strip, so crossing a gap
    // (shaft mouth) or a cliff edge doesn't make the reading plunge; then eased over time.
    let gy: number | null = null;
    for (const dx of [-110, -55, 0, 55, 110]) {
      const g = game.groundBelow({ x: h.pos.x + dx, y: h.pos.y });
      if (g !== null && g > h.pos.y + 10 && (gy === null || g < gy)) gy = g;
    }
    if (gy !== null) gy = Math.min(gy, h.pos.y + vh * 0.7); // don't chase floors far below
    if (gy !== null) {
      this.groundY = this.groundY === null ? gy : this.groundY + (gy - this.groundY) * (1 - Math.exp(-2.5 * dt));
    } else {
      this.groundY = null;
    }
    const ceil = game.ceilingAbove(h.pos, vh);

    // Frame: put the ground at camGround down the screen. In an enclosed space (floor and
    // ceiling both in view), centre between them instead.
    let ty = this.groundY === null ? base + vh * 0.2 : this.groundY - vh * (config.camGround - 0.5);
    if (ceil !== null && this.groundY !== null && this.groundY - ceil < vh * 0.85) ty = (ceil + this.groundY) / 2;
    if (game.orb.attached) {
      tx = lerp(tx, game.orb.pos.x, 0.3);
      ty = lerp(ty, game.orb.pos.y, 0.25);
    }
    // Keep the heli between 22% and 60% from the top (clear of the centre messages), and the faster you climb, the more
    // room you get above you (so shafts don't hide what's coming).
    const climb = clamp(-h.vel.y / 220, 0, 1);
    ty = clamp(ty, base - vh * (0.1 + 0.15 * climb), base + vh * (0.28 - 0.38 * climb));
    if (!game.alive) {
      tx = this.cam.x;
      ty = this.cam.y;
    }
    if (!this.cam.init || (game.time < 0.05 && game.phase === 'playing')) {
      this.cam.x = tx;
      this.cam.y = ty;
      this.cam.init = true;
    }
    const k = 1 - Math.exp(-config.camFollow * dt);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    const halfW = this.w / 2 / scale;
    const W = game.level.data.width;
    this.cam.x = halfW * 2 >= W ? W / 2 : clamp(this.cam.x, halfW, W - halfW);
    this.cam.y = Math.min(this.cam.y, game.level.maxY - this.h / 2 / scale);
  }

  // -------------------------------------------------------------- layers

  private drawStars(): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.stars) {
      const x = (((s.x * this.w * 3 - this.cam.x * s.z) % this.w) + this.w) % this.w;
      const y = (((s.y * this.h * 2 - this.cam.y * s.z * 0.6) % this.h) + this.h) % this.h;
      const tw = 0.6 + 0.4 * Math.sin(this.clock * (1 + s.z * 20) + s.x * 100);
      ctx.fillStyle = `rgba(190,220,255,${s.b * tw * 0.8})`;
      const r = s.z > 0.12 ? 1.6 : 1;
      ctx.fillRect(x, y, r, r);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private buildTerrain(game: Game): void {
    this.terrainPaths = game.level.polygons.map((pts) => {
      const p = new Path2D();
      pts.forEach((v, i) => (i ? p.lineTo(v.x, v.y) : p.moveTo(v.x, v.y)));
      p.closePath();
      return p;
    });
    this.terrainAll = new Path2D();
    for (const p of this.terrainPaths) this.terrainAll.addPath(p);
  }

  private drawTerrain(game: Game): void {
    const ctx = this.ctx;
    const deep = game.level.data.backdropY !== undefined;
    ctx.globalCompositeOperation = 'source-over';
    // solid rock with body: a generated stone texture, darkening with depth
    if (!this.rockPattern) this.rockPattern = ctx.createPattern(rockTexture(), 'repeat');
    ctx.fillStyle = this.rockPattern ?? 'rgb(10,16,40)';
    for (const p of this.terrainPaths) ctx.fill(p);
    const depth = ctx.createLinearGradient(0, 350, 0, deep ? game.level.maxY : 1300);
    depth.addColorStop(0, 'rgba(2,3,10,0)');
    depth.addColorStop(1, deep ? 'rgba(2,3,10,0.35)' : 'rgba(2,3,10,0.75)'); // caves keep rock visible against the dark air
    ctx.fillStyle = depth;
    for (const p of this.terrainPaths) ctx.fill(p);
    const edge = ctx.createLinearGradient(0, 350, 0, Math.max(1000, game.level.maxY - 300));
    edge.addColorStop(0, '#5afcff');
    edge.addColorStop(0.5, C.terrain);
    edge.addColorStop(1, '#7a5cff');
    // lit band just inside every surface
    if (this.terrainAll) {
      ctx.save();
      ctx.clip(this.terrainAll);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = edge;
      for (const [w, a] of [[36, 0.05], [16, 0.08]] as const) {
        ctx.globalAlpha = a * config.glow;
        ctx.lineWidth = w;
        for (const p of this.terrainPaths) ctx.stroke(p);
      }
      ctx.restore();
    }
    for (const p of this.terrainPaths) glow(ctx, p, edge, 2, config.glow);

    for (const { pad, pts } of game.level.padPolygons) {
      // your pad: steady green. Rescue (enemy) pads: blinking red, turning yellow once you're
      // close enough that no new guard will spawn there.
      const rescue = pad.kind === 'rescue';
      const near = rescue && game.alive && Math.hypot(game.heli.pos.x - (pad.x + pad.w / 2), game.heli.pos.y - pad.y) < config.enemySpawnClear;
      const col = !rescue ? C.startPad : near ? C.padSafe : C.padEnemy;
      const flash = rescue ? 0.55 + 0.45 * (Math.sin(this.clock * (near ? 5 : 7)) > 0 ? 1 : 0) : 1;
      const body = new Path2D();
      pts.forEach((v, i) => (i ? body.lineTo(v.x, v.y) : body.moveTo(v.x, v.y)));
      body.closePath();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(6,10,26,1)';
      ctx.fill(body);
      glow(ctx, body, col, 1.2, 0.5 * config.glow);
      const top = new Path2D();
      top.moveTo(pad.x, pad.y);
      top.lineTo(pad.x + pad.w, pad.y);
      glow(ctx, top, col, 3, flash * config.glow);
      // landing lights
      const blink = Math.floor(this.clock * 2) % 2 === 0;
      for (let i = 0; i <= 4; i++) {
        const x = pad.x + (pad.w * i) / 4;
        const lit = (i % 2 === 0) === blink;
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = lit && (!rescue || flash > 0.6) ? col : 'rgba(255,255,255,0.15)';
        ctx.fillRect(x - 2, pad.y + 6, 4, 4);
      }
    }
  }

  /** Underground, empty space shows dark rock instead of sky. */
  private drawBackdrop(game: Game): void {
    const y0 = game.level.data.backdropY;
    if (y0 === undefined) return;
    const ctx = this.ctx;
    const W = game.level.data.width;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + 300);
    g.addColorStop(0, 'rgba(3,2,8,0)');
    g.addColorStop(1, 'rgba(3,2,8,1)');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = g;
    ctx.fillRect(-200, y0, W + 400, 300);
    ctx.fillStyle = 'rgb(3,2,8)';
    ctx.fillRect(-200, y0 + 300, W + 400, game.level.maxY);
    // faint strata so the cave backdrop doesn't read as flat black
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(122,92,255,0.035)';
    ctx.lineWidth = 2;
    for (let y = y0 + 120; y < game.level.maxY; y += 46) {
      ctx.beginPath();
      for (let x = this.cam.x - 1400; x <= this.cam.x + 1400; x += 80) {
        const yy = y + Math.sin(x * 0.004 + y) * 10;
        x === this.cam.x - 1400 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawGates(game: Game): void {
    const ctx = this.ctx;
    for (const g of game.level.gates) {
      const alpha = 1 - g.fade;
      if (alpha < 0.02) continue;
      const path = new Path2D();
      g.pts.forEach((v, i) => (i ? path.lineTo(v.x, v.y) : path.moveTo(v.x, v.y)));
      path.closePath();
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * (0.25 + 0.1 * Math.sin(this.clock * 9));
      ctx.fillStyle = C.gate;
      ctx.fill(path);
      // crackling scan lines across the barrier
      ctx.clip(path);
      ctx.globalAlpha = alpha * 0.5;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      const xs = g.pts.map((p) => p.x);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      for (let x = x0 + ((this.clock * 120) % 16); x < x1; x += 16) {
        ctx.beginPath();
        ctx.moveTo(x, Math.min(...g.pts.map((p) => p.y)));
        ctx.lineTo(x + 8, Math.max(...g.pts.map((p) => p.y)));
        ctx.stroke();
      }
      ctx.restore();
      glow(ctx, path, C.gate, 1.6, alpha * config.glow);
    }
  }

  /** Orb pedestal: a dark metal plinth with a glowing cradle; the glow fades once the orb leaves. */
  private drawPedestal(game: Game): void {
    const ctx = this.ctx;
    const pts = game.level.pedestal;
    const path = new Path2D();
    pts.forEach((v, i) => (i ? path.lineTo(v.x, v.y) : path.moveTo(v.x, v.y)));
    path.closePath();
    const home = game.orb.home;
    const top = home.y + 16.5;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    const g = ctx.createLinearGradient(home.x - 24, 0, home.x + 24, 0);
    g.addColorStop(0, 'rgb(40,20,50)');
    g.addColorStop(0.5, 'rgb(22,10,30)');
    g.addColorStop(1, 'rgb(10,4,16)');
    ctx.fillStyle = g;
    ctx.fill(path);
    ctx.restore();
    const resting = !game.orb.attached && !game.orb.free && !game.orb.delivered && game.orb.pos.x === home.x && game.orb.pos.y === home.y;
    const pulse = 0.7 + 0.3 * Math.sin(this.clock * 3);
    glow(ctx, path, COLORS.orb, 1.4, (resting ? 0.9 : 0.4) * config.glow);
    // glowing bands down the column
    const bands = new Path2D();
    for (const dy of [18, 30]) {
      bands.moveTo(home.x - 14 - dy * 0.06, top + dy);
      bands.lineTo(home.x + 14 + dy * 0.06, top + dy);
    }
    glow(ctx, bands, COLORS.orb, 1, (resting ? 0.6 * pulse : 0.2) * config.glow);
    if (resting) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const halo = ctx.createRadialGradient(home.x, top, 0, home.x, top, 40);
      halo.addColorStop(0, `rgba(255,61,242,${0.35 * pulse})`);
      halo.addColorStop(1, 'rgba(255,61,242,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(home.x - 40, top - 30, 80, 50);
      ctx.restore();
    }
  }

  private drawBowl(game: Game): void {
    const ctx = this.ctx;
    const bowl = game.level.bowl;
    const done = game.orb.delivered;
    const col = C.bowl;
    const pulse = 0.6 + 0.4 * Math.sin(this.clock * 3);

    const body = new Path2D();
    bowl.pts.forEach((v, i) => (i ? body.lineTo(v.x, v.y) : body.moveTo(v.x, v.y)));
    body.closePath();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgb(14,10,4)';
    ctx.fill(body);

    // warm glow pooled in the cup
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(bowl.cx, bowl.rest.y, 0, bowl.cx, bowl.rest.y, bowl.innerR * 2.2);
    g.addColorStop(0, `rgba(255,176,32,${done ? 0.45 : 0.12 + 0.1 * pulse})`);
    g.addColorStop(1, 'rgba(255,176,32,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bowl.cx, bowl.rest.y, bowl.innerR * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    glow(ctx, body, col, 1.8, (done ? 1.2 : 0.8 + 0.2 * pulse) * config.glow);
    // rim lights
    const blink = Math.floor(this.clock * 3) % 2 === 0;
    for (const side of [-1, 1]) {
      dot(ctx, bowl.cx + side * (bowl.innerR + 6), bowl.rimY - 1, 1.8, blink || done ? col : '#ffffff');
    }

    if (!done) {
      // chevrons pointing into the cup
      for (let i = 0; i < 3; i++) {
        const cy = bowl.rimY - 70 + i * 14 + ((this.clock * 20) % 14);
        const c = new Path2D();
        c.moveTo(bowl.cx - 12, cy);
        c.lineTo(bowl.cx, cy + 9);
        c.lineTo(bowl.cx + 12, cy);
        glow(ctx, c, col, 1.8, (0.25 + i * 0.25) * config.glow);
      }
    }
  }

  /** Gun emplacements: bolted armour base, faceted dome, twin barrels with a muzzle block, sensor slit. */
  private drawTurrets(game: Game): void {
    const ctx = this.ctx;
    for (const t of game.turrets) {
      if (!t.alive) continue;
      const n = t.normal;
      const tx = -n.y; // along the surface
      const ty = n.x;
      const L = (u: number, v: number): Vec => ({ x: t.pos.x + tx * u + n.x * v, y: t.pos.y + ty * u + n.y * v });
      const poly = (pts: [number, number][]) => {
        const path = new Path2D();
        pts.forEach(([u, v], i) => {
          const q = L(u, v);
          i ? path.lineTo(q.x, q.y) : path.moveTo(q.x, q.y);
        });
        path.closePath();
        return path;
      };
      const metal = (path: Path2D, light: number) => {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        const a = L(-20, 30);
        const b = L(20, 0);
        const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        g.addColorStop(0, `rgba(${90 + light},${22 + light / 3},${34 + light / 3},0.98)`);
        g.addColorStop(1, 'rgba(18,4,8,0.98)');
        ctx.fillStyle = g;
        ctx.fill(path);
        ctx.restore();
      };
      // base plate
      const base = poly([[-36, -2], [36, -2], [30, 7], [-30, 7]]);
      metal(base, 0);
      glow(ctx, base, COLORS.target, 1.4, 0.9 * config.glow);
      // faceted dome
      const R = TURRET_RADIUS;
      const dome: [number, number][] = [];
      for (let i = 0; i <= 6; i++) {
        const a2 = Math.PI - (i / 6) * Math.PI;
        dome.push([Math.cos(a2) * R, 7 + Math.sin(a2) * R * 0.9]);
      }
      const domePath = poly(dome);
      metal(domePath, 25);
      // twin barrels with a muzzle block, drawn as solid shapes along the aim
      const c = turretCentre(t);
      const dx = Math.cos(t.aim);
      const dy = Math.sin(t.aim);
      const px = -dy;
      const py = dx;
      const bar = (off: number) => {
        const path = new Path2D();
        const pts = [
          [6, off - 2],
          [TURRET_BARREL - 6, off - 2],
          [TURRET_BARREL - 6, off + 2],
          [6, off + 2],
        ];
        pts.forEach(([a2, b2], i) => {
          const q = { x: c.x + dx * a2 + px * b2, y: c.y + dy * a2 + py * b2 };
          i ? path.lineTo(q.x, q.y) : path.moveTo(q.x, q.y);
        });
        path.closePath();
        return path;
      };
      const muzzle = new Path2D();
      [[TURRET_BARREL - 7, -5.5], [TURRET_BARREL + 1, -5.5], [TURRET_BARREL + 1, 5.5], [TURRET_BARREL - 7, 5.5]].forEach(([a2, b2], i) => {
        const q = { x: c.x + dx * a2 + px * b2, y: c.y + dy * a2 + py * b2 };
        i ? muzzle.lineTo(q.x, q.y) : muzzle.moveTo(q.x, q.y);
      });
      muzzle.closePath();
      const barrels = new Path2D();
      barrels.addPath(bar(-3.2));
      barrels.addPath(bar(3.2));
      barrels.addPath(muzzle);
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(40,8,14,0.98)';
      ctx.fill(barrels);
      ctx.restore();
      glow(ctx, barrels, t.charge > 0 ? '#ffb070' : COLORS.target, 1.2, (0.9 + t.charge) * config.glow);
      glow(ctx, domePath, COLORS.target, 1.8, config.glow);
      // dome panel lines and bolts
      const panel = new Path2D();
      const p0 = L(-R * 0.62, 7);
      const p1 = L(0, 7 + R * 0.9);
      const p2 = L(R * 0.62, 7);
      panel.moveTo(p0.x, p0.y);
      panel.lineTo(p1.x, p1.y);
      panel.lineTo(p2.x, p2.y);
      glow(ctx, panel, '#ff9a3c', 0.7, 0.35 * config.glow);
      for (const u of [-27, -14, 14, 27]) {
        const q = L(u, 2.5);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(255,170,150,0.55)';
        ctx.beginPath();
        ctx.arc(q.x, q.y, 1.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      // sensor slit (blinks fast while tracking you)
      const sensor = L(0, 7 + R * 0.45);
      const on = t.tracking ? Math.sin(this.clock * 14) > 0 : Math.sin(this.clock * 3 + t.pos.x) > 0.2;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = on ? 'rgba(255,90,70,0.95)' : 'rgba(255,90,70,0.25)';
      ctx.beginPath();
      ctx.ellipse(sensor.x, sensor.y, 7, 2.2, Math.atan2(ty, tx), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (t.charge > 0) dot(ctx, c.x + dx * (TURRET_BARREL + 2), c.y + dy * (TURRET_BARREL + 2), 1.5 + t.charge * 4, COLORS.enemyShot);
    }
  }

  private drawOrb(game: Game): void {
    const ctx = this.ctx;
    const orb = game.orb;
    const R = config.orbRadius;
    let pos = orb.pos;
    const alpha = 1;
    const r = R;
    if (orb.delivered) {
      // settle from where it touched down into the bottom of the cup
      const k = 1 - Math.exp(-(game.time - orb.deliveredAt) * 6);
      const rest = game.level.bowl.rest;
      pos = { x: lerp(orb.pos.x, rest.x, k), y: lerp(orb.pos.y, rest.y, k) };
    } else if (orb.pos.x < -9999) {
      return;
    }

    // rod / beam
    if (game.alive) {
      const a = toWorld(game.heli.pos, game.heli.tilt, game.facingVis, ANCHOR);
      if (orb.attached) {
        const rod = new Path2D();
        rod.moveTo(a.x, a.y);
        rod.lineTo(pos.x, pos.y);
        glow(ctx, rod, C.rod, 1.6, 0.8 * config.glow);
      } else if (game.beam) {
        ctx.save();
        ctx.setLineDash([4, 6]);
        ctx.lineDashOffset = -this.clock * 60;
        const beam = new Path2D();
        beam.moveTo(a.x, a.y);
        beam.lineTo(pos.x, pos.y);
        glow(ctx, beam, COLORS.orb, 1.4, (0.6 + 0.4 * Math.random()) * config.glow);
        ctx.restore();
      }
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = 'lighter';
    const pulse = 0.85 + 0.15 * Math.sin(this.clock * 4);
    const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r * 3);
    g.addColorStop(0, 'rgba(255,200,250,0.55)');
    g.addColorStop(0.3, `rgba(255,61,242,${0.35 * pulse})`);
    g.addColorStop(1, 'rgba(255,61,242,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r * 3, 0, Math.PI * 2);
    ctx.fill();
    const ring = new Path2D();
    ring.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    glow(ctx, ring, COLORS.orb, 2, config.glow);
    const hex = new Path2D();
    const rot = this.clock * 1.2;
    for (let i = 0; i <= 6; i++) {
      const a = rot + (i * Math.PI) / 3;
      const px = pos.x + Math.cos(a) * r * 0.55;
      const py = pos.y + Math.sin(a) * r * 0.55;
      i ? hex.lineTo(px, py) : hex.moveTo(px, py);
    }
    glow(ctx, hex, '#ffd0fb', 1, 0.7 * config.glow);
    ctx.restore();
  }

  private drawHeli(game: Game): void {
    const h = game.heli;
    this.drawHeliShape({ pos: h.pos, tilt: h.tilt, facing: game.facingVis, spin: game.rotorSpeed, rotorPhase: game.rotorPhase }, HELI_PLAYER);
  }

  /** Any helicopter (player or enemy) in a given colour scheme. */
  private drawHeliShape(h: { pos: Vec; tilt: number; facing: number; spin: number; rotorPhase: number }, pal: HeliPalette): void {
    const ctx = this.ctx;
    const f = h.facing;
    const spin = h.spin;
    const glowK = config.glow;
    // engine buzz: a sub-unit shake that grows with the rotor (visual only)
    const buzz = 0.15 + spin * 0.35;
    const pos = { x: h.pos.x + Math.sin(this.clock * 71) * buzz, y: h.pos.y + Math.cos(this.clock * 83) * buzz };
    const W = (p: Vec) => toWorld(pos, h.tilt, f, p);
    const poly = (pts: Vec[], close = true) => {
      const path = new Path2D();
      pts.forEach((v, i) => {
        const q = W(v);
        i ? path.lineTo(q.x, q.y) : path.moveTo(q.x, q.y);
      });
      if (close) path.closePath();
      return path;
    };
    const seg = (path: Path2D, a: Vec, b: Vec) => {
      const A = W(a);
      const B = W(b);
      path.moveTo(A.x, A.y);
      path.lineTo(B.x, B.y);
    };

    // ---- tail: tapered boom, swept fin, ventral fin
    const boom = poly(HELI.boom);
    const fin = poly(HELI.fin);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = pal.tailFill;
    ctx.fill(boom);
    ctx.fill(fin);
    const tail = new Path2D(boom);
    tail.addPath(fin);
    seg(tail, HELI.ventral[0], HELI.ventral[1]);
    seg(tail, HELI.stab[0], HELI.stab[1]);
    glow(ctx, tail, pal.line, 1.2, glowK);

    // ---- tail rotor: seen face-on from the side, so it's a spinning disc
    const hub = W(TAIL_ROTOR_HUB);
    const tdisc = new Path2D();
    tdisc.arc(hub.x, hub.y, TAIL_ROTOR_R, 0, Math.PI * 2);
    glow(ctx, tdisc, C.rotor, 0.6, (0.08 + spin * 0.3) * glowK);
    const tPhase = h.rotorPhase * 2.6 * Math.sign(f || 1);
    const tGhosts = Math.round(spin * 5);
    for (let g = tGhosts; g >= 0; g--) {
      const a = tPhase - g * 0.22;
      const blade = new Path2D();
      const dx = Math.cos(a) * TAIL_ROTOR_R;
      const dy = Math.sin(a) * TAIL_ROTOR_R;
      blade.moveTo(hub.x - dx, hub.y - dy);
      blade.lineTo(hub.x + dx, hub.y + dy);
      glow(ctx, blade, C.rotor, g ? 0.8 : 1.1, (g ? (1 - g / (tGhosts + 1)) * 0.3 : 0.9) * glowK);
    }

    // ---- fuselage
    const body = poly(BODY);
    const hump = poly(HELI.hump);
    const fill = ctx.createLinearGradient(pos.x, pos.y - 12, pos.x, pos.y + 12);
    fill.addColorStop(0, pal.fillTop);
    fill.addColorStop(1, pal.fillBottom);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = fill;
    ctx.fill(hump);
    ctx.fill(body);
    const hull = new Path2D(body);
    hull.addPath(hump);
    seg(hull, MAST[0], MAST[1]);
    glow(ctx, hull, pal.line, 1.5, glowK);

    // panel lines + side window
    const detail = new Path2D();
    seg(detail, HELI.door[0], HELI.door[1]);
    seg(detail, HELI.exhaust[0], HELI.exhaust[1]);
    detail.addPath(poly(HELI.window));
    glow(ctx, detail, pal.line, 0.7, 0.45 * glowK);

    // canopy glass with a lit cockpit
    const glass = poly(HELI.canopy);
    const cg = W({ x: 13, y: -1 });
    const gfill = ctx.createRadialGradient(cg.x, cg.y, 0, cg.x, cg.y, 12);
    gfill.addColorStop(0, 'rgba(127,252,255,0.45)');
    gfill.addColorStop(1, 'rgba(40,120,200,0.12)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = gfill;
    ctx.fill(glass);
    glow(ctx, glass, pal.canopy, 1, 0.9 * glowK);

    // ---- landing gear
    const gear = new Path2D();
    STRUTS.forEach(([a, b]) => seg(gear, a, b));
    seg(gear, SKID[0], SKID[1]);
    seg(gear, SKID_TOE[0], SKID_TOE[1]);
    glow(ctx, gear, pal.line, 1.2, glowK);

    // ---- main rotor: blades sweep round an edge-on ellipse, with motion-blur ghosts
    const ry = 3.2;
    const tip = (phi: number) => W({ x: ROTOR_R * Math.cos(phi), y: ROTOR_Y + ry * Math.sin(phi) });
    const disc = new Path2D();
    for (let i = 0; i <= 32; i++) {
      const q = tip((i / 32) * Math.PI * 2);
      i ? disc.lineTo(q.x, q.y) : disc.moveTo(q.x, q.y);
    }
    glow(ctx, disc, C.rotor, 0.7, (0.05 + spin * 0.28) * glowK);
    const rhub = W({ x: 0, y: ROTOR_Y });
    const ghosts = Math.round(spin * 7);
    for (let g = ghosts; g >= 0; g--) {
      const path = new Path2D();
      for (let b = 0; b < 2; b++) {
        const t = tip(h.rotorPhase + b * Math.PI - g * 0.14);
        path.moveTo(rhub.x, rhub.y);
        path.lineTo(t.x, t.y);
      }
      const a = g === 0 ? 0.85 : (1 - g / (ghosts + 1)) * 0.16;
      glow(ctx, path, C.rotor, g === 0 ? 1.4 : 1, a * glowK);
    }
    dot(ctx, rhub.x, rhub.y, 1.6, '#ffffff');

    // ---- lights: red tail beacon, white belly strobe, green nav
    const beacon = W(HELI.beacon);
    if ((this.clock * 1.1) % 1 < 0.18) dot(ctx, beacon.x, beacon.y, 1.6, '#ff3030');
    const st = this.clock % 1.4;
    if (st < 0.05 || (st > 0.13 && st < 0.18)) {
      const strobe = W(HELI.strobe);
      dot(ctx, strobe.x, strobe.y, 1.8, '#ffffff');
    }
    const nav = W(HELI.nav);
    dot(ctx, nav.x, nav.y, 1.1, '#3dff8a');
  }

  /** Enemy balloons: an angular armoured gasbag with fins, a glowing red eye and a rigid gun pod. */
  private drawBalloons(game: Game): void {
    const ctx = this.ctx;
    for (const b of game.balloons) {
      const R = BALLOON_R;
      const sway = Math.sin(b.t * 0.9) * 0.07;
      const cs = Math.cos(sway);
      const sn = Math.sin(sway);
      const P = (x: number, y: number): Vec => ({ x: b.pos.x + (x * cs - y * sn) * R, y: b.pos.y + (x * sn + y * cs) * R });
      const poly = (pts: [number, number][], close = true) => {
        const path = new Path2D();
        pts.forEach(([x, y], i) => {
          const q = P(x, y);
          i ? path.lineTo(q.x, q.y) : path.moveTo(q.x, q.y);
        });
        if (close) path.closePath();
        return path;
      };
      const hull: [number, number][] = [
        [0, -1.25], [0.75, -0.85], [1.0, -0.1], [0.7, 0.7], [0.2, 1.05], [-0.2, 1.05], [-0.7, 0.7], [-1.0, -0.1], [-0.75, -0.85],
      ];
      const body = poly(hull);
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      const g = ctx.createLinearGradient(b.pos.x - R, b.pos.y - R, b.pos.x + R, b.pos.y + R);
      g.addColorStop(0, 'rgba(70,10,26,0.97)');
      g.addColorStop(1, 'rgba(16,2,8,0.97)');
      ctx.fillStyle = g;
      ctx.fill(body);
      ctx.restore();
      // fins and top spike
      const fins = new Path2D();
      fins.addPath(poly([[1.0, -0.35], [1.42, -0.05], [1.0, 0.2]], false));
      fins.addPath(poly([[-1.0, -0.35], [-1.42, -0.05], [-1.0, 0.2]], false));
      fins.addPath(poly([[0, -1.25], [0, -1.65]], false));
      fins.addPath(poly([[-0.12, -1.5], [0.12, -1.5]], false));
      glow(ctx, body, BALLOON_LINE, 1.7, config.glow);
      glow(ctx, fins, BALLOON_LINE, 1.5, config.glow);
      // armour facets
      const facets = new Path2D();
      facets.addPath(poly([[-1.0, -0.1], [1.0, -0.1]], false));
      facets.addPath(poly([[-0.75, -0.85], [-0.3, -0.1], [-0.2, 1.05]], false));
      facets.addPath(poly([[0.75, -0.85], [0.3, -0.1], [0.2, 1.05]], false));
      facets.addPath(poly([[0, -1.25], [-0.3, -0.1]], false));
      facets.addPath(poly([[0, -1.25], [0.3, -0.1]], false));
      glow(ctx, facets, '#ff9a3c', 0.8, 0.45 * config.glow);
      // the eye: a red slit that glances toward you and flares when charging
      const look = clamp(Math.cos(b.aim) * 0.25, -0.25, 0.25);
      const eye = P(look, 0.25);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const flare = 0.55 + 0.25 * Math.sin(this.clock * 6 + b.t) + b.charge * 0.8;
      const eg = ctx.createRadialGradient(eye.x, eye.y, 0, eye.x, eye.y, R * (0.55 + b.charge * 0.4));
      eg.addColorStop(0, `rgba(255,80,60,${Math.min(1, flare)})`);
      eg.addColorStop(1, 'rgba(255,0,40,0)');
      ctx.fillStyle = eg;
      ctx.beginPath();
      ctx.arc(eye.x, eye.y, R * (0.55 + b.charge * 0.4), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,${180 + b.charge * 75},${160 + b.charge * 95},${Math.min(1, 0.7 + b.charge)})`;
      ctx.beginPath();
      ctx.ellipse(eye.x, eye.y, R * 0.26, R * 0.06 + b.charge * 2, sway, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // rigid strut down to a hex gun pod
      const gun = balloonGun(b);
      const strut = new Path2D();
      const bottom = P(0, 1.05);
      strut.moveTo(bottom.x, bottom.y);
      strut.lineTo(gun.x, gun.y - 8);
      for (let i = 0; i <= 6; i++) {
        const a2 = (i / 6) * Math.PI * 2 + Math.PI / 6;
        const q = { x: gun.x + Math.cos(a2) * 8, y: gun.y + Math.sin(a2) * 8 };
        i ? strut.lineTo(q.x, q.y) : strut.moveTo(q.x, q.y);
      }
      glow(ctx, strut, BALLOON_LINE, 1.3, config.glow);
      const barrel = new Path2D();
      barrel.moveTo(gun.x, gun.y);
      barrel.lineTo(gun.x + Math.cos(b.aim) * 20, gun.y + Math.sin(b.aim) * 20);
      glow(ctx, barrel, b.charge > 0 ? '#ffb070' : BALLOON_LINE, 2.6, (1 + b.charge) * config.glow);
      if (b.charge > 0) dot(ctx, gun.x + Math.cos(b.aim) * 20, gun.y + Math.sin(b.aim) * 20, 1.5 + b.charge * 3.5, COLORS.enemyShot);
    }
  }

  /**
   * LED bar fuel gauge: a recessed housing with a row of LED lenses. Lit LEDs have a hot core,
   * a specular glint and a halo; unlit ones are dark lenses that still catch a reflection.
   * Red at the low end, then amber, yellow, and green at the full end. Blinks when low; a light sweeps along it while refuelling.
   */
  private drawFuelGauge(game: Game): void {
    const ctx = this.ctx;
    const k = clamp(game.fuel / config.fuelMax, 0, 1);
    this.fuelNeedle += (k - this.fuelNeedle) * (1 - Math.exp(-6 * this.frameDt));
    const low = k < 0.2;
    const blinkOn = Math.sin(this.clock * 9) > -0.1;
    const segs = FUEL_TICKS;
    const ledW = 20;
    const ledH = 32;
    const gap = 6;
    const innerW = segs * ledW + (segs - 1) * gap;
    const pad = 12;
    const w = innerW + pad * 2;
    const h = ledH + pad * 2;
    const x0 = this.w / 2 - w / 2;
    const y0 = this.h - h - 22;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    // housing: dark recessed panel with a thin bevelled frame
    const body = ctx.createLinearGradient(0, y0, 0, y0 + h);
    body.addColorStop(0, '#20232c');
    body.addColorStop(0.5, '#0b0c11');
    body.addColorStop(1, '#16181f');
    ctx.fillStyle = body;
    roundRect(ctx, x0, y0, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    roundRect(ctx, x0 + 0.5, y0 + 0.5, w - 1, h - 1, 8);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, x0 + pad - 4, y0 + pad - 4, innerW + 8, ledH + 8, 4);
    ctx.fill();
    ctx.restore();

    const lit = this.fuelNeedle * segs;
    const sweep = game.refueling ? ((this.clock * 1.6) % 1.4) * segs : -99;
    for (let i = 0; i < segs; i++) {
      const lx = x0 + pad + i * (ledW + gap);
      const ly = y0 + pad;
      const v = i / (segs - 1);
      const [cr, cg, cb] = v < 0.2 ? [255, 60, 50] : v < 0.45 ? [255, 160, 40] : v < 0.75 ? [255, 225, 70] : [80, 255, 120];
      let on = clamp(lit - i, 0, 1);
      if (low && !blinkOn) on *= 0.25;
      const sw = Math.max(0, 1 - Math.abs(sweep - i) / 2.5) * 0.6;
      const glowK = on > 0 ? on : sw * 0.5;
      ctx.save();
      // lens base
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgb(${Math.round(cr * 0.12)},${Math.round(cg * 0.1)},${Math.round(cb * 0.1)})`;
      roundRect(ctx, lx, ly, ledW, ledH, 3);
      ctx.fill();
      if (glowK > 0) {
        ctx.globalCompositeOperation = 'lighter';
        // halo bleeding past the lens
        const halo = ctx.createRadialGradient(lx + ledW / 2, ly + ledH / 2, 2, lx + ledW / 2, ly + ledH / 2, ledH * 1.1);
        halo.addColorStop(0, `rgba(${cr},${cg},${cb},${0.35 * glowK})`);
        halo.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = halo;
        ctx.fillRect(lx - ledH, ly - ledH * 0.6, ledW + ledH * 2, ledH * 2.2);
        // the lit lens: hot core fading to the edges
        const core = ctx.createRadialGradient(lx + ledW / 2, ly + ledH * 0.45, 1, lx + ledW / 2, ly + ledH / 2, ledH * 0.7);
        core.addColorStop(0, `rgba(255,${Math.min(255, cg + 80)},${Math.min(255, cb + 120)},${glowK})`);
        core.addColorStop(0.45, `rgba(${cr},${cg},${cb},${0.95 * glowK})`);
        core.addColorStop(1, `rgba(${Math.round(cr * 0.5)},${Math.round(cg * 0.4)},${Math.round(cb * 0.3)},${0.8 * glowK})`);
        ctx.fillStyle = core;
        roundRect(ctx, lx, ly, ledW, ledH, 3);
        ctx.fill();
      }
      // specular glint on the lens (always there; brighter when lit)
      ctx.globalCompositeOperation = 'lighter';
      const spec = ctx.createLinearGradient(lx, ly, lx, ly + ledH * 0.5);
      spec.addColorStop(0, `rgba(255,255,255,${0.12 + 0.35 * glowK})`);
      spec.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = spec;
      roundRect(ctx, lx + 2, ly + 1.5, ledW - 4, ledH * 0.42, 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.25 + 0.5 * glowK})`;
      ctx.beginPath();
      ctx.ellipse(lx + ledW * 0.32, ly + ledH * 0.2, 1.6, 2.6, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    text(ctx, 'E', x0 - 22, y0 + h / 2, 24, '#ff6a6a', 'center', 0.9);
    text(ctx, 'F', x0 + w + 22, y0 + h / 2, 24, '#50ff78', 'center', 0.9);
  }

  /** The end-of-level bonus tally, big in the middle of the screen. */
  private drawTally(game: Game, y: number): void {
    const t = game.tally!;
    const ctx = this.ctx;
    const timeOn = t.stage === 'time' || t.stage === 'intro' || t.stage === 'pause';
    const pulse = 1 + 0.06 * Math.sin(this.clock * 30);
    // time bonus line
    const tt = game.bonusTime;
    const clock = `${Math.floor(tt / 60)}:${(tt % 60).toFixed(1).padStart(4, '0')}`;
    text(ctx, 'TIME BONUS', this.w / 2 - 30, y + 40, 30, C.hud, 'right', timeOn ? 1 : 0.45);
    text(ctx, clock, this.w / 2 + 30, y + 40, 52 * (t.stage === 'time' ? pulse : 1), t.tenths > 0 ? '#3dff8a' : 'rgba(61,255,138,0.45)', 'left');
    // fuel bonus line
    const fuelOn = t.stage === 'fuel';
    text(ctx, 'FUEL BONUS', this.w / 2 - 30, y + 110, 30, C.fuelPad, 'right', fuelOn ? 1 : 0.45);
    text(ctx, `${t.ticks} × ${POINTS.perFuelTick}`, this.w / 2 + 30, y + 110, 52 * (fuelOn ? pulse : 1), t.ticks > 0 ? C.fuelPad : 'rgba(255,225,77,0.45)', 'left');
    void ctx;
  }

  /** A tiny helicopter silhouette for the lives display. */
  private drawLifeIcon(x: number, y: number, size = 0.5): void {
    const P = (px: number, py: number) => ({ x: x + px * size, y: y + py * size });
    const p = new Path2D();
    BODY.forEach((v, i) => {
      const q = P(v.x, v.y);
      i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y);
    });
    p.closePath();
    const seg = (a: Vec, b: Vec) => {
      const A = P(a.x, a.y);
      const B = P(b.x, b.y);
      p.moveTo(A.x, A.y);
      p.lineTo(B.x, B.y);
    };
    seg({ x: -15, y: 0 }, { x: -44, y: -3 });
    seg({ x: -44, y: -3 }, { x: -48, y: -12 });
    seg({ x: -ROTOR_R, y: ROTOR_Y }, { x: ROTOR_R, y: ROTOR_Y });
    seg(SKID[0], SKID[1]);
    glow(this.ctx, p, COLORS.heli, 1.1, 0.9 * config.glow);
  }

  /** Fuel tanks: a squat canister with a fill gauge; a beam while you're sucking one dry. */
  private drawFuelTanks(game: Game): void {
    const ctx = this.ctx;
    for (const t of game.fuelTanks) {
      if (!t.alive) continue;
      const x0 = t.pos.x - TANK_W / 2;
      const y0 = t.pos.y - TANK_H;
      const body = new Path2D();
      body.moveTo(x0, t.pos.y);
      body.lineTo(x0, y0 + 8);
      body.quadraticCurveTo(x0, y0, x0 + 8, y0);
      body.lineTo(x0 + TANK_W - 8, y0);
      body.quadraticCurveTo(x0 + TANK_W, y0, x0 + TANK_W, y0 + 8);
      body.lineTo(x0 + TANK_W, t.pos.y);
      body.closePath();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgb(24,20,4)';
      ctx.fill(body);
      // fuel level
      const k = t.amount / t.max;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,225,77,${0.25 + 0.15 * Math.sin(this.clock * 4 + t.pos.x)})`;
      const fh = (TANK_H - 6) * k;
      ctx.fillRect(x0 + 4, t.pos.y - 3 - fh, TANK_W - 8, fh);
      ctx.restore();
      const trim = new Path2D(body);
      trim.moveTo(x0 + TANK_W / 2 - 6, y0);
      trim.lineTo(x0 + TANK_W / 2 - 6, y0 - 6); // cap
      trim.lineTo(x0 + TANK_W / 2 + 6, y0 - 6);
      trim.lineTo(x0 + TANK_W / 2 + 6, y0);
      // hazard bands
      trim.moveTo(x0, t.pos.y - 7);
      trim.lineTo(x0 + TANK_W, t.pos.y - 7);
      // fuel-drop glyph on the side
      const dx = t.pos.x;
      const dy = t.pos.y - TANK_H / 2 - 1;
      trim.moveTo(dx, dy - 8);
      trim.quadraticCurveTo(dx + 6, dy, dx + 5, dy + 3);
      trim.arc(dx, dy + 3, 5, 0, Math.PI);
      trim.quadraticCurveTo(dx - 6, dy, dx, dy - 8);
      glow(ctx, trim, C.fuelPad, 1.5, config.glow);
    }
    if (game.fueling && game.alive) {
      const t = game.fueling;
      const a = toWorld(game.heli.pos, game.heli.tilt, game.facingVis, { x: 0, y: SKID_Y });
      ctx.save();
      ctx.setLineDash([5, 6]);
      ctx.lineDashOffset = this.clock * 80; // dashes run upward, toward the heli
      const beam = new Path2D();
      beam.moveTo(t.pos.x, t.pos.y - TANK_H - 4);
      beam.lineTo(a.x, a.y);
      glow(ctx, beam, C.fuelPad, 1.4, (0.6 + 0.3 * Math.random()) * config.glow);
      ctx.restore();
    }
  }

  /** Faux-vector stick figures: wave when you're near, run when called, scurry off the pad when home. */
  private drawSurvivors(game: Game): void {
    const ctx = this.ctx;
    const near = (x: number) => Math.abs(game.heli.pos.x - x) < 700 && game.alive;
    const figure = (x: number, y: number, mode: 'idle' | 'wave' | 'run', dir: number, t: number, alpha = 1) => {
      const p = new Path2D();
      const hip = { x, y: y - 7 };
      const neck = { x, y: y - 15 };
      p.moveTo(hip.x, hip.y);
      p.lineTo(neck.x, neck.y); // body
      p.moveTo(x + 2.6, y - 18.5);
      p.arc(x, y - 18.5, 2.6, 0, Math.PI * 2); // head
      const swing = mode === 'run' ? Math.sin(t * 16) * 5 : 0;
      p.moveTo(hip.x, hip.y);
      p.lineTo(x - 3 + swing * 0.8, y); // legs
      p.moveTo(hip.x, hip.y);
      p.lineTo(x + 3 - swing * 0.8, y);
      if (mode === 'wave') {
        const a = -Math.PI / 2 + Math.sin(t * 9) * 0.6;
        p.moveTo(neck.x, neck.y + 1);
        p.lineTo(x + Math.cos(a) * 8, neck.y + 1 + Math.sin(a) * 8); // waving arm up
        p.moveTo(neck.x, neck.y + 1);
        p.lineTo(x - 4, y - 9);
      } else {
        p.moveTo(neck.x, neck.y + 1);
        p.lineTo(x + dir * 5 - swing * 0.5, y - 10);
        p.moveTo(neck.x, neck.y + 1);
        p.lineTo(x - dir * 5 + swing * 0.5, y - 10);
      }
      glow(ctx, p, COLORS.survivor, 1.1, alpha * config.glow);
    };
    for (const s of game.survivors) {
      if (s.state === 'waiting') figure(s.pos.x, s.pos.y, near(s.pos.x) ? 'wave' : 'idle', s.dir, s.t);
      else if (s.state === 'running') figure(s.pos.x, s.pos.y, 'run', s.dir, s.t);
    }
    for (const d of game.disembarking) if (d.t > 0) figure(d.pos.x, d.pos.y, 'run', -1, d.t, Math.max(0, 1 - d.t / 2.5));
  }

  private drawShield(game: Game): void {
    const ctx = this.ctx;
    const p = game.heli.pos;
    const r = SHIELD_RADIUS + Math.sin(this.clock * 23) * 1.2;
    const flash = game.shieldFlash;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(p.x, p.y, r * 0.55, p.x, p.y, r);
    g.addColorStop(0, 'rgba(127,252,255,0)');
    g.addColorStop(1, `rgba(127,252,255,${0.12 + flash * 0.35})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    const ring = new Path2D();
    ring.arc(p.x, p.y, r, 0, Math.PI * 2);
    glow(ctx, ring, C.shield, 1.4 + flash * 1.5, (0.55 + 0.25 * Math.sin(this.clock * 31) + flash) * config.glow);
    // a few rotating arc segments for a force-field shimmer
    const arcs = new Path2D();
    for (let i = 0; i < 3; i++) {
      const a0 = this.clock * 2.4 + (i * Math.PI * 2) / 3;
      arcs.moveTo(p.x + Math.cos(a0) * (r - 5), p.y + Math.sin(a0) * (r - 5));
      arcs.arc(p.x, p.y, r - 5, a0, a0 + 0.7);
    }
    glow(ctx, arcs, '#ffffff', 1, (0.35 + flash) * config.glow);
  }

  private drawShards(game: Game): void {
    for (const s of game.shards) {
      const c = Math.cos(s.ang);
      const sn = Math.sin(s.ang);
      const hx = s.half.x * c - s.half.y * sn;
      const hy = s.half.x * sn + s.half.y * c;
      const path = new Path2D();
      path.moveTo(s.pos.x - hx, s.pos.y - hy);
      path.lineTo(s.pos.x + hx, s.pos.y + hy);
      glow(this.ctx, path, s.color, 1.4, (s.life / s.maxLife) * config.glow);
    }
  }

  /** Faint nebula clouds behind the stars, drifting with slow parallax. */
  private drawNebula(): void {
    if (!this.nebula) this.nebula = nebulaTexture();
    const ctx = this.ctx;
    const tex = this.nebula;
    // tile the texture across the screen, scrolled with very slow parallax
    const s = (Math.max(this.w, this.h) / tex.width) * 1.25;
    const tw = tex.width * s;
    const th = tex.height * s;
    const ox = -(((this.cam.x * 0.04) % tw) + tw) % tw;
    const oy = -(((this.cam.y * 0.025 + th * 0.3) % th) + th) % th;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.85;
    for (let x = ox; x < this.w; x += tw) for (let y = oy; y < this.h; y += th) ctx.drawImage(tex, x, y, tw, th);
    ctx.restore();
  }

  /** Real bloom: blur a downscaled copy of the frame and add it back on top. */
  private bloom(): void {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const bw = Math.max(1, Math.round(cw / 4));
    const bh = Math.max(1, Math.round(ch / 4));
    if (!this.bloomCanvas || this.bloomCanvas.width !== bw || this.bloomCanvas.height !== bh) {
      this.bloomCanvas = document.createElement('canvas');
      this.bloomCanvas.width = bw;
      this.bloomCanvas.height = bh;
    }
    const b = this.bloomCanvas.getContext('2d')!;
    b.globalCompositeOperation = 'copy';
    if (SUPPORTS_FILTER) b.filter = 'blur(3px) contrast(1.7) brightness(1.15)';
    b.drawImage(this.canvas, 0, 0, bw, bh);
    b.filter = 'none';
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(0.6 * config.glow, 0, 1);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.bloomCanvas, 0, 0, cw, ch);
    ctx.restore();
  }

  private drawProjectiles(game: Game): void {
    const ctx = this.ctx;
    for (const p of game.projectiles) {
      if (p.kind === 'missile') {
        const sp = Math.hypot(p.vel.x, p.vel.y) || 1;
        const path = new Path2D();
        path.moveTo(p.pos.x, p.pos.y);
        path.lineTo(p.pos.x - (p.vel.x / sp) * 14, p.pos.y - (p.vel.y / sp) * 14);
        glow(ctx, path, COLORS.missile, 2, config.glow);
      } else if (p.kind === 'enemy') {
        const sp = Math.hypot(p.vel.x, p.vel.y) || 1;
        const tail = new Path2D();
        tail.moveTo(p.pos.x, p.pos.y);
        tail.lineTo(p.pos.x - (p.vel.x / sp) * 10, p.pos.y - (p.vel.y / sp) * 10);
        glow(ctx, tail, COLORS.enemyShot, 2, 0.6 * config.glow);
        dot(ctx, p.pos.x, p.pos.y, 3, COLORS.enemyShot);
      }
    }
  }

  private drawParticles(game: Game): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of game.particles) {
      const a = p.life / p.maxLife;
      ctx.globalAlpha = a;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.size;
      ctx.beginPath();
      ctx.moveTo(p.pos.x, p.pos.y);
      ctx.lineTo(p.pos.x - p.vel.x * 0.025, p.pos.y - p.vel.y * 0.025);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawRings(game: Game): void {
    for (const r of game.rings) {
      const k = r.t / r.life;
      const p = new Path2D();
      p.arc(r.pos.x, r.pos.y, r.radius * (0.2 + 0.8 * Math.sqrt(k)), 0, Math.PI * 2);
      glow(this.ctx, p, r.color, 2 * (1 - k) + 0.3, (1 - k) * config.glow);
    }
  }

  // -------------------------------------------------------------- HUD

  private drawHud(game: Game): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';

    // score "pop" when it changes
    if (game.score !== this.lastScore) {
      this.scorePop = 1;
      this.lastScore = game.score;
    }
    this.scorePop = Math.max(0, this.scorePop - this.frameDt * 2.5);

    // ---- top left: score + lives, in neon brackets
    brackets(ctx, 14, 10, 380, 176, COLORS.heli, 0.6);
    const pop = this.scorePop;
    text(ctx, String(game.score).padStart(6, '0'), 32, 60, 66 + pop * 12, pop > 0 ? '#fff4b0' : COLORS.heli, 'left');
    text(ctx, 'SCORE', 36, 106, 20, C.hud, 'left', 0.85);
    const lf = game.lifeFlash;
    for (let i = 0; i < Math.max(0, game.lives); i++) this.drawLifeIcon(70 + i * 84, 148, 0.95 * (i === game.lives - 1 ? 1 + lf * 0.4 * Math.abs(Math.sin(this.clock * 10)) : 1));
    if (lf > 0) text(ctx, '1UP!', 70 + game.lives * 84 - 14, 148, 34, '#3dff8a', 'left', Math.min(1, lf * 2));

    // ---- top right: time, rescued, orb lamp, in neon brackets
    brackets(ctx, this.w - 380, 10, 366, 196, C.hud, 0.6);
    const t = game.bonusTime;
    const mm = Math.floor(t / 60);
    const ss = (t % 60).toFixed(1).padStart(4, '0');
    const out = t <= 0;
    text(ctx, `${mm}:${ss}`, this.w - 32, 58, 60, out ? 'rgba(159,232,255,0.4)' : C.hud, 'right');
    text(ctx, 'TIME BONUS', this.w - 32, 100, 20, C.hud, 'right', out ? 0.35 : 0.85);
    if (game.survivors.length) {
      const saved = game.survivors.filter((s) => s.state === 'rescued').length;
      text(ctx, `RESCUED ${saved}/${game.survivors.length}`, this.w - 32, 136, 28, COLORS.survivor, 'right', 1);
    }
    const lx = this.w - 50;
    const ly = 176;
    const lit = game.orb.delivered;
    text(ctx, 'ORB', lx - 30, ly, 26, COLORS.orb, 'right', lit ? 1 : 0.5);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = lit ? COLORS.orb : 'rgba(255,61,242,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(lx, ly, 15, 0, Math.PI * 2);
    ctx.stroke();
    if (lit) {
      const pulse = 0.8 + 0.2 * Math.sin(this.clock * 5);
      const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, 34 * pulse);
      g.addColorStop(0, 'rgba(255,230,252,1)');
      g.addColorStop(0.3, 'rgba(255,61,242,0.75)');
      g.addColorStop(1, 'rgba(255,61,242,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(lx, ly, 34 * pulse, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // ---- bottom centre: an analog fuel gauge
    this.drawFuelGauge(game);

    // ---- centre messages
    const m = game.message;
    if (m) {
      const fadeIn = clamp(m.t / 0.15, 0, 1);
      const fadeOut = clamp((m.life - m.t) / 0.4, 0, 1);
      const a = Math.min(fadeIn, fadeOut);
      // below the corner panels, and shrunk only if the screen is too narrow for it
      const size = Math.min(68, (this.w * 0.92) / (m.text.length * 0.62));
      const my = 250;
      text(ctx, m.text, this.w / 2, my, size, m.color, 'center', a);
      if (m.sub) text(ctx, m.sub, this.w / 2, my + size * 0.75, Math.min(24, (this.w * 0.92) / (m.sub.length * 0.62)), C.hud, 'center', a * 0.9);
      if (game.tally && game.tally.stage !== 'done') this.drawTally(game, my + size * 0.9);
    }

    if (this.paused) {
      ctx.fillStyle = 'rgba(2,1,9,0.55)';
      ctx.fillRect(0, 0, this.w, this.h);
      text(ctx, 'PAUSED', this.w / 2, this.h / 2, 96, C.hud, 'center');
    }
  }
}

// -------------------------------------------------------------- helpers

function glow(ctx: CanvasRenderingContext2D, path: Path2D, color: string | CanvasGradient, width: number, intensity = 1): void {
  if (intensity <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const passes: [number, number][] = [
    [7, 0.05],
    [4, 0.1],
    [2.2, 0.22],
    [1, 0.9],
  ];
  for (const [mul, a] of passes) {
    ctx.globalAlpha = clamp(a * intensity, 0, 1);
    ctx.lineWidth = width * mul;
    ctx.stroke(path);
  }
  ctx.globalAlpha = clamp(0.55 * intensity, 0, 1);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(0.5, width * 0.35);
  ctx.stroke(path);
  ctx.restore();
}

/**
 * Tileable nebula: several layers of soft, wrapped fractal noise tinted magenta, violet, teal
 * and a touch of amber, masked so they form wisps and patches with dark gaps. Very faint.
 */
function nebulaTexture(): HTMLCanvasElement {
  const N = 384;
  let seed = 777;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const octave = (g: number) => {
    const v = new Float32Array(g * g);
    for (let i = 0; i < v.length; i++) v[i] = rnd();
    return (x: number, y: number) => {
      const fx = (x / N) * g;
      const fy = (y / N) * g;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const at = (i: number, j: number) => v[(((j % g) + g) % g) * g + (((i % g) + g) % g)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const fbm = () => {
    const os = [octave(3), octave(6), octave(12), octave(24), octave(48)];
    return (x: number, y: number) => {
      let h = 0;
      let a = 0.5;
      for (const o of os) {
        h += o(x, y) * a;
        a *= 0.5;
      }
      return h / 0.97;
    };
  };
  const layers: [ReturnType<typeof fbm>, [number, number, number], number, number][] = [
    [fbm(), [190, 40, 170], 0.5, 0.8], // magenta
    [fbm(), [80, 50, 220], 0.47, 0.9], // violet
    [fbm(), [20, 140, 170], 0.52, 0.75], // teal
    [fbm(), [230, 110, 40], 0.6, 0.5], // amber wisps
  ];
  // domain warp: bends the clouds into swirls and filaments instead of round blobs
  const warpX = fbm();
  const warpY = fbm();
  const dust = fbm(); // dark dust lanes cutting through
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const g = c.getContext('2d')!;
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const wx = x + (warpX(x, y) - 0.5) * N * 0.35;
      const wy = y + (warpY(x, y) - 0.5) * N * 0.35;
      let r = 0;
      let gg = 0;
      let b = 0;
      for (const [f, col, thresh, k] of layers) {
        const v = Math.max(0, f(wx, wy) - thresh) / (1 - thresh);
        const a = Math.pow(v, 1.3) * k;
        r += col[0] * a;
        gg += col[1] * a;
        b += col[2] * a;
      }
      const lane = 1 - Math.max(0, Math.min(1, (dust(wx * 1.3, wy * 1.3) - 0.45) * 3));
      const i = (y * N + x) * 4;
      img.data[i] = Math.min(255, r * 0.42 * lane);
      img.data[i + 1] = Math.min(255, gg * 0.42 * lane);
      img.data[i + 2] = Math.min(255, b * 0.42 * lane);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/**
 * A tileable stone texture (built once): layered value noise for mottled rock, ridged noise for
 * lighter mineral veins, relief shading lit from the upper left, and fine grain/speckles.
 */
function rockTexture(): HTMLCanvasElement {
  const N = 512;
  let seed = 4242;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const lattice = (g: number) => {
    const v = new Float32Array(g * g);
    for (let i = 0; i < v.length; i++) v[i] = rnd();
    return v;
  };
  const octave = (g: number) => {
    const v = lattice(g);
    return (x: number, y: number) => {
      const fx = (x / N) * g;
      const fy = (y / N) * g;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const at = (i: number, j: number) => v[(((j % g) + g) % g) * g + (((i % g) + g) % g)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const oct = [octave(4), octave(8), octave(16), octave(32), octave(64)];
  const vein = [octave(6), octave(12), octave(24)];
  const H = new Float32Array(N * N);
  const V = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let h = 0;
      let amp = 0.5;
      for (const o of oct) {
        h += o(x, y) * amp;
        amp *= 0.5;
      }
      H[y * N + x] = h / 0.97;
      let r = 0;
      let ra = 0.6;
      for (const o of vein) {
        r += (1 - Math.abs(o(x, y) * 2 - 1)) * ra;
        ra *= 0.5;
      }
      V[y * N + x] = Math.pow(Math.min(1, r / 1.05), 9);
    }
  }
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const g = c.getContext('2d')!;
  const img = g.createImageData(N, N);
  const at = (x: number, y: number) => H[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const h = H[i];
      const relief = Math.max(0.55, Math.min(1.45, 1 + (at(x - 1, y - 1) - at(x + 1, y + 1)) * 9));
      let r = 12 + h * 30;
      let gg = 16 + h * 34;
      let b = 36 + h * 62;
      const v = V[i];
      r += v * 55;
      gg += v * 70;
      b += v * 120;
      const grain = (rnd() - 0.5) * 10;
      const speck = rnd() < 0.004 ? 40 : rnd() < 0.006 ? -14 : 0;
      img.data[i * 4] = Math.max(0, Math.min(255, r * relief + grain + speck));
      img.data[i * 4 + 1] = Math.max(0, Math.min(255, gg * relief + grain + speck));
      img.data[i * 4 + 2] = Math.max(0, Math.min(255, b * relief + grain + speck * 1.3));
      img.data[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Neon corner brackets framing a HUD panel. */
function brackets(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, alpha: number): void {
  const L = 16;
  const p = new Path2D();
  p.moveTo(x, y + L);
  p.lineTo(x, y);
  p.lineTo(x + L, y);
  p.moveTo(x + w - L, y);
  p.lineTo(x + w, y);
  p.lineTo(x + w, y + L);
  p.moveTo(x + w, y + h - L);
  p.lineTo(x + w, y + h);
  p.lineTo(x + w - L, y + h);
  p.moveTo(x + L, y + h);
  p.lineTo(x, y + h);
  p.lineTo(x, y + h - L);
  glow(ctx, p, color, 1.5, alpha * config.glow);
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  ctx.arc(x, y, r * 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function text(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign,
  alpha = 1,
): void {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.font = `bold ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.8;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = clamp(alpha * 0.6, 0, 1);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(s, x, y);
  ctx.restore();
}
