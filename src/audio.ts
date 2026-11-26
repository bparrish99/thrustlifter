import { config } from './config';
import type { Game, GameEvent } from './game';
import type { Vec } from './math';

/*
 * Procedural helicopter sound (Web Audio, no sample files).
 *
 *   rotor:   looped noise -> low-pass -> "chop" gain  ┐
 *   body:    low sine thump              -> chop gain  ├-> rotor bus ┐
 *   rumble:  deep noise + sub sine, NOT pulsed (steady bed)         ├-> master -> low-pass (tames treble)
 *   whine:   faint turbine tone (band-passed)                       ┘
 *
 * The chop gain is pulsed by an LFO whose waveform is a sharp-attack/decay
 * "thwup" shape, at the blade-pass rate. Rate, loudness and brightness all
 * follow the rotor spin, so it idles slowly on the pad and roars at full throttle.
 *
 * Browsers only allow audio after a user gesture, so the context is created
 * on the first key press or click.
 */

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private rotorBus!: GainNode;
  private chopLfo!: OscillatorNode;
  private chopDepth!: GainNode;
  private chopGain!: GainNode;
  private noiseFilter!: BiquadFilterNode;
  private body!: OscillatorNode;
  private whine!: OscillatorNode;
  private whineGain!: GainNode;
  private rumbleGain!: GainNode;
  private rumbleFilter!: BiquadFilterNode;
  private beamGain!: GainNode;
  private beamOsc!: OscillatorNode;
  private beamOsc2!: OscillatorNode;
  private beamAir!: BiquadFilterNode;
  private shieldGain!: GainNode;
  private enemyRotor!: GainNode;
  private nextBlip = 0;
  private nextLowFuel = 0;
  private beamTime = 0; // seconds the beam has been on (drives the rising pitch)
  private lastT = 0;
  private sfx!: GainNode; // effects volume (end of chain)
  private sfxIn!: GainNode; // effects voices connect here
  private noise!: AudioBuffer;
  private brown!: AudioBuffer;
  muted = false;

  constructor(target: Window) {
    const start = () => {
      this.ensure();
      void this.ctx?.resume();
    };
    target.addEventListener('keydown', start);
    target.addEventListener('pointerdown', start);
  }

  toggleMute(): void {
    this.muted = !this.muted;
  }

  private ensure(): void {
    if (this.ctx) return;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    // one-shot effects get their own bus: they must keep playing while the rotor bus is
    // silenced (e.g. your own crash explosion)
    //   voices -> sfxIn -> dry ------------------┐
    //                   -> reverb send -> convolver -> wet ┴-> compressor -> tone -> sfx (volume) -> out
    // The reverb gives every effect space and a tail; the compressor adds weight and stops clipping.
    this.noise = noiseBuffer(ctx, 2);
    this.brown = brownNoiseBuffer(ctx, 3);
    this.sfxIn = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    const verb = ctx.createConvolver();
    verb.buffer = reverbImpulse(ctx, 3.2);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    const wet = ctx.createGain();
    wet.gain.value = 0.4;
    this.sfxIn.connect(comp);
    this.sfxIn.connect(send).connect(verb).connect(wet).connect(comp);
    const sfxTone = ctx.createBiquadFilter();
    sfxTone.type = 'lowpass';
    sfxTone.frequency.value = 5000; // keep the treble soft
    this.sfx = ctx.createGain();
    this.sfx.gain.value = config.volume * config.sfxVolume;
    comp.connect(sfxTone).connect(this.sfx).connect(ctx.destination);

    // tether beam: a rising "sucking" hum (fundamental + soft octave) plus a breathy
    // band of noise that rises with it; pitch swoops up the longer the beam pulls
    this.beamOsc = ctx.createOscillator();
    this.beamOsc.type = 'sine';
    this.beamOsc.frequency.value = 110;
    this.beamOsc2 = ctx.createOscillator();
    this.beamOsc2.type = 'sine';
    this.beamOsc2.frequency.value = 220;
    const octave = ctx.createGain();
    octave.gain.value = 0.3;
    const humMix = ctx.createGain();
    humMix.gain.value = 0.8;
    const pulse = ctx.createOscillator();
    pulse.frequency.value = 3;
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.05;
    pulse.connect(pulseDepth).connect(humMix.gain);
    this.beamOsc.connect(humMix);
    this.beamOsc2.connect(octave).connect(humMix);
    this.beamGain = ctx.createGain();
    this.beamGain.gain.value = 0;
    humMix.connect(this.beamGain).connect(this.sfxIn);
    const air = ctx.createBufferSource();
    air.buffer = this.noise;
    air.loop = true;
    this.beamAir = ctx.createBiquadFilter();
    this.beamAir.type = 'bandpass';
    this.beamAir.frequency.value = 300;
    this.beamAir.Q.value = 4;
    const airLevel = ctx.createGain();
    airLevel.gain.value = 0.35;
    air.connect(this.beamAir).connect(airLevel).connect(this.beamGain);
    air.start();

    // shield: a soft electric hum (two tones a fifth apart) with a fast shimmer
    const s1 = ctx.createOscillator();
    s1.type = 'sine';
    s1.frequency.value = 196;
    const s2 = ctx.createOscillator();
    s2.type = 'triangle';
    s2.frequency.value = 294;
    s2.detune.value = 6;
    const s2lvl = ctx.createGain();
    s2lvl.gain.value = 0.35;
    const shimmer = ctx.createOscillator();
    shimmer.frequency.value = 16;
    const shimmerDepth = ctx.createGain();
    shimmerDepth.gain.value = 0.25;
    const shieldMix = ctx.createGain();
    shieldMix.gain.value = 0.75;
    shimmer.connect(shimmerDepth).connect(shieldMix.gain);
    s1.connect(shieldMix);
    s2.connect(s2lvl).connect(shieldMix);
    const shieldTone = ctx.createBiquadFilter();
    shieldTone.type = 'lowpass';
    shieldTone.frequency.value = 1400;
    this.shieldGain = ctx.createGain();
    this.shieldGain.gain.value = 0;
    shieldMix.connect(shieldTone).connect(this.shieldGain).connect(this.sfxIn);
    for (const o of [s1, s2, shimmer]) o.start();

    // enemy rotors: a lighter, higher chop, loudest when a guard heli is close
    const eNoise = ctx.createBufferSource();
    eNoise.buffer = this.noise;
    eNoise.loop = true;
    const eBand = ctx.createBiquadFilter();
    eBand.type = 'bandpass';
    eBand.frequency.value = 520;
    eBand.Q.value = 1.1;
    const eChop = ctx.createGain();
    eChop.gain.value = 0.3;
    const eLfo = ctx.createOscillator();
    eLfo.setPeriodicWave(thwupWave(ctx));
    eLfo.frequency.value = 17;
    const eDepth = ctx.createGain();
    eDepth.gain.value = 0.3;
    eLfo.connect(eDepth).connect(eChop.gain);
    this.enemyRotor = ctx.createGain();
    this.enemyRotor.gain.value = 0;
    eNoise.connect(eBand).connect(eChop).connect(this.enemyRotor).connect(this.sfxIn);
    eNoise.start();
    eLfo.start();
    for (const o of [this.beamOsc, this.beamOsc2, pulse]) o.start();

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const tone = ctx.createBiquadFilter(); // overall treble cut
    tone.type = 'lowpass';
    tone.frequency.value = 1200;
    tone.Q.value = 0.5;
    this.master.connect(tone).connect(ctx.destination);

    this.rotorBus = ctx.createGain();
    this.rotorBus.gain.value = 0.6;
    this.rotorBus.connect(this.master);

    // pulsed gain: base level + LFO swing
    this.chopGain = ctx.createGain();
    this.chopGain.gain.value = 0.32; // base level between thumps: higher = steadier, lower = punchier
    this.chopGain.connect(this.rotorBus);
    this.chopLfo = ctx.createOscillator();
    this.chopLfo.setPeriodicWave(thwupWave(ctx));
    this.chopLfo.frequency.value = 5;
    this.chopDepth = ctx.createGain();
    this.chopDepth.gain.value = 0.2;
    this.chopLfo.connect(this.chopDepth).connect(this.chopGain.gain);
    this.chopLfo.start();

    // air noise
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 2);
    noise.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'lowpass';
    this.noiseFilter.frequency.value = 200;
    this.noiseFilter.Q.value = 0.5;
    const noiseLevel = ctx.createGain();
    noiseLevel.gain.value = 0.9;
    noise.connect(this.noiseFilter).connect(noiseLevel).connect(this.chopGain);
    noise.start();

    // low body thump
    this.body = ctx.createOscillator();
    this.body.type = 'triangle'; // overtones make the thump audible on small speakers
    this.body.frequency.value = 64;
    const bodyLevel = ctx.createGain();
    bodyLevel.gain.value = 0.55;
    this.body.connect(bodyLevel).connect(this.chopGain);
    this.body.start();

    // steady low rumble bed (not pulsed by the chop)
    const rumbleNoise = ctx.createBufferSource();
    rumbleNoise.buffer = noiseBuffer(ctx, 3);
    rumbleNoise.loop = true;
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 110;
    this.rumbleFilter.Q.value = 0.7;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rumbleNoise.connect(this.rumbleFilter).connect(this.rumbleGain).connect(this.master);
    rumbleNoise.start();
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 38;
    const subLevel = ctx.createGain();
    subLevel.gain.value = 0.35;
    sub.connect(subLevel).connect(this.rumbleGain);
    sub.start();

    // turbine whine
    this.whine = ctx.createOscillator();
    this.whine.type = 'triangle';
    this.whine.frequency.value = 380;
    const whineBand = ctx.createBiquadFilter();
    whineBand.type = 'bandpass';
    whineBand.frequency.value = 900;
    whineBand.Q.value = 2;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(whineBand).connect(this.whineGain).connect(this.master);
    this.whine.start();
  }

  /** One-shot effects for game events. Distant events (from the listener) play quieter. */
  play(e: GameEvent, listener?: Vec): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    let v = 1;
    if (e.pos && listener) v = Math.max(0.15, Math.min(1, 1 - Math.hypot(e.pos.x - listener.x, e.pos.y - listener.y) / 1600));
    const t = ctx.currentTime + 0.005;
    switch (e.type) {
      case 'missile': // ignition thump, then a roaring burn that trails off
        this.tone(t, { type: 'sine', f0: 150, f1: 55, dur: 0.25, gain: 0.55 * v });
        this.noiseHit(t, { dur: 1.0, type: 'bandpass', f0: 700, f1: 1300, q: 0.9, gain: 0.55 * v, attack: 0.04 });
        this.noiseHit(t, { dur: 1.1, type: 'lowpass', f0: 700, f1: 250, gain: 0.7 * v, attack: 0.03, brown: true });
        break;
      case 'tankEmpty': // drained: a hollow little clunk
        this.tone(t, { type: 'triangle', f0: 300, f1: 160, dur: 0.2, gain: 0.25 * v });
        this.ring(t, 900, 0.3, 0.12 * v);
        break;
      case 'board': // cheerful little hop aboard, plus fuel-top-up blips
        this.tone(t, { type: 'triangle', f0: 660, f1: 660, dur: 0.12, gain: 0.16, attack: 0.005, lowpass: 2500 });
        this.tone(t + 0.08, { type: 'triangle', f0: 880, f1: 880, dur: 0.18, gain: 0.16, attack: 0.005, lowpass: 2500 });
        [520, 700, 940].forEach((f, i) => this.tone(t + 0.2 + i * 0.06, { type: 'sine', f0: f, f1: f, dur: 0.1, gain: 0.1, attack: 0.005 }));
        break;
      case 'rescued': // short happy run up
        [523.25, 659.25, 783.99, 880, 1046.5].forEach((f, i) => this.tone(t + i * 0.07, { type: 'triangle', f0: f, f1: f, dur: 0.5, gain: 0.13, attack: 0.005, lowpass: 2600 }));
        break;
      case 'tallyTime': { // rapid rising blips as the clock drains
        const f = 520 + (e.value ?? 0) * 900;
        this.tone(t, { type: 'square', f0: f, f1: f * 1.02, dur: 0.045, gain: 0.05, attack: 0.002, lowpass: 3200 });
        break;
      }
      case 'tallyFuel': { // a bright "ka-ching" per fuel tick, climbing the scale
        const steps = [0, 2, 4, 5, 7, 9, 11, 12];
        const n = (e.value ?? 1) - 1;
        const f = 440 * Math.pow(2, (steps[n % 8] + 12 * Math.floor(n / 8)) / 12);
        this.tone(t, { type: 'triangle', f0: f, f1: f, dur: 0.16, gain: 0.12, attack: 0.003, lowpass: 3500 });
        this.tone(t + 0.03, { type: 'sine', f0: f * 2, f1: f * 2, dur: 0.2, gain: 0.06, attack: 0.003 });
        break;
      }
      case 'tallyDone': // final chord
        for (const f of [523.25, 659.25, 783.99, 1046.5]) this.tone(t, { type: 'triangle', f0: f, f1: f, dur: 1.4, gain: 0.08, attack: 0.01, lowpass: 2600 });
        break;
      case 'extraLife': // classic arcade 1-up arpeggio
        [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568].forEach((f, i) =>
          this.tone(t + i * 0.06, { type: 'square', f0: f, f1: f, dur: i === 5 ? 0.5 : 0.1, gain: 0.07, attack: 0.004, lowpass: 3000 }),
        );
        break;
      case 'balloonPop': // pop! then a rubbery flap of falling scraps
        this.noiseHit(t, { dur: 0.12, type: 'highpass', f0: 1200, f1: 600, gain: 0.6 * v });
        this.tone(t, { type: 'sine', f0: 160, f1: 70, dur: 0.25, gain: 0.5 * v });
        this.tone(t + 0.05, { type: 'triangle', f0: 420, f1: 140, dur: 0.5, gain: 0.08 * v, lowpass: 1200 });
        this.boom(t, 0.3, v * 0.6);
        break;
      case 'enemyLaunch': // guard spinning up: a rising whoosh with a turbine whine
        this.noiseHit(t, { dur: 1.2, type: 'bandpass', f0: 250, f1: 900, q: 1.2, gain: 0.45 * v, attack: 0.4 });
        this.tone(t, { type: 'triangle', f0: 180, f1: 520, dur: 1.2, gain: 0.08 * v, attack: 0.3, lowpass: 1500 });
        break;
      case 'shieldHit': // electric zap as the shield eats a shot
        this.noiseHit(t, { dur: 0.3, type: 'bandpass', f0: 2400, f1: 700, q: 2, gain: 0.5 * v });
        this.tone(t, { type: 'sawtooth', f0: 900, f1: 260, dur: 0.25, gain: 0.08 * v, lowpass: 2200 });
        this.tone(t, { type: 'sine', f0: 180, f1: 90, dur: 0.3, gain: 0.3 * v });
        break;
      case 'enemyShot': // deep "thoom" rather than a pew
        this.tone(t, { type: 'sine', f0: 230, f1: 85, dur: 0.45, gain: 0.45 * v });
        this.tone(t, { type: 'square', f0: 460, f1: 180, dur: 0.3, gain: 0.07 * v, lowpass: 1100 });
        this.noiseHit(t, { dur: 0.4, type: 'bandpass', f0: 650, f1: 280, q: 1.2, gain: 0.35 * v });
        break;
      case 'impact': // missile hits rock
        this.boom(t, 0.35, v);
        break;
      case 'turretDown':
        this.boom(t, 0.9, v);
        this.debris(t + 0.08, 5, v);
        break;
      case 'heliDown':
        this.boom(t, 1.3, 1);
        this.boom(t + 0.16, 0.6, 0.8);
        this.debris(t + 0.1, 8, 1);
        break;
      case 'orbLost': // glassy shatter that rings out, over a muffled burst
        for (const [f, d] of [[990, 1.6], [1320, 1.3], [1780, 1.1], [2470, 0.9], [3110, 0.7]] as const) {
          this.tone(t, { type: 'sine', f0: f, f1: f * 0.985, dur: d, gain: 0.07 * v, attack: 0.002 });
          this.tone(t + 0.01, { type: 'sine', f0: f * 1.004, f1: f * 0.99, dur: d * 0.9, gain: 0.05 * v, attack: 0.002 });
        }
        this.noiseHit(t, { dur: 0.6, type: 'highpass', f0: 2500, f1: 3500, gain: 0.15 * v });
        this.boom(t, 0.45, v);
        break;
      case 'tether': // "...up!" chirp to finish the beam's swoop, then a magnetic lock: thump, clank, hum
        this.tone(t, { type: 'sine', f0: 480, f1: 1100, dur: 0.14, gain: 0.3, attack: 0.01 });
        this.tone(t, { type: 'sine', f0: 120, f1: 65, dur: 0.3, gain: 0.6 });
        this.ring(t, 720, 0.6, 0.35);
        this.tone(t, { type: 'sawtooth', f0: 80, f1: 160, dur: 0.4, gain: 0.12, attack: 0.05, lowpass: 500 });
        break;
      case 'release':
        this.tone(t, { type: 'sine', f0: 110, f1: 55, dur: 0.3, gain: 0.55 });
        this.ring(t, 520, 0.5, 0.3);
        break;
      case 'delivered': // bright chime that rings out
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          this.tone(t + i * 0.1, { type: 'sine', f0: f, f1: f, dur: 2.4, gain: 0.14, attack: 0.008 });
          this.tone(t + i * 0.1, { type: 'sine', f0: f * 1.002, f1: f * 1.002, dur: 2.2, gain: 0.08, attack: 0.008 });
        });
        this.tone(t, { type: 'triangle', f0: 261.6, f1: 261.6, dur: 2.0, gain: 0.1, attack: 0.3, lowpass: 1500 });
        break;
      case 'complete': // fanfare over a warm chord
        [392, 523.25, 659.25, 783.99, 659.25, 1046.5].forEach((f, i) =>
          this.tone(t + i * 0.13, { type: 'triangle', f0: f, f1: f, dur: i === 5 ? 2.6 : 0.5, gain: 0.17, attack: 0.01, lowpass: 2800 }),
        );
        for (const f of [130.8, 196, 261.6, 329.6]) this.tone(t + 0.6, { type: 'sawtooth', f0: f, f1: f, dur: 2.8, gain: 0.05, attack: 0.4, lowpass: 900 });
        break;
      case 'gate': // heavy energy barrier powering up/down
        this.tone(t, { type: 'sawtooth', f0: 55, f1: 110, dur: 1.8, gain: 0.3, attack: 0.15, lowpass: 700 });
        this.tone(t, { type: 'sine', f0: 42, f1: 36, dur: 1.8, gain: 0.45, attack: 0.1 });
        this.noiseHit(t, { dur: 1.8, type: 'lowpass', f0: 400, f1: 120, gain: 0.5, attack: 0.2, brown: true });
        break;
      case 'land':
        this.tone(t, { type: 'sine', f0: 140, f1: 55, dur: 0.35, gain: 0.55 });
        this.noiseHit(t, { dur: 0.3, type: 'lowpass', f0: 400, f1: 100, gain: 0.45, brown: true });
        break;
      case 'liftoff':
        break;
    }
  }

  private tone(
    t: number,
    o: { type: OscillatorType; f0: number; f1: number; dur: number; gain: number; attack?: number; lowpass?: number },
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + o.dur);
    const g = ctx.createGain();
    envelope(g.gain, t, o.attack ?? 0.005, o.dur, o.gain);
    let node: AudioNode = osc.connect(g);
    if (o.lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lowpass;
      node = node.connect(f);
    }
    node.connect(this.sfxIn);
    osc.start(t);
    osc.stop(t + o.dur + 0.1);
  }

  private noiseHit(
    t: number,
    o: { dur: number; type: BiquadFilterType; f0: number; f1: number; q?: number; gain: number; attack?: number; brown?: boolean },
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = o.brown ? this.brown : this.noise;
    src.loop = true;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter();
    f.type = o.type;
    f.Q.value = o.q ?? 0.7;
    f.frequency.setValueAtTime(o.f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + o.dur);
    const g = ctx.createGain();
    envelope(g.gain, t, o.attack ?? 0.004, o.dur, o.gain);
    src.connect(f).connect(g).connect(this.sfxIn);
    src.start(t, Math.random() * 1.5);
    src.stop(t + o.dur + 0.1);
  }

  /** A struck-metal ring: noise through a very narrow band-pass. */
  private ring(t: number, freq: number, dur: number, gain: number): void {
    this.noiseHit(t, { dur, type: 'bandpass', f0: freq, f1: freq * 0.97, q: 18, gain: gain * 4, attack: 0.002 });
  }

  /**
   * Explosion, layered for weight: a short crack, a fiery body that darkens as it
   * decays, a long brown-noise rumble tail and a sub-bass drop. `size` ~0.3 (small) to 1.3 (huge).
   */
  private boom(t: number, size: number, v: number): void {
    this.noiseHit(t, { dur: 0.08, type: 'bandpass', f0: 2200, f1: 900, q: 0.8, gain: 0.45 * v * Math.min(1, size + 0.3) });
    this.noiseHit(t, { dur: 0.4 + 1.0 * size, type: 'lowpass', f0: 600 + 2200 * Math.min(size, 1), f1: 140, gain: 0.85 * v, attack: 0.006 });
    this.noiseHit(t, { dur: 0.7 + 1.6 * size, type: 'lowpass', f0: 450, f1: 55, gain: 0.8 * v * Math.min(1, size + 0.2), attack: 0.03, brown: true });
    this.tone(t, { type: 'sine', f0: 95, f1: 30, dur: 0.5 + 0.6 * size, gain: 0.55 * v * Math.min(1, size + 0.1), attack: 0.004 });
  }

  /** Metal debris clattering down after a big explosion. */
  private debris(t: number, n: number, v: number): void {
    for (let i = 0; i < n; i++) {
      const dt = 0.15 + Math.random() * 0.9;
      this.ring(t + dt, 600 + Math.random() * 1400, 0.25 + Math.random() * 0.25, (0.08 + Math.random() * 0.08) * v);
    }
  }

  /** Call once per frame. */
  update(game: Game, paused: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const spin = game.rotorSpin;
    const audible = game.alive && !paused && !this.muted;
    const smooth = 0.06;

    this.master.gain.setTargetAtTime(audible ? config.volume : 0, t, game.alive ? 0.08 : 0.02);
    this.sfx.gain.setTargetAtTime(this.muted || paused ? 0 : config.volume * config.sfxVolume, t, 0.03);
    // tether beam hum
    const beamOn = game.beam && game.alive && !paused;
    const dt = Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    this.beamTime = beamOn ? this.beamTime + dt : 0;
    // "boooeeee...": swoops from ~85 Hz up toward ~460 Hz over about 1.4 s, then keeps creeping up
    const k = Math.min(1, this.beamTime / 1.4);
    const bf = 85 * Math.pow(460 / 85, k * k * (3 - 2 * k)) + Math.max(0, this.beamTime - 1.4) * 40;
    this.beamGain.gain.setTargetAtTime(beamOn ? 0.26 : 0, t, beamOn ? 0.05 : 0.07);
    this.beamOsc.frequency.setTargetAtTime(bf, t, 0.03);
    this.beamOsc2.frequency.setTargetAtTime(bf * 2, t, 0.03);
    this.beamAir.frequency.setTargetAtTime(bf * 3, t, 0.03);

    // enemy rotor chop by distance to the nearest flying guard
    let near = Infinity;
    for (const e of game.enemies) if (e.state !== 'parked') near = Math.min(near, Math.hypot(e.pos.x - game.heli.pos.x, e.pos.y - game.heli.pos.y));
    const eLevel = paused || !game.alive ? 0 : Math.max(0, 1 - near / 1100) * 0.5;
    this.enemyRotor.gain.setTargetAtTime(eLevel, t, 0.1);

    // shield hum
    this.shieldGain.gain.setTargetAtTime(game.shield && !paused ? 0.2 : 0, t, 0.04);
    // refuel: soft blips rising in pitch as the tank fills
    if (game.refueling && !paused && game.alive && t >= this.nextBlip) {
      const k = game.fuel / config.fuelMax;
      this.tone(t, { type: 'sine', f0: 440 + k * 440, f1: 440 + k * 440, dur: 0.09, gain: 0.12, attack: 0.005 });
      this.nextBlip = t + 0.14;
    }
    // low fuel warning beep while flying
    if (game.alive && !paused && !game.heli.landed && game.fuel < config.fuelMax * 0.2 && t >= this.nextLowFuel) {
      this.tone(t, { type: 'triangle', f0: 660, f1: 640, dur: 0.16, gain: 0.14, attack: 0.005, lowpass: 2000 });
      this.tone(t + 0.18, { type: 'triangle', f0: 520, f1: 500, dur: 0.16, gain: 0.12, attack: 0.005, lowpass: 2000 });
      this.nextLowFuel = t + (game.fuel <= 0 ? 0.8 : 1.4);
    }
    // blade-pass rate: a brisk soft idle chop on the pad; once airborne the beat never
    // drops back to idle tempo (you can hear that you're flying), building to full at max throttle
    const minRate = game.heli.landed ? 8 : 11.5;
    this.chopLfo.frequency.setTargetAtTime(minRate + spin * (15 - minRate), t, game.heli.landed ? 0.35 : 0.25);
    // idle chop sits in an audible band (not just sub-bass) so it reads on any speakers
    this.chopDepth.gain.setTargetAtTime(0.4, t, smooth);
    this.rotorBus.gain.setTargetAtTime(0.7 + spin * 0.3, t, smooth);
    this.noiseFilter.frequency.setTargetAtTime(400 + spin * 235, t, smooth);
    this.body.frequency.setTargetAtTime(64 - spin * 2, t, smooth);
    this.rumbleGain.gain.setTargetAtTime(0.12 + spin * 0.68, t, smooth);
    this.rumbleFilter.frequency.setTargetAtTime(90 + spin * 70, t, smooth);
    this.whine.frequency.setTargetAtTime(340 + spin * 230, t, smooth);
    this.whineGain.gain.setTargetAtTime(0.008 + spin * 0.02, t, smooth);
  }
}

