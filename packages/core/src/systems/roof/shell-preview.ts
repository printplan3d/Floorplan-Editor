/**
 * Client-side shell-roof geometry — port of blender_pipeline_dev/roof/shell.
 *
 * Produces THREE.BufferGeometry for a RoofSegmentNode that matches the
 * backend shell path for hip and gable rectangles with variable pitch,
 * plus gable/shed/hip dormers.
 *
 * Semantics (agreed with the operator 2026-09-22):
 *   - Segment local frame: z_bottom = 0 at storey wall top. The whole
 *     mesh is placed in world by roof-system's mesh.position from the
 *     segment's `position` field. wallHeight is a PARAPET added ABOVE
 *     storey wall top (not the interior chamber height the old
 *     face-generator used).
 *   - Ridge Z above eave, for opposing hip edges with editor tan
 *     values t_a, t_b and full span W perpendicular to the ridge:
 *          ridge_rise = W · (t_a · t_b) / (t_a + t_b)
 *     Under the wavefront convention that's t=W/(c_a+c_b) where
 *     c_i = 1/t_i (inward speed). Verified against the backend's
 *     symmetric 10×10 uniform-t=1 case giving ridge Z = 5.
 *   - Gable-marked edges collapse near-vertical (c ≈ 0). Same
 *     MIN_EDGE_WEIGHT floor as the backend keeps the math stable.
 *   - Dormers are gable/shed/hip primitives unioned into the base
 *     shell via three-bvh-csg, mirroring the backend csg.union step.
 *
 * What this file DOES NOT do:
 *   - General non-rectangular polygons (needs full weighted skeleton;
 *     Phase 5). The base polygon is derived from width/depth or the
 *     4-point custom polygon; anything else falls back to a bounding
 *     rectangle.
 *   - Gambrel / dutch / mansard (backend refuses them too).
 *   - Wall clip (Phase 4).
 */
import * as THREE from 'three'
import { ADDITION, Brush, Evaluator } from 'three-bvh-csg'
import type { RoofSegmentNode } from '../../schema'

// ─── Constants matching the backend ────────────────────────────────
const MIN_EDGE_WEIGHT = 0.01 // shell/skeleton/constants.py
const DEFAULT_FASCIA_THICKNESS_M = 0.18 // shell.py
const NEAR_VERTICAL_TAN = 100.0 // editor-side representation of a "vertical" gable edge

// three-bvh-csg needs materials to union brushes; we use dummies here
// and the roof-system's outer material mapper picks slots by group.
const dummyMats: [THREE.Material, THREE.Material, THREE.Material, THREE.Material] = [
  new THREE.MeshBasicMaterial(),
  new THREE.MeshBasicMaterial(),
  new THREE.MeshBasicMaterial(),
  new THREE.MeshBasicMaterial(),
]

const _csg = new Evaluator()
_csg.useGroups = true
_csg.attributes = ['position', 'normal']
// consolidateGroups OFF, and the material remap done by hand after each
// evaluate (see _remapToSlots). three-bvh-csg 0.0.18 has a bug in this
// path: GeometryBuilder sizes groupIndices lazily, only up to the highest
// group that received an output triangle, but consolidation SORTS the
// group list by material first. A group whose triangles were all culled
// can then land at a loop position its index doesn't exist at, and
// buildGeometry throws "Cannot destructure property 'count' of
// 'groupIndices[index]'". Without consolidation the list stays in index
// order and the loop's min(groupOrder, groupIndices) bound is safe.
//
// Reproduced with the operator's own roof by running this module's
// compiled output in node: overhang 0.3 -> union throws, dormer silently
// dropped (72 verts with or without it); overhang 0 -> union succeeds.
// Adding the eave fascia/soffit is what tipped it — more groups in the
// base, some of them wholly culled under the dormer.
// Present in Evaluator.js at runtime but missing from 0.0.18's .d.ts.
;(_csg as unknown as { consolidateGroups: boolean }).consolidateGroups = false

/**
 * Point every group back at our fixed 4-slot material layout.
 *
 * With consolidation off, B's groups come back offset past A's
 * materials (so a dormer's slate might read slot 5), and any unused
 * materials may have been dropped from the list. Matching by material
 * OBJECT identity against dummyMats is exact regardless of either.
 */
function _remapToSlots(brush: Brush): void {
  const mats = (Array.isArray(brush.material) ? brush.material : [brush.material]) as THREE.Material[]
  for (const g of brush.geometry.groups) {
    const slot = dummyMats.indexOf(mats[g.materialIndex ?? 0] as THREE.MeshBasicMaterial)
    g.materialIndex = slot >= 0 ? slot : 0
  }
  brush.material = dummyMats
}

