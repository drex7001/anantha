import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SHAPES, analyzeShape, isInside, interiorPoint, starOutline } from './shapes.js';
import { buildBVH } from './bvh.js';
import { buildLeds, updateLedColors, hueMatrix } from './leds.js';
import { PATTERNS, hexToLinear } from './patterns.js';
import { AudioEngine, MAX_FLASH_HZ } from './audio.js';
import { InsideScene, SCENES } from './inside.js';
import { ModelSystem } from './models.js';
import { createMirrorMaterial, MAX_PLANES } from './mirrorShader.js';
import { createUI } from './ui.js';
import { createEditor } from './editor.js';
import { loadModel, pickFile } from './importer.js';

export const state = {
  // shape
  shape: 'Infinity cube',
  size: 0.5,          // m
  depth: 0.06,        // m, panels only
  edgeAngle: 20,      // edges sharper than this can carry LED strips
  // mirrors
  faceMode: 'cube',   // cube | box | panel | room
  twoWayR: 0.7,
  twoWayT: 0.25,
  mirrorR: 0.95,
  glassGreen: 0.012,  // per-bounce green tint of real glass mirrors
  maxBounces: 48,
  roomLight: 0.3,
  // LEDs
  strips: 'all',
  ledDensity: 60,     // LEDs per metre
  stripWidthMm: 5,
  doubleStrip: false, // two LED rows per strip, one on each face of the edge
  rowGapMm: 10,       // distance between the two rows
  row2: 'same',       // same | reverse | complement
  stagger: false,     // shift row 2 by half an LED pitch
  ledSizeMm: 3,
  ledIntensity: 20,
  stripGlow: 0.15,
  // pattern
  pattern: 'Rainbow flow',
  speed: 1,
  hueSpread: 1,
  color: '#ff2a6d',
  brightness: 1,
  // render
  renderScale: 1,     // upper limit when autoQuality is on
  autoQuality: true,  // lower the resolution when fps drops
  farGlow: true,      // estimate the light beyond the last traced bounce
  autoExposure: true, // darken (never brighten) when the view is flooded with light
  forceMesh: false,   // use the BVH tracer even for convex shapes
  bloomStrength: 1.2,
  bloomRadius: 0.5,
  bloomThreshold: 0.5,
  exposure: 1,
  autoRotate: false,
  // inside the mirror
  scene: 'None',
  objMaterial: 'designed', // designed | neon | matte | chrome
  objColour: 'own',        // own | pattern
  neonIntensity: 3,
  neonDots: false,         // LED-string look on neon objects
  objScale: 1,
  animSpeed: 1,
  fireflies: 24,
  objDepth: 6,             // objects are traced for this many bounces
  objLight: 3,             // how strongly the LEDs light matte objects
  // water floor
  water: false,
  waterLevel: 0.05,        // fraction of the interior height
  waterReflect: 0.35,      // reflectance looking straight down
  waterWaves: 1,
  // audio
  reactivity: 0.7,
  sensitivity: 1,
  calm: false,             // no beat flashes, slow smooth changes
};

// inputs for the editor / imported shapes
const custom = { outline: starOutline(6, 0.5), mode: 'panel', thickness: 0.35, imported: null, importedName: '' };

// ---------- renderer / camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 0.005;
controls.maxDistance = 10;

const material = createMirrorMaterial();
const u = material.uniforms;
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
quad.frustumCulled = false;
const scene = new THREE.Scene();
scene.add(quad);

const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, quadCam));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1, 0.4, 0.8);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// Resolution actually rendered; equals state.renderScale unless autoQuality lowered it.
let activeScale = state.renderScale;

function resize() {
  if (!state.autoQuality || activeScale > state.renderScale) activeScale = state.renderScale;
  const pr = Math.min(devicePixelRatio, 2) * activeScale;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight);
  composer.setPixelRatio(pr);
  composer.setSize(innerWidth, innerHeight);
  u.uPixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / (innerHeight * pr);
}
addEventListener('resize', resize);

// ---------- messages ----------
const toastEl = document.getElementById('toast');
let toastTimer = 0;
function toast(text, ms = 4000) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

