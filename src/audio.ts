/** Tiny synthesized sound effects (no asset files). Everything is created lazily after the first user gesture. */
export class GameAudio {
  muted = false;
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private budget = 0;
  private last = 0;

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        const len = this.ctx.sampleRate * 0.25;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      } catch { return null; }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private allow(): boolean {
    const now = performance.now();
    if (now - this.last > 100) { this.last = now; this.budget = 0; }
    return ++this.budget <= 10;
  }

  private burst(freq: number, dur: number, vol: number, q = 1) {
    const ctx = this.ensure();
    if (!ctx || !this.noise || vol < 0.01 || !this.allow()) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(ctx.destination);
    src.start(); src.stop(ctx.currentTime + dur);
  }

  private tone(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', slide = 0) {
    const ctx = this.ensure();
    if (!ctx) return;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + dur);
  }

  shot(distance: number, mine: boolean) {
    const vol = mine ? 0.32 : Math.max(0, 0.2 * (1 - distance / 55));
    this.burst(mine ? 900 : 650, 0.12, vol, 0.7);
  }
  hit() { this.burst(1800, 0.05, 0.05, 2); }
  death() { this.tone(180, 0.25, 0.06, 'triangle', -90); }
  order() { this.tone(660, 0.07, 0.07, 'square'); }
  capture() { this.tone(520, 0.12, 0.08, 'sine'); setTimeout(() => this.tone(780, 0.18, 0.08, 'sine'), 110); }
  hitMarker() { this.tone(1500, 0.05, 0.07, 'square'); }
  hurt() { this.tone(120, 0.15, 0.1, 'sawtooth', -40); }
  toggle(): boolean { this.muted = !this.muted; return this.muted; }
  unlock() { this.ensure(); }
}
