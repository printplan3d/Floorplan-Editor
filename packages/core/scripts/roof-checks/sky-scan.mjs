// "Walk mode", offline: where can you see SKY from inside an upper storey?
//
// leak-scan casts from Check-gaps fills kept 0.3 m inside the walls, in 31
// fixed directions; it never looks up from where a person stands, and missed
// the gaps the owner saw in walk mode (2026-10-22, Melissa: once the viewer's
// fake walk-mode ceiling was gone, a slit at the east roof join and a gap by
// the upper shed showed sky). Here: eye height (1.6 m) over every room on
// every storey above the ground, a 0.4 m grid, rays from 20 to 86 degrees up
// all round, against the roofs as exported (glass ignored: a window isn't a
// gap) and every wall trimmed as the preview trims it.
//
//   npx tsc --build, then
//   node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/sky-scan.mjs <draft.json> [maxRays]
// Exit 1 when more than maxRays (default 0) rays escape.
import fs from 'node:fs'
import * as THREE from 'three'
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh'

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

const { resolveRoofContext } = await import('../../dist/systems/roof/roof-scene.js')
const { roofMeshesForExport } = await import('../../dist/systems/roof/roof-export.js')
const { clipWallGeometry } = await import('../../dist/systems/roof/roof-wall-clip-system.js')
const L = console.log
console.log = () => {}
console.warn = () => {}

const nodes = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).nodes
const maxRays = process.argv[3] ? Number(process.argv[3]) : 0
const ctx = resolveRoofContext(nodes)

const pos = []
for (const [, m] of roofMeshesForExport(nodes, ctx)) {
  const glass = new Set(m.glass ?? [])
  for (let k = 0; k < m.faces.length; k += 3) {
    if (glass.has(k / 3)) continue
    for (let o = 0; o < 3; o++) {
      const i = m.faces[k + o]
      pos.push(m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2])
    }
  }
}
for (const w of Object.values(nodes).filter((n) => n.type === 'wall')) {
  const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1])
  if (len < 1e-3) continue
  const t = w.thickness ?? 0.15
  const h = w.height ?? 2.7
  const dx = (w.end[0] - w.start[0]) / len
  const dz = (w.end[1] - w.start[1]) / len
  const base = ctx.levels.get(w.parentId)?.elev ?? 0
  const g = new THREE.BoxGeometry(len, h, t, Math.ceil(len / 0.05), 1, 1).toNonIndexed()
  g.translate(len / 2, h / 2, 0)
  const o = (clipWallGeometry(g, w, 0, ctx) ?? g).toNonIndexed()
  const p = o.getAttribute('position')
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const z = p.getZ(i)
    pos.push(w.start[0] + dx * x - dz * z, base + p.getY(i), w.start[1] + dz * x + dx * z)
  }
}
const bg = new THREE.BufferGeometry()
bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
bg.computeBoundsTree()
const blockers = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))

const dirs = []
for (let el = 20; el <= 86; el += 11) {
  for (let az = 0; az < 360; az += 15) {
    const e = (el * Math.PI) / 180
    const a = (az * Math.PI) / 180
    dirs.push(new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)))
  }
}

const pip = (x, z, P) => {
  let c = false
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, zi] = P[i]
    const [xj, zj] = P[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}

const ray = new THREE.Raycaster()
ray.far = 80
ray.firstHitOnly = true
let points = 0
let escaped = 0
const cells = new Map()
for (const z of Object.values(nodes).filter((n) => n.type === 'zone' && Array.isArray(n.polygon))) {
  const lv = ctx.levels.get(z.parentId)
  if (!lv || lv.elev < 0.5) continue // upper storeys only
  const xs = z.polygon.map((q) => q[0])
  const zs = z.polygon.map((q) => q[1])
  for (let x = Math.min(...xs) + 0.2; x < Math.max(...xs); x += 0.4) {
    for (let q = Math.min(...zs) + 0.2; q < Math.max(...zs); q += 0.4) {
      if (!pip(x, q, z.polygon)) continue
      const eye = new THREE.Vector3(x, lv.elev + 1.6, q)
      // Standing room: nothing within 1.6 m overhead (a low roof corner).
      ray.set(new THREE.Vector3(x, lv.elev + 0.05, q), new THREE.Vector3(0, 1, 0))
      ray.far = 1.55
      if (ray.intersectObject(blockers, false).length) continue
      ray.far = 80
      points++
      for (const d of dirs) {
        ray.set(eye, d)
        if (ray.intersectObject(blockers, false).length) continue
        escaped++
        // Where it leaves: first point along the ray above every roof.
        let exit = null
        for (let s = 0.05; s < 30; s += 0.05) {
          const X = x + d.x * s
          const Y = eye.y + d.y * s
          const Z = q + d.z * s
          const h = ctx.heightAt(X, Z)
          if (h == null || Y > h + 0.05) {
            exit = [X, Y, Z]
            break
          }
        }
        const k = exit ? `${Math.round(exit[0] * 2) / 2},${Math.round(exit[2] * 2) / 2}` : 'none'
        const c = cells.get(k) ?? { n: 0, from: [+x.toFixed(1), +q.toFixed(1)], exit: exit && exit.map((v) => +v.toFixed(2)) }
        c.n++
        cells.set(k, c)
      }
    }
  }
}
L(`${process.argv[2].split(/[\\/]/).pop()}: ${points} eye points x ${dirs.length} rays; ${escaped} see sky`)
for (const c of [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 15)) {
  L(`  ${String(c.n).padStart(4)} rays, e.g. from (${c.from.join(', ')}) leaving at ${c.exit ? '(' + c.exit.join(', ') + ')' : '?'}`)
}
process.exit(escaped > maxRays ? 1 : 0)