// ---------- scene state ----------
let shape = null;
let strip = null;
let bvh = null;
let lastShape = state.shape;
const faceAvg = { R: 0, T: 0 };
let autoExp = 1; // auto-exposure factor, see meterExposure()
const insideCache = { pos: new THREE.Vector3(Infinity, 0, 0), value: false };
const audio = new AudioEngine();
const inside = new InsideScene();
const models = new ModelSystem();
inside.models = models;
models.onTexturesChanged = () => {
  u.uMTriTex.value = models.triTex;
  u.uMNodeTex.value = models.nodeTex;
};
const patternParams = { speed: 1, hueSpread: 1, color: [1, 0, 0], extent: 1, audio: audio.state };
let rBoost = 0; // audio: the mirrors "breathe" with the music

function applyFaces() {
  const two = [Math.min(0.98, state.twoWayR + rBoost), state.twoWayT, state.twoWayR];
  const mirror = [Math.min(0.995, state.mirrorR + rBoost * 0.3), 0, 0.04];
  const black = [0, 0, 0.03];
  const data = strip.faceTex.image.data;
  let r = 0, t = 0;
  shape.planes.forEach((p, i) => {
    let f;
    switch (state.faceMode) {
      case 'box': f = i === shape.windowFace ? two : mirror; break;
      case 'panel': f = i === shape.windowFace ? two : i === shape.backFace ? mirror : black; break;
      case 'room': f = mirror; break;
      default: f = two;
    }
    data[i * 8] = f[0]; data[i * 8 + 1] = f[1]; data[i * 8 + 2] = f[2];
    r += f[0] * p.area; t += f[1] * p.area;
  });
  strip.faceTex.needsUpdate = true;
  faceAvg.R = r / shape.totalArea;
  faceAvg.T = t / shape.totalArea;
}

function rebuildLeds() {
  strip?.dispose();
  strip = buildLeds(shape, state, bvh ? bvh.order : null);
  u.uFaceTex.value = strip.faceTex;
  u.uTriListTex.value = strip.triListTex;
  u.uListTex.value = strip.listTex;
  u.uEdgeTex.value = strip.edgeTex;
  u.uLedTex.value = strip.ledTex;
  applyFaces();
}

function rebuildShape() {
  const def = SHAPES[state.shape];
  const geom = def.make(state.size, state.depth, custom);
  shape = analyzeShape(geom, { fixed: !!def.fixed, size: state.size, edgeAngle: state.edgeAngle });
  geom.dispose();

  const useMesh = state.forceMesh || !shape.convex || shape.planes.length > MAX_PLANES;
  shape.mode = useMesh ? 'mesh' : 'convex';
  bvh?.dispose();
  bvh = null;
  if (useMesh) {
    bvh = buildBVH(shape.tris);
    u.uTriTex.value = bvh.triTex;
    u.uBvhTex.value = bvh.nodeTex;
  } else {
    u.uNumPlanes.value = shape.planes.length;
    shape.planes.forEach((p, i) => u.uPlanes.value[i].set(p.n.x, p.n.y, p.n.z, p.d));
  }
  if (('MESH_MODE' in material.defines) !== useMesh) {
    material.defines = useMesh ? { MESH_MODE: '' } : {};
    material.needsUpdate = true;
  }
  u.uEps.value = shape.radius * 2e-5;
  patternParams.extent = shape.radius;
  insideCache.pos.set(Infinity, 0, 0);
  if (!shape.closed) toast('This mesh is not closed – some rays will escape through holes');
  rebuildLeds();
  inside.setup(state.scene, shape);
}

const WATER_SCENES = ['Clownfish', 'Nature (everything)'];
export function setScene() {
  inside.setup(state.scene, shape);
  if (WATER_SCENES.includes(state.scene)) state.water = true;
  const [W, H, D] = inside.size;
  if (state.scene !== 'None' && Math.min(W, H, D) < 0.15) {
    toast('This shape is very thin – scenes look best in the Mirror room or the Infinity cube', 6000);
  }
  ui?.refresh();
}

