import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { buildPlan, windowWorld } from './plan-fixture.mjs'
console.log = () => {}
console.warn = () => {}
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
const r2 = (v) => (v == null ? 'null' : Math.round(v * 100) / 100)

function report(label, nodes) {
  const ctx = resolveRoofContext(nodes)
  P(`\n===== ${label} =====`)
  for (const [id, r] of ctx.segments) {
    const f = r.shape.frame
    const o = r.opts
    P(`${id.padEnd(13)} styles=${JSON.stringify(r.shape.styles)} ridgeY=${r2(r.placement.baseY + f.ridgeZ)}`,
      `u=[${r2(f.uMin)},${r2(f.uMax)}] span=${r2(f.vMax - f.vMin)}`,
      o.truncateLo != null ? `truncLo=${r2(o.truncateLo)}` : '', o.truncateHi != null ? `truncHi=${r2(o.truncateHi)}` : '',
      o.junctionLo ? 'junctionLo' : '', o.junctionHi ? 'junctionHi' : '',
      o.ridgeRiseOverride != null ? `riseOverride=${r2(o.ridgeRiseOverride)}` : '',
      r.joinedTo ? `joined->${r.joinedTo} (${r.ridgeMatchApplied})` : '',
      o.realWallTop ? `realWallTop=${JSON.stringify(o.realWallTop.map(r2))}` : '',
      o.dormerOverrides ? `dormerOv=${JSON.stringify(Object.fromEntries(Object.entries(o.dormerOverrides).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, r2(b)]))])))}` : '')
  }
  return ctx
}

// 1) Plan as saved.
const plain = buildPlan()
const ctx = report('plan as saved', plain)

// Level-1 west wall 183n: x=-11.85, z -2.27..-6.49, top = 2.7 + 2.7 = 5.4.
P('\nL1 west wall (top 5.40): roof height along it')
for (const z of [-2.3, -3.0, -3.75, -4.5, -5.5, -6.4]) P(`  z=${z}  roof=${r2(ctx.heightAt(-11.85, z))}`)
const win = windowWorld(plain, 'window_lh3r')
const hWin = ctx.heightAt(win.x, win.z)
P(`L1 window lh3r: sill ${r2(win.sill)} head ${r2(win.head)} | roof above it ${r2(hWin)} ->`,
  hWin != null && win.cy > hWin ? 'COVERED by roof (hide)' : 'visible')

// 2) Dormer follows that window.
const withDormer = buildPlan({ dormerWindow: 'window_lh3r' })
const ctx2 = report('dormer follows L1 window lh3r', withDormer)
const h2 = ctx2.heightAt(win.x, win.z)
P(`L1 window lh3r: head ${r2(win.head)} | roof above it ${r2(h2)} ->`, h2 != null && win.head <= h2 ? 'CLEARS (visible under dormer)' : 'STILL COVERED')
for (const dz of [-0.9, -0.75, 0, 0.75, 0.9]) P(`  along wall dz=${dz}: roof=${r2(ctx2.heightAt(win.x, win.z + dz))}`)

// 3) Shallow west-edge pitch on the north roof: west eave lifts; L1 west wall
//    should be the parapet (realWallTop on that edge), not a band in front.
const shallow = buildPlan({ extra: { rseg_7ywyzq: { edgeWeights: [0.925, 0.925, 0.925, 0.35] } } })
const ctx3 = report('north roof, west edge shallowed (tan 0.35)', shallow)
const h3 = ctx3.heightAt(win.x, win.z)
P(`L1 window lh3r with west eave lifted: head ${r2(win.head)} | roof above ${r2(h3)} ->`, h3 != null && win.head <= h3 ? 'visible in the parapet wall' : 'covered')
