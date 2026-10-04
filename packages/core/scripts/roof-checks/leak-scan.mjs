// "Check gaps", offline: where can you see INTO the house from outside?
//
// Builds every room's fill exactly as the viewer's Check gaps does (lifted
// from the compiled viewer), the roofs as exported, and every wall trimmed
// as the preview trims it (plain boxes: no window or door openings, so those
// never count). From points on each fill it casts rays outward -- level and
// upward, 31 directions -- and any ray that escapes without hitting a roof
// or a wall is a leak: a crack, a bleed, a missing piece. Reported in
// clusters with how many rays escaped there and one escaping direction.
//
//   npx tsc --build (core AND viewer), then
//   node --import ./scripts/roof-checks/register.mjs scripts/roof-checks/leak-scan.mjs <draft.json>
import fs from 'node:fs'
import * as THREE from 'three'
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh'

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

const { resolveRoofContext } = await import('../../dist/systems/roof/roof-scene.js')
const { getRoofContext } = await import('../../dist/systems/roof/roof-system.js')
const { roofMeshesForExport } = await import('../../dist/systems/roof/roof-export.js')
const { clipWallGeometry } = await import('../../dist/systems/roof/roof-wall-clip-system.js')
const L = console.log
console.log = () => {}
console.warn = () => {}

// The viewer's fill builder, lifted from its compiled module (it imports
// React / R3F, which this script doesn't need).
const src = fs.readFileSync(new URL('../../../viewer/dist/components/viewer/gap-check.js', import.meta.url), 'utf8')
const body = src.slice(src.indexOf('export function buildGapFills')).replace('export function buildGapFills', 'function buildGapFills')
const consts = src.match(/const (GAP_COLOR|STEP|INSET|FLOOR_GAP|TOP_GAP) = [^;]+;/g).join('\n')
const buildGapFills = new Function('THREE', 'getRoofContext', `${consts}\n${body}\nreturn buildGapFills`)(THREE, getRoofContext)

const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const nodes = d.nodes
const ctx = resolveRoofContext(nodes)

// Blockers: roofs (glass included -- a window isn't a leak) and walls.
const pos = []
for (const [, m] of roofMeshesForExport(nodes, ctx)) {
  for (let k = 0; k < m.faces.length; k++) {
    const i = m.faces[k]
    pos.push(m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2])
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

// Directions: level ring, 30 and 60 degrees up, straight up.
const dirs = []
for (const [el, n] of [[0, 12], [30, 12], [60, 6]]) {
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n
    const e = (el * Math.PI) / 180
    dirs.push(new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)))
  }
}
dirs.push(new THREE.Vector3(0, 1, 0))

const ray = new THREE.Raycaster()
ray.far = 60
ray.firstHitOnly = true
const clusters = new Map()
let samples = 0
for (const f of buildGapFills(nodes)) {
  const elev = ctx.levels.get(f.levelId)?.elev ?? 0
  const p = f.geometry.getAttribute('position')
  const seen = new Set()
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3(p.getX(i), p.getY(i) + elev, p.getZ(i))
    const key = `${Math.round(v.x / 0.2)},${Math.round(v.y / 0.2)},${Math.round(v.z / 0.2)}`
    if (seen.has(key)) continue
    seen.add(key)
    samples++
    for (const dir of dirs) {
      ray.set(v, dir)
      if (ray.intersectObject(blockers, false).length) continue
      const ck = `${Math.round(v.x / 0.5) * 0.5},${Math.round(v.y / 0.5) * 0.5},${Math.round(v.z / 0.5) * 0.5}`
      // Where the ray leaves the house: the first point along it above every
      // roof (or past every wall, for a level ray).
      let exit = null
      for (let s = 0.05; s < 25; s += 0.05) {
        const X = v.x + dir.x * s, Y = v.y + dir.y * s, Z = v.z + dir.z * s
        const h = ctx.heightAt(X, Z)
        if (h == null || Y > h + 0.05) { exit = [X, Y, Z]; break }
      }
      const c = clusters.get(ck) ?? { n: 0, at: v.toArray().map((q) => +q.toFixed(2)), dir: dir.toArray().map((q) => +q.toFixed(2)), exit: exit && exit.map((q) => +q.toFixed(2)) }
      c.n++
      clusters.set(ck, c)
    }
  }
}
const list = [...clusters.values()].sort((a, b) => b.n - a.n)
L(`${process.argv[2].split(/[\\/]/).pop()}: ${samples} fill points x ${dirs.length} rays; ${list.length} leak spot(s)`)
const only = process.argv[3] ? JSON.parse(process.argv[3]) : null
for (const c of (only ? list.filter((q) => q.at[0] >= only[0] && q.at[0] <= only[1] && q.at[2] >= only[2] && q.at[2] <= only[3]) : list.slice(0, 25))) L(`  ${String(c.n).padStart(4)} rays escape near (x ${c.at[0]}, y ${c.at[1]}, z ${c.at[2]}) e.g. towards (${c.dir.join(', ')}), leaving at ${c.exit ? '(' + c.exit.join(', ') + ')' : '?'}`)