// Material slot indices — must line up with roof-system.tsx's
// existing 4-slot layout (rake / roof-deck / interior / shingle-top).
const SLOT_WALL_EXTERIOR = 0
const SLOT_SLATE_TOP = 1
const SLOT_SOFFIT = 2
const SLOT_FASCIA = 3

/** Depth of the fascia board, matching the backend's
 *  DEFAULT_FASCIA_THICKNESS_M in blender_pipeline_dev/roof/shell/shell.py. */
const FASCIA_M = 0.18
// SLOT 3 kept spare; matches roof-system.tsx layout.

// ─── Public entry ──────────────────────────────────────────────────

/**
 * Build a BufferGeometry for one roof segment, in the segment's local
 * frame. The mesh's world position is set by the caller — this
 * function only sees LOCAL coordinates centred at (0, 0, 0) with
 * z_bottom = 0 at storey wall top.
 *
 * Returns null when the segment shape isn't handled here (e.g. mansard).
 * Callers fall back to the legacy analytical engine in roof-system.tsx.
 */
export function generateShellSegmentGeometry(
  node: RoofSegmentNode,
): THREE.BufferGeometry | null {
  const kind = node.roofType
  if (kind === 'gambrel' || kind === 'dutch' || kind === 'mansard') {
    console.log('[shell-preview]', node.id, 'kind', kind, '→ null (legacy path)')
    return null // backend can't render these either — legacy path handles preview
  }

  const polygon = _resolvePolygon(node)
  if (polygon.length !== 4) {
    console.log('[shell-preview]', node.id, 'polygon len', polygon.length, '→ null')
    return null
  }

  const edgeStyles = _resolveEdgeStyles(node, polygon)
  const edgeTans = _resolveEdgeTans(node, edgeStyles)

  const baseZ = Math.max(0, node.wallHeight ?? 0) // parapet — z=0 is storey wall top
  console.log(
    '[shell-preview]',
    node.id,
    'kind',
    kind,
    'w',
    node.width,
    'd',
    node.depth,
    'baseZ',
    baseZ,
    'roofH',
    node.roofHeight,
    'styles',
    edgeStyles,
    'tans',
    edgeTans,
  )
  const parts: THREE.BufferGeometry[] = []

  // Base solid — walls (below eave), roof slopes, gable triangles.
  const targetRidgeRise = Math.max(0.01, node.roofHeight ?? 2.5)
  const overhang = Math.max(0, Number((node as { overhang?: number }).overhang ?? 0.3))
  const frame = _roofFrame(polygon, edgeStyles, edgeTans, baseZ, targetRidgeRise, overhang)
  if (!frame) return null
  const shell = _buildRectangleShell(polygon, edgeStyles, frame)
  if (shell) parts.push(shell)

  const geom = _concat(parts)
  if (!geom) {
    console.log('[shell-preview]', node.id, '→ empty geometry (no parts)')
    return new THREE.BufferGeometry()
  }
  const posAttr = geom.getAttribute('position')
  console.log(
    '[shell-preview]',
    node.id,
    '→ geom with',
    posAttr?.count ?? 0,
    'verts',
    geom.getIndex()?.count ?? 0,
    'indices',
    geom.groups.length,
    'groups',
  )

  // Dormers — union each into the merged shell via CSG so the ridge
  // and window openings integrate cleanly.
  const dormers = _resolveDormers(node)
  if (dormers.length > 0) {
    return _unionDormers(geom, dormers, polygon, edgeStyles, edgeTans, frame)
  }

  geom.computeVertexNormals()
  return geom
}

// ─── Geometry helpers ─────────────────────────────────────────────

type EdgeStyle = 'hip' | 'gable'

function _resolvePolygon(node: RoofSegmentNode): [number, number][] {
  // Local corners in the SEGMENT frame. The full transform to
  // world happens via mesh.position + mesh.rotation.y in
  // roof-system.tsx. Editor's convention has +X east, +Z south
  // (Y is up), so a rectangle centred at origin has corners
  // (-w/2, -d/2)..(w/2, d/2) in XZ.
  const poly = (node as unknown as { polygon?: [number, number][] }).polygon
  if (Array.isArray(poly) && poly.length === 4) {
    return poly.map(([x, z]) => [Number(x), Number(z)] as [number, number])
  }
  const w = node.width
  const d = node.depth
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ]
}

