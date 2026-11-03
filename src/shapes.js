// Shape library and mesh analysis.
//
// Every shape is a closed triangle mesh. analyzeShape() turns it into:
//   planes  – planar faces (coplanar connected triangles merged), outward n·x = d
//   edges   – feature edges (where faces meet at > edgeAngle) that can carry LED strips
//   tris    – triangles with their face id (for the BVH tracer)
//   convex  – true when the fast plane-based tracer can be used
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- outlines
// 2D outlines live in a unit box centred on the origin ([-0.5, 0.5]).

export function fitOutline(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const s = 1 / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1e-9);
  return pts.map(([x, y]) => [(x - cx) * s, (y - cy) * s]);
}

export function starOutline(points = 5, inner = 0.382) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : 1;
    const a = Math.PI / 2 + (i * Math.PI) / points;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return fitOutline(pts);
}

export function heartOutline(n = 44) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([16 * Math.sin(t) ** 3, 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)]);
  }
  return fitOutline(pts);
}

export function polygonOutline(n = 6) {
  return fitOutline(Array.from({ length: n }, (_, i) => {
    const a = Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [Math.cos(a), Math.sin(a)];
  }));
}

export function crossOutline(arm = 0.34) {
  const a = arm / 2, b = 0.5;
  return [[-a, b], [-a, a], [-b, a], [-b, -a], [-a, -a], [-a, -b], [a, -b], [a, -a], [b, -a], [b, a], [a, a], [a, b]];
}

export function extrudeOutline(points, scale, depth) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x * scale, y * scale)));
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1, steps: 1 });
}

// ---------------------------------------------------------------- solids

function permutations(base) {
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const seen = new Set();
  const out = [];
  for (const o of orders) {
    for (let signs = 0; signs < 8; signs++) {
      const v = o.map((k, i) => ((signs >> i) & 1 ? -base[k] : base[k]));
      const key = v.join(',');
      if (!seen.has(key)) { seen.add(key); out.push(new THREE.Vector3(...v)); }
    }
  }
  return out;
}

