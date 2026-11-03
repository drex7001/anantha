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
uniform float uTime;

// objects inside the mirror (inside.js)
uniform int uNumObjects;
uniform int uObjDepth;              // trace objects for this many bounces
uniform vec4 uObjS[32];             // bounding sphere (centre, radius)
uniform vec4 uObjR[32];             // (firstPrim, primCount, 0 or 1 + first sphere in uSph, material)
uniform vec4 uSph[96];              // spheres of spheres-only objects (centre, radius)

// downloaded models (models.js): per-instance BVH in local space
uniform int uNumModels;
uniform sampler2D uMTriTex;         // 3 texels/tri: (v0, packed colour) (e1) (e2)
uniform sampler2D uMNodeTex;        // 2 texels/node: (min, a) (max, count)
uniform vec4 uMA[16];               // (position, scale)
uniform vec4 uMB[16];               // (cos yaw, sin yaw, node offset, tri offset)
uniform vec4 uMC[16];               // world bounding sphere
uniform vec4 uMD[16];               // (material, neon colour from pattern?, 0, 0)
uniform vec4 uME[16];               // neon colour when following the pattern
uniform float uObjLight;            // how strongly the LEDs light matte objects
uniform sampler2D uPrimTex;         // 3 texels/capsule: (a, r) (b, material) (colour, 0)
uniform float uNeonIntensity;
uniform float uNeonDots;            // LED spacing along neon tubes (m); 0 = continuous tube
uniform vec3 uAmbient;              // mean light inside the mirror (lights matte objects)

// water floor
uniform bool uWater;
uniform float uWaterY;
uniform float uWaterMin;            // reflectance looking straight down
uniform float uWaterAmp;            // ripple slope
uniform float uWaterFreq;           // ripples per metre

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

// ---------------- objects: capsules (spheres when a == b) ----------------
// ray / capsule (Inigo Quilez); returns t or -1
float capsuleHit(vec3 ro, vec3 rd, vec3 pa, vec3 pb, float r) {
  vec3 ba = pb - pa, oa = ro - pa;
  float baba = dot(ba, ba), bard = dot(ba, rd), baoa = dot(ba, oa);
  float rdoa = dot(rd, oa), oaoa = dot(oa, oa);
  float a = baba - bard * bard;
  if (a > 1e-12) {
    float b = baba * rdoa - baoa * bard;
    float c = baba * oaoa - baoa * baoa - r * r * baba;
    float h = b * b - a * c;
    if (h < 0.0) return -1.0;
    float t = (-b - sqrt(h)) / a;
    float y = baoa + t * bard;
    if (y > 0.0 && y < baba) return t;          // body
    vec3 oc = y <= 0.0 ? oa : ro - pb;          // end caps
    float b2 = dot(rd, oc), c2 = dot(oc, oc) - r * r, h2 = b2 * b2 - c2;
    return h2 > 0.0 ? -b2 - sqrt(h2) : -1.0;
  }
  // ray parallel to the axis (or a sphere): test both end spheres
  float best = -1.0;
  for (int i = 0; i < 2; i++) {
    vec3 oc = i == 0 ? oa : ro - pb;
    float b2 = dot(rd, oc), h2 = b2 * b2 - dot(oc, oc) + r * r;
    if (h2 > 0.0) { float t = -b2 - sqrt(h2); if (t > 0.0 && (best < 0.0 || t < best)) best = t; }
  }
  return best;
}