function _resolveEdgeStyles(
  node: RoofSegmentNode,
  polygon: [number, number][],
): EdgeStyle[] {
  const explicit = (node as unknown as { edges?: { style: EdgeStyle }[] }).edges
  if (Array.isArray(explicit) && explicit.length === polygon.length) {
    return explicit.map((e) =>
      String(e?.style).toLowerCase() === 'gable' ? 'gable' : 'hip',
    ) as EdgeStyle[]
  }
  // Derive from roofType + ridgeAxis.
  if (node.roofType === 'hip' || node.roofType === 'flat') {
    return ['hip', 'hip', 'hip', 'hip']
  }
  if (node.roofType === 'shed') {
    // Shed: one sloped face (front eave), three vertical walls.
    return ['hip', 'gable', 'gable', 'gable']
  }
  // gable — pick pair based on ridgeAxis. Local edges (CCW starting
  // from bottom-left rectangle corner):
  //   edge 0: (-w/2,-d/2) → (w/2,-d/2)   = bottom (along X, at min-Z)
  //   edge 1: (w/2,-d/2)  → (w/2,d/2)    = right  (along Z, at max-X)
  //   edge 2: (w/2,d/2)   → (-w/2,d/2)   = top    (along X, at max-Z)
  //   edge 3: (-w/2,d/2)  → (-w/2,-d/2)  = left   (along Z, at min-X)
  const axis = node.ridgeAxis
  const w = node.width
  const d = node.depth
  // ridge east-west → gable ends on E and W (edges 1 and 3).
  // ridge north-south → gable ends on N and S (edges 0 and 2).
  // Auto → longer axis is the ridge (backend heuristic).
  const ew = axis === 'east-west' || (axis !== 'north-south' && w >= d)
  return ew ? ['hip', 'gable', 'hip', 'gable'] : ['gable', 'hip', 'gable', 'hip']
}

function _resolveEdgeTans(node: RoofSegmentNode, styles: EdgeStyle[]): number[] {
  const authored = (node as unknown as { edgeWeights?: number[] }).edgeWeights
  const n = styles.length
  const uniformTan = _uniformTanFromRoofHeight(node)
  const base: number[] = new Array(n).fill(uniformTan)
  if (Array.isArray(authored) && authored.length === n) {
    for (let i = 0; i < n; i++) {
      const w = Number(authored[i])
      if (w > 0 && Number.isFinite(w)) base[i] = w
    }
  }
  // Gable-style edges collapse near-vertical regardless of authored
  // weight — a gable end IS vertical by definition.
  for (let i = 0; i < n; i++) {
    if (styles[i] === 'gable') base[i] = NEAR_VERTICAL_TAN
  }
  return base
}

function _uniformTanFromRoofHeight(node: RoofSegmentNode): number {
  // Backend heuristic (editor_scene_translator_dev.py comment):
  //   ridge N-S → slopes fall E-W → run = width / 2
  //   ridge E-W → slopes fall N-S → run = depth / 2
  //   hip       → run = min(w, d) / 2
  // Match it here so uniform-pitch previews land on the same rise the
  // backend picks.
  const rh = Math.max(0.01, node.roofHeight ?? 2.5)
  let run: number
  if (node.roofType === 'gable') {
    const axis = node.ridgeAxis
    const ns = axis === 'north-south' || (axis !== 'east-west' && node.width < node.depth)
    run = Math.max(0.1, ns ? node.width / 2 : node.depth / 2)
  } else {
    run = Math.max(0.1, Math.min(node.width, node.depth) / 2)
  }
  return rh / run
}

// ─── Rectangle shell (analytical) ─────────────────────────────────

/**
 * Analytical shell for a 4-vertex polygon (rectangle in Phase 1).
 * Computes ridge geometry from weighted-skeleton math without running
 * the full simulation — closed form for 4 edges.
 */
/**
 * Everything about a rectangle roof's geometry that both the shell and
 * its dormers need to agree on: where the ridge is, how far the eave
 * is from it, and how high each edge's eave ended up.
 *
 * Shared deliberately. The dormers used to derive their own placement
 * from unrelated numbers and drifted off the roof as a result.
 */
type RoofFrame = {
  ridgeAlongX: boolean
  /** Horizontal run from any eave to the ridge. */
  halfSpan: number
  ridgeZ: number
  /** Eave height per EDGE index. */
  eaveOf: number[]
  /** Eave height per polygon CORNER index. */
  cornerY: number[]
  ridgeLow: [number, number, number]
  ridgeHigh: [number, number, number]
  /** Eave overhang in metres, projected beyond the wall line. */
  overhang: number
  /** tan(pitch) of the SIDE edge each polygon corner belongs to. */
  cornerTan: number[]
}

