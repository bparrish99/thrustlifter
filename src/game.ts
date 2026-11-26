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
  | { type: 'tallyTime' | 'tallyFuel' | 'tallyDone' | 'gate' | 'board' | 'rescued' | 'tankEmpty' | 'enemyLaunch' | 'balloonPop' | 'extraLife' | 'missile' | 'shieldHit' | 'enemyShot' | 'tether' | 'release' | 'orbLost' | 'delivered' | 'complete' | 'turretDown' | 'heliDown' | 'impact' | 'liftoff' | 'land'; pos?: Vec; value?: number };

export interface Survivor {
  pos: Vec; // feet
  state: 'waiting' | 'running' | 'aboard' | 'rescued' | 'lost';
  dir: number; // facing/run direction for the animation
  t: number; // animation clock offset
}

export interface EnemyHeli {
  pos: Vec;
  vel: Vec;
  tilt: number;
  facing: 1 | -1;
  rotorPhase: number;
  spin: number; // 0..1 visual rotor speed
  state: 'parked' | 'launching' | 'hunting' | 'returning';
  pad: PadData;
  cooldown: number;
  charge: number; // 0..1 telegraph before a shot
  lostSight: number; // seconds without seeing you
  alive: boolean;
}

interface GuardPost {
  pad: PadData;
  remaining: number; // guards not yet launched
  timer: number; // countdown to bring out the next one
}

export interface Balloon {
  home: Vec;
  pos: Vec;
  patrol: number;
  t: number; // drift clock
  aim: number; // gun angle
  cooldown: number;
  charge: number;
  alive: boolean;
}

export interface FuelTank {
  pos: Vec; // base, on the ground
  amount: number;
  max: number;
  alive: boolean;
}

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

export type Phase = 'playing' | 'dead' | 'complete' | 'gameover';
export const START_LIVES = 3;
export const POINTS = { turret: 100, balloon: 200, guard: 300, rescue: 500, perTenthUnderTarget: 10, perFuelTick: 25 };
/** LEDs on the fuel gauge (fuel bonus counts whole lit ticks). */
export const FUEL_TICKS = 24;
/** An extra life every this many points. */
export const EXTRA_LIFE_EVERY = 10000;

export const STEP = 1 / 240;
export const SHIELD_RADIUS = 56;
export const BALLOON_R = 28; // envelope radius (it's a bit taller than wide)
export const BALLOON_GUN_DROP = 52; // basket/gun hangs this far below the envelope centre
export const TANK_W = 48; // big on purpose: easy to hit by accident with dumb-fire missiles
export const TANK_H = 34;
export const SURVIVOR_CALL_RANGE = 280; // land within this distance and they come running
export const SURVIVOR_SPEED = 70;
export const TURRET_RADIUS = 22; // dome size; also the collision size
const RESPAWN_DELAY = 2.2;
const CEILING = -1500;

export const COLORS = {
  heli: '#ffd23f',
  orb: '#ff3df2',
  missile: '#7dffb0',
  target: '#ff4a4a',
  enemyShot: '#ff6a3d',
  survivor: '#9dff9d',
  fuel: '#ffe14d',
  balloon: '#ff3d6e',
  spark: ['#ffffff', '#ffd23f', '#ff8a3d', '#ff3df2'],
  dust: '#7fd6ff',
};

export class Game {
  readonly cfg = config;
  level: Level;
  heli!: HeliState;
  orb!: Orb;
  turrets: Turret[] = [];
  survivors: Survivor[] = [];
  fuelTanks: FuelTank[] = [];
  enemies: EnemyHeli[] = [];
  balloons: Balloon[] = [];
  private posts: GuardPost[] = [];
  /** Tank being sucked from this frame (for the beam visual), or null. */
  fueling: FuelTank | null = null;
  /** Little figures running off the pad after being dropped home (visual only). */
  disembarking: { pos: Vec; t: number }[] = [];
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
  timeBonus = 0;
  /** End-of-level bonus tally in progress (null until the level is complete). */
  tally: { stage: 'intro' | 'time' | 'pause' | 'fuel' | 'done'; t: number; tenths: number; tenthsTotal: number; ticks: number; ticksTotal: number; acc: number; sound: number } | null = null;
  /** Bonus time remaining (seconds). Starts at the level's target time, counts down from first lift-off, stops at zero. */
  bonusTime = 0;
  launched = false;
  /** Visual pulse on the lives display after earning one. */
  lifeFlash = 0;
  fuelBonus = 0;
  /** Respawned at a checkpoint and waiting for the first input (no gravity, turrets hold fire). */
  held = false;
  /** On the launch pad since (re)spawning and not yet lifted off: enemies hold fire and can't hurt you. */
  onLaunchPad = true;
  /** Enemies may target you: not sitting on the launch pad before take-off, not held at a checkpoint. */
  get exposed(): boolean {
    return !this.onLaunchPad && !this.held && this.phase === 'playing';
  }
  fuel = 0;
  /** Shield up this frame (hold Space while not carrying the orb, with fuel). */
  shield = false;
  shieldFlash = 0; // visual pulse when the shield absorbs a hit
  /** What the current Space press is doing. Decided when Space goes down, kept until it's released. */
  spaceMode: 'tether' | 'fuel' | 'shield' | 'release' | null = null;
  refueling = false;
  private orbLostTimer = 0;
  private strandedTime = 0;
  private settleTime = 0;