// Put a pyramid on every face of a convex polyhedron.
// height = factor × edge length (√(2/3) on an octahedron gives the stella octangula,
// 1.3764 on a dodecahedron gives the small stellated dodecahedron).
function stellate(base, factor) {
  const g = base.index ? base.toNonIndexed() : base;
  const pos = g.attributes.position;
  const groups = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const d = n.dot(a);
    let G = groups.find((q) => q.n.dot(n) > 0.9999 && Math.abs(q.d - d) < 1e-4);
    if (!G) groups.push((G = { n, d, verts: [] }));
    for (const v of [a, b, c]) if (!G.verts.some((w) => w.distanceTo(v) < 1e-6)) G.verts.push(v.clone());
  }
  const out = [];
  for (const { n, verts } of groups) {
    const cen = verts.reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(verts.length);
    const u = verts[0].clone().sub(cen).normalize();
    const w = n.clone().cross(u);
    verts.sort((p, q) => Math.atan2(p.clone().sub(cen).dot(w), p.clone().sub(cen).dot(u)) -
                         Math.atan2(q.clone().sub(cen).dot(w), q.clone().sub(cen).dot(u)));
    const apex = cen.clone().addScaledVector(n, factor * verts[0].distanceTo(verts[1]));
    for (let i = 0; i < verts.length; i++) {
      const p = verts[i], q = verts[(i + 1) % verts.length];
      out.push(p.x, p.y, p.z, q.x, q.y, q.z, apex.x, apex.y, apex.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return geo;
}

// "∞" – a tube along a lemniscate, lifted at the crossing so it never self-intersects.
class Lemniscate extends THREE.Curve {
  getPoint(t, target = new THREE.Vector3()) {
    const s = t * Math.PI * 2, d = 1 + Math.sin(s) ** 2;
    return target.set((0.5 * Math.cos(s)) / d, (0.5 * Math.sin(s) * Math.cos(s)) / d, 0.12 * Math.sin(s));
  }
}

const prism = (n) => () => new THREE.CylinderGeometry(0.5, 0.5, 1, n, 1);

// faceMode: cube = all two-way, box = window + mirrors, panel = window + back + black, room = all mirrors
// strips:   which edges get LED strips by default
// fixed:    built in metres from (size, depth); otherwise rescaled to `size`
// view / inside: default camera; bounces / edgeAngle: per-shape defaults
// faceMode / strips may be functions of the custom-shape context.
export const SHAPES = {
  'Infinity cube': { make: () => new THREE.BoxGeometry(1, 1, 1), faceMode: 'cube', strips: 'all' },
  'Round panel (classic)': {
    make: (s, d) => new THREE.CylinderGeometry(s / 2, s / 2, d, 24, 1).rotateX(Math.PI / 2),
    fixed: true, faceMode: 'panel', strips: 'window', view: [0.25, 0.15, 1],
  },
  'Square panel (classic)': {
    make: (s, d) => new THREE.BoxGeometry(s, s, d),
    fixed: true, faceMode: 'panel', strips: 'window', view: [0.25, 0.15, 1],
  },
  'Star panel (classic)': {
    make: (s, d) => extrudeOutline(starOutline(5), s, d),
    fixed: true, faceMode: 'panel', strips: 'window', view: [0.25, 0.15, 1],
  },
  'Heart panel (classic)': {
    make: (s, d) => extrudeOutline(heartOutline(), s, d),
    fixed: true, faceMode: 'panel', strips: 'window', view: [0.25, 0.15, 1],
  },
  'Triangular prism': { make: prism(3), faceMode: 'cube', strips: 'all' },
  'Hexagonal prism': { make: prism(6), faceMode: 'cube', strips: 'all' },
  'Star prism 3D': {
    make: (s) => extrudeOutline(starOutline(5), s, s * 0.35),
    fixed: true, faceMode: 'cube', strips: 'all',
  },
  'Octagonal tunnel': {
    make: (s) => new THREE.CylinderGeometry(s / 2, s / 2, s * 1.6, 8, 1).rotateX(Math.PI / 2),
    fixed: true, faceMode: 'box', strips: 'window', view: [0.1, 0.08, 1],
  },
  'Square pyramid': { make: () => new THREE.ConeGeometry(0.6, 0.85, 4, 1), faceMode: 'cube', strips: 'all' },
  'Tetrahedron': { make: () => new THREE.TetrahedronGeometry(1), faceMode: 'cube', strips: 'all' },
  'Octahedron': { make: () => new THREE.OctahedronGeometry(1), faceMode: 'cube', strips: 'all' },
  'Dodecahedron': { make: () => new THREE.DodecahedronGeometry(1), faceMode: 'cube', strips: 'all' },
  'Icosahedron': { make: () => new THREE.IcosahedronGeometry(1), faceMode: 'cube', strips: 'all' },
  'Cuboctahedron': { make: () => new ConvexGeometry(permutations([1, 1, 0])), faceMode: 'cube', strips: 'all' },
  'Truncated octahedron': { make: () => new ConvexGeometry(permutations([0, 1, 2])), faceMode: 'cube', strips: 'all' },
  'Rhombic dodecahedron': {
    make: () => new ConvexGeometry([...permutations([1, 1, 1]), ...permutations([2, 0, 0])]),
    faceMode: 'cube', strips: 'all',
  },
  'Star tetrahedron': {
    make: () => stellate(new THREE.OctahedronGeometry(1), Math.sqrt(2 / 3)),
    faceMode: 'cube', strips: 'all',
  },
  'Small stellated dodecahedron': {
    make: () => stellate(new THREE.DodecahedronGeometry(1), 1.3764),
    faceMode: 'cube', strips: 'all',
  },
  'Spiky icosahedron': {
    make: () => stellate(new THREE.IcosahedronGeometry(1), 1.0),
    faceMode: 'cube', strips: 'all',
  },
  'Torus': {
    make: () => new THREE.TorusGeometry(0.35, 0.15, 6, 12),
    faceMode: 'cube', strips: 'all',
  },
  'Infinity ∞ tube': {
    make: () => new THREE.TubeGeometry(new Lemniscate(), 96, 0.07, 6, true),
    faceMode: 'cube', strips: 'all', edgeAngle: 30, view: [0.15, 0.35, 1],
  },
  'Mirror room (walk-in)': {
    make: () => new THREE.BoxGeometry(3, 2.4, 3),
    fixed: true, faceMode: 'room', strips: 'all', inside: true, bounces: 28,
  },
  'Custom outline (editor)': {
    make: (s, d, c) => extrudeOutline(c.outline, s, c.mode === 'panel' ? d : s * c.thickness),
    fixed: true,
    faceMode: (c) => (c.mode === 'panel' ? 'panel' : 'cube'),
    strips: (c) => (c.mode === 'panel' ? 'window' : 'all'),
    view: [0.25, 0.15, 1],
  },
  'Imported model': {
    make: (s, d, c) => c.imported.clone(),
    faceMode: 'cube', strips: 'all',
  },
};

// ---------------------------------------------------------------- analysis

export function analyzeShape(raw, { fixed, size, edgeAngle = 20 }) {
  const src = raw.index ? raw.toNonIndexed() : raw;
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', src.attributes.position.clone());
  g.computeBoundingBox();
  const center = g.boundingBox.getCenter(new THREE.Vector3());
  g.translate(-center.x, -center.y, -center.z);
  if (!fixed) {
    const ext = g.boundingBox.getSize(new THREE.Vector3());
    const s = size / Math.max(ext.x, ext.y, ext.z);
    g.scale(s, s, s);
  }
  g = mergeVertices(g, 1e-6);

  const P = g.attributes.position.array;
  const nv = P.length / 3;
  const V = (i) => new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  let radius = 0;
  for (let i = 0; i < nv; i++) radius = Math.max(radius, Math.hypot(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]));

  // triangles (degenerates dropped), oriented so normals point outward
  const idx = g.index.array;
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  let tris = [];
  let volume = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const A = V(idx[t]), B = V(idx[t + 1]), C = V(idx[t + 2]);
    const cr = ab.subVectors(B, A).cross(ac.subVectors(C, A));
    if (cr.length() < 1e-12) continue;
    tris.push([idx[t], idx[t + 1], idx[t + 2]]);
    volume += A.dot(B.clone().cross(C));
  }
  if (volume < 0) tris = tris.map(([a, b, c]) => [a, c, b]);
  const T = tris.length;

  const nrm = [], dval = new Float64Array(T), area = new Float64Array(T);
  tris.forEach(([a, b, c], t) => {
    const A = V(a);
    const cr = ab.subVectors(V(b), A).cross(ac.subVectors(V(c), A));
    area[t] = cr.length() / 2;
    nrm.push(cr.clone().normalize());
    dval[t] = nrm[t].dot(A);
  });

  // edge → triangles
  const edgeMap = new Map();
  tris.forEach((tri, t) => {
    for (let k = 0; k < 3; k++) {
      const u = tri[k], v = tri[(k + 1) % 3];
      const key = u < v ? u * nv + v : v * nv + u;
      let e = edgeMap.get(key);
      if (!e) edgeMap.set(key, (e = { u: Math.min(u, v), v: Math.max(u, v), tris: [] }));
      e.tris.push(t);
    }
  });

  // planar faces = connected coplanar triangles (union-find)
  const parent = Int32Array.from({ length: T }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const tol = 1e-5 * Math.max(radius, 1e-3);
  for (const e of edgeMap.values()) {
    if (e.tris.length !== 2) continue;
    const [i, j] = e.tris;
    if (nrm[i].dot(nrm[j]) > 1 - 1e-6 && Math.abs(dval[i] - dval[j]) < tol) parent[find(i)] = find(j);
  }
  const faceOf = new Int32Array(T);
  const planes = [];
  const rootFace = new Map();
  for (let t = 0; t < T; t++) {
    const r = find(t);
    let f = rootFace.get(r);
    if (f === undefined) {
      f = planes.length;
      rootFace.set(r, f);
      planes.push({ n: nrm[r].clone(), d: dval[r], area: 0 });
    }
    faceOf[t] = f;
    planes[f].area += area[t];
  }
  const totalArea = planes.reduce((s, p) => s + p.area, 0);

  // feature edges = where LED strips can go
  const cosT = Math.cos(THREE.MathUtils.degToRad(edgeAngle));
  const edges = [];
  let closed = true;
  for (const e of edgeMap.values()) {
    let feature = false;
    if (e.tris.length !== 2) { feature = true; closed = false; }
    else {
      const [i, j] = e.tris;
      feature = faceOf[i] !== faceOf[j] && nrm[i].dot(nrm[j]) < cosT;
    }
    if (!feature) continue;
    const A = V(e.u), B = V(e.v);
    edges.push({
      a: A, b: B, len: A.distanceTo(B), dir: B.clone().sub(A).normalize(),
      faces: [...new Set(e.tris.map((t) => faceOf[t]))],
    });
  }

  // convex ⇔ closed and every vertex is behind every face plane
  let convex = closed && planes.length <= 64;
  for (const p of planes) {
    if (!convex) break;
    for (let i = 0; i < nv; i++) {
      if (p.n.x * P[i * 3] + p.n.y * P[i * 3 + 1] + p.n.z * P[i * 3 + 2] - p.d > tol * 10) { convex = false; break; }
    }
  }

  let windowFace = 0, backFace = 0;
  planes.forEach((p, k) => {
    const w = planes[windowFace], b = planes[backFace];
    if (p.n.z > w.n.z + 1e-6 || (Math.abs(p.n.z - w.n.z) <= 1e-6 && p.area > w.area)) windowFace = k;
    if (p.n.z < b.n.z - 1e-6 || (Math.abs(p.n.z - b.n.z) <= 1e-6 && p.area > b.area)) backFace = k;
  });

  const positions = new Float32Array(T * 9);
  tris.forEach((tri, t) => tri.forEach((vi, k) => positions.set([P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]], t * 9 + k * 3)));
  g.dispose();

  return {
    planes, edges, convex, closed, windowFace, backFace, radius, totalArea,
    tris: { positions, faceIds: faceOf, count: T },
  };
}