function _roofFrame(
  polygon: [number, number][],
  styles: EdgeStyle[],
  tans: number[],
  baseZ: number,
  targetRidgeRise: number,
  overhang: number,
): RoofFrame | null {
  if (polygon.length !== 4) return null
  const xs = polygon.map((p) => p[0])
  const zs = polygon.map((p) => p[1])
  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const zMin = Math.min(...zs)
  const zMax = Math.max(...zs)
  const W = xMax - xMin
  const D = zMax - zMin
  if (W <= 0 || D <= 0) return null

  // RIDGE IS CENTRED AND PINNED; EAVES ARE DERIVED PER EDGE.
  // Operator's rule 2026-09-25: the ridge stays in the middle at the
  // slider height, and changing ONE edge's pitch moves ONLY that
  // edge's eave (growing a parapet on that side alone).
  //
  //     eave_i = ridgeZ - tan_i * halfSpan
  //
  // Backward compatible: with no authored per-edge pitch every edge
  // takes _uniformTanFromRoofHeight = roofHeight / run, and run IS
  // halfSpan, so every eave lands back on baseZ.
  const gableOnXEnds = styles[1] === 'gable' || styles[3] === 'gable'
  const gableOnZEnds = styles[0] === 'gable' || styles[2] === 'gable'
  // A gable end caps the ridge, so the ridge runs perpendicular to it.
  const ridgeAlongX = gableOnXEnds ? true : gableOnZEnds ? false : W >= D

  const halfSpan = (ridgeAlongX ? D : W) / 2
  const ridgeZ = baseZ + targetRidgeRise

  const sideA = ridgeAlongX ? 0 : 1
  const sideB = ridgeAlongX ? 2 : 3
  const eaveA = ridgeZ - Math.max(MIN_EDGE_WEIGHT, tans[sideA]!) * halfSpan
  const eaveB = ridgeZ - Math.max(MIN_EDGE_WEIGHT, tans[sideB]!) * halfSpan
  const meanEave = (eaveA + eaveB) / 2

  const eaveOf = [meanEave, meanEave, meanEave, meanEave]
  eaveOf[sideA] = eaveA
  eaveOf[sideB] = eaveB

  // Corners take the eave of the SIDE edge they belong to, which keeps
  // the shell closed when the two pitches differ — the end face just
  // gets a sloping base.
  const cornerY = ridgeAlongX
    ? [eaveA, eaveA, eaveB, eaveB]
    : [eaveB, eaveA, eaveA, eaveB]
  const tA = Math.max(MIN_EDGE_WEIGHT, tans[sideA]!)
  const tB = Math.max(MIN_EDGE_WEIGHT, tans[sideB]!)
  const cornerTan = ridgeAlongX ? [tA, tA, tB, tB] : [tB, tA, tA, tB]

  // A gable end runs the ridge out to the wall; a hip end pulls it
  // back by however far its own pitch needs to climb.
  const axisLen = ridgeAlongX ? W : D
  const insetFor = (edgeIdx: number): number => {
    if (styles[edgeIdx] === 'gable') return 0
    const t = Math.max(MIN_EDGE_WEIGHT, tans[edgeIdx]!)
    return Math.min(Math.max((ridgeZ - meanEave) / t, 0), axisLen / 2)
  }
  const insetLow = insetFor(ridgeAlongX ? 3 : 0)
  const insetHigh = insetFor(ridgeAlongX ? 1 : 2)
  const mid = ridgeAlongX ? (zMin + zMax) / 2 : (xMin + xMax) / 2

  return {
    ridgeAlongX,
    halfSpan,
    ridgeZ,
    eaveOf,
    cornerY,
    overhang: Math.max(0, overhang),
    cornerTan,
    ridgeLow: ridgeAlongX
      ? [xMin + insetLow, ridgeZ, mid]
      : [mid, ridgeZ, zMin + insetLow],
    ridgeHigh: ridgeAlongX
      ? [xMax - insetHigh, ridgeZ, mid]
      : [mid, ridgeZ, zMax - insetHigh],
  }
}

