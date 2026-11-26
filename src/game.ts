import { config } from './config';
import { buildLevel, resetGates, segmentsNear, type Level, type LevelData, type PadData, type Segment } from './level';
import { add, closestPointSegment, deg, dist, distPointSegment, dot, len, scale, segmentIntersectionT, segmentsIntersect, sub, type Vec } from './math';
import {
  ANCHOR,
  HULL_RADIUS,
  NOSE,
  ROTOR_R,
  ROTOR_Y,
  SKID_Y,
  createHeli,
  heliPoint,
  hullWorld,
  integrate,
  noseDir,
  rotorNormal,
  solveRod,
  thrustForce,
  updateControls,
  type Body,
  type HeliState,
} from './physics';

export interface FrameInput {
  tiltAxis: number;
  rotor: number;
  dive: number; // 0..1, arcade 'push down' (not realistic, on purpose)
  fire: boolean;
  flip: boolean; // edge
  pickup: boolean; // held: tether
  pickupPressed: boolean; // edge: release when carrying
  restart: boolean; // edge
}

export interface Orb extends Body {
  home: Vec;
  attached: boolean;
  free: boolean; // released: simulated, bounces and rolls
  delivered: boolean;
  deliveredAt: number;
}

export interface Projectile {
  kind: 'missile' | 'enemy';
  pos: Vec;
  vel: Vec;
  life: number;
  // missiles only: launched slow, then their motor accelerates them along `dir`
  dir?: Vec;
  base?: Vec; // velocity inherited from the heli at launch
  speed?: number; // motor speed along dir, ramps up to missileSpeed
}

export interface Turret {
  pos: Vec; // base, on the surface
  normal: Vec; // direction it faces (out of the surface)
  alive: boolean;
  aim: number; // barrel angle (radians, world)
  cooldown: number; // seconds until it may fire
  charge: number; // 0..1 telegraph glow before a shot
  tracking: boolean; // has line of sight to the heli
}

/** Things that happened this frame, for sound (and anything else that wants to react). */
export type GameEvent =
  | { type: 'gate' | 'missile' | 'enemyShot' | 'tether' | 'release' | 'orbLost' | 'delivered' | 'complete' | 'turretDown' | 'heliDown' | 'impact' | 'liftoff' | 'land'; pos?: Vec };

export interface Particle {
  pos: Vec;
  vel: Vec;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  drag: number;
  grav: number;
}

/** A tumbling line fragment: vector-style debris. */
export interface Shard {
  pos: Vec; // centre
  half: Vec; // half-extent vector at angle 0
  vel: Vec;
  ang: number;
  angVel: number;
  life: number;
  maxLife: number;
  color: string;
}

export interface Ring {
  pos: Vec;
  t: number;
  life: number;
  radius: number;
  color: string;
}

export interface Message {
  text: string;
  sub?: string;
  color: string;
  t: number;
  life: number;
}

export type Phase = 'playing' | 'dead' | 'complete';

export const STEP = 1 / 240;
export const TURRET_RADIUS = 22; // dome size; also the collision size
const RESPAWN_DELAY = 2.2;
const CEILING = -1500;

export const COLORS = {
  heli: '#ffd23f',
  orb: '#ff3df2',
  missile: '#7dffb0',
  target: '#ff4a4a',
  enemyShot: '#ff6a3d',
  spark: ['#ffffff', '#ffd23f', '#ff8a3d', '#ff3df2'],
  dust: '#7fd6ff',
};

export class Game {
  readonly cfg = config;
  level: Level;
  heli!: HeliState;
  orb!: Orb;
  turrets: Turret[] = [];
  projectiles: Projectile[] = [];
  particles: Particle[] = [];
  rings: Ring[] = [];
  shards: Shard[] = [];
  events: GameEvent[] = [];
  screenFlash = 0;
  message: Message | null = null;

  phase: Phase = 'playing';
  phaseTime = 0;
  time = 0; // since level start
  deaths = 0;
  shake = 0;
  beam = false; // tether beam visible this frame
  beamProgress = 0; // 0..1: how close the beam is to locking (distance / rod length)
  facingVis = 1; // animated facing for rendering
  rotorPhase = 0;
  rotorSpin = 0; // eases toward throttle (drives sound intensity)
  rotorSpeed = 0; // visual rotor speed 0..1: rotorSpin, but never below a floor while airborne
  private rotorFloor = 0;
  lastCrash = '';
  lastOrbLoss = '';
  completedAt: number | null = null;
  private tetherArmed = true; // must let go of Space after a release before tethering again
  private orbLostTimer = 0;
  private settleTime = 0;

  private acc = 0;
  private missileCd = 0;

  readonly levelNumber: number;
  readonly hasNextLevel: boolean;

  constructor(data: LevelData, opts: { levelNumber?: number; hasNextLevel?: boolean } = {}) {
    this.levelNumber = opts.levelNumber ?? 1;
    this.hasNextLevel = opts.hasNextLevel ?? false;
    this.level = buildLevel(data);
    this.restart();
  }

