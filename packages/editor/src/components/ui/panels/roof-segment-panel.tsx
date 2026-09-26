'use client'

import {
  type AnyNode,
  type AnyNodeId,
  type RoofSegmentNode,
  RoofSegmentNode as RoofSegmentNodeSchema,
  type RoofType,
  resolveRoofContext,
  roofHeightForRidge,
  touchingSegments,
  useScene,
  windowsUnderSegment,
} from '@ritn3d/core'
import { DEFAULT_LEVEL_HEIGHT, getLevelHeight, useViewer } from '@ritn3d/viewer'
import { Copy, Move, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo } from 'react'
import { sfxEmitter } from '../../../lib/sfx-bus'
import useEditor from '../../../store/use-editor'
import { useDormerPick } from '../../../store/use-dormer-pick'
import { ActionButton, ActionGroup } from '../controls/action-button'
import { MetricControl } from '../controls/metric-control'
import { PanelSection } from '../controls/panel-section'
import { SegmentedControl } from '../controls/segmented-control'
import { SliderControl } from '../controls/slider-control'
import { PanelWrapper } from './panel-wrapper'

// --- Shell-rebuild helpers (per-edge pitch + dormers) --------------------
//
// Pitch <-> weight: our backend shell subsystem interprets `edge_weights`
// as tan(pitch_angle) for each edge — 1.0 == 45 degrees uniform. The
// panel shows PITCH ANGLE in degrees (0-70) since that's what humans
// author against; conversion happens on write / read at the UI edge.
const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI
const DEFAULT_PITCH_DEG = 30
function weightToDeg(w: number): number {
  return Math.round(Math.atan(w) * RAD_TO_DEG)
}
function degToWeight(d: number): number {
  return Math.max(0.01, Math.tan(d * DEG_TO_RAD))
}
const EDGE_LABEL_RECT = ['South', 'East', 'North', 'West']
// n_edges for a rect segment is always 4; for a 4-point polygon it's 4
// too. Custom polygons with != 4 vertices are deferred UI (rare in DFY).
function edgeCount(seg: RoofSegmentNode): number {
  const poly = (seg as any).polygon as [number, number][] | undefined
  return Array.isArray(poly) && poly.length >= 3 ? poly.length : 4
}
function edgeLabel(i: number, n: number): string {
  if (n === 4) return EDGE_LABEL_RECT[i] ?? `Edge ${i + 1}`
  return `Edge ${i + 1}`
}

type DormerType = 'gable' | 'shed' | 'hip'
const DORMER_TYPE_OPTIONS: { label: string; value: DormerType }[] = [
  { label: 'Gable', value: 'gable' },
  { label: 'Shed', value: 'shed' },
  { label: 'Hip', value: 'hip' },
]

/** Ridge angle (degrees, three.js rotation-y sense, -90..90) that runs the
 *  ridge along the footprint's longest edge — for a diagonal house. */
function alongLongestEdgeDeg(node: any): number {
  const poly: [number, number][] =
    Array.isArray(node.polygon) && node.polygon.length >= 3
      ? node.polygon
      : [
          [-node.width / 2, -node.depth / 2],
          [node.width / 2, -node.depth / 2],
          [node.width / 2, node.depth / 2],
          [-node.width / 2, node.depth / 2],
        ]
  let best = 0
  let bestLen = -1
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const len = Math.hypot(dx, dz)
    if (len > bestLen) {
      bestLen = len
      // rotateY(1, 0, t) = (cos t, -sin t) must point along (dx, dz).
      best = Math.atan2(-dz, dx)
    }
  }
  let deg = (best * 180) / Math.PI
  while (deg > 90) deg -= 180
  while (deg < -90) deg += 180
  return Math.round(deg)
}

/** What a shed dormer's roof pitch is when the operator hasn't set one:
 *  a third of its parent slope's pitch (shell-preview's default), degrees.
 *  Approximate for junction-adjusted wings; the geometry is authoritative. */
function defaultShedPitchDeg(node: any, parentFaceId: number): number {
  const ew =
    node.ridgeAxis === 'east-west' ||
    (node.ridgeAxis !== 'north-south' && (node.width ?? 0) >= (node.depth ?? 0))
  const sloped = ew ? [0, 2] : [1, 3]
  const e = sloped[Math.min(Math.max(0, parentFaceId | 0), 1)]!
  const half = (ew ? node.depth : node.width) / 2
  const w = Array.isArray(node.edgeWeights) ? node.edgeWeights[e] : undefined
  const tan = typeof w === 'number' && w > 0 ? w : (node.roofHeight ?? 2.5) / Math.max(0.1, half)
  return Math.round((Math.atan(tan / 3) * 180) / Math.PI)
}

function newDormerDefaults(seg: RoofSegmentNode): any {
  return {
    id: `dorm_${Math.random().toString(36).slice(2, 10)}`,
    parentFaceId: 0,
    footOnParent: [
      [0.35, 0.15],
      [0.55, 0.35],
    ],
    type: 'gable',
    ridgeHeight: 0.8,
    cheekWidth: 1.2,
    ridgeOrientation: 'orthogonal',
  }
}

const ROOF_TYPE_OPTIONS: { label: string; value: RoofType }[] = [
  { label: 'Hip', value: 'hip' },
  { label: 'Gable', value: 'gable' },
  { label: 'Shed', value: 'shed' },
  { label: 'Flat', value: 'flat' },
]

