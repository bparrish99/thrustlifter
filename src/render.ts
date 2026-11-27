import { config } from './config';
import { minimapBounds, type MapBounds } from './minimap';
import { stepCamera } from './camera';
import { BALLOON_R, COLORS, FUEL_TICKS, POINTS, SHIELD_RADIUS, balloonGun, TANK_H, TANK_W, TURRET_BARREL, TURRET_RADIUS, toWorldPoint, turretCentre, type Game } from './game';
import type { Level } from './level';
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
  private terrainEdge: Path2D | null = null;
  private rockPattern: CanvasPattern | null = null;
  private cavePattern: CanvasPattern | null = null;
  private nebula: HTMLCanvasElement | null = null;
  private terrainFor: unknown = null;
  private cam = { x: 0, y: 0, init: false };
  private groundY: number | null = null;
  private ceilY: number | null = null;
  private aim: { x?: number; y?: number } = {};
  paused = false;
  private clock = 0;
  private frameDt = 0;
  private fuelNeedle = 1;
  /** Where the HUD put the fuel gauge and its two boxes this frame (screen px), for hints to avoid/point at. */
  private gaugeRect = { x: 0, y: 0, w: 0, h: 0 };
  private hudRects: { l: number; r: number; t: number; b: number }[] = [];
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

  /** Editor camera: when set, the view is fixed here instead of following the heli. */
  camOverride: { x: number; y: number; viewHeight: number } | null = null;
  showHud = true;

  /** World units per screen pixel scale for the current view. */
  get viewScale(): number {
    return this.h / (this.camOverride?.viewHeight ?? config.viewHeight);
  }

  screenToWorld(sx: number, sy: number): Vec {
    const s = this.viewScale;
    return { x: (sx - this.w / 2) / s + this.cam.x, y: (sy - this.h / 2) / s + this.cam.y };
  }

  worldToScreen(p: Vec): Vec {
    const s = this.viewScale;
    return { x: (p.x - this.cam.x) * s + this.w / 2, y: (p.y - this.cam.y) * s + this.h / 2 };
  }

  /** Run `fn` with the context in world coordinates (for editor overlays). */
  withWorld(fn: (ctx: CanvasRenderingContext2D, scale: number) => void): void {
    const ctx = this.ctx;
    const s = this.viewScale;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.w / 2, this.h / 2);
    ctx.scale(s, s);
    ctx.translate(-this.cam.x, -this.cam.y);
    fn(ctx, s);
    ctx.restore();
  }

  /** Run `fn` with the context in CSS-pixel screen coordinates. */
  withScreen(fn: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    fn(ctx, this.w, this.h);
    ctx.restore();
  }

  render(game: Game, dt: number): void {
    this.clock += dt;
    this.frameDt = dt;
    const ctx = this.ctx;
    if (this.terrainFor !== game.level) {
      this.buildTerrain(game);
      this.terrainFor = game.level;
      this.cam.init = false;
      this.groundY = null;
      this.ceilY = null;
    }
    const scale = this.viewScale;
    if (this.camOverride) {
      this.cam.x = this.camOverride.x;
      this.cam.y = this.camOverride.y;
      this.cam.init = true;
    } else {
      this.updateCamera(game, dt, scale);
    }

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
    if (this.showHud) this.drawHud(game);
  }

  /** Jump the camera straight to the heli next frame instead of easing there (after loading a save state). */
  snapCamera(): void {
    this.cam.init = false;
  }

  private updateCamera(game: Game, dt: number, scale: number): void {
    const st = { ...this.cam, groundY: this.groundY, ceilY: this.ceilY, aimX: this.aim.x, aimY: this.aim.y };
    stepCamera(st, game, dt, this.w / 2 / scale, this.h / 2 / scale);
    this.cam.x = st.x;
    this.cam.y = st.y;
    this.cam.init = st.init;
    this.groundY = st.groundY;
    this.ceilY = st.ceilY ?? null;
    this.aim = { x: st.aimX, y: st.aimY };
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
    // the lit edge follows only the surface facing air (seams where rocks overlap stay hidden)
    this.terrainEdge = outlinePath(game.level.outline);
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
        if (this.terrainEdge) ctx.stroke(this.terrainEdge);
      }
      ctx.restore();
    }
    if (this.terrainEdge) glow(ctx, this.terrainEdge, edge, 2, config.glow);

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
    // the far cave wall: dark mottled stone with drips and cracks, drifting slower than the rock in
    // front (parallax) so it reads as distant. Fades in with the backdrop over its first 300.
    if (!this.cavePattern) this.cavePattern = ctx.createPattern(caveTexture(), 'repeat');
    if (this.cavePattern) {
      const k = 0.35; // how much the far wall moves with the camera, vs the foreground's 1
      this.cavePattern.setTransform(new DOMMatrix().translate(this.cam.x * k, this.cam.y * k).scale(2));
      ctx.save();
      ctx.fillStyle = this.cavePattern;
      // fade in as stacked layers, each reaching all the way down, so there are no seams between
      // steps (side-by-side strips leave faint lines where their edges meet)
      const bands = 16;
      let prev = 0;
      for (let i = 0; i < bands; i++) {
        const t = (i + 1) / bands; // total opacity wanted from this step down
        ctx.globalAlpha = 1 - (1 - t) / (1 - prev);
        const top = y0 + (300 * i) / bands;
        ctx.fillRect(-200, top, W + 400, game.level.maxY + 300 - top);
        prev = t;
      }
      ctx.restore();
    }
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
  /**
   * Vertical LED fuel gauge (bottom-left, in its own box): a recessed strip of LED lenses, empty at
   * the bottom, full at the top. Lit LEDs have a hot core, a specular glint and a halo; unlit lenses
   * still catch the light. Red to amber to yellow to green; blinks when low; a light sweeps up it
   * while refuelling.
   */
  private drawFuelGauge(game: Game, x0: number, y0: number, w: number, h: number): void {
    const ctx = this.ctx;
    const k = clamp(game.fuel / config.fuelMax, 0, 1);
    this.fuelNeedle += (k - this.fuelNeedle) * (1 - Math.exp(-6 * this.frameDt));
    const low = k < 0.2;
    const blinkOn = Math.sin(this.clock * 9) > -0.1;
    const segs = FUEL_TICKS;
    const pad = 4;
    const gap = 2;
    const ledW = w - pad * 2;
    const ledH = (h - pad * 2 - gap * (segs - 1)) / segs;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(ctx, x0, y0, w, h, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    roundRect(ctx, x0 + 0.5, y0 + 0.5, w - 1, h - 1, 4);
    ctx.stroke();
    ctx.restore();

    const lit = this.fuelNeedle * segs;
    const sweep = game.refueling ? ((this.clock * 1.6) % 1.4) * segs : -99;
    for (let i = 0; i < segs; i++) {
      const lx = x0 + pad;
      const ly = y0 + h - pad - (i + 1) * ledH - i * gap; // i = 0 at the bottom
      const v = i / (segs - 1);
      const [cr, cg, cb] = v < 0.2 ? [255, 60, 50] : v < 0.45 ? [255, 160, 40] : v < 0.75 ? [255, 225, 70] : [80, 255, 120];
      let on = clamp(lit - i, 0, 1);
      if (low && !blinkOn) on *= 0.25;
      const sw = Math.max(0, 1 - Math.abs(sweep - i) / 2.5) * 0.6;
      const glowK = on > 0 ? on : sw * 0.5;
      const cx = lx + ledW / 2;
      const cy = ly + ledH / 2;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgb(${Math.round(cr * 0.12)},${Math.round(cg * 0.1)},${Math.round(cb * 0.1)})`;
      roundRect(ctx, lx, ly, ledW, ledH, 2);
      ctx.fill();
      if (glowK > 0) {
        ctx.globalCompositeOperation = 'lighter';
        const halo = ctx.createRadialGradient(cx, cy, 1, cx, cy, ledW * 0.9);
        halo.addColorStop(0, `rgba(${cr},${cg},${cb},${0.3 * glowK})`);
        halo.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = halo;
        ctx.fillRect(lx - ledW * 0.5, ly - ledH, ledW * 2, ledH * 3);
        const core = ctx.createRadialGradient(cx, cy, 1, cx, cy, ledW * 0.6);
        core.addColorStop(0, `rgba(255,${Math.min(255, cg + 80)},${Math.min(255, cb + 120)},${glowK})`);
        core.addColorStop(0.45, `rgba(${cr},${cg},${cb},${0.95 * glowK})`);
        core.addColorStop(1, `rgba(${Math.round(cr * 0.5)},${Math.round(cg * 0.4)},${Math.round(cb * 0.3)},${0.8 * glowK})`);
        ctx.fillStyle = core;
        roundRect(ctx, lx, ly, ledW, ledH, 2);
        ctx.fill();
      }
      // specular glint along the top of each lens (always there; brighter when lit)
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,255,255,${0.1 + 0.3 * glowK})`;
      roundRect(ctx, lx + 2, ly + 0.8, ledW - 4, Math.max(1, ledH * 0.35), 1);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.2 + 0.5 * glowK})`;
      ctx.beginPath();
      ctx.ellipse(lx + ledW * 0.25, ly + ledH * 0.35, 1.8, Math.max(0.8, ledH * 0.18), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    text(ctx, 'F', x0 + w + 13, y0 + 8, 14, '#50ff78', 'center', 0.85);
    text(ctx, 'E', x0 + w + 13, y0 + h - 8, 14, '#ff6a6a', 'center', 0.85);
  }

  /** The end-of-level bonus tally, big in the middle of the screen: rescues (if any), time, fuel. */
  private drawTally(game: Game, y: number): void {
    const t = game.tally!;
    const pulse = 1 + 0.06 * Math.sin(this.clock * 30);
    let row = y + 40;
    // rescue bonus line: a hostage per rescue, each lighting up (with a pop) as it's paid
    if (t.rescuesTotal > 0) {
      const on = t.stage === 'rescue' || (t.stage === 'intro' && t.rescues > 0);
      const paid = t.rescuesTotal - t.rescues;
      text(this.ctx, 'RESCUE BONUS', this.w / 2 - 30, row, 30, COLORS.survivor, 'right', on ? 1 : 0.45);
      for (let i = 0; i < t.rescuesTotal; i++) {
        const lit = i < paid;
        const justPaid = lit && i === paid - 1 && t.stage === 'rescue' ? Math.max(0, 1 - t.t / 0.35) : 0;
        this.drawHostageIcon(this.w / 2 + 44 + i * 40, row + 22, 2.1 * (1 + justPaid * 0.35), lit ? 1 : 0.3);
      }
      const after = this.w / 2 + 44 + t.rescuesTotal * 40;
      text(this.ctx, `${paid} × ${POINTS.rescue}`, after, row, 52 * (on && t.t < 0.25 && paid > 0 ? pulse : 1), paid > 0 ? COLORS.survivor : 'rgba(157,255,157,0.45)', 'left', on ? 1 : 0.6);
      row += 70;
    }
    // time bonus line
    const timeOn = t.stage === 'time' || t.stage === 'pause' || (t.stage === 'intro' && t.rescuesTotal === 0);
    const tt = game.bonusTime;
    const clock = `${Math.floor(tt / 60)}:${(tt % 60).toFixed(1).padStart(4, '0')}`;
    text(this.ctx, 'TIME BONUS', this.w / 2 - 30, row, 30, C.hud, 'right', timeOn ? 1 : 0.45);
    text(this.ctx, clock, this.w / 2 + 30, row, 52 * (t.stage === 'time' ? pulse : 1), t.tenths > 0 ? '#3dff8a' : 'rgba(61,255,138,0.45)', 'left');
    row += 70;
    // fuel bonus line
    const fuelOn = t.stage === 'fuel';
    text(this.ctx, 'FUEL BONUS', this.w / 2 - 30, row, 30, C.fuelPad, 'right', fuelOn ? 1 : 0.45);
    text(this.ctx, `${t.ticks} × ${POINTS.perFuelTick}`, this.w / 2 + 30, row, 52 * (fuelOn ? pulse : 1), t.ticks > 0 ? C.fuelPad : 'rgba(255,225,77,0.45)', 'left');
  }

  /** A little hostage (the same figure as in the level, standing, arms down) for the carried count. */
  private drawHostageIcon(x: number, y: number, k: number, alpha = 1): void {
    drawPerson(this.ctx, x, y, k, 'idle', 1, 0, alpha, true);
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

  /** Hostages: small solid figures (not stick men). Wave when you're near, run when called, scurry off the pad when home. */
  private drawSurvivors(game: Game): void {
    const ctx = this.ctx;
    const near = (x: number) => Math.abs(game.heli.pos.x - x) < 700 && game.alive;
    for (const s of game.survivors) {
      if (s.state === 'waiting') drawPerson(ctx, s.pos.x, s.pos.y, 1, near(s.pos.x) ? 'wave' : 'idle', s.dir, s.t + s.pos.x * 0.37);
      else if (s.state === 'running') drawPerson(ctx, s.pos.x, s.pos.y, 1, 'run', s.dir, s.t);
    }
    for (const d of game.disembarking) if (d.t > 0) drawPerson(ctx, d.pos.x, d.pos.y, 1, 'run', -1, d.t, Math.max(0, 1 - d.t / 2.5));
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

  private minimapCache: { level: Level; w: number; h: number; dpr: number; img: HTMLCanvasElement; bounds: MapBounds } | null = null;

  /**
   * Whole-level minimap, lower right, in neon corner brackets like the other HUD panels. No text:
   * rock in miniature, your heli (blinking), the orb (travels with you when carried), bowl, pads,
   * fuel tanks, closed gates (no enemies, on purpose), and a faint box for what's on screen.
   */
  private drawMinimap(game: Game): void {
    const ctx = this.ctx;
    const level = game.level;
    const maxW = Math.min(300, this.w * 0.25);
    const maxH = 150;
    let cache = this.minimapCache;
    if (!cache || cache.level !== level || cache.dpr !== this.dpr || cache.w > maxW + 0.5 || (cache.w < maxW - 0.5 && cache.h < maxH - 0.5)) {
      const bounds = minimapBounds(level.data);
      const k = Math.min(maxW / (bounds.x1 - bounds.x0), maxH / (bounds.y1 - bounds.y0));
      const w = (bounds.x1 - bounds.x0) * k;
      const h = (bounds.y1 - bounds.y0) * k;
      const img = document.createElement('canvas');
      img.width = Math.ceil(w * this.dpr);
      img.height = Math.ceil(h * this.dpr);
      const c = img.getContext('2d')!;
      c.scale(this.dpr * k, this.dpr * k);
      c.translate(-bounds.x0, -bounds.y0);
      const paths = level.polygons.map((poly) => {
        const p = new Path2D();
        poly.forEach((v, i) => (i ? p.lineTo(v.x, v.y) : p.moveTo(v.x, v.y)));
        p.closePath();
        return p;
      });
      c.fillStyle = 'rgba(20,40,90,0.95)';
      for (const p of paths) c.fill(p);
      c.strokeStyle = C.terrain;
      c.globalAlpha = 0.8;
      c.lineWidth = 1.4 / k;
      c.lineJoin = 'round';
      c.stroke(outlinePath(level.outline));
      cache = this.minimapCache = { level, w, h, dpr: this.dpr, img, bounds };
    }
    const { w, h, bounds } = cache;
    const k = w / (bounds.x1 - bounds.x0);
    const x0 = this.w - w - 30;
    const y0 = this.h - h - 26;
    const toMap = (p: Vec) => ({ x: x0 + (p.x - bounds.x0) * k, y: y0 + clamp(p.y - bounds.y0, 0, bounds.y1 - bounds.y0) * k });

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(2,1,9,0.72)';
    ctx.fillRect(x0 - 6, y0 - 6, w + 12, h + 12);
    ctx.drawImage(cache.img, x0, y0, w, h);
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.clip();

    // what's on screen
    const tl = toMap(this.screenToWorld(0, 0));
    const br = toMap(this.screenToWorld(this.w, this.h));
    ctx.strokeStyle = 'rgba(159,232,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

    // closed gates
    ctx.strokeStyle = C.gate;
    ctx.lineWidth = 2;
    for (const g of level.gates) {
      if (g.fade > 0.5) continue;
      ctx.beginPath();
      g.pts.forEach((v, i) => {
        const m = toMap(v);
        i ? ctx.lineTo(m.x, m.y) : ctx.moveTo(m.x, m.y);
      });
      ctx.closePath();
      ctx.stroke();
    }

    const pip = (p: Vec, color: string, r: number, square = false) => {
      const m = toMap(p);
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      if (square) ctx.fillRect(m.x - r, m.y - r, r * 2, r * 2);
      else {
        ctx.beginPath();
        ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const bar = (x: number, y: number, wd: number, color: string) => {
      const a = toMap({ x, y });
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.fillRect(a.x, a.y - 3, Math.max(4, wd * k), 3);
    };
    for (const p of level.data.pads) bar(p.x, p.y, p.w, p.kind === 'start' ? C.startPad : C.padSafe);
    bar(level.bowl.cx - level.bowl.halfW, level.bowl.rimY + 20, level.bowl.halfW * 2, C.bowl);
    for (const t of game.fuelTanks) if (t.alive) pip({ x: t.pos.x, y: t.pos.y - 10 }, COLORS.fuel, 2, true);
    // enemies are deliberately left off (owner's call): you find them by flying
    const orb = game.orb;
    if (!orb.delivered && orb.pos.x > -9999) pip(orb.pos, COLORS.orb, 3);
    if (game.alive && Math.sin(this.clock * 8) > -0.6) pip(game.heli.pos, COLORS.heli, 3.2);
    ctx.restore();
    brackets(ctx, x0 - 12, y0 - 12, w + 24, h + 24, C.hud, 0.6);
  }

  /**
   * First-level hints, each floating above what it's about with a little arrow pointing down at it.
   * Hints are independent, so several can be up at once: a box that would overlap one already placed
   * (earlier hints keep their spot) stacks above it, with a thin line down to its target.
   */
  private drawTips(game: Game): void {
    const tips = game.tutorial?.views ?? [];
    const ctx = this.ctx;
    const size = 22;
    const lineH = size * 1.25;
    const bob = Math.sin(this.clock * 3) * 4; // float gently (all together, so stacks stay neat)
    const placed: { l: number; r: number; t: number; b: number }[] = [];
    for (const tip of tips) {
      if (tip.alpha <= 0) continue;
      let ax: number;
      let ay: number; // the point the arrow touches (screen px)
      // hints float above what they point at (things in the world, or the fuel gauge) with an arrow down
      const up = false; // (an up-pointing hint below a HUD box is supported, but nothing uses it now)
      if (tip.at === 'fuelGauge') {
        // sits above the bottom-left gauge, pointing down at it
        ax = this.gaugeRect.x + this.gaugeRect.w / 2;
        ay = this.gaugeRect.y - 18;
      } else {
        const p = this.worldToScreen(tip.at.world);
        ax = p.x;
        ay = p.y - tip.at.lift * this.viewScale;
        if (ax < -40 || ax > this.w + 40 || ay < 40 || ay > this.h + 40) continue; // off screen
      }
      ctx.save();
      ctx.font = `bold ${size}px ${FONT}`;
      const tw = Math.max(...tip.lines.map((l) => ctx.measureText(l).width));
      ctx.restore();
      const boxW = tw + 36;
      const boxH = tip.lines.length * lineH + 16;
      // where the box wants to be: just above its target (or just below, pointing up)
      const aim = up ? ay + 14 + bob : ay - 16 + bob - boxH;
      let cx = clamp(ax, boxW / 2 + 12, this.w - boxW / 2 - 12);
      // never cover a HUD box: slide sideways clear of it (never up or down, which would leave the
      // box far from its target with a long line to it)
      for (const o of this.hudRects) {
        const overlaps = cx - boxW / 2 < o.r + 8 && cx + boxW / 2 > o.l - 8 && aim + boxH > o.t - 6 && aim < o.b + 6;
        if (!overlaps) continue;
        cx = (o.l + o.r) / 2 < this.w / 2 ? o.r + 10 + boxW / 2 : o.l - 10 - boxW / 2;
      }
      const l = cx - boxW / 2;
      const r = cx + boxW / 2;
      const hits = (o: { l: number; r: number; t: number; b: number }, top: number, gapY: number) =>
        l < o.r + 8 && r > o.l - 8 && top + boxH > o.t - gapY && top < o.b + gapY;
      const wantTop = aim;
      // stack clear of hints already placed: upward for down-pointing hints, downward for up-pointing ones
      let top = wantTop;
      for (let moved = true; moved; ) {
        moved = false;
        for (const o of placed) {
          if (hits(o, top, 22)) {
            top = up ? o.b + 22 : o.t - 22 - boxH;
            moved = true;
          }
        }
      }
      const bottom = top + boxH;
      placed.push({ l, r, t: top, b: bottom });
      const a = tip.alpha;
      ctx.save();
      ctx.globalAlpha = a * 0.82;
      ctx.fillStyle = '#05040f';
      roundRect(ctx, l, top, boxW, boxH, 6);
      ctx.fill();
      ctx.globalAlpha = a;
      ctx.strokeStyle = COLORS.heli;
      ctx.lineWidth = 2;
      ctx.shadowColor = COLORS.heli;
      ctx.shadowBlur = 12;
      ctx.stroke();
      // arrow at the thing (a thin line first if the box got moved out of the way)
      const tipX = clamp(ax, l + 14, r - 14);
      const edge = up ? top : bottom; // the box edge facing the target
      // the arrow sits where the box wanted to be; if the box had to move, a thin line joins them
      const arrowBase = up ? aim : aim + boxH;
      if (Math.abs(edge - arrowBase) > 0.5) {
        ctx.globalAlpha = a * 0.6;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(tipX, edge);
        ctx.lineTo(tipX, arrowBase);
        ctx.stroke();
        ctx.globalAlpha = a;
      }
      const dir = up ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(tipX - 10, arrowBase + dir);
      ctx.lineTo(tipX, arrowBase + 13 * dir);
      ctx.lineTo(tipX + 10, arrowBase + dir);
      ctx.fillStyle = COLORS.heli;
      ctx.fill();
      ctx.restore();
      tip.lines.forEach((ln, i) => text(ctx, ln, cx, top + 8 + lineH * (i + 0.5), size, i === 0 ? '#fff4b0' : C.hud, 'center', a));
    }
  }

  private drawHud(game: Game): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';

    // score "pop" when it changes
    if (game.score !== this.lastScore) {
      this.scorePop = 1;
      this.lastScore = game.score;
    }
    this.scorePop = Math.max(0, this.scorePop - this.frameDt * 2.5);

    // ---- top left, one line: score then lives, in a compact translucent box
    const rowH = 52;
    const rowY = 10 + rowH / 2; // centre line of both top boxes
    const pop = this.scorePop;
    const lives = Math.max(0, game.lives);
    const lf = game.lifeFlash;
    const scoreStr = String(game.score).padStart(6, '0');
    ctx.save();
    ctx.font = `bold 32px ${FONT}`;
    const scoreW = ctx.measureText(scoreStr).width;
    ctx.restore();
    const lifeX0 = 24 + scoreW + 42; // icon centres (each reaches ~22px left of its centre, tail first)
    const lw = lifeX0 - 12 + (lives - 1) * 48 + 30 + (lf > 0 ? 64 : 0);
    hudBox(ctx, 12, 10, lw, rowH, COLORS.heli);
    text(ctx, scoreStr, 24, rowY + 1, 32 + pop * 6, pop > 0 ? '#fff4b0' : COLORS.heli, 'left');
    for (let i = 0; i < lives; i++) this.drawLifeIcon(lifeX0 + i * 48, rowY + 3, 0.45 * (i === lives - 1 ? 1 + lf * 0.4 * Math.abs(Math.sin(this.clock * 10)) : 1));
    if (lf > 0) text(ctx, '1UP!', lifeX0 + lives * 48 - 16, rowY, 20, '#3dff8a', 'left', Math.min(1, lf * 2));

    // ---- top right, one line: time bonus, hostage icon + rescued count, orb lamp (no labels)
    const t = game.bonusTime;
    const clockStr = `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
    const out = t <= 0;
    // hostages you're carrying right now, out of the level's total
    const rescuedStr = game.survivors.length ? `${game.survivors.filter((s) => s.state === 'aboard').length}/${game.survivors.length}` : '';
    ctx.save();
    ctx.font = `bold 30px ${FONT}`;
    const clockW = ctx.measureText('0:00.0').width; // fixed width so the box doesn't twitch
    ctx.font = `bold 24px ${FONT}`;
    const rescW = rescuedStr ? ctx.measureText(rescuedStr).width : 0;
    ctx.restore();
    const orbR = 11;
    const figsW = 15; // one little figure, so you know what the count is
    const bw = 16 + clockW + (rescuedStr ? 24 + figsW + 10 + rescW : 0) + 24 + orbR * 2 + 16;
    const bh = rowH;
    const bx = this.w - 12 - bw;
    const by = 10;
    hudBox(ctx, bx, by, bw, bh, C.hud);
    let cx = bx + 16;
    text(ctx, clockStr, cx, rowY + 1, 30, out ? 'rgba(159,232,255,0.4)' : C.hud, 'left');
    cx += clockW + 24;
    if (rescuedStr) {
      this.drawHostageIcon(cx + 6, rowY + 12, 1.25);
      cx += figsW + 10;
      text(ctx, rescuedStr, cx, rowY + 1, 24, COLORS.survivor, 'left', 1);
      cx += rescW + 24;
    }
    const lx = cx + orbR;
    const ly = rowY;

    // ---- bottom left: a big vertical fuel gauge in its own translucent box
    const gh = Math.round(Math.min(255, this.h * 0.34));
    const gw = 30;
    const fbw = gw + 36; // room for the F/E marks to its right
    const fbh = gh + 20;
    const fbx = 12;
    const fby = this.h - 12 - fbh;
    hudBox(ctx, fbx, fby, fbw, fbh, C.hud);
    const gx = fbx + 10;
    const gy = fby + 10;
    this.gaugeRect = { x: gx, y: gy, w: gw, h: gh };
    this.hudRects = [
      { l: 12, r: 12 + lw, t: 10, b: 10 + rowH },
      { l: bx, r: bx + bw, t: by, b: by + bh },
      { l: fbx, r: fbx + fbw, t: fby, b: fby + fbh },
    ];
    this.drawFuelGauge(game, gx, gy, gw, gh);

    const lit = game.orb.delivered;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = lit ? COLORS.orb : 'rgba(255,61,242,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(lx, ly, orbR, 0, Math.PI * 2);
    ctx.stroke();
    if (lit) {
      const pulse = 0.8 + 0.2 * Math.sin(this.clock * 5);
      const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, 26 * pulse);
      g.addColorStop(0, 'rgba(255,230,252,1)');
      g.addColorStop(0.3, 'rgba(255,61,242,0.75)');
      g.addColorStop(1, 'rgba(255,61,242,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(lx, ly, 26 * pulse, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // ---- bottom right: minimap
    this.drawMinimap(game);

    // ---- first-level tutorial hint
    this.drawTips(game);

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

/** A path along rock edges, joining edges that meet end to end (so corners are drawn as corners). */
function outlinePath(edges: [Vec, Vec][]): Path2D {
  const p = new Path2D();
  let last: Vec | null = null;
  for (const [a, b] of edges) {
    if (!last || Math.abs(last.x - a.x) > 0.01 || Math.abs(last.y - a.y) > 0.01) p.moveTo(a.x, a.y);
    p.lineTo(b.x, b.y);
    last = b;
  }
  return p;
}

/**
 * A person, short and stocky (about 17 tall), standing with feet at (x, y): a solid silhouette (head, tapered torso,
 * jointed arms and legs) with a soft glow, posed for idling, waving for help, or running. `dir` is
 * the way they face (1 = right). `still` freezes the pose (HUD icon).
 */
/** Far-side arm and leg: a darker shade, so the figure has some depth. */
const FAR_SURVIVOR = '#4f9a5c';

function drawPerson(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, mode: 'idle' | 'wave' | 'run', dir: number, t: number, alpha = 1, still = false): void {
  // angles are measured from hanging straight down; positive swings toward the way they face
  const seg = (from: { x: number; y: number }, ang: number, len: number) => ({ x: from.x + Math.sin(ang) * dir * len * k, y: from.y + Math.cos(ang) * len * k });
  const run = mode === 'run';
  const ph = still ? 0 : t * 15;
  const lean = run ? 0.22 : 0;
  const breathe = still || run ? 0 : Math.sin(t * 2.2) * 0.25;
  const bob = run ? Math.abs(Math.sin(ph)) * 0.9 : 0;
  const hip = { x, y: y - (7 + bob) * k };
  const shoulder = { x: hip.x + Math.sin(lean) * dir * 6 * k, y: hip.y - (6 - breathe * 0.4) * k };
  const head = { x: shoulder.x + Math.sin(lean) * dir * 3.4 * k, y: shoulder.y - 3.4 * k };
  // legs: thigh swing and knee bend through a stride (left and right half a cycle apart)
  const leg = (off: number) => {
    const p = ph + off;
    const thigh = run ? Math.sin(p) * 0.75 : off ? -0.16 : 0.16;
    const knee = run ? thigh - (0.25 + Math.max(0, -Math.cos(p)) * 1.3) : thigh - 0.05;
    // each leg hangs from its own side of the hips (off = 0: the near side)
    const at = { x: hip.x + (off ? -1 : 1) * dir * (run ? 0.6 : 1.5) * k, y: hip.y };
    const kn = seg(at, thigh, 3.7);
    return [at, kn, seg(kn, knee, 3.5)] as const;
  };
  // arms swing opposite the legs when running; hang loosely when idle; one waves when you're near
  // arms hang from the shoulder edges (from the middle they'd be hidden inside the stocky body)
  const arm = (off: number, waving: boolean) => {
    const side = off ? 1 : -1; // +1: the near side (the way they face)
    const at = { x: shoulder.x + side * dir * (run ? 1 : 3) * k, y: shoulder.y + 0.6 * k };
    if (waving) {
      // elbow out, forearm up and clear of the head, waving
      const up = seg(at, Math.PI / 2 + 0.15, 3.4);
      return [at, up, seg(up, Math.PI - 0.35 + Math.sin(t * 9) * 0.35, 3.4)] as const;
    }
    const sw = run ? -Math.sin(ph + off) * 0.9 : side * (0.22 + breathe * 0.1);
    const el = seg(at, sw, 3.4);
    return [at, el, seg(el, sw + (run ? 1.4 : side * 0.08), 3.2)] as const;
  };
  const limbs = [leg(Math.PI), arm(0, false), leg(0), arm(Math.PI, mode === 'wave')];
  const col = COLORS.survivor;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'source-over'; // solid, not additive: overlapping parts stay one colour
  ctx.shadowColor = col;
  ctx.shadowBlur = 3 * k * config.glow;
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // far-side limbs dimmer, for a bit of depth
  limbs.forEach(([a, b, c], i) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = i < 2 ? FAR_SURVIVOR : col;
    ctx.lineWidth = (i % 2 === 0 ? 3.4 : 2.7) * k;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.stroke();
    if (i === 1) {
      // torso (drawn between the far and near limbs): shoulders wider than hips
      ctx.fillStyle = col;
      const ux = shoulder.x - hip.x, uy = shoulder.y - hip.y;
      const ul = Math.hypot(ux, uy) || 1;
      const nx = -uy / ul, ny = ux / ul;
      ctx.beginPath();
      ctx.moveTo(hip.x + nx * 3.2 * k, hip.y + ny * 3.2 * k);
      ctx.lineTo(shoulder.x + nx * 3.8 * k, shoulder.y + ny * 3.8 * k);
      ctx.lineTo(shoulder.x - nx * 3.8 * k, shoulder.y - ny * 3.8 * k);
      ctx.lineTo(hip.x - nx * 3.2 * k, hip.y - ny * 3.2 * k);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1.6 * k; // round off the torso's corners
      ctx.strokeStyle = col;
      ctx.stroke();
      // head
      ctx.beginPath();
      ctx.ellipse(head.x, head.y, 2.7 * k, 2.8 * k, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.restore();
}

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
/** The far wall behind caves: very dark, low-contrast stone with vertical drip streaks and faint cracks. */
function caveTexture(): HTMLCanvasElement {
  const N = 512;
  let seed = 9001;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  /** Tiling value noise with gx x gy cells (different counts across and down stretch the features). */
  const octave = (gx: number, gy: number) => {
    const v = new Float32Array(gx * gy);
    for (let i = 0; i < v.length; i++) v[i] = rnd();
    return (x: number, y: number) => {
      const fx = (x / N) * gx;
      const fy = (y / N) * gy;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const sx = (fx - x0) * (fx - x0) * (3 - 2 * (fx - x0));
      const sy = (fy - y0) * (fy - y0) * (3 - 2 * (fy - y0));
      const at = (i: number, j: number) => v[(((j % gy) + gy) % gy) * gx + (((i % gx) + gx) % gx)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const blotch = [octave(3, 3), octave(6, 6), octave(12, 12), octave(24, 24), octave(48, 48)];
  const drip = [octave(8, 3), octave(16, 5)]; // narrower across than down: soft vertical seeping
  const crack = [octave(5, 5), octave(10, 10)];
  const H = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let h = 0;
      let amp = 0.5;
      for (const o of blotch) {
        h += o(x, y) * amp;
        amp *= 0.5;
      }
      let d = 0;
      let da = 0.5;
      for (const o of drip) {
        d += o(x, y) * da;
        da *= 0.5;
      }
      H[y * N + x] = h * 0.9 + d * 0.25;
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
      const h = at(x, y);
      // light from above-left: a hint of relief so it reads as rough stone, not fog
      const relief = 1 + (at(x - 2, y - 2) - at(x + 2, y + 2)) * 5;
      // thin dark cracks where the crack noise crosses its midline
      let cr = 0;
      for (const o of crack) cr = Math.max(cr, 1 - Math.abs(o(x, y) * 2 - 1) * 28);
      const dark = 1 - Math.max(0, cr) * 0.55;
      const v = Math.max(0, h - 0.3) * relief * dark;
      const grain = (rnd() - 0.5) * 3;
      img.data[i * 4] = Math.max(0, Math.min(255, 4 + v * 34 + grain));
      img.data[i * 4 + 1] = Math.max(0, Math.min(255, 3 + v * 26 + grain));
      img.data[i * 4 + 2] = Math.max(0, Math.min(255, 9 + v * 62 + grain * 1.4));
      img.data[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

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
/** A compact, slightly translucent HUD box with a thin coloured edge. */
function hudBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(6,5,20,0.58)';
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 8);
  ctx.stroke();
  ctx.restore();
}

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
