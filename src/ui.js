// Settings panel: a glass card with six tabs, each holding its own lil-gui.
import GUI from 'lil-gui';
import './panel.css';

const TABS = [
  { id: 'shape', icon: '◆', label: 'Shape' },
  { id: 'leds', icon: '✦', label: 'LEDs' },
  { id: 'mirror', icon: '▣', label: 'Mirror' },
  { id: 'inside', icon: '❀', label: 'Inside' },
  { id: 'audio', icon: '♫', label: 'Audio' },
  { id: 'view', icon: '⚙', label: 'View' },
];
const TAB_KEY = 'anantha.tab';

export function createUI(state, a, shapeNames, patternNames, sceneNames, audio) {
  const panel = document.createElement('aside');
  panel.className = 'panel';
  panel.innerHTML = `
    <header class="panel-head">
      <div class="brand"><span class="brand-name">anantha</span><span class="brand-si">අනන්ත</span></div>
      <div class="head-actions">
        <button class="icon-btn" data-act="fullscreen" title="Full screen (F)">⛶</button>
        <button class="icon-btn" data-act="collapse" title="Minimise panel">–</button>
      </div>
    </header>
    <nav class="tabs" role="tablist">
      ${TABS.map((t, i) => `<button class="tab" role="tab" data-tab="${t.id}" title="${t.label} (${i + 1})">
        <span class="tab-icon">${t.icon}</span>${t.label}</button>`).join('')}
    </nav>
    <div class="panes">${TABS.map((t) => `<section class="pane" data-pane="${t.id}" hidden></section>`).join('')}</div>
    <footer class="panel-foot">
      <span><kbd>F</kbd> full screen</span><span><kbd>H</kbd> hide panel</span><span><kbd>1</kbd>–<kbd>6</kbd> tabs</span>
    </footer>`;
  document.body.appendChild(panel);

  const pane = (id) => panel.querySelector(`[data-pane="${id}"]`);
  const gui = Object.fromEntries(TABS.map((t) => [t.id, new GUI({ container: pane(t.id), title: t.label })]));
  const note = (id, text) => {
    const p = document.createElement('p');
    p.className = 'pane-note';
    p.textContent = text;
    pane(id).prepend(p);
  };
  const tag = (ctrl, cls) => { ctrl.domElement.classList.add(cls); return ctrl; };

  // ---------------- Shape
  const g1 = gui.shape;
  g1.add(state, 'shape', shapeNames).name('Shape').onChange(a.selectShape);
  tag(g1.add(a, 'openEditor').name('✎  Draw your own shape'), 'primary');
  g1.add(a, 'importModel').name('⇪  Import 3D model (STL · OBJ · GLB)');
  const s1 = g1.addFolder('Size');
  s1.add(state, 'size', 0.15, 2, 0.01).name('Size (m)').onFinishChange(a.rebuildShape);
  s1.add(state, 'depth', 0.02, 0.3, 0.005).name('Panel depth (m)').onFinishChange(a.rebuildShape);
  s1.add(state, 'edgeAngle', 1, 89, 1).name('LED edge angle (°)').onFinishChange(a.rebuildShape);

  // ---------------- LEDs
  const g2 = gui.leds;
  const p2 = g2.addFolder('Pattern');
  p2.add(state, 'pattern', patternNames).name('Pattern');
  p2.addColor(state, 'color').name('Colour').onChange(a.syncUniforms);
  p2.add(state, 'speed', 0, 5, 0.01).name('Speed').onChange(a.syncUniforms);
  p2.add(state, 'hueSpread', 0, 4, 0.01).name('Hue spread').onChange(a.syncUniforms);
  p2.add(state, 'brightness', 0, 2, 0.01).name('Brightness');
  const st = g2.addFolder('Strips');
  st.add(state, 'strips', {
    'All edges': 'all', 'Window ring': 'window', 'Back ring': 'back',
    Vertical: 'vertical', Horizontal: 'horizontal', Alternate: 'alternate',
  }).name('Edges').onChange(a.rebuildLeds);
  st.add(state, 'ledDensity', 10, 144, 1).name('LEDs per metre').onFinishChange(a.rebuildLeds);
  st.add(state, 'stripWidthMm', 1, 20, 0.5).name('Strip width (mm)').onChange(a.syncUniforms);
  st.add(state, 'ledSizeMm', 0.5, 6, 0.1).name('LED size (mm)').onChange(a.syncUniforms);
  st.add(state, 'ledIntensity', 0.5, 40, 0.1).name('LED intensity').onChange(a.syncUniforms);
  st.add(state, 'stripGlow', 0, 0.5, 0.01).name('Strip glow').onChange(a.syncUniforms);
  const ds = g2.addFolder('Double strip');
  ds.add(state, 'doubleStrip').name('Double strip').onChange(() => { a.syncUniforms(); a.rebuildLeds(); });
  ds.add(state, 'rowGapMm', 2, 30, 0.5).name('Row gap (mm)').onChange(a.syncUniforms);
  ds.add(state, 'row2', { Same: 'same', 'Reverse direction': 'reverse', 'Complement colour': 'complement' })
    .name('Row 2 colours').onChange(a.rebuildLeds);
  ds.add(state, 'stagger').name('Stagger rows').onChange(a.syncUniforms);

  // ---------------- Mirror
  const g3 = gui.mirror;
  g3.add(state, 'faceMode', {
    'All two-way (cube)': 'cube',
    'Window + mirrors (box)': 'box',
    'Window + back + black sides (panel)': 'panel',
    'All mirrors (room)': 'room',
  }).name('Faces').onChange(a.syncUniforms);
  const gl = g3.addFolder('Glass');
  gl.add(state, 'twoWayR', 0, 0.99, 0.01).name('Two-way reflect').onChange(a.syncUniforms);
  gl.add(state, 'twoWayT', 0, 1, 0.01).name('Two-way transmit').onChange(a.syncUniforms);
  gl.add(state, 'mirrorR', 0, 0.999, 0.001).name('Mirror reflect').onChange(a.syncUniforms);
  gl.add(state, 'glassGreen', 0, 0.06, 0.001).name('Green tint').onChange(a.syncUniforms);
  const dp = g3.addFolder('Depth & room');
  dp.add(state, 'maxBounces', 1, 256, 1).name('Max bounces').onChange(a.syncUniforms);
  dp.add(state, 'roomLight', 0, 3, 0.01).name('Room light').onChange(a.syncUniforms);

  // ---------------- Inside
  const g4 = gui.inside;
  note('inside', 'Creatures and nature inside the mirror, reflected forever. Best in the Mirror room or the Infinity cube.');
  g4.add(state, 'scene', sceneNames).name('Scene').onChange(a.setScene);
  const lk = g4.addFolder('Look');
  lk.add(state, 'objMaterial', {
    'As designed': 'designed', Neon: 'neon', 'Matte (lit by the LEDs)': 'matte', Chrome: 'chrome',
  }).name('Material');
  lk.add(state, 'objColour', { 'Own colours': 'own', 'Follow LED pattern': 'pattern' }).name('Neon colours');
  lk.add(state, 'neonIntensity', 0.5, 20, 0.1).name('Neon intensity');
  lk.add(state, 'neonDots').name('LED-string look');
  const mo = g4.addFolder('Motion');
  mo.add(state, 'objScale', 0.3, 2, 0.01).name('Size');
  mo.add(state, 'animSpeed', 0, 3, 0.01).name('Animation speed');
  mo.add(state, 'fireflies', 0, 64, 1).name('Fireflies');
  mo.add(state, 'objDepth', 1, 48, 1).name('Reflection depth');
  const wa = g4.addFolder('Water floor');
  wa.add(state, 'water').name('Water');
  wa.add(state, 'waterLevel', 0.01, 0.5, 0.01).name('Level');
  wa.add(state, 'waterReflect', 0, 1, 0.01).name('Reflect');
  wa.add(state, 'waterWaves', 0, 3, 0.01).name('Waves');

  // ---------------- Audio
  const g5 = gui.audio;
  note('audio', 'Lights follow the music. Beat flashes are limited to 3 per second; calm mode turns them off.');
  const status = { source: 'off' };
  tag(g5.add(status, 'source').name('Playing').listen().disable(), 'status');
  tag(g5.add(a, 'loadMusic').name('♫  Play a music file…'), 'primary');
  g5.add(a, 'useMic').name('🎤  Microphone');
  g5.add(a, 'useTab').name('⇆  Tab / system audio');
  const tr = g5.addFolder('Transport');
  tr.add(a, 'playPause').name('Play / pause');
  tr.add(a, 'stopAudio').name('Stop');
  const rs = g5.addFolder('Response');
  rs.add(state, 'reactivity', 0, 1, 0.01).name('Reactivity');
  rs.add(state, 'sensitivity', 0.3, 3, 0.01).name('Beat sensitivity');
  rs.add(state, 'calm').name('Calm mode (no flashes)');
  const lv = g5.addFolder('Levels');
  for (const [k, n] of [['bass', 'Bass'], ['mids', 'Mids'], ['highs', 'Highs']]) {
    tag(lv.add(audio.state, k, 0, 1).name(n).listen().disable(), 'meter');
  }
  tag(lv.add(audio.state, 'beatsPerSec', 0, 4).name('Beats / s').listen().disable(), 'meter');
  setInterval(() => {
    status.source = audio.kind === 'off' ? 'nothing – pick a source below'
      : `${audio.name}${audio.el?.paused ? ' (paused)' : ''}`;
  }, 400);

  // ---------------- View
  const g6 = gui.view;
  const cam = g6.addFolder('Camera');
  tag(cam.add(a, 'toggleFullscreen').name('⛶  Full screen'), 'primary');
  cam.add(state, 'autoRotate').name('Auto rotate').onChange(a.syncUniforms);
  cam.add(a, 'resetView').name('Reset view');
  cam.add(a, 'goInside').name('Go inside');
  const rd = g6.addFolder('Render');
  rd.add(state, 'autoQuality').name('Auto quality').onChange(a.resize);
  rd.add(state, 'renderScale', 0.25, 1.5, 0.05).name('Max render scale').onFinishChange(a.resize);
  rd.add(state, 'autoExposure').name('Auto exposure');
  rd.add(state, 'exposure', 0.1, 3, 0.01).name('Exposure').onChange(a.syncUniforms);
  rd.add(state, 'farGlow').name('Far-field glow');
  const bl = g6.addFolder('Bloom');
  bl.add(state, 'bloomStrength', 0, 3, 0.01).name('Strength').onChange(a.syncUniforms);
  bl.add(state, 'bloomRadius', 0, 1, 0.01).name('Radius').onChange(a.syncUniforms);
  bl.add(state, 'bloomThreshold', 0, 4, 0.01).name('Threshold').onChange(a.syncUniforms);
  const ad = g6.addFolder('Advanced');
  ad.add(state, 'forceMesh').name('Force BVH tracer').onChange(a.rebuildShape);
  ad.close();

  // ---------------- tabs
  const tabs = [...panel.querySelectorAll('.tab')];
  function showTab(id) {
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === id));
    for (const p of panel.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== id;
    panel.querySelector('.panes').scrollTop = 0;
    try { localStorage.setItem(TAB_KEY, id); } catch { /* private mode */ }
  }
  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  let saved = null;
  try { saved = localStorage.getItem(TAB_KEY); } catch { /* private mode */ }
  showTab(TABS.some((t) => t.id === saved) ? saved : 'shape');

  panel.querySelector('[data-act="fullscreen"]').addEventListener('click', () => a.toggleFullscreen());
  panel.querySelector('[data-act="collapse"]').addEventListener('click', (ev) => {
    const c = panel.classList.toggle('collapsed');
    ev.currentTarget.textContent = c ? '+' : '–';
    ev.currentTarget.title = c ? 'Open panel' : 'Minimise panel';
  });

  // 1–6 switch tabs (ignored while typing or while the shape editor is open)
  addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target.closest?.('input, select, textarea')) return;
    if (!document.getElementById('editor')?.hidden) return;
    const i = Number(ev.key) - 1;
    if (i >= 0 && i < TABS.length) {
      panel.classList.remove('collapsed');
      showTab(TABS[i].id);
    }
  });

  const all = Object.values(gui);
  const refresh = () => all.forEach((g) => g.controllersRecursive().forEach((c) => c.updateDisplay()));
  return { panel, refresh, showTab };
}
