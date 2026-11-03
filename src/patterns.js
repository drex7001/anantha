// LED colour patterns. Each pattern writes a linear-RGB colour (0..1) for one
// LED into `o`. `L` is the LED record from leds.js, `t` is time in seconds,
// `P` holds the pattern parameters (speed, base colour, extent, ...).

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export function hsv(h, s, v, o) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }
  o[0] = srgbToLinear(r); o[1] = srgbToLinear(g); o[2] = srgbToLinear(b);
  return o;
}

export function hexToLinear(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => srgbToLinear(x / 255));
}

const setScaled = (o, c, k) => { o[0] = c[0] * k; o[1] = c[1] * k; o[2] = c[2] * k; return o; };

export const PATTERNS = {
  'Rainbow flow': (L, t, P, o) => hsv(L.u * P.hueSpread + t * P.speed * 0.15, 1, 1, o),

  'Rainbow 3D': (L, t, P, o) =>
    hsv((L.y / P.extent) * 0.5 * P.hueSpread + t * P.speed * 0.15, 1, 1, o),

  'Comet chase': (L, t, P, o) => {
    const head = (t * P.speed * 0.12) % 1;
    const d = (head - L.u + 1) % 1; // distance behind the head
    const k = Math.exp(-d * 25) + 0.02;
    return setScaled(o, P.color, Math.min(1, k));
  },

  'Theater chase': (L, t, P, o) => {
    const step = Math.floor(t * P.speed * 6);
    return setScaled(o, P.color, (L.i + step) % 3 === 0 ? 1 : 0.0);
  },

  'Breathing': (L, t, P, o) =>
    setScaled(o, P.color, 0.08 + 0.92 * (0.5 - 0.5 * Math.cos(t * P.speed * 1.5))),

  'Twinkle': (L, t, P, o) => {
    const s = Math.pow(0.5 + 0.5 * Math.sin(t * P.speed * 2.2 + L.seed * 97), 40);
    o[0] = P.color[0] * 0.05 + s; o[1] = P.color[1] * 0.05 + s; o[2] = P.color[2] * 0.05 + s;
    return o;
  },

  'Plane sweep': (L, t, P, o) => {
    // a glowing plane that sweeps through the 3D shape, slowly changing direction
    const a = t * 0.23, b = t * 0.17;
    const nx = Math.cos(a) * Math.cos(b), ny = Math.sin(b), nz = Math.sin(a) * Math.cos(b);
    const d = L.x * nx + L.y * ny + L.z * nz;
    const w = Math.sin(t * P.speed) * P.extent;
    const k = Math.exp(-(((d - w) / (0.3 * P.extent)) ** 2));
    hsv(t * 0.04 + d / P.extent * 0.2 * P.hueSpread, 1, 1, o);
    return setScaled(o, o, 0.06 + k);
  },

  'Edge colours': (L, t, P, o) => hsv(L.e * 0.618 + t * P.speed * 0.05, 0.95, 1, o),

  'Solid': (L, t, P, o) => setScaled(o, P.color, 1),

  // ---- audio patterns (P.audio from audio.js; all zero when no audio is playing)
  'Audio spectrum': (L, t, P, o) => {
    const sp = P.audio.spectrum;
    const v = sp[Math.min(sp.length - 1, Math.floor(L.u * sp.length))];
    hsv(0.62 - L.u * 0.62 * P.hueSpread + t * P.speed * 0.02, 1, 1, o);
    return setScaled(o, o, 0.04 + v * v);
  },

  'Audio bass wave': (L, t, P, o) => {
    // a shell of light expands from the centre on every beat
    const A = P.audio;
    const d = Math.hypot(L.x, L.y, L.z) / P.extent;
    const ring = Math.exp(-(((d - A.sinceBeat * 1.6) / 0.18) ** 2)) * Math.exp(-A.sinceBeat * 1.2);
    hsv(A.beatCount * 0.13 + d * 0.25 * P.hueSpread, 1, 1, o);
    return setScaled(o, o, 0.06 + 0.8 * A.bass + ring);
  },

  'Audio VU meter': (L, t, P, o) => {
    // every strip fills from its start with the level; green → red
    const level = Math.min(1, P.audio.energy * 1.3);
    hsv(0.33 * (1 - L.s), 1, 1, o);
    return setScaled(o, o, L.s < level ? 1 : 0.03);
  },
};
