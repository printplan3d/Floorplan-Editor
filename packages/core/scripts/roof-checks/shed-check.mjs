// A Shed roof section is one slope: low eave on edge 0, rising to a high
// wall on the opposite side (operator 2026-09-26: it used to be built with
// a near-vertical second "slope" that ran 150 m into the ground).
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { roofMeshesForExport } from '../../dist/systems/roof/roof-export.js'
console.log = () => {}
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
let fails = 0
const ok = (c, l) => { P(`  ${c ? 'PASS' : 'FAIL'} ${l}`); if (!c) fails++ }
const nodes = {
  level_0: { id: 'level_0', type: 'level', level: 0, children: ['w', 'roof_s'] },
  w: { id: 'w', type: 'wall', parentId: 'level_0', start: [40, 40], end: [41, 40], height: 2.7, thickness: 0.15, bulge: 0, children: [] },
  roof_s: { id: 'roof_s', type: 'roof', parentId: 'level_0', position: [2, 0, 1.5], rotation: 0, children: ['s'] },
  s: { id: 's', type: 'roof-segment', parentId: 'roof_s', position: [0, 0, 0], rotation: 0, roofType: 'shed', ridgeAxis: 'north-south', width: 4, depth: 3, roofHeight: 1.2, wallHeight: 0, overhang: 0.3 },
}
const ctx = resolveRoofContext(nodes)
const m = roofMeshesForExport(nodes, ctx).get('s')
const ys = m.vertices.filter((_, i) => i % 3 === 1)
P(`\nshed 4 x 3 m, rise 1.2 m on a 2.7 m storey: world y ${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)}`)
ok(Math.min(...ys) > 2.7 - 0.6 && Math.max(...ys) < 2.7 + 1.2 + 0.05, 'nothing below the eave (fascia) or above the high wall')
const h = (x, z) => ctx.heightAt(x, z)
ok(Math.abs(h(2, 0.05) - (2.7 + 1.2 * 0.05 / 3)) < 0.05, `low side at the eave (${h(2, 0.05).toFixed(2)})`)
ok(Math.abs(h(2, 2.95) - (2.7 + 1.2 * 2.95 / 3)) < 0.05, `high side at the wall top (${h(2, 2.95).toFixed(2)})`)
ok(Math.abs(h(2, 1.5) - 3.3) < 0.05, `one straight slope (mid ${h(2, 1.5).toFixed(2)})`)
ok(h(2, 3.5) == null, 'nothing past the high wall + overhang')
P(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`)
process.exit(fails ? 1 : 0)