function _buildRectangleShell(
  polygon: [number, number][],
  styles: EdgeStyle[],
  frame: RoofFrame,
): THREE.BufferGeometry | null {
  const { ridgeAlongX, cornerY, cornerTan, overhang, ridgeLow, ridgeHigh } = frame

  // Wall-line corners: where the roof meets the storey wall.
  const wall = polygon.map(
    ([x, z], i) => [x, cornerY[i]!, z] as [number, number, number],
  )

  // Eave corners: the wall line pushed OUT by the overhang, dropping
  // along the slope as it goes.
  //
  // Phase 1 skipped this — "eave sits AT the polygon edge (no overhang
  // ... comes back in Phase 5)" — which left the preview with no eave
  // detail at all while the backend had been projecting
  // eave_overhang_cm (default 30) and a fascia board the whole time.
  // Rectangles here are axis-aligned, so outward is simply away from
  // the centre on each axis.
  const cx = polygon.reduce((a, p) => a + p[0], 0) / polygon.length
  const cz = polygon.reduce((a, p) => a + p[1], 0) / polygon.length
  const c = polygon.map(([x, z], i) => {
    const ox = x + Math.sign(x - cx) * overhang
    const oz = z + Math.sign(z - cz) * overhang
    // Drop along the slope of the side edge this corner belongs to.
    return [ox, cornerY[i]! - cornerTan[i]! * overhang, oz] as [
      number,
      number,
      number,
    ]
  })

  const faces: { verts: [number, number, number][]; slot: number }[] = []
  const slotFor = (i: number) =>
    styles[i] === 'gable' ? SLOT_WALL_EXTERIOR : SLOT_SLATE_TOP

  if (ridgeAlongX) {
    faces.push({ verts: [c[0]!, c[1]!, ridgeHigh, ridgeLow], slot: slotFor(0) })
    faces.push({ verts: [c[2]!, c[3]!, ridgeLow, ridgeHigh], slot: slotFor(2) })
    faces.push({ verts: [c[1]!, c[2]!, ridgeHigh], slot: slotFor(1) })
    faces.push({ verts: [c[3]!, c[0]!, ridgeLow], slot: slotFor(3) })
  } else {
    faces.push({ verts: [c[1]!, c[2]!, ridgeHigh, ridgeLow], slot: slotFor(1) })
    faces.push({ verts: [c[3]!, c[0]!, ridgeLow, ridgeHigh], slot: slotFor(3) })
    faces.push({ verts: [c[0]!, c[1]!, ridgeLow], slot: slotFor(0) })
    faces.push({ verts: [c[2]!, c[3]!, ridgeHigh], slot: slotFor(2) })
  }

  // Fascia board — the vertical strip hanging off the eave edge, and
  // the soffit closing the underside back to the wall.
  if (overhang > 1e-3) {
    const drop = (p: [number, number, number]): [number, number, number] => [
      p[0],
      p[1] - FASCIA_M,
      p[2],
    ]
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      faces.push({
        verts: [drop(c[i]!), drop(c[j]!), c[j]!, c[i]!],
        slot: SLOT_FASCIA,
      })
      // Soffit: horizontal underside from the fascia bottom back in to
      // the wall, at the fascia-bottom height so it reads flat.
      const wi: [number, number, number] = [wall[i]![0], c[i]![1] - FASCIA_M, wall[i]![2]]
      const wj: [number, number, number] = [wall[j]![0], c[j]![1] - FASCIA_M, wall[j]![2]]
      faces.push({ verts: [wi, wj, drop(c[j]!), drop(c[i]!)], slot: SLOT_SOFFIT })
    }
  }

  // Wall band — storey wall top (z=0) up to this corner's eave. THIS
  // is the parapet: it grows on the side whose pitch was shallowed and
  // nowhere else. Measured at the WALL line, not the eave line, so the
  // overhang doesn't stretch it.
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    if (wall[i]![1] <= 1e-3 && wall[j]![1] <= 1e-3) continue
    const lo_i: [number, number, number] = [wall[i]![0], 0, wall[i]![2]]
    const lo_j: [number, number, number] = [wall[j]![0], 0, wall[j]![2]]
    faces.push({ verts: [lo_i, lo_j, wall[j]!, wall[i]!], slot: SLOT_WALL_EXTERIOR })
  }

  // Soffit — flat cap under the roof so walk-mode doesn't see sky from
  // below. Sits at the lowest eave so it never pokes through a slope.
  const soffitY = Math.min(...cornerY)
  faces.push({
    verts: polygon.map(
      ([x, z]) => [x, soffitY, z] as [number, number, number],
    ),
    slot: SLOT_SOFFIT,
  })

  return _facesToGeometry(faces)
}

// ─── Dormers — port of blender_pipeline_dev/roof/shell/dormers.py ─

type DormerSpec = {
  id: string
  parentFaceId: number
  footOnParent: [[number, number], [number, number]]
  type: 'gable' | 'shed' | 'hip'
  ridgeHeight: number
  cheekWidth: number
}

