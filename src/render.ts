import { config } from './config';
import { COLORS, TARGET_RADIUS, targetCentre, type Game } from './game';
import { clamp, lerp, toDeg, type Vec } from './math';
import { ANCHOR, BODY, MAST, ROTOR_R, ROTOR_Y, SKID, SKID_TOE, STRUTS, TAIL_ROTOR_HUB, TAIL_ROTOR_R, toWorld } from './physics';

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
  private cam = { x: 0, y: 0, init: false };
  helpVisible = true;
  paused = false;
  private clock = 0;

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
    const ctx = this.ctx;
    if (this.terrainPaths.length === 0) this.buildTerrain(game);
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
    this.drawPlanet();

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

    this.drawTerrain(game);
    this.drawBowl(game);
    this.drawTargets(game);
    this.drawOrb(game);
    if (game.alive) this.drawHeli(game);
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
    let ty = h.pos.y + h.vel.y * config.camLookahead - config.viewHeight * 0.1; // bias up: more sky, less rock
    if (game.orb.attached) {
      tx = lerp(tx, game.orb.pos.x, 0.3);
      ty = lerp(ty, game.orb.pos.y, 0.3);
    }
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
    this.cam.y = Math.min(this.cam.y, 1400 - this.h / 2 / scale);
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
  }

  private drawTerrain(game: Game): void {
    const ctx = this.ctx;
    const fill = ctx.createLinearGradient(0, 300, 0, 1300);
    fill.addColorStop(0, 'rgb(8,24,56)');
    fill.addColorStop(1, 'rgb(3,4,16)');
    ctx.globalCompositeOperation = 'source-over';
    for (const p of this.terrainPaths) {
      ctx.fillStyle = fill;
      ctx.fill(p);
    }
    // faint contour lines inside the rock for depth
    ctx.save();
    for (const p of this.terrainPaths) ctx.clip(p);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(34,230,255,0.06)';
    ctx.lineWidth = 1;
    for (let y = -1200; y < 1400; y += 28) {
      ctx.beginPath();
      ctx.moveTo(this.cam.x - 2000, y);
      ctx.lineTo(this.cam.x + 2000, y);
      ctx.stroke();
    }
    ctx.restore();
    const edge = ctx.createLinearGradient(0, 350, 0, 1000);
    edge.addColorStop(0, '#5afcff');
    edge.addColorStop(0.5, C.terrain);
    edge.addColorStop(1, '#7a5cff');
    for (const p of this.terrainPaths) glow(ctx, p, edge, 2, config.glow);

    for (const { pad, pts } of game.level.padPolygons) {
      const col = C.startPad;
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
      glow(ctx, top, col, 3, config.glow);
      // landing lights
      const blink = Math.floor(this.clock * 2) % 2 === 0;
      for (let i = 0; i <= 4; i++) {
        const x = pad.x + (pad.w * i) / 4;
        const lit = (i % 2 === 0) === blink;
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = lit ? col : 'rgba(255,255,255,0.15)';
        ctx.fillRect(x - 2, pad.y + 6, 4, 4);
      }
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
    text(ctx, done ? 'DELIVERED' : 'ORB BOWL', bowl.cx, bowl.rimY - 86, 14, col, 'center', done ? 1 : 0.85);
  }

  private drawTargets(game: Game): void {
    const ctx = this.ctx;
    for (const t of game.targets) {
      if (!t.alive) continue;
      const { x, y } = t.pos;
      const p = new Path2D();
      p.moveTo(x - 22, y);
      p.lineTo(x + 22, y);
      p.moveTo(x - TARGET_RADIUS, y);
      p.arc(x, y, TARGET_RADIUS, Math.PI, 0);
      const ang = -Math.PI / 2 + Math.sin(this.clock * 0.8 + x) * 0.9;
      p.moveTo(x, y - 8);
      p.lineTo(x + Math.cos(ang) * 26, y - 8 + Math.sin(ang) * 26);
      glow(ctx, p, COLORS.target, 1.8, config.glow);
      if (Math.sin(this.clock * 6 + x) > 0.3) {
        const c = targetCentre(t);
        dot(ctx, c.x, c.y, 3, COLORS.target);
      }
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
      } else if (game.orb.delivered && game.phase === 'playing' && game.alive) {
      const off = game.padOffset();
      const arrow = off < 0 ? '◀◀' : '▶▶';
      const label = Math.abs(off) < 120 ? 'LAND ON YOUR PAD' : `RETURN TO PAD  ${Math.abs(off).toFixed(0)}`;
      text(ctx, off < 0 ? `${arrow}  ${label}` : `${label}  ${arrow}`, this.w / 2, this.h - 110, 15, '#3dff8a', 'center', 0.75 + 0.25 * Math.sin(this.clock * 5));
    } else if (game.orb.attached && game.orbApproach()) {
      text(ctx, 'SPACE TO RELEASE', this.w / 2, this.h - 110, 13, COLORS.orb, 'center', 0.7);
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
    const ctx = this.ctx;
    const h = game.heli;
    const f = game.facingVis;
    const spin = game.rotorSpin;
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
    ctx.fillStyle = 'rgba(26,18,4,0.95)';
    ctx.fill(boom);
    ctx.fill(fin);
    const tail = new Path2D(boom);
    tail.addPath(fin);
    seg(tail, HELI.ventral[0], HELI.ventral[1]);
    seg(tail, HELI.stab[0], HELI.stab[1]);
    glow(ctx, tail, COLORS.heli, 1.2, glowK);

    // ---- tail rotor: seen face-on from the side, so it's a spinning disc
    const hub = W(TAIL_ROTOR_HUB);
    const tdisc = new Path2D();
    tdisc.arc(hub.x, hub.y, TAIL_ROTOR_R, 0, Math.PI * 2);
    glow(ctx, tdisc, C.rotor, 0.6, (0.08 + spin * 0.3) * glowK);
    const tPhase = game.rotorPhase * 2.6 * Math.sign(f || 1);
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
    fill.addColorStop(0, 'rgba(60,44,8,0.95)');
    fill.addColorStop(1, 'rgba(14,10,2,0.95)');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = fill;
    ctx.fill(hump);
    ctx.fill(body);
    const hull = new Path2D(body);
    hull.addPath(hump);
    seg(hull, MAST[0], MAST[1]);
    glow(ctx, hull, COLORS.heli, 1.5, glowK);

    // panel lines + side window
    const detail = new Path2D();
    seg(detail, HELI.door[0], HELI.door[1]);
    seg(detail, HELI.exhaust[0], HELI.exhaust[1]);
    detail.addPath(poly(HELI.window));
    glow(ctx, detail, COLORS.heli, 0.7, 0.45 * glowK);

    // canopy glass with a lit cockpit
    const glass = poly(HELI.canopy);
    const cg = W({ x: 13, y: -1 });
    const gfill = ctx.createRadialGradient(cg.x, cg.y, 0, cg.x, cg.y, 12);
    gfill.addColorStop(0, 'rgba(127,252,255,0.45)');
    gfill.addColorStop(1, 'rgba(40,120,200,0.12)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = gfill;
    ctx.fill(glass);
    glow(ctx, glass, '#7ffcff', 1, 0.9 * glowK);

    // ---- landing gear
    const gear = new Path2D();
    STRUTS.forEach(([a, b]) => seg(gear, a, b));
    seg(gear, SKID[0], SKID[1]);
    seg(gear, SKID_TOE[0], SKID_TOE[1]);
    glow(ctx, gear, COLORS.heli, 1.2, glowK);

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
        const t = tip(game.rotorPhase + b * Math.PI - g * 0.14);
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

  private drawPlanet(): void {
    const ctx = this.ctx;
    const R = this.h * 0.15;
    const x = this.w * 0.8 - this.cam.x * 0.015;
    const y = this.h * 0.2 - this.cam.y * 0.01;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    const g = ctx.createLinearGradient(0, y - R, 0, y + R);
    g.addColorStop(0, 'rgba(255,106,213,0.22)');
    g.addColorStop(1, 'rgba(90,30,160,0.05)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();
    // synthwave cut-lines, thicker toward the bottom
    ctx.fillStyle = 'rgba(2,1,9,0.9)';
    for (let i = 0; i < 7; i++) {
      const yy = y + R * (0.1 + i * 0.13);
      ctx.fillRect(x - R, yy, R * 2, 1 + i * 0.9);
    }
    ctx.restore();
    const outline = new Path2D();
    outline.arc(x, y, R, 0, Math.PI * 2);
    glow(ctx, outline, '#ff6ad5', 1.2, 0.35 * config.glow);
    const ring = new Path2D();
    ring.ellipse(x, y, R * 1.75, R * 0.3, -0.22, Math.PI * 0.06, Math.PI * 0.94 + Math.PI);
    glow(ctx, ring, '#ff9a3c', 1, 0.3 * config.glow);
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
      } else {
        const path = new Path2D();
        path.arc(p.pos.x, p.pos.y, 4.5, 0, Math.PI * 2);
        glow(ctx, path, COLORS.bomb, 1.6, config.glow);
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
    const h = game.heli;
    ctx.globalCompositeOperation = 'source-over';

    text(ctx, 'THRUSTLIFTER', 24, 34, 20, COLORS.heli, 'left');
    text(ctx, `// ${game.level.data.name}`, 24, 56, 12, C.hud, 'left', 0.7);

    const alive = game.targets.filter((t) => t.alive).length;
    text(ctx, `TURRETS ${alive}/${game.targets.length}`, this.w - 24, 34, 14, COLORS.target, 'right');
    text(ctx, `DEATHS ${game.deaths}`, this.w - 24, 54, 12, C.hud, 'right', 0.8);
    text(ctx, `TIME ${(game.completedAt ?? game.time).toFixed(1)}`, this.w - 24, 72, 12, C.hud, 'right', 0.8);

    // instrument cluster (room reserved to the right of it for FUEL / SHIELD later)
    const bx = 24;
    const by = this.h - 30;
    text(ctx, 'THRUST', bx, by - 26, 11, C.hud, 'left', 0.8);
    const bw = 160;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(159,232,255,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by - 18, bw, 10);
    const hover = clamp(game.hoverRpm(), 0, 1);
    ctx.fillStyle = h.throttle >= hover ? 'rgba(125,255,176,0.85)' : 'rgba(255,210,63,0.85)';
    ctx.fillRect(bx + 1, by - 17, (bw - 2) * h.throttle, 8);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bx + bw * hover - 1, by - 22, 2, 18);
    text(ctx, 'HOVER', bx + bw * hover, by + 4, 9, '#ffffff', 'center', 0.6);

    // tilt gauge
    const gx = bx + bw + 70;
    const gy = by - 6;
    const gr = 34;
    const max = config.maxTiltDeg;
    const toA = (d: number) => -Math.PI / 2 + ((d / max) * Math.PI) / 3;
    ctx.strokeStyle = 'rgba(159,232,255,0.45)';
    ctx.beginPath();
    ctx.arc(gx, gy, gr, toA(-max), toA(max));
    ctx.stroke();
    for (const d of [-max, 0, max]) {
      const a = toA(d);
      ctx.beginPath();
      ctx.moveTo(gx + Math.cos(a) * (gr - 5), gy + Math.sin(a) * (gr - 5));
      ctx.lineTo(gx + Math.cos(a) * (gr + 3), gy + Math.sin(a) * (gr + 3));
      ctx.stroke();
    }
    const tgt = toA(toDeg(h.tiltTarget));
    ctx.strokeStyle = 'rgba(255,61,242,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(gx + Math.cos(tgt) * (gr - 2), gy + Math.sin(tgt) * (gr - 2));
    ctx.lineTo(gx + Math.cos(tgt) * (gr + 6), gy + Math.sin(tgt) * (gr + 6));
    ctx.stroke();
    const act = toA(toDeg(h.tilt));
    ctx.strokeStyle = COLORS.heli;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx + Math.cos(act) * (gr - 4), gy + Math.sin(act) * (gr - 4));
    ctx.stroke();
    const td = toDeg(h.tilt);
    text(ctx, `TILT ${td >= 0 ? '+' : ''}${td.toFixed(0)}°`, gx, gy + 18, 11, C.hud, 'center', 0.8);

    text(ctx, h.facing === 1 ? 'FACING ▶' : '◀ FACING', gx + 90, by - 14, 13, COLORS.heli, 'center');
    const orbState = game.orb.delivered ? 'DELIVERED' : game.orb.attached ? 'ON ROD' : game.orb.free ? 'DROPPED' : 'NOT HELD';
    text(ctx, `ORB ${orbState}`, gx + 90, by + 4, 11, COLORS.orb, 'center', game.orb.attached ? 1 : 0.6);

    const approach = game.orbApproach();
    if (approach) {
      const col = approach.safe ? '#3dff8a' : '#ff4a4a';
      text(ctx, `ORB SPEED ${approach.speed.toFixed(0)}`, this.w / 2, this.h - 150, 18, col, 'center');
      text(ctx, `max impact ${config.orbMaxImpact}`, this.w / 2, this.h - 130, 11, C.hud, 'center', 0.7);
    }

    if (game.bombBlockedFlash > 0) {
      text(ctx, 'BOMB BAY BLOCKED BY ORB', this.w / 2, this.h - 110, 13, COLORS.bomb, 'center', game.bombBlockedFlash);
    } else if (game.orbInReach() && !game.beam) {
      text(ctx, 'HOLD SPACE TO TETHER', this.w / 2, this.h - 110, 13, COLORS.orb, 'center', 0.6 + 0.4 * Math.sin(this.clock * 6));
    } else if (game.beam) {
      text(ctx, 'TETHERING — PULL AWAY TO LOCK THE ROD', this.w / 2, this.h - 110, 13, COLORS.orb, 'center');
    }

    const m = game.message;
    if (m) {
      const fadeIn = clamp(m.t / 0.15, 0, 1);
      const fadeOut = clamp((m.life - m.t) / 0.4, 0, 1);
      const a = Math.min(fadeIn, fadeOut);
      text(ctx, m.text, this.w / 2, this.h * 0.3, 42, m.color, 'center', a);
      if (m.sub) text(ctx, m.sub, this.w / 2, this.h * 0.3 + 32, 14, C.hud, 'center', a * 0.85);
    }

    if (this.helpVisible) {
      const lines = [
        '←/→ or A/D  tilt     ↑ or W  rotor     ↓ or S  dive     C or L  flip facing',
        'Z or J  missile      X or K  bomb      SPACE  hold: tether · tap: release',
        'R restart · P pause · T tuning panel · H hide this',
      ];
      lines.forEach((l, i) => text(ctx, l, this.w / 2, this.h - 70 + i * 17, 12, C.hud, 'center', 0.55));
    }

    if (this.paused) {
      ctx.fillStyle = 'rgba(2,1,9,0.55)';
      ctx.fillRect(0, 0, this.w, this.h);
      text(ctx, 'PAUSED', this.w / 2, this.h / 2, 48, C.hud, 'center');
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