// ─── Auto roofHeight computation ─────────────────────────────────────
// Multi-storey L0-roof-covers-L1 model (2026-09-22): compute the
// segment's roofHeight so the ridge sits at least AUTO_HEIGHT_MARGIN_M
// above the tallest wall whose XY footprint falls under the segment's
// polygon. Falls back to `min(width, depth) / 4` on single-storey
// plans where no wall pokes into the roof volume.
const AUTO_HEIGHT_MARGIN_M = 1.0

function _segLocalPolygon(seg: RoofSegmentNode): [number, number][] {
  const poly = (seg as any).polygon as [number, number][] | undefined
  if (Array.isArray(poly) && poly.length >= 3) {
    return poly.map((p) => [Number(p[0]), Number(p[1])] as [number, number])
  }
  const w2 = seg.width / 2
  const d2 = seg.depth / 2
  return [
    [-w2, -d2],
    [w2, -d2],
    [w2, d2],
    [-w2, d2],
  ]
}

function _pointInPolygon(p: [number, number], poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!
    const pj = poly[j]!
    const cross = pi[1] > p[1] !== pj[1] > p[1]
    if (cross) {
      const xat = pi[0] + ((p[1] - pi[1]) * (pj[0] - pi[0])) / (pj[1] - pi[1] || 1e-12)
      if (p[0] < xat) inside = !inside
    }
  }
  return inside
}

function _segsIntersect(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const denom = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])
  if (Math.abs(denom) < 1e-12) return false
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / denom
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / denom
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

function _wallHitsPolygon(
  start: [number, number],
  end: [number, number],
  poly: [number, number][],
): boolean {
  if (_pointInPolygon(start, poly) || _pointInPolygon(end, poly)) return true
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (_segsIntersect(start, end, poly[j]!, poly[i]!)) return true
  }
  return false
}

function computeAutoRoofHeight(
  seg: RoofSegmentNode,
  nodes: Record<string, AnyNode>,
): number {
  // 1. Elevations per level. getLevelHeight is cache-hit by
  //    reference-equality of the nodes bag, so the useMemo below
  //    keeps the whole computation cheap.
  const levels = (Object.values(nodes).filter((n) => n?.type === 'level') as any[]).sort(
    (a, b) => (a.level ?? 0) - (b.level ?? 0),
  )
  const levelElev = new Map<string, number>()
  let cumEl = 0
  for (const lvl of levels) {
    levelElev.set(lvl.id, cumEl)
    cumEl += getLevelHeight(lvl.id, nodes)
  }

  // 2. This segment's own level + eave elevation. Eave sits at
  //    level_elevation + level_wall_height + optional roof-segment
  //    parapet (seg.wallHeight). The BACKEND uses exactly this
  //    formula (editor_scene_translator_dev.py:
  //    `base_z = storey_elev + storey_height + wall_h`). If we skip
  //    the storey_height term the auto value comes out ~2.7 m too
  //    tall — a plain 1-storey house's roof looks like a church.
  const parentRoof = seg.parentId ? nodes[seg.parentId as AnyNodeId] : null
  const parentLevel =
    parentRoof && parentRoof.parentId ? nodes[parentRoof.parentId as AnyNodeId] : null
  const singleStoreyFallback = () => Math.max(0.5, Math.min(seg.width, seg.depth) / 4)
  if (!parentLevel || parentLevel.type !== 'level') return singleStoreyFallback()
  const ourElev = levelElev.get(parentLevel.id) ?? 0
  const parentStoreyHeight = getLevelHeight(parentLevel.id, nodes)
  const eaveZ = ourElev + parentStoreyHeight + (seg.wallHeight ?? 0)

  // 3. World-plan polygon of the roof segment. The plan-scene emits
  //    walls' start/end in the same UNFLIPPED frame this uses, so
  //    intersection tests here match what the backend renders.
  const local = _segLocalPolygon(seg)
  const parentRoofPos = ((parentRoof as any)?.position ?? [0, 0, 0]) as number[]
  const parentRoofRot = ((parentRoof as any)?.rotation ?? 0) as number
  const cosG = Math.cos(parentRoofRot)
  const sinG = Math.sin(parentRoofRot)
  const worldCx =
    (parentRoofPos[0] ?? 0) + seg.position[0] * cosG - seg.position[2] * sinG
  const worldCz =
    (parentRoofPos[2] ?? 0) + seg.position[0] * sinG + seg.position[2] * cosG
  const worldRot = parentRoofRot + (seg.rotation ?? 0)
  const cosR = Math.cos(worldRot)
  const sinR = Math.sin(worldRot)
  const worldPoly: [number, number][] = local.map(([lx, lz]) => [
    worldCx + lx * cosR - lz * sinR,
    worldCz + lx * sinR + lz * cosR,
  ])

  // 4. Iterate walls, find intersecting ones whose top is above eave.
  let maxTop = -Infinity
  let anyAbove = false
  for (const n of Object.values(nodes)) {
    if (!n || n.type !== 'wall') continue
    const wLevel = n.parentId ? nodes[n.parentId as AnyNodeId] : null
    if (!wLevel || wLevel.type !== 'level') continue
    const wElev = levelElev.get(wLevel.id) ?? 0
    const wTop = wElev + ((n as any).height ?? DEFAULT_LEVEL_HEIGHT)
    if (wTop <= eaveZ + 1e-3) continue

    const s = (n as any).start
    const e = (n as any).end
    if (!Array.isArray(s) || !Array.isArray(e) || s.length < 2 || e.length < 2) continue
    if (!_wallHitsPolygon([s[0], s[1]], [e[0], e[1]], worldPoly)) continue

    anyAbove = true
    if (wTop > maxTop) maxTop = wTop
  }

  if (anyAbove) return Math.max(0.5, maxTop - eaveZ + AUTO_HEIGHT_MARGIN_M)
  return singleStoreyFallback()
}

