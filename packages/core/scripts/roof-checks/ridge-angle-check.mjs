// Ridge at an angle with the footprint left where it was drawn (operator
// 2026-09-26: a diagonal house). The roof is built in the ridge's frame.
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { generateShellSegmentGeometry } from '../../dist/systems/roof/shell-preview.js'
console.log = () => {}
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
const r2 = (v) => Math.round(v * 100) / 100
let fails = 0
const ok = (c, l) => { P(`  ${c ? 'PASS' : 'FAIL'} ${l}`); if (!c) fails++ }

const plan = (seg) => {
  const nodes = { level_0: { id: 'level_0', type: 'level', level: 0, children: ['w', 'roof'] },
    w: { id: 'w', type: 'wall', parentId: 'level_0', start: [0, 0], end: [1, 0], height: 2.7, thickness: 0.15, bulge: 0, children: [] },
    roof: { id: 'roof', type: 'roof', parentId: 'level_0', position: [2, 0, 3], rotation: 0, children: ['s'] },
    s: { id: 's', type: 'roof-segment', parentId: 'roof', position: [0, 0, 0], rotation: 0, wallHeight: 0, overhang: 0.3,
      roofType: 'gable', ridgeAxis: 'east-west', width: 10, depth: 6, roofHeight: 3, ...seg } }
  return resolveRoofContext(nodes).segments.get('s')
}
const world = (r) => r.shape.polygon.map(([x, z]) => [r.placement.tx + r.placement.cos * x + r.placement.sin * z, r.placement.tz - r.placement.sin * x + r.placement.cos * z])

P('\nangle 0 changes nothing')
{
  const a = plan({}), b = plan({ ridgeAngleDeg: 0 })
  const ga = generateShellSegmentGeometry(a.placement.seg, a.opts).attributes.position.array
  const gb = generateShellSegmentGeometry(b.placement.seg, b.opts).attributes.position.array
  ok(ga.length === gb.length && ga.every((v, i) => v === gb[i]) && a.placement.cos === b.placement.cos,
    'identical geometry and placement')
}

P('\ndiagonal house: 10 x 6 rectangle drawn as a 4-point footprint turned 45 deg')
{
  const t = Math.PI / 4, c = Math.cos(t), s = Math.sin(t)
  // local corners of a 10 x 6 rectangle, turned 45 deg in plan (x, z)
  const poly = [[-5, -3], [5, -3], [5, 3], [-5, 3]].map(([x, z]) => [x * c - z * s, x * s + z * c])
  // "Align to footprint": longest edge P1 -> P2, three rotation-y sense
  const dx = poly[1][0] - poly[0][0], dz = poly[1][1] - poly[0][1]
  const deg = Math.round((Math.atan2(-dz, dx) * 180) / Math.PI)
  const before = plan({ polygon: poly })
  const after = plan({ polygon: poly, ridgeAngleDeg: deg })
  const area = (r) => (r.shape.frame.uMax - r.shape.frame.uMin) * (r.shape.frame.vMax - r.shape.frame.vMin)
  P(`    align angle ${deg} deg; roof area before ${r2(area(before))} m2 (bounding box), after ${r2(area(after))} m2 (footprint 60)`)
  ok(Math.abs(area(after) - 60) < 0.01, 'roof covers exactly the footprint')
  const W = world(after), target = poly.map(([x, z]) => [2 + x, 3 + z])
  const matched = target.every((p) => W.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6))
  ok(matched, 'roof corners sit on the drawn footprint corners (footprint not moved)')
  const f = after.shape.frame
  const r0 = [f.uMin, f.vMid], r1 = [f.uMax, f.vMid]
  const w0 = [after.placement.cos * r0[0] + after.placement.sin * r0[1], -after.placement.sin * r0[0] + after.placement.cos * r0[1]]
  const w1 = [after.placement.cos * r1[0] + after.placement.sin * r1[1], -after.placement.sin * r1[0] + after.placement.cos * r1[1]]
  const rd = [w1[0] - w0[0], w1[1] - w0[1]], ed = [dx, dz]
  const cross = Math.abs(rd[0] * ed[1] - rd[1] * ed[0]) / (Math.hypot(...rd) * Math.hypot(...ed))
  ok(cross < 1e-6 && Math.abs(Math.hypot(...rd) - 10) < 1e-6, `ridge runs along the house's 10 m side (${r2(Math.hypot(...rd))} m)`)
}
P(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAIL(S)`}`)
