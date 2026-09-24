import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { generateShellSegmentGeometry } from '../../dist/systems/roof/shell-preview.js'
import { buildPlan } from './plan-fixture.mjs'
const warns = []
console.log = () => {}
console.warn = (...a) => warns.push(a.map(String).join(' ').slice(0, 140))
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
const r2 = (v) => (v == null ? 'null' : Math.round(v * 100) / 100)
const SLOT = ['wall', 'slate', 'soffit', 'fascia']

// Facing audit in the segment's local frame: slate up, soffit down (except
// the hidden interior cap), vertical walls/boards outward from the centre.
function audit(g) {
  const pos = g.attributes.position.array
  const idx = g.index ? g.index.array : null
  const tri = (idx ? idx.length : pos.length / 3) / 3
  const slotOf = new Array(tri).fill(-1)
  for (const gr of g.groups) for (let t = gr.start / 3; t < (gr.start + gr.count) / 3; t++) slotOf[t] = gr.materialIndex
  let cx = 0, cz = 0
  for (let i = 0; i < pos.length; i += 3) { cx += pos[i]; cz += pos[i + 2] }
  cx /= pos.length / 3; cz /= pos.length / 3
  let bad = 0, maxSlot = 0
  for (let t = 0; t < tri; t++) {
    const I = (k) => (idx ? idx[3 * t + k] : 3 * t + k) * 3
    const a = I(0), b = I(1), c = I(2)
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const L = Math.hypot(nx, ny, nz); if (L < 1e-9) continue
    nx /= L; ny /= L; nz /= L
    const mx = (pos[a] + pos[b] + pos[c]) / 3, mz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3
    const s = SLOT[slotOf[t]]
    maxSlot = Math.max(maxSlot, slotOf[t])
    if (s === 'slate' && !(ny > 0.05)) bad++
    else if (s === 'soffit' && Math.abs(ny) > 0.99 && ny > 0) { /* interior cap faces up: hidden, fine */ }
    else if (s === 'soffit' && !(ny < 0.05)) bad++
  }
  return { verts: g.attributes.position.count, groups: g.groups.length, wrongFacing: bad, maxSlot }
}

function geomReport(label, nodes) {
  const ctx = resolveRoofContext(nodes)
  P(`\n== ${label}`)
  for (const [id, r] of ctx.segments) {
    const g = generateShellSegmentGeometry(r.placement.seg, r.opts)
    const a = audit(g)
    P(`  ${id.padEnd(13)} styles=${JSON.stringify(r.shape.styles)} ridgeY=${r2(r.placement.baseY + r.shape.frame.ridgeZ)}`,
      `u=[${r2(r.shape.frame.uMin)},${r2(r.shape.frame.uMax)}]`, r.joinedTo ? `joined(${r.ridgeMatchApplied})` : '',
      `| verts ${a.verts} groups ${a.groups} maxSlot ${a.maxSlot} wrongFacing ${a.wrongFacing}`)
  }
  return ctx
}

geomReport('operator plan as saved', buildPlan())
geomReport('operator plan, dormer follows L1 window', buildPlan({ dormerWindow: 'window_lh3r' }))
geomReport('operator plan, dormer follows window, SHED', buildPlan({ dormerWindow: 'window_lh3r', extra: { rseg_7ywyzq: { dormers: [{ id: 'dorm1', type: 'shed', parentFaceId: 0, ridgeHeight: 1, cheekWidth: 2, ridgeOrientation: 'orthogonal', footOnParent: [[0.3, 0.3], [0.5, 0.4]], windowId: 'window_lh3r' }] } } }))
geomReport('operator plan, dormer follows window, HIP', buildPlan({ dormerWindow: 'window_lh3r', extra: { rseg_7ywyzq: { dormers: [{ id: 'dorm1', type: 'hip', parentFaceId: 0, ridgeHeight: 1, cheekWidth: 2, ridgeOrientation: 'orthogonal', footOnParent: [[0.3, 0.3], [0.5, 0.4]], windowId: 'window_lh3r' }] } } }))
geomReport('operator plan, west edge shallowed', buildPlan({ extra: { rseg_7ywyzq: { edgeWeights: [0.925, 0.925, 0.925, 0.35] } } }))
const bay = geomReport('operator plan, south roof default pitch (bay must EXTEND up the slope)', buildPlan({ extra: { rseg_iz8x9q: { edgeWeights: undefined } } }))
const b = bay.segments.get('rseg_l3l6ct')
P(`   bay west end: was world x=${r2(-3.712 - 0.691)}, now x=${r2(-3.712 + b.shape.frame.uMin)}  (south east wall at x=-4.13)`)

// Synthetic L on one level: main gable E-W 10x6, wing HIP N-S 6 wide, overlapping in the corner.
function lPlan(wingType, extraWing = {}) {
  const nodes = { level_0: { id: 'level_0', type: 'level', level: 0, children: [] } }
  nodes.w0 = { id: 'w0', type: 'wall', parentId: 'level_0', start: [0, 0], end: [10, 0], height: 2.7, thickness: 0.15, bulge: 0, children: [] }
  nodes.level_0.children.push('w0')
  const add = (rid, pos, sid, seg) => {
    nodes[rid] = { id: rid, type: 'roof', parentId: 'level_0', position: pos, rotation: 0, children: [sid] }
    nodes.level_0.children.push(rid)
    nodes[sid] = { id: sid, type: 'roof-segment', parentId: rid, position: [0, 0, 0], rotation: 0, wallHeight: 0, overhang: 0.3, ...seg }
  }
  add('roof_A', [5, 0, 3], 'seg_A_main', { roofType: 'gable', ridgeAxis: 'east-west', width: 10, depth: 6, roofHeight: 3 })
  add('roof_B', [3, 0, 5], 'seg_B_wing', { roofType: wingType, ridgeAxis: 'north-south', width: 6, depth: 10, roofHeight: 2.2, ...extraWing })
  return nodes
}
const L1 = geomReport('synthetic L: main gable E-W + wing HIP N-S (wing ridge 2.2 -> level-matched to 3.0)', lPlan('hip'))
const w = L1.segments.get('seg_B_wing')
P(`   wing buried end now at world z=${r2(5 + w.shape.frame.uMin)} (main ridge line z=3)`)
geomReport('synthetic L: wing GABLE, ridgeMatch=pitch (dropped ridge)', lPlan('gable', { ridgeMatch: 'pitch' }))
const Li = geomReport('synthetic L: wing gable, ridgeMatch=independent (ridge 2.2 dies into the slope)', lPlan('gable', { ridgeMatch: 'independent' }))
const wi = Li.segments.get('seg_B_wing')
P(`   wing end at world z=${r2(5 + wi.shape.frame.uMin)}; main roof there = ${r2(Li.heightAt(3, 5 + wi.shape.frame.uMin))} vs wing ridge ${r2(wi.placement.baseY + wi.shape.frame.ridgeZ)}`)

P('\nunion warnings:', warns.length ? warns.join(' | ') : 'none')
