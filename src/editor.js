// 2D outline editor: draw any (non-self-intersecting) polygon and turn it into
// a classic infinity panel or a 3D prism.
import { starOutline, heartOutline, crossOutline, polygonOutline, fitOutline } from './shapes.js';

const SIZE = 440;          // canvas px
const VIEW = 1.2;          // canvas spans [-0.6, 0.6]
const GRID = 0.05;

const toPx = ([x, y]) => [(x / VIEW + 0.5) * SIZE, (0.5 - y / VIEW) * SIZE];
const toWorld = (px, py) => [(px / SIZE - 0.5) * VIEW, (0.5 - py / SIZE) * VIEW];

function segIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function validateOutline(pts) {
  if (pts.length < 3) return 'Need at least 3 points';
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // neighbours share a vertex
      if (segIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return 'Outline crosses itself';
    }
  }
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  if (Math.abs(area) < 1e-3) return 'Outline is too small';
  return null;
}

export function createEditor({ onApply }) {
  const root = document.createElement('div');
  root.id = 'editor';
  root.hidden = true;
  root.innerHTML = `
    <div class="ed-panel">
      <div class="ed-head">Shape editor
        <span class="ed-hint">click: add point · drag: move · right-click: delete</span></div>
      <canvas width="${SIZE}" height="${SIZE}"></canvas>
      <div class="ed-row">
        <button data-preset="star">Star</button>
        <button data-preset="heart">Heart</button>
        <button data-preset="cross">Cross</button>
        <button data-preset="poly">Polygon</button>
        <input class="ed-n" type="number" min="3" max="32" value="6" title="polygon sides">
        <button data-act="clear">Clear</button>
      </div>
      <div class="ed-row">
        <label><input type="radio" name="ed-mode" value="panel" checked> classic panel</label>
        <label><input type="radio" name="ed-mode" value="prism"> 3D prism</label>
        <label>thickness <input class="ed-thick" type="range" min="0.05" max="1" step="0.01" value="0.35"></label>
        <label><input class="ed-snap" type="checkbox" checked> snap</label>
      </div>
      <div class="ed-row ed-foot">
        <span class="ed-msg"></span>
        <button data-act="close">Close</button>
        <button data-act="apply" class="ed-primary">Apply</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const msg = root.querySelector('.ed-msg');
  const applyBtn = root.querySelector('[data-act="apply"]');
  const snapBox = root.querySelector('.ed-snap');
  const thick = root.querySelector('.ed-thick');

  let pts = [];
  let drag = -1;
  let hover = -1;

  const snap = (p) => (snapBox.checked ? p.map((v) => Math.round(v / GRID) * GRID) : p);
  const clamp = (p) => p.map((v) => Math.max(-0.58, Math.min(0.58, v)));

  function eventPos(ev) {
    const r = canvas.getBoundingClientRect();
    return [((ev.clientX - r.left) * SIZE) / r.width, ((ev.clientY - r.top) * SIZE) / r.height];
  }
  function vertexAt(px, py) {
    return pts.findIndex((p) => { const [x, y] = toPx(p); return Math.hypot(x - px, y - py) < 9; });
  }
  // Where to insert a new point: the segment it is clicked on, otherwise the
  // segment whose detour through the point adds the least perimeter.
  function insertAfter(p) {
    const [px, py] = toPx(p);
    let near = -1, nearD = 10, cheap = 0, cheapCost = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const A = pts[i], B = pts[(i + 1) % pts.length];
      const [ax, ay] = toPx(A), [bx, by] = toPx(B);
      const dx = bx - ax, dy = by - ay;
      const s = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(px - ax - s * dx, py - ay - s * dy);
      if (d < nearD) { nearD = d; near = i; }
      const cost = Math.hypot(p[0] - A[0], p[1] - A[1]) + Math.hypot(p[0] - B[0], p[1] - B[1]) -
                   Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (cost < cheapCost) { cheapCost = cost; cheap = i; }
    }
    return near >= 0 ? near : cheap;
  }

  function draw() {
    ctx.fillStyle = '#0b0c10';
    ctx.fillRect(0, 0, SIZE, SIZE);
    for (let g = -0.6; g <= 0.6001; g += GRID) {
      const major = Math.abs(g) < 1e-6 ? '#3a3f4b' : Math.abs((g / 0.25) % 1) < 1e-6 ? '#1f232c' : '#14171d';
      ctx.strokeStyle = major;
      const [x] = toPx([g, 0]), [, y] = toPx([0, g]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(SIZE, y); ctx.stroke();
    }
    const [bx0, by0] = toPx([-0.5, 0.5]);
    ctx.strokeStyle = '#2b3140';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(bx0, by0, SIZE / VIEW, SIZE / VIEW);
    ctx.setLineDash([]);

    const err = validateOutline(pts);
    if (pts.length) {
      ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = toPx(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fillStyle = err ? 'rgba(255,80,80,0.12)' : 'rgba(255,42,109,0.16)';
      ctx.fill();
      ctx.strokeStyle = err ? '#ff5050' : '#ff2a6d';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
      pts.forEach((p, i) => {
        const [x, y] = toPx(p);
        ctx.beginPath();
        ctx.arc(x, y, i === hover || i === drag ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#ffd166' : '#e8e8f0';
        ctx.fill();
      });
    }
    msg.textContent = err ? err : `${pts.length} points`;
    msg.classList.toggle('ed-err', !!err);
    applyBtn.disabled = !!err;
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const [px, py] = eventPos(ev);
    let i = vertexAt(px, py);
    if (i < 0) {
      const p = clamp(snap(toWorld(px, py)));
      if (pts.length >= 3) { i = insertAfter(p) + 1; pts.splice(i, 0, p); }
      else { pts.push(p); i = pts.length - 1; }
    }
    drag = i;
    canvas.setPointerCapture(ev.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (ev) => {
    const [px, py] = eventPos(ev);
    if (drag >= 0) pts[drag] = clamp(snap(toWorld(px, py)));
    else hover = vertexAt(px, py);
    draw();
  });
  canvas.addEventListener('pointerup', () => { drag = -1; draw(); });
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const [px, py] = eventPos(ev);
    const i = vertexAt(px, py);
    if (i >= 0) { pts.splice(i, 1); hover = -1; draw(); }
  });

  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const preset = b.dataset.preset;
    if (preset === 'star') pts = starOutline(5);
    if (preset === 'heart') pts = heartOutline(32);
    if (preset === 'cross') pts = crossOutline();
    if (preset === 'poly') pts = polygonOutline(Math.max(3, Math.min(32, +root.querySelector('.ed-n').value || 6)));
    if (b.dataset.act === 'clear') pts = [];
    if (b.dataset.act === 'close') close();
    if (b.dataset.act === 'apply' && !validateOutline(pts)) {
      const mode = root.querySelector('input[name="ed-mode"]:checked').value;
      onApply({ outline: fitOutline(pts), mode, thickness: +thick.value });
      close();
    }
    draw();
  });
  addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !root.hidden) close(); });

  function open(current) {
    pts = current.outline.map((p) => [...p]);
    root.querySelector(`input[name="ed-mode"][value="${current.mode}"]`).checked = true;
    thick.value = current.thickness;
    root.hidden = false;
    draw();
  }
  function close() { root.hidden = true; }

  return { open, close };
}