// Gambrel / Dutch / Mansard are DEFERRED in blender_pipeline_dev/roof/scene.py
// — the backend raises NotImplementedError on those kinds, so the pipeline
// silently skips the roof and the user gets no roof at all. Hidden from the
// picker until the geometry code lands. Values still exist on the schema
// so plans that already carry one keep parsing.

// Ridge direction — explicit user choice, never inferred from width/depth
// after this control is touched. "Auto" keeps the width>=depth heuristic
// for anything the user hasn't set.
// Ridge direction is always an explicit user pick — Auto was removed
// because its length-based fallback silently overrode gable direction on
// clear rectangles, wasting render credit. Every gable mass now carries
// an explicit E-W or N-S; new masses default to E-W (see plan-scene.ts).
const RIDGE_AXIS_OPTIONS: { label: string; value: 'east-west' | 'north-south' }[] = [
  { label: '↕ N–S', value: 'north-south' },
  { label: '↔ E–W', value: 'east-west' },
]

export function RoofSegmentPanel() {
  const selectedIds = useViewer((s) => s.selection.selectedIds)
  const setSelection = useViewer((s) => s.setSelection)
  const nodes = useScene((s) => s.nodes)
  const updateNode = useScene((s) => s.updateNode)
  const setMovingNode = useEditor((s) => s.setMovingNode)

  const selectedId = selectedIds[0]
  const node = selectedId
    ? (nodes[selectedId as AnyNode['id']] as RoofSegmentNode | undefined)
    : undefined

  // Scene-level roof resolution: which roof this wing joins, and which
  // windows a dormer here could follow. Same function the roof system uses.
  const roofCtx = useMemo(
    () => resolveRoofContext(nodes as Record<string, AnyNode>),
    [nodes],
  )
  const joined = node ? roofCtx.segments.get(node.id) : undefined
  // Touching sections and their ridge heights, for Match height.
  const touching = useMemo(() => {
    if (!node) return []
    const all = nodes as Record<string, any>
    const mine = joined ? joined.placement.baseY + joined.shape.frame.ridgeZ : null
    return touchingSegments(roofCtx, node.id).map((t) => {
      const seg = all[t.id]
      const roof = seg?.parentId ? all[seg.parentId] : undefined
      return {
        ...t,
        name: (seg?.name as string | undefined) ?? (roof?.name as string | undefined) ?? 'Roof section',
        same: mine != null && Math.abs(mine - t.ridgeY) < 0.02,
      }
    })
  }, [nodes, roofCtx, node, joined])
  // Windows a new dormer could sit on (not ones already followed).
  const pickableWindows = useMemo(() => {
    if (!node) return []
    const taken = new Set(
      (((node as any).dormers as { windowId?: string }[] | undefined) ?? []).map((d) => d.windowId),
    )
    return windowsUnderSegment(nodes as Record<string, AnyNode>, roofCtx, node.id).filter(
      (w) => !taken.has(w.id),
    )
  }, [nodes, roofCtx, node])
  const startWindowPick = useCallback(() => {
    if (!node) return
    const all = nodes as Record<string, any>
    const roof = node.parentId ? all[node.parentId] : undefined
    const roofLevelId: string | null = roof?.parentId ?? null
    useDormerPick.getState().start(node.id, roofLevelId)
    // The windows are usually on the floor above the roof's level: go to
    // it when they're all on one floor, so they can be clicked in the plan.
    const levelOf = (wid: string) => {
      const w = all[wid]
      const wall = w ? all[w.wallId ?? w.parentId] : undefined
      return (wall?.parentId as string | undefined) ?? null
    }
    const lv = new Set(pickableWindows.map((w) => levelOf(w.id)))
    const only = lv.size === 1 ? [...lv][0] : null
    setSelection((only ? { levelId: only, selectedIds: [] } : { selectedIds: [] }) as any)
  }, [node, nodes, pickableWindows, setSelection])
  const followableWindows = useMemo(
    () =>
      node
        ? windowsUnderSegment(
            nodes as Record<string, AnyNode>,
            roofCtx,
            node.id,
            (((node as any).dormers as { windowId?: string }[] | undefined) ?? [])
              .map((d) => d.windowId)
              .filter((id): id is string => !!id),
          )
        : [],
    [nodes, roofCtx, node],
  )

  const handleUpdate = useCallback(
    (updates: Partial<RoofSegmentNode>) => {
      if (!selectedId) return
      updateNode(selectedId as AnyNode['id'], updates)
    },
    [selectedId, updateNode],
  )

  // Height slider = ridge height, full stop.
  //
  // This used to also rescale edge_weights proportionally, because the
  // shell read the weights and derived the ridge FROM them, so without
  // the rescale the slider was a no-op. That coupling is gone: the
  // shell now pins the ridge at roofHeight and lets the eave float
  // (see _buildRectangleShell in core/systems/roof/shell-preview.ts).
  // Rescaling here would now change the PITCH every time the height
  // moved, which is exactly the coupling we removed.
  const applyRoofHeight = useCallback(
    (newHeight: number) => {
      if (!selectedId) return
      updateNode(selectedId as AnyNode['id'], { roofHeight: newHeight })
    },
    [selectedId, updateNode],
  )

  // Auto-migrate roof segments that were saved with a deferred kind
  // (gambrel / dutch / mansard) — the backend rejects those and drops
  // the whole roof silently. Force to 'gable' the first time such a
  // segment is opened, so the user's existing plans don't render an
  // invisible roof forever.
  useEffect(() => {
    if (!node || node.type !== 'roof-segment') return
    const kind = node.roofType
    if (kind === 'gambrel' || kind === 'dutch' || kind === 'mansard') {
      updateNode(node.id as AnyNode['id'], { roofType: 'gable' })
    }
  }, [node?.id, node?.roofType, updateNode])

  // Reactive auto-roofHeight — recomputes any time the scene (walls,
  // levels, this segment's polygon) changes. Zero cost when the toggle
  // is off. When on, writes the computed height back into the node
  // only when it drifts more than 1 cm from the current value, so the
  // scene doesn't churn on floating-point noise.
  const autoRoofH = useMemo(() => {
    if (!node || node.type !== 'roof-segment') return null
    if (!(node as any).autoRoofHeight) return null
    return computeAutoRoofHeight(node, nodes as Record<string, AnyNode>)
  }, [node, nodes])

  useEffect(() => {
    if (!node || autoRoofH == null) return
    if (Math.abs(autoRoofH - node.roofHeight) < 0.01) return
    applyRoofHeight(autoRoofH)
  }, [autoRoofH, node?.id, node?.roofHeight, applyRoofHeight])

  const handleClose = useCallback(() => {
    setSelection({ selectedIds: [] })
  }, [setSelection])

  const handleBack = useCallback(() => {
    if (node?.parentId) {
      setSelection({ selectedIds: [node.parentId] })
    }
  }, [node?.parentId, setSelection])

  const handleDuplicate = useCallback(() => {
    if (!node?.parentId) return
    sfxEmitter.emit('sfx:item-pick')

    let duplicateInfo = structuredClone(node) as any
    delete duplicateInfo.id
    duplicateInfo.metadata = { ...duplicateInfo.metadata, isNew: true }
    // Offset slightly so it's visible
    duplicateInfo.position = [
      duplicateInfo.position[0] + 1,
      duplicateInfo.position[1],
      duplicateInfo.position[2] + 1,
    ]

    try {
      const duplicate = RoofSegmentNodeSchema.parse(duplicateInfo)
      useScene.getState().createNode(duplicate, duplicate.parentId as AnyNodeId)
      setSelection({ selectedIds: [] })
      setMovingNode(duplicate)
    } catch (e) {
      console.error('Failed to duplicate roof segment', e)
    }
  }, [node, setSelection, setMovingNode])

  const handleMove = useCallback(() => {
    if (node) {
      sfxEmitter.emit('sfx:item-pick')
      setMovingNode(node)
      setSelection({ selectedIds: [] })
    }
  }, [node, setMovingNode, setSelection])

  const handleDelete = useCallback(() => {
    if (!(selectedId && node)) return
    sfxEmitter.emit('sfx:item-delete')
    const parentId = node.parentId
    useScene.getState().deleteNode(selectedId as AnyNodeId)
    if (parentId) {
      useScene.getState().dirtyNodes.add(parentId as AnyNodeId)
      setSelection({ selectedIds: [parentId] })
    } else {
      setSelection({ selectedIds: [] })
    }
  }, [selectedId, node, setSelection])

  if (!node || node.type !== 'roof-segment' || selectedIds.length !== 1) return null

  return (
    <PanelWrapper
      icon="/icons/roof.png"
      onBack={handleBack}
      onClose={handleClose}
      title={node.name || 'Roof Segment'}
      width={300}
    >
      <PanelSection title="Roof Type">
        <SegmentedControl
          onChange={(v) => handleUpdate({ roofType: v })}
          options={ROOF_TYPE_OPTIONS}
          value={
            (['hip', 'gable', 'shed', 'flat'] as RoofType[]).includes(node.roofType)
              ? node.roofType
              : 'gable'
          }
        />
        <div className="px-1 pt-1 text-[10px] leading-tight text-neutral-500">
          Gambrel, Dutch and Mansard are coming soon.
        </div>
      </PanelSection>

      <PanelSection title="Ridge Direction">
        <SegmentedControl
          onChange={(v) => handleUpdate({ ridgeAxis: v, ridgeAngleDeg: undefined } as any)}
          options={RIDGE_AXIS_OPTIONS}
          value={
            node.ridgeAxis === 'east-west' || node.ridgeAxis === 'north-south'
              ? node.ridgeAxis
              : 'east-west'
          }
        />
        {/* Ridge at any angle; the footprint stays where it was drawn. */}
        <SliderControl
          label="Ridge angle"
          max={90}
          min={-90}
          onChange={(nv) => handleUpdate({ ridgeAngleDeg: nv } as any)}
          precision={0}
          step={1}
          unit="°"
          value={
            typeof (node as any).ridgeAngleDeg === 'number'
              ? (node as any).ridgeAngleDeg
              : node.ridgeAxis === 'north-south'
                ? 90
                : 0
          }
        />
        <div className="flex gap-1.5 px-1 pt-1 pb-1">
          <ActionButton
            label="Align to footprint"
            onClick={() => handleUpdate({ ridgeAngleDeg: alongLongestEdgeDeg(node) } as any)}
          />
        </div>
      </PanelSection>

      {(() => {
        // Custom-shape mode: user has an explicit polygon on the node.
        // When toggled on, expose per-corner X/Z sliders instead of
        // width/depth. Toggling off reverts to the width/depth
        // rectangle — clearing the polygon field.
        const poly = (node as any).polygon as [number, number][] | undefined
        const isCustom = Array.isArray(poly) && poly.length >= 3
        const rectCorners: [number, number][] = [
          [-node.width / 2, -node.depth / 2],
          [node.width / 2, -node.depth / 2],
          [node.width / 2, node.depth / 2],
          [-node.width / 2, node.depth / 2],
        ]
        const enterCustom = () => handleUpdate({ polygon: rectCorners } as any)
        const exitCustom = () => handleUpdate({ polygon: undefined } as any)
        const updateCorner = (i: number, xz: [number, number]) => {
          if (!isCustom) return
          const next = poly!.map((p, j) => (j === i ? xz : p))
          handleUpdate({ polygon: next } as any)
        }
        return (
          <>
            <PanelSection title="Footprint">
              <SegmentedControl
                onChange={(v) =>
                  v === 'custom' ? enterCustom() : exitCustom()
                }
                options={[
                  { label: 'Rectangle', value: 'rect' },
                  { label: '4-point', value: 'custom' },
                ]}
                value={isCustom ? 'custom' : 'rect'}
              />
              {isCustom ? (
                <div className="mt-1 flex flex-col gap-0.5">
                  {(poly || []).slice(0, 4).map((p, i) => (
                    <div className="flex gap-1" key={i}>
                      <MetricControl
                        label={`P${i + 1} X`}
                        max={25}
                        min={-25}
                        onChange={(v) => updateCorner(i, [v, p[1]])}
                        precision={2}
                        step={0.1}
                        unit="m"
                        value={Math.round(p[0] * 100) / 100}
                      />
                      <MetricControl
                        label={`P${i + 1} Z`}
                        max={25}
                        min={-25}
                        onChange={(v) => updateCorner(i, [p[0], v])}
                        precision={2}
                        step={0.1}
                        unit="m"
                        value={Math.round(p[1] * 100) / 100}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <SliderControl
                    label="Width"
                    max={25}
                    min={0.5}
                    onChange={(v) => handleUpdate({ width: v })}
                    precision={2}
                    step={0.5}
                    unit="m"
                    value={Math.round(node.width * 100) / 100}
                  />
                  <SliderControl
                    label="Depth"
                    max={25}
                    min={0.5}
                    onChange={(v) => handleUpdate({ depth: v })}
                    precision={2}
                    step={0.5}
                    unit="m"
                    value={Math.round(node.depth * 100) / 100}
                  />
                </>
              )}
            </PanelSection>
          </>
        )
      })()}

      <PanelSection title="Heights">
        <SliderControl
          label="Parapet"
          max={5}
          min={0}
          onChange={(v) => handleUpdate({ wallHeight: v })}
          precision={2}
          step={0.1}
          unit="m"
          value={Math.round(node.wallHeight * 100) / 100}
        />
        <div className="px-1 pt-0 pb-1 text-[10px] leading-tight text-neutral-500">
          Extra vertical rise above the storey wall top, before the roof pitch.
          0 for a plain roof. Storey wall height comes from the wall segments
          on the level, not from here.
        </div>
        <SegmentedControl
          onChange={(v) =>
            handleUpdate({ autoRoofHeight: v === 'auto' } as Partial<RoofSegmentNode>)
          }
          options={[
            { label: 'Auto', value: 'auto' },
            { label: 'Manual', value: 'manual' },
          ]}
          value={(node as any).autoRoofHeight ? 'auto' : 'manual'}
        />
        {(node as any).autoRoofHeight ? (
          <div className="px-1 py-1 text-[11px] leading-tight text-neutral-500">
            Roof <b>{(Math.round(node.roofHeight * 100) / 100).toFixed(2)} m</b>
            {' '}— auto from upper walls + 1.0 m margin.
          </div>
        ) : (
          <>
            <SliderControl
              label="Roof"
              max={15}
              min={0}
              onChange={(v) => applyRoofHeight(v)}
              precision={2}
              step={0.1}
              unit="m"
              value={Math.round(node.roofHeight * 100) / 100}
            />
            {Array.isArray((node as any).edgeWeights) &&
              (node as any).edgeWeights.length > 0 && (
                <div className="px-1 pt-0 pb-1 text-[10px] leading-tight text-neutral-500">
                  Rescales per-edge pitches proportionally when set.
                </div>
              )}
          </>
        )}
      </PanelSection>

      {/* Structure — only Overhang is wired into blender_pipeline_dev/roof
          today. Wall Thick / Deck Thick / Shingle Thick sit on the schema
          (so plans that carry them keep round-tripping) but the multi-mass
          solids builder ignores them, so hiding them from the panel until
          they're implemented avoids the user tuning a slider that changes
          nothing in the render. */}
      <PanelSection title="Structure">
        <SliderControl
          label="Overhang"
          max={1}
          min={0}
          onChange={(v) => handleUpdate({ overhang: v })}
          precision={2}
          step={0.05}
          unit="m"
          value={Math.round(node.overhang * 100) / 100}
        />
      </PanelSection>

      <PanelSection title="Position">
        <MetricControl
          label="X"
          max={50}
          min={-50}
          onChange={(v) => {
            const pos = [...node.position] as [number, number, number]
            pos[0] = v
            handleUpdate({ position: pos })
          }}
          precision={2}
          step={0.05}
          unit="m"
          value={Math.round(node.position[0] * 100) / 100}
        />
        <MetricControl
          label="Y"
          max={50}
          min={-50}
          onChange={(v) => {
            const pos = [...node.position] as [number, number, number]
            pos[1] = v
            handleUpdate({ position: pos })
          }}
          precision={2}
          step={0.05}
          unit="m"
          value={Math.round(node.position[1] * 100) / 100}
        />
        <MetricControl
          label="Z"
          max={50}
          min={-50}
          onChange={(v) => {
            const pos = [...node.position] as [number, number, number]
            pos[2] = v
            handleUpdate({ position: pos })
          }}
          precision={2}
          step={0.05}
          unit="m"
          value={Math.round(node.position[2] * 100) / 100}
        />
        <SliderControl
          label="Rotation"
          max={180}
          min={-180}
          onChange={(degrees) => {
            handleUpdate({ rotation: (degrees * Math.PI) / 180 })
          }}
          precision={0}
          step={1}
          unit="°"
          value={Math.round((node.rotation * 180) / Math.PI)}
        />
        <div className="flex gap-1.5 px-1 pt-2 pb-1">
          <ActionButton
            label="-45°"
            onClick={() => {
              sfxEmitter.emit('sfx:item-rotate')
              handleUpdate({ rotation: node.rotation - Math.PI / 4 })
            }}
          />
          <ActionButton
            label="+45°"
            onClick={() => {
              sfxEmitter.emit('sfx:item-rotate')
              handleUpdate({ rotation: node.rotation + Math.PI / 4 })
            }}
          />
        </div>
      </PanelSection>

      {(() => {
        // Per-edge pitch section. Reads / writes edgeWeights[] — one
        // entry per polygon edge, tan(pitch). Shows the pitch each edge is
        // actually BUILT with (from the resolved roof: roofHeight over the
        // half-span, any authored weight, a Pitch/Level match), not a flat
        // 30° for every edge not set by hand (operator 2026-09-26). Gable /
        // open ends have no slope, so no slider.
        const n = edgeCount(node)
        const currentWeights = ((node as any).edgeWeights as number[] | undefined) ?? []
        const built = joined?.shape
        const sloped = (i: number) =>
          built
            ? i === built.frame.eSideLo || i === built.frame.eSideHi || built.styles[i] === 'hip'
            : true
        const tanOf = (i: number): number => {
          const t = built?.frame.tanOf[i]
          if (typeof t === 'number' && sloped(i)) return t
          const w = currentWeights[i]
          return typeof w === 'number' && w > 0 ? w : degToWeight(DEFAULT_PITCH_DEG)
        }
        const pitches: number[] = Array.from({ length: n }, (_, i) => weightToDeg(tanOf(i)))
        const setPitch = (i: number, deg: number) => {
          // The other edges keep the pitch they're built with.
          const weights = Array.from({ length: n }, (_, k) => (k === i ? degToWeight(deg) : tanOf(k)))
          handleUpdate({ edgeWeights: weights } as any)
        }
        const clearAll = () => handleUpdate({ edgeWeights: undefined } as any)
        return (
          <PanelSection title="Per-Edge Pitch">
            <div className="px-1 pt-1 text-[10px] leading-tight text-neutral-500">
              Shell-rebuild only (RITN3D_USE_SHELL_BUILDER=1). Different
              pitches per edge produce a variable-pitch roof.
            </div>
            {pitches.map((p, i) =>
              sloped(i) ? (
                <SliderControl
                  key={i}
                  label={edgeLabel(i, n)}
                  max={70}
                  min={5}
                  onChange={(v) => setPitch(i, v)}
                  precision={0}
                  step={1}
                  unit="°"
                  value={p}
                />
              ) : (
                <div
                  className="flex justify-between px-1 py-1 text-[11px] text-neutral-500"
                  key={i}
                >
                  <span>{edgeLabel(i, n)}</span>
                  <span>{built?.styles[i] === 'gable' ? 'gable end, no slope' : 'joins another roof, no slope'}</span>
                </div>
              ),
            )}
            <div className="flex gap-1.5 px-1 pt-2 pb-1">
              <ActionButton label="Reset to Default" onClick={clearAll} />
            </div>
          </PanelSection>
        )
      })()}

      {touching.length > 0 ? (
        <PanelSection title="Match height">
          <div className="px-1 pt-1 pb-1 text-[10px] leading-tight text-neutral-500">
            Each section keeps its own height. Sections at the same ridge
            height fuse into one roof. Match puts this ridge exactly on a
            touching section's.
          </div>
          <div className="flex flex-col gap-1 px-1 pb-1">
            {touching.map((t) => (
              <ActionButton
                disabled={t.same}
                key={t.id}
                label={`${t.same ? '✓ Level with' : 'Match'} ${t.name} (ridge ${t.ridgeY.toFixed(2)} m)`}
                onClick={() => {
                  const h = roofHeightForRidge(roofCtx, node!.id, t.ridgeY)
                  if (h == null || !(h > 0.05)) return
                  // Own height, no Pitch/Level override left to fight it.
                  handleUpdate({ roofHeight: h, ridgeMatch: undefined } as any)
                }}
              />
            ))}
          </div>
        </PanelSection>
      ) : null}

      {joined?.joinedTo ? (
        <PanelSection title="Joins another roof">
          <div className="px-1 pt-1 pb-1 text-[10px] leading-tight text-neutral-500">
            This wing's ridge runs into another roof, so its inner end is
            cut to meet it and left open. Ridge now{' '}
            {joined.ridgeMatchApplied === 'level'
              ? 'LEVEL with the main ridge (pitch adjusted)'
              : joined.ridgeMatchApplied === 'pitch'
                ? "at the main roof's PITCH (ridge drops to suit)"
                : 'at its OWN height, dying into the main slope'}
            .
          </div>
          <SegmentedControl
            onChange={(v) =>
              handleUpdate({ ridgeMatch: v === 'auto' ? undefined : v } as any)
            }
            options={[
              { label: 'Auto', value: 'auto' },
              { label: 'Level', value: 'level' },
              { label: 'Pitch', value: 'pitch' },
              { label: 'Own', value: 'independent' },
            ]}
            value={((node as any).ridgeMatch as string | undefined) ?? 'auto'}
          />
        </PanelSection>
      ) : null}
      {(() => {
        // Dormer list. Each dormer stored on the segment as a
        // {id, parentFaceId, footOnParent, type, ridgeHeight,
        //  cheekWidth, ...} object. The shell backend cuts the parent
        // roof around each dormer at render time.
        const dormers = ((node as any).dormers as any[] | undefined) ?? []
        const n = edgeCount(node)
        const setDormers = (next: any[]) =>
          handleUpdate({ dormers: next.length ? next : undefined } as any)
        const addDormer = () => setDormers([...dormers, newDormerDefaults(node)])
        const updateDormer = (idx: number, patch: any) => {
          const next = dormers.map((d, i) => (i === idx ? { ...d, ...patch } : d))
          setDormers(next)
        }
        const deleteDormer = (idx: number) =>
          setDormers(dormers.filter((_, i) => i !== idx))
        return (
          <PanelSection title={`Dormers (${dormers.length})`}>
            <div className="px-1 pt-1 text-[10px] leading-tight text-neutral-500">
              Manually placed on a parent face (0…{n - 1}). Foot U/V is a
              position on the face — U along the eave, V toward the ridge.
            </div>
            {dormers.map((d, idx) => {
              // Read the MIDPOINT, because that is what setFoot writes
              // around and what the geometry consumes (uMid/vMid in
              // shell-preview's _buildDormerGeometry).
              //
              // This used to read u from footOnParent[0][0] — the LEFT
              // edge — while writing [nu - half_w, ...]. So every call
              // shifted U left by half_w, and since the V slider calls
              // setFoot(u, nv), nudging V walked the dormer along the
              // eave by cheekWidth/20 each time. The operator's own
              // dormer had drifted to uMid = -1.999 (U is a 0..1
              // fraction, and the slider's range is 0.1..0.9, so it
              // could not have been entered) — about 19 V moves at
              // 0.125 a go. That is the "when i move V, it going away
              // from house" report: not the geometry, the panel.
              //
              // V never drifted because it was read and written
              // consistently; it is made symmetric here too so both
              // axes mean the same thing.
              const half_w = (d.cheekWidth ?? 1.2) / 20
              const HALF_V = 0.075
              const fp = d.footOnParent
              const u = fp ? ((fp[0]?.[0] ?? 0) + (fp[1]?.[0] ?? 0)) / 2 : 0.45
              const v = fp ? ((fp[0]?.[1] ?? 0) + (fp[1]?.[1] ?? 0)) / 2 : 0.25
              const setFoot = (nu: number, nv: number) => {
                // Clamped so a bad value can never walk off the roof.
                const cu = Math.min(Math.max(nu, 0), 1)
                const cv = Math.min(Math.max(nv, 0), 1)
                updateDormer(idx, {
                  footOnParent: [
                    [cu - half_w, cv - HALF_V],
                    [cu + half_w, cv + HALF_V],
                  ],
                })
              }
              return (
                <div
                  className="mt-1.5 rounded border border-neutral-700/60 p-1.5"
                  key={d.id ?? idx}
                >
                  <div className="flex items-center justify-between px-0.5 pb-1">
                    <span className="text-[11px] text-neutral-300">
                      Dormer {idx + 1}
                    </span>
                    <ActionButton
                      className="hover:bg-red-500/20"
                      icon={<Trash2 className="h-3 w-3 text-red-400" />}
                      label=""
                      onClick={() => deleteDormer(idx)}
                    />
                  </div>
                  <SegmentedControl
                    onChange={(v) => updateDormer(idx, { type: v })}
                    options={DORMER_TYPE_OPTIONS}
                    value={d.type ?? 'gable'}
                  />
                  <label className="mt-1.5 flex items-center justify-between gap-2 px-0.5 text-[11px] text-neutral-400">
                    <span>Follow window</span>
                    <select
                      className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[11px] text-neutral-200"
                      onChange={(e) =>
                        updateDormer(idx, { windowId: e.target.value || undefined })
                      }
                      value={d.windowId ?? ''}
                    >
                      <option value="">None — place by hand</option>
                      {followableWindows.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {d.windowId ? (
                    <>
                      <div className="px-1 pt-1 text-[10px] leading-tight text-neutral-500">
                        Placed and sized from the window: its front sits on
                        the window's wall. Move or resize the window and
                        this dormer follows. Adjust the fit below.
                      </div>
                      <SliderControl
                        label="Extra width"
                        max={4}
                        min={0}
                        onChange={(nv) => updateDormer(idx, { fitWidth: nv })}
                        precision={2}
                        step={0.05}
                        unit="m"
                        value={d.fitWidth ?? 0.5}
                      />
                      <SliderControl
                        label="Headroom"
                        max={2}
                        min={0.05}
                        onChange={(nv) => updateDormer(idx, { fitHeadroom: nv })}
                        precision={2}
                        step={0.05}
                        unit="m"
                        value={d.fitHeadroom ?? 0.15}
                      />
                      <SliderControl
                        label="Shift along eave"
                        max={2}
                        min={-2}
                        onChange={(nv) => updateDormer(idx, { fitOffset: nv })}
                        precision={2}
                        step={0.05}
                        unit="m"
                        value={d.fitOffset ?? 0}
                      />
                      {d.type === 'shed' ? (
                        <SliderControl
                          label="Roof pitch"
                          max={40}
                          min={1}
                          onChange={(nv) => updateDormer(idx, { pitchDeg: nv })}
                          precision={0}
                          step={1}
                          unit="°"
                          value={d.pitchDeg ?? defaultShedPitchDeg(node, d.parentFaceId ?? 0)}
                        />
                      ) : null}
                      <div className="flex gap-1.5 px-1 pt-1">
                        <ActionButton
                          label="Reset fit"
                          onClick={() =>
                            updateDormer(idx, { fitWidth: undefined, fitHeadroom: undefined, fitOffset: undefined })
                          }
                        />
                      </div>
                    </>
                  ) : (
                  <>
                  <MetricControl
                    label="Parent face"
                    max={n - 1}
                    min={0}
                    onChange={(v) =>
                      updateDormer(idx, { parentFaceId: Math.round(v) })
                    }
                    precision={0}
                    step={1}
                    unit=""
                    value={d.parentFaceId ?? 0}
                  />
                  <SliderControl
                    label="U (along eave)"
                    max={0.9}
                    min={0.1}
                    onChange={(nv) => setFoot(nv, v)}
                    precision={2}
                    step={0.05}
                    unit=""
                    value={u}
                  />
                  <SliderControl
                    label="V (toward ridge)"
                    max={0.9}
                    min={0.05}
                    onChange={(nv) => setFoot(u, nv)}
                    precision={2}
                    step={0.05}
                    unit=""
                    value={v}
                  />
                  <SliderControl
                    label="Ridge height"
                    max={5}
                    min={0.3}
                    onChange={(nv) => updateDormer(idx, { ridgeHeight: nv })}
                    precision={2}
                    step={0.1}
                    unit="m"
                    value={d.ridgeHeight ?? 0.8}
                  />
                  <SliderControl
                    label="Cheek width"
                    max={12}
                    min={0.6}
                    onChange={(nv) => updateDormer(idx, { cheekWidth: nv })}
                    precision={2}
                    step={0.1}
                    unit="m"
                    value={d.cheekWidth ?? 1.2}
                  />
                  {d.type === 'shed' ? (
                    <SliderControl
                      label="Roof pitch"
                      max={40}
                      min={1}
                      onChange={(nv) => updateDormer(idx, { pitchDeg: nv })}
                      precision={0}
                      step={1}
                      unit="°"
                      value={d.pitchDeg ?? defaultShedPitchDeg(node, d.parentFaceId ?? 0)}
                    />
                  ) : null}
                  {/* The dormer's own window (every dormer has one). Sizes
                      are clamped to fit the dormer front when built; sill is
                      measured up from where the front meets the slope. */}
                  <SliderControl
                    label="Window width"
                    max={3}
                    min={0.4}
                    onChange={(nv) => updateDormer(idx, { window: { ...(d.window ?? {}), w: nv } })}
                    precision={2}
                    step={0.05}
                    unit="m"
                    value={d.window?.w ?? 1.2}
                  />
                  <SliderControl
                    label="Window height"
                    max={2}
                    min={0.3}
                    onChange={(nv) => updateDormer(idx, { window: { ...(d.window ?? {}), h: nv } })}
                    precision={2}
                    step={0.05}
                    unit="m"
                    value={d.window?.h ?? 1.0}
                  />
                  <SliderControl
                    label="Window sill"
                    max={1}
                    min={0.05}
                    onChange={(nv) => updateDormer(idx, { window: { ...(d.window ?? {}), sill: nv } })}
                    precision={2}
                    step={0.05}
                    unit="m"
                    value={d.window?.sill ?? 0.15}
                  />
                  </>
                  )}
                </div>
              )
            })}
            {/* Two ways in: pick the window it sits on (the usual case: a
                window reaching into the roof), or place one by hand. */}
            <div className="flex gap-1.5 px-1 pt-2 pb-1">
              {pickableWindows.length > 0 ? (
                <ActionButton label="+ Dormer on a window" onClick={startWindowPick} />
              ) : null}
              <ActionButton label="+ Dormer by hand" onClick={addDormer} />
            </div>
            {pickableWindows.length === 0 ? (
              <div className="px-1 pb-1 text-[10px] leading-tight text-neutral-500">
                No window reaches up into this roof, so there's none to
                put a dormer on. Place one by hand.
              </div>
            ) : null}
          </PanelSection>
        )
      })()}

      {(() => {
        const currentOverride =
          ((node as any).roofOverrideMesh as string | undefined) ?? ''
        return (
          <PanelSection title="Advanced">
            <div className="px-1 pt-1 pb-1 text-[10px] leading-tight text-neutral-500">
              roof_override_mesh — path to an OBJ. When set, the pipeline
              uses this mesh verbatim (still validated). For eyebrows /
              arcs / hand-authored assets only.
            </div>
            <input
              className="w-full rounded border border-neutral-700/60 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 outline-none focus:border-neutral-500"
              onChange={(e) =>
                handleUpdate({
                  roofOverrideMesh: e.target.value || undefined,
                } as any)
              }
              placeholder="e.g. /assets/roofs/eyebrow_a.obj"
              type="text"
              value={currentOverride}
            />
          </PanelSection>
        )
      })()}

      <PanelSection title="Actions">
        <ActionGroup>
          <ActionButton icon={<Move className="h-3.5 w-3.5" />} label="Move" onClick={handleMove} />
          <ActionButton
            icon={<Copy className="h-3.5 w-3.5" />}
            label="Duplicate"
            onClick={handleDuplicate}
          />
          <ActionButton
            className="hover:bg-red-500/20"
            icon={<Trash2 className="h-3.5 w-3.5 text-red-400" />}
            label="Delete"
            onClick={handleDelete}
          />
        </ActionGroup>
      </PanelSection>
    </PanelWrapper>
  )
}
