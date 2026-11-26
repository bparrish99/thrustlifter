import { config } from '../config';
import { Game } from '../game';
import type { LevelData, PadData } from '../level';
import { distPointSegment, type Vec } from '../math';
import type { Renderer } from '../render';
import {
  ORB_PEDESTAL_HEIGHT,
  PAD_EMBED,
  formatLevel,
  nearestSurface,
  newLevelTemplate,
  slugFile,
  snapToGround,
  tightSpots,
  validate,
  type Problem,
} from './tools';

/*
 * In-game level editor. Edits a copy of a level's data; every change rebuilds a live Game from it
 * so the level is drawn exactly as it plays. Enter test-flies it; "Save to project" writes the JSON
 * into src/levels (dev server only). The session (draft, camera, file) survives page reloads.
 */

type Tool = 'select' | 'rock' | 'pad' | 'rescue' | 'orb' | 'bowl' | 'turret' | 'balloon' | 'tank' | 'survivor' | 'gate' | 'checkpoint';

const TOOLS: { id: Tool; key: string; label: string; hint: string }[] = [
  { id: 'select', key: '1', label: 'Select', hint: 'Click to select, drag to move. Double-click an edge to add a point. Del removes.' },
  { id: 'rock', key: '2', label: 'Rock', hint: 'Click to place points of a new rock shape. Click the first point (or Enter) to close it.' },
  { id: 'pad', key: '3', label: 'Launch pad', hint: 'Click the ground to move your launch/return pad there.' },
  { id: 'rescue', key: '4', label: 'Rescue pad', hint: 'Click the ground to add a rescue pad (gets 1 guard and 2 survivors).' },
  { id: 'orb', key: '5', label: 'Orb', hint: 'Click the ground to move the orb (its pedestal stands there).' },
  { id: 'bowl', key: '6', label: 'Bowl', hint: 'Click the ground to move the orb bowl.' },
  { id: 'turret', key: '7', label: 'Turret', hint: 'Click near any surface (floor, wall or ceiling) to mount a turret on it.' },
  { id: 'balloon', key: '8', label: 'Balloon', hint: 'Click anywhere in the air to add a balloon.' },
  { id: 'tank', key: '9', label: 'Fuel tank', hint: 'Click the ground to add a fuel tank.' },
  { id: 'survivor', key: '0', label: 'Survivor', hint: 'Click the ground to add a survivor.' },
  { id: 'gate', key: '-', label: 'Gate', hint: 'Drag a rectangle to add an energy gate (opens on delivery; change in its properties).' },
  { id: 'checkpoint', key: '=', label: 'Checkpoint', hint: 'Click to place the after-delivery respawn point (where you hover after dying post-delivery).' },
];

type Sel =
  | { kind: 'vert'; poly: number; i: number }
  | { kind: 'gatevert'; gate: number; i: number }
  | { kind: 'pad' | 'turret' | 'balloon' | 'tank' | 'survivor' | 'gate'; i: number }
  | { kind: 'orb' | 'bowl' | 'checkpoint' }
  | null;

interface Session {
  file: string | null;
  draft: LevelData;
  cam: { x: number; y: number; viewHeight: number };
}

const SESSION_KEY = 'thrustlifter.editor.session.v1';
const clone = <T>(v: T): T => structuredClone(v);

export class Editor {
  active = false;
  /** Set by main.ts: start a test flight of this data. */
  onTest: ((data: LevelData) => void) | null = null;
  /** Set by main.ts: leave the editor (back to normal play). */
  onExit: (() => void) | null = null;

  private draft: LevelData = newLevelTemplate();
  file: string | null = null;
  game: Game = new Game(this.draft);
  private cam = { x: 1500, y: 600, viewHeight: 1400 };
  private tool: Tool = 'select';
  private sel: Sel = null;
  private grid = true;
  private showTight = false;
  private tight: { p: Vec; level: 'tight' | 'snug' }[] = [];
  private tightDirty = true;
  private problems: Problem[] = [];
  private rockPts: Vec[] = [];
  private gateStart: Vec | null = null;
  private mouse: Vec = { x: 0, y: 0 }; // world
  private mouseScreen: Vec = { x: 0, y: 0 };
  private drag: { sel: Sel; last: Vec; moved: boolean } | null = null;
  private pan: { sx: number; sy: number; cx: number; cy: number } | null = null;
  private spaceDown = false;
  private keys = new Set<string>();
  private undo: string[] = [];
  private redo: string[] = [];
  private dirtyGame = true;
  private status = '';
  private statusT = 0;
  private panel: HTMLDivElement;
  private toolbar: HTMLDivElement;

