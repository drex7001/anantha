import GUI from 'lil-gui';

export function createUI(state, a, shapeNames, patternNames) {
  const gui = new GUI({ title: 'Infinity Mirror' });
  const refresh = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());

  const fShape = gui.addFolder('Shape');
  fShape.add(state, 'shape', shapeNames).name('shape').onChange(a.selectShape);
  fShape.add(a, 'openEditor').name('✎ shape editor…');
  fShape.add(a, 'importModel').name('⇪ import model (stl/obj/glb)…');
  fShape.add(state, 'size', 0.15, 2, 0.01).name('size (m)').onFinishChange(a.rebuildShape);
  fShape.add(state, 'depth', 0.02, 0.3, 0.005).name('panel depth (m)').onFinishChange(a.rebuildShape);
  fShape.add(state, 'edgeAngle', 1, 89, 1).name('LED edge angle (°)').onFinishChange(a.rebuildShape);

  const fMirror = gui.addFolder('Mirrors');
  fMirror.add(state, 'faceMode', {
    'all two-way (cube)': 'cube',
    'window + mirrors (box)': 'box',
    'window + back + black sides (panel)': 'panel',
    'all mirrors (room)': 'room',
  }).name('faces').onChange(a.syncUniforms);
  fMirror.add(state, 'twoWayR', 0, 0.99, 0.01).name('two-way reflect').onChange(a.syncUniforms);
  fMirror.add(state, 'twoWayT', 0, 1, 0.01).name('two-way transmit').onChange(a.syncUniforms);
  fMirror.add(state, 'mirrorR', 0, 0.999, 0.001).name('mirror reflect').onChange(a.syncUniforms);
  fMirror.add(state, 'glassGreen', 0, 0.06, 0.001).name('glass green tint').onChange(a.syncUniforms);
  fMirror.add(state, 'maxBounces', 1, 256, 1).name('max bounces').onChange(a.syncUniforms);
  fMirror.add(state, 'roomLight', 0, 3, 0.01).name('room light').onChange(a.syncUniforms);

  const fLed = gui.addFolder('LED strips');
  fLed.add(state, 'strips', {
    'all edges': 'all', 'window ring': 'window', 'back ring': 'back',
    vertical: 'vertical', horizontal: 'horizontal', alternate: 'alternate',
  }).name('edges').onChange(a.rebuildLeds);
  fLed.add(state, 'ledDensity', 10, 144, 1).name('LEDs / m').onFinishChange(a.rebuildLeds);
  fLed.add(state, 'stripWidthMm', 1, 20, 0.5).name('strip width (mm)').onChange(a.syncUniforms);
  fLed.add(state, 'doubleStrip').name('double strip').onChange(() => { a.syncUniforms(); a.rebuildLeds(); });
  fLed.add(state, 'rowGapMm', 2, 30, 0.5).name('row gap (mm)').onChange(a.syncUniforms);
  fLed.add(state, 'row2', { same: 'same', 'reverse direction': 'reverse', 'complement colour': 'complement' })
    .name('row 2 colours').onChange(a.rebuildLeds);
  fLed.add(state, 'stagger').name('stagger rows').onChange(a.syncUniforms);
  fLed.add(state, 'ledSizeMm', 0.5, 6, 0.1).name('LED size (mm)').onChange(a.syncUniforms);
  fLed.add(state, 'ledIntensity', 0.5, 40, 0.1).name('LED intensity').onChange(a.syncUniforms);
  fLed.add(state, 'stripGlow', 0, 0.5, 0.01).name('strip glow').onChange(a.syncUniforms);

  const fPat = gui.addFolder('Pattern');
  fPat.add(state, 'pattern', patternNames);
  fPat.add(state, 'speed', 0, 5, 0.01).onChange(a.syncUniforms);
  fPat.add(state, 'hueSpread', 0, 4, 0.01).name('hue spread').onChange(a.syncUniforms);
  fPat.addColor(state, 'color').onChange(a.syncUniforms);
  fPat.add(state, 'brightness', 0, 2, 0.01);

  const fRender = gui.addFolder('Render');
  fRender.add(state, 'autoQuality').name('auto quality').onChange(a.resize);
  fRender.add(state, 'renderScale', 0.25, 1.5, 0.05).name('max render scale').onFinishChange(a.resize);
  fRender.add(state, 'farGlow').name('far-field glow');
  fRender.add(state, 'autoExposure').name('auto exposure');
  fRender.add(state, 'bloomStrength', 0, 3, 0.01).name('bloom strength').onChange(a.syncUniforms);
  fRender.add(state, 'bloomRadius', 0, 1, 0.01).name('bloom radius').onChange(a.syncUniforms);
  fRender.add(state, 'bloomThreshold', 0, 4, 0.01).name('bloom threshold').onChange(a.syncUniforms);
  fRender.add(state, 'exposure', 0.1, 3, 0.01).onChange(a.syncUniforms);
  fRender.add(state, 'forceMesh').name('force BVH tracer').onChange(a.rebuildShape);
  fRender.close();

  const fView = gui.addFolder('View');
  fView.add(a, 'toggleFullscreen').name('⛶ full screen (F) · hide controls (H)');
  fView.add(state, 'autoRotate').name('auto rotate').onChange(a.syncUniforms);
  fView.add(a, 'resetView').name('reset view');
  fView.add(a, 'goInside').name('go inside');

  return { gui, refresh };
}
