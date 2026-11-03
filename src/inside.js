// Objects inside the mirror: creatures, trees, fireflies, chrome spheres.
// Every frame the creatures are re-posed and handed to the ray tracer:
//   primTex  3 texels/capsule  (a.xyz, r) (b.xyz, material) (colour.rgb, 0)
//   objS     uniform vec4/object: bounding sphere (centre, radius)
//   objR     uniform vec4/object: (firstPrim, primCount, spheres, material)
//            spheres = 0 for capsules, else 1 + index of its first entry in sph
//   sph      uniform vec4/sphere: (centre, radius) for spheres-only objects
// The per-object and sphere data live in uniforms because every pixel reads
// them in the same order on every bounce (cheaper than texture fetches).
// Material: 0 neon (emits colour), 1 matte (lit by the mirror's mean light), 2 chrome.
import { human, quadruped, bird, fish, makeTree, tree, mulberry32 } from './creatures.js';
import { isInside } from './shapes.js';
import { linearTexture } from './textures.js';

export const MAX_OBJECTS = 32;   // must match the shader
export const MAX_SPHERES = 96;   // must match the shader
export const MAX_PRIMS = 1024;
const MAT = { neon: 0, matte: 1, chrome: 2 };
const CHROME = [0.92, 0.93, 0.96];

const KINDS = {
  human: { build: (ph) => human(ph), own: [0.35, 0.75, 1.0], albedo: [0.82, 0.8, 0.78], cadence: 0.9, speed: 1.2, scale: 1 },
  deer: { build: (ph) => quadruped(ph), own: [1.0, 0.6, 0.25], albedo: [0.6, 0.42, 0.28], cadence: 1.1, speed: 1.3, scale: 1 },
  dog: { build: (ph) => quadruped(ph, { antlers: false }), own: [1.0, 0.85, 0.4], albedo: [0.75, 0.6, 0.4], cadence: 1.8, speed: 1.1, scale: 0.5 },
  bird: { build: (ph) => bird(ph), own: [0.4, 1.0, 0.6], albedo: [0.75, 0.75, 0.8], cadence: 3, speed: 1, scale: 1 },
  fish: { build: (ph) => fish(ph), own: [1.0, 0.35, 0.6], albedo: [0.95, 0.55, 0.3], cadence: 1.6, speed: 0.6, scale: 1 },
  tree: { own: [1.0, 0.75, 0.35], albedo: [0.35, 0.25, 0.18], leafAlbedo: [0.25, 0.5, 0.2] },
  firefly: { own: [0.75, 1.0, 0.25], albedo: [0.7, 0.75, 0.5] },
  spheres: { albedo: [0.8, 0.8, 0.85], own: [0.9, 0.9, 1.0] },
};

// path: walk (on the ground, circling), fly / swim (circling in the air), static
// lane: circle radius as a fraction of the walk radius; height: fraction of the interior height
export const SCENES = {
  'None': [],
  'Neon deer': [{ kind: 'deer', path: 'walk', mat: 'neon' }],
  'People walking': [
    { kind: 'human', path: 'walk', mat: 'matte' },
    { kind: 'human', path: 'walk', mat: 'matte', phase: Math.PI, lane: 0.55, dir: -1 },
  ],
  'Dog & owner': [
    { kind: 'human', path: 'walk', mat: 'neon' },
    { kind: 'dog', path: 'walk', mat: 'neon', phase: 0.35, lane: 1.25 },
  ],
  'Forest & fireflies': [
    { kind: 'tree', path: 'static', pos: [-0.45, 0.2], seed: 3 },
    { kind: 'tree', path: 'static', pos: [0.5, -0.25], seed: 11 },
    { kind: 'fireflies' },
  ],
  'Birds': [
    { kind: 'bird', path: 'fly', height: 0.62 },
    { kind: 'bird', path: 'fly', height: 0.75, phase: 2.1, lane: 0.7 },
    { kind: 'bird', path: 'fly', height: 0.5, phase: 4.2, lane: 1.15, dir: -1 },
  ],
  'Floating fish': [
    { kind: 'fish', path: 'swim', height: 0.35 },
    { kind: 'fish', path: 'swim', height: 0.5, phase: 1.6, lane: 0.6, dir: -1 },
    { kind: 'fish', path: 'swim', height: 0.65, phase: 3.1, lane: 1.1 },
    { kind: 'fish', path: 'swim', height: 0.45, phase: 4.7, lane: 0.85 },
  ],
  'Chrome spheres': [{ kind: 'spheres', count: 7 }],
  'Nature (everything)': [
    { kind: 'tree', path: 'static', pos: [-0.35, -0.3], seed: 5 },
    { kind: 'deer', path: 'walk', mat: 'neon', lane: 1.0 },
    { kind: 'bird', path: 'fly', height: 0.72, phase: 1.0, lane: 0.8 },
    { kind: 'bird', path: 'fly', height: 0.6, phase: 3.5, lane: 1.1, dir: -1 },
    { kind: 'fireflies' },
  ],
};

