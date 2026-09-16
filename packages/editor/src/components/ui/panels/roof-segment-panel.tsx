'use client'

import {
  type AnyNode,
  type AnyNodeId,
  type RoofSegmentNode,
  RoofSegmentNode as RoofSegmentNodeSchema,
  type RoofType,
  useScene,
} from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { Copy, Move, Trash2 } from 'lucide-react'
import { useCallback, useEffect } from 'react'
import { sfxEmitter } from '../../../lib/sfx-bus'
import useEditor from '../../../store/use-editor'
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

  const handleUpdate = useCallback(
    (updates: Partial<RoofSegmentNode>) => {
      if (!selectedId) return
      updateNode(selectedId as AnyNode['id'], updates)
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
          onChange={(v) => handleUpdate({ ridgeAxis: v })}
          options={RIDGE_AXIS_OPTIONS}
          value={
            node.ridgeAxis === 'east-west' || node.ridgeAxis === 'north-south'
              ? node.ridgeAxis
              : 'east-west'
          }
        />
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
          label="Wall"
          max={5}
          min={0}
          onChange={(v) => handleUpdate({ wallHeight: v })}
          precision={2}
          step={0.1}
          unit="m"
          value={Math.round(node.wallHeight * 100) / 100}
        />
        <SliderControl
          label="Roof"
          max={15}
          min={0}
          onChange={(v) => handleUpdate({ roofHeight: v })}
          precision={2}
          step={0.1}
          unit="m"
          value={Math.round(node.roofHeight * 100) / 100}
        />
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
        // entry per polygon edge. UI shows PITCH ANGLE in degrees; we
        // convert to tan(pitch) on write. When all edges have the
        // default pitch we clear edgeWeights so old plans that used
        // the roofHeight/half-span pitch still work unchanged.
        const n = edgeCount(node)
        const currentWeights = ((node as any).edgeWeights as number[] | undefined) ?? []
        const pitches: number[] = Array.from({ length: n }, (_, i) => {
          const w = currentWeights[i]
          return typeof w === 'number' ? weightToDeg(w) : DEFAULT_PITCH_DEG
        })
        const setPitch = (i: number, deg: number) => {
          const next = [...pitches]
          next[i] = deg
          const weights = next.map(degToWeight)
          const allDefault = next.every((d) => d === DEFAULT_PITCH_DEG)
          handleUpdate({
            edgeWeights: allDefault ? undefined : weights,
          } as any)
        }
        const clearAll = () => handleUpdate({ edgeWeights: undefined } as any)
        return (
          <PanelSection title="Per-Edge Pitch">
            <div className="px-1 pt-1 text-[10px] leading-tight text-neutral-500">
              Shell-rebuild only (RITN3D_USE_SHELL_BUILDER=1). Different
              pitches per edge produce a variable-pitch roof.
            </div>
            {pitches.map((p, i) => (
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
            ))}
            <div className="flex gap-1.5 px-1 pt-2 pb-1">
              <ActionButton label="Reset to Default" onClick={clearAll} />
            </div>
          </PanelSection>
        )
      })()}

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
              const u = d.footOnParent?.[0]?.[0] ?? 0.35
              const v = d.footOnParent?.[0]?.[1] ?? 0.15
              const setFoot = (nu: number, nv: number) => {
                const half_w = (d.cheekWidth ?? 1.2) / 20 // tiny UV span, mostly cosmetic
                updateDormer(idx, {
                  footOnParent: [
                    [nu - half_w, nv],
                    [nu + half_w, nv + 0.15],
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
                    max={2.5}
                    min={0.3}
                    onChange={(nv) => updateDormer(idx, { ridgeHeight: nv })}
                    precision={2}
                    step={0.1}
                    unit="m"
                    value={d.ridgeHeight ?? 0.8}
                  />
                  <SliderControl
                    label="Cheek width"
                    max={4}
                    min={0.6}
                    onChange={(nv) => updateDormer(idx, { cheekWidth: nv })}
                    precision={2}
                    step={0.1}
                    unit="m"
                    value={d.cheekWidth ?? 1.2}
                  />
                </div>
              )
            })}
            <div className="flex gap-1.5 px-1 pt-2 pb-1">
              <ActionButton label="+ Add Dormer" onClick={addDormer} />
            </div>
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