export function resetView() {
  const def = SHAPES[state.shape];
  controls.target.set(0, 0, 0);
  if (def.inside) {
    camera.position.set(0.2, 0.15, 1.25); // near a wall, outside the walking paths
  } else {
    const dir = new THREE.Vector3(...(def.view || [0.55, 0.35, 1])).normalize();
    camera.position.copy(dir.multiplyScalar(Math.max(shape.radius, state.size / 2) * 3.4));
  }
  controls.update();
}

export function goInside() {
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (shape.convex) {
    controls.target.set(0, 0, 0);
    camera.position.copy(dir.multiplyScalar(shape.radius * 0.15));
  } else {
    const { point, half } = interiorPoint(shape);
    controls.target.copy(point);
    camera.position.copy(point).addScaledVector(dir, half * 0.5);
  }
  controls.update();
}

const pick = (v) => (typeof v === 'function' ? v(custom) : v);

// Apply a shape's recommended mirror/strip setup, then rebuild.
export function selectShape() {
  if (state.shape === 'Imported model' && !custom.imported) {
    toast('Import a model first: Shape → import model…');
    state.shape = lastShape;
    ui?.refresh();
    return;
  }
  const def = SHAPES[state.shape];
  state.faceMode = pick(def.faceMode);
  state.strips = pick(def.strips);
  state.maxBounces = def.bounces ?? 48;
  state.edgeAngle = def.edgeAngle ?? 20;
  syncUniforms();
  rebuildShape();
  resetView();
  lastShape = state.shape;
  ui?.refresh();
}

// A double strip must be wide enough to carry both rows.
function stripWidth() {
  const w = state.stripWidthMm / 1000;
  return state.doubleStrip ? Math.max(w, state.rowGapMm / 2000 + 1.5 * state.ledSizeMm / 1000) : w;
}

export function syncUniforms() {
  u.uStripWidth.value = stripWidth();
  u.uDoubleStrip.value = state.doubleStrip;
  u.uRowGap.value = state.rowGapMm / 1000;
  u.uStagger.value = state.stagger ? 0.5 : 0;
  u.uLedRadius.value = state.ledSizeMm / 1000;
  u.uLedIntensity.value = state.ledIntensity;
  u.uStripGlow.value = state.stripGlow;
  u.uMaxBounces.value = state.maxBounces;
  u.uEnv.value = state.roomLight;
  u.uTint.value.set(1 - state.glassGreen, 1, 1 - state.glassGreen * 0.6);
  bloom.strength = state.bloomStrength;
  bloom.radius = state.bloomRadius;
  bloom.threshold = state.bloomThreshold / autoExp;
  renderer.toneMappingExposure = state.exposure * autoExp;
  controls.autoRotate = state.autoRotate;
  patternParams.speed = state.speed;
  patternParams.hueSpread = state.hueSpread;
  patternParams.color = hexToLinear(state.color);
  if (strip) applyFaces();
}

// Mean radiance along a ray inside the mirror. Per bounce a ray hits a strip
// with probability p (strip area / total area) and otherwise reflects with the
// area-weighted mean reflectivity, so it is a geometric series:
//   (p·E + (1-p)·T·env) / (1 − (1-p)·R·tint)
// Used for the far-field glow (light beyond the last traced bounce) and to
// light matte objects (a diffuse surface in uniform light L shows albedo·L).
function updateTail(avgLed) {
  const L = meanRadiance(avgLed);
  u.uTail.value.set(...(state.farGlow ? L : [0, 0, 0]));
  u.uAmbient.value.set(L[0] * 2.5 + 0.01, L[1] * 2.5 + 0.01, L[2] * 2.5 + 0.01);
}

