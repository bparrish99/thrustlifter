import { controlLabel, lastDevice } from './bindings';
import type { Game } from './game';
import type { PadData } from './level';
import type { Vec } from './math';

/*
 * First-level tutorial: short hints that float above the thing they're about, the first time you
 * meet it. A deliberate exception to "show, don't tell" (see DESIGN.md), for level 1 only.
 * Hints name the player's own controls (bindings.ts), as gamepad buttons if they last used a pad.
 * Each hint runs on its own, whatever else is showing: it appears whenever its situation applies, stays
 * until you've done what it says (or for a few seconds), then never again on that run of the level.
 * While you're close enough to do it, it fades out of the way so you can see what you're doing.
 * Overlapping boxes are stacked by the renderer. Anchors are generic (any tank, any orb, any rescue pad), so the hints work
 * on whatever level is first in the play order.
 */

/** Where a hint points: a world position (with how far above it to float), or the fuel gauge on the HUD. */
export type TipAnchor = { world: Vec; lift: number } | 'fuelGauge';

export interface TipView {
  id: string;
  lines: string[];
  at: TipAnchor;
  alpha: number;
}

interface TipDef {
  id: string;
  lines: string[] | ((g: Game) => string[]);
  /** Where to point right now, or null if the hint doesn't apply here and now. */
  anchor(g: Game): TipAnchor | null;
  /** The player has done what the hint asks. */
  done(g: Game): boolean;
  /** Close enough to do it: the hint fades out of the way (and back if you move off again). */
  close?(g: Game): boolean;
  /** Longest time on screen before it gives up (seconds). */
  maxTime?: number;
}

const NEAR_X = 750;
const NEAR_Y = 480;
const near = (g: Game, p: Vec, k = 1) => Math.abs(p.x - g.heli.pos.x) < NEAR_X * k && Math.abs(p.y - g.heli.pos.y) < NEAR_Y * k;
const padTop = (p: PadData): Vec => ({ x: p.x + p.w / 2, y: p.y });
const launchPad = (g: Game) => g.level.data.pads.find((p) => p.kind === 'start');
/** Low over a pad, lining up to land on it. */
const overPad = (g: Game, p: PadData) => g.heli.pos.x > p.x - 60 && g.heli.pos.x < p.x + p.w + 60 && g.heli.pos.y > p.y - 220 && g.heli.pos.y < p.y + 10;
const aboard = (g: Game) => g.survivors.some((s) => s.state === 'aboard');

function nearest<T>(g: Game, items: T[], pos: (t: T) => Vec, k = 1): Vec | null {
  let best: Vec | null = null;
  let bd = Infinity;
  for (const it of items) {
    const p = pos(it);
    const d = Math.hypot(p.x - g.heli.pos.x, p.y - g.heli.pos.y);
    if (d < bd && near(g, p, k)) {
      bd = d;
      best = p;
    }
  }
  return best;
}