  private acc = 0;
  private missileCd = 0;

  readonly levelNumber: number;
  readonly hasNextLevel: boolean;
  /** Lives remaining (including the current one). Carried from level to level. */
  lives = START_LIVES;
  /** Score (rules to be decided; carried from level to level). */
  score = 0;
  private readonly startLives: number;
  private readonly startScore: number;

  constructor(data: LevelData, opts: { levelNumber?: number; hasNextLevel?: boolean; lives?: number; score?: number } = {}) {
    this.levelNumber = opts.levelNumber ?? 1;
    this.hasNextLevel = opts.hasNextLevel ?? false;
    this.startLives = opts.lives ?? START_LIVES;
    this.startScore = opts.score ?? 0;
    this.level = buildLevel(data);
    this.restart();
  }

  get alive(): boolean {
    return this.phase !== 'dead' && this.phase !== 'gameover';
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
    this.survivors = (d.survivors ?? []).map((s, i) => ({ pos: { x: s.x, y: s.y }, state: 'waiting' as const, dir: -1, t: i * 0.37 }));
    this.disembarking = [];
    this.fuelTanks = (d.fuelTanks ?? []).map((t) => {
      const amount = t.amount ?? this.cfg.tankAmount;
      return { pos: { x: t.x, y: t.y }, amount, max: amount, alive: true };
    });
    this.fuel = this.cfg.fuelMax;
    this.enemies = [];
    this.balloons = (d.balloons ?? []).map((b, i) => ({
      home: { x: b.x, y: b.y },
      pos: { x: b.x, y: b.y },
      patrol: b.patrol ?? this.cfg.balloonPatrol,
      t: i * 2.1,
      aim: Math.PI / 2,
      cooldown: 1 + Math.random() * this.cfg.balloonFireInterval,
      charge: 0,
      alive: true,
    }));
    this.posts = d.pads.filter((p) => (p.guards ?? 0) > 0).map((pad) => ({ pad, remaining: pad.guards!, timer: 0 }));
    this.projectiles = [];
    this.particles = [];
    this.rings = [];
    this.shards = [];
    this.events = [];
    this.deaths = 0;
    // after a game over, R starts this level over with a full set of lives
    this.lives = this.phase === 'gameover' ? START_LIVES : this.startLives;
    this.score = this.startScore;
    this.time = 0;
    this.orbLostTimer = 0;
    this.settleTime = 0;
    this.spaceMode = null;
    this.completedAt = null;
    this.timeBonus = 0;
    this.tally = null;
    this.bonusTime = this.level.data.targetTime ?? 0;
    this.launched = false;
    this.fuelBonus = 0;
    resetGates(this.level);
    this.phase = 'playing';
    this.phaseTime = 0;
    this.spawnHeli();
    this.flash(this.level.data.name, undefined, COLORS.orb, 3);
  }

  /** Start on the launch pad, or (with `at`) hovering at a checkpoint, held until you touch the controls. */
  private spawnHeli(at?: Vec): void {
    const pad = this.level.startPad;
    if (at) {
      this.heli = createHeli(at, this.cfg);
      this.held = true;
    } else {
      this.heli = createHeli({ x: pad.x + pad.w / 2, y: pad.y - SKID_Y - 0.05 }, this.cfg);
      this.heli.landed = true;
      this.held = false;
    }
    this.onLaunchPad = !at;
    this.facingVis = 1;
    this.acc = 0;
  }

  /** Where to respawn given progress so far (null = launch pad). Internal only: no "checkpoint" UI. */
  private checkpoint(): Vec | null {
    if (!this.orb.delivered) return null;
    const cp = this.level.data.checkpoints?.find((c) => c.after === 'delivery');
    if (cp) return { x: cp.x, y: cp.y };
    const b = this.level.bowl;
    return { x: b.cx, y: b.rimY - 220 };
  }

  /** Minimum fuel guaranteed at the current respawn point (so you can't be soft-locked). */
  private checkpointFuel(): number {
    const d = this.level.data;
    const min = this.orb.delivered
      ? (d.checkpoints?.find((c) => c.after === 'delivery')?.fuel ?? this.cfg.fuelRespawnMin)
      : (d.startFuelMin ?? this.cfg.fuelRespawnMin);
    return Math.min(min, this.cfg.fuelMax);
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
    if (input.pickupPressed && this.alive && this.orb.attached) {
      this.release();
      this.spaceMode = 'release'; // this press is spent on the release; no re-grab, no shield
    }

    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP && n < 40) {
      this.substep(input, STEP);
      this.acc -= STEP;
      n++;
    }
    if (n >= 40) this.acc = 0;