export class InsideScene {
  constructor() {
    this.primTex = linearTexture(3 * MAX_PRIMS);
    this.objS = new Float32Array(MAX_OBJECTS * 4);
    this.objR = new Float32Array(MAX_OBJECTS * 4);
    this.sph = new Float32Array(MAX_SPHERES * 4);
    this.numObjects = 0;
    this.numPrims = 0;
    this.defs = [];
  }

  // Fit the scene to the shape's interior (scale, ground, walk radius).
  setup(name, shape) {
    this.defs = SCENES[name] || [];
    this.shape = shape;
    const { bboxMin: mn, bboxMax: mx } = shape;
    this.min = mn;
    this.size = [mx.x - mn.x, mx.y - mn.y, mx.z - mn.z];
    const [W, H, D] = this.size;
    this.ground0 = shape.flatBottom ? mn.y : mn.y + 0.2 * H;
    this.baseScale = Math.min(H / 2.6, Math.min(W, D) / 1.3);
    this.R = 0.3 * Math.min(W, D);
    this.trees = new Map();
    for (const d of this.defs) if (d.kind === 'tree') this.trees.set(d.seed, makeTree(d.seed));
    const rnd = mulberry32(42);
    this.flies = Array.from({ length: 64 }, () => ({
      f: [0.11 + rnd() * 0.2, 0.09 + rnd() * 0.2, 0.13 + rnd() * 0.2], p: [rnd() * 7, rnd() * 7, rnd() * 7],
      blink: 0.25 + rnd() * 0.45, ph: rnd() * 7, pos: [0, 0, 0],
    }));
    this.spheres = Array.from({ length: 12 }, () => ({
      x: (rnd() - 0.5) * 0.85, y: 0.15 + rnd() * 0.7, z: (rnd() - 0.5) * 0.85, r: 0.6 + rnd() * 0.8, ph: rnd() * 7,
    }));
  }