/** Attack to `peak`, then a natural exponential decay that reaches silence by `dur`. */
function envelope(p: AudioParam, t: number, attack: number, dur: number, peak: number): void {
  p.setValueAtTime(0.0001, t);
  p.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  p.setTargetAtTime(0.0001, t + attack, Math.max(0.01, (dur - attack) / 4.5));
}

/** Brown (red) noise: deep, heavy rumble. */
function brownNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = last * 3.5;
  }
  return buf;
}

/** Synthetic hall reverb: stereo decaying noise, darkened over time. */
function reverbImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      const k = 0.5 - 0.42 * x; // later reflections are duller
      lp += ((Math.random() * 2 - 1) - lp) * k;
      d[i] = lp * Math.pow(1 - x, 2.4) * (i < ctx.sampleRate * 0.01 ? i / (ctx.sampleRate * 0.01) : 1);
    }
  }
  return buf;
}

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** One blade pass: a fast attack then exponential decay, as a periodic wave. */
function thwupWave(ctx: AudioContext): PeriodicWave {
  const N = 256;
  const H = 18; // fewer harmonics = rounder pulse, less click
  const shape = (x: number) => (x < 0.08 ? Math.sin((x / 0.08) * Math.PI * 0.5) : Math.exp(-(x - 0.08) * 5.5));
  const real = new Float32Array(H);
  const imag = new Float32Array(H);
  for (let k = 1; k < H; k++) {
    let a = 0;
    let b = 0;
    for (let n = 0; n < N; n++) {
      const x = n / N;
      const v = shape(x);
      a += v * Math.cos(2 * Math.PI * k * x);
      b += v * Math.sin(2 * Math.PI * k * x);
    }
    real[k] = (2 * a) / N;
    imag[k] = (2 * b) / N;
  }
  return ctx.createPeriodicWave(real, imag);
}
