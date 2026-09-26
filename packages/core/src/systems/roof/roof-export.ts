/**
 * The roof exactly as the preview draws it, for the render pipeline.
 *
 * Agreed with the operator 2026-09-26: the backend renders the editor's own
 * roof mesh instead of rebuilding it from masses, so the render can never
 * disagree with the preview (joins, filled-in walls, step walls, dormers
 * that follow windows — all of it lives here, once). Plans that come from
 * elsewhere (mobile, API) carry no mesh and keep the backend's builder.
 */
import type { AnyNode, RoofSegmentNode } from '../../schema'
import type { RoofContext } from './roof-scene'
import { getRoofContext } from './roof-system'
import { generateShellSegmentGeometry, SLOT_GLASS } from './shell-preview'

/** One roof segment's final mesh in WORLD coordinates (three.js frame: X, Y
 *  up, Z), as flat arrays: vertices [x, y, z, ...] in metres rounded to the
 *  millimetre, faces [a, b, c, ...] counter-clockwise from outside, and
 *  `glass`: indices (into the face list) of dormer-window glass triangles. */
export type RoofExportMesh = { vertices: number[]; faces: number[]; glass: number[] }

const round = (v: number) => Math.round(v * 1000) / 1000

export function roofMeshesForExport(
  nodes: Record<string, AnyNode>,
  ctx: RoofContext = getRoofContext(nodes),
  only?: Set<string>,
): Map<string, RoofExportMesh> {
  const out = new Map<string, RoofExportMesh>()
  for (const [segId, r] of ctx.segments) {
    if (only && !only.has(segId)) continue
    const g = generateShellSegmentGeometry(r.placement.seg as RoofSegmentNode, r.opts)
    if (!g) continue
    const pos = g.getAttribute('position')
    const idx = g.getIndex()
    if (!pos || pos.count === 0) {
      g.dispose()
      continue
    }
    const pl = r.placement
    const vertices: number[] = []
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      const z = pos.getZ(i)
      vertices.push(
        round(pl.tx + pl.cos * x + pl.sin * z),
        round(pl.baseY + y),
        round(pl.tz - pl.sin * x + pl.cos * z),
      )
    }
    const faces: number[] = []
    const glass: number[] = []
    const slotOf = (k: number) => {
      for (const gr of g.groups) if (k >= gr.start && k < gr.start + gr.count) return gr.materialIndex ?? 0
      return 0
    }
    const n = idx ? idx.count : pos.count
    for (let k = 0; k + 2 < n; k += 3) {
      const a = idx ? idx.getX(k) : k
      const b = idx ? idx.getX(k + 1) : k + 1
      const c = idx ? idx.getX(k + 2) : k + 2
      if (a === b || b === c || a === c) continue
      if (slotOf(k) === SLOT_GLASS) glass.push(faces.length / 3)
      faces.push(a, b, c)
    }
    g.dispose()
    if (faces.length) out.set(segId, { vertices, faces, glass })
  }
  return out
}
