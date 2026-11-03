// Downloaded low-poly models (Quaternius, CC0) inside the mirror.
//
// Each instance is a skinned glTF posed on the CPU every frame (AnimationMixer +
// SkinnedMesh.getVertexPosition), normalised to real-world size, and traced by
// the shader through its own BVH. The BVH topology is built once per instance
// and refitted every frame, and the ray is moved into the instance's local
// space, so walking around the room never needs a rebuild.
//
//   triTex   3 texels/triangle  (v0, packed colour) (e1, 0) (e2, 0)       local space
//   nodeTex  2 texels/node      (min, a) (max, count)   a/count as in bvh.js, local indices
//   per instance (uniform vec4 arrays):
//     A (position, scale)   B (cos yaw, sin yaw, node offset, tri offset)
//     C (world bounding sphere)   D (material, neon colour from pattern?, 0, 0)   E (neon colour)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { linearTexture } from './textures.js';
import { LEAF_SIZE } from './bvh.js';

export const MAX_MODEL_INSTANCES = 16; // must match the shader

// height: real-world size in metres; speed: walking speed (m/s) at that size
// yaw: turn so the model faces +z; clip: animation to loop
export const MODEL_DEFS = {
  deer: { file: 'deer.glb', height: 1.3, clip: 'Walk', speed: 1.0 },
  stag: { file: 'stag.glb', height: 1.7, clip: 'Walk', speed: 1.0 },
  fox: { file: 'fox.glb', height: 0.5, clip: 'Walk', speed: 0.6 },
  horse: { file: 'horse.glb', height: 1.7, clip: 'Walk', speed: 1.3 },
  man: { file: 'man.glb', height: 1.75, clip: 'Man_Walk', speed: 1.3 },
  woman: { file: 'woman.glb', height: 1.68, clip: 'Walk', speed: 0.95 },
  pigeon: { file: 'pigeon.glb', height: 0.3, clip: 'Walk', speed: 0.35 },
  clownfish: { file: 'clownfish.glb', height: 0.35, clip: 'Swimming_Normal', speed: 0.5 },
  tree1: { file: 'tree1.glb', height: 2.6 },
  tree2: { file: 'tree2.glb', height: 2.2 },
};

const loader = new GLTFLoader();
const files = new Map(); // file → Promise<gltf>
function loadFile(file) {
  if (!files.has(file)) files.set(file, loader.loadAsync(`${import.meta.env.BASE_URL}models/quaternius/${file}`));
  return files.get(file);
}

function pickClip(clips, name) {
  if (!name) return null;
  return clips.find((c) => c.name === name) || clips.find((c) => c.name.endsWith(`|${name}`)) || clips[0] || null;
}

