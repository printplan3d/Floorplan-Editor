// Roof faces standing INSIDE the house: a vertical roof triangle whose
// outward side is still under roof, above the triangle -- e.g. two roofs
// meeting end to end with different eaves, each closing its end with a full
// wall, so two gable walls stand back to back across the room (DFY Melissa,
// 2026-10-18: "a wall that shouldn't be there" at the top of the stairs).
// A real step wall (the part of a higher roof's end above a lower roof)
// has open air in front of it, so it doesn't count.
//
// usage: node --import ./scripts/roof-checks/register.mjs \
//          scripts/roof-checks/internal-wall-scan.mjs <plan.json> [maxArea]
// plan.json: { nodes } as the editor's localStorage draft stores them.
// Exit 1 when the internal area exceeds maxArea (default 0.5 m2).
import { readFileSync } from 'node:fs'
import { roofMeshesForExport } from '../../dist/systems/roof/roof-export.js'
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'

console.log = () => {}
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
const [file, maxArg] = process.argv.slice(2)
const nodes = JSON.parse(readFileSync(file, 'utf8')).nodes
const ctx = resolveRoofContext(nodes)
const meshes = roofMeshesForExport(nodes, ctx)
const PROBE = 0.5 // past a 0.3 m rake overhang
const ABOVE = 0.1

let total = 0
const groups = new Map()
for (const [id, m] of meshes) {
  const V = m.vertices
  const F = m.faces
  for (let i = 0; i < F.length; i += 3) {
    const a = [V[F[i] * 3], V[F[i] * 3 + 1], V[F[i] * 3 + 2]]
    const b = [V[F[i + 1] * 3], V[F[i + 1] * 3 + 1], V[F[i + 1] * 3 + 2]]
    const c = [V[F[i + 2] * 3], V[F[i + 2] * 3 + 1], V[F[i + 2] * 3 + 2]]
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const L = Math.hypot(...n)
    const area = L / 2
    if (area < 1e-3) continue
    if (Math.abs(n[1] / L) > 0.2) continue
    const h = Math.hypot(n[0], n[2])
    const nx = n[0] / h
    const nz = n[2] / h
    const cy = (a[1] + b[1] + c[1]) / 3
    const cx = (a[0] + b[0] + c[0]) / 3
    const cz = (a[2] + b[2] + c[2]) / 3
    const roofOut = ctx.heightAt(cx + nx * PROBE, cz + nz * PROBE)
    if (roofOut == null || roofOut < cy + ABOVE) continue
    total += area
    const key = `${id} @ x=${cx.toFixed(1)} z=${cz.toFixed(1)} n=(${nx.toFixed(2)},${nz.toFixed(2)})`
    const g = groups.get(key) ?? { area: 0, y0: 1e9, y1: -1e9 }
    g.area += area
    g.y0 = Math.min(g.y0, cy)
    g.y1 = Math.max(g.y1, cy)
    groups.set(key, g)
  }
}
const top = [...groups.entries()].sort((p, q) => q[1].area - p[1].area).slice(0, 15)
for (const [k, g] of top) P(`  ${k}  area ${g.area.toFixed(2)} m2  y ${g.y0.toFixed(2)}..${g.y1.toFixed(2)}`)
const maxArea = maxArg ? Number(maxArg) : 0.5
P(`internal roof wall area: ${total.toFixed(2)} m2 (limit ${maxArea})`)
process.exit(total > maxArea ? 1 : 0)