// nearest capsule closer than tMax; neon tubes get a pixel-footprint margin (fp)
int traceObjects(vec3 ro, vec3 rd, float tMax, float fp, out float tHit) {
  tHit = tMax;
  int hit = -1;
  for (int o = 0; o < 32; o++) {
    if (o >= uNumObjects) break;
    vec4 S = uObjS[o];
    vec3 oc = ro - S.xyz;
    float b = dot(oc, rd), rr = S.w + fp, h = b * b - dot(oc, oc) + rr * rr;
    if (h < 0.0) continue;
    h = sqrt(h);
    if (-b - h > tHit || -b + h < 0.0) continue;  // bounding sphere missed
    vec4 R = uObjR[o];
    int first = int(R.x + 0.5), cnt = int(R.y + 0.5);
    if (R.z > 0.5) {
      // spheres only (fireflies, chrome balls): uniform data and a ray/sphere test each
      int s0 = int(R.z - 0.5);
      float grow = R.w < 0.5 ? 0.5 * fp : 0.0; // neon spheres get the footprint margin
      for (int i = 0; i < 96; i++) {
        if (i >= cnt) break;
        int pi = first + i;
        vec4 A = uSph[s0 + i];
        vec3 q = ro - A.xyz;
        float r = A.w + grow, b2 = dot(q, rd), h2 = b2 * b2 - dot(q, q) + r * r;
        if (h2 <= 0.0) continue;
        float t = -b2 - sqrt(h2);
        if (t > uEps * 0.1 && t < tHit) { tHit = t; hit = pi; }
      }
      continue;
    }
    for (int i = 0; i < 256; i++) {
      if (i >= cnt) break;
      int pi = first + i;
      vec4 A = tx(uPrimTex, 3 * pi), B = tx(uPrimTex, 3 * pi + 1);
      float r = A.w + (B.w < 0.5 ? 0.5 * fp : 0.0);
      // cheap reject: the capsule's own bounding sphere
      vec3 q = ro - 0.5 * (A.xyz + B.xyz);
      float br = 0.5 * length(B.xyz - A.xyz) + r, qb = dot(q, rd);
      float qh = qb * qb - dot(q, q) + br * br;
      if (qh < 0.0 || -qb - sqrt(qh) > tHit) continue;
      float t = capsuleHit(ro, rd, A.xyz, B.xyz, r);
      if (t > uEps * 0.1 && t < tHit) { tHit = t; hit = pi; }
    }
  }
  return hit;
}

// ---------------- downloaded models ----------------
// Nearest model triangle closer than tHit. The ray is moved into each
// instance's local space (inverse yaw + scale, direction not renormalised so t
// stays the same), then that instance's BVH is walked.
bool traceModels(vec3 ro, vec3 rd, inout float tHit, out int model, out int tri) {
  model = -1;
  tri = -1;
  for (int m = 0; m < 16; m++) {
    if (m >= uNumModels) break;
    vec4 C = uMC[m];
    vec3 oc = ro - C.xyz;
    float b = dot(oc, rd), h = b * b - dot(oc, oc) + C.w * C.w;
    if (h < 0.0) continue;
    h = sqrt(h);
    if (-b - h > tHit || -b + h < 0.0) continue;  // bounding sphere missed

    vec4 A = uMA[m], B = uMB[m];
    vec3 o = ro - A.xyz;
    float is = 1.0 / A.w;
    vec3 lo = vec3(o.x * B.x - o.z * B.y, o.y, o.x * B.y + o.z * B.x) * is;
    vec3 ld = vec3(rd.x * B.x - rd.z * B.y, rd.y, rd.x * B.y + rd.z * B.x) * is;
    int nodeOff = int(B.z + 0.5), triOff = int(B.w + 0.5);

    vec3 inv = 1.0 / mix(ld, vec3(1e-9), lessThan(abs(ld), vec3(1e-9)));
    int stack[32];
    int sp = 0;
    stack[sp++] = 0;
    for (int it = 0; it < 1024; it++) {
      if (sp == 0) break;
      int ni = nodeOff + stack[--sp];
      vec4 N0 = tx(uMNodeTex, 2 * ni), N1 = tx(uMNodeTex, 2 * ni + 1);
      vec3 t0 = (N0.xyz - lo) * inv, t1 = (N1.xyz - lo) * inv;
      vec3 tmn = min(t0, t1), tmx = max(t0, t1);
      float tn = max(max(tmn.x, tmn.y), tmn.z), tf = min(min(tmx.x, tmx.y), tmx.z);
      if (tf < max(tn, 0.0) || tn > tHit) continue;
      int cnt = int(N1.w + 0.5), idx = int(N0.w + 0.5);
      if (cnt == 0) {
        if (sp < 31) { stack[sp++] = idx; stack[sp++] = ni - nodeOff + 1; }
        continue;
      }
      for (int k = 0; k < LEAF_SIZE; k++) {
        if (k >= cnt) break;
        int ti = triOff + idx + k;
        vec3 v0 = tx(uMTriTex, 3 * ti).xyz, e1 = tx(uMTriTex, 3 * ti + 1).xyz, e2 = tx(uMTriTex, 3 * ti + 2).xyz;
        vec3 pv = cross(ld, e2);
        float det = dot(e1, pv);
        if (abs(det) < 1e-14) continue;
        float id = 1.0 / det;
        vec3 tv = lo - v0;
        float u = dot(tv, pv) * id;
        if (u < 0.0 || u > 1.0) continue;
        vec3 qv = cross(tv, e1);
        float v = dot(ld, qv) * id;
        if (v < 0.0 || u + v > 1.0) continue;
        float t = dot(e2, qv) * id;
        if (t > uEps * 0.1 && t < tHit) { tHit = t; model = m; tri = ti; }
      }
    }
  }
  return model >= 0;
}