// ---------------------------------------------------------------- one posed model
class Rig {
  constructor(def, gltf) {
    this.def = def;
    this.root = SkeletonUtils.clone(gltf.scene);
    this.mixer = new THREE.AnimationMixer(this.root);
    const clip = pickClip(gltf.animations, def.clip);
    this.duration = clip ? clip.duration : 0;
    if (clip) this.mixer.clipAction(clip).play();

    this.meshes = [];
    this.root.traverse((o) => { if (o.isMesh) this.meshes.push(o); });
    const idx = [], col = [];
    this.meshes.forEach((mesh, mi) => {
      const g = mesh.geometry;
      const n = g.index ? g.index.count : g.attributes.position.count;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const groups = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0 }];
      const vc = g.attributes.color;
      for (const grp of groups) {
        const mat = mats[grp.materialIndex] || mats[0];
        for (let k = grp.start; k < grp.start + grp.count; k += 3) {
          const v = [0, 1, 2].map((j) => (g.index ? g.index.getX(k + j) : k + j));
          let [r, gg, b] = [mat.color.r, mat.color.g, mat.color.b];
          if (vc && mat.vertexColors) {
            const avg = (c) => (vc.getComponent(v[0], c) + vc.getComponent(v[1], c) + vc.getComponent(v[2], c)) / 3;
            r *= avg(0); gg *= avg(1); b *= avg(2);
          }
          idx.push(mi, v[0], v[1], v[2]);
          col.push(r, gg, b);
        }
      }
    });
    this.T = col.length / 3;
    this.idx = Int32Array.from(idx);
    this.col = Float32Array.from(col);
    this.vpos = this.meshes.map((m) => new Float32Array(m.geometry.attributes.position.count * 3));
    this.boneMats = [];
    for (const m of this.meshes) {
      // the fast skinning path reads raw arrays: make sure positions are plain floats
      const p = m.geometry.attributes.position;
      if (p.isInterleavedBufferAttribute || p.normalized || !(p.array instanceof Float32Array)) {
        const f = new Float32Array(p.count * 3);
        for (let i = 0; i < p.count; i++) { f[i * 3] = p.getX(i); f[i * 3 + 1] = p.getY(i); f[i * 3 + 2] = p.getZ(i); }
        m.geometry.setAttribute('position', new THREE.BufferAttribute(f, 3));
      }
      for (const name of ['skinIndex', 'skinWeight']) {
        const a = m.geometry.attributes[name];
        if (a && a.isInterleavedBufferAttribute) {
          const f = new Float32Array(a.count * 4);
          for (let i = 0; i < a.count; i++) for (let k = 0; k < 4; k++) f[i * 4 + k] = a.getComponent(i, k);
          m.geometry.setAttribute(name, new THREE.BufferAttribute(f, 4));
        }
      }
    }
    this.positions = new Float32Array(this.T * 9);

    // normalise from the first frame: feet on y = 0, centred, real-world height
    this.scale = 1;
    this.offset = [0, 0, 0];
    this.pose(0);
    const P = this.positions;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) {
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]); }
    }
    this.scale = def.height / Math.max(hi[1] - lo[1], 1e-6);
    this.offset = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
    this.pose(0);
  }

  // positions of every triangle at animation time t (seconds), model space.
  // Linear-blend skinning done by hand on typed arrays: per bone one combined
  // matrix  meshWorld · bindInverse · boneWorld · boneInverse · bind,  then per
  // vertex just Σ weight · (M · v). (getVertexPosition is ~10× slower.)
  pose(t) {
    if (this.duration) this.mixer.setTime(t % this.duration);
    this.root.updateMatrixWorld(true);
    const M = new THREE.Matrix4(), tmp = new THREE.Matrix4();
    this.meshes.forEach((mesh, mi) => {
      const out = this.vpos[mi];
      const pos = mesh.geometry.attributes.position.array;
      const n = out.length / 3;
      if (!mesh.isSkinnedMesh) {
        const e = mesh.matrixWorld.elements;
        for (let i = 0; i < n; i++) {
          const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
          out[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
          out[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          out[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        }
        return;
      }
      const sk = mesh.skeleton;
      const mats = this.boneMats[mi] || (this.boneMats[mi] = new Float32Array(sk.bones.length * 16));
      for (let b = 0; b < sk.bones.length; b++) {
        tmp.multiplyMatrices(sk.bones[b].matrixWorld, sk.boneInverses[b]);
        M.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse).multiply(tmp).multiply(mesh.bindMatrix);
        mats.set(M.elements, b * 16);
      }
      const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
      const SI = si.array, SW = sw.array;
      const wScale = sw.normalized ? (SW instanceof Uint8Array ? 1 / 255 : SW instanceof Uint16Array ? 1 / 65535 : 1) : 1;
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        let ox = 0, oy = 0, oz = 0;
        for (let j = 0; j < 4; j++) {
          const w = SW[i * 4 + j] * wScale;
          if (w === 0) continue;
          const e = SI[i * 4 + j] * 16;
          ox += w * (mats[e] * x + mats[e + 4] * y + mats[e + 8] * z + mats[e + 12]);
          oy += w * (mats[e + 1] * x + mats[e + 5] * y + mats[e + 9] * z + mats[e + 13]);
          oz += w * (mats[e + 2] * x + mats[e + 6] * y + mats[e + 10] * z + mats[e + 14]);
        }
        out[i * 3] = ox; out[i * 3 + 1] = oy; out[i * 3 + 2] = oz;
      }
    });
    const { idx, positions: P, scale: s } = this;
    const [ox, oy, oz] = this.offset;
    for (let t3 = 0; t3 < this.T; t3++) {
      const vp = this.vpos[idx[t3 * 4]];
      for (let k = 0; k < 3; k++) {
        const vi = idx[t3 * 4 + 1 + k] * 3, o = t3 * 9 + k * 3;
        P[o] = (vp[vi] - ox) * s; P[o + 1] = (vp[vi + 1] - oy) * s; P[o + 2] = (vp[vi + 2] - oz) * s;
      }
    }
  }
}

