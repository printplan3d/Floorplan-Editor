// Scan a real plan for missing fascia (operator 2026-09-27: "this side is
// still missing fascia").
//   node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/fascia-scan.mjs <draft.json>
// Along every overhanging edge, from outside, a horizontal ray at fascia
// height aimed at the roof must hit a fascia face (slot 3) of that roof
// first. Anything else there (nothing, slates, soffit, a wall) is reported.
import fs from 'node:fs'
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { generateShellSegmentGeometry, shellHeightAtLocal } from '../../dist/systems/roof/shell-preview.js'
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
const first = (o, dir, maxT) => {
  let best = null
  for (const [a, b, c, id, slot] of tris) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const pv = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]]
    const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2]
    if (Math.abs(det) < 1e-12) continue
    const tv = [o[0] - a[0], o[1] - a[1], o[2] - a[2]]
    const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) / det
    if (u < 0 || u > 1) continue
    const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]]
    const v = (dir[0] * qv[0] + dir[1] * qv[1] + dir[2] * qv[2]) / det
    if (v < 0 || u + v > 1) continue
    const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det
    if (t > 1e-4 && t < maxT && (!best || t < best.t)) best = { t, id, slot }
  }
  return best
}
const short = (id) => id.slice(-6)
const names = { 0: 'wall', 1: 'slates', 2: 'soffit', 3: 'fascia', 4: 'glass', 5: 'backing' }
let total = 0
let tested = 0, noH = 0, other = 0
for (const [id, r] of ctx.segments) {
  const s = r.shape, f = s.frame, pl = r.placement
  const oh = f.overhang
  if (oh < 0.05) continue
  const poly = s.polygon
  const cx = poly.reduce((q, p) => q + p[0], 0) / 4, cz = poly.reduce((q, p) => q + p[1], 0) / 4
  for (let i = 0; i < 4; i++) {
    const st = s.styles[i]
    if (st !== 'hip' && st !== 'gable') continue
    if ((i === f.eSideLo && s.flushLo) || (i === f.eSideHi && s.flushHi)) continue
    const a = poly[i], b = poly[(i + 1) % 4]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    const out = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L]
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2
    if (out[0] * (mx - cx) + out[1] * (mz - cz) < 0) { out[0] = -out[0]; out[1] = -out[1] }
    const n = Math.max(2, Math.floor(L / 0.25))
    const bad = {}
    for (let k = 1; k < n; k++) {
      const t = k / n
      // just inside the fascia line, where the roof surface is
      const xi = a[0] + (b[0] - a[0]) * t + out[0] * (oh - 0.02)
      const zi = a[1] + (b[1] - a[1]) * t + out[1] * (oh - 0.02)
      // Heights exist only inside the wall line: read it just inside the
      // edge and carry the slope out (a rake keeps its height).
      const xe = a[0] + (b[0] - a[0]) * t - out[0] * 0.02
      const ze = a[1] + (b[1] - a[1]) * t - out[1] * 0.02
      const he = shellHeightAtLocal(s, xe, ze, false)
      if (he == null) { noH++; continue }
      tested++
      const sloped = i === f.eSideLo || i === f.eSideHi || st === 'hip'
      const h = he - (sloped ? f.tanOf[i] * (oh + 0.02) : 0)
      const y = pl.baseY + h - 0.08
      const xo = a[0] + (b[0] - a[0]) * t + out[0] * (oh + 0.4)
      const zo = a[1] + (b[1] - a[1]) * t + out[1] * (oh + 0.4)
      const W = (x, z) => [pl.tx + pl.cos * x + pl.sin * z, pl.tz - pl.sin * x + pl.cos * z]
      const [Xo, Zo] = W(xo, zo)
      const [Xi, Zi] = W(xi, zi)
      const L2 = Math.hypot(Xi - Xo, Zi - Zo)
      const dir = [(Xi - Xo) / L2, 0, (Zi - Zo) / L2]
      // Under another roof out there (inside its attic): hidden, skip.
      const over = ctx.heightAt(Xo, Zo)
      if (over != null && over > y + 0.05) { other++; continue }
      const hit = first([Xo, y, Zo], dir, 0.6)
      // Covered by another roof out there: not this edge's job.
      if (hit && hit.id !== id) { other++; continue }
      if (hit && hit.slot === 3) continue
      const what = hit ? names[hit.slot] ?? `slot${hit.slot}` : 'nothing'
      ;(bad[what] ??= []).push([Xo, Zo])
    }
    for (const [what, pts] of Object.entries(bad)) {
      if (pts.length < 2) continue
      total += pts.length
      P(`  ${short(id)} edge ${i} (${st}): ${what} x${pts.length}, e.g. ${pts.slice(0, 3).map((p) => `(${p[0].toFixed(1)},${p[1].toFixed(1)})`).join(' ')}`)
    }
  }
}
P(`edges samples without fascia: ${total} (tested ${tested}, no roof height ${noH}, another roof first ${other})`)
