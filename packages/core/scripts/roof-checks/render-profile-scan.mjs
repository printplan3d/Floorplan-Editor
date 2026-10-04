// What the render pipeline does with each wall's exported top profile
// (blender_pipeline_dev/roof/wall_clip.py clip_wall_to_profile): cut the
// wall at the profile's inner points, then move every top vertex to the
// profile there, held flat past its ends. The wall mesh runs half a
// thickness past both ends. Reports, per wall, how far that top stands
// above the roof surface over the wall's centreline.
//   node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/render-profile-scan.mjs <draft.json>...
import fs from 'node:fs'
const { resolveRoofContext } = await import('../../dist/systems/roof/roof-scene.js')
const { wallTopProfile } = await import('../../dist/systems/roof/roof-wall-clip-system.js')
const L = console.log
console.log = () => {}
console.warn = () => {}
const profZ = (prof, s) => {
  if (s <= prof[0].s) return prof[0].y
  for (let i = 1; i < prof.length; i++) {
    const a = prof[i - 1], b = prof[i]
    if (s <= b.s) return a.y + ((b.y - a.y) * (s - a.s)) / (b.s - a.s || 1)
  }
  return prof[prof.length - 1].y
}
for (const f of process.argv.slice(2)) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'))
  if (!d.nodes) continue
  const ctx = resolveRoofContext(d.nodes)
  const out = []
  for (const w of Object.values(d.nodes).filter((n) => n.type === 'wall')) {
    const prof = wallTopProfile(w, 0, ctx)
    if (!prof) continue
    const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1])
    const dx = (w.end[0] - w.start[0]) / len, dz = (w.end[1] - w.start[1]) / len
    const halfT = (w.thickness ?? 0.15) / 2
    const base = ctx.levels.get(w.parentId)?.elev ?? 0
    const top = w.height ?? 2.7
    // Mesh top vertices: both (extended) ends plus every inner cut.
    const vs = [-halfT, len + halfT, ...prof.map((p) => p.s).filter((s) => s > 1e-3 && s < len - 1e-3)].sort((a, b) => a - b)
    const vz = vs.map((s) => Math.min(top, profZ(prof, s)))
    let worst = 0, at = null
    for (let s = 0; s <= len; s += 0.02) {
      let k = 1
      while (k < vs.length - 1 && vs[k] < s) k++
      const y = vz[k - 1] + ((vz[k] - vz[k - 1]) * (s - vs[k - 1])) / (vs[k] - vs[k - 1] || 1)
      const h = ctx.wallHeightAt(w.start[0] + dx * s, w.start[1] + dz * s, [dx, dz])
      if (h == null) continue
      const over = base + y - h
      if (over > worst) { worst = over; at = [w.start[0] + dx * s, w.start[1] + dz * s] }
    }
    if (worst > 0.005) out.push(`${w.id.slice(-6)} above roof by ${worst.toFixed(3)} at ${at.map((v) => v.toFixed(2))}`)
  }
  L(f.split(/[\/]/).pop(), out.length ? '\n  ' + out.join('\n  ') : 'clean')
}
