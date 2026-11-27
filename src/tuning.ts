import GUI from 'lil-gui';
import { DEFAULTS, config, resetConfig, saveConfig } from './config';

type Key = keyof typeof DEFAULTS;
type Spec = [Key, number, number, number, string?];

const FOLDERS: [string, Spec[], boolean][] = [
  [
    'Thrust & gravity',
    [
      ['maxThrust', 50, 1500, 5, 'max thrust'],
      ['maxHorizSpeed', 40, 800, 5, 'max horiz speed'],
      ['diveAccel', 0, 600, 5, 'dive (↓) accel'],
      ['gravity', 20, 600, 5, 'gravity'],
    ],
    true,
  ],
  [
    'Tilt',
    [
      ['maxTiltDeg', 5, 60, 1, 'max tilt °'],
      ['tiltRateDeg', 10, 240, 1, 'tilt rate °/s'],
      ['tiltEase', 1, 30, 0.5, 'tilt ease'],
    ],
    true,
  ],
  [
    'Orb & rod',
    [
      ['orbMass', 0.1, 5, 0.05, 'orb mass'],
      ['rodLength', 40, 250, 1, 'rod length'],
      ['orbRadius', 6, 30, 1, 'orb radius'],
      ['orbDrag', 0, 1, 0.01, 'orb drag'],
      ['orbBounce', 0, 0.95, 0.05, 'orb bounce'],
    ],
    true,
  ],
  [
    'Fuel & shield',
    [
      ['fuelMax', 10, 400, 5, 'fuel tank'],
      ['fuelBurn', 0, 10, 0.1, 'thrust burn /s'],
      ['shieldBurn', 0, 40, 0.5, 'shield burn /s'],
      ['tankRate', 1, 200, 1, 'tank suck rate /s'],
      ['tankAmount', 5, 200, 1, 'fuel per tank'],
      ['tankReach', 40, 400, 5, 'tank reach'],
      ['rescueFuelBoost', 0, 100, 1, 'fuel per survivor'],
      ['fuelRespawnMin', 0, 100, 1, 'respawn fuel minimum'],
    ],
    false,
  ],
  [
    'Body & world',
    [
      ['heliMass', 0.2, 5, 0.05, 'heli mass'],
      ['heliDrag', 0, 2, 0.01, 'heli drag'],
      ['landMaxSpeed', 10, 300, 5, 'safe landing speed'],
      ['landMaxTiltDeg', 1, 30, 1, 'max land tilt °'],
    ],
    false,
  ],
  [
    'Weapons',
    [
      ['missileLaunchSpeed', 0, 600, 5, 'missile launch speed'],
      ['missileAccel', 100, 8000, 50, 'missile accel'],
      ['missileSpeed', 200, 1500, 10, 'missile top speed'],
      ['missileCooldown', 0.05, 1, 0.01, 'missile cooldown'],
      ['missileLife', 0.3, 4, 0.1, 'missile life'],
    ],
    false,
  ],
  [
    'Enemies',
    [
      ['turretRange', 100, 1500, 10, 'turret range'],
      ['turretInterval', 0.3, 8, 0.1, 'turret fire interval'],
      ['turretCharge', 0, 2, 0.05, 'turret charge-up'],
      ['turretShotSpeed', 50, 1000, 10, 'turret shot speed'],
      ['turretLead', 0, 1, 0.05, 'turret aim lead'],
      ['turretArcDeg', 10, 90, 1, 'turret aim arc °'],
      ['enemyHeliSpeed', 50, 500, 5, 'guard heli speed'],
      ['enemyHeliAccel', 50, 800, 10, 'guard heli accel'],
      ['enemyDetect', 100, 2000, 10, 'guard wake range'],
      ['enemyStandoff', 80, 800, 10, 'guard standoff'],
      ['enemyLeash', 200, 3000, 50, 'guard leash'],
      ['enemyChase', 0, 20, 0.5, 'guard chase time'],
      ['enemyBurst', 1, 5, 1, 'guard shots per volley'],
      ['enemyLead', 0, 1, 0.05, 'guard aim lead'],
      ['enemyFireRange', 100, 1200, 10, 'guard fire range'],
      ['enemyFireInterval', 0.5, 8, 0.1, 'guard fire interval'],
      ['enemyCharge', 0, 2, 0.05, 'guard charge-up'],
      ['enemyRespawn', 0.5, 30, 0.5, 'guard relaunch delay'],
      ['enemySpawnClear', 0, 1500, 10, 'guard spawn clearance'],
      ['balloonPatrol', 0, 500, 5, 'balloon drift range'],
      ['balloonFireRange', 100, 1200, 10, 'balloon fire range'],
      ['balloonFireInterval', 0.5, 10, 0.1, 'balloon fire interval'],
      ['balloonCharge', 0, 2, 0.05, 'balloon charge-up'],
    ],
    false,
  ],
  [
    'Camera, look & sound',
    [
      ['viewHeight', 400, 1800, 10, 'view height'],
      ['camLookahead', 0, 1.5, 0.05, 'look-ahead s'],
      ['camFollow', 0.5, 15, 0.1, 'follow speed'],
      ['camGround', 0.55, 0.95, 0.01, 'ground position on screen'],
      ['glow', 0, 2, 0.05, 'glow'],
      ['volume', 0, 1, 0.05, 'volume'],
      ['sfxVolume', 0, 1.5, 0.05, 'effects volume'],
    ],
    false,
  ],
];

export function createTuningPanel(): GUI {
  const gui = new GUI({ title: 'TUNING  [T]' });
  for (const [name, specs, open] of FOLDERS) {
    const f = gui.addFolder(name);
    for (const [key, min, max, step, label] of specs) {
      f.add(config, key, min, max, step).name(label ?? key).onChange(saveConfig);
    }
    if (!open) f.close();
  }
  const actions = {
    copy: () => {
      const json = JSON.stringify(config, null, 2);
      console.log(json);
      void navigator.clipboard?.writeText(json);
    },
    reset: () => {
      resetConfig();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    },
  };
  gui.add(actions, 'copy').name('📋 copy settings JSON');
  gui.add(actions, 'reset').name('↺ reset to defaults');
  return gui;
}
