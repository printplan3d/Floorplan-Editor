// A dormer following a window stays editable (operator 2026-09-26): extra
// width, headroom and a sideways shift adjust the window fit.
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { buildPlan } from './plan-fixture.mjs'
console.log = () => {}
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
let fails = 0
const ok = (c, l) => { P(`  ${c ? 'PASS' : 'FAIL'} ${l}`); if (!c) fails++ }
const ov = (fit) => {
  const plan = buildPlan({ dormerWindow: 'window_lh3r' })
  Object.assign(plan.rseg_7ywyzq.dormers[0], fit)
  return resolveRoofContext(plan).segments.get('rseg_7ywyzq').opts.dormerOverrides.dorm1
}
const base = ov({})
P(`\nfollowing window lh3r: width ${base.cheekWidth.toFixed(2)} ridge ${base.ridgeHeight.toFixed(2)} u ${base.uMid.toFixed(3)}`)
ok(Math.abs(base.cheekWidth - 2.0) < 1e-6, 'default width = window 1.5 + 0.5')
const wide = ov({ fitWidth: 1.5 })
ok(Math.abs(wide.cheekWidth - 3.0) < 1e-6, `extra width 1.5 -> ${wide.cheekWidth.toFixed(2)} m`)
const tall = ov({ fitHeadroom: 0.65 })
ok(tall.ridgeHeight > base.ridgeHeight + 0.4, `headroom 0.65 raises the dormer (${base.ridgeHeight.toFixed(2)} -> ${tall.ridgeHeight.toFixed(2)})`)
const moved = ov({ fitOffset: 0.5 })
ok(Math.abs(moved.uMid - base.uMid) > 0.01 && moved.edgeIdx === base.edgeIdx, `shift 0.5 m moves it along the eave (u ${base.uMid.toFixed(3)} -> ${moved.uMid.toFixed(3)})`)
P(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`)
process.exit(fails ? 1 : 0)
