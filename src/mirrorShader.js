// Full-screen ray tracer for an LED infinity mirror.
//
// Each pixel's ray enters the shape through a (two-way) face, then bounces
// between the inner faces; every bounce multiplies the throughput by that
// face's reflectivity. LED strips sit along feature edges: a ray landing within
// uStripWidth of a strip edge sees the strip and its nearest LED.
//
// Two intersection back-ends, picked per shape:
//   convex (default) – ray vs. a list of planes, very cheap
//   MESH_MODE        – ray vs. triangles through a BVH, for any closed mesh
import * as THREE from 'three';
import { LEAF_SIZE } from './bvh.js';

export const MAX_PLANES = 32;

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
#define MAX_PLANES ${MAX_PLANES}
#define MAX_BOUNCES 256
#define MAX_FACE_EDGES 256
#define LEAF_SIZE ${LEAF_SIZE}

uniform vec3 uCamPos;
uniform mat4 uCamWorld;
uniform mat4 uProjInv;
uniform bool uInside;

uniform int uNumPlanes;
uniform vec4 uPlanes[MAX_PLANES];   // convex mode: xyz = outward normal, w = d
uniform sampler2D uTriTex;          // mesh mode
uniform sampler2D uTriListTex;      // mesh mode: per-triangle strip lists
uniform sampler2D uBvhTex;          // mesh mode

uniform sampler2D uFaceTex;
uniform sampler2D uListTex;
uniform sampler2D uEdgeTex;
uniform sampler2D uLedTex;

uniform float uStripWidth;
uniform bool uDoubleStrip;
uniform float uRowGap;
uniform float uStagger;             // 0 or 0.5
uniform float uLedRadius;
uniform float uLedIntensity;
uniform float uStripGlow;
uniform int uMaxBounces;
uniform vec3 uTint;
uniform float uPixelAngle;
uniform float uEnv;
uniform float uEps;
uniform vec3 uTail;

varying vec2 vUv;

vec4 tx(sampler2D t, int i) { return texelFetch(t, ivec2(i & 1023, i >> 10), 0); }

// Dim room around the mirror; the brighter it is, the weaker the effect.
vec3 envColor(vec3 d) {
  float h = d.y * 0.5 + 0.5;
  vec3 c = mix(vec3(0.010, 0.010, 0.013), vec3(0.055, 0.057, 0.066), smoothstep(0.0, 1.0, h));
  c += vec3(1.0, 0.94, 0.86) * pow(max(d.y, 0.0), 28.0) * 0.8;  // ceiling light
  return c * uEnv;
}

// Strip coverage (alpha) and emitted light at point q on face f.
// fp = pixel footprint at this path length (ray-cone anti-aliasing).
// k0 = list key: the face (convex mode) or the BVH triangle (mesh mode).
// Double strip: the strip wraps the edge with one LED row on each adjacent
// face, uRowGap apart; row 0 is on the edge's first face.
void stripAt(vec3 q, int f, int k0, float fp, out float alpha, out vec3 emis) {
  alpha = 0.0;
  emis = vec3(0.0);
#ifdef MESH_MODE
  vec4 L = tx(uTriListTex, k0);
  int off = int(L.x + 0.5), cnt = int(L.y + 0.5);
#else
  int cnt = int(tx(uFaceTex, 2 * k0).w + 0.5);
  int off = int(tx(uFaceTex, 2 * k0 + 1).x + 0.5);
#endif
  if (cnt == 0) return;

  float best = 1e9, bs = 0.0, bc = 0.0, bo = 0.0;
  int be = 0;
  vec3 ba = vec3(0.0), bb = vec3(0.0);
  for (int j = 0; j < MAX_FACE_EDGES; j++) {
    if (j >= cnt) break;
    int k = off + j;
    int e = int(tx(uListTex, k >> 2)[k & 3] + 0.5);
    vec4 A = tx(uEdgeTex, 3 * e);
    vec4 B = tx(uEdgeTex, 3 * e + 1);
    vec3 ab = B.xyz - A.xyz;
    float s = clamp(dot(q - A.xyz, ab) / dot(ab, ab), 0.0, 1.0);
    float d = length(q - (A.xyz + s * ab));
    if (d < best) { best = d; be = e; bs = s; ba = A.xyz; bb = B.xyz; bc = A.w; bo = B.w; }
  }

  alpha = 1.0 - smoothstep(uStripWidth - fp, uStripWidth + fp, best);
  if (alpha <= 0.0) return;

  // which LED row this face carries, and where that row sits
  int row = 0;
  vec3 rowOffset = vec3(0.0);
  float shift = 0.0;
  if (uDoubleStrip) {
    vec3 perp = q - mix(ba, bb, bs);               // from the edge into face f
    float pl = length(perp);
    rowOffset = (pl > 1e-7 ? perp / pl : vec3(0.0)) * (0.5 * uRowGap);
    row = f == int(tx(uEdgeTex, 3 * be + 2).x + 0.5) ? 0 : 1;
    shift = uStagger * float(row);                 // half-pitch offset for row 1
  }

  // nearest LED in that row
  float fi = clamp(floor(bs * bc - shift), 0.0, bc - 1.0);
  vec3 pc = mix(ba, bb, (fi + 0.5 + shift) / bc) + rowOffset;
  float dl = length(q - pc);
  vec3 led = tx(uLedTex, int(bo + 0.5) + row * int(bc + 0.5) + int(fi)).rgb;

  float r = uLedRadius;
  float cov = 1.0 - smoothstep(max(r - fp, 0.0), r + fp, dl);
  float energy = (r * r) / (r * r + fp * fp); // keep total light when the LED shrinks below a pixel
  emis = led * (uLedIntensity * cov * energy + uStripGlow) + vec3(0.004);
}

