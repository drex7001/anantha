# anantha · අනන්ත

A ray-traced LED infinity mirror simulator that runs in the browser (Three.js + WebGL2).

Every pixel's ray is traced through the two-way glass and bounces between the
mirror faces, losing a little light at each bounce. That is what produces the
endless tunnel of LEDs.

## Features

- **Ray-traced mirrors.** Two-way glass (reflect/transmit), full mirrors, black
  walls, the green tint of glass and room light are all adjustable.
- **25 built-in shapes:**
  - classic round, square, star and heart panels
  - an infinity cube, prisms, and Platonic and Archimedean solids
  - star polyhedra, a torus, an ∞ tube and a walk-in mirror room
- **Any closed mesh.** You can draw an outline in the shape editor or import
  an STL, OBJ or GLB file. Convex shapes use a fast plane tracer; all other
  shapes use a BVH.
- **LED strips.**
  - Strips can go on any set of edges: all, window ring, back ring, vertical,
    horizontal or alternate.
  - Each strip can be single or double. Row 2 can use the same colours, run in
    reverse or use the complementary colour, with optional stagger.
  - There are 9 colour patterns.
- **Rendering.**
  - Bloom glow.
  - A far-field glow that estimates the bounces beyond the trace limit.
  - Auto exposure.
  - Auto quality, which adapts the resolution to keep the frame rate up.
- **Full screen.** Press `F` for full screen and `H` to hide the controls.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
```

Requires a browser with WebGL2. Development and testing were done in Chrome on
an Intel UHD 630 (integrated GPU).

## Controls

| Input | Action |
|---|---|
| drag / scroll | orbit / zoom |
| `F` | full screen on/off |
| `H` | show/hide the controls |
| panel on the right | shape, mirrors, LED strips, pattern, render, view |

## Code layout

| File | What it does |
|---|---|
| `src/mirrorShader.js` | Full-screen ray tracer (convex planes or BVH), LED strips, ray-cone anti-aliasing |
| `src/shapes.js` | Shape library, mesh analysis (planar faces, feature edges, convexity) |
| `src/bvh.js` | BVH build and GPU packing |
| `src/leds.js` | LED strips → data textures, per-frame colours |
| `src/patterns.js` | LED colour patterns |
| `src/editor.js` | 2D outline editor |
| `src/importer.js` | STL / OBJ / GLB import |
| `src/main.js` | Renderer, bloom, auto quality and exposure, far-field glow, full screen |
| `src/ui.js` | Control panel (lil-gui) |