  constructor(
    private canvas: HTMLCanvasElement,
    private renderer: Renderer,
  ) {
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'ed-toolbar';
    this.panel = document.createElement('div');
    this.panel.className = 'ed-panel';
    document.body.append(this.toolbar, this.panel);
    injectStyles();
    this.hideUi();

    canvas.addEventListener('mousedown', (e) => this.active && this.onMouseDown(e));
    addEventListener('mousemove', (e) => this.active && this.onMouseMove(e));
    addEventListener('mouseup', (e) => this.active && this.onMouseUp(e));
    canvas.addEventListener('dblclick', (e) => this.active && this.onDoubleClick(e));
    canvas.addEventListener('wheel', (e) => this.active && this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => this.active && e.preventDefault());
    addEventListener('keydown', (e) => this.active && this.onKeyDown(e));
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space') this.spaceDown = false;
    });
  }

  // ------------------------------------------------------------------ session

  /** Open the editor on a level (or resume the saved session for it). */
  open(data: LevelData, file: string | null): void {
    const saved = loadSession();
    if (saved && saved.file === file) {
      this.draft = saved.draft;
      this.cam = saved.cam;
    } else {
      this.draft = clone(data);
      const pad = this.draft.pads.find((p) => p.kind === 'start');
      this.cam = { x: pad ? pad.x + pad.w / 2 : 1000, y: pad ? pad.y - 200 : 500, viewHeight: 1500 };
    }
    this.file = file;
    this.undo = [];
    this.redo = [];
    this.sel = null;
    this.rockPts = [];
    this.active = true;
    this.showUi();
    this.changed();
    this.flash(file ? `Editing ${file}` : 'Editing a new level');
  }

  /** Re-open after a test flight, keeping everything as it was. */
  resume(): void {
    this.active = true;
    this.showUi();
    this.changed();
  }

  /** Re-open the last session after a page reload, if there was one. */
  resumeSaved(): boolean {
    const s = loadSession();
    if (!s || !localStorage.getItem(SESSION_KEY + '.active')) return false;
    this.draft = s.draft;
    this.file = s.file;
    this.cam = s.cam;
    this.active = true;
    this.showUi();
    this.changed();
    return true;
  }

  close(): void {
    this.active = false;
    this.hideUi();
    this.renderer.camOverride = null;
    this.renderer.showHud = true;
    localStorage.removeItem(SESSION_KEY + '.active');
  }

  get data(): LevelData {
    return this.draft;
  }

  private saveSession(): void {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ file: this.file, draft: this.draft, cam: this.cam } satisfies Session));
      localStorage.setItem(SESSION_KEY + '.active', '1');
    } catch {
      /* storage full or unavailable */
    }
  }

  // ------------------------------------------------------------------ editing core

  private snapshot(): void {
    this.undo.push(JSON.stringify(this.draft));
    if (this.undo.length > 200) this.undo.shift();
    this.redo = [];
  }

  private undoStep(dir: 1 | -1): void {
    const from = dir === 1 ? this.undo : this.redo;
    const to = dir === 1 ? this.redo : this.undo;
    const s = from.pop();
    if (!s) return;
    to.push(JSON.stringify(this.draft));
    this.draft = JSON.parse(s);
    this.sel = null;
    this.changed();
  }

  /** Something in the draft changed: rebuild the preview, revalidate, autosave. */
  private changed(): void {
    this.dirtyGame = true;
    this.tightDirty = true;
    this.problems = validate(this.draft, config);
    this.saveSession();
    this.buildPanel();
  }

  private rebuildGame(): void {
    try {
      this.game = new Game(this.draft, { levelNumber: 0 });
      this.game.message = null;
      // one tiny step so guards appear parked on their pads
      this.game.update({ tiltAxis: 0, rotor: 0, dive: 0, fire: false, flip: false, pickup: false, pickupPressed: false, restart: false }, 1 / 120);
      this.game.events.length = 0;
    } catch (e) {
      this.flash(`Can't build level: ${String(e)}`);
    }
    this.dirtyGame = false;
  }

  private snap(v: number): number {
    return this.grid ? Math.round(v / 10) * 10 : Math.round(v);
  }

  private flash(s: string): void {
    this.status = s;
    this.statusT = 4;
  }

  // ------------------------------------------------------------------ frame

  /** Called every frame while the editor is open. Renders the level and the editor overlay. */
  frame(dt: number): void {
    // keyboard panning
    const speed = this.cam.viewHeight * 0.9 * dt;
    if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) this.cam.x -= speed;
    if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) this.cam.x += speed;
    if (this.keys.has('ArrowUp') || this.keys.has('KeyW')) this.cam.y -= speed;
    if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) this.cam.y += speed;
    if (this.dirtyGame) this.rebuildGame();
    if (this.showTight && this.tightDirty) {
      this.tight = tightSpots(this.draft, 95, 200);
      this.tightDirty = false;
    }
    this.statusT = Math.max(0, this.statusT - dt);
    this.renderer.camOverride = this.cam;
    this.renderer.showHud = false;
    this.renderer.render(this.game, dt);
    this.mouse = this.renderer.screenToWorld(this.mouseScreen.x, this.mouseScreen.y);
    this.drawOverlay();
  }

  // ------------------------------------------------------------------ drawing

  private drawOverlay(): void {
    const d = this.draft;
    const r = this.renderer;
    r.withWorld((ctx, scale) => {
      const px = 1 / scale; // one screen pixel in world units
      // grid
      if (this.grid) {
        const tl = r.screenToWorld(0, 0);
        const br = r.screenToWorld(innerWidth, innerHeight);
        const step = this.cam.viewHeight > 2500 ? 200 : 100;
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = px;
        ctx.beginPath();
        for (let x = Math.floor(tl.x / step) * step; x < br.x; x += step) {
          ctx.moveTo(x, tl.y);
          ctx.lineTo(x, br.y);
        }
        for (let y = Math.floor(tl.y / step) * step; y < br.y; y += step) {
          ctx.moveTo(tl.x, y);
          ctx.lineTo(br.x, y);
        }
        ctx.stroke();
      }
      // level bounds
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.setLineDash([12 * px, 8 * px]);
      ctx.lineWidth = 1.5 * px;
      const bottom = Math.max(...d.terrain.flat().filter((_, i) => i % 2 === 1));
      ctx.strokeRect(0, -1200, d.width, bottom + 1200);
      ctx.setLineDash([]);
      // tight spots
      if (this.showTight) {
        for (const t of this.tight) {
          ctx.fillStyle = t.level === 'tight' ? 'rgba(255,60,60,0.55)' : 'rgba(255,170,40,0.35)';
          ctx.fillRect(t.p.x - 4, t.p.y - 4, 8, 8);
        }
      }
      // rock vertices
      d.terrain.forEach((poly, pi) => {
        for (let k = 0; k < poly.length; k += 2) {
          const sel = this.sel?.kind === 'vert' && this.sel.poly === pi && this.sel.i === k / 2;
          handle(ctx, { x: poly[k], y: poly[k + 1] }, px, sel ? '#ffffff' : '#5afcff', sel ? 6 : 4);
        }
      });
      // gate vertices
      (d.gates ?? []).forEach((g, gi) => {
        for (let k = 0; k < g.poly.length; k += 2) {
          const sel = this.sel?.kind === 'gatevert' && this.sel.gate === gi && this.sel.i === k / 2;
          handle(ctx, { x: g.poly[k], y: g.poly[k + 1] }, px, sel ? '#ffffff' : '#ff3d8b', sel ? 6 : 3.5);
        }
      });
      // checkpoint marker
      const cp = d.checkpoints?.find((c) => c.after === 'delivery');
      if (cp) {
        ctx.strokeStyle = this.sel?.kind === 'checkpoint' ? '#ffffff' : '#3dff8a';
        ctx.lineWidth = 2 * px;
        ctx.setLineDash([6 * px, 5 * px]);
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, 40, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        label(ctx, 'RESPAWN AFTER DELIVERY', cp.x, cp.y - 52, px, '#3dff8a');
      }
      // balloon patrol ranges
      for (const b of d.balloons ?? []) {
        const pr = b.patrol ?? config.balloonPatrol;
        ctx.strokeStyle = 'rgba(255,61,110,0.35)';
        ctx.lineWidth = px;
        ctx.setLineDash([4 * px, 6 * px]);
        ctx.beginPath();
        ctx.ellipse(b.x, b.y, pr, pr * 0.45, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // selection highlight
      const sb = this.selBounds(this.sel);
      if (sb) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5 * px;
        ctx.setLineDash([5 * px, 4 * px]);
        ctx.strokeRect(sb.x - 8, sb.y - 8, sb.w + 16, sb.h + 16);
        ctx.setLineDash([]);
      }
      // problem markers
      for (const p of this.problems) {
        if (!p.at) continue;
        ctx.strokeStyle = p.level === 'error' ? '#ff3b3b' : '#ffb020';
        ctx.lineWidth = 2.5 * px;
        ctx.beginPath();
        ctx.arc(p.at.x, p.at.y, 26 + 4 * Math.sin(performance.now() / 150), 0, Math.PI * 2);
        ctx.stroke();
      }
      // rock in progress
      if (this.rockPts.length) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 * px;
        ctx.beginPath();
        this.rockPts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.lineTo(this.snap(this.mouse.x), this.snap(this.mouse.y));
        ctx.stroke();
        for (const p of this.rockPts) handle(ctx, p, px, '#ffffff', 4);
        handle(ctx, this.rockPts[0], px, '#3dff8a', 7);
      }
      // gate in progress
      if (this.gateStart) {
        const a = this.gateStart;
        const b = { x: this.snap(this.mouse.x), y: this.snap(this.mouse.y) };
        ctx.strokeStyle = '#ff3d8b';
        ctx.lineWidth = 2 * px;
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      }
      // placement ghost
      const ghost = this.ghost();
      if (ghost) {
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1.5 * px;
        ctx.setLineDash([4 * px, 4 * px]);
        ctx.beginPath();
        ctx.arc(ghost.x, ghost.y, 18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
    // screen-space: hint + status + coordinates
    r.withScreen((ctx, w, h) => {
      const t = TOOLS.find((x) => x.id === this.tool)!;
      ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const hint = `${t.label}: ${t.hint}`;
      const tw = ctx.measureText(hint).width;
      ctx.fillRect(w / 2 - tw / 2 - 10, h - 40, tw + 20, 26);
      ctx.fillStyle = '#cfe9ff';
      ctx.fillText(hint, w / 2, h - 22);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(207,233,255,0.6)';
      ctx.fillText(`x ${Math.round(this.mouse.x)}  y ${Math.round(this.mouse.y)}  ·  zoom ${Math.round(this.cam.viewHeight)}`, 12, h - 12);
      if (this.statusT > 0) {
        ctx.textAlign = 'center';
        ctx.font = 'bold 18px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillStyle = `rgba(255,225,77,${Math.min(1, this.statusT)})`;
        ctx.fillText(this.status, w / 2, 90);
      }
    });
  }

  /** Where a click with the current tool would put something (for the hover ghost). */
  private ghost(): Vec | null {
    const m = this.mouse;
    switch (this.tool) {
      case 'pad':
      case 'rescue':
      case 'tank':
      case 'survivor':
      case 'bowl':
      case 'orb': {
        const g = snapToGround(this.draft, m);
        return g === null ? null : { x: this.snap(m.x), y: g };
      }
      case 'turret':
        return nearestSurface(this.draft, m)?.pos ?? null;
      default:
        return null;
    }
  }

  private selBounds(s: Sel): { x: number; y: number; w: number; h: number } | null {
    if (!s) return null;
    const d = this.draft;
    const box = (x: number, y: number, w = 0, h = 0) => ({ x, y, w, h });
    switch (s.kind) {
      case 'pad': {
        const p = d.pads[s.i];
        return box(p.x, p.y - 4, p.w, 24);
      }
      case 'turret':
        return box(d.turrets[s.i].x - 34, d.turrets[s.i].y - 34, 68, 68);
      case 'balloon':
        return box(d.balloons![s.i].x - 32, d.balloons![s.i].y - 38, 64, 96);
      case 'tank':
        return box(d.fuelTanks![s.i].x - 24, d.fuelTanks![s.i].y - 34, 48, 34);
      case 'survivor':
        return box(d.survivors![s.i].x - 6, d.survivors![s.i].y - 22, 12, 22);
      case 'gate': {
        const xs = d.gates![s.i].poly.filter((_, k) => k % 2 === 0);
        const ys = d.gates![s.i].poly.filter((_, k) => k % 2 === 1);
        return box(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      }
      case 'orb':
        return box(d.orb.x - 24, d.orb.y - 16, 48, 16 + 16.5 + ORB_PEDESTAL_HEIGHT);
      case 'bowl':
        return box(d.bowl.x - 40, d.bowl.y - 34, 80, 34);
      case 'checkpoint': {
        const c = d.checkpoints!.find((x) => x.after === 'delivery')!;
        return box(c.x - 40, c.y - 40, 80, 80);
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ hit testing

  private hit(p: Vec): Sel {
    const d = this.draft;
    const px = 1 / this.renderer.viewScale;
    const near = (a: Vec, r: number) => Math.hypot(a.x - p.x, a.y - p.y) < r;
    // handles first (screen-size tolerance)
    for (let gi = 0; gi < (d.gates ?? []).length; gi++) {
      const g = d.gates![gi].poly;
      for (let k = 0; k < g.length; k += 2) if (near({ x: g[k], y: g[k + 1] }, 9 * px)) return { kind: 'gatevert', gate: gi, i: k / 2 };
    }
    for (let pi = 0; pi < d.terrain.length; pi++) {
      const poly = d.terrain[pi];
      for (let k = 0; k < poly.length; k += 2) if (near({ x: poly[k], y: poly[k + 1] }, 9 * px)) return { kind: 'vert', poly: pi, i: k / 2 };
    }
    // objects
    const cp = d.checkpoints?.find((c) => c.after === 'delivery');
    const order: Sel[] = [
      ...(d.balloons ?? []).map((_, i) => ({ kind: 'balloon' as const, i })),
      ...d.turrets.map((_, i) => ({ kind: 'turret' as const, i })),
      ...(d.survivors ?? []).map((_, i) => ({ kind: 'survivor' as const, i })),
      ...(d.fuelTanks ?? []).map((_, i) => ({ kind: 'tank' as const, i })),
      { kind: 'orb' },
      { kind: 'bowl' },
      ...d.pads.map((_, i) => ({ kind: 'pad' as const, i })),
      ...(d.gates ?? []).map((_, i) => ({ kind: 'gate' as const, i })),
      ...(cp ? [{ kind: 'checkpoint' as const }] : []),
    ];
    for (const s of order) {
      const b = this.selBounds(s)!;
      const m = 6 * px;
      if (p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m) return s;
    }
    return null;
  }

  // ------------------------------------------------------------------ mouse

  private screenPos(e: MouseEvent): Vec {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onMouseDown(e: MouseEvent): void {
    this.mouseScreen = this.screenPos(e);
    const m = this.renderer.screenToWorld(this.mouseScreen.x, this.mouseScreen.y);
    this.mouse = m;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown)) {
      this.pan = { sx: this.mouseScreen.x, sy: this.mouseScreen.y, cx: this.cam.x, cy: this.cam.y };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const sp = { x: this.snap(m.x), y: this.snap(m.y) };
    const d = this.draft;

    switch (this.tool) {
      case 'select': {
        const s = this.hit(m);
        this.sel = s;
        if (s) {
          this.snapshot();
          this.drag = { sel: s, last: m, moved: false };
        }
        this.buildPanel();
        return;
      }
      case 'rock': {
        if (this.rockPts.length >= 3 && Math.hypot(sp.x - this.rockPts[0].x, sp.y - this.rockPts[0].y) < 12 / this.renderer.viewScale) {
          this.finishRock();
        } else {
          this.rockPts.push(sp);
        }
        return;
      }
      case 'gate':
        this.gateStart = sp;
        return;
    }

    // placement tools
    const ground = snapToGround(d, m);
    const onGround = (fn: (gy: number) => void) => {
      if (ground === null) return this.flash('No ground below there.');
      this.snapshot();
      fn(ground);
      this.changed();
    };
    switch (this.tool) {
      case 'pad':
        return onGround((gy) => {
          let p = d.pads.find((x) => x.kind === 'start');
          if (!p) {
            p = { x: 0, y: 0, w: 160, kind: 'start' };
            d.pads.unshift(p);
          }
          p.x = sp.x - p.w / 2;
          p.y = gy - PAD_EMBED;
          this.sel = { kind: 'pad', i: d.pads.indexOf(p) };
        });
      case 'rescue':
        return onGround((gy) => {
          const p: PadData = { x: sp.x - 60, y: gy - PAD_EMBED, w: 120, kind: 'rescue', guards: 1 };
          d.pads.push(p);
          (d.survivors ??= []).push({ x: p.x + p.w + 25, y: gy }, { x: p.x + p.w + 45, y: gy });
          this.sel = { kind: 'pad', i: d.pads.length - 1 };
        });
      case 'orb':
        return onGround((gy) => {
          d.orb = { x: sp.x, y: gy - ORB_PEDESTAL_HEIGHT - 16.5 };
          this.sel = { kind: 'orb' };
        });
      case 'bowl':
        return onGround((gy) => {
          d.bowl = { x: sp.x, y: gy };
          this.sel = { kind: 'bowl' };
        });
      case 'tank':
        return onGround((gy) => {
          (d.fuelTanks ??= []).push({ x: sp.x, y: gy });
          this.sel = { kind: 'tank', i: d.fuelTanks.length - 1 };
        });
      case 'survivor':
        return onGround((gy) => {
          (d.survivors ??= []).push({ x: sp.x, y: gy });
          this.sel = { kind: 'survivor', i: d.survivors.length - 1 };
        });
      case 'turret': {
        const s = nearestSurface(d, m);
        if (!s) return this.flash('Click closer to a surface to mount a turret.');
        this.snapshot();
        d.turrets.push({ x: Math.round(s.pos.x), y: Math.round(s.pos.y), dir: Math.round((Math.atan2(s.normal.y, s.normal.x) * 180) / Math.PI) }); // dir is a hint; the game aligns to the surface
        this.sel = { kind: 'turret', i: d.turrets.length - 1 };
        this.changed();
        return;
      }
      case 'balloon':
        this.snapshot();
        (d.balloons ??= []).push({ x: sp.x, y: sp.y });
        this.sel = { kind: 'balloon', i: d.balloons.length - 1 };
        this.changed();
        return;
      case 'checkpoint': {
        this.snapshot();
        const cp = d.checkpoints?.find((c) => c.after === 'delivery');
        if (cp) Object.assign(cp, { x: sp.x, y: sp.y });
        else (d.checkpoints ??= []).push({ x: sp.x, y: sp.y, after: 'delivery', fuel: 40 });
        this.sel = { kind: 'checkpoint' };
        this.changed();
        return;
      }
    }
  }

  private onMouseMove(e: MouseEvent): void {
    this.mouseScreen = this.screenPos(e);
    const m = this.renderer.screenToWorld(this.mouseScreen.x, this.mouseScreen.y);
    this.mouse = m;
    if (this.pan) {
      const s = this.renderer.viewScale;
      this.cam.x = this.pan.cx - (this.mouseScreen.x - this.pan.sx) / s;
      this.cam.y = this.pan.cy - (this.mouseScreen.y - this.pan.sy) / s;
      return;
    }
    if (!this.drag) return;
    this.drag.moved = true;
    const d = this.draft;
    const s = this.drag.sel!;
    const sp = { x: this.snap(m.x), y: this.snap(m.y) };
    const dx = m.x - this.drag.last.x;
    const dy = m.y - this.drag.last.y;
    const ground = () => snapToGround(d, m);
    switch (s.kind) {
      case 'vert':
        d.terrain[s.poly][s.i * 2] = sp.x;
        d.terrain[s.poly][s.i * 2 + 1] = sp.y;
        break;
      case 'gatevert':
        d.gates![s.gate].poly[s.i * 2] = sp.x;
        d.gates![s.gate].poly[s.i * 2 + 1] = sp.y;
        break;
      case 'gate':
        d.gates![s.i].poly = d.gates![s.i].poly.map((v, k) => v + (k % 2 === 0 ? dx : dy));
        this.drag.last = m;
        break;
      case 'balloon':
        Object.assign(d.balloons![s.i], { x: sp.x, y: sp.y });
        break;
      case 'checkpoint':
        Object.assign(d.checkpoints!.find((c) => c.after === 'delivery')!, { x: sp.x, y: sp.y });
        break;
      case 'turret': {
        const n = nearestSurface(d, m);
        if (n) Object.assign(d.turrets[s.i], { x: Math.round(n.pos.x), y: Math.round(n.pos.y), dir: Math.round((Math.atan2(n.normal.y, n.normal.x) * 180) / Math.PI) });
        break;
      }
      case 'pad': {
        const g = ground();
        const p = d.pads[s.i];
        if (g !== null) Object.assign(p, { x: sp.x - p.w / 2, y: g - PAD_EMBED });
        break;
      }
      case 'tank': {
        const g = ground();
        if (g !== null) Object.assign(d.fuelTanks![s.i], { x: sp.x, y: g });
        break;
      }
      case 'survivor': {
        const g = ground();
        if (g !== null) Object.assign(d.survivors![s.i], { x: sp.x, y: g });
        break;
      }
      case 'orb': {
        const g = ground();
        if (g !== null) d.orb = { x: sp.x, y: g - ORB_PEDESTAL_HEIGHT - 16.5 };
        break;
      }
      case 'bowl': {
        const g = ground();
        if (g !== null) d.bowl = { x: sp.x, y: g };
        break;
      }
    }
    this.dirtyGame = true;
    this.tightDirty = true;
  }

  private onMouseUp(e: MouseEvent): void {
    if (this.pan && (e.button === 1 || e.button === 2 || e.button === 0)) {
      this.pan = null;
      this.saveSession();
      return;
    }
    if (this.gateStart) {
      const a = this.gateStart;
      const b = { x: this.snap(this.mouse.x), y: this.snap(this.mouse.y) };
      this.gateStart = null;
      if (Math.abs(b.x - a.x) < 10 || Math.abs(b.y - a.y) < 10) return this.flash('Drag out a bigger rectangle for the gate.');
      this.snapshot();
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      (this.draft.gates ??= []).push({ poly: [x0, y0, x1, y0, x1, y1, x0, y1], opens: 'delivery' });
      this.sel = { kind: 'gate', i: this.draft.gates.length - 1 };
      this.changed();
      return;
    }
    if (this.drag) {
      if (!this.drag.moved) this.undo.pop(); // just a click: nothing changed
      else this.changed();
      this.drag = null;
    }
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.tool !== 'select') return;
    const p = this.renderer.screenToWorld(this.screenPos(e).x, this.screenPos(e).y);
    const tol = 8 / this.renderer.viewScale;
    const d = this.draft;
    for (let pi = 0; pi < d.terrain.length; pi++) {
      const poly = d.terrain[pi];
      const n = poly.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = { x: poly[i * 2], y: poly[i * 2 + 1] };
        const b = { x: poly[j * 2], y: poly[j * 2 + 1] };
        if (distPointSegment(p, a, b) < tol) {
          this.snapshot();
          poly.splice(j === 0 ? poly.length : j * 2, 0, this.snap(p.x), this.snap(p.y));
          this.sel = { kind: 'vert', poly: pi, i: j === 0 ? n : j };
          this.changed();
          return;
        }
      }
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const before = this.renderer.screenToWorld(this.screenPos(e).x, this.screenPos(e).y);
    const k = Math.exp(e.deltaY * 0.0012);
    this.cam.viewHeight = Math.max(300, Math.min(6000, this.cam.viewHeight * k));
    // keep the point under the cursor fixed
    this.renderer.camOverride = this.cam;
    const s = this.renderer.viewScale;
    const sp = this.screenPos(e);
    this.cam.x = before.x - (sp.x - innerWidth / 2) / s;
    this.cam.y = before.y - (sp.y - innerHeight / 2) / s;
    this.saveSession();
  }

  // ------------------------------------------------------------------ keys

  private onKeyDown(e: KeyboardEvent): void {
    if (isTextField(e.target)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyZ') {
      e.preventDefault();
      return this.undoStep(e.shiftKey ? -1 : 1);
    }
    if (ctrl && e.code === 'KeyY') {
      e.preventDefault();
      return this.undoStep(-1);
    }
    if (ctrl && e.code === 'KeyS') {
      e.preventDefault();
      void this.saveToProject();
      return;
    }
    if (ctrl) return;
    if (e.code === 'Space') {
      this.spaceDown = true;
      e.preventDefault();
      return;
    }
    if (e.code.startsWith('Arrow')) e.preventDefault();
    this.keys.add(e.code);
    const tool = TOOLS.find((t) => t.key === e.key);
    if (tool && !e.repeat) return this.setTool(tool.id);
    switch (e.code) {
      case 'Enter':
        if (this.rockPts.length >= 3) return this.finishRock();
        return this.test();
      case 'Escape':
        if (this.rockPts.length || this.gateStart) {
          this.rockPts = [];
          this.gateStart = null;
          return;
        }
        this.sel = null;
        this.buildPanel();
        return;
      case 'Delete':
      case 'Backspace':
        return this.deleteSel(e.shiftKey);
      case 'KeyG':
        this.grid = !this.grid;
        return this.buildPanel();
      case 'KeyC':
        this.showTight = !this.showTight;
        return this.buildPanel();
      case 'KeyF':
        return this.frameAll();
    }
  }

  private setTool(t: Tool): void {
    this.tool = t;
    this.rockPts = [];
    this.gateStart = null;
    this.buildToolbar();
  }

  private finishRock(): void {
    if (this.rockPts.length < 3) return;
    this.snapshot();
    this.draft.terrain.push(this.rockPts.flatMap((p) => [p.x, p.y]));
    this.sel = { kind: 'vert', poly: this.draft.terrain.length - 1, i: 0 };
    this.rockPts = [];
    this.changed();
  }

  private deleteSel(wholeShape = false): void {
    const s = this.sel;
    const d = this.draft;
    if (!s) return;
    this.snapshot();
    switch (s.kind) {
      case 'vert': {
        const poly = d.terrain[s.poly];
        if (wholeShape || poly.length <= 6) {
          if (d.terrain.length <= 1) {
            this.undo.pop();
            return this.flash('A level needs at least one rock shape.');
          }
          d.terrain.splice(s.poly, 1);
        } else poly.splice(s.i * 2, 2);
        break;
      }
      case 'gatevert':
      case 'gate':
        d.gates!.splice(s.kind === 'gatevert' ? s.gate : s.i, 1);
        break;
      case 'pad':
        if (d.pads[s.i].kind === 'start') {
          this.undo.pop();
          return this.flash("The launch pad can't be deleted (move it instead).");
        }
        d.pads.splice(s.i, 1);
        break;
      case 'turret':
        d.turrets.splice(s.i, 1);
        break;
      case 'balloon':
        d.balloons!.splice(s.i, 1);
        break;
      case 'tank':
        d.fuelTanks!.splice(s.i, 1);
        break;
      case 'survivor':
        d.survivors!.splice(s.i, 1);
        break;
      case 'checkpoint':
        d.checkpoints = (d.checkpoints ?? []).filter((c) => c.after !== 'delivery');
        break;
      case 'orb':
      case 'bowl':
        this.undo.pop();
        return this.flash(`The ${s.kind} can't be deleted (move it instead).`);
    }
    this.sel = null;
    this.changed();
  }

  private frameAll(): void {
    const all = this.draft.terrain.flat().filter((_, i) => i % 2 === 1);
    const bottom = Math.max(...all);
    const ys = all.filter((y) => y > -1100 && y < bottom - 1); // skip the invisible world frame
    const minY = Math.min(...ys, 0) - 200;
    const maxY = Math.max(...ys, 800) + 100;
    this.cam = {
      x: this.draft.width / 2,
      y: (minY + maxY) / 2,
      viewHeight: Math.max(maxY - minY, (this.draft.width / (innerWidth / innerHeight)) * 1.05),
    };
    this.saveSession();
  }

  // ------------------------------------------------------------------ actions

  private test(): void {
    const errors = this.problems.filter((p) => p.level === 'error');
    if (errors.length) return this.flash(`Fix first: ${errors[0].text}`);
    this.active = false;
    this.hideUi();
    this.renderer.camOverride = null;
    this.renderer.showHud = true;
    this.onTest?.(clone(this.draft));
  }

  private async saveToProject(): Promise<void> {
    const errors = this.problems.filter((p) => p.level === 'error');
    if (errors.length) return this.flash(`Can't save yet: ${errors[0].text}`);
    const file = this.file ?? slugFile(this.draft.name);
    try {
      const res = await fetch('/__editor/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, text: formatLevel(this.draft) }),
      });
      const out = (await res.json()) as { ok: boolean; error?: string };
      if (!out.ok) throw new Error(out.error);
      this.file = file;
      this.saveSession();
      this.flash(`Saved to src/levels/${file}`);
      this.buildPanel();
    } catch (e) {
      this.flash(`Save failed: ${String(e)}. (Use Copy JSON instead.)`);
    }
  }

  private newLevel(): void {
    this.snapshot();
    this.draft = newLevelTemplate();
    this.file = null;
    this.sel = null;
    this.frameAll();
    this.changed();
    this.flash('New level. Save to project to add it to the game.');
  }

  // ------------------------------------------------------------------ UI panels

  private showUi(): void {
    this.toolbar.style.display = '';
    this.panel.style.display = '';
    this.buildToolbar();
    this.buildPanel();
  }

  private hideUi(): void {
    this.toolbar.style.display = 'none';
    this.panel.style.display = 'none';
  }

  private buildToolbar(): void {
    this.toolbar.replaceChildren(
      el('div', { class: 'ed-title' }, 'LEVEL EDITOR'),
      ...TOOLS.map((t) => {
        const b = el('button', { class: t.id === this.tool ? 'on' : '', title: t.hint }, `${t.key}  ${t.label}`);
        b.onclick = () => this.setTool(t.id);
        return b;
      }),
    );
  }

  private buildPanel(): void {
    const d = this.draft;
    const kids: HTMLElement[] = [];
    const section = (title: string) => kids.push(el('div', { class: 'ed-section' }, title));
    const num = (label: string, get: () => number | undefined, set: (v: number) => void, step = 1) => {
      const input = el('input', { type: 'number', step: String(step), value: String(get() ?? '') }) as HTMLInputElement;
      input.onchange = () => {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v)) return;
        this.snapshot();
        set(v);
        this.changed();
      };
      kids.push(el('label', {}, label, input));
    };
    const txt = (label: string, get: () => string, set: (v: string) => void) => {
      const input = el('input', { type: 'text', value: get() }) as HTMLInputElement;
      input.onchange = () => {
        this.snapshot();
        set(input.value);
        this.changed();
      };
      kids.push(el('label', {}, label, input));
    };
    const check = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
      input.checked = get();
      input.onchange = () => {
        this.snapshot();
        set(input.checked);
        this.changed();
      };
      kids.push(el('label', { class: 'ed-check' }, input, label));
    };
    const button = (label: string, fn: () => void, cls = '') => {
      const b = el('button', { class: cls }, label);
      b.onclick = fn;
      return b;
    };

    kids.push(
      el(
        'div',
        { class: 'ed-actions' },
        button('▶ Test fly  [Enter]', () => this.test(), 'primary'),
        button('💾 Save to project  [Ctrl+S]', () => void this.saveToProject(), 'primary'),
        button('↶ Undo', () => this.undoStep(1)),
        button('↷ Redo', () => this.undoStep(-1)),
        button('📋 Copy JSON', () => {
          void navigator.clipboard?.writeText(formatLevel(this.draft));
          this.flash('Level JSON copied to the clipboard.');
        }),
        button('📥 Paste JSON', () => {
          const t = prompt('Paste level JSON:');
          if (!t) return;
          try {
            const data = JSON.parse(t) as LevelData;
            this.snapshot();
            this.draft = data;
            this.changed();
          } catch {
            this.flash("That isn't valid level JSON.");
          }
        }),
        button('✚ New level', () => this.newLevel()),
        button('⛶ Frame all  [F]', () => this.frameAll()),
        button(`${this.grid ? '☑' : '☐'} Grid snap  [G]`, () => {
          this.grid = !this.grid;
          this.buildPanel();
        }),
        button(`${this.showTight ? '☑' : '☐'} Tight spots  [C]`, () => {
          this.showTight = !this.showTight;
          this.buildPanel();
        }),
        button('✕ Exit editor  [E]', () => this.onExit?.()),
      ),
    );

    section(`LEVEL · ${this.file ?? 'not saved yet'}`);
    txt('Name', () => d.name, (v) => (d.name = v.toUpperCase()));
    num('Width', () => d.width, (v) => (d.width = Math.max(800, v)), 50);
    num('Target time (s)', () => d.targetTime, (v) => (d.targetTime = Math.max(0, v)), 5);
    num('Respawn fuel at pad', () => d.startFuelMin, (v) => (d.startFuelMin = Math.max(0, v)));
    const cp = d.checkpoints?.find((c) => c.after === 'delivery');
    if (cp) num('Respawn fuel after delivery', () => cp.fuel, (v) => (cp.fuel = Math.max(0, v)));
    check('Cave backdrop', () => d.backdropY !== undefined, (v) => (d.backdropY = v ? 640 : undefined));
    if (d.backdropY !== undefined) num('Cave backdrop starts at y', () => d.backdropY, (v) => (d.backdropY = v), 10);

    const s = this.sel;
    if (s) {
      section(`SELECTED · ${selName(s)}`);
      switch (s.kind) {
        case 'pad': {
          const p = d.pads[s.i];
          num('Width', () => p.w, (v) => (p.w = Math.max(60, v)), 10);
          if (p.kind === 'rescue') {
            num('Guards', () => p.guards ?? 0, (v) => (p.guards = Math.max(0, Math.round(v))));
            check('Guards wake only after delivery', () => p.guardsAfter === 'delivery', (v) => (p.guardsAfter = v ? 'delivery' : undefined));
          }
          break;
        }
        case 'balloon': {
          const b = d.balloons![s.i];
          num('Drift range', () => b.patrol ?? config.balloonPatrol, (v) => (b.patrol = Math.max(0, v)), 10);
          break;
        }
        case 'tank': {
          const t = d.fuelTanks![s.i];
          num('Fuel amount', () => t.amount ?? config.tankAmount, (v) => (t.amount = Math.max(1, v)));
          break;
        }
        case 'gate':
        case 'gatevert': {
          const g = d.gates![s.kind === 'gatevert' ? s.gate : s.i];
          const sel = el('select', {}) as HTMLSelectElement;
          sel.append(el('option', { value: 'opens' }, 'Opens when the orb is delivered'), el('option', { value: 'closes' }, 'Seals when you grab the orb'));
          sel.value = g.closes ? 'closes' : 'opens';
          sel.onchange = () => {
            this.snapshot();
            if (sel.value === 'closes') {
              delete g.opens;
              g.closes = 'pickup';
            } else {
              delete g.closes;
              g.opens = 'delivery';
            }
            this.changed();
          };
          kids.push(el('label', {}, 'Behaviour', sel));
          break;
        }
        case 'vert':
          kids.push(el('div', { class: 'ed-note' }, 'Del removes this point · Shift+Del removes the whole shape · double-click an edge to add a point'));
          break;
      }
      if (s.kind !== 'orb' && s.kind !== 'bowl' && !(s.kind === 'pad' && d.pads[s.i].kind === 'start')) kids.push(button('🗑 Delete  [Del]', () => this.deleteSel()));
    }

    section(`CHECKS · ${this.problems.length ? this.problems.length + ' to look at' : 'all good'}`);
    for (const p of this.problems) kids.push(el('div', { class: `ed-problem ${p.level}` }, (p.level === 'error' ? '✖ ' : '⚠ ') + p.text));
    kids.push(
      el(
        'div',
        { class: 'ed-note' },
        'Pan: right-drag, Space+drag or WASD/arrows · Zoom: mouse wheel · Undo: Ctrl+Z · Tight spots: red = too narrow for the heli, amber = too low to carry the orb through.',
      ),
    );
    this.panel.replaceChildren(...kids);
  }
}

// ---------------------------------------------------------------------- helpers

function selName(s: NonNullable<Sel>): string {
  switch (s.kind) {
    case 'vert':
      return 'rock point';
    case 'gatevert':
      return 'gate corner';
    case 'pad':
      return 'pad';
    default:
      return s.kind;
  }
}

function handle(ctx: CanvasRenderingContext2D, p: Vec, px: number, color: string, r: number): void {
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(p.x - (r + 1.5) * px, p.y - (r + 1.5) * px, (r + 1.5) * 2 * px, (r + 1.5) * 2 * px);
  ctx.fillStyle = color;
  ctx.fillRect(p.x - r * px, p.y - r * px, r * 2 * px, r * 2 * px);
}

function label(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, px: number, color: string): void {
  ctx.save();
  ctx.font = `${12 * px}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
  ctx.restore();
}

function el(tag: string, attrs: Record<string, string>, ...kids: (string | Node)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'value') (e as HTMLInputElement).value = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

function isTextField(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function injectStyles(): void {
  if (document.getElementById('ed-styles')) return;
  const s = document.createElement('style');
  s.id = 'ed-styles';
  s.textContent = `
  .ed-toolbar, .ed-panel { position: fixed; z-index: 10; font: 12px ui-monospace, Menlo, Consolas, monospace; color: #cfe9ff;
    background: rgba(8,6,24,0.88); border: 1px solid rgba(90,252,255,0.25); box-shadow: 0 0 18px rgba(90,252,255,0.12); }
  .ed-toolbar { top: 10px; left: 10px; display: flex; flex-direction: column; gap: 3px; padding: 8px; width: 150px; }
  .ed-title { font-weight: bold; color: #ffd23f; letter-spacing: 1px; margin-bottom: 4px; }
  .ed-panel { top: 10px; right: 10px; width: 300px; max-height: calc(100vh - 20px); overflow-y: auto; padding: 10px; }
  .ed-toolbar button, .ed-panel button { font: inherit; color: inherit; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
    padding: 5px 7px; text-align: left; cursor: pointer; border-radius: 3px; }
  .ed-toolbar button:hover, .ed-panel button:hover { background: rgba(90,252,255,0.15); }
  .ed-toolbar button.on { background: rgba(255,210,63,0.25); border-color: #ffd23f; color: #fff4b0; }
  .ed-panel button.primary { background: rgba(61,255,138,0.15); border-color: rgba(61,255,138,0.5); }
  .ed-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .ed-actions button.primary { grid-column: span 2; }
  .ed-section { margin: 12px 0 6px; font-weight: bold; color: #ffd23f; border-bottom: 1px solid rgba(255,210,63,0.25); padding-bottom: 3px; }
  .ed-panel label { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 4px 0; }
  .ed-panel label.ed-check { justify-content: flex-start; }
  .ed-panel input[type=number], .ed-panel input[type=text], .ed-panel select { font: inherit; width: 130px; background: #05040f; color: #7dffb0;
    border: 1px solid rgba(255,255,255,0.2); padding: 3px 5px; }
  .ed-problem { margin: 3px 0; line-height: 1.35; }
  .ed-problem.error { color: #ff6a6a; }
  .ed-problem.warn { color: #ffcf66; }
  .ed-note { margin-top: 8px; color: rgba(207,233,255,0.6); line-height: 1.4; }
  `;
  document.head.append(s);
}
