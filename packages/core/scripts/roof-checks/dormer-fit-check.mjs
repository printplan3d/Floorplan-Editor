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
// Editing the dormer's own window changes the window only, never the
// dormer (operator 2026-09-26), for gable and shed.
for (const type of ['gable', 'shed']) {
  const shape = (fit) => {
    const plan = buildPlan({ dormerWindow: 'window_lh3r' })
    Object.assign(plan.rseg_7ywyzq.dormers[0], { type, ...fit })
    return resolveRoofContext(plan).segments.get('rseg_7ywyzq').shape.dormers[0]
  }
  const d0 = shape({})
  const d1 = shape({ window: { sill: 0.6, h: 1.8, w: 0.5 } })
  const same = ['rZ', 'zFront', 'halfW', 'cheekD'].every((k) => Math.abs(d0[k] - d1[k]) < 1e-9) &&
    Math.hypot(d0.anchor[0] - d1.anchor[0], d0.anchor[1] - d1.anchor[1]) < 1e-9
  ok(same, `${type}: sill / height / width of its window leave the dormer where and as it was`)
}

P(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`)
process.exit(fails ? 1 : 0)