vec3 unpackColour(float p) {
  vec3 c = vec3(floor(p / 65536.0), mod(floor(p / 256.0), 256.0), mod(p, 256.0)) / 255.0;
  return c * c; // stored sqrt-encoded
}

// ---------------- water: rippled plane y = uWaterY ----------------
vec2 waveGrad(vec2 x, vec2 dir, float k, float w) { return dir * k * cos(dot(dir, x) * k - w * uTime); }

// fp = pixel footprint: ripples smaller than a pixel fade out instead of aliasing
vec3 waterNormal(vec3 q, float fp) {
  vec2 x = q.xz * uWaterFreq;
  vec2 g = waveGrad(x, vec2(0.958, 0.287), 1.0, 1.1)
         + waveGrad(x, vec2(-0.371, 0.928), 1.7, 1.6) * 0.55
         + waveGrad(x, vec2(0.659, -0.753), 2.9, 2.3) * 0.3;
  float d = length(x);
  g += x / max(d, 1e-4) * cos(d * 3.0 - uTime * 2.0) * 0.45 * exp(-d * 0.12); // rings from the centre
  float amp = uWaterAmp / (1.0 + fp * uWaterFreq * 4.0);
  return normalize(vec3(-g.x * amp, 1.0, -g.y * amp));
}