// ---------------------------------------------------------------- CPU ray queries

// Möller–Trumbore; returns t or -1
function rayTri(o, d, P, k) {
  const v0x = P[k], v0y = P[k + 1], v0z = P[k + 2];
  const e1x = P[k + 3] - v0x, e1y = P[k + 4] - v0y, e1z = P[k + 5] - v0z;
  const e2x = P[k + 6] - v0x, e2y = P[k + 7] - v0y, e2z = P[k + 8] - v0z;
  const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return -1;
  const inv = 1 / det;
  const tx = o.x - v0x, ty = o.y - v0y, tz = o.z - v0z;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

const PARITY_DIR = new THREE.Vector3(0.4472, 0.5345, 0.7171).normalize();

export function isInside(shape, c) {
  if (shape.convex) return shape.planes.every((p) => p.n.dot(c) - p.d < 0);
  const P = shape.tris.positions;
  let hits = 0;
  for (let k = 0; k < P.length; k += 9) if (rayTri(c, PARITY_DIR, P, k) > 0) hits++;
  return hits % 2 === 1;
}

// A point well inside the mesh: step inward from the largest triangle to the
// middle of the solid behind it. `half` is the local half-thickness.
export function interiorPoint(shape) {
  const P = shape.tris.positions;
  let best = 0, bestArea = -1;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let k = 0; k < P.length; k += 9) {
    a.fromArray(P, k); b.fromArray(P, k + 3); c.fromArray(P, k + 6);
    const ar = b.clone().sub(a).cross(c.clone().sub(a)).length();
    if (ar > bestArea) { bestArea = ar; best = k; }
  }
  a.fromArray(P, best); b.fromArray(P, best + 3); c.fromArray(P, best + 6);
  const cen = a.clone().add(b).add(c).divideScalar(3);
  const inward = b.clone().sub(a).cross(c.clone().sub(a)).normalize().negate();
  const o = cen.clone().addScaledVector(inward, shape.radius * 1e-4);
  let t = Infinity;
  for (let k = 0; k < P.length; k += 9) {
    const h = rayTri(o, inward, P, k);
    if (h > 1e-9 && h < t) t = h;
  }
  if (!isFinite(t)) t = shape.radius * 0.1;
  return { point: o.addScaledVector(inward, t / 2), half: t / 2 };
}
