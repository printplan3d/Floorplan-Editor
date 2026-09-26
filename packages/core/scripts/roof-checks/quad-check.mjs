// 4-point footprints that aren't rectangles follow the footprint (operator
// 2026-09-26, plan c39200da): the rectangle roof is cut back to each
// slanted edge + overhang and closed with a wall and fascia.
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { generateShellSegmentGeometry, shellHeightAtLocal } from '../../dist/systems/roof/shell-preview.js'
console.log = () => {}
const warns = []
console.warn = (...a) => warns.push(a.map(String).join(' ').slice(0, 140))
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
const r2 = (v) => Math.round(v * 100) / 100
let fails = 0
const ok = (c, l) => { P(`  ${c ? 'PASS' : 'FAIL'} ${l}`); if (!c) fails++ }

// The operator's segments (plan c39200da), as saved.
const SEGS = {
  '1qzul7': { pos: [2.16, 0, 2.47], ridgeAxis: 'east-west', width: 8.89, depth: 8.51, roofHeight: 6.9,
    polygon: [[-4.45, -4.26], [4.45, -4.26], [4.45, 4.26], [-8.53, 4.05]] },
  qfmucr: { pos: [-4.2, 0, 1.78], ridgeAxis: 'east-west', ridgeAngleDeg: -45, width: 3.73, depth: 7.13, roofHeight: 4.9,
    polygon: [[-2.77, -8.15], [1.87, -3.56], [-2.06, 4.63], [-8.8, -2.3]] },
}
for (const [id, d] of Object.entries(SEGS)) {
  const nodes = { level_0: { id: 'level_0', type: 'level', level: 0, children: ['w', 'roof'] },
    w: { id: 'w', type: 'wall', parentId: 'level_0', start: [40, 40], end: [41, 40], height: 2.7, thickness: 0.15, bulge: 0, children: [] },
    roof: { id: 'roof', type: 'roof', parentId: 'level_0', position: d.pos, rotation: 0, children: [id] },
    [id]: { id, type: 'roof-segment', parentId: 'roof', position: [0, 0, 0], rotation: 0, wallHeight: 0, overhang: 0.3, roofType: 'gable', ...d } }
  const r = resolveRoofContext(nodes).segments.get(id)
  const s = r.shape
  P(`\n${id}: ${s.footprintCuts.length} slanted edge(s)`)
  ok(s.footprintCuts.length > 0, 'footprint recognised as not a rectangle')
  const g = generateShellSegmentGeometry(r.placement.seg, r.opts)
  const pos = g.attributes.position.array
  const oh = s.frame.overhang
  let beyond = 0
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], z = pos[i + 2]
    for (const c of s.footprintCuts) if (c.n[0] * (x - c.a[0]) + c.n[1] * (z - c.a[1]) > oh + 1e-4) beyond++
  }
  ok(beyond === 0, `no roof past a slanted edge + overhang (${beyond} vertices)`)
  // A closing wall stands on each slanted edge line.
  const idx = g.index.array
  const walls = s.footprintCuts.map((c) => {
    let n = 0
    for (const gr of g.groups) if (gr.materialIndex === 0) for (let k = gr.start; k < gr.start + gr.count; k++) {
      const i = idx[k]; const x = pos[i * 3], z = pos[i * 3 + 2]
      if (Math.abs(c.n[0] * (x - c.a[0]) + c.n[1] * (z - c.a[1])) < 1e-4) n++
    }
    return n
  })
  ok(walls.every((n) => n >= 3), `closing wall on every slanted edge (${walls.join(', ')} verts)`)
  // Height field: nothing just outside a slanted edge, roof just inside.
  const c = s.footprintCuts[0]
  const mid = [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2]
  const out = shellHeightAtLocal(s, mid[0] + c.n[0] * 0.5, mid[1] + c.n[1] * 0.5)
  const inn = shellHeightAtLocal(s, mid[0] - c.n[0] * 0.5, mid[1] - c.n[1] * 0.5)
  ok(out == null && inn != null, `height field: outside ${out == null ? 'none' : r2(out)}, inside ${inn == null ? 'none' : r2(inn)}`)
  // Facing audit: slate up, soffit down.
  let bad = 0
  for (const gr of g.groups) for (let k = gr.start; k < gr.start + gr.count; k += 3) {
    const [a, b, cc] = [0, 1, 2].map((o) => { const i = idx[k + o]; return [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] })
    const u = b.map((v, j) => v - a[j]), v = cc.map((x, j) => x - a[j])
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const L = Math.hypot(...n); if (L < 1e-9) continue
    const ny = n[1] / L
    if ((gr.materialIndex === 1 && ny < 0.05) || (gr.materialIndex === 2 && ny > 0.05 && ny < 0.99)) bad++
  }
  ok(bad === 0, `facing audit clean (${bad} wrong)`)
}
P(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAIL(S)`} | warnings: ${warns.length ? warns.join(' | ') : 'none'}`)
