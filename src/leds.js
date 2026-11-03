// Turns a shape's feature edges into LED strips and packs the per-face and
// per-edge data for the shader (all linear textures, see textures.js):
//   faceTex     2 texels/face  (R, T, R_outer, stripEdgeCount) (listOffset, 0, 0, 0)
//   triListTex  1 texel/BVH triangle (listOffset, count)        – mesh mode only
//   listTex     strip-edge indices, 4 per texel: per face (convex mode) or
//               per triangle (mesh mode: only strips within LIST_RADIUS of it)
//   edgeTex     3 texels/edge  (a.xyz, ledCount) (b.xyz, ledOffset) (row-0 face, other face)
//   ledTex      1 texel/LED    linear RGB, rewritten every frame
import * as THREE from 'three';
import { linearTexture } from './textures.js';

const MAX_LIST = 256;       // must match MAX_FACE_EDGES in the shader
const LIST_RADIUS = 0.025;  // m; ≥ the largest strip width the UI allows

function stripSelected(edge, index, shape, mode) {
  switch (mode) {
    case 'window': return edge.faces.includes(shape.windowFace);
    case 'back': return edge.faces.includes(shape.backFace);
    case 'vertical': return Math.abs(edge.dir.y) > 0.9;
    case 'horizontal': return Math.abs(edge.dir.y) < 0.15;
    case 'alternate': return index % 2 === 0;
    default: return true;
  }
}

// closest distance between segments p1-q1 and p2-q2 (Ericson, RTCD 5.1.9)
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _r = new THREE.Vector3();
const _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();
function segSegDist(p1, q1, p2, q2) {
  _d1.subVectors(q1, p1); _d2.subVectors(q2, p2); _r.subVectors(p1, p2);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  let s, t;
  if (a <= 1e-14 && e <= 1e-14) return p1.distanceTo(p2);
  if (a <= 1e-14) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = _d1.dot(_r);
    if (e <= 1e-14) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = _d1.dot(_d2), den = a * e - b * b;
      s = den > 1e-14 ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  _c1.copy(p1).addScaledVector(_d1, s);
  _c2.copy(p2).addScaledVector(_d2, t);
  return _c1.distanceTo(_c2);
}

// Edge and triangle lie in the same face plane and the edge is on the face
// boundary, so their distance is the closest distance to a triangle side.
const _v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
function edgeTriDist(e, P, t) {
  for (let k = 0; k < 3; k++) _v[k].fromArray(P, t * 9 + k * 3);
  return Math.min(segSegDist(e.a, e.b, _v[0], _v[1]), segSegDist(e.a, e.b, _v[1], _v[2]),
                  segSegDist(e.a, e.b, _v[2], _v[0]));
}

