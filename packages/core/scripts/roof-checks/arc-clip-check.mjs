// Walls trimmed to the roof — curved and straight. A real arc wall mesh (the wall system's
// own extruder) on level 1 under a level-0 gable roof: after trimming, no
// part of the wall may stand above the roof, and the wall must still reach
// the roof (not be cut lower) along its whole curve.
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { clipWallGeometry } from '../../dist/systems/roof/roof-wall-clip-system.js'
import { generateExtrudedWall } from '../../dist/systems/wall/wall-system.js'
import { tessellateArc } from '../../dist/lib/arc-math.js'
console.log = () => {}
const warns = []
console.warn = (...a) => warns.push(a.map(String).join(' ').slice(0, 160))
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
const r2 = (v) => Math.round(v * 100) / 100
let fails = 0
const ok = (c, label) => { P(`  ${c ? 'PASS' : 'FAIL'} ${label}`); if (!c) fails++ }

function plan(wall) {
  const nodes = {
    level_0: { id: 'level_0', type: 'level', level: 0, children: ['w_g', 'roof_A'] },
    level_1: { id: 'level_1', type: 'level', level: 1, children: ['w_arc'] },
    w_g: { id: 'w_g', type: 'wall', parentId: 'level_0', start: [-5, 4], end: [5, 4], height: 2.7, thickness: 0.15, bulge: 0, children: [] },
    roof_A: { id: 'roof_A', type: 'roof', parentId: 'level_0', position: [0, 0, 0], rotation: 0, children: ['seg_A'] },
    seg_A: { id: 'seg_A', type: 'roof-segment', parentId: 'roof_A', position: [0, 0, 0], rotation: 0, wallHeight: 0, overhang: 0.3,
      roofType: 'gable', ridgeAxis: 'east-west', width: 10, depth: 8, roofHeight: 3 },
    w_arc: { id: 'w_arc', type: 'wall', parentId: 'level_1', height: 2.7, thickness: 0.15, children: [], ...wall },
  }
  return nodes
}

function run(label, wall) {
  const nodes = plan(wall)
  const ctx = resolveRoofContext(nodes)
  const node = nodes.w_arc
  const src = generateExtrudedWall(node, [], { junctionData: new Map(), junctions: new Map() }, 0)
  const out = clipWallGeometry(src, node, 0, ctx)
  const [sx, sz] = node.start, [ex, ez] = node.end
  const a = Math.atan2(ez - sz, ex - sx), ca = Math.cos(a), sa = Math.sin(a)
  const baseY = 2.7 // level-1 elevation
  const world = (x, y, z) => [sx + x * ca - z * sa, baseY + y, sz + x * sa + z * ca]
  const poke = (g) => {
    const p = g.attributes.position.array
    let n = 0, worst = 0
    for (let i = 0; i < p.length; i += 3) {
      const [X, Y, Z] = world(p[i], p[i + 1], p[i + 2])
      const h = ctx.heightAt(X, Z)
      if (h != null && Y > h + 0.02) { n++; worst = Math.max(worst, Y - h) }
    }
    return { n, worst }
  }
  P(`\n${label}`)
  const before = poke(src)
  ok(before.n > 0, `untrimmed wall pokes through the roof (${before.n} verts, up to ${r2(before.worst)} m) — the case being fixed`)
  ok(!!out, 'wall was trimmed')
  if (!out) return
  const after = poke(out)
  ok(after.n === 0, `trimmed wall stays under the roof (${after.n} verts above, worst ${r2(after.worst)} m)`)
  // Still reaches the roof: slice the trimmed mesh with the vertical plane
  // across the wall at each sample (normal = local wall direction) and take
  // the highest crossing within 0.3 m of the centreline.
  const p = out.attributes.position.array
  const T = []
  for (let i = 0; i < p.length; i += 9) T.push([0, 1, 2].map((k) => world(p[i + 3 * k], p[i + 3 * k + 1], p[i + 3 * k + 2])))
  let worstShort = 0
  const pts = node.bulge
    ? tessellateArc(node.start, node.end, node.bulge, 0.25)
    : Array.from({ length: 22 }, (_, i) => [sx + ((ex - sx) * i) / 21, sz + ((ez - sz) * i) / 21])
  for (let j = 1; j < pts.length - 1; j++) {
    const [X, Z] = pts[j]
    const tx = pts[j + 1][0] - pts[j - 1][0], tz = pts[j + 1][1] - pts[j - 1][1]
    const tl = Math.hypot(tx, tz), nx = tx / tl, nz = tz / tl
    let top = -1e9
    for (const tri of T) {
      for (let e = 0; e < 3; e++) {
        const A = tri[e], Bv = tri[(e + 1) % 3]
        const da = (A[0] - X) * nx + (A[2] - Z) * nz, db = (Bv[0] - X) * nx + (Bv[2] - Z) * nz
        if (da * db > 0 || da === db) continue
        const t = da / (da - db)
        const q = [A[0] + (Bv[0] - A[0]) * t, A[1] + (Bv[1] - A[1]) * t, A[2] + (Bv[2] - A[2]) * t]
        if (Math.hypot(q[0] - X, q[2] - Z) < 0.3) top = Math.max(top, q[1])
      }
    }
    const want = Math.min(baseY + node.height, ctx.heightAt(X, Z) ?? 1e9)
    worstShort = Math.max(worstShort, want - top)
  }
  const nPts = pts.length - 2
  ok(worstShort < 0.08, `wall still reaches the roof along the whole curve (worst shortfall ${r2(worstShort)} m over ${nPts} points)`)
}

run('arc bulging toward the eave (bulge +0.5)', { start: [-3, 1], end: [3, 1], bulge: 0.5 })
run('arc bulging toward the ridge (bulge -0.5)', { start: [-3, 1], end: [3, 1], bulge: -0.5 })
run('semicircle across the slope (bulge 1)', { start: [-2, -1], end: [2, 3], bulge: 1 })
// Straight walls use the same 3-point sections: nothing may poke either.
run('straight wall parallel to the eave', { start: [-3, 1], end: [3, 1], bulge: 0 })
run('straight wall running up the slope', { start: [1, 3.5], end: [1, -3.5], bulge: 0 })

P(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAIL(S)`} | warnings: ${warns.length ? warns.join(' | ') : 'none'}`)
