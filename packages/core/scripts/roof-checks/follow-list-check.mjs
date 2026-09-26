// "Follow window" offers only windows that reach into the roof (a roof on
// L0 covers L1: its windows), plus any window a dormer already follows.
import { resolveRoofContext, windowsUnderSegment } from '../../dist/systems/roof/roof-scene.js'
import { buildPlan } from './plan-fixture.mjs'
console.log = () => {}
const P = (...a) => process.stdout.write(a.join(' ') + '\n')
let fails = 0
const ok = (c, l) => { P(`  ${c ? 'PASS' : 'FAIL'} ${l}`); if (!c) fails++ }
const plan = buildPlan()
const ctx = resolveRoofContext(plan)
const all = Object.values(plan).filter((n) => n.type === 'window').map((w) => [w.id, plan[w.wallId].parentId])
const list = windowsUnderSegment(plan, ctx, 'rseg_7ywyzq')
P(`\nnorth roof offers: ${list.map((w) => w.label + ' [' + w.id + ']').join(', ') || 'nothing'}`)
ok(list.some((w) => w.id === 'window_lh3r'), 'L1 window lh3r offered')
ok(list.every((w) => plan[plan[w.id].wallId].parentId === 'level_1'), 'no L0 window offered')
const l0 = all.find(([id, lvl]) => lvl === 'level_0' && windowsUnderSegment(plan, ctx, 'rseg_7ywyzq', [id]).some((w) => w.id === id))
ok(!!l0, 'an L0 window a dormer already follows is still listed')
if (l0) P(`    ${windowsUnderSegment(plan, ctx, 'rseg_7ywyzq', [l0[0]]).find((w) => w.id === l0[0]).label}`)
P(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAIL(S)`}`)