function _resolveDormers(node: RoofSegmentNode): DormerSpec[] {
  const raw = (node as unknown as { dormers?: DormerSpec[] }).dormers
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (d) =>
      d &&
      Array.isArray(d.footOnParent) &&
      d.footOnParent.length === 2 &&
      typeof d.ridgeHeight === 'number' &&
      typeof d.cheekWidth === 'number',
  )
}

function _unionDormers(
  base: THREE.BufferGeometry,
  dormers: DormerSpec[],
  polygon: [number, number][],
  styles: EdgeStyle[],
  tans: number[],
  frame: RoofFrame,
): THREE.BufferGeometry {
  // Turn the base geometry into a Brush, then union each dormer.
  let acc: Brush = new Brush(base, dummyMats)
  acc.updateMatrixWorld()
  for (const d of dormers) {
    const dgeo = _buildDormerGeometry(d, polygon, styles, tans, frame)
    if (!dgeo) continue
    const dbrush = new Brush(dgeo, dummyMats)
    dbrush.updateMatrixWorld()
    try {
      const next = _csg.evaluate(acc, dbrush, ADDITION) as Brush
      _remapToSlots(next)
      acc.geometry.dispose()
      dbrush.geometry.dispose()
      acc = next
    } catch (e) {
      // If a dormer union fails (usually because the primitive lies
      // outside the parent slope), silently skip — the base preview
      // still shows correctly, and the operator sees which dormer
      // is broken by its absence from the render.
      console.warn('shell-preview: dormer union failed', e)
      dbrush.geometry.dispose()
    }
  }
  const out = acc.geometry
  out.computeVertexNormals()
  return out
}

