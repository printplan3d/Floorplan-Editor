// Scan a real plan for roof gaps (operator 2026-09-27: "still gaps").
//   node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/gap-scan.mjs <draft.json>
// draft.json = { nodes } (the editor's scene nodes).
// 1. Every step in the roof's top surface (0.2 m grid) must have a face
//    closing it: a horizontal ray just above the lower side, toward the
//    higher side, has to hit something within the grid step.
// 2. No lower-level roof inside a room on the level above (between that
//    room's floor and its own roof).
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
  for (let k = 0; k < idx.count; k += 3) tris.push([W(idx.getX(k)), W(idx.getX(k + 1)), W(idx.getX(k + 2)), id])
}
const hitsAlong = (o, dir, maxT, only) => {
  const out = []
  for (const [a, b, c, id] of tris) {
    if (only && !only(id)) continue
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
    if (t > 1e-4 && t < maxT) out.push({ t, id })
  }
  return out.sort((p, q) => p.t - q.t)
}
const top = (x, z) => { const h = hitsAlong([x, 60, z], [0, -1, 0], 120); return h.length ? { y: 60 - h[0].t, id: h[0].id } : null }
let xs = [1e9, -1e9], zs = [1e9, -1e9]
for (const [a, b, c] of tris) for (const p of [a, b, c]) { xs = [Math.min(xs[0], p[0]), Math.max(xs[1], p[0])]; zs = [Math.min(zs[0], p[2]), Math.max(zs[1], p[2])] }
const S = 0.2, grid = new Map(), key = (x, z) => `${x.toFixed(2)},${z.toFixed(2)}`
for (let x = xs[0]; x <= xs[1]; x += S) for (let z = zs[0]; z <= zs[1]; z += S) grid.set(key(x, z), top(x, z))
const gaps = []
for (let x = xs[0]; x <= xs[1]; x += S) for (let z = zs[0]; z <= zs[1]; z += S) {
  const a = grid.get(key(x, z)); if (!a) continue
  for (const [dx, dz] of [[S, 0], [0, S]]) {
    const b = grid.get(key(x + dx, z + dz)); if (!b) continue
    const lo = a.y < b.y ? { p: [x, z], ...a } : { p: [x + dx, z + dz], ...b }
    const hi = a.y < b.y ? { p: [x + dx, z + dz], ...b } : { p: [x, z], ...a }
    if (hi.y - lo.y < 0.15) continue
    const y = lo.y + Math.min(0.1, (hi.y - lo.y) / 2)
    const dir = [(hi.p[0] - lo.p[0]) / S, 0, (hi.p[1] - lo.p[1]) / S]
    if (!hitsAlong([lo.p[0], y, lo.p[1]], dir, S * 1.5).length) gaps.push({ at: [x, z], lo, hi })
  }
}
const short = (id) => id.slice(-6)
const byPair = {}
for (const g of gaps) (byPair[`${short(g.lo.id)} -> ${short(g.hi.id)}`] ??= []).push(g)
P(`steps without a closing face: ${gaps.length}`)
for (const [k, v] of Object.entries(byPair)) P(`  ${k}: ${v.length}, e.g. ${v.slice(0, 3).map((g) => `(${g.at.map((n) => n.toFixed(1))}) ${g.lo.y.toFixed(2)}->${g.hi.y.toFixed(2)}`).join('  ')}`)

// Lower roofs inside upper-level rooms.
let inside = 0
for (const [id, r] of ctx.segments) {
  const lv = ctx.levels.get(r.placement.levelId)
  if (!lv || lv.elev < 0.5) continue
  const f = r.shape.frame, pl = r.placement
  const lowerIds = (oid) => { const o = ctx.segments.get(oid); const lo = o && ctx.levels.get(o.placement.levelId); return !!lo && lo.elev < lv.elev - 1e-3 }
  let n = 0
  for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) {
    const x = f.uMin + ((f.uMax - f.uMin) * i) / 10, z = f.vMin + ((f.vMax - f.vMin) * j) / 10
    const [lx, lz] = f.ridgeAlongX ? [x, z] : [z, x]
    const X = pl.tx + pl.cos * lx + pl.sin * lz, Z = pl.tz - pl.sin * lx + pl.cos * lz
    const h = hitsAlong([X, pl.baseY - 0.05, Z], [0, -1, 0], pl.baseY - lv.elev - 0.1, lowerIds)
    if (h.length) n++
  }
  if (n) { inside += n; P(`  lower roof inside the room under ${short(id)}: ${n}/81 samples`) }
}
P(`lower roofs inside upper rooms: ${inside}`)