#ifndef MESH_MODE
// ---------------- convex polyhedron: planes only ----------------
bool enterShape(vec3 ro, vec3 rd, out float t, out vec3 n, out int f, out int k) {
  float tN = -1e20, tF = 1e20;
  int fN = -1;
  for (int i = 0; i < MAX_PLANES; i++) {
    if (i >= uNumPlanes) break;
    vec4 P = uPlanes[i];
    float den = dot(P.xyz, rd);
    float num = P.w - dot(P.xyz, ro);
    if (abs(den) < 1e-9) { if (num < 0.0) tF = -1.0; continue; }
    float ti = num / den;
    if (den < 0.0) { if (ti > tN) { tN = ti; fN = i; } }
    else tF = min(tF, ti);
  }
  if (fN < 0 || tN > tF || tF < 0.0) return false;
  t = tN; f = fN; k = fN; n = uPlanes[fN].xyz;
  return true;
}

bool nextHit(vec3 p, vec3 rd, int face, out float t, out vec3 n, out int f, out int k) {
  t = 1e20; f = -1;
  for (int i = 0; i < MAX_PLANES; i++) {
    if (i >= uNumPlanes) break;
    if (i == face) continue;
    vec4 P = uPlanes[i];
    float den = dot(P.xyz, rd);
    if (den <= 1e-7) continue;
    float ti = max((P.w - dot(P.xyz, p)) / den, 0.0);
    if (ti < t) { t = ti; f = i; }
  }
  if (f < 0) return false;
  k = f;
  n = uPlanes[f].xyz;
  return true;
}

#else
// ---------------- any closed mesh: BVH over triangles ----------------
// Closest hit. (Near-first ordered traversal was measured slower here: the
// extra child-box fetches cost more than the culling saves on small BVHs.)
bool traceMesh(vec3 ro, vec3 rd, out float tHit, out int tri) {
  vec3 srd = mix(rd, vec3(1e-9), lessThan(abs(rd), vec3(1e-9)));
  vec3 inv = 1.0 / srd;
  int stack[32];
  int sp = 0;
  stack[sp++] = 0;
  tHit = 1e20;
  tri = -1;
  for (int it = 0; it < 2048; it++) {
    if (sp == 0) break;
    int ni = stack[--sp];
    vec4 A = tx(uBvhTex, 2 * ni);
    vec4 B = tx(uBvhTex, 2 * ni + 1);
    vec3 t0 = (A.xyz - ro) * inv, t1 = (B.xyz - ro) * inv;
    vec3 tmn = min(t0, t1), tmx = max(t0, t1);
    float tn = max(max(tmn.x, tmn.y), tmn.z);
    float tf = min(min(tmx.x, tmx.y), tmx.z);
    if (tf < max(tn, 0.0) || tn > tHit) continue;
    int count = int(B.w + 0.5);
    int idx = int(A.w + 0.5);
    if (count == 0) {
      if (sp < 31) {
        stack[sp++] = idx;     // right
        stack[sp++] = ni + 1;  // left (popped first)
      }
    } else {
      for (int k = 0; k < LEAF_SIZE; k++) {
        if (k >= count) break;
        int ti = idx + k;
        vec3 v0 = tx(uTriTex, 3 * ti).xyz;
        vec3 e1 = tx(uTriTex, 3 * ti + 1).xyz;
        vec3 e2 = tx(uTriTex, 3 * ti + 2).xyz;
        vec3 pv = cross(rd, e2);
        float det = dot(e1, pv);
        if (abs(det) < 1e-14) continue;
        float id = 1.0 / det;
        vec3 tv = ro - v0;
        float u = dot(tv, pv) * id;
        if (u < 0.0 || u > 1.0) continue;
        vec3 qv = cross(tv, e1);
        float v = dot(rd, qv) * id;
        if (v < 0.0 || u + v > 1.0) continue;
        float t = dot(e2, qv) * id;
        if (t > uEps * 0.1 && t < tHit) { tHit = t; tri = ti; }
      }
    }
  }
  return tri >= 0;
}

