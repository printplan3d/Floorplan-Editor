// Every dormer has a window (operator, 2026-09-26). A free dormer gets its
// own: a recess cut into its front with an outward-facing glass pane at the
// back. A dormer built over a real window gets none (that window is it).
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { generateShellSegmentGeometry, SLOT_GLASS } from '../../dist/systems/roof/shell-preview.js'
import { buildPlan } from './plan-fixture.mjs'
console.log = () => {}
const warns = []
console.warn = (...a) => warns.push(a.map(String).join(' ').slice(0, 140))
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
const r2 = (v) => Math.round(v * 100) / 100
let fails = 0
const ok = (c, l) => { P(`  ${c ? 'PASS' : 'FAIL'} ${l}`); if (!c) fails++ }

function glassOf(g) {
  const pos = g.attributes.position, idx = g.index
  const tris = []
  for (const gr of g.groups) {
    if (gr.materialIndex !== SLOT_GLASS) continue
    for (let k = gr.start; k < gr.start + gr.count; k += 3) {
      tris.push([0, 1, 2].map((o) => { const i = idx.getX(k + o); return [pos.getX(i), pos.getY(i), pos.getZ(i)] }))
    }
  }
  return tris
}

for (const type of ['gable', 'shed', 'hip']) {
  const plan = buildPlan({ extra: { rseg_7ywyzq: { depth: 4.499, edgeWeights: [0.577, 0.577, 0.577, 0.249],
    dormers: [{ id: 'dorm1', type, parentFaceId: 0, ridgeHeight: 1.5, cheekWidth: 2.6, ridgeOrientation: 'orthogonal',
      footOnParent: [[0.335, 0.275], [0.565, 0.425]] }] } } })
  const r = resolveRoofContext(plan).segments.get('rseg_7ywyzq')
  const d = r.shape.dormers[0]
  const g = generateShellSegmentGeometry(r.placement.seg, r.opts)
  const tris = glassOf(g)
  P(`\nfree ${type} dormer (front at world y ${r2(r.placement.baseY + d.zFront)})`)
  ok(tris.length === 2, `glass pane present (${tris.length} triangles)`)
  if (!tris.length) continue
  const ys = tris.flat().map((p) => p[1]), offs = tris.flat().map((p) => (p[0] - d.anchor[0]) * d.eaveUnit[0] + (p[2] - d.anchor[1]) * d.eaveUnit[1])
  const deps = tris.flat().map((p) => (p[0] - d.anchor[0]) * d.inwardUnit[0] + (p[2] - d.anchor[1]) * d.inwardUnit[1])
  const [a, b, c] = tris[0]
  const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]
  const outward = -(n[0] * d.inwardUnit[0] + n[2] * d.inwardUnit[1])
  P(`    window ${r2(Math.max(...offs) - Math.min(...offs))} m wide x ${r2(Math.max(...ys) - Math.min(...ys))} m tall, sill ${r2(r.placement.baseY + Math.min(...ys))} head ${r2(r.placement.baseY + Math.max(...ys))}, ${r2(Math.min(...deps))} m behind the front`)
  ok(outward > 0, 'glass faces out of the dormer front')
  ok(Math.min(...deps) > 0.05 && Math.max(...deps) < 0.08, 'glass sits at the back of the recess')
  ok(Math.min(...ys) >= d.zFront + 0.14, 'sill clears the main slope')
}

