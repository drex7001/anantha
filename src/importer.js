// Load a closed 3D model (STL / OBJ / GLB) as a single position-only geometry.
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const MAX_TRIANGLES = 200000;

function positionsOnly(geom) {
  const src = geom.index ? geom.toNonIndexed() : geom;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.attributes.position.clone());
  return g;
}

export async function loadModel(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  let geometry;
  if (ext === 'stl') {
    geometry = positionsOnly(new STLLoader().parse(await file.arrayBuffer()));
  } else {
    let root;
    if (ext === 'obj') root = new OBJLoader().parse(await file.text());
    else if (ext === 'glb') root = (await new GLTFLoader().parseAsync(await file.arrayBuffer(), '')).scene;
    else throw new Error(`Unsupported file type ".${ext}" (use .stl, .obj or .glb)`);
    root.updateMatrixWorld(true);
    const parts = [];
    root.traverse((o) => {
      if (o.isMesh) {
        const g = positionsOnly(o.geometry);
        g.applyMatrix4(o.matrixWorld);
        parts.push(g);
      }
    });
    if (!parts.length) throw new Error('No meshes found in the file');
    geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts);
  }
  const tris = geometry.attributes.position.count / 3;
  if (tris > MAX_TRIANGLES) throw new Error(`${tris} triangles – the limit is ${MAX_TRIANGLES}`);
  return geometry;
}

export function pickFile(onFile) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.stl,.obj,.glb';
  input.onchange = () => input.files[0] && onFile(input.files[0]);
  input.click();
}