function _buildDormerGeometry(
  spec: DormerSpec,
  polygon: [number, number][],
  styles: EdgeStyle[],
  tans: number[],
  frame: RoofFrame,
): THREE.BufferGeometry | null {
  // Locate the parent face's eave edge from polygon + styles.
  // For a rectangle, hip-style edges are potential parent faces.
  const hipIndices: number[] = []
  for (let i = 0; i < styles.length; i++) if (styles[i] === 'hip') hipIndices.push(i)
  if (hipIndices.length === 0) return null
  const idx = hipIndices[Math.min(spec.parentFaceId, hipIndices.length - 1)]!

  const p0 = polygon[idx]!
  const p1 = polygon[(idx + 1) % polygon.length]!
  const eave = new THREE.Vector2(p1[0] - p0[0], p1[1] - p0[1])
  const eaveLen = eave.length()
  if (eaveLen < 1e-6) return null
  const eaveUnit = eave.clone().multiplyScalar(1 / eaveLen)
  // Inward (into the polygon interior) is a 90° CCW rotation of eave.
  const inwardUnit = new THREE.Vector2(-eaveUnit.y, eaveUnit.x)

  const uMid = 0.5 * (spec.footOnParent[0][0] + spec.footOnParent[1][0])
  const vMid = 0.5 * (spec.footOnParent[0][1] + spec.footOnParent[1][1])
  const halfW = spec.cheekWidth / 2

  // V runs eave -> ridge, so its run is the frame's halfSpan.
  //
  // This used to be Math.min(eaveLen, 4.0). eaveLen is the length
  // ALONG the eave — the wrong dimension entirely — and the 4.0 was
  // arbitrary. Checked against the operator's own plan: on one roof
  // V=1 overshot 0.13m PAST the ridge and off the far slope, on
  // another it stopped 0.34m short, and they agreed only on the roof
  // where halfSpan happened to equal 4. Overshooting the ridge is
  // what "it goes away from the house" looked like.
  //
  // A dormer EMERGES from the slope. It is modelled as a gable prism
  // that starts below the roof plane and runs inward until the roof
  // swallows it, then CSG-unioned so the slope cuts it to shape.
  //
  // It used to be a flat-bottomed box sitting ON the slope with its
  // apex inset at 0.25 * cheekD, so the "gable" was a sloped wedge and
  // nothing penetrated the roof. That reads as a chimney, which is
  // exactly what the operator called it.
  const tanParent = Math.max(MIN_EDGE_WEIGHT, tans[idx]!)
  const eaveParent = frame.eaveOf[idx]!
  const zAt = (dist: number) => eaveParent + tanParent * Math.max(0, dist)

  // Its ridge must stay at or below the main ridge. The front face
  // rises ridgeHeight above the roof, and the roof climbs back to that
  // height over ridgeHeight/tan of run, so that run is the limit.
  const runToBury = spec.ridgeHeight / tanParent
  const maxInward = Math.max(0, frame.halfSpan - runToBury)
  // V maps across the run that is actually usable — mapping across
  // halfSpan and clamping left the slider dead past a point.
  const inward = Math.min(Math.max(vMid, 0), 1) * maxInward

  const anchor = new THREE.Vector2(
    p0[0] + uMid * eave.x + inwardUnit.x * inward,
    p0[1] + uMid * eave.y + inwardUnit.y * inward,
  )

  const zFront = zAt(inward)
  const rZ = zFront + spec.ridgeHeight
  // Run inward until the roof surface reaches the dormer ridge, plus a
  // little, so the rear is fully inside the roof and the union leaves
  // no back wall poking out.
  const cheekD = runToBury + 0.15
  // Start below the slope so the front face is cut by the roof rather
  // than floating on it.
  const zBase = zFront - Math.max(0.6, spec.ridgeHeight)

  const corner = (offW: number, offD: number): [number, number] => [
    anchor.x + offW * eaveUnit.x + offD * inwardUnit.x,
    anchor.y + offW * eaveUnit.y + offD * inwardUnit.y,
  ]

  const c0 = corner(-halfW, 0)
  const c1 = corner(halfW, 0)
  const c2 = corner(halfW, cheekD)
  const c3 = corner(-halfW, cheekD)
  // Apexes sit on the SAME planes as the base corners, on the centre
  // line — that is what makes the gable face vertical and square to
  // the eave. Insetting them was what gave the wedge/chimney look.
  const apexFront = corner(0, 0)
  const apexBack = corner(0, cheekD)

  if (spec.type === 'gable') {
    // 6 verts: 4 base + 2 ridge apex points.
    const rf = apexFront
    const rb = apexBack
    const verts: [number, number, number][] = [
      [c0[0], zBase, c0[1]],
      [c1[0], zBase, c1[1]],
      [c2[0], zBase, c2[1]],
      [c3[0], zBase, c3[1]],
      [rf[0], rZ, rf[1]],
      [rb[0], rZ, rb[1]],
    ]
    return _facesToGeometry([
      { verts: [verts[0]!, verts[1]!, verts[4]!], slot: SLOT_WALL_EXTERIOR }, // front gable
      { verts: [verts[3]!, verts[5]!, verts[2]!], slot: SLOT_WALL_EXTERIOR }, // back gable
      { verts: [verts[0]!, verts[4]!, verts[5]!, verts[3]!], slot: SLOT_SLATE_TOP },
      { verts: [verts[1]!, verts[2]!, verts[5]!, verts[4]!], slot: SLOT_SLATE_TOP },
      { verts: [verts[0]!, verts[3]!, verts[2]!, verts[1]!], slot: SLOT_SOFFIT },
    ])
  }

  if (spec.type === 'shed') {
    const verts: [number, number, number][] = [
      [c0[0], zBase, c0[1]],
      [c1[0], zBase, c1[1]],
      [c2[0], zBase, c2[1]],
      [c3[0], zBase, c3[1]],
      [c0[0], rZ, c0[1]],
      [c1[0], rZ, c1[1]],
    ]
    return _facesToGeometry([
      { verts: [verts[0]!, verts[4]!, verts[5]!, verts[1]!], slot: SLOT_WALL_EXTERIOR }, // front wall
      { verts: [verts[4]!, verts[3]!, verts[2]!, verts[5]!], slot: SLOT_SLATE_TOP }, // slope
      { verts: [verts[0]!, verts[3]!, verts[4]!], slot: SLOT_WALL_EXTERIOR }, // left cheek
      { verts: [verts[1]!, verts[5]!, verts[2]!], slot: SLOT_WALL_EXTERIOR }, // right cheek
      { verts: [verts[0]!, verts[3]!, verts[2]!, verts[1]!], slot: SLOT_SOFFIT },
    ])
  }

  if (spec.type === 'hip') {
    const centre: [number, number] = [
      anchor.x + (cheekD / 2) * inwardUnit.x,
      anchor.y + (cheekD / 2) * inwardUnit.y,
    ]
    const verts: [number, number, number][] = [
      [c0[0], zBase, c0[1]],
      [c1[0], zBase, c1[1]],
      [c2[0], zBase, c2[1]],
      [c3[0], zBase, c3[1]],
      [centre[0], rZ, centre[1]],
    ]
    return _facesToGeometry([
      { verts: [verts[0]!, verts[1]!, verts[4]!], slot: SLOT_SLATE_TOP },
      { verts: [verts[1]!, verts[2]!, verts[4]!], slot: SLOT_SLATE_TOP },
      { verts: [verts[2]!, verts[3]!, verts[4]!], slot: SLOT_SLATE_TOP },
      { verts: [verts[3]!, verts[0]!, verts[4]!], slot: SLOT_SLATE_TOP },
      { verts: [verts[0]!, verts[3]!, verts[2]!, verts[1]!], slot: SLOT_SOFFIT },
    ])
  }
  return null
}