// Pixel footprint (ray-cone width) at the current path length. Curved mirrors
// (chrome balls, water ripples) widen the cone, so what they reflect gets
// smoothly blurred instead of aliasing into noise.
#define FOOTPRINT (fpBase + (travelled - tBase) * spread)

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 v = uProjInv * vec4(ndc, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec3 p = uCamPos;

  vec3 col = vec3(0.0);
  vec3 thr = vec3(1.0);
  float travelled = 0.0;
  float fpBase = 0.0, tBase = 0.0, spread = uPixelAngle;
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
    stripAt(p, f, k, FOOTPRINT, a, em);
    col += a * vec3(0.002);                     // back side of the strip
    thr *= props.y * (1.0 - a);                 // light that makes it through the glass
    p -= n * uEps;
  }

  bool reachedLimit = true;
  for (int b = 0; b < MAX_BOUNCES; b++) {
    if (b >= uMaxBounces) break;
    if (max(thr.r, max(thr.g, thr.b)) < 0.0015) { reachedLimit = false; break; }
    bool shell = nextHit(p, rd, face, t, n, f, k);
    if (!shell) t = 1e20;                        // escaped (open mesh) unless something is in the way

    // objects and water inside the mirror, if nearer than the next face
    // (objects are only traced for the first uObjDepth bounces: deeper copies are tiny)
    float tO = t;
    int prim = uNumObjects > 0 && b < uObjDepth ? traceObjects(p, rd, t, FOOTPRINT, tO) : -1;
    int model = -1, mtri = -1;
    if (uNumModels > 0 && b < uObjDepth) {
      float tM = tO;
      if (traceModels(p, rd, tM, model, mtri)) { tO = tM; prim = -1; }
    }
    float tW = 1e20;
    if (uWater && abs(rd.y) > 1e-6) {
      float tw = (uWaterY - p.y) / rd.y;
      if (tw > uEps * 0.1 && tw < min(t, tO)) tW = tw;
    }

    if (tW < 1e19) {                             // water: Fresnel reflection, the rest is absorbed
      p += rd * tW;
      travelled += tW;
      float side = rd.y > 0.0 ? -1.0 : 1.0;      // +1: hit from above
      vec3 nw = waterNormal(p, FOOTPRINT) * side;
      float c = abs(dot(rd, nw));
      float F = 0.02 + 0.98 * pow(1.0 - c, 5.0);
      thr *= mix(uWaterMin, 1.0, F) * vec3(0.9, 0.96, 1.0);
      rd = reflect(rd, nw);
      if (rd.y * side <= 0.0) rd.y = -rd.y;      // a steep ripple must not send the ray back into the water
      p += nw * uEps;
      face = -1;
      float fpw = FOOTPRINT;                     // ripples spread the reflected cone a little
      spread += 6.0 * uWaterAmp * uWaterFreq * fpw;
      fpBase = fpw; tBase = travelled;
      continue;
    }

    if (prim >= 0 || model >= 0) {
      p += rd * tO;
      travelled += tO;
      float fp = FOOTPRINT;
      vec3 colr, no;
      int mat;
      float w = 1.0, dots = 1.0, curv = 0.0;     // curv: radius of a curved surface (0 = flat)
      if (model >= 0) {
        vec4 V0 = tx(uMTriTex, 3 * mtri);
        vec3 nl = normalize(cross(tx(uMTriTex, 3 * mtri + 1).xyz, tx(uMTriTex, 3 * mtri + 2).xyz));
        vec4 MB = uMB[model], MD = uMD[model];
        no = vec3(nl.x * MB.x + nl.z * MB.y, nl.y, -nl.x * MB.y + nl.z * MB.x);
        if (dot(no, rd) > 0.0) no = -no;         // triangles are two-sided
        colr = unpackColour(V0.w);
        mat = int(MD.x + 0.5);
        if (mat == 0) colr = MD.y > 0.5 ? uME[model].rgb : MD.z * colr / max(max(colr.r, colr.g), max(colr.b, 1e-3));
      } else {
        vec4 A = tx(uPrimTex, 3 * prim), B = tx(uPrimTex, 3 * prim + 1);
        colr = tx(uPrimTex, 3 * prim + 2).rgb;
        vec3 ba = B.xyz - A.xyz;
        float bb = dot(ba, ba);
        float s = bb > 1e-12 ? clamp(dot(p - A.xyz, ba) / bb, 0.0, 1.0) : 0.0;
        no = normalize(p - (A.xyz + s * ba));
        mat = int(B.w + 0.5);
        curv = A.w;
        w = A.w / (A.w + 0.5 * fp);              // thin neon tubes stay energy-conserving
        float len = sqrt(bb);
        if (uNeonDots > 0.0 && len > 1e-5) {     // LED-string look: bright dots along the tube
          float d = abs(fract(s * len / uNeonDots) - 0.5) * uNeonDots;
          dots = 0.12 + 0.88 * (1.0 - smoothstep(A.w * 0.9, A.w * 0.9 + fp + 1e-5, d));
        }
      }
      if (mat == 0) {                            // neon: glowing glass – bright rim, see-through core
        float rim = pow(1.0 - abs(dot(no, rd)), 2.0);
        col += thr * colr * uNeonIntensity * w * dots * (0.2 + 1.4 * rim);
        thr *= 1.0 - 0.45 * w;                   // the glass dims what is behind it a little
        p += rd * uEps;                          // and the ray carries on through
        continue;
      } else if (mat == 1) {                     // matte: lit by the mirror's mean light
        float lam = 0.45 + 0.55 * max(no.y, 0.0);
        float rim = pow(1.0 - abs(dot(no, rd)), 3.0);
        col += thr * uAmbient * uObjLight * (colr * lam + 0.12 * rim);
        reachedLimit = false;
        break;
      } else {                                   // chrome (polished: a hint of diffuse keeps the shape readable)
        col += thr * uAmbient * uObjLight * 0.08;
        thr *= colr;
        rd = reflect(rd, no);
        p += no * uEps;
        face = -1;
        if (curv > 0.0) {                        // a convex mirror of radius r spreads the cone by 2w/r
          spread += 2.0 * fp / curv;
          fpBase = fp; tBase = travelled;
        }
        continue;
      }
    }

    if (!shell) {
      col += thr * envColor(rd);
      reachedLimit = false;
      break;
    }
    p += rd * t;
    travelled += t;
    face = f;

    stripAt(p, f, k, FOOTPRINT, a, em);
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
      uTime: { value: 0 },
      uNumObjects: { value: 0 },
      uObjDepth: { value: 12 },
      uNumModels: { value: 0 },
      uMTriTex: { value: null },
      uMNodeTex: { value: null },
      uMA: { value: new Float32Array(16 * 4) },
      uMB: { value: new Float32Array(16 * 4) },
      uMC: { value: new Float32Array(16 * 4) },
      uMD: { value: new Float32Array(16 * 4) },
      uME: { value: new Float32Array(16 * 4) },
      uObjLight: { value: 3 },
      uObjS: { value: new Float32Array(32 * 4) },
      uObjR: { value: new Float32Array(32 * 4) },
      uSph: { value: new Float32Array(96 * 4) },
      uPrimTex: { value: null },
      uNeonIntensity: { value: 5 },
      uNeonDots: { value: 0 },
      uAmbient: { value: new THREE.Vector3() },
      uWater: { value: false },
      uWaterY: { value: 0 },
      uWaterMin: { value: 0.35 },
      uWaterAmp: { value: 0.08 },
      uWaterFreq: { value: 6 },
    },
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
}
