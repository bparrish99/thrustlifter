import { config } from './config';
import type { Game } from './game';

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

  /** Call once per frame. */
  update(game: Game, paused: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const spin = game.rotorSpin;
    const audible = game.alive && !paused && !this.muted;
    const smooth = 0.06;

    this.master.gain.setTargetAtTime(audible ? config.volume : 0, t, game.alive ? 0.08 : 0.02);
    // blade-pass rate: a brisk soft idle chop, building to a fast chop at full throttle
    this.chopLfo.frequency.setTargetAtTime(8 + spin * 7, t, smooth);
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