// ── Trim, bottom plate, undersides ──
function trisOf(g, pl) {
  const pos = g.attributes.position, idx = g.index, out = []
  for (const gr of g.groups) for (let k = gr.start; k < gr.start + gr.count; k += 3) {
    const t = [0, 1, 2].map((o) => { const i = idx.getX(k + o); const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      return pl ? [pl.tx + pl.cos * x + pl.sin * z, pl.baseY + y, pl.tz - pl.sin * x + pl.cos * z] : [x, y, z] })
    out.push({ t, slot: gr.materialIndex })
  }
  return out
}
{
  const plan = buildPlan({ extra: { rseg_7ywyzq: { depth: 4.499, edgeWeights: [0.577, 0.577, 0.577, 0.249] } } })
  const ctx = resolveRoofContext(plan)
  const r = ctx.segments.get('rseg_7ywyzq')
  const d = r.shape.dormers[0]
  const g = generateShellSegmentGeometry(r.placement.seg, r.opts)
  const T = trisOf(g)
  const rel = (p) => [(p[0] - d.anchor[0]) * d.eaveUnit[0] + (p[2] - d.anchor[1]) * d.eaveUnit[1], (p[0] - d.anchor[0]) * d.inwardUnit[0] + (p[2] - d.anchor[1]) * d.inwardUnit[1]]
  const near = T.filter(({ t }) => t.every((p) => { const [w, dd] = rel(p); return Math.abs(w) < d.halfW + 0.5 && dd > -0.5 && dd < d.cheekD && p[1] > d.zFront - 0.3 }))
  const ws = near.flatMap(({ t }) => t.map((p) => Math.abs(rel(p)[0])))
  const ds = near.flatMap(({ t }) => t.map((p) => rel(p)[1]))
  P('\ndormer trim (operator plan, free gable dormer)')
  ok(Math.max(...ws) > d.halfW + 0.09, `roof trim overhangs the cheeks (${r2(Math.max(...ws) - d.halfW)} m)`)
  ok(Math.min(...ds) < -0.14, `roof trim overhangs the front (${r2(-Math.min(...ds))} m)`)
  ok(near.some(({ slot }) => slot === 3), 'trim has fascia / barge-board faces')
  ok(!T.some(({ t }) => t.every((p) => Math.abs(p[1] - d.zBase) < 1e-4)), 'dormer bottom plate removed (no floating ceiling)')

  // Looking UP from inside the level-1 room: the first roof face hit must
  // face DOWN at the viewer (a ceiling), not be a slate seen from behind.
  const W = trisOf(g, r.placement)
  const up = (o) => {
    let best = null
    for (const { t: [a, b, c], slot } of W) {
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const pv = [e2[2], 0, -e2[0]], det = e1[0] * pv[0] + e1[2] * pv[2]
      if (Math.abs(det) < 1e-12) continue
      const tv = [o[0] - a[0], o[1] - a[1], o[2] - a[2]]
      const u = (tv[0] * pv[0] + tv[2] * pv[2]) / det
      if (u < 0 || u > 1) continue
      const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]]
      const v = qv[1] / det
      if (v < 0 || u + v > 1) continue
      const dist = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det
      const ny = e1[2] * e2[0] - e1[0] * e2[2]
      if (dist > 1e-6 && (!best || dist < best.dist)) best = { dist, ny, slot }
    }
    return best
  }
  P('\nroof seen from inside the level-1 room')
  for (const [x, z] of [[-11.0, -3.0], [-9.0, -4.0], [-7.0, -3.5], [-6.0, -3.22], [-5.2, -3.22], [-7.3, -3.22]]) {
    const h = up([x, 4.9, z])
    ok(!!h && h.ny < 0, `looking up at (${x}, ${z}): ${h ? `ceiling ${r2(h.dist)} m above, facing ${h.ny < 0 ? 'down' : 'UP (sky shows)'}` : 'nothing (sky)'}`)
  }
}

// ── Orientation: every dormer drains FORWARD ──
// Walking from the dormer's front back into the main roof, the roof (the
// higher of dormer and main slope) must never go downhill. The shed used to
// fall backward into the main roof — a wedge that read as a chimney.
P('\norientation (roof along the dormer centre line, front -> back)')
for (const type of ['gable', 'shed', 'hip']) {
  const plan = buildPlan({ extra: { rseg_7ywyzq: { depth: 4.499, edgeWeights: [0.577, 0.577, 0.577, 0.249],
    dormers: [{ id: 'd', type, parentFaceId: 0, ridgeHeight: 1.5, cheekWidth: 2.6, footOnParent: [[0.335, 0.275], [0.565, 0.425]] }] } } })
  const ctx = resolveRoofContext(plan)
  const r = ctx.segments.get('rseg_7ywyzq'), d = r.shape.dormers[0], pl = r.placement
  const W = (dd) => { const x = d.anchor[0] + dd * d.inwardUnit[0], z = d.anchor[1] + dd * d.inwardUnit[1]
    return [pl.tx + pl.cos * x + pl.sin * z, pl.tz - pl.sin * x + pl.cos * z] }
  const hs = []
  for (let dd = 0; dd <= d.cheekD; dd += 0.05) hs.push(ctx.heightAt(...W(dd)))
  let worst = 0
  for (let i = 1; i < hs.length; i++) worst = Math.max(worst, hs[i - 1] - hs[i])
  ok(worst < 1e-6, `${type}: front ${r2(hs[0])} -> back ${r2(hs[hs.length - 1])}, never downhill (worst drop ${r2(worst)} m)`)
}

