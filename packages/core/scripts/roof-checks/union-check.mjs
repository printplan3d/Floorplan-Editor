// Meeting roofs must read as ONE roof: no face of one roof inside another,
// the level-1 room not split by gable walls, the wall infill reaching down to
// the storey wall top, and continuation masses sharing their side lines.
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { generateShellSegmentGeometry, shellHeightAtLocal } from '../../dist/systems/roof/shell-preview.js'
import { buildPlan } from './plan-fixture.mjs'
console.log = () => {}
const warns = []
console.warn = (...a) => warns.push(a.map(String).join(' ').slice(0, 140))
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
const r2 = (v) => (v == null ? 'null' : Math.round(v * 1000) / 1000)
let fails = 0
const ok = (cond, label) => { P(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); if (!cond) fails++ }

const local = (pl, X, Z) => { const dx = X - pl.tx, dz = Z - pl.tz; return [pl.cos * dx - pl.sin * dz, pl.sin * dx + pl.cos * dz] }

function worldTris(ctx) {
  const out = []
  for (const [id, r] of ctx.segments) {
    const g = generateShellSegmentGeometry(r.placement.seg, r.opts)
    const p = g.attributes.position.array, idx = g.index.array, pl = r.placement
    const W = (i) => [pl.tx + pl.cos * p[i * 3] + pl.sin * p[i * 3 + 2], pl.baseY + p[i * 3 + 1], pl.tz - pl.sin * p[i * 3] + pl.cos * p[i * 3 + 2]]
    for (let t = 0; t < idx.length; t += 3) out.push([W(idx[t]), W(idx[t + 1]), W(idx[t + 2]), id])
  }
  return out
}

/** Triangles (by centroid) buried more than 3 cm inside ANOTHER roof. */
function buried(ctx, tris) {
  let n = 0
  for (const [a, b, c, id] of tris) {
    const m = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3)
    for (const [oid, o] of ctx.segments) {
      if (oid === id) continue
      const f = o.shape.frame, pl = o.placement
      const [x, z] = local(pl, m[0], m[2])
      const u = f.ridgeAlongX ? x : z, v = f.ridgeAlongX ? z : x
      const M = 0.03
      if (u < f.uMin + M || u > f.uMax - M || v < f.vMin + M || v > f.vMax - M) continue
      const h = shellHeightAtLocal({ ...o.shape, dormers: [] }, x, z)
      if (h == null) continue
      if (m[1] < pl.baseY + h - M && m[1] > pl.baseY + (o.shape.infillFloor ?? 0) + M) { n++; break }
    }
  }
  return n
}

function hit(tris, o, d) {
  let best = null
  for (const [a, b, c, id] of tris) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]]
    const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2]
    if (Math.abs(det) < 1e-12) continue
    const inv = 1 / det, tv = [o[0] - a[0], o[1] - a[1], o[2] - a[2]]
    const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * inv
    if (u < 0 || u > 1) continue
    const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]]
    const v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) * inv
    if (v < 0 || u + v > 1) continue
    const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv
    if (t > 1e-6 && (!best || t < best.t)) best = { t, id }
  }
  return best
}

// ── Operator's current plan ──
const plan = buildPlan({ extra: { rseg_7ywyzq: { depth: 4.499, edgeWeights: [0.577, 0.577, 0.577, 0.249] }, rseg_iz8x9q: { edgeWeights: undefined } } })
const ctx = resolveRoofContext(plan)
const tris = worldTris(ctx)
P('\nOperator plan (north + south roofs over the one level-1 room)')
ok(buried(ctx, tris) === 0, `no roof face buried inside another roof (${buried(ctx, tris)} found)`)
{
  const h = hit(tris, [-9.0, 3.5, -3.0], [0, 0, -1])
  ok(!h || h.t > 3.3, `level-1 room not split at the seam (z=-5.24): ray from z=-3 south ${h ? `hits ${h.id} after ${r2(h.t)} m` : 'hits nothing'}`)
}
{
  const n = ctx.segments.get('rseg_7ywyzq')
  ok(n.shape.infillFloor < -0.1, `north roof lifted ${r2(-n.shape.infillFloor)} m -> infill floor at local ${r2(n.shape.infillFloor)}`)
  const h = hit(tris, [-8.0, 2.77, 0.5], [0, 0, -1])
  ok(!!h && h.t < 1.4, `north gable closed down to the wall top (y=2.77) ${h ? `hit ${h.id} at ${r2(h.t)}` : 'nothing'}`)
}
{
  const n = ctx.segments.get('rseg_7ywyzq'), s = ctx.segments.get('rseg_iz8x9q')
  const side = (r) => { const f = r.shape.frame, pl = r.placement; return [pl.tx + f.vMin, pl.tx + f.vMax] } // ridge along Z: v = x
  const [a, b] = [side(n), side(s)]
  ok(Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3, `side lines shared: north x=[${a.map(r2)}] south x=[${b.map(r2)}]`)
  ok(Math.abs((a[0] + a[1]) / 2 - (b[0] + b[1]) / 2) < 1e-3, 'ridges on one line (no kink)')
}

// ── Perpendicular gables (T/L) ──
function lPlan(wingType, extra = {}) {
  const nodes = { level_0: { id: 'level_0', type: 'level', level: 0, children: [] } }
  nodes.w0 = { id: 'w0', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.7, thickness: 0.15, bulge: 0, children: [] }
  nodes.level_0.children.push('w0')
  const add = (rid, pos, sid, seg) => {
    nodes[rid] = { id: rid, type: 'roof', parentId: 'level_0', position: pos, rotation: 0, children: [sid] }
    nodes.level_0.children.push(rid)
    nodes[sid] = { id: sid, type: 'roof-segment', parentId: rid, position: [0, 0, 0], rotation: 0, wallHeight: 0, overhang: 0.3, ...seg }
  }
  add('roof_A', [5, 0, 3], 'seg_A_main', { roofType: 'gable', ridgeAxis: 'east-west', width: 10, depth: 6, roofHeight: 3 })
  add('roof_B', [3, 0, 5], 'seg_B_wing', { roofType: wingType, ridgeAxis: 'north-south', width: 6, depth: 10, roofHeight: 2.2, ...extra })
  return nodes
}
for (const [label, nodes] of [
  ['L: gable main + gable wing, level ridges', lPlan('gable')],
  ['L: gable main + hip wing', lPlan('hip')],
  ['L: gable wing, dropped ridge (pitch)', lPlan('gable', { ridgeMatch: 'pitch' })],
]) {
  const c = resolveRoofContext(nodes)
  const t = worldTris(c)
  P(`\n${label}`)
  ok(buried(c, t) === 0, `no roof face buried inside the other (${buried(c, t)} found)`)
  // Inside the house under the valley: horizontal rays must not meet a
  // leftover gable/eave wall between the two volumes.
  const h = hit(t, [3.0, 3.2, 2.0], [0, 0, 1])
  ok(!h || h.t > 5.5, `under-roof ray from the main into the wing runs clear ${h ? `(hits ${h.id} after ${r2(h.t)} m)` : ''}`)
}

P(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAIL(S)`} | union warnings: ${warns.length ? warns.join(' | ') : 'none'}`)
