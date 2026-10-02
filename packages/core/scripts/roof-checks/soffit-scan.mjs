// Scan a real plan for broken soffits (operator 2026-09-27: "many soffits
// are broken, I can only see parts of them").
//   node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/soffit-scan.mjs <draft.json>
// Under every overhanging edge, half an overhang out from the wall line, a
// ray straight up from below must hit a soffit / fascia / wall face first.
// Hitting the back of the slates (slot 1) or nothing at all is a hole.
import fs from 'node:fs'
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { generateShellSegmentGeometry } from '../../dist/systems/roof/shell-preview.js'
console.log = () => {}
console.warn = () => {}
const P = (s) => process.stdout.write(s + '\n')
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const ctx = resolveRoofContext(d.nodes)
const tris = []
for (const [id, r] of ctx.segments) {
  const g = generateShellSegmentGeometry(r.placement.seg, r.opts)
  if (!g) continue
  const pos = g.getAttribute('position'), idx = g.getIndex(), pl = r.placement
  const W = (i) => { const x = pos.getX(i), z = pos.getZ(i); return [pl.tx + pl.cos * x + pl.sin * z, pl.baseY + pos.getY(i), pl.tz - pl.sin * x + pl.cos * z] }
  const slotAt = (k) => { for (const gr of g.groups) if (k >= gr.start && k < gr.start + gr.count) return gr.materialIndex ?? 0; return 0 }
  for (let k = 0; k < idx.count; k += 3) tris.push([W(idx.getX(k)), W(idx.getX(k + 1)), W(idx.getX(k + 2)), id, slotAt(k)])
}
const firstUp = (o) => {
  let best = null
  for (const [a, b, c, id, slot] of tris) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const pv = [e2[2], 0, -e2[0]] // dir = (0,1,0): dir x e2
    const det = e1[0] * pv[0] + e1[2] * pv[2]
    if (Math.abs(det) < 1e-12) continue
    const tv = [o[0] - a[0], o[1] - a[1], o[2] - a[2]]
    const u = (tv[0] * pv[0] + tv[2] * pv[2]) / det
    if (u < 0 || u > 1) continue
    const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]]
    const v = qv[1] / det
    if (v < 0 || u + v > 1) continue
    const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det
    if (t > 1e-4 && (!best || t < best.t)) best = { t, id, slot, up: e1[2] * e2[0] - e1[0] * e2[2] > 0 }
  }
  return best
}
const short = (id) => id.slice(-6)
let total = 0
for (const [id, r] of ctx.segments) {
  const s = r.shape, f = s.frame, pl = r.placement
  if (f.overhang < 0.05) continue
  const poly = s.polygon
  const bad = []
  for (let i = 0; i < 4; i++) {
    const st = s.styles[i]
    if (st !== 'hip' && st !== 'gable') continue
    const a = poly[i], b = poly[(i + 1) % 4]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    const out = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L]
    // outward = the side away from the polygon centre
    const cx = poly.reduce((q, p) => q + p[0], 0) / 4, cz = poly.reduce((q, p) => q + p[1], 0) / 4
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2
    if (out[0] * (mx - cx) + out[1] * (mz - cz) < 0) { out[0] = -out[0]; out[1] = -out[1] }
    // Each edge's own overhang (level-fascia eaves vary with pitch).
    const ohI = f.ohEdge?.[i] ?? f.overhang
    const n = Math.max(2, Math.floor(L / 0.25))
    for (let k = 1; k < n; k++) {
      const t = k / n
      const x = a[0] + (b[0] - a[0]) * t + out[0] * ohI * 0.5
      const z = a[1] + (b[1] - a[1]) * t + out[1] * ohI * 0.5
      // Skip points inside another roof's footprint (the neighbour takes over there).
      const X = pl.tx + pl.cos * x + pl.sin * z, Z = pl.tz - pl.sin * x + pl.cos * z
      const h = firstUp([X, pl.baseY - 1.5, Z])
      if (!h) { bad.push({ i, X, Z, what: 'nothing' }); continue }
      if (h.id !== id) continue // another roof overhead: not this soffit's job
      if (h.slot === 1) bad.push({ i, X, Z, what: 'slates' })
      else if (h.up) bad.push({ i, X, Z, what: `slot${h.slot}-facing-up` })
    }
  }
  if (bad.length) {
    total += bad.length
    const byEdge = {}
    for (const b of bad) (byEdge[`${b.i}:${b.what}`] ??= []).push(b)
    for (const [k, v] of Object.entries(byEdge))
      P(`  ${short(id)} edge ${k}: ${v.length}, e.g. ${v.slice(0, 3).map((b) => `(${b.X.toFixed(1)},${b.Z.toFixed(1)})`).join(' ')}`)
  }
}
P(`soffit holes: ${total}`)
