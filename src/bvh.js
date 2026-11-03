// Bounding volume hierarchy over the shape's triangles, packed for the shader.
//   nodeTex: 2 texels per node  (min.xyz, a) (max.xyz, count)
//            leaf: count > 0, triangles [a, a+count); inner: count = 0,
//            left child = node + 1, right child = a
//   triTex:  3 texels per triangle in leaf order  (v0.xyz, faceId) (e1.xyz) (e2.xyz)
import { linearTexture } from './textures.js';

export const LEAF_SIZE = 8; // max triangles per leaf (the shader's leaf loop uses it too)

export function buildBVH({ positions: P, faceIds, count: n }) {
  const lo = new Float32Array(n * 3), hi = new Float32Array(n * 3), cen = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const a = P[t * 9 + k], b = P[t * 9 + 3 + k], c = P[t * 9 + 6 + k];
      lo[t * 3 + k] = Math.min(a, b, c);
      hi[t * 3 + k] = Math.max(a, b, c);
      cen[t * 3 + k] = (a + b + c) / 3;
    }
  }

  const order = new Uint32Array(n).map((_, i) => i);
  const nodes = [];

  function build(start, end) {
    const node = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], a: 0, count: 0 };
    const index = nodes.length;
    nodes.push(node);
    const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = order[i];
      for (let k = 0; k < 3; k++) {
        node.min[k] = Math.min(node.min[k], lo[t * 3 + k]);
        node.max[k] = Math.max(node.max[k], hi[t * 3 + k]);
        cmin[k] = Math.min(cmin[k], cen[t * 3 + k]);
        cmax[k] = Math.max(cmax[k], cen[t * 3 + k]);
      }
    }
    if (end - start <= LEAF_SIZE) {
      node.a = start;
      node.count = end - start;
      return index;
    }
    const ext = [0, 1, 2].map((k) => cmax[k] - cmin[k]);
    const axis = ext.indexOf(Math.max(...ext));
    const sub = Array.from(order.subarray(start, end));
    sub.sort((i, j) => cen[i * 3 + axis] - cen[j * 3 + axis]);
    order.set(sub, start);
    const mid = (start + end) >> 1;
    build(start, mid); // left child is always index + 1
    node.a = build(mid, end);
    return index;
  }
  build(0, n);

  const nodeTex = linearTexture(nodes.length * 2);
  const nd = nodeTex.image.data;
  nodes.forEach((node, i) => {
    nd.set([...node.min, node.a], i * 8);
    nd.set([...node.max, node.count], i * 8 + 4);
  });

  const triTex = linearTexture(n * 3);
  const td = triTex.image.data;
  for (let k = 0; k < n; k++) {
    const t = order[k], o = t * 9;
    td.set([P[o], P[o + 1], P[o + 2], faceIds[t]], k * 12);
    td.set([P[o + 3] - P[o], P[o + 4] - P[o + 1], P[o + 5] - P[o + 2], 0], k * 12 + 4);
    td.set([P[o + 6] - P[o], P[o + 7] - P[o + 1], P[o + 8] - P[o + 2], 0], k * 12 + 8);
  }

  return {
    nodeTex, triTex, nodeCount: nodes.length,
    order, // order[k] = original index of the k-th triangle in triTex
    dispose() { nodeTex.dispose(); triTex.dispose(); },
  };
}
