import { Tutorial } from './tutorial';
import { config } from './config';
import { buildLevel, resetGates, segmentsNear, type Gate, type Level, type LevelData, type PadData, type Segment } from './level';
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
  | { type: 'tallyRescue' | 'tallyTime' | 'tallyFuel' | 'tallyDone' | 'gate' | 'board' | 'rescued' | 'tankEmpty' | 'enemyLaunch' | 'balloonPop' | 'extraLife' | 'missile' | 'shieldHit' | 'enemyShot' | 'tether' | 'release' | 'orbLost' | 'delivered' | 'complete' | 'turretDown' | 'heliDown' | 'impact' | 'liftoff' | 'land'; pos?: Vec; value?: number };

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
  lastSeen: Vec | null; // where you were last seen (chased when out of sight)
  path: Vec[]; // nav-grid route to the current goal
  pathT: number; // seconds until the route is recomputed
  orbit: number; // angle of its attack position around you
  orbitDir: 1 | -1;
  orbitT: number; // seconds until it may switch orbit direction
  burst: number; // shots left in the current burst
  burstT: number;
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
/** Seconds to linger on the mission-complete results before the next level starts. */
export const ADVANCE_DELAY = 3;
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
/** How far sideways of a tank's centre you can be and still refuel from it. */
export const TANK_REACH_X = 45;
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
  /** Set when the results have been shown long enough; main.ts then loads the next level. */
  readyForNext = false;
  /** End-of-level bonus tally in progress (null until the level is complete). */
  tally: {
    stage: 'intro' | 'rescue' | 'time' | 'pause' | 'fuel' | 'done';
    t: number;
    /** Rescued hostages still to pay out, and how many there were. */
    rescues: number;
    rescuesTotal: number;
    tenths: number;
    tenthsTotal: number;
    ticks: number;
    ticksTotal: number;
    acc: number;
    sound: number;
  } | null = null;
  /** Bonus time remaining (seconds). Starts at the level's target time, counts down from first lift-off, stops at zero. */
  bonusTime = 0;
  launched = false;
  /** Visual pulse on the lives display after earning one. */
  lifeFlash = 0;
  fuelBonus = 0;
  /** Where you last died (picks the nearest respawn point). */
  deathPos: Vec | null = null;
  /** You died carrying the orb: you respawn holding it. */
  private carryingAtDeath = false;
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

  /** First-level hints (null on other levels). Survives deaths and restarts, so each hint shows once per visit. */
  readonly tutorial: Tutorial | null;

  constructor(data: LevelData, opts: { levelNumber?: number; hasNextLevel?: boolean; lives?: number; score?: number; tutorial?: boolean } = {}) {
    this.levelNumber = opts.levelNumber ?? 1;
    this.tutorial = opts.tutorial ? new Tutorial() : null;
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
      // sit flush on the surface it was placed on, whatever its angle (floor, slope, wall, ceiling, pad)
      const a0 = deg(t.dir ?? -90);
      const mount = this.surfaceAt({ x: t.x, y: t.y }, { x: Math.cos(a0), y: Math.sin(a0) });
      const pos = mount?.pos ?? { x: t.x, y: t.y };
      const normal = mount?.normal ?? { x: Math.cos(a0), y: Math.sin(a0) };
      const a = Math.atan2(normal.y, normal.x);
      return { pos, normal, alive: true, aim: a, cooldown: 1 + Math.random() * this.cfg.turretInterval, charge: 0, tracking: false };
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
    // each rescue pad has a set number of guards (0 = unguarded); they also stop once its hostages are picked up
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

  /** The level's checkpoints (or, if it has none, one above the bowl). Internal only: no checkpoint UI. */
  checkpoints(): { x: number; y: number; fuel: number }[] {
    const cps = this.level.data.checkpoints ?? [];
    if (cps.length) return cps.map((c) => ({ x: c.x, y: c.y, fuel: c.fuel ?? this.cfg.fuelRespawnMin }));
    const b = this.level.bowl;
    return [{ x: b.cx, y: b.rimY - 220, fuel: this.cfg.fuelRespawnMin }];
  }

  /**
   * Where to come back after dying: whichever respawn point (the launch pad or a checkpoint) is
   * closest to where you died, by flying distance through open air (so one just the other side of a
   * rock wall doesn't count as close). `at` null = on the launch pad.
   */
  respawnPoint(carryingOrb = false): { at: Vec | null; fuel: number } {
    const pad = this.level.startPad;
    const cands: { at: Vec | null; pos: Vec; fuel: number }[] = [
      ...(carryingOrb ? [] : [{ at: null, pos: { x: pad.x + pad.w / 2, y: pad.y - 40 }, fuel: this.level.data.startFuelMin ?? this.cfg.fuelRespawnMin }]),
      ...this.checkpoints()
        // carrying: only checkpoints with room for the orb to hang below (if none have room, any will do)
        .filter((c, _, all) => !carryingOrb || !all.some((o) => this.orbHangRoom(o)) || this.orbHangRoom(c))
        .map((c) => ({ at: { x: c.x, y: c.y }, pos: { x: c.x, y: c.y }, fuel: c.fuel })),
    ];
    const from = this.deathPos ?? this.heli.pos;
    const flying = this.flyingDistances(from, cands.map((c) => c.pos));
    const reachable = flying.some((d) => Number.isFinite(d));
    let best = 0;
    let bestD = Infinity;
    cands.forEach((c, i) => {
      const d = reachable ? flying[i] : dist(from, c.pos);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return { at: cands[best].at, fuel: cands[best].fuel };
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
    this.tutorial?.update(this, dt);
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
      if (orb.attached && !this.held) {
        // (held at a checkpoint: the orb hangs frozen under you too, until you touch a control)
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
    const carrying = this.carryingAtDeath && !this.orb.delivered;
    this.carryingAtDeath = false;
    if (!this.orb.delivered && !carrying) {
      this.resetOrb();
      resetGates(this.level);
    }
    // died carrying the orb: gates stay as they were (sealed behind you), and you come back at the
    // nearest checkpoint (never the pad: the orb can't hang under a landed heli) still holding it
    const rp = this.respawnPoint(carrying);
    this.spawnHeli(rp.at ?? undefined);
    if (carrying) {
      const orb = this.orb;
      const hook = heliPoint(this.heli, ANCHOR);
      orb.pos = { x: hook.x, y: hook.y + this.cfg.rodLength };
      orb.vel = { x: 0, y: 0 };
      orb.attached = true;
      orb.free = false;
      this.orbLostTimer = 0;
      this.settleTime = 0;
    }
    // no refuel on death: keep what you had, with a small safety net so you're never stranded
    this.fuel = Math.max(this.fuel, Math.min(rp.fuel, this.cfg.fuelMax));
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
    this.sealGates('delivery');
    // no text: the bowl flare, the chime and the lit ORB lamp say it
    this.events.push({ type: 'delivered', pos: at });
  }

  /** Landed back on the start pad with the orb in the bowl: mission complete. */
  private complete(): void {
    this.phase = 'complete';
    this.completedAt = this.time;
    const h = this.heli;
    // bonuses are paid out by the end-of-level tally (rescues, then time, then fuel), see stepTally()
    // hostages ride with you until now: they unload one by one in the tally (see stepTally)
    const rescues = this.survivors.filter((s) => s.state === 'aboard').length;
    const tenthsUnder = Math.floor(this.bonusTime * 10 + 1e-6);
    this.timeBonus = tenthsUnder * POINTS.perTenthUnderTarget;
    const ticks = Math.floor((Math.max(0, this.fuel) / this.cfg.fuelMax) * FUEL_TICKS + 1e-6);
    this.fuelBonus = ticks * POINTS.perFuelTick;
    this.tally = { stage: 'intro', t: 0, rescues, rescuesTotal: rescues, tenths: tenthsUnder, tenthsTotal: tenthsUnder, ticks, ticksTotal: ticks, acc: 0, sound: 0 };
    this.bonusTime = tenthsUnder / 10;
    this.fuel = (ticks / FUEL_TICKS) * this.cfg.fuelMax;
    this.ring(h.pos, 160, '#3dff8a', 1.2);
    this.ring(h.pos, 100, '#ffb020', 0.9);
    this.explode({ x: h.pos.x, y: h.pos.y - 30 }, 70, 260, '#3dff8a');
    this.events.push({ type: 'complete', pos: h.pos });
    this.flash('MISSION COMPLETE', undefined, '#3dff8a', 1e9);
  }

  /** End-of-level tally: pay out each rescued hostage (slowly, one by one), then drain the time bonus, then the fuel gauge tick by tick, into the score. */
  private stepTally(dt: number): void {
    const t = this.tally;
    if (!t) return;
    if (t.stage === 'done') {
      // after a pause on the results, move on to the next level automatically
      t.t += dt;
      if (t.t > ADVANCE_DELAY && this.hasNextLevel) this.readyForNext = true;
      return;
    }
    t.t += dt;
    if (t.stage === 'intro') {
      if (t.t > 1.2) Object.assign(t, { stage: t.rescues > 0 ? 'rescue' : t.tenths > 0 ? 'time' : 'fuel', t: 0 });
      return;
    }
    if (t.stage === 'rescue') {
      // few of these, so each one gets its own beat
      if (t.rescues > 0 && t.t >= 0.7) {
        t.t = 0;
        t.rescues--;
        // the next hostage climbs out and scurries off the pad
        const s = this.survivors.find((v) => v.state === 'aboard');
        if (s) s.state = 'rescued';
        const pad = this.level.startPad;
        const k = t.rescuesTotal - t.rescues - 1;
        this.disembarking.push({ pos: { x: this.heli.pos.x - 10 + k * 6, y: pad.y }, t: 0 });
        this.award(POINTS.rescue, this.heli.pos);
        this.events.push({ type: 'tallyRescue', value: t.rescuesTotal - t.rescues });
      }
      if (t.rescues <= 0 && t.t > 0.8) Object.assign(t, { stage: t.tenths > 0 ? 'time' : 'fuel', t: 0 });
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
          t.t = 0;
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
        t.t = 0;
        this.finishTally();
      }
    }
  }

  private finishTally(): void {
    const d = this.deaths === 1 ? '1 death' : `${this.deaths} deaths`;
    const next = this.hasNextLevel ? 'next level coming up' : 'all levels done  ·  R to play again';
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
    // hostages stay aboard when you land on your pad: they only unload (and score) in the
    // end-of-level tally, after mission complete
    if (pad.kind === 'start' && this.orb.delivered && this.phase === 'playing') this.complete();
  }

  /** Landed with an empty tank: you can't take off and won't die, so end the attempt (no explosion). */
  private strand(): void {
    this.deathPos = { ...this.heli.pos };
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
    this.deathPos = { ...h.pos };
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
    this.carryingAtDeath = this.orb.attached;
    if (this.orb.attached) {
      this.explode(this.orb.pos, 50, 300, COLORS.orb);
      this.orb.attached = false;
      this.orb.pos = { x: -99999, y: -99999 }; // hidden until respawn (back on its pedestal, or with you if you were carrying it)
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
        this.sealGates('pickup');
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
        lastSeen: null,
        path: [],
        pathT: 0,
        orbit: -Math.PI / 2,
        orbitDir: Math.random() < 0.5 ? 1 : -1,
        orbitT: 2,
        burst: 0,
        burstT: 0,
      });
    }

    for (const e of this.enemies) {
      if (!e.alive) continue;
      const awake = !e.pad.guardsAfter || this.orb.delivered;
      const home = { x: e.pad.x + e.pad.w / 2, y: e.pad.y - 160 };
      const d = dist(e.pos, h.pos);
      const sees = this.alive && this.exposed && d < cfg.enemyDetect && this.lineOfSight(e.pos, h.pos);
      e.lostSight = sees ? 0 : e.lostSight + dt;
      if (sees) e.lastSeen = { ...h.pos };
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
        if (!this.alive || !this.exposed || dist(e.pos, home) > cfg.enemyLeash || (!sees && e.lostSight > cfg.enemyChase)) {
          e.state = 'returning';
          e.path = [];
        } else if (sees) {
          target = this.attackPoint(e, home);
        } else {
          // chase: it follows the sound of your rotor, routing through the caves to wherever you are
          target = h.pos;
        }
      } else if (e.state === 'returning') {
        target = home;
        if (sees && this.exposed && dist(e.pos, home) < cfg.enemyLeash * 0.8) e.state = 'hunting';
      }

      if (target) {
        e.spin = Math.min(1, e.spin + dt * 2);
        this.steerGuard(e, target, dt);
      }
      e.rotorPhase += (9 + e.spin * 18) * dt;
      e.tilt += (Math.max(-0.6, Math.min(0.6, (e.vel.x / cfg.enemyHeliSpeed) * 0.55)) - e.tilt) * (1 - Math.exp(-6 * dt));
      if (e.state !== 'parked' && this.alive) e.facing = h.pos.x >= e.pos.x ? 1 : -1;

      // shooting: telegraph with a charge glow, then a quick burst, leading your movement
      const fire = () => {
        const muzzle = toWorldPoint(e, NOSE);
        const tFly = dist(muzzle, h.pos) / cfg.turretShotSpeed;
        const aim = { x: h.pos.x + h.vel.x * tFly * cfg.enemyLead, y: h.pos.y + h.vel.y * tFly * cfg.enemyLead };
        const dir = sub(aim, muzzle);
        const dl2 = len(dir) || 1;
        this.projectiles.push({ kind: 'enemy', pos: muzzle, vel: scale(dir, cfg.turretShotSpeed / dl2), life: cfg.enemyFireRange / cfg.turretShotSpeed + 0.8 });
        this.events.push({ type: 'enemyShot', pos: muzzle });
      };
      if (e.burst > 0) {
        e.burstT -= dt;
        if (e.burstT <= 0 && sees) {
          fire();
          e.burst--;
          e.burstT = 0.15;
        }
      }
      if (e.state === 'hunting' && sees && d < cfg.enemyFireRange) {
        e.cooldown -= dt;
        e.charge = e.cooldown < cfg.enemyCharge ? 1 - Math.max(0, e.cooldown) / Math.max(cfg.enemyCharge, 0.01) : 0;
        if (e.cooldown <= 0) {
          fire();
          e.burst = Math.max(0, Math.round(cfg.enemyBurst) - 1);
          e.burstT = 0.15;
          e.cooldown = cfg.enemyFireInterval * (0.8 + Math.random() * 0.4);
          e.charge = 0;
        }
      } else {
        e.charge = Math.max(0, e.charge - dt * 3);
        e.cooldown = Math.max(e.cooldown, cfg.enemyCharge + 0.2);
      }

      // flying guards die if they hit terrain (not their own pad while taking off)
      if (e.state === 'hunting' || e.state === 'returning') {
        const r = 24;
        for (const sg of segmentsNear(this.level, e.pos.x - r, e.pos.y - r, e.pos.x + r, e.pos.y + r)) {
          if (sg.pad === e.pad) continue;
          if (distPointSegment(e.pos, sg.a, sg.b) < r) {
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

  /**
   * Where a hunting guard wants to be: circling you at standoff range, preferring spots above you,
   * that are in open air with a clear shot. Tries a few angles if the preferred one is blocked.
   */
  private attackPoint(e: EnemyHeli, home: Vec): Vec {
    const cfg = this.cfg;
    const h = this.heli;
    e.orbitT -= 1 / 60;
    if (e.orbitT <= 0) {
      if (Math.random() < 0.35) e.orbitDir = e.orbitDir === 1 ? -1 : 1;
      e.orbitT = 1.5 + Math.random() * 2;
    }
    e.orbit += e.orbitDir * 0.9 * (1 / 60);
    // first choice: circling above and to the side of you. In low caves where that's blocked,
    // fall back to level with you, then below.
    for (const lift of [0.7, 0.25, -0.35]) {
      for (let k = 0; k < 8; k++) {
        const a = e.orbit + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.6;
        const up = lift >= 0 ? Math.abs(Math.sin(a)) * cfg.enemyStandoff * lift + 40 * lift : lift * cfg.enemyStandoff;
        const p = { x: h.pos.x + Math.cos(a) * cfg.enemyStandoff, y: h.pos.y - up };
        if (dist(p, home) > cfg.enemyLeash * 0.95) continue;
        if (this.clearance(p) < 75) continue;
        if (!this.lineOfSight(p, h.pos)) continue;
        if (k) e.orbit = a;
        return p;
      }
    }
    return { ...e.pos }; // nowhere better: hold position
  }

  /** Fly a guard toward `target`: route around rock via the nav grid, keep off the walls, brake before hitting things. */
  private steerGuard(e: EnemyHeli, target: Vec, dt: number): void {
    const cfg = this.cfg;
    const V = cfg.enemyHeliSpeed;
    let goal = target;
    const direct = e.state === 'launching' || this.clearPath(e.pos, target, 30);
    if (!direct) {
      e.pathT -= dt;
      if (e.pathT <= 0 || e.path.length === 0) {
        e.path = this.navPath(e.pos, target);
        e.pathT = 0.4;
      }
      while (e.path.length > 1 && dist(e.pos, e.path[0]) < 36) e.path.shift();
      // head for the farthest waypoint we can reach in a straight line
      for (let i = Math.min(e.path.length - 1, 12); i >= 0; i--) {
        if (this.clearPath(e.pos, e.path[i], 26)) {
          goal = e.path[i];
          break;
        }
      }
    } else {
      e.path = [];
    }
    const to = sub(goal, e.pos);
    const tl = len(to);
    const speed = goal === target ? Math.min(V, tl * 2.5) : V;
    let want = tl > 1 ? scale(to, speed / tl) : { x: 0, y: 0 };
    // push away from nearby walls (stronger the closer they are)
    const R = 85;
    for (const sg of segmentsNear(this.level, e.pos.x - R, e.pos.y - R, e.pos.x + R, e.pos.y + R)) {
      if (e.state === 'launching' && sg.pad === e.pad) continue;
      const c = closestPointSegment(e.pos, sg.a, sg.b);
      const dd = dist(e.pos, c);
      if (dd < R && dd > 0.01) {
        const k = (R - dd) / R;
        want = add(want, scale(sub(e.pos, c), (k * k * V * 1.8) / dd));
      }
    }
    // don't ram the player (a collision kills you both): keep a little personal space
    const toMe = sub(e.pos, this.heli.pos);
    const md = len(toMe);
    if (this.alive && md > 0.01) {
      const space = 210;
      if (md < space) want = add(want, scale(toMe, (((space - md) / space) * V * 3) / md));
      // closing fast? brake early enough to stop before contact
      const closing = -dot(sub(e.vel, this.heli.vel), toMe) / md;
      const stopDist = (closing * closing) / (2 * cfg.enemyHeliAccel) + 90;
      if (closing > 0 && md < stopDist) want = add(want, scale(toMe, (closing * 2) / md));
    }
    // brake if the way ahead is blocked within stopping distance
    const sp = len(e.vel);
    if (sp > 20) {
      const stop = (sp * sp) / (2 * cfg.enemyHeliAccel) + 30;
      const ahead = add(e.pos, scale(e.vel, stop / sp));
      if (!this.clearPath(e.pos, ahead, 22)) want = add(scale(want, 0.5), scale(e.vel, -0.8));
    }
    const wl = len(want);
    if (wl > V * 1.25) want = scale(want, (V * 1.25) / wl);
    const dv = sub(want, e.vel);
    const dl = len(dv);
    const maxDv = cfg.enemyHeliAccel * dt;
    e.vel = dl > maxDv ? add(e.vel, scale(dv, maxDv / dl)) : want;
    e.pos = add(e.pos, scale(e.vel, dt));
    // hard safety: never let the hull touch rock. Slide along it instead (kill the inward velocity).
    const keep = 36;
    for (const sg of segmentsNear(this.level, e.pos.x - keep, e.pos.y - keep, e.pos.x + keep, e.pos.y + keep)) {
      if (e.state === 'launching' && sg.pad === e.pad) continue;
      const c = closestPointSegment(e.pos, sg.a, sg.b);
      const dd = dist(e.pos, c);
      if (dd >= keep || dd < 0.01) continue;
      const n = scale(sub(e.pos, c), 1 / dd);
      e.pos = add(c, scale(n, keep));
      const vn = dot(e.vel, n);
      if (vn < 0) e.vel = sub(e.vel, scale(n, vn));
    }
  }

  /**
   * The solid surface nearest p (within 40): the closest point on it, and its normal pointing out
   * into open air. `hint` breaks ties for thin features where both sides are open.
   */
  private surfaceAt(p: Vec, hint: Vec): { pos: Vec; normal: Vec } | null {
    let best: { pos: Vec; normal: Vec; d: number } | null = null;
    for (const sg of segmentsNear(this.level, p.x - 40, p.y - 40, p.x + 40, p.y + 40)) {
      if (sg.gate !== undefined) continue;
      const c = closestPointSegment(p, sg.a, sg.b);
      const dd = dist(p, c);
      if (best && dd >= best.d) continue;
      const t = sub(sg.b, sg.a);
      const tl = len(t);
      if (tl < 1) continue;
      let n = { x: -t.y / tl, y: t.x / tl };
      const outA = !this.solidAt(add(c, scale(n, 5)));
      const outB = !this.solidAt(add(c, scale(n, -5)));
      if (outA === outB ? dot(n, hint) < 0 : !outA) n = { x: -n.x, y: -n.y };
      best = { pos: c, normal: n, d: dd };
    }
    return best && best.d <= 40 ? { pos: best.pos, normal: best.normal } : null;
  }

  /** Inside rock, or inside a pad. */
  private solidAt(p: Vec): boolean {
    if (this.insideRock(p)) return true;
    return this.level.data.pads.some((pd) => p.x >= pd.x && p.x <= pd.x + pd.w && p.y >= pd.y && p.y <= pd.y + 20);
  }

  /** Distance from p to the nearest solid edge (capped). */
  clearance(p: Vec, cap = 200): number {
    if (this.insideRock(p)) return 0;
    let best = cap;
    for (const sg of segmentsNear(this.level, p.x - cap, p.y - cap, p.x + cap, p.y + cap)) best = Math.min(best, distPointSegment(p, sg.a, sg.b));
    return best;
  }

  /** Seal the gates set to close on this event (now, or as soon as you're clear of them). */
  private sealGates(when: 'pickup' | 'delivery'): void {
    let sealed = false;
    for (const gt of this.level.gates) {
      if (gt.closes !== when || !gt.open) continue;
      if (this.inGate(gt)) gt.sealPending = true;
      else {
        gt.open = false;
        sealed = true;
      }
    }
    if (sealed) this.events.push({ type: 'gate' });
  }

  /** Is the heli, or the orb (on its rod or loose), in or touching this gate? */
  private inGate(gt: Gate): boolean {
    const touching = (p: Vec, r: number) => {
      let inside = false;
      for (let i = 0, j = gt.pts.length - 1; i < gt.pts.length; j = i++) {
        const a = gt.pts[i];
        const b = gt.pts[j];
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
        if (distPointSegment(p, a, b) < r) return true;
      }
      return inside;
    };
    if (this.alive && touching(this.heli.pos, HULL_RADIUS + 4)) return true;
    const orb = this.orb;
    return (orb.attached || orb.free) && touching(orb.pos, this.cfg.orbRadius + 4);
  }

  private insideRock(p: Vec): boolean {
    for (const pts of this.level.polygons) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i];
        const b = pts[j];
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  /** True if a body of radius r can travel straight from a to b without touching anything solid. */
  clearPath(a: Vec, b: Vec, r: number): boolean {
    for (const sg of segmentsNear(this.level, Math.min(a.x, b.x) - r, Math.min(a.y, b.y) - r, Math.max(a.x, b.x) + r, Math.max(a.y, b.y) + r)) {
      if (segmentsIntersect(a, b, sg.a, sg.b)) return false;
      if (distPointSegment(sg.a, a, b) < r || distPointSegment(sg.b, a, b) < r || distPointSegment(a, sg.a, sg.b) < r || distPointSegment(b, sg.a, sg.b) < r) return false;
    }
    return true;
  }

  // nav grid: open-air cells with room for a guard; built once per level
  private nav: { cell: number; x0: number; y0: number; cols: number; rows: number; free: Uint8Array } | null = null;

  private buildNav(): void {
    const cell = 40;
    const x0 = 0;
    // cover the whole playable height (some levels reach up to their top border)
    const d = this.level.data;
    const highest = Math.min(...d.pads.map((p) => p.y), d.orb.y, d.bowl.y, ...(d.checkpoints ?? []).map((c) => c.y), ...(d.balloons ?? []).map((b) => b.y));
    const y0 = Math.min(-600, Math.floor((highest - 400) / cell) * cell);
    const maxY = Math.max(...this.level.polygons.flat().map((p) => p.y));
    const cols = Math.ceil(this.level.data.width / cell);
    const rows = Math.ceil((maxY - y0) / cell);
    const free = new Uint8Array(cols * rows);
    // the grid ignores gates (built as if all open); closed ones are blocked per search (navFree)
    const gatesWere = this.level.gates.map((g) => g.open);
    for (const g of this.level.gates) g.open = true;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const p = { x: x0 + (c + 0.5) * cell, y: y0 + (r + 0.5) * cell };
        free[r * cols + c] = this.clearance(p, 60) >= 38 ? 1 : 0;
      }
    }
    for (let i = 0; i < gatesWere.length; i++) this.level.gates[i].open = gatesWere[i];
    this.nav = { cell, x0, y0, cols, rows, free };
  }

  private navGateKey = '';
  private navGateFree: Uint8Array | null = null;

  /** Open nav cells right now: the grid, minus cells too close to a gate that's currently closed. */
  private navFree(): Uint8Array {
    const n = this.nav!;
    const key = this.level.gates.map((g) => (g.open ? 1 : 0)).join('');
    if (this.navGateFree && key === this.navGateKey) return this.navGateFree;
    const free = n.free.slice();
    for (const sg of this.level.segments) {
      if (sg.gate === undefined || this.level.gates[sg.gate].open) continue;
      const c0 = Math.max(0, Math.floor((sg.minX - 40 - n.x0) / n.cell));
      const c1 = Math.min(n.cols - 1, Math.floor((sg.maxX + 40 - n.x0) / n.cell));
      const r0 = Math.max(0, Math.floor((sg.minY - 40 - n.y0) / n.cell));
      const r1 = Math.min(n.rows - 1, Math.floor((sg.maxY + 40 - n.y0) / n.cell));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const p = { x: n.x0 + (c + 0.5) * n.cell, y: n.y0 + (r + 0.5) * n.cell };
          if (distPointSegment(p, sg.a, sg.b) < 38) free[r * n.cols + c] = 0;
        }
      }
    }
    this.navGateKey = key;
    this.navGateFree = free;
    return free;
  }

  /** Is there room for the orb to hang on its rod straight below a heli hovering at p? */
  private orbHangRoom(p: Vec): boolean {
    const hook = { x: p.x + ANCHOR.x, y: p.y + ANCHOR.y };
    return this.clearPath(hook, { x: hook.x, y: hook.y + this.cfg.rodLength }, this.cfg.orbRadius + 4);
  }

  /** Flying distance from `from` to each target over the nav grid (Infinity where there's no way through). */
  flyingDistances(from: Vec, targets: Vec[]): number[] {
    if (!this.nav) this.buildNav();
    const n = this.nav!;
    const free = this.navFree();
    const start = this.navNearestFree(from);
    if (start < 0) return targets.map(() => Infinity);
    const steps = new Float64Array(n.cols * n.rows).fill(Infinity);
    steps[start] = 0;
    // Dijkstra over the grid (diagonal steps cost √2), with a small binary heap
    const heap: [number, number][] = [[0, start]];
    const push = (d: number, i: number) => {
      heap.push([d, i]);
      for (let k = heap.length - 1; k > 0; ) {
        const p = (k - 1) >> 1;
        if (heap[p][0] <= heap[k][0]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        k = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let k = 0; ; ) {
          const l = 2 * k + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const [d, i] = pop();
      if (d > steps[i]) continue;
      const c = i % n.cols;
      const r = Math.floor(i / n.cols);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= n.cols || rr >= n.rows) continue;
        const j = rr * n.cols + cc;
        if (!free[j]) continue;
        if (dc && dr && (!free[r * n.cols + cc] || !free[rr * n.cols + c])) continue; // no corner cutting
        const nd = d + (dc && dr ? Math.SQRT2 : 1);
        if (nd < steps[j]) {
          steps[j] = nd;
          push(nd, j);
        }
      }
    }
    return targets.map((t) => {
      const g = this.navNearestFree(t);
      return g < 0 ? Infinity : steps[g] * n.cell;
    });
  }

  /** The open nav cell nearest a point (small spiral search), or -1. */
  private navNearestFree(p: Vec): number {
    const n = this.nav!;
    const free = this.navFree();
    const c0 = Math.max(0, Math.min(n.cols - 1, Math.floor((p.x - n.x0) / n.cell)));
    const r0 = Math.max(0, Math.min(n.rows - 1, Math.floor((p.y - n.y0) / n.cell)));
    if (free[r0 * n.cols + c0]) return r0 * n.cols + c0;
    for (let rad = 1; rad < 6; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          const c = c0 + dc;
          const r = r0 + dr;
          if (c < 0 || r < 0 || c >= n.cols || r >= n.rows) continue;
          if (free[r * n.cols + c]) return r * n.cols + c;
        }
      }
    }
    return -1;
  }

  /** Breadth-first route over the nav grid from `from` to (the open cell nearest) `to`. */
  navPath(from: Vec, to: Vec): Vec[] {
    if (!this.nav) this.buildNav();
    const n = this.nav!;
    const free = this.navFree();
    const idx = (p: Vec) => {
      const c = Math.max(0, Math.min(n.cols - 1, Math.floor((p.x - n.x0) / n.cell)));
      const r = Math.max(0, Math.min(n.rows - 1, Math.floor((p.y - n.y0) / n.cell)));
      return r * n.cols + c;
    };
    const centre = (i: number) => ({ x: n.x0 + ((i % n.cols) + 0.5) * n.cell, y: n.y0 + (Math.floor(i / n.cols) + 0.5) * n.cell });
    // nearest open cell to a point (small spiral search)
    const nearestFree = (p: Vec) => {
      const i0 = idx(p);
      if (free[i0]) return i0;
      const c0 = i0 % n.cols;
      const r0 = Math.floor(i0 / n.cols);
      for (let rad = 1; rad < 6; rad++) {
        for (let dr = -rad; dr <= rad; dr++) {
          for (let dc = -rad; dc <= rad; dc++) {
            const c = c0 + dc;
            const r = r0 + dr;
            if (c < 0 || r < 0 || c >= n.cols || r >= n.rows) continue;
            if (free[r * n.cols + c]) return r * n.cols + c;
          }
        }
      }
      return -1;
    };
    const start = nearestFree(from);
    const goal = nearestFree(to);
    if (start < 0 || goal < 0) return [];
    const prev = new Int32Array(n.cols * n.rows).fill(-1);
    prev[start] = start;
    const queue = [start];
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      if (i === goal) break;
      const c = i % n.cols;
      const r = Math.floor(i / n.cols);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= n.cols || rr >= n.rows) continue;
        const j = rr * n.cols + cc;
        if (!free[j] || prev[j] >= 0) continue;
        if (dc && dr && (!free[r * n.cols + cc] || !free[rr * n.cols + c])) continue; // no corner cutting
        prev[j] = i;
        queue.push(j);
      }
    }
    if (prev[goal] < 0) return [];
    const out: Vec[] = [];
    for (let i = goal; i !== start; i = prev[i]) out.push(centre(i));
    out.reverse();
    if (out.length) out[out.length - 1] = to;
    return out;
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
  tankInReach(): FuelTank | null {
    const h = this.heli;
    let best: FuelTank | null = null;
    for (const t of this.fuelTanks) {
      if (!t.alive) continue;
      const top = { x: t.pos.x, y: t.pos.y - TANK_H };
      const dy = top.y - h.pos.y;
      if (Math.abs(t.pos.x - h.pos.x) > TANK_REACH_X || dy < 0 || dy > this.cfg.tankReach) continue;
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
    // a gate due to seal waits until you (and the orb) are clear of it, so it can't crush you
    let sealed = false;
    for (const gt of this.level.gates) {
      if (gt.sealPending && gt.open && !this.inGate(gt)) {
        gt.open = false;
        gt.sealPending = false;
        sealed = true;
      }
    }
    if (sealed) this.events.push({ type: 'gate' });
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