// ---------------------------------------------------------------- BVH: build once, refit per frame
function buildTopology(P, n) {
  const cen = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) cen[t * 3 + k] = (P[t * 9 + k] + P[t * 9 + 3 + k] + P[t * 9 + 6 + k]) / 3;
  }
  const order = new Uint32Array(n).map((_, i) => i);
  const a = [], count = [];
  (function build(start, end) {
    const i = a.length;
    a.push(0); count.push(0);
    if (end - start <= LEAF_SIZE) { a[i] = start; count[i] = end - start; return i; }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let j = start; j < end; j++) {
      for (let k = 0; k < 3; k++) { const c = cen[order[j] * 3 + k]; lo[k] = Math.min(lo[k], c); hi[k] = Math.max(hi[k], c); }
    }
    const ext = [0, 1, 2].map((k) => hi[k] - lo[k]);
    const axis = ext.indexOf(Math.max(...ext));
    const sub = Array.from(order.subarray(start, end)).sort((p, q) => cen[p * 3 + axis] - cen[q * 3 + axis]);
    order.set(sub, start);
    const mid = (start + end) >> 1;
    build(start, mid);
    a[i] = build(mid, end);
    return i;
  })(0, n);
  return { order, a: Int32Array.from(a), count: Int32Array.from(count), box: new Float32Array(a.length * 6) };
}

// children always come after their parent, so one backwards pass refits everything
function refit(topo, P) {
  const { a, count, order, box } = topo;
  for (let i = a.length - 1; i >= 0; i--) {
    const b = i * 6;
    if (count[i] > 0) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let j = a[i]; j < a[i] + count[i]; j++) {
        const o = order[j] * 9;
        for (let v = 0; v < 9; v += 3) {
          const x = P[o + v], y = P[o + v + 1], z = P[o + v + 2];
          if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
          if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
        }
      }
      box[b] = x0; box[b + 1] = y0; box[b + 2] = z0; box[b + 3] = x1; box[b + 4] = y1; box[b + 5] = z1;
    } else {
      const l = (i + 1) * 6, r = a[i] * 6;
      for (let k = 0; k < 3; k++) {
        box[b + k] = Math.min(box[l + k], box[r + k]);
        box[b + 3 + k] = Math.max(box[l + 3 + k], box[r + 3 + k]);
      }
    }
  }
}

// colour → one float (sqrt-encoded 8-bit channels keep dark colours precise)
const pack = (r, g, b) => {
  const q = (c) => Math.round(Math.sqrt(Math.min(1, Math.max(0, c))) * 255);
  return q(r) * 65536 + q(g) * 256 + q(b);
};

// ---------------------------------------------------------------- all instances
export class ModelSystem {
  constructor() {
    this.slots = []; // { key, rig, topo, triOffset, nodeOffset }
    this.triTex = linearTexture(1);
    this.nodeTex = linearTexture(1);
    this.A = new Float32Array(MAX_MODEL_INSTANCES * 4);
    this.B = new Float32Array(MAX_MODEL_INSTANCES * 4);
    this.C = new Float32Array(MAX_MODEL_INSTANCES * 4);
    this.D = new Float32Array(MAX_MODEL_INSTANCES * 4);
    this.E = new Float32Array(MAX_MODEL_INSTANCES * 4);
    this.count = 0;
    this.tris = 0;
    this.pending = 0;
    this.onTexturesChanged = () => {};
  }

