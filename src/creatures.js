// Procedural creatures and plants built from capsules (no downloaded models).
// Local space: metres at real-life size, y up, facing +z, standing on y = 0.
// Every builder returns [{ a, b, r, part }]: a capsule from a to b with
// radius r (a === b gives a sphere). part 'body' takes the object's material;
// part 'light' is a light by design (tree fairy-lights).

const add = (p, q) => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
// a limb of length len hanging down, swung forward (towards +z) by ang radians
const limb = (len, ang) => [0, -len * Math.cos(ang), len * Math.sin(ang)];
const C = (a, b, r, part = 'body') => ({ a, b, r, part });
const S = (c, r, part = 'body') => ({ a: c, b: c, r, part });

// walking person, ~1.75 m; phase advances 2π per stride pair
export function human(phase) {
  const bob = 0.03 * Math.abs(Math.sin(phase));
  const hip = [0, 0.95 + bob, 0], chest = [0, 1.42 + bob, 0.03], head = [0, 1.66 + bob, 0.04];
  const out = [
    C(hip, chest, 0.12),
    S(head, 0.105),
    C([-0.19, chest[1] - 0.02, 0.03], [0.19, chest[1] - 0.02, 0.03], 0.055), // shoulders
  ];
  for (const side of [-1, 1]) {
    const p = phase + (side > 0 ? 0 : Math.PI);
    const thigh = 0.42 * Math.sin(p);
    const knee = 0.12 + 0.6 * Math.max(0, Math.cos(p)); // knee flexes while the leg swings forward
    const hj = [side * 0.1, hip[1] - 0.03, 0];
    const kn = add(hj, limb(0.45, thigh));
    const an = add(kn, limb(0.43, thigh - knee));
    out.push(C(hj, kn, 0.065), C(kn, an, 0.05), C(an, add(an, [0, -0.03, 0.15]), 0.035));

    const q = phase + (side > 0 ? Math.PI : 0); // arms swing against the legs
    const swing = 0.4 * Math.sin(q), elbow = 0.25 + 0.25 * Math.max(0, Math.sin(q));
    const sh = [side * 0.2, chest[1] - 0.04, 0.03];
    const el = add(sh, limb(0.29, swing));
    out.push(C(sh, el, 0.045), C(el, add(el, limb(0.27, swing + elbow)), 0.038));
  }
  return out;
}

// four-legged walker: a deer (antlers) or, scaled down, a dog
export function quadruped(phase, { antlers = true } = {}) {
  const bob = 0.02 * Math.abs(Math.sin(phase));
  const out = [C([0, 1.02 + bob, -0.42], [0, 1.08 + bob, 0.38], 0.19)];
  const neckTop = [0, 1.5 + bob, 0.62];
  out.push(C([0, 1.12 + bob, 0.42], neckTop, 0.075), C(neckTop, [0, 1.44 + bob, 0.86], 0.065));
  for (const side of [-1, 1]) {
    if (antlers) {
      const base = [side * 0.05, 1.58 + bob, 0.62], tip = [side * 0.2, 1.88 + bob, 0.55];
      out.push(C(base, tip, 0.016), C(lerp(base, tip, 0.55), [side * 0.13, 1.93 + bob, 0.68], 0.013));
    } else {
      out.push(C([side * 0.05, 1.56 + bob, 0.6], [side * 0.09, 1.67 + bob, 0.56], 0.025));
    }
  }
  out.push(C([0, 1.1 + bob, -0.58], [0, 1.0 + bob, -0.68], 0.035)); // tail
  // walk: diagonal legs move together
  for (const [x, z, off] of [[0.11, 0.32, 0], [-0.11, 0.32, Math.PI], [0.11, -0.36, Math.PI], [-0.11, -0.36, 0]]) {
    const p = phase + off;
    const up = 0.35 * Math.sin(p), bend = 0.1 + 0.5 * Math.max(0, Math.cos(p));
    const hj = [x, 0.95 + bob, z];
    const kn = add(hj, limb(0.42, up));
    out.push(C(hj, kn, 0.055), C(kn, add(kn, limb(0.48, up - bend)), 0.035));
  }
  return out;
}