    this.stepTally(dt);
    this.frameEffects(input, dt);
  }

  private substep(input: FrameInput, dt: number): void {
    const cfg = this.cfg;
    const h = this.heli;
    const orb = this.orb;
    this.time += dt;
    this.phaseTime += dt;
    if (this.launched && this.phase !== 'complete' && this.phase !== 'gameover') this.bonusTime = Math.max(0, this.bonusTime - dt);
    h.mass = cfg.heliMass;
    orb.mass = cfg.orbMass;

    if (this.phase === 'gameover') {
      // waiting for R
    } else if (this.phase === 'dead') {
      if (this.phaseTime >= RESPAWN_DELAY) {
        if (this.lives <= 0) {
          this.phase = 'gameover';
          this.flash('GAME OVER', 'press R to try again', '#ff4a4a', 1e9);
        } else {
          this.respawn();
        }
      }
    } else {
      // respawned at a checkpoint: hang in place until the player touches anything
      if (this.held && (input.tiltAxis !== 0 || input.rotor > 0 || input.dive > 0 || input.fire || input.flip || input.pickup)) this.held = false;
      // out of fuel: no thrust, no dive, no shield
      const ctl = this.fuel > 0 ? input : { ...input, rotor: 0, dive: 0 };
      updateControls(h, ctl, cfg, dt);
      // hover over a fuel tank holding Space (not while carrying) to suck it up
      this.fueling = null;
      this.refueling = false;
      // Space does ONE thing per press, decided when it goes down: tether (orb in reach) beats
      // fuel (tank in reach) beats shield. It never switches until Space is released.
      if (!input.pickup) this.spaceMode = null;
      else if (this.spaceMode === null) this.spaceMode = orb.attached ? 'release' : this.orbInReach() ? 'tether' : this.tankInReach() ? 'fuel' : 'shield';
      const tank = this.spaceMode === 'fuel' && !orb.attached ? this.tankInReach() : null;
      this.shield = this.spaceMode === 'shield' && this.fuel > 0 && !orb.attached;
      // landed with an empty tank and nothing to suck from: stranded after a moment
      this.strandedTime = this.phase === 'playing' && h.landed && this.fuel <= 0.01 && !this.fueling ? this.strandedTime + dt : 0;
      if (!this.held && this.phase === 'playing') {
        this.fuel -= (h.throttle + ctl.dive) * cfg.fuelBurn * dt + (this.shield ? cfg.shieldBurn * dt : 0);
        this.fuel = Math.max(0, this.fuel);
      }
      {
        if (tank && this.fuel < cfg.fuelMax) {
          const take = Math.min(cfg.tankRate * dt, tank.amount, cfg.fuelMax - this.fuel);
          tank.amount -= take;
          this.fuel += take;
          this.fueling = tank;
          this.refueling = true;
          if (tank.amount <= 0.01) {
            tank.alive = false;
            this.explode(tankCentre(tank), 12, 120, COLORS.fuel);
            this.events.push({ type: 'tankEmpty', pos: tankCentre(tank) });
          }
        }
      }

      if (h.landed && h.throttle * cfg.maxThrust > h.mass * cfg.gravity) {
        h.landed = false;
        this.launched = true;
        this.onLaunchPad = false;
        this.events.push({ type: 'liftoff', pos: h.pos });
      }

      if (!h.landed && !this.held) {
        const f = thrustForce(h, cfg);
        f.y += Math.max(0, Math.min(1, ctl.dive)) * cfg.diveAccel * h.mass; // straight down, world space
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
      if (this.phase === 'playing' && this.strandedTime > 2.5) this.strand();
      if (this.alive) this.pickupAndDeliver(input);
      if (this.alive) this.weapons(input, dt);
    }

    if (orb.free) this.stepFreeOrb(dt);
    if (this.orbLostTimer > 0) {
      this.orbLostTimer -= dt;
      if (this.orbLostTimer <= 0) this.resetOrb();
    }
    this.stepTurrets(dt);
    this.stepEnemies(dt);
    this.stepBalloons(dt);
    this.stepSurvivors(dt);
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
    this.spawnHeli(this.checkpoint() ?? undefined);
    // no refuel on death: keep what you had, with a small safety net so you're never stranded
    this.fuel = Math.max(this.fuel, this.checkpointFuel());
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
      for (const t of this.fuelTanks) {
        if (!t.alive || dist(t.pos, h.pos) > HULL_RADIUS + TANK_W) continue;
        const c = tankCentre(t);
        if (hull.some((hs) => distPointSegment(c, hs.a, hs.b) < TANK_W / 2)) return this.crash('HIT A FUEL TANK');
      }
      for (const b of this.balloons) {
        if (!b.alive || dist(b.pos, h.pos) > HULL_RADIUS + BALLOON_R * 1.6) continue;
        const g = balloonGun(b);
        if (hull.some((hs) => distPointSegment(b.pos, hs.a, hs.b) < BALLOON_R || distPointSegment(g, hs.a, hs.b) < 9)) {
          this.popBalloon(b);
          return this.crash('HIT A BALLOON');
        }
      }
      for (const e of this.enemies) {
        if (e.alive && dist(e.pos, h.pos) < 50) {
          this.destroyEnemy(e);
          return this.crash('MID-AIR COLLISION');
        }
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
      for (const t of this.fuelTanks) if (t.alive && dist(p, tankCentre(t)) < r + TANK_W / 2) return this.loseOrb('it hit a fuel tank');
      for (const b of this.balloons) {
        if (b.alive && (dist(p, b.pos) < r + BALLOON_R || dist(p, balloonGun(b)) < r + 9)) {
          this.popBalloon(b);
          this.award(POINTS.balloon, b.pos);
          return this.loseOrb('it hit a balloon');
        }
      }
      for (const e of this.enemies) {
        if (e.alive && dist(p, e.pos) < r + 24) {
          this.destroyEnemy(e);
          this.award(POINTS.guard, e.pos); // the orb is a wrecking ball, too
          return this.loseOrb('it hit a helicopter');
        }
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
    for (const t of this.fuelTanks) if (t.alive && dist(orb.pos, tankCentre(t)) < r + TANK_W / 2) return this.loseOrb('it hit a fuel tank');
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
    // no text: the bowl flare, the chime and the lit ORB lamp say it
    this.events.push({ type: 'delivered', pos: at });
  }

  /** Landed back on the start pad with the orb in the bowl: mission complete. */
  private complete(): void {
    this.phase = 'complete';
    this.completedAt = this.time;
    const h = this.heli;
    // bonuses are paid out by the end-of-level tally (time first, then fuel), see stepTally()
    const tenthsUnder = Math.floor(this.bonusTime * 10 + 1e-6);
    this.timeBonus = tenthsUnder * POINTS.perTenthUnderTarget;
    const ticks = Math.floor((Math.max(0, this.fuel) / this.cfg.fuelMax) * FUEL_TICKS + 1e-6);
    this.fuelBonus = ticks * POINTS.perFuelTick;
    this.tally = { stage: 'intro', t: 0, tenths: tenthsUnder, tenthsTotal: tenthsUnder, ticks, ticksTotal: ticks, acc: 0, sound: 0 };
    this.bonusTime = tenthsUnder / 10;
    this.fuel = (ticks / FUEL_TICKS) * this.cfg.fuelMax;
    this.ring(h.pos, 160, '#3dff8a', 1.2);
    this.ring(h.pos, 100, '#ffb020', 0.9);
    this.explode({ x: h.pos.x, y: h.pos.y - 30 }, 70, 260, '#3dff8a');
    this.events.push({ type: 'complete', pos: h.pos });
    this.flash('MISSION COMPLETE', undefined, '#3dff8a', 1e9);
  }

  /** End-of-level tally: drain the time bonus, then the fuel gauge tick by tick, into the score. */
  private stepTally(dt: number): void {
    const t = this.tally;
    if (!t || t.stage === 'done') return;
    t.t += dt;
    if (t.stage === 'intro') {
      if (t.t > 1.2) Object.assign(t, { stage: t.tenths > 0 ? 'time' : 'fuel', t: 0 });
      return;
    }
    if (t.stage === 'time') {
      // drain the whole time bonus in at most ~2.5s
      const rate = Math.max(t.tenthsTotal / 2.5, 40);
      t.acc += rate * dt;
      const n = Math.min(t.tenths, Math.floor(t.acc));
      if (n > 0) {
        t.acc -= n;
        t.tenths -= n;
        this.bonusTime = t.tenths / 10;
        this.award(n * POINTS.perTenthUnderTarget, this.heli.pos);
      }
      t.sound -= dt;
      if (t.sound <= 0 && n > 0) {
        this.events.push({ type: 'tallyTime', value: 1 - t.tenths / Math.max(1, t.tenthsTotal) });
        t.sound = 0.05;
      }
      if (t.tenths <= 0) Object.assign(t, { stage: 'pause', t: 0 });
      return;
    }
    if (t.stage === 'pause') {
      if (t.t > 0.6) {
        if (t.ticks > 0) Object.assign(t, { stage: 'fuel', t: 0 });
        else {
          t.stage = 'done';
          this.finishTally();
        }
      }
      return;
    }
    if (t.stage === 'fuel') {
      if (t.ticks > 0 && t.t >= 0.13) {
        t.t = 0;
        t.ticks--;
        this.fuel = (t.ticks / FUEL_TICKS) * this.cfg.fuelMax;
        this.award(POINTS.perFuelTick, this.heli.pos);
        this.events.push({ type: 'tallyFuel', value: t.ticksTotal - t.ticks });
      }
      if (t.ticks <= 0 && t.t > 0.5) {
        t.stage = 'done';
        this.finishTally();
      }
    }
  }

  private finishTally(): void {
    const d = this.deaths === 1 ? '1 death' : `${this.deaths} deaths`;
    const next = this.hasNextLevel ? 'N next level  ·  R retry' : 'all levels done  ·  R retry';
    const n = this.survivors.length;
    const saved = this.survivors.filter((s) => s.state === 'rescued').length;
    const rescue = n ? `  ·  rescued ${saved}/${n}` : '';
    this.events.push({ type: 'tallyDone' });
    this.flash('MISSION COMPLETE', `score ${this.score}  ·  ${d}${rescue}  ·  ${next}`, '#3dff8a', 1e9);
  }

  private land(pad: PadData): void {
    const h = this.heli;
    h.landed = true;
    h.vel = { x: 0, y: 0 };
    h.tilt = 0;
    h.tiltTarget = 0;
    h.pos.y = pad.y - SKID_Y - 0.05;
    this.events.push({ type: 'land', pos: h.pos });
    if (pad.kind === 'start') {
      const aboard = this.survivors.filter((s) => s.state === 'aboard');
      aboard.forEach((s, i) => {
        s.state = 'rescued';
        this.award(POINTS.rescue, { x: h.pos.x - 30 + i * 30, y: h.pos.y - 20 * i });
        this.disembarking.push({ pos: { x: h.pos.x - 10 + i * 6, y: pad.y }, t: -i * 0.25 });
      });
      if (aboard.length) {
        this.events.push({ type: 'rescued', pos: h.pos });
      }
    }
    if (pad.kind === 'start' && this.orb.delivered && this.phase === 'playing') this.complete();
  }

  /** Landed with an empty tank: you can't take off and won't die, so end the attempt (no explosion). */
  private strand(): void {
    this.phase = 'dead';
    this.phaseTime = 0;
    this.deaths++;
    this.lives--;
    this.lastCrash = 'STRANDED';
    this.strandedTime = 0;
    // anyone aboard climbs back out and waits where you landed
    for (const s of this.survivors) if (s.state === 'aboard' || s.state === 'running') s.state = 'waiting';
    this.events.push({ type: 'land', pos: this.heli.pos });
  }

  private crash(reason: string): void {
    if (this.phase !== 'playing') return; // the mission's over: nothing can hurt you now
    const h = this.heli;
    this.phase = 'dead';
    this.phaseTime = 0;
    this.deaths++;
    this.lives--;
    this.shake = 1;
    this.lastCrash = reason;
    this.explode(h.pos, 90, 420);
    this.screenFlash = 1;
    for (const s of hullWorld(h)) this.shatter(s.a, s.b, h.vel, COLORS.heli);
    this.events.push({ type: 'heliDown', pos: h.pos });
    for (const s of this.survivors) if (s.state === 'aboard' || s.state === 'running') s.state = s.state === 'aboard' ? 'lost' : 'waiting';
    if (this.orb.attached) {
      this.explode(this.orb.pos, 50, 300, COLORS.orb);
      this.orb.attached = false;
      this.orb.pos = { x: -99999, y: -99999 }; // hidden until respawn
    }
  }

  // ------------------------------------------------------ pickup / deliver

  private pickupAndDeliver(input: FrameInput): void {
    const h = this.heli;
    const orb = this.orb;
    const L = this.cfg.rodLength;
    this.beam = false;
    if (orb.delivered) return;

    if (!orb.attached) {
      if (!input.pickup || this.spaceMode !== 'tether' || this.orbLostTimer > 0) return;
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
        if (sealing.length) this.events.push({ type: 'gate' });
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
      const canFire = t.tracking && this.exposed && Math.abs(wrapAngle(want - t.aim)) < 0.12;
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

  /** Survivors run to the heli when it's landed nearby, and climb aboard. */
  private stepSurvivors(dt: number): void {
    const h = this.heli;
    const landed = this.alive && h.landed;
    for (const s of this.survivors) {
      s.t += dt;
      if (s.state !== 'waiting' && s.state !== 'running') continue;
      const dx = h.pos.x - s.pos.x;
      const sameLevel = Math.abs(h.pos.y + SKID_Y - s.pos.y) < 40;
      if (landed && sameLevel && Math.abs(dx) < SURVIVOR_CALL_RANGE) {
        s.state = 'running';
        s.dir = Math.sign(dx) || 1;
        s.pos.x += s.dir * Math.min(Math.abs(dx), SURVIVOR_SPEED * dt);
        const gy = this.groundBelow({ x: s.pos.x, y: s.pos.y - 30 }, 80);
        if (gy !== null) s.pos.y = gy;
        if (Math.abs(h.pos.x - s.pos.x) < 8) {
          s.state = 'aboard';
          this.events.push({ type: 'board', pos: s.pos });
          // each survivor you pick up brings a little fuel with them
          this.fuel = Math.min(this.cfg.fuelMax, this.fuel + this.cfg.rescueFuelBoost);
        }
      } else {
        s.state = 'waiting';
        s.dir = Math.sign(dx) || s.dir;
      }
    }
    for (const d of this.disembarking) {
      d.t += dt;
      if (d.t > 0) d.pos.x -= SURVIVOR_SPEED * dt;
    }
    this.disembarking = this.disembarking.filter((d) => d.t < 2.5);
  }

  // ------------------------------------------------------------- enemy helis

  /** Guard helicopters: parked on their rescue pad until you come near, then they hunt you. */
  private stepEnemies(dt: number): void {
    const cfg = this.cfg;
    const h = this.heli;
    // bring out the next guard on each post once the previous one is gone
    for (const post of this.posts) {
      if (post.remaining <= 0 || this.enemies.some((e) => e.alive && e.pad === post.pad)) continue;
      // nothing left to guard: once this pad's survivors have been picked up, no more guards come
      if (this.hostagesGone(post.pad)) {
        post.remaining = 0;
        continue;
      }
      post.timer -= dt;
      if (post.timer > 0) continue;
      // never pop a new guard onto the pad right next to you: wait until you've moved off
      const pc = { x: post.pad.x + post.pad.w / 2, y: post.pad.y };
      if (this.alive && dist(h.pos, pc) < cfg.enemySpawnClear) continue;
      post.remaining--;
      post.timer = cfg.enemyRespawn;
      const p = post.pad;
      this.enemies.push({
        pos: { x: p.x + p.w / 2, y: p.y - SKID_Y - 0.05 },
        vel: { x: 0, y: 0 },
        tilt: 0,
        facing: -1,
        rotorPhase: Math.random() * 6,
        spin: 0,
        state: 'parked',
        pad: p,
        cooldown: cfg.enemyFireInterval,
        charge: 0,
        lostSight: 0,
        alive: true,
      });
    }

    for (const e of this.enemies) {
      if (!e.alive) continue;
      const awake = !e.pad.guardsAfter || this.orb.delivered;
      const home = { x: e.pad.x + e.pad.w / 2, y: e.pad.y - 160 };
      const d = dist(e.pos, h.pos);
      const sees = this.alive && this.exposed && d < cfg.enemyDetect && this.lineOfSight(e.pos, h.pos);
      e.lostSight = sees ? 0 : e.lostSight + dt;
      let target: Vec | null = null;

      if (e.state === 'parked') {
        e.spin = Math.max(0, e.spin - dt);
        if (awake && sees) {
          e.state = 'launching';
          this.events.push({ type: 'enemyLaunch', pos: e.pos });
        }
      } else if (e.state === 'launching') {
        target = home;
        if (e.pos.y <= home.y + 20) e.state = 'hunting';
      } else if (e.state === 'hunting') {
        if (!this.alive || e.lostSight > 2 || dist(e.pos, home) > cfg.enemyLeash) {
          e.state = 'returning';
        } else {
          const side = Math.sign(e.pos.x - h.pos.x) || 1;
          target = { x: h.pos.x + side * cfg.enemyStandoff, y: h.pos.y - 60 };
          // stay on the leash
          const off = sub(target, home);
          const ol = len(off);
          if (ol > cfg.enemyLeash * 0.9) target = add(home, scale(off, (cfg.enemyLeash * 0.9) / ol));
        }
      } else if (e.state === 'returning') {
        target = home;
        if (sees && dist(e.pos, home) < cfg.enemyLeash * 0.8) e.state = 'hunting';
      }

      if (target) {
        e.spin = Math.min(1, e.spin + dt * 1.5);
        // steer: accelerate toward a desired velocity aimed at the target
        const to = sub(target, e.pos);
        const tl = len(to);
        const want = tl > 1 ? scale(to, Math.min(cfg.enemyHeliSpeed, tl * 1.5) / tl) : { x: 0, y: 0 };
        // terrain avoidance: look ahead, and keep clear of floors and ceilings
        const ahead = add(e.pos, scale(e.vel, 0.7));
        if (!this.lineOfSight(e.pos, ahead)) {
          want.x = -e.vel.x * 0.5;
          want.y = -cfg.enemyHeliSpeed * 0.6;
        }
        const floor = this.groundBelow(e.pos, 120);
        if (floor !== null && floor - e.pos.y < 80 && e.state !== 'launching') want.y = Math.min(want.y, -cfg.enemyHeliSpeed * 0.5);
        const ceil = this.ceilingAbove(e.pos, 90);
        if (ceil !== null && e.pos.y - ceil < 70) want.y = Math.max(want.y, cfg.enemyHeliSpeed * 0.4);
        const dv = sub(want, e.vel);
        const dl = len(dv);
        const maxDv = cfg.enemyHeliAccel * dt;
        e.vel = dl > maxDv ? add(e.vel, scale(dv, maxDv / dl)) : want;
        e.pos = add(e.pos, scale(e.vel, dt));
      }
      e.rotorPhase += (9 + e.spin * 18) * dt;
      e.tilt += (Math.max(-0.5, Math.min(0.5, (e.vel.x / cfg.enemyHeliSpeed) * 0.45)) - e.tilt) * (1 - Math.exp(-5 * dt));
      if (e.state !== 'parked' && this.alive) e.facing = h.pos.x >= e.pos.x ? 1 : -1;

      // shooting: telegraph with a charge glow, then fire at you (partial lead)
      if (e.state === 'hunting' && sees && d < cfg.enemyFireRange) {
        e.cooldown -= dt;
        e.charge = e.cooldown < cfg.enemyCharge ? 1 - Math.max(0, e.cooldown) / Math.max(cfg.enemyCharge, 0.01) : 0;
        if (e.cooldown <= 0) {
          const muzzle = toWorldPoint(e, NOSE);
          const tFly = d / cfg.turretShotSpeed;
          const aim = { x: h.pos.x + h.vel.x * tFly * 0.4, y: h.pos.y + h.vel.y * tFly * 0.4 };
          const dir = sub(aim, muzzle);
          const dl2 = len(dir) || 1;
          this.projectiles.push({ kind: 'enemy', pos: muzzle, vel: scale(dir, cfg.turretShotSpeed / dl2), life: cfg.enemyFireRange / cfg.turretShotSpeed + 0.8 });
          this.events.push({ type: 'enemyShot', pos: muzzle });
          e.cooldown = cfg.enemyFireInterval * (0.8 + Math.random() * 0.4);
          e.charge = 0;
        }
      } else {
        e.charge = Math.max(0, e.charge - dt * 3);
        e.cooldown = Math.max(e.cooldown, cfg.enemyCharge + 0.3);
      }

      // flying guards die if they hit terrain (not their own pad while taking off)
      if (e.state === 'hunting' || e.state === 'returning') {
        const r = 24;
        for (const s of segmentsNear(this.level, e.pos.x - r, e.pos.y - r, e.pos.x + r, e.pos.y + r)) {
          if (s.pad === e.pad) continue;
          if (distPointSegment(e.pos, s.a, s.b) < r) {
            this.destroyEnemy(e);
            break;
          }
        }
      }
    }
    this.enemies = this.enemies.filter((e) => e.alive);
  }

  /** Balloons drift in a slow looping pattern around their spot and take pot-shots at you. */
  private stepBalloons(dt: number): void {
    const cfg = this.cfg;
    const h = this.heli;
    for (const b of this.balloons) {
      if (!b.alive) continue;
      b.t += dt;
      b.pos = {
        x: b.home.x + Math.cos(b.t * 0.23) * b.patrol,
        y: b.home.y + Math.sin(b.t * 0.37) * b.patrol * 0.45 + Math.sin(b.t * 1.3) * 6,
      };
      const gun = balloonGun(b);
      const d = dist(gun, h.pos);
      const sees = this.alive && this.exposed && d < cfg.balloonFireRange && this.lineOfSight(gun, h.pos);
      const tFly = d / cfg.turretShotSpeed;
      const aimAt = { x: h.pos.x + h.vel.x * tFly * 0.3, y: h.pos.y + h.vel.y * tFly * 0.3 };
      const want = sees ? Math.atan2(aimAt.y - gun.y, aimAt.x - gun.x) : Math.PI / 2;
      b.aim += wrapAngle(want - b.aim) * (1 - Math.exp(-4 * dt));
      if (sees) {
        b.cooldown -= dt;
        b.charge = b.cooldown < cfg.balloonCharge ? 1 - Math.max(0, b.cooldown) / Math.max(cfg.balloonCharge, 0.01) : 0;
        if (b.cooldown <= 0) {
          const dir = { x: Math.cos(b.aim), y: Math.sin(b.aim) };
          const muzzle = add(gun, scale(dir, 14));
          this.projectiles.push({ kind: 'enemy', pos: muzzle, vel: scale(dir, cfg.turretShotSpeed), life: cfg.balloonFireRange / cfg.turretShotSpeed + 0.8 });
          this.events.push({ type: 'enemyShot', pos: muzzle });
          b.cooldown = cfg.balloonFireInterval * (0.8 + Math.random() * 0.4);
          b.charge = 0;
        }
      } else {
        b.charge = Math.max(0, b.charge - dt * 3);
        b.cooldown = Math.max(b.cooldown, cfg.balloonCharge + 0.4);
      }
    }
    this.balloons = this.balloons.filter((b) => b.alive);
  }

  popBalloon(b: Balloon): void {
    if (!b.alive) return;
    b.alive = false;
    this.explode(b.pos, 50, 300, COLORS.balloon);
    for (let k = 0; k < 8; k++) {
      const a0 = (k * Math.PI) / 4;
      const a1 = a0 + Math.PI / 4;
      this.shatter(
        { x: b.pos.x + Math.cos(a0) * BALLOON_R, y: b.pos.y + Math.sin(a0) * BALLOON_R * 1.15 },
        { x: b.pos.x + Math.cos(a1) * BALLOON_R, y: b.pos.y + Math.sin(a1) * BALLOON_R * 1.15 },
        { x: 0, y: -60 },
        COLORS.balloon,
      );
    }
    const g = balloonGun(b);
    this.shatter({ x: g.x - 8, y: g.y }, { x: g.x + 8, y: g.y }, { x: 0, y: 0 }, COLORS.balloon);
    this.events.push({ type: 'balloonPop', pos: b.pos });
  }

  /** Add points (and any extra lives they earn). */
  award(points: number, at: Vec): void {
    const before = Math.floor(this.score / EXTRA_LIFE_EVERY);
    this.score += points;
    const gained = Math.floor(this.score / EXTRA_LIFE_EVERY) - before;
    if (gained > 0) {
      this.lives += gained;
      this.events.push({ type: 'extraLife', pos: at });
      this.lifeFlash = 1;
    }
  }

  /** True if this pad had survivors near it and none are still waiting there. */
  private hostagesGone(pad: PadData): boolean {
    const c = pad.x + pad.w / 2;
    const near = this.survivors.filter((s) => Math.abs(s.pos.x - c) < SURVIVOR_CALL_RANGE + pad.w && Math.abs(s.pos.y - pad.y) < 80);
    return near.length > 0 && near.every((s) => s.state !== 'waiting' && s.state !== 'running');
  }

  destroyEnemy(e: EnemyHeli): void {
    if (!e.alive) return;
    e.alive = false;
    this.explode(e.pos, 80, 380, '#ff3d6e');
    for (const s of hullWorld({ pos: e.pos, tilt: e.tilt, facing: e.facing } as HeliState)) this.shatter(s.a, s.b, e.vel, '#ff3d6e');
    this.ring(e.pos, 80, '#ff3d6e', 0.6);
    this.shake = Math.max(this.shake, 0.4);
    this.events.push({ type: 'turretDown', pos: e.pos });
  }

  /** A live tank roughly below the heli, within reach and in sight. */
  private tankInReach(): FuelTank | null {
    const h = this.heli;
    let best: FuelTank | null = null;
    for (const t of this.fuelTanks) {
      if (!t.alive) continue;
      const top = { x: t.pos.x, y: t.pos.y - TANK_H };
      const dy = top.y - h.pos.y;
      if (Math.abs(t.pos.x - h.pos.x) > 45 || dy < 0 || dy > this.cfg.tankReach) continue;
      if (!this.lineOfSight({ x: h.pos.x, y: h.pos.y + SKID_Y + 2 }, { x: top.x, y: top.y - 1 })) continue;
      if (!best || dy < best.pos.y - TANK_H - h.pos.y) best = t;
    }
    return best;
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
      if (p.kind === 'enemy' && this.alive && !this.exposed && dist(p.pos, this.heli.pos) < HULL_RADIUS + 10) {
        hit = p.pos; // a shot already in flight fizzles harmlessly against a heli that hasn't launched yet
        this.explode(p.pos, 8, 120, COLORS.enemyShot);
      } else if (p.kind === 'enemy' && this.alive && this.shield && dist(p.pos, this.heli.pos) < SHIELD_RADIUS) {
        hit = p.pos;
        this.shieldFlash = 1;
        this.explode(p.pos, 14, 160, '#7ffcff');
        this.events.push({ type: 'shieldHit', pos: p.pos });
      } else if (p.kind === 'enemy' && this.alive && dist(p.pos, this.heli.pos) < HULL_RADIUS + 10) {
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
      for (const b of hit || p.kind === 'enemy' ? [] : this.balloons) {
        if (b.alive && (distPointSegment(b.pos, prev, p.pos) < BALLOON_R + 6 || distPointSegment(balloonGun(b), prev, p.pos) < 12)) {
          hit = p.pos;
          this.popBalloon(b);
          this.award(POINTS.balloon, b.pos);
          break;
        }
      }
      for (const e of hit || p.kind === 'enemy' ? [] : this.enemies) {
        if (e.alive && distPointSegment(e.pos, prev, p.pos) < 30) {
          hit = p.pos;
          this.destroyEnemy(e);
          this.award(POINTS.guard, e.pos);
          break;
        }
      }
      for (const t of hit || p.kind === 'enemy' ? [] : this.fuelTanks) {
        if (t.alive && distPointSegment(tankCentre(t), prev, p.pos) < TANK_W / 2 + 6) {
          t.alive = false;
          hit = p.pos;
          const c = tankCentre(t);
          this.explode(c, 60, 320, COLORS.fuel);
          this.ring(c, 60, COLORS.fuel, 0.5);
          this.shatter({ x: c.x - TANK_W / 2, y: c.y }, { x: c.x + TANK_W / 2, y: c.y }, { x: 0, y: -150 }, COLORS.fuel);
          this.shatter({ x: c.x, y: c.y - TANK_H / 2 }, { x: c.x, y: c.y + TANK_H / 2 }, { x: 0, y: -150 }, COLORS.fuel);
          this.events.push({ type: 'turretDown', pos: c });
          break;
        }
      }
      for (const t of hit || p.kind === 'enemy' ? [] : this.turrets) {
        if (t.alive && distPointSegment(turretCentre(t), prev, p.pos) < TURRET_RADIUS + TURRET_HIT_SLACK) {
          t.alive = false;
          hit = p.pos;
          this.award(POINTS.turret, turretCentre(t));
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
    this.lifeFlash = Math.max(0, this.lifeFlash - dt * 0.6);
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 3);
    if (!this.alive) this.shield = false;
    for (const gt of this.level.gates) gt.fade += ((gt.open ? 1 : 0) - gt.fade) * (1 - Math.exp(-4 * dt));


    // out of fuel on the ground: the engine coughs grey smoke (shows you're stranded)
    if (this.alive && this.strandedTime > 0 && Math.random() < dt * 9) {
      const p = heliPoint(h, { x: -12, y: -11 });
      const life = 0.9 + Math.random() * 0.6;
      this.particles.push({ pos: p, vel: { x: (Math.random() - 0.5) * 20, y: -30 - Math.random() * 30 }, life, maxLife: life, color: '#8a8f9c', size: 2.5, drag: 1.5, grav: -0.05 });
    }

    // fuel flowing up the beam from the tank
    if (this.fueling && this.alive) {
      const top = { x: this.fueling.pos.x, y: this.fueling.pos.y - TANK_H };
      const to = heliPoint(h, { x: 0, y: SKID_Y });
      for (let i = 0; i < 2; i++) {
        const k = Math.random();
        const life = 0.3;
        this.particles.push({
          pos: { x: top.x + (to.x - top.x) * k * 0.3 + (Math.random() - 0.5) * 8, y: top.y + (to.y - top.y) * k * 0.3 },
          vel: { x: (to.x - top.x) / life, y: (to.y - top.y) / life },
          life,
          maxLife: life,
          color: COLORS.fuel,
          size: 1.2,
          drag: 0,
          grav: 0,
        });
      }
    }

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

export function balloonGun(b: Balloon): Vec {
  return { x: b.pos.x, y: b.pos.y + BALLOON_GUN_DROP };
}

/** Local heli point to world for any heli-like thing. */
export function toWorldPoint(e: { pos: Vec; tilt: number; facing: number }, p: Vec): Vec {
  const x = p.x * e.facing;
  const c = Math.cos(e.tilt);
  const s = Math.sin(e.tilt);
  return { x: e.pos.x + x * c - p.y * s, y: e.pos.y + x * s + p.y * c };
}

export function tankCentre(t: FuelTank): Vec {
  return { x: t.pos.x, y: t.pos.y - TANK_H / 2 };
}

export function turretCentre(t: Turret): Vec {
  return { x: t.pos.x + t.normal.x * 11, y: t.pos.y + t.normal.y * 11 };
}

export const TURRET_BARREL = 30;
/** Extra slack for player shots: missiles are dumb-fire, so turrets are generous to hit. */
export const TURRET_HIT_SLACK = 9;