bool hitMesh(vec3 ro, vec3 rd, out float t, out vec3 n, out int f, out int k) {
  if (!traceMesh(ro, rd, t, k)) return false;
  vec4 V0 = tx(uTriTex, 3 * k);
  n = normalize(cross(tx(uTriTex, 3 * k + 1).xyz, tx(uTriTex, 3 * k + 2).xyz));
  f = int(V0.w + 0.5);
  return true;
}

bool enterShape(vec3 ro, vec3 rd, out float t, out vec3 n, out int f, out int k) { return hitMesh(ro, rd, t, n, f, k); }
bool nextHit(vec3 p, vec3 rd, int face, out float t, out vec3 n, out int f, out int k) { return hitMesh(p, rd, t, n, f, k); }
#endif

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 v = uProjInv * vec4(ndc, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec3 p = uCamPos;

  vec3 col = vec3(0.0);
  vec3 thr = vec3(1.0);
  float travelled = 0.0;
  int face = -1;
  float t; vec3 n; int f, k;
  float a; vec3 em;

  if (!uInside) {
    if (!enterShape(p, rd, t, n, f, k)) {
      gl_FragColor = vec4(envColor(rd), 1.0);
      return;
    }
    p += rd * t;
    travelled = t;
    face = f;
    vec4 props = tx(uFaceTex, 2 * f);
    col += envColor(reflect(rd, n)) * props.z;  // room reflected on the glass
    stripAt(p, f, k, travelled * uPixelAngle, a, em);
    col += a * vec3(0.002);                     // back side of the strip
    thr *= props.y * (1.0 - a);                 // light that makes it through the glass
    p -= n * uEps;
  }

  bool reachedLimit = true;
  for (int b = 0; b < MAX_BOUNCES; b++) {
    if (b >= uMaxBounces) break;
    if (max(thr.r, max(thr.g, thr.b)) < 0.0015) { reachedLimit = false; break; }
    if (!nextHit(p, rd, face, t, n, f, k)) {     // escaped (open mesh)
      col += thr * envColor(rd);
      reachedLimit = false;
      break;
    }
    p += rd * t;
    travelled += t;
    face = f;

    stripAt(p, f, k, travelled * uPixelAngle, a, em);
    col += thr * a * em;
    thr *= 1.0 - a;

    vec4 props = tx(uFaceTex, 2 * f);
    col += thr * props.y * envColor(rd);        // room seen through two-way glass
    rd = reflect(rd, n);
    thr *= props.x * uTint;
    p -= n * uEps;
  }

  // Far field: light from the bounces we did not trace (estimated on the CPU).
  if (reachedLimit) col += thr * uTail;

  gl_FragColor = vec4(col, 1.0);
}
`;

export function createMirrorMaterial() {
  return new THREE.ShaderMaterial({
    defines: {},
    uniforms: {
      uCamPos: { value: new THREE.Vector3() },
      uCamWorld: { value: new THREE.Matrix4() },
      uProjInv: { value: new THREE.Matrix4() },
      uInside: { value: false },
      uNumPlanes: { value: 0 },
      uPlanes: { value: Array.from({ length: MAX_PLANES }, () => new THREE.Vector4()) },
      uTriTex: { value: null },
      uTriListTex: { value: null },
      uBvhTex: { value: null },
      uFaceTex: { value: null },
      uListTex: { value: null },
      uEdgeTex: { value: null },
      uLedTex: { value: null },
      uStripWidth: { value: 0.005 },
      uDoubleStrip: { value: false },
      uRowGap: { value: 0.008 },
      uStagger: { value: 0 },
      uLedRadius: { value: 0.0025 },
      uLedIntensity: { value: 8 },
      uStripGlow: { value: 0.08 },
      uMaxBounces: { value: 48 },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uPixelAngle: { value: 0.001 },
      uEnv: { value: 0.3 },
      uEps: { value: 1e-5 },
      uTail: { value: new THREE.Vector3() },
    },
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
}