/** All the hints (independent of each other; the order is just reading order). */
export const TIPS: TipDef[] = [
  {
    id: 'liftoff',
    lines: () => [`HOLD ${controlLabel('rotor')} TO LIFT OFF`, lastDevice.kind === 'pad' ? 'LEFT STICK TO TILT' : `${controlLabel('left')} ${controlLabel('right')} TO TILT`],
    anchor: (g) => (g.onLaunchPad && g.heli.landed ? { world: g.heli.pos, lift: 80 } : null),
    done: (g) => !g.onLaunchPad,
    maxTime: 1e9,
  },
  {
    id: 'fuel',
    lines: () => ['HOVER OVER A FUEL TANK', `HOLD ${controlLabel('beam')} TO REFUEL`],
    anchor: (g) => {
      // only when there's room in your tank (5% or more) (Space does nothing over a tank when you're full)
      if (g.orb.attached || g.fuel > g.cfg.fuelMax * 0.95) return null;
      const p = nearest(g, g.fuelTanks.filter((t) => t.alive), (t) => t.pos, 0.8);
      return p ? { world: p, lift: 60 } : null;
    },
    done: (g) => g.refueling,
    close: (g) => g.tankInReach() !== null,
    maxTime: 8,
  },
  {
    id: 'lowFuel',
    lines: (g) => ['LOW FUEL', g.fuelTanks.some((t) => t.alive) ? 'FIND A FUEL TANK' : 'GO EASY ON THE ROTOR'],
    anchor: (g) => (g.fuel < g.cfg.fuelMax * 0.25 && !g.heli.landed ? 'fuelGauge' : null),
    done: (g) => g.fuel > g.cfg.fuelMax * 0.5,
  },
  {
    id: 'orb',
    lines: () => ['HOVER OVER THE ORB', `HOLD ${controlLabel('beam')} TO TETHER IT`],
    anchor: (g) => (!g.orb.attached && !g.orb.delivered && !g.orb.free && near(g, g.orb.pos) ? { world: g.orb.pos, lift: 60 } : null),
    done: (g) => g.orb.attached,
    close: (g) => g.orbInReach(),
    maxTime: 12,
  },
  {
    id: 'bowl',
    lines: () => ['LOWER THE ORB IN', `TAP ${controlLabel('beam')} TO LET GO`],
    anchor: (g) => {
      const b = g.level.data.bowl;
      return g.orb.attached && near(g, b, 1.3) ? { world: b, lift: 70 } : null;
    },
    done: (g) => g.orb.delivered,
    close: (g) => Math.abs(g.orb.pos.x - g.level.bowl.cx) < 80 && g.orb.pos.y > g.level.bowl.rimY - 220,
    maxTime: 12,
  },
  {
    id: 'rescue',
    lines: ['RESCUE HOSTAGES'],
    anchor: (g) => {
      const waiting = g.survivors.filter((s) => s.state === 'waiting');
      const pads = g.level.data.pads.filter((p) => p.kind === 'rescue' && waiting.some((s) => Math.abs(s.pos.x - (p.x + p.w / 2)) < 300 + p.w));
      const p = nearest(g, pads, padTop);
      return p ? { world: p, lift: 70 } : null;
    },
    done: aboard,
    close: (g) => g.level.data.pads.some((p) => p.kind === 'rescue' && overPad(g, p)),
    maxTime: 1e9, // stays while you're near the pad; goes if you fly off, and comes back when you return
  },
  {
    // right after the first delivery, wherever you are: the job isn't over until you're home
    id: 'flyBack',
    lines: (g) => {
      const pad = launchPad(g);
      const left = pad ? padTop(pad).x < g.heli.pos.x : true;
      return left ? ['ORB DELIVERED!', '◀ NOW FLY BACK TO YOUR PAD'] : ['ORB DELIVERED!', 'NOW FLY BACK TO YOUR PAD ▶'];
    },
    anchor: (g) => (g.orb.delivered && g.phase === 'playing' ? { world: g.heli.pos, lift: 80 } : null),
    done: (g) => {
      const pad = launchPad(g);
      return g.phase === 'complete' || (!!pad && near(g, padTop(pad), 1.3));
    },
    maxTime: 7,
  },
  {
    id: 'fight',
    lines: () => [`${controlLabel('fire')} TO FIRE · ${controlLabel('flip')} TO TURN AROUND`, `HOLD ${controlLabel('beam')} FOR A SHIELD`],
    anchor: (g) => {
      if (!g.exposed) return null;
      const p =
        nearest(g, g.balloons.filter((b) => b.alive), (b) => b.pos) ??
        nearest(g, g.turrets.filter((t) => t.alive), (t) => t.pos) ??
        nearest(g, g.enemies.filter((e) => e.alive && e.state !== 'parked'), (e) => e.pos);
      return p ? { world: p, lift: 70 } : null;
    },
    done: (g) => g.events.some((e) => e.type === 'balloonPop' || e.type === 'turretDown' || e.type === 'heliDown'),
    maxTime: 7,
  },
  {
    id: 'home',
    lines: ['LAND TO COMPLETE THE MISSION'],
    anchor: (g) => {
      const pad = launchPad(g);
      return pad && g.orb.delivered && near(g, padTop(pad), 1.3) ? { world: padTop(pad), lift: 70 } : null;
    },
    done: (g) => g.phase === 'complete',
    close: (g) => !!launchPad(g) && overPad(g, launchPad(g)!),
    maxTime: 1e9, // stays over the pad until you land
  },
];

const FADE_IN = 0.3;
const FADE_OUT = 0.5;
/** Fade out of the way when you're close enough to do what a hint says. */
const FADE_CLOSE = 0.25;
const DEFAULT_MAX = 8;
/** If the thing it points at drops out of range for this long, the hint goes away (and may come back later). */
const LOST_GRACE = 1.2;

export class Tutorial {
  /** Hints already shown (finished or timed out). */
  readonly seen = new Set<string>();
  /** Hints on screen (or fading), each running on its own. */
  private live = new Map<string, { def: TipDef; t: number; out: number; lost: number; at: TipAnchor; vis: number }>();
  private game: Game | null = null;

  update(g: Game, dt: number): void {
    this.game = g;
    const playing = g.phase === 'playing';
    for (const def of TIPS) {
      const c = this.live.get(def.id);
      if (c) {
        const at = playing ? def.anchor(g) : null;
        // close enough to do it: get out of the way (the clock pauses meanwhile)
        const close = !!at && !!def.close?.(g);
        c.vis = close ? Math.max(0, c.vis - dt / FADE_CLOSE) : Math.min(1, c.vis + dt / FADE_CLOSE);
        if (at) {
          c.at = at;
          c.lost = 0;
          if (!close) c.t += dt;
        } else c.lost += dt;
        const finished = def.done(g) || c.t > (def.maxTime ?? DEFAULT_MAX);
        if (finished) this.seen.add(def.id);
        if (finished || c.lost > LOST_GRACE) c.out += dt;
        if (c.out >= FADE_OUT) this.live.delete(def.id);
        continue;
      }
      if (!playing || this.seen.has(def.id) || def.done(g)) continue;
      const at = def.anchor(g);
      if (at) this.live.set(def.id, { def, t: 0, out: 0, lost: 0, at, vis: def.close?.(g) ? 0 : 1 });
    }
  }

  /** The hints to draw this frame. */
  get views(): TipView[] {
    return [...this.live.values()].map((c) => {
      const fadeIn = Math.min(1, c.t / FADE_IN);
      const fadeOut = c.out > 0 ? Math.max(0, 1 - c.out / FADE_OUT) : c.lost > 0 ? Math.max(0, 1 - c.lost / 0.4) : 1;
      const lines = typeof c.def.lines === 'function' ? c.def.lines(this.game!) : c.def.lines;
      return { id: c.def.id, lines, at: c.at, alpha: Math.min(fadeIn, fadeOut) * c.vis };
    });
  }

  /** Ids of the hints currently up (for tests and console poking). */
  get showing(): string[] {
    return [...this.live.values()].filter((c) => c.out === 0 && c.lost === 0 && c.vis > 0).map((c) => c.def.id);
  }
}
