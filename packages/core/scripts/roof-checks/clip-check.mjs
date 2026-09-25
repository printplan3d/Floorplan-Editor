import * as THREE from 'three'
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg'
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { clipWallGeometry } from '../../dist/systems/roof/roof-wall-clip-system.js'
import { buildPlan } from './plan-fixture.mjs'
console.log = () => {}
const warns = []
console.warn = (...a) => warns.push(a.map(String).join(' ').slice(0, 160))
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
const r2 = (v) => Math.round(v * 100) / 100

// L1 west wall 183n in wall-local space: x 0..len along the wall, y 0..2.7.
const len = Math.hypot(0, -6.49 - -2.27) // 4.22
const box = new THREE.BoxGeometry(len, 2.7, 0.15).toNonIndexed()
box.translate(len / 2, 1.35, 0)
box.deleteAttribute('uv')
// Window lh3r: centre x 1.48, y 1.5, 1.5 x 1.5 — cut the real opening in.
const hole = new THREE.BoxGeometry(1.5, 1.5, 1).toNonIndexed()
hole.translate(1.48, 1.5, 0)
hole.deleteAttribute('uv')
const ev = new Evaluator()
ev.useGroups = false
ev.attributes = ['position', 'normal']
const wallGeo = ev.evaluate(new Brush(box), new Brush(hole), SUBTRACTION).geometry

function profile(g, picks) {
  // True wall top at each x: slice every triangle with the plane x = k and
  // keep the highest crossing. And whether the window opening survived (no
  // wall material inside the hole's middle).
  const p = g.attributes.position.array
  const bands = {}
  let inHole = 0
  for (let i = 0; i < p.length; i += 9) {
    const V = [0, 1, 2].map((j) => [p[i + 3 * j], p[i + 3 * j + 1]])
    for (const k of picks) {
      for (let e = 0; e < 3; e++) {
        const [a, b] = [V[e], V[(e + 1) % 3]]
        if ((a[0] - k) * (b[0] - k) > 0 || a[0] === b[0]) continue
        const y = a[1] + ((b[1] - a[1]) * (k - a[0])) / (b[0] - a[0])
        bands[k] = Math.max(bands[k] ?? -1e9, y)
      }
    }
  }
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1]
    if (x > 1.0 && x < 1.96 && y > 1.0 && y < 2.0) inHole++
  }
  return { bands, inHole }
}

function run(label, nodes) {
  const ctx = resolveRoofContext(nodes)
  const node = nodes['wall_183n']
  const out = clipWallGeometry(wallGeo, node, 0, ctx)
  const g = out ?? wallGeo
  const pick = [0.01, 0.75, 1.0, 1.5, 2.0, 2.25, 3.0, 4.0, 4.21]
  const { bands, inHole } = profile(g, pick)
  P(`\n${label}: ${out ? 'CLIPPED' : 'unchanged'}  tris ${g.attributes.position.count / 3}`)
  P('  wall top (local y) at x =', pick.map((x) => `${x}:${r2(bands[x] ?? NaN)}`).join('  '))
  P('  window opening kept clear:', inHole === 0 ? 'yes' : `NO (${inHole} verts inside)`)
}

run('default pitch (roof 3.11 world -> 0.41 local over most of the wall)', buildPlan())
run('dormer following window lh3r', buildPlan({ dormerWindow: 'window_lh3r' }))
run('north roof west edge shallowed (tan 0.35)', buildPlan({ extra: { rseg_7ywyzq: { edgeWeights: [0.925, 0.925, 0.925, 0.35] } } }))
P('\nclip warnings:', warns.length ? warns.join(' | ') : 'none')