  // Set the list of model instances (by kind). Loads files as needed; instances
  // appear when their model has loaded.
  async setInstances(kinds) {
    const token = (this.token = {});
    this.slots = [];
    this.count = 0;
    this.pending = kinds.length;
    const rigs = await Promise.all(kinds.map(async (kind) => {
      const def = MODEL_DEFS[kind];
      try { return new Rig(def, await loadFile(def.file)); } catch (err) { console.error(`model ${kind}:`, err); return null; }
    }));
    if (token !== this.token) return; // superseded by a newer scene
    this.pending = 0;
    let triOffset = 0, nodeOffset = 0;
    this.slots = rigs.map((rig) => {
      if (!rig) return null;
      const topo = buildTopology(rig.positions, rig.T);
      const slot = { rig, topo, triOffset, nodeOffset };
      triOffset += rig.T;
      nodeOffset += topo.a.length;
      return slot;
    });
    this.tris = triOffset;
    this.triTex.dispose();
    this.nodeTex.dispose();
    this.triTex = linearTexture(Math.max(1, triOffset * 3));
    this.nodeTex = linearTexture(Math.max(1, nodeOffset * 2));
    this.onTexturesChanged();
  }

  // inst[i] = { x, y, z, yaw, scale, time, material (0 neon / 1 matte / 2 chrome), neon: [r,g,b] | null }
  update(inst) {
    const T = this.triTex.image.data, N = this.nodeTex.image.data;
    let n = 0, dirty = false;
    this.slots.forEach((slot, i) => {
      const p = inst[i];
      if (!slot || !p || n >= MAX_MODEL_INSTANCES) return;
      const { rig, topo } = slot;
      if (rig.duration || !slot.posed) { // static models (trees) are posed once
        dirty = true;
        rig.pose(p.time);
        refit(topo, rig.positions);
        slot.posed = true;
        const P = rig.positions;
        for (let k = 0; k < rig.T; k++) {
          const t = topo.order[k], o = t * 9, w = (slot.triOffset + k) * 12;
          T[w] = P[o]; T[w + 1] = P[o + 1]; T[w + 2] = P[o + 2];
          T[w + 3] = pack(rig.col[t * 3], rig.col[t * 3 + 1], rig.col[t * 3 + 2]);
          T[w + 4] = P[o + 3] - P[o]; T[w + 5] = P[o + 4] - P[o + 1]; T[w + 6] = P[o + 5] - P[o + 2]; T[w + 7] = 0;
          T[w + 8] = P[o + 6] - P[o]; T[w + 9] = P[o + 7] - P[o + 1]; T[w + 10] = P[o + 8] - P[o + 2]; T[w + 11] = 0;
        }
        for (let j = 0; j < topo.a.length; j++) {
          const w = (slot.nodeOffset + j) * 8, b = j * 6;
          N[w] = topo.box[b]; N[w + 1] = topo.box[b + 1]; N[w + 2] = topo.box[b + 2]; N[w + 3] = topo.a[j];
          N[w + 4] = topo.box[b + 3]; N[w + 5] = topo.box[b + 4]; N[w + 6] = topo.box[b + 5]; N[w + 7] = topo.count[j];
        }
      }
      // world bounding sphere from the root box
      const bx = topo.box;
      const lc = [(bx[0] + bx[3]) / 2, (bx[1] + bx[4]) / 2, (bx[2] + bx[5]) / 2];
      const lr = Math.hypot(bx[3] - bx[0], bx[4] - bx[1], bx[5] - bx[2]) / 2;
      const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
      this.A.set([p.x, p.y, p.z, p.scale], n * 4);
      this.B.set([c, s, slot.nodeOffset, slot.triOffset], n * 4);
      this.C.set([p.x + (lc[0] * c + lc[2] * s) * p.scale, p.y + lc[1] * p.scale, p.z + (-lc[0] * s + lc[2] * c) * p.scale, lr * p.scale], n * 4);
      this.D.set([p.material, p.neon ? 1 : 0, p.gain ?? 1, 0], n * 4);
      this.E.set(p.neon || [0, 0, 0], n * 4);
      n++;
    });
    this.count = n;
    if (dirty) { this.triTex.needsUpdate = true; this.nodeTex.needsUpdate = true; }
  }
}
