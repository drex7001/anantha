// All shader data lives in RGBA float textures used as linear arrays:
// element i is at texel (i % TEX_W, i / TEX_W). The shader's tx() mirrors this.
import * as THREE from 'three';

export const TEX_W = 1024;

export function linearTexture(texels) {
  const h = Math.max(1, Math.ceil(texels / TEX_W));
  const tex = new THREE.DataTexture(new Float32Array(TEX_W * h * 4), TEX_W, h, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