  get alive(): boolean {
    return this.phase !== 'dead';
  }

  restart(): void {
    const d = this.level.data;
    this.turrets = d.turrets.map((t) => {
      const a = deg(t.dir ?? -90);
      const normal = { x: Math.cos(a), y: Math.sin(a) };
      return { pos: { x: t.x, y: t.y }, normal, alive: true, aim: a, cooldown: 1 + Math.random() * this.cfg.turretInterval, charge: 0, tracking: false };
    });
    this.orb = {
      pos: { ...d.orb },
      vel: { x: 0, y: 0 },
      mass: this.cfg.orbMass,
      home: { ...d.orb },
      attached: false,
      free: false,
      delivered: false,
      deliveredAt: 0,
    };
    this.projectiles = [];
    this.particles = [];
    this.rings = [];
    this.shards = [];
    this.events = [];
    this.deaths = 0;
    this.time = 0;
    this.orbLostTimer = 0;
    this.settleTime = 0;
    this.tetherArmed = true;
    this.completedAt = null;
    resetGates(this.level);
    this.phase = 'playing';
    this.phaseTime = 0;
    this.spawnHeli();
    this.flash('LIFT THE ORB', 'get it into the bowl', COLORS.orb, 3);
  }

  private spawnHeli(): void {
    const pad = this.level.startPad;
    this.heli = createHeli({ x: pad.x + pad.w / 2, y: pad.y - SKID_Y - 0.05 }, this.cfg);
    this.heli.landed = true;
    this.facingVis = 1;
    this.acc = 0;
  }

  flash(text: string, sub: string | undefined, color: string, life = 2): void {
    this.message = { text, sub, color, t: 0, life };
  }

  // ---------------------------------------------------------------- update

  update(input: FrameInput, dt: number): void {
    if (input.restart) {
      this.restart();
      return;
    }
    if (input.flip && this.alive) this.heli.facing = this.heli.facing === 1 ? -1 : 1;
    if (input.pickupPressed && this.alive && this.orb.attached) this.release();

    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP && n < 40) {
      this.substep(input, STEP);
      this.acc -= STEP;
      n++;
    }
    if (n >= 40) this.acc = 0;

