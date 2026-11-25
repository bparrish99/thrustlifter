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
| Tilt | Limited to **±45°** (started at ±30°, opened up in playtesting). Input moves a *target* angle; actual tilt **eases** toward it. **No auto-level** (precise held angles matter in tight spaces). May revisit after playtesting. |
| Rotor | Thrust along the rotor normal. **Instant**: press = thrust, release = none (spool lag was tried and rejected because it made delicate moves too hard). Gamepad trigger gives analog throttle. Blades still *look* like they spin up. |
| Facing | Separate from tilt; flip at any time. Realistic nose geometry: tilt right + face right = nose down, missile fires slightly down. Flip to face left = nose up, fires up-left. |
| Dive | ↓ / S adds straight-down acceleration (world space, not along the rotor). Deliberately arcade, not realistic. Tunable. |
| Missile (Fire 1) | Fires straight out of the nose. Aim with tilt plus facing. |
| Bomb (Fire 2) | Drops beneath you, for targets below (limited tilt can't aim down). **Disabled while the orb is attached.** |
| Tether | **Rigid rod** (rope makes it too easy). The rod is a true two-way constraint: the orb drags and shoves the heli. |
| Pickup | Hold tether (Space) within rod length of the orb, then pull away. After a release you must let go of Space before you can tether again. The rod locks at full length (Thrust-style; no "tractor beam" as a separate system). |
| Delivery | A small **orb bowl** (cup radius 28 vs orb radius 16). **Space while carrying releases the orb**, which keeps its momentum, so drops and "layups" work. **The bowl is the only thing the orb can touch safely**: it bounces around in the cup and is delivered once it **comes to rest in the bottom**. Within the bowl it's sturdy, shattering only on a head-on impact above **max impact** (default 240). Lowering it onto the bowl on the rod also works (a gentle touch auto-releases). |
| Orb destruction | The orb **explodes if it touches anything except the bowl** (ground, turrets), carried or dropped, **or if it's shot** (by anything, including your own weapons). **The pilot does not die.** The orb respawns on its pedestal after ~2s. |
| Mission complete | Choplifter-style: after the orb is in the bowl, **fly back and land on your start pad**. A HUD hint points the way home. |
| Collision | Heli touching anything = death (terrain, turrets, a loose orb). The exception is skids landing gently and level on a pad. The rod passes through terrain for now. The rod crossing the rotor = "rotor strike" death. |
| Out of scope | No reactor, no inverse gravity. Probably no tractor beam. |
| Leave room for | Fuel, shields (HUD space is reserved; pads could refuel). |
| Gravity | Gentle, Thrust-like. Playtest-tuned defaults: gravity 165, thrust 450, max horizontal speed 250, dive 115. The first defaults (320/850) were far too violent. With the orb, full thrust holds altitude up to ~44° of tilt, so max tilt (45°) is right at the edge. |
| Sound | Procedural (Web Audio, no samples). Rotor chop tempo follows the rotor: a brisk, soft but clearly audible idle chop (~8/s) building to a harder chop (~15/s) at full throttle, over a steady drone with a light low rumble and faint turbine whine. Treble kept soft (it read as a machine gun when bright). The idle chop must sit in an audible band, not just sub-bass. M mutes; volume in the tuning panel. |
| Look | Colourful faux-vector 80s arcade with modern glitz: additive glow lines, bloom, particles, scanlines, vignette. |

## Core loop

Launch from your pad → fight through the level → grab the orb → deliver it to the bowl → make your way back and land on your pad.

Level-design hook: the return trip doesn't have to retrace the outbound route. Levels can force a **separate path from the bowl back to the pad** (one-way drops, gates that open on delivery, a route that only works without the orb's extra length and weight).

## Milestones

- **M0, lug test** (current): one surface level, heli, orb, rod, orb bowl, inert turrets, missiles/bombs, live tuning panel. *Goal: is carrying the orb fun?*
- **M1, combat basics**: turrets that shoot, flying enemies, damage rules, fuel/shields decision.
- **M2, caverns**: underground levels, camera for tight spaces, level sequencing, a level editor.
- **M3, glitz pass**: WebGL bloom, audio, screen effects, menus.

## Open questions

- Should the rod collide with terrain (Thrust's didn't)?
- Fuel and shields: if added, does the shield block the tether like Thrust's did?
- Lives and scoring model.
- What a "harder level" means beyond tighter terrain: gravity per level, wind, heavier orbs, longer or shorter rods?
