# Roof checks (off-browser)

Fast verification of the roof preview against real plan data, with no Chrome
involved. Everything runs the COMPILED core output, so build first.

```bash
cd packages/core
npx tsc --build
node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/scene-check.mjs
node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/geom-check.mjs
node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/clip-check.mjs
node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/gap-check.mjs
node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/union-check.mjs
node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/arc-clip-check.mjs
```

- `plan-fixture.mjs` — a real two-storey plan (22 walls, 17 openings, 3 roofs)
  rebuilt as a node graph. `buildPlan({ dormerWindow, extra })` varies it.
- `scene-check.mjs` — junctions, level matching, real-wall parapets, dormer
  window overrides, and the roof height over the level-1 wall and window.
- `geom-check.mjs` — builds every resolved segment and audits triangle facing
  (slate up, soffit down) and material slots; includes synthetic L plans.
- `clip-check.mjs` — trims a wall with a real window opening to the roof.
- `arc-clip-check.mjs` — real curved (and straight) wall meshes under a
  slope: nothing above the roof after trimming, and the wall still reaches
  it everywhere.
- `gap-check.mjs` — ray tests for holes at edges, seams, gable ends, slots.
- `union-check.mjs` — meeting roofs read as one: no face buried in another
  roof, the level-1 room not split, infill down to the wall top, shared side
  lines. Fails 7/13 with the neighbour clipping turned off.
- `register.mjs` / `ext-loader.mjs` — the compiled output uses extensionless
  imports; this hook lets plain Node resolve them.

Why this exists: in a hidden or minimised Chrome window, rAF and
ResizeObserver are suspended, so the 3D preview can't be trusted for
verification there. A synthetic CSG repro also once failed to reproduce a real
bug — use the real plan data.