    this.frameEffects(input, dt);
  }

  private substep(input: FrameInput, dt: number): void {
    const cfg = this.cfg;
    const h = this.heli;
    const orb = this.orb;
    this.time += dt;
    this.phaseTime += dt;
    h.mass = cfg.heliMass;
    orb.mass = cfg.orbMass;

    if (this.phase === 'dead') {
      if (this.phaseTime >= RESPAWN_DELAY) this.respawn();
    } else {
      updateControls(h, input, cfg, dt);

      if (h.landed && h.throttle * cfg.maxThrust > h.mass * cfg.gravity) {
        h.landed = false;
        this.events.push({ type: 'liftoff', pos: h.pos });
      }

      if (!h.landed) {
        const f = thrustForce(h, cfg);
        f.y += Math.max(0, Math.min(1, input.dive)) * cfg.diveAccel * h.mass; // straight down, world space
        integrate(h, f, cfg.gravity, cfg.heliDrag, dt);
        if (h.pos.y < CEILING) {
          h.pos.y = CEILING;
          h.vel.y = Math.max(h.vel.y, 0);
        }
      }
      if (orb.attached) {
        integrate(orb, { x: 0, y: 0 }, cfg.gravity, cfg.orbDrag, dt);
        solveRod(h, heliPoint(h, ANCHOR), orb, cfg.rodLength, h.landed);
      }

      this.collide();
      if (this.alive) this.pickupAndDeliver(input);
      if (!input.pickup) this.tetherArmed = true;
      if (this.alive) this.weapons(input, dt);
    }

    if (orb.free) this.stepFreeOrb(dt);
    if (this.orbLostTimer > 0) {
      this.orbLostTimer -= dt;
      if (this.orbLostTimer <= 0) this.resetOrb();
    }
    this.stepTurrets(dt);
    this.stepProjectiles(dt);
  }

  private resetOrb(): void {
    const orb = this.orb;
    orb.attached = false;
    orb.free = false;
    orb.pos = { ...orb.home };
    orb.vel = { x: 0, y: 0 };
    this.orbLostTimer = 0;
    this.settleTime = 0;
  }

  private respawn(): void {
    this.phase = this.completedAt !== null ? 'complete' : 'playing';
    this.phaseTime = 0;
    if (!this.orb.delivered) {
      this.resetOrb();
      resetGates(this.level);
    }
    this.spawnHeli();
  }

  // ------------------------------------------------------------- collision

  private nearHeli(): Segment[] {
    const p = this.heli.pos;
    const r = HULL_RADIUS;
    return segmentsNear(this.level, p.x - r, p.y - r, p.x + r, p.y + r);
  }

  private collide(): void {
    const h = this.heli;
    const orb = this.orb;
    const cfg = this.cfg;

    if (!h.landed) {
      const hull = hullWorld(h);
      let crash = false;
      let pad: PadData | null = null;
      for (const s of this.nearHeli()) {
        for (const hs of hull) {
          if (!segmentsIntersect(hs.a, hs.b, s.a, s.b)) continue;
          if (hs.gear && s.pad) pad = s.pad;
          else crash = true;
        }
      }
      if (crash) return this.crash('TERRAIN IMPACT');
      if (pad) {
        const speed = len(h.vel);
        if (h.vel.y < 0) {
          // scraping upward off a pad: harmless
        } else if (speed <= cfg.landMaxSpeed && Math.abs(h.tilt) <= deg(cfg.landMaxTiltDeg)) {
          this.land(pad);
        } else {
          return this.crash(speed > cfg.landMaxSpeed ? 'HARD LANDING' : 'LANDED CROOKED');
        }
      }

      for (const t of this.turrets) {
        if (!t.alive || dist(t.pos, h.pos) > HULL_RADIUS + TURRET_RADIUS) continue;
        const c = turretCentre(t);
        if (hull.some((hs) => distPointSegment(c, hs.a, hs.b) < TURRET_RADIUS)) return this.crash('HIT A TURRET');
      }

      if (!orb.attached && !orb.delivered && dist(orb.pos, h.pos) < HULL_RADIUS + cfg.orbRadius) {
        if (hull.some((hs) => distPointSegment(orb.pos, hs.a, hs.b) < cfg.orbRadius)) return this.crash('HIT THE ORB');
      }

      if (orb.attached) {
        const rotor = hull.find((hs) => hs.rotor)!;
        if (segmentsIntersect(heliPoint(h, ANCHOR), orb.pos, rotor.a, rotor.b)) return this.crash('ROTOR STRIKE');
      }
    }

    if (orb.attached) {
      const r = cfg.orbRadius;
      const p = orb.pos;
      for (const s of segmentsNear(this.level, p.x - r, p.y - r, p.x + r, p.y + r)) {
        if (distPointSegment(p, s.a, s.b) >= r - 0.5) continue;
        if (s.bowl) return this.bowlContact(s);
        return this.loseOrb('it hit the ground');
      }
      for (const t of this.turrets) {
        if (t.alive && dist(p, turretCentre(t)) < r + TURRET_RADIUS) return this.loseOrb('it hit a turret');
      }
    }
  }

  /** Carried orb touched the bowl: gentle enough = it lets go and the bowl takes it; too hard = shattered. */
  private bowlContact(s: Segment): void {
    const impact = this.impactSpeed(s);
    if (impact <= this.cfg.orbMaxImpact) return this.release();
    this.loseOrb(`impact ${impact.toFixed(0)} > ${this.cfg.orbMaxImpact}`);
  }

  /** How hard the orb is moving into a segment (normal component of velocity). */
  private impactSpeed(s: Segment): number {
    const c = closestPointSegment(this.orb.pos, s.a, s.b);
    const d = dist(this.orb.pos, c) || 1;
    const n = { x: (this.orb.pos.x - c.x) / d, y: (this.orb.pos.y - c.y) / d };
    return Math.max(0, -dot(this.orb.vel, n));
  }

  /** Let go of the orb. It keeps its momentum. */
  private release(): void {
    const orb = this.orb;
    if (!orb.attached) return;
    orb.attached = false;
    orb.free = true;
    this.tetherArmed = false;
    this.settleTime = 0;
    this.ring(heliPoint(this.heli, ANCHOR), 24, COLORS.orb, 0.3);
    this.events.push({ type: 'release', pos: orb.pos });
  }

  /** A released orb: gravity, bounces, rolling, shattering on hard hits, settling into the bowl. */
  private stepFreeOrb(dt: number): void {
    const cfg = this.cfg;
    const orb = this.orb;
    const r = cfg.orbRadius;
    integrate(orb, { x: 0, y: 0 }, cfg.gravity, cfg.orbDrag, dt);

    // Only the bowl is soft: touching ground or a turret destroys the orb.
    const contacts: { n: Vec; pen: number }[] = [];
    for (const s of segmentsNear(this.level, orb.pos.x - r, orb.pos.y - r, orb.pos.x + r, orb.pos.y + r)) {
      const c = closestPointSegment(orb.pos, s.a, s.b);
      const d = dist(orb.pos, c);
      if (d >= r || d < 1e-6) continue;
      if (!s.bowl) return this.loseOrb('it hit the ground');
      contacts.push({ n: { x: (orb.pos.x - c.x) / d, y: (orb.pos.y - c.y) / d }, pen: r - d });
    }
    for (const t of this.turrets) {
      if (t.alive && dist(orb.pos, turretCentre(t)) < r + TURRET_RADIUS) return this.loseOrb('it hit a turret');
    }
    for (const { n, pen } of contacts) {
      orb.pos.x += n.x * pen;
      orb.pos.y += n.y * pen;
      const vn = dot(orb.vel, n);
      if (vn >= 0) continue;
      const impact = -vn;
      if (impact > cfg.orbMaxImpact) return this.loseOrb(`impact ${impact.toFixed(0)} > ${cfg.orbMaxImpact}`);
      const e = impact < 25 ? 0 : cfg.orbBounce; // small knocks don't bounce, so it can settle
      const tx = orb.vel.x - vn * n.x;
      const ty = orb.vel.y - vn * n.y;
      const keep = 1 - 0.6 * dt * 10; // rolling friction along the surface
      orb.vel.x = tx * keep - e * vn * n.x;
      orb.vel.y = ty * keep - e * vn * n.y;
    }

    // delivered once it comes to rest in the cup
    const bowl = this.level.bowl;
    const inCup = Math.abs(orb.pos.x - bowl.cx) < bowl.innerR && orb.pos.y > bowl.rimY;
    if (inCup && len(orb.vel) < 25) {
      this.settleTime += dt;
      if (this.settleTime > 0.35) this.deliver();
    } else {
      this.settleTime = 0;
    }
  }

  /** Orb destroyed (carried or dropped): the pilot lives, the orb respawns on its pedestal. */
  private loseOrb(why: string): void {
    const orb = this.orb;
    if (orb.delivered || this.orbLostTimer > 0) return;
    orb.attached = false;
    this.beam = false;
    this.explode(orb.pos, 60, 300, COLORS.orb);
    for (let k = 0; k < 8; k++) {
      const a0 = (k * Math.PI) / 4;
      const a1 = a0 + Math.PI / 4;
      const r = this.cfg.orbRadius;
      this.shatter({ x: orb.pos.x + Math.cos(a0) * r, y: orb.pos.y + Math.sin(a0) * r }, { x: orb.pos.x + Math.cos(a1) * r, y: orb.pos.y + Math.sin(a1) * r }, orb.vel, COLORS.orb);
    }
    this.shake = Math.max(this.shake, 0.5);
    this.lastOrbLoss = why;
    this.events.push({ type: 'orbLost', pos: { ...orb.pos } });
    orb.free = false;
    orb.pos = { x: -99999, y: -99999 };
    orb.vel = { x: 0, y: 0 };
    this.orbLostTimer = 2;
    this.flash('ORB DESTROYED', `${why}  ·  a new one is back on the pedestal`, COLORS.orb, 2);
  }

  private deliver(): void {
    const orb = this.orb;
    orb.attached = false;
    orb.free = false;
    orb.delivered = true;
    orb.deliveredAt = this.time;
    orb.vel = { x: 0, y: 0 };
    const at = this.level.bowl.rest;
    this.ring(at, 140, '#ffb020', 1);
    this.ring(at, 90, COLORS.orb, 0.8);
    this.explode(at, 50, 220, '#ffb020');
    const opening = this.level.gates.filter((gt) => gt.opens === 'delivery' && !gt.open);
    opening.forEach((gt) => (gt.open = true));
    if (opening.length) this.events.push({ type: 'gate' });
    this.flash('ORB DELIVERED', opening.length ? 'a gate has opened · find your way back to the pad' : 'now return to your pad', '#ffb020', 3.5);
    this.events.push({ type: 'delivered', pos: at });
  }

  /** Landed back on the start pad with the orb in the bowl: mission complete. */
  private complete(): void {
    this.phase = 'complete';
    this.completedAt = this.time;
    const h = this.heli;
    this.ring(h.pos, 160, '#3dff8a', 1.2);
    this.ring(h.pos, 100, '#ffb020', 0.9);
    this.explode({ x: h.pos.x, y: h.pos.y - 30 }, 70, 260, '#3dff8a');
    const d = this.deaths === 1 ? '1 death' : `${this.deaths} deaths`;
    this.events.push({ type: 'complete', pos: h.pos });
    const next = this.hasNextLevel ? 'N next level  ·  R retry' : 'all levels done  ·  R retry';
    this.flash('MISSION COMPLETE', `${this.time.toFixed(1)}s  ·  ${d}  ·  ${next}`, '#3dff8a', 1e9);
  }

  private land(pad: PadData): void {
    const h = this.heli;
    h.landed = true;
    h.vel = { x: 0, y: 0 };
    h.tilt = 0;
    h.tiltTarget = 0;
    h.pos.y = pad.y - SKID_Y - 0.05;
    this.events.push({ type: 'land', pos: h.pos });
    if (pad.kind === 'start' && this.orb.delivered && this.phase === 'playing') this.complete();
  }

  private crash(reason: string): void {
    const h = this.heli;
    this.phase = 'dead';
    this.phaseTime = 0;
    this.deaths++;
    this.shake = 1;
    this.lastCrash = reason;
    this.explode(h.pos, 90, 420);
    this.screenFlash = 1;
    for (const s of hullWorld(h)) this.shatter(s.a, s.b, h.vel, COLORS.heli);
    this.events.push({ type: 'heliDown', pos: h.pos });
    if (this.orb.attached) {
      this.explode(this.orb.pos, 50, 300, COLORS.orb);
      this.orb.attached = false;
      this.orb.pos = { x: -99999, y: -99999 }; // hidden until respawn
    }
    this.flash('CRASHED', reason, '#ff4a4a', RESPAWN_DELAY);
  }

  // ------------------------------------------------------ pickup / deliver

  private pickupAndDeliver(input: FrameInput): void {
    const h = this.heli;
    const orb = this.orb;
    const L = this.cfg.rodLength;
    this.beam = false;
    if (orb.delivered) return;

    if (!orb.attached) {
      if (!input.pickup || !this.tetherArmed || this.orbLostTimer > 0) return;
      const anchor = heliPoint(h, ANCHOR);
      const d = dist(anchor, orb.pos);
      if (d > L + 0.5) return;
      this.beam = true;
      this.beamProgress = Math.min(1, d / L);
      // Lock the rod once we reach full length while separating (or still),
      // so we never ram the orb into the ground on attach.
      const dir = scale(sub(orb.pos, anchor), 1 / Math.max(d, 1e-6));
      if (d >= L - 0.5 && dot(sub(h.vel, orb.vel), dir) <= 5) {
        orb.attached = true;
        orb.free = false;
        solveRod(h, anchor, orb, L, h.landed);
        this.events.push({ type: 'tether', pos: orb.pos });
        const sealing = this.level.gates.filter((gt) => gt.closes === 'pickup' && gt.open);
        sealing.forEach((gt) => (gt.open = false));
        if (sealing.length) {
          this.flash('ORB SECURED', 'the way you came in has sealed', COLORS.orb, 2.5);
          this.events.push({ type: 'gate' });
        } else {
          this.flash('ORB SECURED', undefined, COLORS.orb, 1.4);
        }
        this.ring(orb.pos, 50, COLORS.orb, 0.5);
      }
    }
  }

  // ---------------------------------------------------------------- weapons

  private weapons(input: FrameInput, dt: number): void {
    const h = this.heli;
    const cfg = this.cfg;
    this.missileCd -= dt;

    if (input.fire && this.missileCd <= 0 && !h.landed) {
      this.missileCd = cfg.missileCooldown;
      const dir = noseDir(h.tilt, h.facing);
      const speed = Math.min(cfg.missileLaunchSpeed, cfg.missileSpeed);
      this.projectiles.push({
        kind: 'missile',
        pos: heliPoint(h, NOSE),
        vel: add(h.vel, scale(dir, speed)),
        life: cfg.missileLife,
        dir,
        base: { ...h.vel },
        speed,
      });
      this.events.push({ type: 'missile', pos: heliPoint(h, NOSE) });
    }

  }

  /** Turrets track the heli, telegraph with a charge glow, then fire. Line of sight and a firing arc required. */
  private stepTurrets(dt: number): void {
    const cfg = this.cfg;
    const h = this.heli;
    for (const t of this.turrets) {
      if (!t.alive) continue;
      const c = turretCentre(t);
      const base = Math.atan2(t.normal.y, t.normal.x);
      const arc = deg(cfg.turretArcDeg);
      let want = base;
      t.tracking = false;
      if (this.alive && dist(c, h.pos) < cfg.turretRange) {
        // aim with partial lead on the heli's motion
        const tFly = dist(c, h.pos) / cfg.turretShotSpeed;
        const aimAt = { x: h.pos.x + h.vel.x * tFly * cfg.turretLead, y: h.pos.y + h.vel.y * tFly * cfg.turretLead };
        const ang = Math.atan2(aimAt.y - c.y, aimAt.x - c.x);
        const off = wrapAngle(ang - base);
        if (Math.abs(off) <= arc && this.lineOfSight(c, h.pos)) {
          t.tracking = true;
          want = ang;
        } else {
          want = base + Math.max(-arc, Math.min(arc, off)) * 0.3; // drift toward you, but can't see you
        }
      }
      // slew the barrel
      const d = wrapAngle(want - t.aim);
      const maxTurn = 2.2 * dt;
      t.aim += Math.max(-maxTurn, Math.min(maxTurn, d));

      t.cooldown -= dt;
      const canFire = t.tracking && Math.abs(wrapAngle(want - t.aim)) < 0.12;
      t.charge = canFire && t.cooldown < cfg.turretCharge ? 1 - Math.max(0, t.cooldown) / cfg.turretCharge : Math.max(0, t.charge - dt * 4);
      if (t.cooldown <= 0) {
        if (canFire) {
          const spread = (Math.random() - 0.5) * deg(4);
          const dir = { x: Math.cos(t.aim + spread), y: Math.sin(t.aim + spread) };
          const muzzle = { x: c.x + dir.x * TURRET_BARREL, y: c.y + dir.y * TURRET_BARREL };
          this.projectiles.push({ kind: 'enemy', pos: muzzle, vel: scale(dir, cfg.turretShotSpeed), life: cfg.turretRange / cfg.turretShotSpeed + 0.6 });
          this.events.push({ type: 'enemyShot', pos: muzzle });
          for (let i = 0; i < 6; i++) {
            const a = t.aim + (Math.random() - 0.5) * 0.8;
            const sp = 60 + Math.random() * 120;
            const life = 0.15 + Math.random() * 0.15;
            this.particles.push({ pos: { ...muzzle }, vel: { x: Math.cos(a) * sp, y: Math.sin(a) * sp }, life, maxLife: life, color: COLORS.enemyShot, size: 1, drag: 4, grav: 0 });
          }
          t.cooldown = cfg.turretInterval * (0.8 + Math.random() * 0.4);
          t.charge = 0;
        } else {
          t.cooldown = Math.min(cfg.turretCharge * 0.6, cfg.turretInterval); // ready again soon after it reacquires
        }
      }
    }
  }

  private lineOfSight(a: Vec, b: Vec): boolean {
    const near = segmentsNear(this.level, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
    return !near.some((s) => segmentsIntersect(a, b, s.a, s.b));
  }

  private stepProjectiles(dt: number): void {
    const keep: Projectile[] = [];
    for (const p of this.projectiles) {
      const prev = { ...p.pos };
      if (p.kind === 'missile' && p.dir && p.base && p.speed !== undefined) {
        p.speed = Math.min(this.cfg.missileSpeed, p.speed + this.cfg.missileAccel * dt);
        p.vel = add(p.base, scale(p.dir, p.speed));
      }
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.life -= dt;

      let hit: Vec | null = null;
      if (p.kind === 'enemy' && this.alive && dist(p.pos, this.heli.pos) < HULL_RADIUS + 10) {
        const hull = hullWorld(this.heli);
        if (hull.some((hs) => segmentsIntersect(prev, p.pos, hs.a, hs.b) || distPointSegment(p.pos, hs.a, hs.b) < 2.5)) {
          hit = p.pos;
          this.crash('SHOT DOWN');
        }
      }
      const orb = this.orb;
      if (!hit && !orb.delivered && this.orbLostTimer <= 0 && distPointSegment(orb.pos, prev, p.pos) < this.cfg.orbRadius + 2) {
        hit = p.pos;
        this.loseOrb('it was shot');
      }
      for (const t of hit || p.kind === 'enemy' ? [] : this.turrets) {
        if (t.alive && distPointSegment(turretCentre(t), prev, p.pos) < TURRET_RADIUS + TURRET_HIT_SLACK) {
          t.alive = false;
          hit = p.pos;
          this.explode(turretCentre(t), 70, 360, COLORS.target);
          const base = Math.atan2(t.normal.y, t.normal.x);
          for (let k = 0; k < 6; k++) {
            const a0 = base - Math.PI / 2 + (k * Math.PI) / 6;
            const a1 = a0 + Math.PI / 6;
            const r = TURRET_RADIUS;
            this.shatter({ x: t.pos.x + Math.cos(a0) * r, y: t.pos.y + Math.sin(a0) * r }, { x: t.pos.x + Math.cos(a1) * r, y: t.pos.y + Math.sin(a1) * r }, scale(t.normal, 120), COLORS.target);
          }
          this.events.push({ type: 'turretDown', pos: turretCentre(t) });
          this.ring(turretCentre(t), 70, COLORS.target, 0.6);
          this.shake = Math.max(this.shake, 0.4);
          break;
        }
      }
      if (!hit) {
        const near = segmentsNear(
          this.level,
          Math.min(prev.x, p.pos.x),
          Math.min(prev.y, p.pos.y),
          Math.max(prev.x, p.pos.x),
          Math.max(prev.y, p.pos.y),
        );
        for (const s of near) {
          const t = segmentIntersectionT(prev, p.pos, s.a, s.b);
          if (t !== null) {
            hit = { x: prev.x + (p.pos.x - prev.x) * t, y: prev.y + (p.pos.y - prev.y) * t };
            if (p.kind === 'enemy') {
              this.explode(hit, 8, 120, COLORS.enemyShot);
            } else {
              this.explode(hit, 18, 180, COLORS.missile);
              this.events.push({ type: 'impact', pos: hit });
            }
            break;
          }
        }
      }
      if (!hit && p.life > 0) keep.push(p);
    }
    this.projectiles = keep;
  }

  // ---------------------------------------------------------------- effects

  explode(at: Vec, count: number, speed: number, tint?: string): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.2 + Math.random() * 0.8);
      const life = 0.4 + Math.random() * 0.9;
      this.particles.push({
        pos: { ...at },
        vel: { x: Math.cos(a) * s, y: Math.sin(a) * s },
        life,
        maxLife: life,
        color: tint && Math.random() < 0.5 ? tint : COLORS.spark[(Math.random() * COLORS.spark.length) | 0],
        size: 1 + Math.random() * 2,
        drag: 2.2,
        grav: 0.5,
      });
    }
    this.ring(at, speed * 0.35, tint ?? '#ffffff', 0.45);
  }

  /** Break a line segment into a tumbling shard flung outward. */
  shatter(a: Vec, b: Vec, baseVel: Vec, color: string): void {
    const pos = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const ang = -Math.PI * (0.1 + Math.random() * 0.8); // burst upward and outward
    const sp = 80 + Math.random() * 220;
    const life = 1.2 + Math.random() * 1.0;
    this.shards.push({
      pos,
      half: { x: (b.x - a.x) / 2, y: (b.y - a.y) / 2 },
      vel: { x: baseVel.x * 0.3 + Math.cos(ang) * sp, y: Math.min(0, baseVel.y * 0.2) + Math.sin(ang) * sp },
      ang: 0,
      angVel: (Math.random() - 0.5) * 18,
      life,
      maxLife: life,
      color,
    });
  }

  ring(pos: Vec, radius: number, color: string, life: number): void {
    this.rings.push({ pos: { ...pos }, t: 0, life, radius, color });
  }

  private frameEffects(input: FrameInput, dt: number): void {
    const h = this.heli;
    this.facingVis += (h.facing - this.facingVis) * (1 - Math.exp(-18 * dt));
    this.rotorSpin += (h.throttle - this.rotorSpin) * (1 - Math.exp(-6 * dt));
    // matches the sound: airborne, the rotor never drops back to pad-idle speed
    this.rotorFloor += ((h.landed || !this.alive ? 0 : 0.5) - this.rotorFloor) * (1 - Math.exp(-3 * dt));
    this.rotorSpeed = Math.max(this.rotorSpin, this.rotorFloor);
    this.rotorPhase += (9 + this.rotorSpeed * 18) * dt; // brisk idle, whirls at full throttle
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.screenFlash = Math.max(0, this.screenFlash - dt * 4);
    for (const gt of this.level.gates) gt.fade += ((gt.open ? 1 : 0) - gt.fade) * (1 - Math.exp(-4 * dt));


    // dive: streaks blasted UP out of the rotor disc so you can see the push-down
    if (this.alive && !h.landed && input.dive > 0) {
      const n = rotorNormal(h.tilt);
      const rate = input.dive * 70;
      const count = Math.floor(rate * dt) + (Math.random() < (rate * dt) % 1 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const p = heliPoint(h, { x: (Math.random() * 2 - 1) * ROTOR_R * 0.9, y: ROTOR_Y - 2 });
        const sp = 170 + Math.random() * 130;
        const life = 0.2 + Math.random() * 0.15;
        this.particles.push({
          pos: p,
          vel: { x: h.vel.x + n.x * sp, y: h.vel.y + n.y * sp },
          life,
          maxLife: life,
          color: '#a8dcff',
          size: 0.8,
          drag: 1,
          grav: 0,
        });
      }
    }

    for (const s of this.shards) {
      s.life -= dt;
      s.vel.y += this.cfg.gravity * 1.2 * dt;
      const prev = { ...s.pos };
      s.pos.x += s.vel.x * dt;
      s.pos.y += s.vel.y * dt;
      s.ang += s.angVel * dt;
      // bounce off terrain
      const near = segmentsNear(this.level, Math.min(prev.x, s.pos.x), Math.min(prev.y, s.pos.y), Math.max(prev.x, s.pos.x), Math.max(prev.y, s.pos.y));
      for (const seg of near) {
        if (segmentIntersectionT(prev, s.pos, seg.a, seg.b) === null) continue;
        const t = sub(seg.b, seg.a);
        const tl = len(t) || 1;
        let n = { x: -t.y / tl, y: t.x / tl };
        if (dot(n, s.vel) > 0) n = { x: -n.x, y: -n.y };
        const vn = dot(s.vel, n);
        s.vel = { x: (s.vel.x - 1.5 * vn * n.x) * 0.7, y: (s.vel.y - 1.5 * vn * n.y) * 0.7 };
        s.pos = prev;
        s.angVel *= 0.6;
        break;
      }
    }
    this.shards = this.shards.filter((s) => s.life > 0);
    if (this.message) {
      this.message.t += dt;
      if (this.message.t > this.message.life) this.message = null;
    }
    if (!input.pickup || !this.alive) this.beam = false;

    // rotor wash kicking up dust
    if (this.alive && h.throttle > 0.3) {
      const n = rotorNormal(h.tilt);
      const from = h.pos;
      const to = { x: h.pos.x - n.x * 230, y: h.pos.y - n.y * 230 };
      let best: { t: number; s: Segment } | null = null;
      const near = segmentsNear(this.level, Math.min(from.x, to.x), Math.min(from.y, to.y), Math.max(from.x, to.x), Math.max(from.y, to.y));
      for (const s of near) {
        const t = segmentIntersectionT(from, to, s.a, s.b);
        if (t !== null && (!best || t < best.t)) best = { t, s };
      }
      if (best) {
        const hit = { x: from.x + (to.x - from.x) * best.t, y: from.y + (to.y - from.y) * best.t };
        const tangent = sub(best.s.b, best.s.a);
        const tl = len(tangent) || 1;
        const strength = h.throttle * (1 - best.t);
        const count = Math.round(strength * 60 * dt * 6);
        for (let i = 0; i < count; i++) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const sp = 80 + Math.random() * 220 * strength;
          const life = 0.3 + Math.random() * 0.5;
          this.particles.push({
            pos: { x: hit.x + (Math.random() - 0.5) * 10, y: hit.y - 2 },
            vel: { x: (tangent.x / tl) * sp * side, y: (tangent.y / tl) * sp * side - Math.random() * 40 },
            life,
            maxLife: life,
            color: COLORS.dust,
            size: 0.8 + Math.random(),
            drag: 3,
            grav: 0,
          });
        }
      }
    }

    // missile exhaust
    for (const p of this.projectiles) {
      if (p.kind !== 'missile') continue;
      const life = 0.15 + Math.random() * 0.2;
      this.particles.push({
        pos: { ...p.pos },
        vel: { x: -p.vel.x * 0.05 + (Math.random() - 0.5) * 30, y: -p.vel.y * 0.05 + (Math.random() - 0.5) * 30 },
        life,
        maxLife: life,
        color: Math.random() < 0.5 ? COLORS.missile : '#ffffff',
        size: 1,
        drag: 4,
        grav: 0,
      });
    }

    const g = this.cfg.gravity;
    const alive: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      const damp = Math.exp(-p.drag * dt);
      p.vel.x *= damp;
      p.vel.y = p.vel.y * damp + g * p.grav * dt;
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      alive.push(p);
    }
    this.particles = alive.length > 4000 ? alive.slice(-4000) : alive;

    for (const r of this.rings) r.t += dt;
    this.rings = this.rings.filter((r) => r.t < r.life);
  }

  // ---------------------------------------------------------------- queries

  /** throttle at which thrust exactly balances weight (with orb if attached). */
  hoverRpm(): number {
    const m = this.cfg.heliMass + (this.orb.attached ? this.cfg.orbMass : 0);
    return (m * this.cfg.gravity) / this.cfg.maxThrust;
  }

  /** Orb speed readout for the HUD when carrying it near the bowl, else null. */
  orbApproach(): { speed: number; safe: boolean } | null {
    if (!this.alive || !(this.orb.attached || this.orb.free)) return null;
    if (dist(this.orb.pos, this.level.bowl.rest) > 320) return null;
    const speed = len(this.orb.vel);
    return { speed, safe: speed <= this.cfg.orbMaxImpact };
  }

  /** y of the first solid surface straight below p (within maxDist), or null. */
  groundBelow(p: Vec, maxDist = 1500): number | null {
    const to = { x: p.x, y: p.y + maxDist };
    let best: number | null = null;
    for (const s of segmentsNear(this.level, p.x - 1, p.y, p.x + 1, to.y)) {
      const t = segmentIntersectionT(p, to, s.a, s.b);
      if (t !== null && (best === null || t < best)) best = t;
    }
    return best === null ? null : p.y + best * maxDist;
  }

  /** y of the first solid surface straight above p (within maxDist), or null. */
  ceilingAbove(p: Vec, maxDist = 1500): number | null {
    const to = { x: p.x, y: p.y - maxDist };
    let best: number | null = null;
    for (const s of segmentsNear(this.level, p.x - 1, to.y, p.x + 1, p.y)) {
      const t = segmentIntersectionT(p, to, s.a, s.b);
      if (t !== null && (best === null || t < best)) best = t;
    }
    return best === null ? null : p.y - best * maxDist;
  }

  /** Signed horizontal distance from the heli to the start pad centre (for the return-to-base hint). */
  padOffset(): number {
    const p = this.level.startPad;
    return p.x + p.w / 2 - this.heli.pos.x;
  }

  /** Is the tether currently reachable (for HUD hints)? */
  orbInReach(): boolean {
    if (!this.alive || this.orb.attached || this.orb.delivered || this.orbLostTimer > 0) return false;
    return dist(heliPoint(this.heli, ANCHOR), this.orb.pos) <= this.cfg.rodLength + 0.5;
  }
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function turretCentre(t: Turret): Vec {
  return { x: t.pos.x + t.normal.x * 11, y: t.pos.y + t.normal.y * 11 };
}

export const TURRET_BARREL = 30;
/** Extra slack for player shots: missiles are dumb-fire, so turrets are generous to hit. */
export const TURRET_HIT_SLACK = 9;