// bird with a 0.7 m wingspan; flap advances 2π per wing beat
export function bird(flap) {
  const a = 0.75 * Math.sin(flap);
  const out = [
    C([0, 0, -0.1], [0, 0.01, 0.1], 0.05),
    S([0, 0.04, 0.14], 0.04),
    C([0, 0.035, 0.17], [0, 0.025, 0.23], 0.012), // beak
    C([0, 0, -0.1], [0, 0.02, -0.22], 0.022),     // tail
  ];
  for (const side of [-1, 1]) {
    const sh = [side * 0.04, 0.02, 0.02];
    const el = add(sh, [side * 0.17 * Math.cos(a), 0.17 * Math.sin(a), -0.02]);
    out.push(C(sh, el, 0.028), C(el, add(el, [side * 0.17 * Math.cos(a * 1.5), 0.17 * Math.sin(a * 1.5), -0.06]), 0.016));
  }
  return out;
}

// fish ~0.45 m long, swimming with a travelling body wave
export function fish(phase) {
  const radii = [0.05, 0.06, 0.05, 0.032, 0.016];
  const pts = radii.map((_, i) => [(0.01 + 0.012 * i) * Math.sin(phase - i * 0.9), 0, 0.16 - i * 0.08]);
  const out = [S(pts[0], radii[0])];
  for (let i = 0; i < 4; i++) out.push(C(pts[i], pts[i + 1], radii[i + 1]));
  const tail = pts[4], flick = 0.02 * Math.sin(phase - 4);
  out.push(C(tail, add(tail, [flick, 0.07, -0.07]), 0.012), C(tail, add(tail, [flick, -0.07, -0.07]), 0.012));
  out.push(C(add(pts[1], [0, 0.05, 0]), add(pts[2], [0, 0.085, -0.03]), 0.01)); // dorsal fin
  return out;
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ~2 m tree: trunk + two levels of three branches, fairy-light clusters at the tips.
// Each part remembers its group (0 = trunk, 1-3 = one main branch and everything
// on it) so the tracer can cull the tree in four smaller pieces.
export function makeTree(seed) {
  const rnd = mulberry32(seed);
  const branches = [], tips = [];
  (function grow(base, dir, len, r, depth, group) {
    const end = add(base, dir.map((d) => d * len));
    branches.push({ a: base, b: end, r, group });
    if (depth === 2) { tips.push({ p: end, group }); return; }
    for (let i = 0; i < 3; i++) {
      const yaw = (i / 3) * Math.PI * 2 + rnd() * 0.8, pitch = 0.45 + rnd() * 0.4;
      const nd = [Math.sin(pitch) * Math.cos(yaw), Math.cos(pitch), Math.sin(pitch) * Math.sin(yaw)];
      grow(end, nd, len * 0.62, r * 0.6, depth + 1, depth === 0 ? i + 1 : group);
    }
  })([0, 0, 0], [0, 1, 0], 1.0, 0.07, 0, 0);
  return { branches, tips };
}

// returns four capsule lists (trunk, then the three main branches with their lights)
export function tree(T, t, phase) {
  const sway = (p) => {
    const k = p[1] * p[1] * 0.04; // bends more higher up
    return [p[0] + k * Math.sin(t * 1.1 + phase), p[1], p[2] + k * Math.cos(t * 0.9 + phase)];
  };
  const groups = [[], [], [], []];
  for (const b of T.branches) groups[b.group].push(C(sway(b.a), sway(b.b), b.r));
  for (const tip of T.tips) {
    const s = sway(tip.p);
    groups[tip.group].push(S(add(s, [0.05, 0.03, 0]), 0.03, 'light'), S(add(s, [-0.04, 0.07, 0.03]), 0.028, 'light'),
                           S(add(s, [0, 0, -0.05]), 0.028, 'light'));
  }
  return groups;
}

export { mulberry32 };
