# THRUSTLIFTER — Design

A tribute to the *feel* of the BBC Micro's Thrust, flown in a helicopter. Fly down,
pick up a heavy orb on a rigid rod, and lug it through increasingly tight terrain
to an orb bowl. The orb swings like a pendulum under the same gravity you fight,
and its momentum pushes and pulls the craft.

**Core principle: flying with the orb is the hardest part of the game. Combat never is,
no matter how hard a level gets.** Every system gets judged against that.

## Decided

| Area | Decision |
|---|---|
| Platform | Browser, TypeScript, Vite. Canvas2D faux-vector glow for now (renderer isolated so a WebGL bloom pass can replace it). |
| Tilt | Limited to **±50°** (started at ±30°, opened up in playtesting). Input moves a *target* angle; actual tilt **eases** toward it. **No auto-level** (precise held angles matter in tight spaces). May revisit after playtesting. |
| Rotor | Thrust along the rotor normal. **Instant**: press = thrust, release = none (spool lag was tried and rejected because it made delicate moves too hard). Gamepad trigger gives analog throttle. Blades still *look* like they spin up. |
| Facing | Separate from tilt; flip at any time. Realistic nose geometry: tilt right + face right = nose down, missile fires slightly down. Flip to face left = nose up, fires up-left. |
| Dive | ↓ / S adds straight-down acceleration (world space, not along the rotor). Deliberately arcade, not realistic. Tunable. Shown by streaks blasting up out of the rotor (the downward version for normal thrust was rejected). |
| Missile (fire) | Fires straight out of the nose. Aim with tilt plus facing. |
| Bombs | **Removed for now** (one fire button is enough; Z fires, X flips). Possible later as upgrades, e.g. triple shot or firing perpendicular. |
| Tether | **Rigid rod** (rope makes it too easy). The rod is a true two-way constraint: the orb drags and shoves the heli. |
| Pickup | Hold tether (Space) within rod length of the orb, then pull away. After a release you must let go of Space before you can tether again. The rod locks at full length (Thrust-style; no "tractor beam" as a separate system). |
| Delivery | A small **orb bowl** (cup radius 28 vs orb radius 16). **Space while carrying releases the orb**, which keeps its momentum, so drops and "layups" work. **The bowl is the only thing the orb can touch safely**: it bounces around in the cup and is delivered once it **comes to rest in the bottom**. Within the bowl it's sturdy, shattering only on a head-on impact above **max impact** (default 240). Lowering it onto the bowl on the rod also works (a gentle touch auto-releases). |
| Orb destruction | The orb **explodes if it touches anything except the bowl** (ground, turrets), carried or dropped, **or if it's shot** (by anything, including your own weapons). **The pilot does not die.** The orb respawns on its pedestal after ~2s. |
| Mission complete | Choplifter-style: after the orb is in the bowl, **fly back and land on your start pad**. A HUD hint points the way home. |
| Collision | Heli touching anything = death (terrain, turrets, a loose orb). The exception is skids landing gently and level on a pad. The rod passes through terrain for now. The rod crossing the rotor = "rotor strike" death. |
| Out of scope | No reactor, no inverse gravity. Probably no tractor beam. |
| Leave room for | Fuel, shields (HUD space is reserved; pads could refuel). |
| Gravity | Gentle, Thrust-like. Playtest-tuned defaults: gravity 230, thrust 645, max horizontal speed 335, dive 170, max tilt 50°. The first defaults (320/850) were far too violent. With the orb, full thrust holds altitude up to ~43° of tilt; past that (up to the 50° max) you sink. |
| Turrets | Big enough to hit with dumb-fire missiles (generous hit area). They track you, **telegraph each shot with a visible charge-up glow**, then fire a slow, dodgeable shot. They need line of sight, range and a firing arc around the way they face, so they can sit on floors, ceilings or walls. A hit kills you or destroys the orb. Range, interval, charge time, shot speed, aim lead and arc are tunable ("Enemies" folder). Combat stays secondary to flying. **Placement rule: only put turrets where the player can dodge and shoot back.** You can't fire upward (missiles stay within ±45° of horizontal), and there are no shields yet, so no turrets above you in vertical shafts or in spots you're forced through. |
| Gates | Energy barriers in level data: `closes: pickup` seals the way in when you grab the orb; `opens: delivery` opens a way out when it's delivered. They reset if you die before delivering. This is how levels force a separate return path. |
| Levels | Played in order (`src/levels/index.ts`). N goes to the next level after completing one; 1-9 jump to any level. Level 1 Proving Ground (surface); Level 2 Deep Caverns: the orb sits right at the bottom of the first shaft, then a long winding carry (passage, drop shaft, lower tunnel, climb, big chamber) to the bowl with **no enemies on the carry**; turrets guard only the way in and the way home (sealing gate on pickup, exit gate up a separate shaft on delivery). **Level-design rule: the orb comes early, and the orb-to-bowl stretch is the main challenge.** Cave levels set `backdropY` so open cave reads dark against solid rock. |
| Sound | Procedural (Web Audio, no samples). Rotor chop tempo follows the rotor: a brisk, soft but clearly audible idle chop (~8/s) building to a harder chop (~15/s) at full throttle, over a steady drone with a light low rumble and faint turbine whine. Treble kept soft (it read as a machine gun when bright). The idle chop must sit in an audible band, not just sub-bass. M mutes; volume in the tuning panel. Event effects are synthesized too, and must have **weight, depth and sustain** (thin, short "bubble-wrap pops" were rejected). They're layered: explosions = crack + darkening fiery body + long brown-noise rumble + sub-bass drop; metal rings for clunks and debris; a rising "sucking" hum (boooeeee...) swoops up while the tether beam pulls, ending in an "...up!" chirp at lock-on (phaser tones were tried and rejected). All effects go through a hall reverb and a compressor and ring out for 1–3.5s. Distant events play quieter. |
| Look | Colourful faux-vector 80s arcade with modern glitz: additive glow lines, bloom, particles, scanlines, vignette. |

## Core loop

Launch from your pad → fight through the level → grab the orb → deliver it to the bowl → make your way back and land on your pad.

Level-design hook: the return trip doesn't have to retrace the outbound route. Levels can force a **separate path from the bowl back to the pad** (one-way drops, gates that open on delivery, a route that only works without the orb's extra length and weight).

## Milestones

- **M0, lug test** (current): one surface level, heli, orb, rod, orb bowl, inert turrets, missiles/bombs, live tuning panel. *Goal: is carrying the orb fun?*
- **M1, combat basics**: turrets that shoot ✅, flying enemies, fuel/shields decision.
- **M2, caverns**: underground levels ✅ (Deep Caverns), level sequencing ✅, gates ✅, a level editor.
- **M3, glitz pass**: WebGL bloom, audio, screen effects, menus.

## Camera

Frames the ground under you (highest of 5 probes across a strip, eased, so gaps and cliff edges don't make it lurch) at "ground position on screen". In enclosed spaces it centres between floor and ceiling. Climbing shifts the view up to show what's above. The heli stays between 22% and 60% from the top, clear of the centre messages. "View height" is zoom.

## Open questions

- Should the rod collide with terrain (Thrust's didn't)?
- Fuel and shields: if added, does the shield block the tether like Thrust's did?
- Lives and scoring model.
- What a "harder level" means beyond tighter terrain: gravity per level, wind, heavier orbs, longer or shorter rods?