// ─── Common geometry helpers ─────────────────────────────────────

function _facesToGeometry(
  faces: { verts: [number, number, number][]; slot: number }[],
): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const groups: { start: number; count: number; slot: number }[] = []
  let vertCount = 0
  for (const face of faces) {
    if (face.verts.length < 3) continue
    // Reverse winding once here so every face defined above lists
    // its vertices in an intuitive "walk around the face" order,
    // and the resulting normals still point OUTWARD (three.js
    // back-face culling would otherwise hide the whole mesh). The
    // face-declarations upstream were traced in the visually
    // natural direction; without this flip the cross product came
    // out pointing inward — verified against the soffit (naturally
    // written FL→BL→BR→FR, cross was +Y instead of the wanted -Y).
    const verts = [...face.verts].reverse()
    const p0 = new THREE.Vector3(...verts[0]!)
    const p1 = new THREE.Vector3(...verts[1]!)
    const p2 = new THREE.Vector3(...verts[2]!)
    const n = new THREE.Vector3()
      .subVectors(p1, p0)
      .cross(new THREE.Vector3().subVectors(p2, p0))
      .normalize()
    const start = vertCount
    let count = 0
    for (let i = 1; i < verts.length - 1; i++) {
      const a = verts[0]!
      const b = verts[i]!
      const c = verts[i + 1]!
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
      normals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z)
      indices.push(vertCount, vertCount + 1, vertCount + 2)
      vertCount += 3
      count += 3
    }
    groups.push({ start, count, slot: face.slot })
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setIndex(indices)
  for (const g of groups) geom.addGroup(g.start, g.count, g.slot)
  return geom
}

// roofMaterials has four entries; a group pointing past that makes
// material[idx] undefined and both the stock and BVH-accelerated
// raycast throw. Clamp every slot we emit.
const MAX_SLOT = 3

/**
 * Ensure a geometry's groups tile its ENTIRE index buffer with
 * in-range materialIndex values.
 *
 * three-mesh-bvh's raycast resolves a hit triangle's material by
 * finding the group that contains its face index. A triangle in no
 * group yields undefined, and reading `.materialIndex` off it throws
 * on every pointer move — which takes down the render loop and
 * blanks the scene. CSG results in particular can come back with no
 * groups at all, so this runs on anything we hand downstream.
 */
export function ensureGroupCoverage(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  const idx = geom.getIndex()
  const total = idx ? idx.count : (geom.getAttribute('position')?.count ?? 0)
  if (total === 0) {
    geom.clearGroups()
    return geom
  }
  const src = (geom.groups ?? [])
    .filter((g) => g.count > 0)
    .map((g) => ({
      start: g.start,
      count: g.count,
      slot: Math.min(MAX_SLOT, Math.max(0, g.materialIndex ?? 0)),
    }))
    .sort((a, b) => a.start - b.start)
  const patched: typeof src = []
  let cursor = 0
  for (const g of src) {
    if (g.start > cursor) patched.push({ start: cursor, count: g.start - cursor, slot: 0 })
    patched.push(g)
    cursor = Math.max(cursor, g.start + g.count)
  }
  if (cursor < total) patched.push({ start: cursor, count: total - cursor, slot: 0 })
  geom.clearGroups()
  for (const g of patched) geom.addGroup(g.start, g.count, g.slot)
  return geom
}

function _concat(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null
  if (parts.length === 1) return ensureGroupCoverage(parts[0]!)
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const groups: { start: number; count: number; slot: number }[] = []
  let base = 0
  let indexBase = 0
  for (const p of parts) {
    const pos = p.getAttribute('position')
    const nrm = p.getAttribute('normal')
    const idx = p.getIndex()
    if (!(pos && idx)) continue
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i))
      if (nrm) normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i))
    }
    for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + base)
    if (p.groups && p.groups.length > 0) {
      for (const g of p.groups) {
        groups.push({
          start: g.start + indexBase,
          count: g.count,
          slot: Math.min(MAX_SLOT, Math.max(0, g.materialIndex ?? 0)),
        })
      }
    } else {
      groups.push({ start: indexBase, count: idx.count, slot: 0 })
    }
    base += pos.count
    indexBase += idx.count
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  if (normals.length === positions.length)
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setIndex(indices)
  for (const g of groups) geom.addGroup(g.start, g.count, g.slot)
  return ensureGroupCoverage(geom)
}