function meanRadiance(avgLed) {
  const sw = stripWidth(), r = state.ledSizeMm / 1000;
  const p = Math.min(0.9, (strip.stripLenFaces * sw) / shape.totalArea);
  const rows = state.doubleStrip ? 2 : 1;
  const dotFrac = Math.min(1, (Math.PI * r * r * state.ledDensity * rows) / (2 * sw));
  const k = state.ledIntensity * dotFrac + state.stripGlow;
  const env = 0.03 * state.roomLight;
  const tint = [1 - state.glassGreen, 1, 1 - state.glassGreen * 0.6];
  return [0, 0, 0].map((_, c) => {
    const emit = avgLed[c] * k + 0.004;
    const num = p * emit + (1 - p) * faceAvg.T * env;
    return num / Math.max(0.02, 1 - (1 - p) * faceAvg.R * tint[c]);
  });
}

// ---------- editor / import ----------
const editor = createEditor({
  onApply: ({ outline, mode, thickness }) => {
    Object.assign(custom, { outline, mode, thickness });
    state.shape = 'Custom outline (editor)';
    selectShape();
  },
});

async function importFile(file) {
  try {
    toast(`Loading ${file.name}…`, 60000);
    custom.imported?.dispose();
    custom.imported = await loadModel(file);
    custom.importedName = file.name;
    state.shape = 'Imported model';
    selectShape();
    toast(`${file.name}: ${shape.tris.count} triangles, ${shape.planes.length} faces, ` +
          `${shape.edges.length} LED edges${shape.convex ? '' : ' (BVH tracer)'}`);
  } catch (err) {
    console.error(err);
    toast(`Import failed: ${err.message}`, 8000);
  }
}

// ---------- audio ----------
let warnedFlashes = false;
async function startAudio(start) {
  try {
    await start();
    if (!warnedFlashes) {
      warnedFlashes = true;
      toast(`⚠ Audio-reactive lights can flash. Flashes are limited to ${MAX_FLASH_HZ} per second; ` +
            'turn on "calm mode" if you are sensitive to flashing light.', 9000);
    } else toast(`Audio: ${audio.name}`);
  } catch (err) {
    console.error(err);
    toast(`Audio failed: ${err.message}`, 7000);
  }
}
function pickAudioFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.onchange = () => input.files[0] && startAudio(() => audio.useFile(input.files[0]));
  input.click();
}

export const actions = {
  rebuildShape, rebuildLeds, selectShape, resetView, goInside, syncUniforms, resize, importFile, setScene,
  loadMusic: pickAudioFile,
  useMic: () => startAudio(() => audio.useMic()),
  useTab: () => startAudio(() => audio.useTab()),
  playMusicFile: (file) => startAudio(() => audio.useFile(file)),
  playPause: () => audio.togglePlay(),
  stopAudio: () => { audio.stop(); rBoost = 0; applyFaces(); },
  openEditor: () => editor.open(custom),
  importModel: () => pickFile(importFile),
  toggleFullscreen: () => toggleFullscreen(),
};

// ---------- go ----------
let ui = null;
syncUniforms();
rebuildShape();
resetView();
resize();
ui = createUI(state, actions, Object.keys(SHAPES), Object.keys(PATTERNS), Object.keys(SCENES), audio);
u.uPrimTex.value = inside.primTex;
u.uObjS.value = inside.objS;
u.uObjR.value = inside.objR;
u.uSph.value = inside.sph;
u.uMA.value = models.A;
u.uMB.value = models.B;
u.uMC.value = models.C;
u.uMD.value = models.D;
u.uME.value = models.E;
models.onTexturesChanged();

// Colour of a neon object when it follows the LED pattern: a stand-in LED at the
// object's position, with u going round the room so patterns sweep around it.
const objLed = { u: 0, x: 0, y: 0, z: 0, e: 0, i: 0, s: 0.5, seed: 0.5, row: 0 };
let tNow = 0;
function objectColour(x, y, z, i, out) {
  Object.assign(objLed, { u: Math.atan2(z, x) / (2 * Math.PI) + 0.5, x, y, z, e: i, i, seed: (i * 0.618) % 1 });
  return PATTERNS[state.pattern](objLed, tNow, patternParams, out);
}

