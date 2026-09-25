// Gaps and stray planes, checked the way you'd see them: horizontal rays
// fired at the house must hit a wall. Uses the operator's CURRENT north roof
// (depth 4.5, west pitch 0.249, east 0.577 -> eaves 5.54 / 4.23 world).
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { generateShellSegmentGeometry } from '../../dist/systems/roof/shell-preview.js'
import { buildPlan } from './plan-fixture.mjs'
console.log = () => {}
const warns = []
console.warn = (...a) => warns.push(a.map(String).join(' ').slice(0, 140))
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
const r2 = (v) => (v == null ? 'null' : Math.round(v * 100) / 100)

const current = buildPlan({
  extra: {
    rseg_7ywyzq: {
      depth: 4.499, edgeWeights: [0.577, 0.577, 0.577, 0.249],
      dormers: [{ id: 'dorm1', type: 'gable', parentFaceId: 0, ridgeHeight: 1.5, cheekWidth: 2.6,
        ridgeOrientation: 'orthogonal', footOnParent: [[0.335, 0.275], [0.565, 0.425]] }],
    },
    rseg_iz8x9q: { edgeWeights: undefined },
  },
})

const ctx = resolveRoofContext(current)
const tris = [] // world-space triangles of every roof shell
for (const [id, r] of ctx.segments) {
  const o = r.opts
  P(`${id.padEnd(13)} styles=${JSON.stringify(r.shape.styles)} ridgeY=${r2(r.placement.baseY + r.shape.frame.ridgeZ)}`,
    o.realWalls ? `realWalls=${JSON.stringify(o.realWalls.map((w) => [w.edge, r2(w.t0), r2(w.t1), r2(w.top), r2(w.inset)]))}` : '',
    o.noInteriorCap ? 'noInteriorCap' : 'CAP')
  const g = generateShellSegmentGeometry(r.placement.seg, o)
  const p = g.attributes.position.array
  const idx = g.index.array
  const pl = r.placement
  const W = (i) => {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2]
    return [pl.tx + pl.cos * x + pl.sin * z, pl.baseY + y, pl.tz - pl.sin * x + pl.cos * z]
  }
  for (let t = 0; t < idx.length; t += 3) tris.push([W(idx[t]), W(idx[t + 1]), W(idx[t + 2]), id])
}

// Moller-Trumbore, both faces.
function hit(o, d) {
  let best = null
  for (const [a, b, c, id] of tris) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]]
    const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2]
    if (Math.abs(det) < 1e-12) continue
    const inv = 1 / det
    const tv = [o[0] - a[0], o[1] - a[1], o[2] - a[2]]
    const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * inv
    if (u < 0 || u > 1) continue
    const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]]
    const v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) * inv
    if (v < 0 || u + v > 1) continue
    const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv
    if (t > 1e-6 && (!best || t < best.t)) best = { t, id, y: o[1] }
  }
  return best
}

const report = (label, o, d, maxT) => {
  const h = hit(o, d)
  const ok = h && h.t <= maxT
  P(`  ${ok ? 'CLOSED' : 'OPEN  '} ${label}${h ? `  hit ${h.id} at ${r2(h.t)} m` : '  (nothing)'}`)
  return ok
}

let open = 0
P('\n1) West edge where level 1 has NO wall (z = -1.5, north of the L1 wall end at -2.27)')
for (const y of [3.2, 4.0, 5.0]) if (!report(`y=${y}`, [-13.5, y, -1.5], [1, 0, 0], 1.6)) open++

P('\n2) Seam between the roofs (z = -5.24): looking north from above the south roof')
for (const [x, y] of [[-11.0, 5.0], [-11.0, 5.4], [-5.0, 4.5], [-8.0, 6.3]]) {
  const hs = ctx.heightAt(x, -5.6)
  if (hs != null && y <= hs + 0.05) { P(`  (skip x=${x} y=${y}: under the south roof, ${r2(hs)})`); continue }
  if (!report(`x=${x} y=${y}`, [x, y, -5.6], [0, 0, 1], 0.6)) open++
}

P('\n3) Flat interior plane: a ray straight DOWN inside the house, between the L1 walls')
{
  const h = hit([-9.0, 5.0, -3.5], [0, -1, 0])
  const plane = h && h.y !== undefined && h.t < 2.2
  P(`  ${plane ? 'PLANE FOUND' : 'no plane   '}  ${h ? `hit ${h.id} after ${r2(h.t)} m (y=${r2(5.0 - h.t)})` : '(nothing)'}`)
  if (plane) open++
}

P('\n4) North gable end (z = -0.745), looking south')
for (const [x, y] of [[-11.5, 3.2], [-8.1, 6.0], [-5.0, 3.5]]) if (!report(`x=${x} y=${y}`, [x, y, 0.5], [0, 0, -1], 1.4)) open++

P('\n5) The slot between the roof edge (x=-12.15) and the inset L1 wall (x=-11.85), looking along it')
for (const y of [3.5, 4.5]) if (!report(`y=${y} from the open stretch toward the L1 wall`, [-12.0, y, -1.5], [0, 0, -1], 1.0)) open++

P(`\n${open === 0 ? 'ALL CLOSED' : `${open} OPENING(S)`} | union warnings: ${warns.length ? warns.join(' | ') : 'none'}`)