// ── The operator sizes the window from the dormer panel ──
P('\nwindow size from the dormer panel')
for (const [label, win, want] of [
  ['custom 0.8 x 0.6, sill 0.3', { w: 0.8, h: 0.6, sill: 0.3 }, { w: 0.8, h: 0.6, sill: 0.3 }],
  ['oversized 9 x 9 -> clamped to the front', { w: 9, h: 9 }, null],
]) {
  const plan = buildPlan({ extra: { rseg_7ywyzq: { depth: 4.499, edgeWeights: [0.577, 0.577, 0.577, 0.249],
    dormers: [{ id: 'd', type: 'shed', parentFaceId: 0, ridgeHeight: 1.5, cheekWidth: 2.6, footOnParent: [[0.335, 0.275], [0.565, 0.425]], window: win }] } } })
  const r = resolveRoofContext(plan).segments.get('rseg_7ywyzq'), d = r.shape.dormers[0]
  const tris = glassOf(generateShellSegmentGeometry(r.placement.seg, r.opts))
  const ys = tris.flat().map((p) => p[1])
  const ws = tris.flat().map((p) => (p[0] - d.anchor[0]) * d.eaveUnit[0] + (p[2] - d.anchor[1]) * d.eaveUnit[1])
  const got = { w: Math.max(...ws) - Math.min(...ws), h: Math.max(...ys) - Math.min(...ys), sill: Math.min(...ys) - d.zFront }
  if (want) ok(Math.abs(got.w - want.w) < 1e-3 && Math.abs(got.h - want.h) < 1e-3 && Math.abs(got.sill - want.sill) < 1e-3,
    `${label}: got ${r2(got.w)} x ${r2(got.h)}, sill ${r2(got.sill)}`)
  else ok(got.w <= 2 * d.halfW - 0.3 + 1e-6 && Math.max(...ys) <= d.rZ - 0.15 + 1e-6,
    `${label}: ${r2(got.w)} x ${r2(got.h)} inside a ${r2(2 * d.halfW)} m front, head ${r2(Math.max(...ys) - d.rZ)} m under the roof`)
}

// ── Shed roof pitch from the dormer panel ──
P('\nshed roof pitch (main roof is 30 degrees)')
for (const [asked, want] of [[5, 5], [20, 20], [45, 27]]) {
  const plan = buildPlan({ extra: { rseg_7ywyzq: { depth: 4.499, edgeWeights: [0.577, 0.577, 0.577, 0.249],
    dormers: [{ id: 'd', type: 'shed', parentFaceId: 0, ridgeHeight: 1.5, cheekWidth: 2.6, footOnParent: [[0.335, 0.275], [0.565, 0.425]], pitchDeg: asked }] } } })
  const ctx = resolveRoofContext(plan)
  const r = ctx.segments.get('rseg_7ywyzq'), d = r.shape.dormers[0], pl = r.placement, f = r.shape.frame
  const got = (Math.atan(d.tanShed) * 180) / Math.PI
  const W = (dd) => { const x = d.anchor[0] + dd * d.inwardUnit[0], z = d.anchor[1] + dd * d.inwardUnit[1]
    return [pl.tx + pl.cos * x + pl.sin * z, pl.tz - pl.sin * x + pl.cos * z] }
  let worst = 0, prev = null
  for (let dd = 0; dd <= d.cheekD; dd += 0.05) { const h = ctx.heightAt(...W(dd)); if (prev != null) worst = Math.max(worst, prev - h); prev = h }
  const buriedY = d.zFront + d.tanParent * (d.cheekD - 0.15)
  ok(Math.abs(got - want) < 0.05 && worst < 1e-6 && buriedY < f.ridgeZ - 0.1,
    `asked ${asked} deg -> ${got.toFixed(1)} deg; drains forward; meets the main roof ${r2(f.ridgeZ - buriedY)} m under the ridge`)
}

const withWin = buildPlan({ dormerWindow: 'window_lh3r' })
const rw = resolveRoofContext(withWin).segments.get('rseg_7ywyzq')
P('\ndormer following window lh3r')
ok(glassOf(generateShellSegmentGeometry(rw.placement.seg, rw.opts)).length === 0, 'no extra glass (the real window is its front)')

P(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAIL(S)`} | warnings: ${warns.length ? warns.join(' | ') : 'none'}`)