// Cost is ~ pixels × bounces, so resolution is the knob that keeps fps up.
// Drop quickly when slow; climb back slowly (after 2 good seconds).
// The resize is applied at the start of the next frame: resizing the canvas
// clears it, and doing that after a render would show one black frame.
let goodSeconds = 0;
let resizePending = false;
function adaptQuality(fps) {
  if (fps < 48 && activeScale > 0.35) {
    activeScale = Math.max(0.35, activeScale * 0.85);
    goodSeconds = 0;
    resizePending = true;
  } else if (fps > 57 && activeScale < state.renderScale) {
    if (++goodSeconds >= 2) {
      activeScale = Math.min(state.renderScale, activeScale * 1.08);
      goodSeconds = 0;
      resizePending = true;
    }
  } else {
    goodSeconds = 0;
  }
}

// Auto exposure: every few frames trace a 32×18 thumbnail, take its mean
// luminance and lower the exposure when it is above KEY (never raise it).
// KEY sits just above the mirror room (~0.044); a view from inside a small
// LED-lined tube reaches ~0.15 and would otherwise wash out to white.
const METER_W = 32, METER_H = 18, KEY = 0.05;
const meterRT = new THREE.WebGLRenderTarget(METER_W, METER_H, { type: THREE.FloatType });
const meterBuf = new Float32Array(METER_W * METER_H * 4);
function meterExposure() {
  const normalAngle = u.uPixelAngle.value;
  u.uPixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / METER_H;
  renderer.setRenderTarget(meterRT);
  renderer.render(scene, quadCam);
  renderer.readRenderTargetPixels(meterRT, 0, 0, METER_W, METER_H, meterBuf);
  renderer.setRenderTarget(null);
  u.uPixelAngle.value = normalAngle;
  let sum = 0;
  for (let i = 0; i < meterBuf.length; i += 4) {
    sum += 0.2126 * meterBuf[i] + 0.7152 * meterBuf[i + 1] + 0.0722 * meterBuf[i + 2];
  }
  stats.meterLum = sum / (METER_W * METER_H);
  const target = Math.min(1, KEY / Math.max(stats.meterLum, 1e-6));
  autoExp += (target - autoExp) * 0.25;
  renderer.toneMappingExposure = state.exposure * autoExp;
  bloom.threshold = state.bloomThreshold / autoExp; // bloom runs before exposure
}

function cameraInside() {
  if (insideCache.pos.distanceToSquared(camera.position) > 1e-12) {
    insideCache.pos.copy(camera.position);
    insideCache.value = isInside(shape, camera.position);
  }
  return insideCache.value;
}

const hud = document.getElementById('hud');

// ---------- full screen ----------
// F toggles full screen, H shows/hides the controls. In full screen the
// controls start hidden and the cursor fades out when the mouse is idle.
let uiVisible = true;
function setUiVisible(v) {
  uiVisible = v;
  ui.panel.hidden = !v;
  hud.style.display = v ? '' : 'none';
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch((err) => toast(`Full screen blocked: ${err.message}`));
}
document.addEventListener('fullscreenchange', () => {
  const fs = !!document.fullscreenElement;
  setUiVisible(!fs);
  if (fs) toast('Full screen · H = show/hide controls · F or Esc = exit', 3500);
});
addEventListener('keydown', (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.target.closest?.('input, select, textarea')) return;
  if (!document.getElementById('editor').hidden) return;
  const key = ev.key.toLowerCase();
  if (key === 'f') toggleFullscreen();
  if (key === 'h') setUiVisible(!uiVisible);
});
let cursorTimer = 0;
addEventListener('pointermove', () => {
  document.body.style.cursor = '';
  clearTimeout(cursorTimer);
  if (document.fullscreenElement && !uiVisible) {
    cursorTimer = setTimeout(() => { document.body.style.cursor = 'none'; }, 2500);
  }
});
let frames = 0, frameNo = 0, lastHud = performance.now();
const stats = { fps: 0, ms: 0, cpuMs: 0 }; // cpuMs: JS work per frame (smoothed)
window.__sim = {
  state, stats, actions, custom, audio, inside,
  get shape() { return shape; },
  toneExposure: () => renderer.toneMappingExposure,
};

