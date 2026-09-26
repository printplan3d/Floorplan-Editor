// Two roof sections meeting along a shared edge, ridges at an angle, no
// overlap (operator 2026-09-26, plan c39200da: the main E-W roof and the
// 45-degree wing): they fuse on the seam: each end opens, both stop dead on
// one line, and the slopes meet there with no gap.
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { generateShellSegmentGeometry } from '../../dist/systems/roof/shell-preview.js'
console.log = () => {}
const warns = []
console.warn = (...a) => warns.push(a.map(String).join(' ').slice(0, 140))
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
let fails = 0
const ok = (c, l) => { P(`  ${c ? 'PASS' : 'FAIL'} ${l}`); if (!c) fails++ }

const seg = (id, pos, d) => ({ roof: { id: `roof_${id}`, type: 'roof', parentId: 'level_0', position: pos, rotation: 0, children: [id] },
  seg: { id, type: 'roof-segment', parentId: `roof_${id}`, position: [0, 0, 0], rotation: 0, wallHeight: 0, overhang: 0.3, roofType: 'gable', ...d } })
function plan(segs) {
  const nodes = { level_0: { id: 'level_0', type: 'level', level: 0, children: ['w'] },
    w: { id: 'w', type: 'wall', parentId: 'level_0', start: [40, 40], end: [41, 40], height: 2.7, thickness: 0.15, bulge: 0, children: [] } }
  for (const s of segs) { nodes[s.roof.id] = s.roof; nodes[s.seg.id] = s.seg; nodes.level_0.children.push(s.roof.id) }
  return nodes
}
const world = (r, x, z) => [r.placement.tx + r.placement.cos * x + r.placement.sin * z, r.placement.tz - r.placement.sin * x + r.placement.cos * z]

// The operator's two sections, as saved (ridge heights 6.9 / 4.9 rise).
const MAIN = seg('main', [2.16, 0, 2.47], { ridgeAxis: 'east-west', width: 8.89, depth: 8.51, roofHeight: 6.9,
  polygon: [[-4.45, -4.26], [4.45, -4.26], [4.45, 4.26], [-8.53, 4.05]] })
const WING = seg('wing', [-4.2, 0, 1.78], { ridgeAxis: 'east-west', ridgeAngleDeg: -45, width: 3.73, depth: 7.13, roofHeight: 6.9,
  polygon: [[-2.77, -8.15], [1.87, -3.56], [-2.06, 4.63], [-8.8, -2.3]] })

P('\nmain E-W roof + 45-degree wing sharing a slanted edge')
const ctx = resolveRoofContext(plan([MAIN, WING]))
const A = ctx.segments.get('main'), B = ctx.segments.get('wing')
ok(A.shape.seams.length === 1 && B.shape.seams.length === 1, 'one seam on each roof')
const f = (r) => r.shape.frame
const seamEnd = (r) => [r.shape.styles[f(r).eEndLo], r.shape.styles[f(r).eEndHi]]
ok(seamEnd(A).includes('junction') && seamEnd(B).includes('junction'), `seam ends open (main ${seamEnd(A)}, wing ${seamEnd(B)})`)
ok(!!B.joinedTo, `wing reports the join to the panel (${B.ridgeMatchApplied})`)

// Nothing of either roof past the line where it meets the other (each
// half: past the meeting line AND on that side of its own ridge).
for (const r of [A, B]) {
  const m = r.shape.seams[0]
  const g = generateShellSegmentGeometry(r.placement.seg, r.opts)
  const pos = g.attributes.position.array
  let past = 0
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], z = pos[i + 2]
    if (m.halves.some((h) => h.n[0] * (x - h.p[0]) + h.n[1] * (z - h.p[1]) > 0.01 && h.s[0] * (x - h.r[0]) + h.s[1] * (z - h.r[1]) > 0.01)) past++
  }
  ok(past === 0, `${r.placement.seg.id}: no geometry past the meeting line (${past} vertices)`)
}
// The two halves meet at the ridge crossing (a valley and a hip, not a gap).
{
  const [h1, h2] = A.shape.seams[0].halves
  const gap = Math.hypot(h1.from[0] - h2.from[0], h1.from[1] - h2.from[1])
  ok(gap < 0.05, `meeting lines start together at the ridge (${gap.toFixed(3)} m apart)`)
}