  // opts: { t, speed, scale, material: designed|neon|matte|chrome, colour: own|pattern,
  //         colorFn(x,y,z,i,out), fireflies, waterY (or null), gain }
  update(o) {
    const P = this.primTex.image.data;
    let np = 0, no = 0, ns = 0;
    const [W, H, D] = this.size;
    const ground = o.waterY != null ? Math.max(this.ground0, o.waterY) : this.ground0;
    const s0 = this.baseScale * o.scale;
    const t = o.t * o.speed;
    const tmpC = [0, 0, 0];

    const emit = (prims, x, y, z, yaw, sc, kind, mat) => {
      if (no >= MAX_OBJECTS || !prims.length) return;
      const K = KINDS[kind] || {};
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const first = np;
      let cx = 0, cy = 0, cz = 0, n = 0;
      const world = [];
      for (const pr of prims) {
        if (np >= MAX_PRIMS) break;
        const tr = (p) => [x + (p[0] * c + p[2] * s) * sc, y + p[1] * sc, z + (-p[0] * s + p[2] * c) * sc];
        const a = tr(pr.a), b = tr(pr.b);
        // material for this capsule
        // light parts (leaves, fireflies) are neon by design; the override restyles
        // bodies and leaves, but fireflies always stay lights and chrome never dims a light
        let m = pr.part === 'light' ? 'neon' : mat;
        if (o.material !== 'designed' && kind !== 'firefly') {
          m = pr.part === 'light' && o.material === 'chrome' ? 'neon' : o.material;
        }
        let col;
        if (m === 'neon') {
          if (o.colour === 'pattern') col = o.colorFn((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, np, tmpC).slice();
          else col = K.own || [1, 0.8, 0.4];
          col = col.map((v) => v * o.gain);
          col = col.map((v) => v * (pr.glow ?? 1)); // fireflies blink
        } else if (m === 'matte') col = (pr.part === 'light' ? K.leafAlbedo : K.albedo) || [0.6, 0.6, 0.6];
        else col = CHROME;
        P.set([a[0], a[1], a[2], pr.r * sc, b[0], b[1], b[2], MAT[m], col[0], col[1], col[2], 0], np * 12);
        world.push([a, b, pr.r * sc]);
        cx += a[0] + b[0]; cy += a[1] + b[1]; cz += a[2] + b[2]; n += 2;
        np++;
      }
      cx /= n; cy /= n; cz /= n;
      let rad = 0;
      for (const [a, b, r] of world) {
        rad = Math.max(rad, Math.hypot(a[0] - cx, a[1] - cy, a[2] - cz) + r, Math.hypot(b[0] - cx, b[1] - cy, b[2] - cz) + r);
      }
      // spheres-only objects of one material take a cheaper path in the shader
      let spheresOnly = ns + (np - first) <= MAX_SPHERES;
      for (let i = first; i < np && spheresOnly; i++) {
        const k = i * 12;
        if (P[k] !== P[k + 4] || P[k + 1] !== P[k + 5] || P[k + 2] !== P[k + 6] || P[k + 7] !== P[first * 12 + 7]) spheresOnly = false;
      }
      let sphTag = 0;
      if (spheresOnly) {
        sphTag = 1 + ns;
        for (let i = first; i < np; i++, ns++) this.sph.set([P[i * 12], P[i * 12 + 1], P[i * 12 + 2], P[i * 12 + 3]], ns * 4);
      }
      this.objS.set([cx, cy, cz, rad], no * 4);
      this.objR.set([first, np - first, sphTag, P[first * 12 + 7]], no * 4);
      no++;
    };

    for (const d of this.defs) {
      const K = KINDS[d.kind];
      const phase0 = d.phase || 0, lane = d.lane || 1, dir = d.dir || 1;
      if (d.kind === 'fireflies') { this.#fireflies(o, emit); continue; }
      if (d.kind === 'spheres') { this.#spheres(o, emit, d.count, ground); continue; }
      const sc = s0 * K.scale;
      if (d.kind === 'tree') {
        const [px, pz] = d.pos;
        for (const part of tree(this.trees.get(d.seed), t, d.seed)) {
          emit(part, px * this.R, ground, pz * this.R, 0, s0, 'tree', 'matte');
        }
        continue;
      }
      const r = this.R * lane;
      const v = (K.speed * sc) / Math.max(r, 1e-3); // angular speed so feet roughly match the ground
      const th = phase0 + dir * t * v;
      const yaw = Math.atan2(-dir * Math.sin(th), dir * Math.cos(th));
      let y = ground;
      if (d.path === 'fly' || d.path === 'swim') y = this.min.y + d.height * H + 0.04 * H * Math.sin(t * 0.7 + phase0);
      const gait = t * K.cadence * Math.PI * 2 + phase0;
      emit(K.build(gait), Math.cos(th) * r, y, Math.sin(th) * r, yaw, sc, d.kind, d.mat || 'neon');
    }
    this.numObjects = no;
    this.numPrims = np;
    this.primTex.needsUpdate = true;
  }

  #fireflies(o, emit) {
    const [W, H, D] = this.size;
    const cy = this.min.y + 0.5 * H;
    const prims = [];
    const n = Math.min(o.fireflies, this.flies.length);
    const r = 0.012 * this.baseScale * o.scale / 0.92 + 0.002;
    for (let i = 0; i < n; i++) {
      const F = this.flies[i], tt = o.t * o.speed;
      const p = [
        0.42 * W * Math.sin(tt * F.f[0] + F.p[0]) * Math.cos(tt * F.f[1] * 0.7 + F.p[1]),
        cy + 0.32 * H * Math.sin(tt * F.f[1] + F.p[1]),
        0.42 * D * Math.sin(tt * F.f[2] + F.p[2]),
      ];
      for (let k = 0; k < 4 && !isInside(this.shape, { x: p[0], y: p[1], z: p[2] }); k++) {
        p[0] *= 0.6; p[1] = cy + (p[1] - cy) * 0.6; p[2] *= 0.6; // pull towards the middle
      }
      F.glow = 0.12 + Math.pow(Math.max(0, Math.sin(tt * F.blink + F.ph)), 4); // slow, unsynchronised
      prims.push({ a: p, b: p, r, part: 'light', glow: F.glow });
    }
    // one object per quadrant: smaller bounding spheres cull more rays
    for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      emit(prims.filter((q) => Math.sign(q.a[0] || 1) === sx && Math.sign(q.a[2] || 1) === sz), 0, 0, 0, 0, 1, 'firefly', 'neon');
    }
  }

  #spheres(o, emit, count, ground) {
    const [W, H, D] = this.size;
    for (let i = 0; i < Math.min(count, this.spheres.length); i++) {
      const S = this.spheres[i];
      const r = 0.11 * S.r * this.baseScale * o.scale;
      const p = [S.x * W * 0.8, Math.max(ground + r, this.min.y + S.y * H) + 0.03 * H * Math.sin(o.t * o.speed * 0.5 + S.ph), S.z * D * 0.8];
      emit([{ a: p, b: p, r, part: 'body' }], 0, 0, 0, 0, 1, 'spheres', 'chrome');
    }
  }
}
