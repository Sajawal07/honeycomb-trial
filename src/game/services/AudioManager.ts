/**
 * AudioManager
 * All sounds are synthesized at runtime with WebAudio (no files, works
 * offline): needle scratch loop, crack snaps, break crunch, success chime,
 * failure tone, countdown tick and UI clicks.
 */
export class AudioManager {
  enabled = true;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private scratchSrc: AudioBufferSourceNode | null = null;
  private scratchGain: GainNode | null = null;
  private scratchFilter: BiquadFilterNode | null = null;

  /** Must be called from a user gesture to unlock audio on mobile. */
  unlock(): void {
    if (!this.enabled) return;
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.8;
        const comp = this.ctx.createDynamicsCompressor();
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
        this.noise = this.makeNoise(2);
        this.startScratchLoop();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.setScratch(0, false);
      if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
    } else {
      this.unlock();
    }
  }

  suspend(): void {
    this.setScratch(0, false);
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (this.enabled && this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  destroy(): void {
    try {
      this.scratchSrc?.stop();
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      last = last * 0.6 + w * 0.4; // slightly brown for a sugary grind
      d[i] = last * (0.7 + 0.3 * Math.random());
    }
    return buf;
  }

  private startScratchLoop(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2400;
    filter.Q.value = 1.4;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.master!);
    src.start();
    this.scratchSrc = src;
    this.scratchFilter = filter;
    this.scratchGain = gain;
  }

  /** Continuous needle scratch; intensity 0..1, rough=true when off the line. */
  setScratch(intensity: number, rough: boolean): void {
    if (!this.ctx || !this.scratchGain || !this.scratchFilter) return;
    const t = this.ctx.currentTime;
    const g = this.enabled ? Math.min(1, intensity) * (rough ? 0.32 : 0.16) : 0;
    this.scratchGain.gain.setTargetAtTime(g, t, 0.03);
    this.scratchFilter.frequency.setTargetAtTime(rough ? 1100 : 2600 + intensity * 900, t, 0.05);
  }

  private burst(opts: { dur: number; gain: number; type: BiquadFilterType; freq: number; q?: number; delay?: number }): void {
    if (!this.ctx || !this.enabled || !this.noise) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.frequency.value = opts.freq;
    f.Q.value = opts.q ?? 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opts.gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 1.5);
    src.stop(t + opts.dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', delay = 0, slideTo?: number): void {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  crack(severity: number): void {
    this.burst({ dur: 0.07 + severity * 0.05, gain: 0.5 + severity * 0.3, type: 'highpass', freq: 2200 - severity * 800, q: 0.7 });
    this.burst({ dur: 0.04, gain: 0.35, type: 'bandpass', freq: 5200, q: 3, delay: 0.025 });
    this.tone(180 - severity * 60, 0.06, 0.12, 'triangle');
  }

  breakCookie(): void {
    this.burst({ dur: 0.5, gain: 0.9, type: 'lowpass', freq: 1400, q: 0.5 });
    for (let i = 0; i < 6; i++) {
      this.burst({ dur: 0.06, gain: 0.45, type: 'highpass', freq: 1800 + i * 300, delay: 0.03 + i * 0.05 + Math.random() * 0.03 });
    }
    this.tone(110, 0.45, 0.25, 'sine', 0, 55);
  }

  success(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      this.tone(f, 0.55, 0.16, 'triangle', i * 0.075);
      this.tone(f * 2, 0.35, 0.04, 'sine', i * 0.075 + 0.01);
    });
    this.burst({ dur: 0.25, gain: 0.12, type: 'highpass', freq: 6000, delay: 0.02 });
  }

  fail(): void {
    this.tone(220, 0.5, 0.18, 'sawtooth', 0.0, 140);
    this.tone(164.8, 0.8, 0.16, 'triangle', 0.18, 98);
  }

  tick(urgent: boolean): void {
    this.tone(urgent ? 1320 : 990, 0.06, 0.12, 'square');
  }

  click(): void {
    this.tone(660, 0.05, 0.07, 'triangle');
  }

  roundStart(): void {
    this.tone(392, 0.18, 0.08, 'triangle');
    this.tone(587.3, 0.25, 0.08, 'triangle', 0.1);
  }
}