// The two roofs meet on the seam: surface just either side agrees.
const m = A.shape.seams[0]
const [a0, a1] = [world(A, ...m.a), world(A, ...m.b)]
const nW = [A.placement.cos * m.n[0] + A.placement.sin * m.n[1], -A.placement.sin * m.n[0] + A.placement.cos * m.n[1]]
let worst = 0, n = 0
for (let k = 1; k < 20; k++) {
  const t = k / 20
  const X = a0[0] + (a1[0] - a0[0]) * t, Z = a0[1] + (a1[1] - a0[1]) * t
  const hIn = ctx.heightAt(X - nW[0] * 0.05, Z - nW[1] * 0.05)
  const hOut = ctx.heightAt(X + nW[0] * 0.05, Z + nW[1] * 0.05)
  if (hIn == null || hOut == null) continue
  n++
  worst = Math.max(worst, Math.abs(hIn - hOut))
}
ok(n >= 15 && worst < 0.15, `surface continuous across the seam (${n} samples, worst step ${worst.toFixed(3)} m)`)

// Two parallel ridges end to end are a continuation, not a seam.
P('\ntwo E-W roofs end to end (continuation, not a seam)')
const L1 = seg('l1', [0, 0, 0], { ridgeAxis: 'east-west', width: 6, depth: 5, roofHeight: 3 })
const L2 = seg('l2', [6, 0, 0], { ridgeAxis: 'east-west', width: 6, depth: 5, roofHeight: 3 })
const c2 = resolveRoofContext(plan([L1, L2]))
ok(c2.segments.get('l1').shape.seams.length === 0 && c2.segments.get('l2').shape.seams.length === 0, 'no seam')

// An L whose wing ridge meets the main roof's EAVE side is a junction.
P('\nL: wing ridge runs into the main roof\'s eave side (junction, not a seam)')
const M = seg('m', [0, 0, 0], { ridgeAxis: 'east-west', width: 10, depth: 5, roofHeight: 3 })
const W = seg('w2', [3, 0, 5], { ridgeAxis: 'north-south', width: 4, depth: 5, roofHeight: 2.5 })
const c3 = resolveRoofContext(plan([M, W]))
ok(c3.segments.get('w2').shape.seams.length === 0 && c3.segments.get('m').shape.seams.length === 0, 'no seam')

// Different heights stay independent: no fuse, no levelling.
P('\nsame pair, wing ridge 0.5 m lower (independent)')
const c4 = resolveRoofContext(plan([MAIN, seg('wing', WING.roof.position, { ...WING.seg, roofHeight: 6.4 })]))
const w4 = c4.segments.get('wing'), m4 = c4.segments.get('main')
ok(w4.shape.seams.length === 0 && m4.shape.seams.length === 0, 'no seam')
const ry = (r) => r.placement.baseY + r.shape.frame.ridgeZ
ok(Math.abs(ry(w4) - ry(m4)) > 0.4, `wing keeps its own ridge height (${ry(w4).toFixed(2)} vs ${ry(m4).toFixed(2)})`)

// Level on a wing that has its own wall height lands exactly level.
P('\nL wing with a 0.6 m wall height, Level chosen')
const W5 = seg('w5', [3, 0, 4.5], { ridgeAxis: 'north-south', width: 4, depth: 5, roofHeight: 2.5, wallHeight: 0.6, ridgeMatch: 'level' })
const c5 = resolveRoofContext(plan([M, W5]))
ok(Math.abs(ry(c5.segments.get('w5')) - ry(c5.segments.get('m'))) < 0.005, `ridges level (${ry(c5.segments.get('w5')).toFixed(3)} vs ${ry(c5.segments.get('m')).toFixed(3)})`)

P(`\n${fails ? `${fails} FAILED` : 'ALL PASS'} | warnings: ${warns.length ? warns.join(' / ') : 'none'}`)
process.exit(fails ? 1 : 0)
