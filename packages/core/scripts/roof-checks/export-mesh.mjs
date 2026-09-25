// Dump the roof meshes the editor sends to the render pipeline for the
// operator's current plan (plan frame, exactly as export-json emits them).
import { roofMeshesForExport } from '../../dist/systems/roof/roof-export.js'
import { resolveRoofContext } from '../../dist/systems/roof/roof-scene.js'
import { buildPlan } from './plan-fixture.mjs'
import { writeFileSync } from 'node:fs'
console.log = () => {}
const plan = buildPlan({ extra: { rseg_7ywyzq: { depth: 4.499, edgeWeights: [0.577, 0.577, 0.577, 0.249] }, rseg_iz8x9q: { edgeWeights: undefined } } })
const ctx = resolveRoofContext(plan)
const meshes = roofMeshesForExport(plan, ctx)
const out = {}
for (const [id, m] of meshes) {
  const v = []
  for (let i = 0; i < m.vertices.length; i += 3) v.push(-m.vertices[i], m.vertices[i + 2], m.vertices[i + 1]) // export-json toPlanMesh
  const ys = m.vertices.filter((_, i) => i % 3 === 1)
  out[id] = { editor_mesh: { vertices: v, faces: m.faces, ...(m.glass.length ? { glass: m.glass } : {}) }, worldYmax: Math.max(...ys), worldYmin: Math.min(...ys) }
}
const target = process.argv[2]
if (target) writeFileSync(target, JSON.stringify(out))
process.stdout.write(Object.entries(out).map(([id, o]) => `${id}: verts ${o.editor_mesh.vertices.length / 3} tris ${o.editor_mesh.faces.length / 3} glass ${(o.editor_mesh.glass || []).length} y=[${o.worldYmin.toFixed(2)},${o.worldYmax.toFixed(2)}]`).join('\n') + '\n')
