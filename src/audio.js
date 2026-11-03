// Audio analysis for the audio-reactive mode (Web Audio API).
//
// Produces per frame: bass / mids / highs / energy (0..1, auto-gain), a
// 64-band log spectrum, and beats. Photosensitivity safety:
//   • beats (which drive flashes) are at most MAX_FLASH_HZ per second
//   • calm mode turns beats off entirely and smooths every level slowly

export const MAX_FLASH_HZ = 3;
const MIN_BEAT_GAP = 1 / MAX_FLASH_HZ + 0.01; // s
const BANDS = 64;

const smooth = (cur, target, dt, attack, release) =>
  cur + (target - cur) * (1 - Math.exp(-dt / (target > cur ? attack : release)));

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.node = null;     // current source node
    this.el = null;       // <audio> for files
    this.stream = null;   // mic / tab stream
    this.kind = 'off';
    this.name = '';
    this.calm = false;
    this.sensitivity = 1;
    this.peaks = { bass: 1e-3, mids: 1e-3, highs: 1e-3, spec: 1e-3 };
    this.raw = { bass: 0 };
    this.flux = [];
    this.beatTimes = [];
    this.lastBeat = -10;
    this.lastTime = 0;
    this.state = {
      active: false, bass: 0, mids: 0, highs: 0, energy: 0,
      pulse: 0, sinceBeat: 10, beatCount: 0, beatsPerSec: 0,
      spectrum: new Float32Array(BANDS),
    };
  }

  #ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.5;
      this.bins = new Float32Array(this.analyser.frequencyBinCount);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  stop() {
    this.node?.disconnect();
    this.node = null;
    if (this.el) { this.el.pause(); URL.revokeObjectURL(this.el.src); this.el = null; }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.kind = 'off';
    this.name = '';
    this.state.active = false;
  }

  async useFile(file) {
    this.stop();
    this.#ensureContext();
    const el = new Audio();
    el.src = URL.createObjectURL(file);
    el.loop = true;
    this.node = this.ctx.createMediaElementSource(el);
    this.node.connect(this.analyser);
    this.node.connect(this.ctx.destination); // we play the file, so route it to the speakers
    this.el = el;
    await el.play();
    this.#started('file', file.name);
  }

  async useMic() {
    this.stop();
    this.#ensureContext();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.node = this.ctx.createMediaStreamSource(this.stream); // analysed only, never played back
    this.node.connect(this.analyser);
    this.#started('mic', 'microphone');
  }

  async useTab() {
    this.stop();
    this.#ensureContext();
    // Chrome only shares audio together with a video track; we drop the video.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) throw new Error('No audio shared – tick "share tab audio"');
    this.stream = stream;
    this.node = this.ctx.createMediaStreamSource(stream);
    this.node.connect(this.analyser);
    this.#started('tab', 'tab audio');
  }

  togglePlay() {
    if (!this.el) return;
    if (this.el.paused) this.el.play(); else this.el.pause();
  }

  #started(kind, name) {
    this.kind = kind;
    this.name = name;
    this.state.active = true;
    this.flux.length = 0;
    this.beatTimes.length = 0;
    for (const k in this.peaks) this.peaks[k] = 1e-3;
  }

  update(nowMs) {
    const now = nowMs / 1000;
    const dt = Math.min(0.1, Math.max(1e-3, now - (this.lastTime || now - 0.016)));
    this.lastTime = now;
    const S = this.state;

    if (!S.active || !this.analyser || (this.el && this.el.paused)) {
      for (const k of ['bass', 'mids', 'highs', 'energy', 'pulse']) S[k] = smooth(S[k], 0, dt, 0.1, 0.4);
      S.spectrum.forEach((v, i) => { S.spectrum[i] = v * Math.exp(-dt / 0.3); });
      S.sinceBeat += dt;
      return S;
    }

    this.analyser.getFloatFrequencyData(this.bins);
    const hzPerBin = this.ctx.sampleRate / this.analyser.fftSize;
    const mag = (i) => Math.pow(10, this.bins[i] / 20); // dB → linear
    const band = (lo, hi) => {
      const a = Math.max(1, Math.floor(lo / hzPerBin)), b = Math.min(this.bins.length - 1, Math.ceil(hi / hzPerBin));
      let s = 0;
      for (let i = a; i <= b; i++) s += mag(i);
      return s / (b - a + 1);
    };

    // auto gain: divide by a slowly decaying peak
    const agc = (key, v) => {
      this.peaks[key] = Math.max(v, this.peaks[key] * Math.exp(-dt / 4), 1e-4);
      return Math.min(1, v / this.peaks[key]);
    };
    const bass = agc('bass', band(30, 150));
    const mids = agc('mids', band(150, 2000));
    const highs = agc('highs', band(2000, 12000));

    const [atk, rel] = this.calm ? [0.35, 1.0] : [0.03, 0.22];
    S.bass = smooth(S.bass, bass, dt, atk, rel);
    S.mids = smooth(S.mids, mids, dt, atk * 2, rel * 1.5);
    S.highs = smooth(S.highs, highs, dt, atk, rel);
    S.energy = smooth(S.energy, (bass + mids + highs) / 3, dt, 0.3, 1.2);

    // log-spaced spectrum 40 Hz … 12 kHz
    let specPeak = 1e-4;
    const spec = new Float32Array(BANDS);
    for (let i = 0; i < BANDS; i++) {
      const lo = 40 * Math.pow(300, i / BANDS), hi = 40 * Math.pow(300, (i + 1) / BANDS);
      spec[i] = band(lo, hi);
      specPeak = Math.max(specPeak, spec[i]);
    }
    this.peaks.spec = Math.max(specPeak, this.peaks.spec * Math.exp(-dt / 4), 1e-4);
    for (let i = 0; i < BANDS; i++) S.spectrum[i] = smooth(S.spectrum[i], spec[i] / this.peaks.spec, dt, atk, rel);

    // beats: spectral flux of the bass band against an adaptive threshold
    const flux = Math.max(0, bass - this.raw.bass);
    this.raw.bass = bass;
    this.flux.push(flux);
    if (this.flux.length > 60) this.flux.shift();
    const mean = this.flux.reduce((s, v) => s + v, 0) / this.flux.length;
    const sd = Math.sqrt(this.flux.reduce((s, v) => s + (v - mean) ** 2, 0) / this.flux.length);
    const threshold = mean + (1.5 / this.sensitivity) * sd;
    S.sinceBeat += dt;
    if (!this.calm && flux > threshold && flux > 0.08 / this.sensitivity && now - this.lastBeat >= MIN_BEAT_GAP) {
      this.lastBeat = now;
      this.beatTimes.push(now);
      S.beatCount++;
      S.sinceBeat = 0;
      S.pulse = 1;
    }
    S.pulse *= Math.exp(-dt / 0.15);
    while (this.beatTimes.length && now - this.beatTimes[0] > 4) this.beatTimes.shift();
    S.beatsPerSec = this.beatTimes.length / 4;
    return S;
  }
}