// row2: colours of the second row of a double strip
//   same       – identical to row 1
//   reverse    – the pattern runs the other way along the strips
//   complement – opposite hue of row 1
export function buildLeds(shape, { strips, ledDensity, doubleStrip, row2 }, bvhOrder = null) {
  const { edges, planes } = shape;
  const rows = doubleStrip ? 2 : 1;

  const counts = edges.map((e, i) =>
    stripSelected(e, i, shape, strips) ? Math.max(1, Math.round(e.len * ledDensity)) : 0);
  const totalLen = edges.reduce((s, e, i) => s + (counts[i] ? e.len : 0), 0) || 1;

  // per edge: row 0 LEDs [off, off+n), then row 1 LEDs [off+n, off+2n)
  const leds = [];
  const ledOffset = [];
  let acc = 0;
  edges.forEach((e, ei) => {
    const n = counts[ei];
    ledOffset.push(leds.length);
    const row0 = [];
    for (let row = 0; row < rows; row++) {
      for (let i = 0; i < n; i++) {
        const s = (i + 0.5) / n;
        const u = (acc + s * e.len) / totalLen; // position along all strips, 0..1
        const L = {
          e: ei, i, s, row,
          u: row === 1 && row2 === 'reverse' ? 1 - u : u,
          x: e.a.x + (e.b.x - e.a.x) * s,
          y: e.a.y + (e.b.y - e.a.y) * s,
          z: e.a.z + (e.b.z - e.a.z) * s,
          seed: row === 1 ? row0[i].seed : Math.random(),
          complement: row === 1 && row2 === 'complement',
          texIndex: leds.length * 4,
        };
        if (row === 0) row0.push(L);
        leds.push(L);
      }
    }
    if (n) acc += e.len;
  });

  // edgeTex: 3 texels/edge  (a.xyz, ledCount) (b.xyz, ledOffset) (face of row 0, other face)
  const edgeTex = linearTexture(Math.max(1, edges.length) * 3);
  edges.forEach((e, i) => {
    edgeTex.image.data.set([
      e.a.x, e.a.y, e.a.z, counts[i],
      e.b.x, e.b.y, e.b.z, ledOffset[i],
      e.faces[0], e.faces[1] ?? e.faces[0], 0, 0,
    ], i * 12);
  });

  // strip edges bordering each face
  const faceLists = planes.map(() => []);
  edges.forEach((e, i) => { if (counts[i]) for (const f of e.faces) faceLists[f].push(i); });

  // the lists the shader walks: per face, or per triangle in mesh mode
  let lists = faceLists;
  if (bvhOrder) {
    const P = shape.tris.positions, F = shape.tris.faceIds;
    lists = Array.from(bvhOrder, (t) =>
      faceLists[F[t]].filter((ei) => edgeTriDist(edges[ei], P, t) < LIST_RADIUS));
  }
  let truncated = false;
  lists = lists.map((l) => { if (l.length > MAX_LIST) { truncated = true; return l.slice(0, MAX_LIST); } return l; });
  if (truncated) console.warn(`more than ${MAX_LIST} strip edges near one face/triangle; extras ignored`);

  const totalEntries = lists.reduce((s, l) => s + l.length, 0);
  const listTex = linearTexture(Math.max(1, Math.ceil(totalEntries / 4)));
  const offsets = [];
  let off = 0;
  lists.forEach((list) => {
    offsets.push(off);
    list.forEach((ei, j) => { listTex.image.data[off + j] = ei; });
    off += list.length;
  });

  const faceTex = linearTexture(Math.max(1, planes.length) * 2);
  const triListTex = linearTexture(bvhOrder ? Math.max(1, bvhOrder.length) : 1);
  if (bvhOrder) {
    lists.forEach((l, k) => { triListTex.image.data[k * 4] = offsets[k]; triListTex.image.data[k * 4 + 1] = l.length; });
  } else {
    lists.forEach((l, f) => { faceTex.image.data[f * 8 + 3] = l.length; faceTex.image.data[f * 8 + 4] = offsets[f]; });
  }

  // strip area per metre of strip width (both faces of each edge) – used for the far-field estimate
  const stripLenFaces = edges.reduce((s, e, i) => s + (counts[i] ? e.len * e.faces.length : 0), 0);

  return {
    leds,
    count: leds.length,
    stripLenFaces,
    edgeTex, listTex, faceTex, triListTex,
    ledTex: linearTexture(Math.max(1, leds.length)),
    dispose() {
      for (const t of [this.edgeTex, this.listTex, this.faceTex, this.triListTex, this.ledTex]) t.dispose();
    },
  };
}

const tmp = [0, 0, 0];
const avg = [0, 0, 0];

// 3×3 matrix rotating RGB colours around the grey axis by `a` radians (hue shift)
export function hueMatrix(a) {
  const c = Math.cos(a), s = Math.sin(a) / Math.sqrt(3), k = (1 - c) / 3;
  return [c + k, k - s, k + s, k + s, c + k, k - s, k - s, k + s, c + k];
}

// Writes this frame's colours; returns the average LED colour (for the far-field glow).
// mod (optional, audio): { hue: hueMatrix | null, sparkle: chance per LED per frame }
export function updateLedColors(strip, pattern, t, params, brightness, mod = null) {
  const data = strip.ledTex.image.data;
  const H = mod?.hue, sparkle = mod?.sparkle || 0;
  avg[0] = avg[1] = avg[2] = 0;
  for (const L of strip.leds) {
    pattern(L, t, params, tmp);
    if (L.complement) {
      // rotate hue by 180° keeping saturation/value: c' = max + min − c
      const s = Math.max(tmp[0], tmp[1], tmp[2]) + Math.min(tmp[0], tmp[1], tmp[2]);
      tmp[0] = s - tmp[0]; tmp[1] = s - tmp[1]; tmp[2] = s - tmp[2];
    }
    if (H) {
      const [x, y, z] = tmp;
      tmp[0] = Math.max(0, H[0] * x + H[1] * y + H[2] * z);
      tmp[1] = Math.max(0, H[3] * x + H[4] * y + H[5] * z);
      tmp[2] = Math.max(0, H[6] * x + H[7] * y + H[8] * z);
    }
    if (sparkle && Math.random() < sparkle) tmp[0] = tmp[1] = tmp[2] = 1.2; // single-LED glint
    const r = tmp[0] * brightness, g = tmp[1] * brightness, b = tmp[2] * brightness;
    data[L.texIndex] = r; data[L.texIndex + 1] = g; data[L.texIndex + 2] = b; data[L.texIndex + 3] = 1;
    avg[0] += r; avg[1] += g; avg[2] += b;
  }
  const n = Math.max(1, strip.leds.length);
  avg[0] /= n; avg[1] /= n; avg[2] /= n;
  strip.ledTex.needsUpdate = true;
  return avg;
}