renderer.setAnimationLoop((now) => {
  const cpuStart = performance.now();
  if (resizePending) { resizePending = false; resize(); }
  controls.update();
  camera.updateMatrixWorld();
  u.uCamPos.value.copy(camera.position);
  u.uCamWorld.value.copy(camera.matrixWorld);
  u.uProjInv.value.copy(camera.projectionMatrixInverse);
  u.uInside.value = cameraInside();
  tNow = now / 1000;
  u.uTime.value = tNow;

  // audio → light. Calm mode halves the depth; beats are already rate-limited in audio.js.
  audio.calm = state.calm;
  audio.sensitivity = state.sensitivity;
  const A = audio.update(now);
  const react = A.active ? state.reactivity * (state.calm ? 0.5 : 1) : 0;
  const gain = 1 + react * (1.3 * A.bass + 0.5 * A.pulse - 0.65);
  const mod = react ? { hue: hueMatrix(react * A.mids * 1.4), sparkle: react * A.highs * 0.03 } : null;
  bloom.strength = state.bloomStrength * (1 + react * (0.5 * A.bass + 0.4 * A.pulse));
  if (react || rBoost) { rBoost = react * 0.06 * A.energy; applyFaces(); }

  const avg = updateLedColors(strip, PATTERNS[state.pattern], tNow, patternParams, state.brightness * gain, mod);
  updateTail(avg);

  // inside the mirror: creatures, trees, fireflies + water
  const H = shape.bboxMax.y - shape.bboxMin.y;
  const waterY = shape.bboxMin.y + state.waterLevel * H;
  u.uWater.value = state.water;
  u.uWaterY.value = waterY;
  u.uWaterMin.value = state.waterReflect;
  u.uWaterAmp.value = 0.08 * state.waterWaves;
  u.uWaterFreq.value = 7 / Math.max(H, 0.05);
  if (state.scene !== 'None') {
    inside.update({
      t: tNow, speed: state.animSpeed * (1 + 0.5 * react * A.energy), scale: state.objScale,
      material: state.objMaterial, colour: state.objColour, colorFn: objectColour,
      fireflies: state.fireflies, waterY: state.water ? waterY : null, gain: Math.max(0.2, gain),
    });
  }
  u.uNumObjects.value = state.scene !== 'None' ? inside.numObjects : 0;
  u.uNumModels.value = state.scene !== 'None' ? models.count : 0;
  u.uObjDepth.value = state.objDepth;
  u.uObjLight.value = state.objLight;
  u.uNeonIntensity.value = state.neonIntensity;
  u.uNeonDots.value = state.neonDots ? Math.max(0.004, 0.035 * inside.baseScale * state.objScale) : 0;
  if (state.autoExposure && frameNo % 8 === 0) meterExposure();
  else if (!state.autoExposure && autoExp !== 1) { autoExp = 1; syncUniforms(); }
  stats.cpuMs += (performance.now() - cpuStart - stats.cpuMs) * 0.1;
  composer.render();

  frameNo++;
  frames++;
  if (now - lastHud > 1000) {
    stats.fps = (frames * 1000) / (now - lastHud);
    stats.ms = 1000 / stats.fps;
    if (state.autoQuality) adaptQuality(stats.fps);
    const w = renderer.domElement.width, h = renderer.domElement.height;
    const tracer = shape.mode === 'mesh' ? `BVH ${shape.tris.count} tris` : 'convex';
    const objs = (u.uNumObjects.value ? ` · ${inside.numObjects} objects / ${inside.numPrims} capsules` : '') +
      (u.uNumModels.value ? ` · ${models.count} models / ${models.tris} tris` : '') +
      (models.pending ? ' · loading models…' : '');
    const snd = A.active ? ` · ♪ ${audio.name} · ${A.beatsPerSec.toFixed(1)} beats/s${state.calm ? ' (calm)' : ''}` : '';
    hud.textContent =
      `${stats.fps.toFixed(0)} fps · ${w}×${h} · ${tracer} · ${shape.planes.length} faces · ` +
      `${shape.edges.length} edges · ${strip.count} LEDs · ≤${state.maxBounces} bounces${objs}${snd}`;
    frames = 0;
    lastHud = now;
  }
});
