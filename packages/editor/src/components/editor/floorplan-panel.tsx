'use client'

import { Icon } from '@iconify/react'
import {
  type AnyNodeId,
  arcLength,
  arcMidpoint,
  bulgeFromThreePoints,
  type BuildingNode,
  calculateLevelMiters,
  DoorNode,
  emitter,
  type GuideNode,
  getWallPlanFootprint,
  isStraight,
  ItemNode,
  pointAndTangentAtT,
  tessellateArc,
  type LevelNode,
  loadAssetUrl,
  type Point2D,
  type SiteNode,
  SlabNode,
  useScene,
  type WallNode,
  WindowNode,
  ZoneNode as ZoneNodeSchema,
  type ZoneNode as ZoneNodeType,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { ChevronDown, Command, X } from 'lucide-react'
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { sfxEmitter } from '../../lib/sfx-bus'
import { cn } from '../../lib/utils'
import useEditor from '../../store/use-editor'
import { FLOORPLAN_SYMBOL_MIME } from '../ui/symbol-catalog'
import { snapToHalf } from '../tools/item/placement-math'
import {
  createWallOnCurrentLevel,
  isWallLongEnough,
  snapPointToGrid,
  snapWallDraftPoint,
  WALL_GRID_STEP,
  type WallPlanPoint,
} from '../tools/wall/wall-drafting'
import { furnishTools } from '../ui/action-menu/furnish-tools'
import { tools as structureTools } from '../ui/action-menu/structure-tools'
import { SliderControl } from '../ui/controls/slider-control'
import { PALETTE_COLORS } from '../ui/primitives/color-dot'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/primitives/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/primitives/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/primitives/tooltip'
import { NodeActionMenu } from './node-action-menu'

const FALLBACK_VIEW_SIZE = 12
const FLOORPLAN_PADDING = 2
const MIN_VIEWPORT_WIDTH_RATIO = 0.08
const MAX_VIEWPORT_WIDTH_RATIO = 40
const PANEL_MIN_WIDTH = 420
const PANEL_MIN_HEIGHT = 320
const PANEL_DEFAULT_WIDTH = 560
const PANEL_DEFAULT_HEIGHT = 360
const PANEL_MARGIN = 16
const PANEL_DEFAULT_BOTTOM_OFFSET = 96
const MIN_GRID_SCREEN_SPACING = 8
const GRID_COORDINATE_PRECISION = 6
const MAJOR_GRID_STEP = WALL_GRID_STEP * 2
const FLOORPLAN_WALL_THICKNESS_SCALE = 1.18
const FLOORPLAN_MIN_VISIBLE_WALL_THICKNESS = 0.13
const FLOORPLAN_MAX_EXTRA_THICKNESS = 0.035
const FLOORPLAN_PANEL_LAYOUT_STORAGE_KEY = 'pascal-editor-floorplan-panel-layout'
const EMPTY_WALL_MITER_DATA = calculateLevelMiters([])
const EDITOR_CURSOR = "url('/cursor.svg') 4 2, default"
const FLOORPLAN_CURSOR_INDICATOR_OFFSET_X = 20
const FLOORPLAN_CURSOR_INDICATOR_OFFSET_Y = 14
const FLOORPLAN_CURSOR_MARKER_CORE_RADIUS = 0.06
const FLOORPLAN_CURSOR_MARKER_GLOW_RADIUS = 0.2
const FLOORPLAN_HOVER_TRANSITION = 'opacity 180ms cubic-bezier(0.2, 0, 0, 1)'
const FLOORPLAN_WALL_HIT_STROKE_WIDTH = 18
const FLOORPLAN_WALL_HOVER_GLOW_STROKE_WIDTH = 18
const FLOORPLAN_WALL_HOVER_RING_STROKE_WIDTH = 8
const FLOORPLAN_OPENING_HIT_STROKE_WIDTH = 16
const FLOORPLAN_OPENING_STROKE_WIDTH = 0.05
const FLOORPLAN_OPENING_DETAIL_STROKE_WIDTH = 0.02
const FLOORPLAN_OPENING_DASHED_STROKE_WIDTH = 0.02
const FLOORPLAN_ENDPOINT_HIT_STROKE_WIDTH = 18
const FLOORPLAN_ENDPOINT_HOVER_GLOW_STROKE_WIDTH = 16
const FLOORPLAN_ENDPOINT_HOVER_RING_STROKE_WIDTH = 7
const FLOORPLAN_MARQUEE_DRAG_THRESHOLD_PX = 4
// Measurement sizing scales with viewport — larger canvas = bigger labels
// Base values for a ~10m viewport, scaled by viewWidth/10
let _measureScale = 1
function setMeasureScale(viewBoxWidth: number) {
  _measureScale = Math.max(0.5, Math.min(3, viewBoxWidth / 10))
}
const FLOORPLAN_MEASUREMENT_OFFSET_BASE = 0.46
const FLOORPLAN_MEASUREMENT_EXTENSION_OVERSHOOT_BASE = 0.08
const FLOORPLAN_MEASUREMENT_LABEL_GAP_BASE = 0.56
const FLOORPLAN_MEASUREMENT_LABEL_LINE_PADDING_BASE = 0.14
const FLOORPLAN_MEASUREMENT_LABEL_FONT_SIZE_BASE = 0.17
const FLOORPLAN_MEASUREMENT_LABEL_STROKE_WIDTH_BASE = 0.06

// Dynamic getters
function getMeasureOffset() { return FLOORPLAN_MEASUREMENT_OFFSET_BASE * _measureScale }
function getMeasureExtOvershoot() { return FLOORPLAN_MEASUREMENT_EXTENSION_OVERSHOOT_BASE * _measureScale }
function getMeasureLabelGap() { return FLOORPLAN_MEASUREMENT_LABEL_GAP_BASE * _measureScale }
function getMeasureLabelLinePadding() { return FLOORPLAN_MEASUREMENT_LABEL_LINE_PADDING_BASE * _measureScale }
function getMeasureLabelFontSize() { return FLOORPLAN_MEASUREMENT_LABEL_FONT_SIZE_BASE * _measureScale }
function getMeasureLabelStrokeWidth() { return FLOORPLAN_MEASUREMENT_LABEL_STROKE_WIDTH_BASE * _measureScale }

// Fixed (pixel-based via vectorEffect, no scaling needed)
const FLOORPLAN_MEASUREMENT_LINE_WIDTH = 2.0
const FLOORPLAN_MEASUREMENT_LINE_OUTLINE_WIDTH = 4.0
const FLOORPLAN_MEASUREMENT_LINE_OPACITY = 0.9
const FLOORPLAN_MEASUREMENT_LINE_OUTLINE_OPACITY = 1.0
const FLOORPLAN_MEASUREMENT_LABEL_OPACITY = 0.95

// Compat aliases for code that still uses the old constants
const FLOORPLAN_MEASUREMENT_OFFSET = FLOORPLAN_MEASUREMENT_OFFSET_BASE
const FLOORPLAN_MEASUREMENT_EXTENSION_OVERSHOOT = FLOORPLAN_MEASUREMENT_EXTENSION_OVERSHOOT_BASE
const FLOORPLAN_MEASUREMENT_LABEL_FONT_SIZE = FLOORPLAN_MEASUREMENT_LABEL_FONT_SIZE_BASE
const FLOORPLAN_MEASUREMENT_LABEL_STROKE_WIDTH = FLOORPLAN_MEASUREMENT_LABEL_STROKE_WIDTH_BASE
const FLOORPLAN_MEASUREMENT_LABEL_GAP = FLOORPLAN_MEASUREMENT_LABEL_GAP_BASE
const FLOORPLAN_MEASUREMENT_LABEL_LINE_PADDING = FLOORPLAN_MEASUREMENT_LABEL_LINE_PADDING_BASE
const FLOORPLAN_ACTION_MENU_HORIZONTAL_PADDING = 60
const FLOORPLAN_ACTION_MENU_MIN_ANCHOR_Y = 56
const FLOORPLAN_ACTION_MENU_OFFSET_Y = 10
const FLOORPLAN_DEFAULT_WINDOW_LOCAL_Y = 1.5
const FLOORPLAN_LEVEL_MENU_CLOSE_DELAY_MS = 120
// Match the guide plane footprint used in the 3D renderer so the 2D overlay aligns.
const FLOORPLAN_GUIDE_BASE_WIDTH = 10
const FLOORPLAN_GUIDE_MIN_SCALE = 0.01
const FLOORPLAN_GUIDE_HANDLE_SIZE = 0.22
const FLOORPLAN_GUIDE_HANDLE_HIT_RADIUS = 0.3
const FLOORPLAN_GUIDE_SELECTION_STROKE_WIDTH = 0.05
const FLOORPLAN_GUIDE_HANDLE_HINT_OFFSET = 72
const FLOORPLAN_GUIDE_HANDLE_HINT_PADDING_X = 92
const FLOORPLAN_GUIDE_HANDLE_HINT_PADDING_Y = 48
const FLOORPLAN_GUIDE_ROTATION_SNAP_DEGREES = 45
const FLOORPLAN_GUIDE_ROTATION_FINE_SNAP_DEGREES = 1
const FLOORPLAN_SITE_COLOR = '#10b981'

type FloorplanViewport = {
  centerX: number
  centerY: number
  width: number
}

type SvgPoint = {
  x: number
  y: number
}

type PanState = {
  pointerId: number
  clientX: number
  clientY: number
}

type GestureLikeEvent = Event & {
  clientX?: number
  clientY?: number
  scale?: number
}

type PanelRect = {
  x: number
  y: number
  width: number
  height: number
}

type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

type PanelInteractionState = {
  pointerId: number
  startClientX: number
  startClientY: number
  initialRect: PanelRect
  type: 'drag' | 'resize'
  direction?: ResizeDirection
}

type ViewportBounds = {
  width: number
  height: number
}

type OpeningNode = WindowNode | DoorNode

type WallEndpoint = 'start' | 'end'

type FloorplanSelectionTool = 'click' | 'marquee'

type FloorplanCursorIndicator =
  | {
      kind: 'asset'
      iconSrc: string
    }
  | {
      kind: 'icon'
      icon: string
    }

// Ritn3D: 'arc-wall' added to the floor-plan toolbar. The structureTools
// entry uses iconNode (inline SVG) since we don't have a PNG for the arc
// wall yet — the render below conditionally uses iconNode when iconSrc is
// missing.
const FLOORPLAN_QUICK_BUILD_TOOL_IDS = ['wall', 'arc-wall', 'door', 'window', 'slab', 'zone'] as const

type FloorplanQuickBuildTool = (typeof FLOORPLAN_QUICK_BUILD_TOOL_IDS)[number]

const FLOORPLAN_QUICK_BUILD_TOOL_LABELS: Record<FloorplanQuickBuildTool, string> = {
  wall: 'Wall',
  'arc-wall': 'Arc Wall',
  door: 'Door',
  window: 'Window',
  slab: 'Floor',
  zone: 'Zone',
}

const FLOORPLAN_QUICK_BUILD_TOOL_FALLBACK_ICONS: Record<FloorplanQuickBuildTool, string | undefined> = {
  wall: '/icons/wall.png',
  'arc-wall': undefined, // uses iconNode from structureTools
  door: '/icons/door.png',
  window: '/icons/window.png',
  slab: '/icons/floor.png',
  zone: '/icons/zone.png',
}

const FLOORPLAN_QUICK_BUILD_TOOLS = FLOORPLAN_QUICK_BUILD_TOOL_IDS.map((id) => {
  const toolConfig = structureTools.find((entry) => entry.id === id)

  return {
    id,
    iconSrc: toolConfig?.iconSrc ?? FLOORPLAN_QUICK_BUILD_TOOL_FALLBACK_ICONS[id],
    iconNode: toolConfig?.iconNode,
    label: FLOORPLAN_QUICK_BUILD_TOOL_LABELS[id],
  }
})

function getLevelDisplayLabel(level: LevelNode) {
  return level.name || `Level ${level.level}`
}

type PersistedPanelLayout = {
  rect: PanelRect
  viewport: ViewportBounds
}

type FloorplanSelectionBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

type FloorplanMarqueeState = {
  pointerId: number
  startClientX: number
  startClientY: number
  startPlanPoint: WallPlanPoint
  currentPlanPoint: WallPlanPoint
}

type WallEndpointDragState = {
  pointerId: number
  wallId: WallNode['id']
  endpoint: WallEndpoint
  fixedPoint: WallPlanPoint
  currentPoint: WallPlanPoint
}

const GUIDE_CORNERS = ['nw', 'ne', 'se', 'sw'] as const

type GuideCorner = (typeof GUIDE_CORNERS)[number]

type GuideInteractionMode = 'resize' | 'rotate' | 'translate'

type GuideTransformDraft = {
  guideId: GuideNode['id']
  position: WallPlanPoint
  scale: number
  rotation: number
}

type GuideHandleHintAnchor = {
  x: number
  y: number
  directionX: number
  directionY: number
}

type GuideInteractionState = {
  pointerId: number
  guideId: GuideNode['id']
  corner: GuideCorner
  mode: GuideInteractionMode
  aspectRatio: number
  centerSvg: SvgPoint
  oppositeCornerSvg: SvgPoint | null
  pointerOffsetSvg: WallPlanPoint
  rotationSvg: number
  cornerBaseAngle: number
  scale: number
}

type WallEndpointDraft = {
  wallId: WallNode['id']
  endpoint: WallEndpoint
  start: WallPlanPoint
  end: WallPlanPoint
}

// Bulge drag — separate state from endpoint drag because the operation
// modifies a different field (wall.bulge) and the cursor is interpreted as
// the perpendicular offset midpoint, not a new endpoint. Lives in parallel
// with WallEndpointDragState so the existing endpoint drag is unchanged.
type WallBulgeDragState = {
  pointerId: number
  wallId: WallNode['id']
  start: WallPlanPoint
  end: WallPlanPoint
  // Relative drag state. We track the cursor's perpendicular offset and
  // chord-aligned offset at drag start, plus the wall's bulge at drag start.
  // On each pointer-move we compute the CHANGE in cursor perp vs drag start
  // and apply that delta to the initial bulge. That way small drag = small
  // bulge change regardless of how curved the wall already is.
  initialBulge: number
  initialPerp: number
  lastBulge: number
  lastLogAt?: number
}

type WallBulgeDraft = {
  wallId: WallNode['id']
  bulge: number
}

type SlabBoundaryDraft = {
  slabId: SlabNode['id']
  polygon: WallPlanPoint[]
}

type SlabVertexDragState = {
  pointerId: number
  slabId: SlabNode['id']
  vertexIndex: number
}

type SiteBoundaryDraft = {
  siteId: SiteNode['id']
  polygon: WallPlanPoint[]
}

type SiteVertexDragState = {
  pointerId: number
  siteId: SiteNode['id']
  vertexIndex: number
}

type ZoneBoundaryDraft = {
  zoneId: ZoneNodeType['id']
  polygon: WallPlanPoint[]
}

type ZoneVertexDragState = {
  pointerId: number
  zoneId: ZoneNodeType['id']
  vertexIndex: number
}

type WallPolygonEntry = {
  wall: WallNode
  polygon: Point2D[]
  points: string
}

type OpeningPolygonEntry = {
  opening: OpeningNode
  polygon: Point2D[]
  points: string
}

type SlabPolygonEntry = {
  slab: SlabNode
  polygon: Point2D[]
  holes: Point2D[][]
  path: string
}

type SitePolygonEntry = {
  site: SiteNode
  polygon: Point2D[]
  points: string
}

type ZonePolygonEntry = {
  zone: ZoneNodeType
  polygon: Point2D[]
  points: string
}

type FloorplanPalette = {
  surface: string
  minorGrid: string
  majorGrid: string
  minorGridOpacity: number
  majorGridOpacity: number
  slabFill: string
  slabStroke: string
  selectedSlabFill: string
  wallFill: string
  wallStroke: string
  wallHoverStroke: string
  selectedFill: string
  selectedStroke: string
  draftFill: string
  draftStroke: string
  cursor: string
  editCursor: string
  anchor: string
  openingFill: string
  openingStroke: string
  doorFill: string
  doorStroke: string
  windowFill: string
  windowStroke: string
  measurementStroke: string
  endpointHandleFill: string
  endpointHandleStroke: string
  endpointHandleHoverStroke: string
  endpointHandleActiveFill: string
  endpointHandleActiveStroke: string
}

const resizeCursorByDirection: Record<ResizeDirection, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  sw: 'nesw-resize',
}

const resizeHandleConfigurations: Array<{
  direction: ResizeDirection
  className: string
}> = [
  { direction: 'n', className: 'absolute top-0 left-4 right-4 z-20 h-2 cursor-ns-resize' },
  { direction: 's', className: 'absolute right-4 bottom-0 left-4 z-20 h-2 cursor-ns-resize' },
  { direction: 'e', className: 'absolute top-4 right-0 bottom-4 z-20 w-2 cursor-ew-resize' },
  { direction: 'w', className: 'absolute top-4 bottom-4 left-0 z-20 w-2 cursor-ew-resize' },
  { direction: 'ne', className: 'absolute top-0 right-0 z-20 h-4 w-4 cursor-nesw-resize' },
  { direction: 'nw', className: 'absolute top-0 left-0 z-20 h-4 w-4 cursor-nwse-resize' },
  { direction: 'se', className: 'absolute right-0 bottom-0 z-20 h-4 w-4 cursor-nwse-resize' },
  { direction: 'sw', className: 'absolute bottom-0 left-0 z-20 h-4 w-4 cursor-nesw-resize' },
]

const guideCornerSigns: Record<GuideCorner, { x: -1 | 1; y: -1 | 1 }> = {
  nw: { x: -1, y: -1 },
  ne: { x: 1, y: -1 },
  se: { x: 1, y: 1 },
  sw: { x: -1, y: 1 },
}

const oppositeGuideCorner: Record<GuideCorner, GuideCorner> = {
  nw: 'se',
  ne: 'sw',
  se: 'nw',
  sw: 'ne',
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getSelectionModifierKeys(event?: { metaKey?: boolean; ctrlKey?: boolean }) {
  return {
    meta: Boolean(event?.metaKey),
    ctrl: Boolean(event?.ctrlKey),
  }
}

function toPoint2D(point: WallPlanPoint): Point2D {
  return { x: point[0], y: point[1] }
}

function toWallPlanPoint(point: Point2D): WallPlanPoint {
  return [point.x, point.y]
}

function toSvgX(value: number): number {
  return -value
}

function toSvgY(value: number): number {
  return -value
}

function toSvgPoint(point: Point2D): SvgPoint {
  return {
    x: toSvgX(point.x),
    y: toSvgY(point.y),
  }
}

function toSvgPlanPoint(point: WallPlanPoint): SvgPoint {
  return {
    x: toSvgX(point[0]),
    y: toSvgY(point[1]),
  }
}

function toPlanPointFromSvgPoint(svgPoint: SvgPoint): WallPlanPoint {
  return [toSvgX(svgPoint.x), toSvgY(svgPoint.y)]
}

function rotateVector([x, y]: WallPlanPoint, angle: number): WallPlanPoint {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [x * cos - y * sin, x * sin + y * cos]
}

function addVectorToSvgPoint(point: SvgPoint, [dx, dy]: WallPlanPoint): SvgPoint {
  return {
    x: point.x + dx,
    y: point.y + dy,
  }
}

function subtractSvgPoints(point: SvgPoint, origin: SvgPoint): WallPlanPoint {
  return [point.x - origin.x, point.y - origin.y]
}

function midpointBetweenSvgPoints(start: SvgPoint, end: SvgPoint): SvgPoint {
  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  }
}

function getGuideWidth(scale: number) {
  return FLOORPLAN_GUIDE_BASE_WIDTH * scale
}

function getGuideHeight(width: number, aspectRatio: number) {
  return width / aspectRatio
}

function getGuideCenterSvgPoint(guide: GuideNode): SvgPoint {
  return {
    x: toSvgX(guide.position[0]),
    y: toSvgY(guide.position[2]),
  }
}

function getGuideCornerLocalOffset(
  width: number,
  height: number,
  corner: GuideCorner,
): WallPlanPoint {
  const signs = guideCornerSigns[corner]
  return [(width / 2) * signs.x, (height / 2) * signs.y]
}

function getGuideCornerSvgPoint(
  centerSvg: SvgPoint,
  width: number,
  height: number,
  rotationSvg: number,
  corner: GuideCorner,
): SvgPoint {
  return addVectorToSvgPoint(
    centerSvg,
    rotateVector(getGuideCornerLocalOffset(width, height, corner), rotationSvg),
  )
}

function snapAngleToIncrement(angle: number, incrementDegrees: number) {
  const incrementRadians = (incrementDegrees * Math.PI) / 180
  return Math.round(angle / incrementRadians) * incrementRadians
}

function toPositiveAngleDegrees(angle: number) {
  const angleDegrees = (angle * 180) / Math.PI
  return ((angleDegrees % 180) + 180) % 180
}

function getResizeCursorForAngle(angle: number) {
  const normalizedDegrees = toPositiveAngleDegrees(angle)

  if (normalizedDegrees < 22.5 || normalizedDegrees >= 157.5) {
    return 'ew-resize'
  }

  if (normalizedDegrees < 67.5) {
    return 'nwse-resize'
  }

  if (normalizedDegrees < 112.5) {
    return 'ns-resize'
  }

  return 'nesw-resize'
}

function getGuideResizeCursor(corner: GuideCorner, rotationSvg: number) {
  const signs = guideCornerSigns[corner]
  return getResizeCursorForAngle(Math.atan2(signs.y, signs.x) + rotationSvg)
}

function buildCursorUrl(svgMarkup: string, hotspotX: number, hotspotY: number, fallback: string) {
  return `url("data:image/svg+xml,${encodeURIComponent(svgMarkup)}") ${hotspotX} ${hotspotY}, ${fallback}`
}

function getGuideRotateCursor(isDarkMode: boolean) {
  const strokeColor = isDarkMode ? '#ffffff' : '#09090b'
  const outlineColor = isDarkMode ? '#0a0e1b' : '#ffffff'
  const svgMarkup = `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M7 15.75a6 6 0 1 0 1.9-8.28" stroke="${outlineColor}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M7 5.5v4.5h4.5" stroke="${outlineColor}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M7 15.75a6 6 0 1 0 1.9-8.28" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M7 5.5v4.5h4.5" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `.trim()

  return buildCursorUrl(svgMarkup, 12, 12, 'pointer')
}

function buildGuideTranslateDraft(
  interaction: GuideInteractionState,
  pointerSvg: SvgPoint,
): GuideTransformDraft {
  const centerSvg = addVectorToSvgPoint(pointerSvg, [
    -interaction.pointerOffsetSvg[0],
    -interaction.pointerOffsetSvg[1],
  ])

  return {
    guideId: interaction.guideId,
    position: toPlanPointFromSvgPoint(centerSvg),
    scale: interaction.scale,
    rotation: normalizeAngle(-interaction.rotationSvg),
  }
}

function normalizeAngle(angle: number) {
  let nextAngle = angle

  while (nextAngle <= -Math.PI) {
    nextAngle += Math.PI * 2
  }

  while (nextAngle > Math.PI) {
    nextAngle -= Math.PI * 2
  }

  return nextAngle
}

function areGuideTransformDraftsEqual(
  previousDraft: GuideTransformDraft | null,
  nextDraft: GuideTransformDraft | null,
  epsilon = 1e-6,
) {
  if (previousDraft === nextDraft) {
    return true
  }

  if (!(previousDraft && nextDraft)) {
    return false
  }

  return (
    previousDraft.guideId === nextDraft.guideId &&
    Math.abs(previousDraft.position[0] - nextDraft.position[0]) <= epsilon &&
    Math.abs(previousDraft.position[1] - nextDraft.position[1]) <= epsilon &&
    Math.abs(previousDraft.scale - nextDraft.scale) <= epsilon &&
    Math.abs(previousDraft.rotation - nextDraft.rotation) <= epsilon
  )
}

function doesGuideMatchDraft(guide: GuideNode, draft: GuideTransformDraft, epsilon = 1e-6) {
  return (
    Math.abs(guide.position[0] - draft.position[0]) <= epsilon &&
    Math.abs(guide.position[2] - draft.position[1]) <= epsilon &&
    Math.abs(guide.scale - draft.scale) <= epsilon &&
    Math.abs(normalizeAngle(guide.rotation[1] - draft.rotation)) <= epsilon
  )
}

function buildGuideResizeDraft(
  interaction: GuideInteractionState,
  pointerSvg: SvgPoint,
): GuideTransformDraft {
  const signs = guideCornerSigns[interaction.corner]
  const minWidth = FLOORPLAN_GUIDE_BASE_WIDTH * FLOORPLAN_GUIDE_MIN_SCALE
  const diagonal = [signs.x * interaction.aspectRatio, signs.y] as WallPlanPoint
  const oppositeCornerSvg = interaction.oppositeCornerSvg ?? interaction.centerSvg
  const relativePointer = rotateVector(
    subtractSvgPoints(pointerSvg, oppositeCornerSvg),
    -interaction.rotationSvg,
  )
  const projectedHeight =
    (relativePointer[0] * diagonal[0] + relativePointer[1] * diagonal[1]) /
    (interaction.aspectRatio ** 2 + 1)
  const width = Math.max(minWidth, projectedHeight * interaction.aspectRatio)
  const height = getGuideHeight(width, interaction.aspectRatio)
  const draggedCornerSvg = addVectorToSvgPoint(
    oppositeCornerSvg,
    rotateVector([signs.x * width, signs.y * height], interaction.rotationSvg),
  )
  const centerSvg = midpointBetweenSvgPoints(oppositeCornerSvg, draggedCornerSvg)

  return {
    guideId: interaction.guideId,
    position: toPlanPointFromSvgPoint(centerSvg),
    scale: width / FLOORPLAN_GUIDE_BASE_WIDTH,
    rotation: normalizeAngle(-interaction.rotationSvg),
  }
}

function buildGuideRotationDraft(
  interaction: GuideInteractionState,
  pointerSvg: SvgPoint,
  useFineIncrement: boolean,
): GuideTransformDraft {
  const pointerVector = subtractSvgPoints(pointerSvg, interaction.centerSvg)

  if (pointerVector[0] ** 2 + pointerVector[1] ** 2 <= 1e-6) {
    return {
      guideId: interaction.guideId,
      position: toPlanPointFromSvgPoint(interaction.centerSvg),
      scale: interaction.scale,
      rotation: normalizeAngle(-interaction.rotationSvg),
    }
  }

  const rawRotationSvg =
    Math.atan2(pointerVector[1], pointerVector[0]) - interaction.cornerBaseAngle
  const snappedRotationSvg = snapAngleToIncrement(
    rawRotationSvg,
    useFineIncrement
      ? FLOORPLAN_GUIDE_ROTATION_FINE_SNAP_DEGREES
      : FLOORPLAN_GUIDE_ROTATION_SNAP_DEGREES,
  )

  return {
    guideId: interaction.guideId,
    position: toPlanPointFromSvgPoint(interaction.centerSvg),
    scale: interaction.scale,
    rotation: normalizeAngle(-snappedRotationSvg),
  }
}

function toSvgSelectionBounds(bounds: FloorplanSelectionBounds) {
  return {
    x: toSvgX(bounds.maxX),
    y: toSvgY(bounds.maxY),
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  }
}

function getFloorplanSelectionBounds(
  start: WallPlanPoint,
  end: WallPlanPoint,
): FloorplanSelectionBounds {
  return {
    minX: Math.min(start[0], end[0]),
    maxX: Math.max(start[0], end[0]),
    minY: Math.min(start[1], end[1]),
    maxY: Math.max(start[1], end[1]),
  }
}

function isPointInsideSelectionBounds(point: Point2D, bounds: FloorplanSelectionBounds) {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  )
}

function isPointInsidePolygon(point: Point2D, polygon: Point2D[]) {
  let isInside = false

  for (
    let currentIndex = 0, previousIndex = polygon.length - 1;
    currentIndex < polygon.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const current = polygon[currentIndex]
    const previous = polygon[previousIndex]

    if (!(current && previous)) {
      continue
    }

    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x

    if (intersects) {
      isInside = !isInside
    }
  }

  return isInside
}

function getLineOrientation(start: Point2D, end: Point2D, point: Point2D) {
  return (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x)
}

function isPointOnSegment(point: Point2D, start: Point2D, end: Point2D) {
  const epsilon = 1e-9

  return (
    Math.abs(getLineOrientation(start, end, point)) <= epsilon &&
    point.x >= Math.min(start.x, end.x) - epsilon &&
    point.x <= Math.max(start.x, end.x) + epsilon &&
    point.y >= Math.min(start.y, end.y) - epsilon &&
    point.y <= Math.max(start.y, end.y) + epsilon
  )
}

function doSegmentsIntersect(
  firstStart: Point2D,
  firstEnd: Point2D,
  secondStart: Point2D,
  secondEnd: Point2D,
) {
  const orientation1 = getLineOrientation(firstStart, firstEnd, secondStart)
  const orientation2 = getLineOrientation(firstStart, firstEnd, secondEnd)
  const orientation3 = getLineOrientation(secondStart, secondEnd, firstStart)
  const orientation4 = getLineOrientation(secondStart, secondEnd, firstEnd)

  const hasProperIntersection =
    ((orientation1 > 0 && orientation2 < 0) || (orientation1 < 0 && orientation2 > 0)) &&
    ((orientation3 > 0 && orientation4 < 0) || (orientation3 < 0 && orientation4 > 0))

  if (hasProperIntersection) {
    return true
  }

  return (
    isPointOnSegment(secondStart, firstStart, firstEnd) ||
    isPointOnSegment(secondEnd, firstStart, firstEnd) ||
    isPointOnSegment(firstStart, secondStart, secondEnd) ||
    isPointOnSegment(firstEnd, secondStart, secondEnd)
  )
}

function doesPolygonIntersectSelectionBounds(polygon: Point2D[], bounds: FloorplanSelectionBounds) {
  if (polygon.length === 0) {
    return false
  }

  if (polygon.some((point) => isPointInsideSelectionBounds(point, bounds))) {
    return true
  }

  const boundsCorners: [Point2D, Point2D, Point2D, Point2D] = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ]

  if (boundsCorners.some((corner) => isPointInsidePolygon(corner, polygon))) {
    return true
  }

  const boundsEdges = [
    [boundsCorners[0], boundsCorners[1]],
    [boundsCorners[1], boundsCorners[2]],
    [boundsCorners[2], boundsCorners[3]],
    [boundsCorners[3], boundsCorners[0]],
  ] as const

  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index]
    const end = polygon[(index + 1) % polygon.length]

    if (!(start && end)) {
      continue
    }

    for (const [edgeStart, edgeEnd] of boundsEdges) {
      if (doSegmentsIntersect(start, end, edgeStart, edgeEnd)) {
        return true
      }
    }
  }

  return false
}

function getDistanceToWallSegment(point: Point2D, start: WallPlanPoint, end: WallPlanPoint) {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy

  if (lengthSquared <= Number.EPSILON) {
    return Math.hypot(point.x - start[0], point.y - start[1])
  }

  const projection = clamp(
    ((point.x - start[0]) * dx + (point.y - start[1]) * dy) / lengthSquared,
    0,
    1,
  )
  const projectedX = start[0] + dx * projection
  const projectedY = start[1] + dy * projection

  return Math.hypot(point.x - projectedX, point.y - projectedY)
}

function getViewportBounds(): ViewportBounds {
  if (typeof window === 'undefined') {
    return {
      width: PANEL_DEFAULT_WIDTH + PANEL_MARGIN * 2,
      height: PANEL_DEFAULT_HEIGHT + PANEL_MARGIN * 2,
    }
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  }
}

function getPanelSizeLimits(bounds: ViewportBounds) {
  const maxWidth = Math.max(1, bounds.width - PANEL_MARGIN * 2)
  const maxHeight = Math.max(1, bounds.height - PANEL_MARGIN * 2)

  return {
    maxHeight,
    maxWidth,
    minHeight: Math.min(PANEL_MIN_HEIGHT, maxHeight),
    minWidth: Math.min(PANEL_MIN_WIDTH, maxWidth),
  }
}

function constrainPanelRect(rect: PanelRect, bounds: ViewportBounds): PanelRect {
  const { minWidth, maxWidth, minHeight, maxHeight } = getPanelSizeLimits(bounds)
  const width = clamp(rect.width, minWidth, maxWidth)
  const height = clamp(rect.height, minHeight, maxHeight)
  const x = clamp(rect.x, PANEL_MARGIN, Math.max(PANEL_MARGIN, bounds.width - PANEL_MARGIN - width))
  const y = clamp(
    rect.y,
    PANEL_MARGIN,
    Math.max(PANEL_MARGIN, bounds.height - PANEL_MARGIN - height),
  )

  return { x, y, width, height }
}

function getPanelPositionRatios(rect: PanelRect, bounds: ViewportBounds) {
  const availableX = Math.max(bounds.width - rect.width - PANEL_MARGIN * 2, 0)
  const availableY = Math.max(bounds.height - rect.height - PANEL_MARGIN * 2, 0)

  return {
    xRatio: availableX > 0 ? (rect.x - PANEL_MARGIN) / availableX : 0.5,
    yRatio: availableY > 0 ? (rect.y - PANEL_MARGIN) / availableY : 0.5,
  }
}

function adaptPanelRectToBounds(
  rect: PanelRect,
  previousBounds: ViewportBounds,
  nextBounds: ViewportBounds,
): PanelRect {
  const normalizedRect = constrainPanelRect(rect, previousBounds)
  const { xRatio, yRatio } = getPanelPositionRatios(normalizedRect, previousBounds)
  const { minWidth, maxWidth, minHeight, maxHeight } = getPanelSizeLimits(nextBounds)
  const width = clamp(normalizedRect.width, minWidth, maxWidth)
  const height = clamp(normalizedRect.height, minHeight, maxHeight)
  const availableX = Math.max(nextBounds.width - width - PANEL_MARGIN * 2, 0)
  const availableY = Math.max(nextBounds.height - height - PANEL_MARGIN * 2, 0)

  return constrainPanelRect(
    {
      x: PANEL_MARGIN + availableX * xRatio,
      y: PANEL_MARGIN + availableY * yRatio,
      width,
      height,
    },
    nextBounds,
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidPanelRect(value: unknown): value is PanelRect {
  return (
    typeof value === 'object' &&
    value !== null &&
    isFiniteNumber((value as PanelRect).x) &&
    isFiniteNumber((value as PanelRect).y) &&
    isFiniteNumber((value as PanelRect).width) &&
    isFiniteNumber((value as PanelRect).height)
  )
}

function isValidViewportBounds(value: unknown): value is ViewportBounds {
  return (
    typeof value === 'object' &&
    value !== null &&
    isFiniteNumber((value as ViewportBounds).width) &&
    isFiniteNumber((value as ViewportBounds).height)
  )
}

function readPersistedPanelLayout(currentBounds: ViewportBounds): PanelRect | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const rawLayout = window.localStorage.getItem(FLOORPLAN_PANEL_LAYOUT_STORAGE_KEY)
    if (!rawLayout) {
      return null
    }

    const parsedLayout = JSON.parse(rawLayout) as Partial<PersistedPanelLayout>
    if (!(isValidPanelRect(parsedLayout.rect) && isValidViewportBounds(parsedLayout.viewport))) {
      return null
    }

    return adaptPanelRectToBounds(parsedLayout.rect, parsedLayout.viewport, currentBounds)
  } catch {
    return null
  }
}

function writePersistedPanelLayout(layout: PersistedPanelLayout) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(FLOORPLAN_PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
}

function getInitialPanelRect(bounds: ViewportBounds): PanelRect {
  return constrainPanelRect(
    {
      x: bounds.width - PANEL_DEFAULT_WIDTH - PANEL_MARGIN,
      y: bounds.height - PANEL_DEFAULT_HEIGHT - PANEL_DEFAULT_BOTTOM_OFFSET,
      width: PANEL_DEFAULT_WIDTH,
      height: PANEL_DEFAULT_HEIGHT,
    },
    bounds,
  )
}

function movePanelRect(
  initialRect: PanelRect,
  dx: number,
  dy: number,
  bounds: ViewportBounds,
): PanelRect {
  return constrainPanelRect(
    {
      ...initialRect,
      x: initialRect.x + dx,
      y: initialRect.y + dy,
    },
    bounds,
  )
}

function resizePanelRect(
  initialRect: PanelRect,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  bounds: ViewportBounds,
): PanelRect {
  const right = initialRect.x + initialRect.width
  const bottom = initialRect.y + initialRect.height

  let x = initialRect.x
  let y = initialRect.y
  let width = initialRect.width
  let height = initialRect.height

  if (direction.includes('e')) width = initialRect.width + dx
  if (direction.includes('s')) height = initialRect.height + dy
  if (direction.includes('w')) width = initialRect.width - dx
  if (direction.includes('n')) height = initialRect.height - dy

  const maxWidth = Math.max(PANEL_MIN_WIDTH, bounds.width - PANEL_MARGIN * 2)
  const maxHeight = Math.max(PANEL_MIN_HEIGHT, bounds.height - PANEL_MARGIN * 2)
  width = clamp(width, PANEL_MIN_WIDTH, maxWidth)
  height = clamp(height, PANEL_MIN_HEIGHT, maxHeight)

  if (direction.includes('w')) {
    x = right - width
  }
  if (direction.includes('n')) {
    y = bottom - height
  }

  x = clamp(x, PANEL_MARGIN, Math.max(PANEL_MARGIN, bounds.width - PANEL_MARGIN - width))
  y = clamp(y, PANEL_MARGIN, Math.max(PANEL_MARGIN, bounds.height - PANEL_MARGIN - height))

  if (direction.includes('w')) {
    width = right - x
  } else {
    width = Math.min(width, bounds.width - PANEL_MARGIN - x)
  }

  if (direction.includes('n')) {
    height = bottom - y
  } else {
    height = Math.min(height, bounds.height - PANEL_MARGIN - y)
  }

  return constrainPanelRect({ x, y, width, height }, bounds)
}

function formatPolygonPoints(points: Point2D[]): string {
  return points
    .map((point) => {
      const svgPoint = toSvgPoint(point)
      return `${svgPoint.x},${svgPoint.y}`
    })
    .join(' ')
}

function formatPolygonPath(points: Point2D[], holes: Point2D[][] = []): string {
  const formatSubpath = (subpathPoints: Point2D[]) => {
    const [firstPoint, ...restPoints] = subpathPoints
    if (!firstPoint) {
      return null
    }

    const firstSvgPoint = toSvgPoint(firstPoint)

    return [
      `M ${firstSvgPoint.x} ${firstSvgPoint.y}`,
      ...restPoints.map((point) => {
        const svgPoint = toSvgPoint(point)
        return `L ${svgPoint.x} ${svgPoint.y}`
      }),
      'Z',
    ].join(' ')
  }

  return [points, ...holes].map(formatSubpath).filter(Boolean).join(' ')
}

function toFloorplanPolygon(points: Array<[number, number]>): Point2D[] {
  return points.map(([x, y]) => ({ x, y }))
}

function isPointInsidePolygonWithHoles(
  point: Point2D,
  polygon: Point2D[],
  holes: Point2D[][] = [],
) {
  return (
    isPointInsidePolygon(point, polygon) && !holes.some((hole) => isPointInsidePolygon(point, hole))
  )
}

function isPointNearPlanPoint(a: WallPlanPoint, b: WallPlanPoint, threshold = 0.25) {
  return Math.abs(a[0] - b[0]) < threshold && Math.abs(a[1] - b[1]) < threshold
}

function calculatePolygonSnapPoint(
  lastPoint: WallPlanPoint,
  currentPoint: WallPlanPoint,
): WallPlanPoint {
  const [x1, y1] = lastPoint
  const [x, y] = currentPoint
  const dx = x - x1
  const dy = y - y1
  const absDx = Math.abs(dx)
  const absDy = Math.abs(dy)
  const horizontalDist = absDy
  const verticalDist = absDx
  const diagonalDist = Math.abs(absDx - absDy)
  const minDist = Math.min(horizontalDist, verticalDist, diagonalDist)

  if (minDist === diagonalDist) {
    const diagonalLength = Math.min(absDx, absDy)
    return [x1 + Math.sign(dx) * diagonalLength, y1 + Math.sign(dy) * diagonalLength]
  }

  if (minDist === horizontalDist) {
    return [x, y1]
  }

  return [x1, y]
}

function snapPolygonDraftPoint({
  point,
  start,
  angleSnap,
}: {
  point: WallPlanPoint
  start?: WallPlanPoint
  angleSnap: boolean
}): WallPlanPoint {
  const snappedPoint: WallPlanPoint = [snapToHalf(point[0]), snapToHalf(point[1])]

  if (!(start && angleSnap)) {
    return snappedPoint
  }

  return calculatePolygonSnapPoint(start, snappedPoint)
}

function pointMatchesWallPlanPoint(
  point: Point2D | undefined,
  planPoint: WallPlanPoint,
  epsilon = 1e-6,
): boolean {
  if (!point) {
    return false
  }

  return Math.abs(point.x - planPoint[0]) <= epsilon && Math.abs(point.y - planPoint[1]) <= epsilon
}

function getWallHoverSidePaths(polygon: Point2D[], wall: WallNode): [string, string] | null {
  if (polygon.length < 4) {
    return null
  }

  // Ritn3D 2026-06-17: arc walls. Their footprint polygon is
  // [outer[0..N], inner[N..0]] with N+1 tessellated points per side. The
  // straight-wall fast path below took polygon[0]/polygon[1] and drew ONE
  // straight line, which renders as a chord stub diving across the arc.
  // For arc walls trace the full tessellated outer and inner polylines.
  const isArc = Math.abs(wall.bulge ?? 0) > 1e-6
  if (isArc && polygon.length % 2 === 0) {
    const half = polygon.length / 2
    const outerPts = polygon.slice(0, half)
    const innerPts = polygon.slice(half).reverse()
    const buildPath = (pts: Point2D[]) => {
      if (pts.length < 2) return ''
      const svgPts = pts.map(toSvgPoint)
      const first = svgPts[0]!
      let d = `M ${first.x} ${first.y}`
      for (let i = 1; i < svgPts.length; i++) {
        const p = svgPts[i]!
        d += ` L ${p.x} ${p.y}`
      }
      return d
    }
    const outerPath = buildPath(outerPts)
    const innerPath = buildPath(innerPts)
    if (!outerPath || !innerPath) return null
    return [outerPath, innerPath]
  }

  const startRight = polygon[0]
  const endRight = polygon[1]
  const hasEndCenterPoint = pointMatchesWallPlanPoint(polygon[2], wall.end)
  const endLeft = polygon[hasEndCenterPoint ? 3 : 2]
  const lastPoint = polygon[polygon.length - 1]
  const hasStartCenterPoint = pointMatchesWallPlanPoint(lastPoint, wall.start)
  const startLeft = polygon[hasStartCenterPoint ? polygon.length - 2 : polygon.length - 1]

  if (!(startRight && endRight && endLeft && startLeft)) {
    return null
  }

  const svgStartRight = toSvgPoint(startRight)
  const svgEndRight = toSvgPoint(endRight)
  const svgStartLeft = toSvgPoint(startLeft)
  const svgEndLeft = toSvgPoint(endLeft)

  return [
    `M ${svgStartRight.x} ${svgStartRight.y} L ${svgEndRight.x} ${svgEndRight.y}`,
    `M ${svgStartLeft.x} ${svgStartLeft.y} L ${svgEndLeft.x} ${svgEndLeft.y}`,
  ]
}

function buildDraftWall(
  levelId: string,
  start: WallPlanPoint,
  end: WallPlanPoint,
  bulge = 0,
): WallNode {
  return {
    object: 'node',
    id: 'wall_draft' as WallNode['id'],
    type: 'wall',
    name: 'Draft wall',
    parentId: levelId,
    visible: true,
    metadata: {},
    children: [],
    start,
    end,
    bulge,
    frontSide: 'unknown',
    backSide: 'unknown',
  }
}

function pointsEqual(a: WallPlanPoint, b: WallPlanPoint): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

function polygonsEqual(a: WallPlanPoint[], b: Array<[number, number]>): boolean {
  return (
    a.length === b.length &&
    a.every((point, index) => {
      const otherPoint = b[index]
      if (!otherPoint) {
        return false
      }

      return pointsEqual(point, otherPoint)
    })
  )
}

function buildWallEndpointDraft(
  wallId: WallNode['id'],
  endpoint: WallEndpoint,
  fixedPoint: WallPlanPoint,
  movingPoint: WallPlanPoint,
): WallEndpointDraft {
  return {
    wallId,
    endpoint,
    start: endpoint === 'start' ? movingPoint : fixedPoint,
    end: endpoint === 'end' ? movingPoint : fixedPoint,
  }
}

function buildWallWithUpdatedEndpoints(
  wall: WallNode,
  start: WallPlanPoint,
  end: WallPlanPoint,
): WallNode {
  return {
    ...wall,
    start,
    end,
  }
}

function getFloorplanWallThickness(wall: WallNode): number {
  const baseThickness = wall.thickness ?? 0.1
  const scaledThickness = baseThickness * FLOORPLAN_WALL_THICKNESS_SCALE

  return Math.min(
    baseThickness + FLOORPLAN_MAX_EXTRA_THICKNESS,
    Math.max(baseThickness, scaledThickness, FLOORPLAN_MIN_VISIBLE_WALL_THICKNESS),
  )
}

function getFloorplanWall(wall: WallNode): WallNode {
  return {
    ...wall,
    // Slightly exaggerate thin walls so the 2D blueprint reads clearly without drifting far from BIM.
    thickness: getFloorplanWallThickness(wall),
  }
}

type WallMeasurementOverlay = {
  wallId: WallNode['id']
  dimensionLineEnd: { x1: number; y1: number; x2: number; y2: number }
  dimensionLineStart: { x1: number; y1: number; x2: number; y2: number }
  extensionStart: { x1: number; y1: number; x2: number; y2: number }
  extensionEnd: { x1: number; y1: number; x2: number; y2: number }
  label: string
  labelX: number
  labelY: number
  labelAngleDeg: number
  isSelected?: boolean
}

function formatMeasurement(value: number, unit: 'metric' | 'imperial') {
  if (unit === 'imperial') {
    const feet = value * 3.280_84
    const wholeFeet = Math.floor(feet)
    const inches = Math.round((feet - wholeFeet) * 12)
    if (inches === 12) return `${wholeFeet + 1}'0"`
    return `${wholeFeet}'${inches}"`
  }
  return `${Number.parseFloat(value.toFixed(2))}m`
}

function getPolygonAreaAndCentroid(polygon: Point2D[]) {
  let cx = 0
  let cy = 0
  let area = 0

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const p1 = polygon[j]!
    const p2 = polygon[i]!
    const f = p1.x * p2.y - p2.x * p1.y
    cx += (p1.x + p2.x) * f
    cy += (p1.y + p2.y) * f
    area += f
  }

  area /= 2

  if (Math.abs(area) < 1e-9) {
    return { area: 0, centroid: polygon[0] ?? { x: 0, y: 0 } }
  }

  cx /= 6 * area
  cy /= 6 * area

  return { area: Math.abs(area), centroid: { x: cx, y: cy } }
}

function getSlabArea(polygon: Point2D[], holes: Point2D[][]) {
  const outer = getPolygonAreaAndCentroid(polygon)
  let totalArea = outer.area
  for (const hole of holes) {
    totalArea -= getPolygonAreaAndCentroid(hole).area
  }
  return { area: Math.max(0, totalArea), centroid: outer.centroid }
}

function formatArea(areaSqM: number, unit: 'metric' | 'imperial') {
  if (unit === 'imperial') {
    const areaSqFt = areaSqM * 10.763_910_4
    return (
      <>
        {Math.round(areaSqFt).toLocaleString()} ft
        <tspan baselineShift="super" fontSize="0.75em">
          2
        </tspan>
      </>
    )
  }
  return (
    <>
      {Number.parseFloat(areaSqM.toFixed(1))} m
      <tspan baselineShift="super" fontSize="0.75em">
        2
      </tspan>
    </>
  )
}

function FloorplanMeasurementLine({
  palette,
  segment,
  isSelected,
}: {
  palette: FloorplanPalette
  segment: { x1: number; y1: number; x2: number; y2: number }
  isSelected?: boolean
}) {
  const lineOpacity = isSelected
    ? FLOORPLAN_MEASUREMENT_LINE_OPACITY
    : FLOORPLAN_MEASUREMENT_LINE_OPACITY * 0.4
  const outlineOpacity = isSelected
    ? FLOORPLAN_MEASUREMENT_LINE_OUTLINE_OPACITY
    : FLOORPLAN_MEASUREMENT_LINE_OUTLINE_OPACITY * 0.4

  return (
    <>
      <line
        shapeRendering="geometricPrecision"
        stroke={palette.surface}
        strokeLinecap="round"
        strokeOpacity={outlineOpacity}
        strokeWidth={FLOORPLAN_MEASUREMENT_LINE_OUTLINE_WIDTH}
        vectorEffect="non-scaling-stroke"
        x1={segment.x1}
        x2={segment.x2}
        y1={segment.y1}
        y2={segment.y2}
      />
      <line
        shapeRendering="geometricPrecision"
        stroke={palette.measurementStroke}
        strokeLinecap="round"
        strokeOpacity={lineOpacity}
        strokeWidth={FLOORPLAN_MEASUREMENT_LINE_WIDTH}
        vectorEffect="non-scaling-stroke"
        x1={segment.x1}
        x2={segment.x2}
        y1={segment.y1}
        y2={segment.y2}
      />
    </>
  )
}

function getWallMeasurementOverlay(
  wall: WallNode,
  centerX: number,
  centerZ: number,
  unit: 'metric' | 'imperial',
): WallMeasurementOverlay | null {
  const dx = wall.end[0] - wall.start[0]
  const dz = wall.end[1] - wall.start[1]
  const length = Math.hypot(dx, dz)

  if (length < 0.1) {
    return null
  }

  const nx = -dz / length
  const nz = dx / length
  const midX = (wall.start[0] + wall.end[0]) / 2
  const midZ = (wall.start[1] + wall.end[1]) / 2
  const cx = midX - centerX
  const cz = midZ - centerZ
  const dot = cx * nx + cz * nz
  const outX = dot >= 0 ? nx : -nx
  const outZ = dot >= 0 ? nz : -nz
  const label = formatMeasurement(length, unit)
  const mOffset = getMeasureOffset()
  const mOvershoot = getMeasureExtOvershoot()
  const dimensionLine = {
    x1: toSvgX(wall.start[0] + outX * mOffset),
    y1: toSvgY(wall.start[1] + outZ * mOffset),
    x2: toSvgX(wall.end[0] + outX * mOffset),
    y2: toSvgY(wall.end[1] + outZ * mOffset),
  }

  const extensionStart = {
    x1: toSvgX(wall.start[0]),
    y1: toSvgY(wall.start[1]),
    x2: toSvgX(wall.start[0] + outX * (mOffset + mOvershoot)),
    y2: toSvgY(wall.start[1] + outZ * (mOffset + mOvershoot)),
  }

  const extensionEnd = {
    x1: toSvgX(wall.end[0]),
    y1: toSvgY(wall.end[1]),
    x2: toSvgX(wall.end[0] + outX * (mOffset + mOvershoot)),
    y2: toSvgY(wall.end[1] + outZ * (mOffset + mOvershoot)),
  }

  const svgDx = dimensionLine.x2 - dimensionLine.x1
  const svgDy = dimensionLine.y2 - dimensionLine.y1
  const svgLength = Math.hypot(svgDx, svgDy)
  let labelAngleDeg = (Math.atan2(svgDy, svgDx) * 180) / Math.PI

  if (labelAngleDeg > 90) {
    labelAngleDeg -= 180
  } else if (labelAngleDeg <= -90) {
    labelAngleDeg += 180
  }

  if (svgLength < 1e-6) {
    return null
  }

  const dirSvgX = svgDx / svgLength
  const dirSvgY = svgDy / svgLength
  const labelGapHalf = Math.min(
    getMeasureLabelGap() / 2,
    Math.max(0, svgLength / 2 - getMeasureLabelLinePadding()),
  )
  const labelX = (dimensionLine.x1 + dimensionLine.x2) / 2
  const labelY = (dimensionLine.y1 + dimensionLine.y2) / 2
  const dimensionLineStart = {
    x1: dimensionLine.x1,
    y1: dimensionLine.y1,
    x2: labelX - dirSvgX * labelGapHalf,
    y2: labelY - dirSvgY * labelGapHalf,
  }
  const dimensionLineEnd = {
    x1: labelX + dirSvgX * labelGapHalf,
    y1: labelY + dirSvgY * labelGapHalf,
    x2: dimensionLine.x2,
    y2: dimensionLine.y2,
  }

  return {
    wallId: wall.id,
    dimensionLineEnd,
    dimensionLineStart,
    extensionStart,
    extensionEnd,
    label,
    labelX,
    labelY,
    labelAngleDeg,
  }
}

function getOpeningFootprint(wall: WallNode, node: WindowNode | DoorNode): Point2D[] {
  const width = node.width
  const depth = wall.thickness ?? 0.1
  const halfWidth = width / 2
  const halfDepth = depth / 2

  // Position is distance along the wall from start. For straight walls that's
  // chord distance; for arcs it's arc length. arcLength() collapses to chord
  // length when bulge == 0, so both cases go through the same formula.
  const bulge = wall.bulge ?? 0
  const totalLen = arcLength(wall.start, wall.end, bulge)
  if (totalLen < 1e-9) return []

  // Normalize position into [0, 1] parametric arc length so we can ask the
  // arc helper for (point, tangent) at that t. For straight walls this gives
  // exactly the legacy result (linear interpolation along chord).
  const t = Math.max(0, Math.min(1, node.position[0] / totalLen))
  const { point, tangent } = pointAndTangentAtT(wall.start, wall.end, bulge, t)

  const dirX = tangent[0]
  const dirZ = tangent[1]
  const perpX = -dirZ
  const perpZ = dirX
  const cx = point[0]
  const cz = point[1]

  return [
    { x: cx - dirX * halfWidth + perpX * halfDepth, y: cz - dirZ * halfWidth + perpZ * halfDepth },
    { x: cx + dirX * halfWidth + perpX * halfDepth, y: cz + dirZ * halfWidth + perpZ * halfDepth },
    { x: cx + dirX * halfWidth - perpX * halfDepth, y: cz + dirZ * halfWidth - perpZ * halfDepth },
    { x: cx - dirX * halfWidth - perpX * halfDepth, y: cz - dirZ * halfWidth - perpZ * halfDepth },
  ]
}

function getOpeningCenterLine(polygon: Point2D[]) {
  if (polygon.length < 4) {
    return null
  }

  const [p1, p2, p3, p4] = polygon

  return {
    start: {
      x: (p1!.x + p4!.x) / 2,
      y: (p1!.y + p4!.y) / 2,
    },
    end: {
      x: (p2!.x + p3!.x) / 2,
      y: (p2!.y + p3!.y) / 2,
    },
  }
}

function normalizeGridCoordinate(value: number): number {
  return Number(value.toFixed(GRID_COORDINATE_PRECISION))
}

function isGridAligned(value: number, step: number): boolean {
  if (!(Number.isFinite(step) && step > 0)) {
    return false
  }

  const normalizedValue = normalizeGridCoordinate(value / step)
  return Math.abs(normalizedValue - Math.round(normalizedValue)) < 1e-4
}

// Keep visible grid spacing above a minimum pixel size.
// Uses 1-2-5 sequence for smooth zoom transitions (like engineering graph paper).
function getVisibleGridSteps(
  viewportWidth: number,
  surfaceWidth: number,
): {
  minorStep: number
  majorStep: number
} {
  const pixelsPerUnit = surfaceWidth / Math.max(viewportWidth, Number.EPSILON)
  let minorStep = WALL_GRID_STEP

  // 1-2-5 sequence: 0.5 → 1.0 → 2.5 → 5.0 → 10 → 25 → ...
  const multipliers = [1, 2, 5]
  let scale = 1
  let mIdx = 0
  while (WALL_GRID_STEP * scale * multipliers[mIdx]! * pixelsPerUnit < MIN_GRID_SCREEN_SPACING) {
    mIdx++
    if (mIdx >= multipliers.length) {
      mIdx = 0
      scale *= 10
    }
  }
  minorStep = WALL_GRID_STEP * scale * multipliers[mIdx]!

  return {
    minorStep,
    majorStep: Math.max(MAJOR_GRID_STEP, minorStep * 5),
  }
}

function buildGridPath(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  step: number,
  options?: {
    excludeStep?: number
  },
): string {
  if (!(Number.isFinite(step) && step > 0)) {
    return ''
  }

  const commands: string[] = []
  const startXIndex = Math.floor(minX / step)
  const endXIndex = Math.ceil(maxX / step)
  const startYIndex = Math.floor(minY / step)
  const endYIndex = Math.ceil(maxY / step)
  const gridMinX = normalizeGridCoordinate(minX)
  const gridMaxX = normalizeGridCoordinate(maxX)
  const gridMinY = normalizeGridCoordinate(minY)
  const gridMaxY = normalizeGridCoordinate(maxY)

  for (let index = startXIndex; index <= endXIndex; index += 1) {
    const x = index * step
    if (options?.excludeStep && isGridAligned(x, options.excludeStep)) {
      continue
    }

    const gridX = normalizeGridCoordinate(x)
    commands.push(`M ${gridX} ${gridMinY} L ${gridX} ${gridMaxY}`)
  }

  for (let index = startYIndex; index <= endYIndex; index += 1) {
    const y = index * step
    if (options?.excludeStep && isGridAligned(y, options.excludeStep)) {
      continue
    }

    const gridY = normalizeGridCoordinate(y)
    commands.push(`M ${gridMinX} ${gridY} L ${gridMaxX} ${gridY}`)
  }

  return commands.join(' ')
}

function findClosestWallPoint(
  point: WallPlanPoint,
  walls: WallNode[],
  maxDistance = 0.5,
): { wall: WallNode; point: WallPlanPoint; t: number; normal: [number, number, number] } | null {
  let best: {
    wall: WallNode
    point: WallPlanPoint
    t: number
    normal: [number, number, number]
  } | null = null
  let bestDistSq = maxDistance * maxDistance

  for (const wall of walls) {
    const bulge = wall.bulge ?? 0
    if (isStraight(bulge)) {
      // Straight wall — original fast chord projection.
      const [x1, z1] = wall.start
      const [x2, z2] = wall.end
      const dx = x2 - x1
      const dz = z2 - z1
      const lengthSq = dx * dx + dz * dz
      if (lengthSq < 1e-9) continue
      let t = ((point[0] - x1) * dx + (point[1] - z1) * dz) / lengthSq
      t = Math.max(0, Math.min(1, t))
      const px = x1 + t * dx
      const pz = z1 + t * dz
      const distSq = (point[0] - px) ** 2 + (point[1] - pz) ** 2
      if (distSq < bestDistSq) {
        bestDistSq = distSq
        best = { wall, point: [px, pz], t, normal: [0, 0, 1] }
      }
      continue
    }

    // Curved wall — tessellate the arc, find closest point on the polyline.
    // `t` returned is arc-length-parametric (cumulative segment length /
    // total) — same semantic the rendering / placement code expects. Slower
    // than the chord projection (O(segments) per wall) but only runs while
    // a placement tool is hovering; furniture catalogs hover-test elsewhere.
    const samples = tessellateArc(wall.start, wall.end, bulge)
    if (samples.length < 2) continue
    // Pre-compute cumulative segment lengths for t-parameter mapping.
    const cum: number[] = [0]
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!
      const b = samples[i]!
      cum.push(cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]))
    }
    const totalLen = cum[cum.length - 1]!
    if (totalLen < 1e-9) continue
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!
      const b = samples[i]!
      const sx = b[0] - a[0]
      const sz = b[1] - a[1]
      const segLenSq = sx * sx + sz * sz
      if (segLenSq < 1e-12) continue
      let segT = ((point[0] - a[0]) * sx + (point[1] - a[1]) * sz) / segLenSq
      segT = Math.max(0, Math.min(1, segT))
      const px = a[0] + segT * sx
      const pz = a[1] + segT * sz
      const distSq = (point[0] - px) ** 2 + (point[1] - pz) ** 2
      if (distSq < bestDistSq) {
        bestDistSq = distSq
        const arcLenAtHit = cum[i - 1]! + segT * Math.sqrt(segLenSq)
        const t = arcLenAtHit / totalLen
        best = { wall, point: [px, pz], t, normal: [0, 0, 1] }
      }
    }
  }

  return best
}

type GuideImageDimensions = {
  width: number
  height: number
}

function useResolvedAssetUrl(url: string) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!url) {
      setResolvedUrl(null)
      return
    }

    let cancelled = false
    setResolvedUrl(null)

    loadAssetUrl(url).then((nextUrl) => {
      if (!cancelled) {
        setResolvedUrl(nextUrl)
      }
    })

    return () => {
      cancelled = true
    }
  }, [url])

  return resolvedUrl
}

function useGuideImageDimensions(url: string | null) {
  const [dimensions, setDimensions] = useState<GuideImageDimensions | null>(null)

  useEffect(() => {
    if (!url) {
      setDimensions(null)
      return
    }

    let cancelled = false
    const image = new globalThis.Image()

    image.onload = () => {
      if (cancelled) {
        return
      }

      const width = image.naturalWidth || image.width
      const height = image.naturalHeight || image.height

      if (!(width > 0 && height > 0)) {
        setDimensions(null)
        return
      }

      setDimensions({ width, height })
    }

    image.onerror = () => {
      if (!cancelled) {
        setDimensions(null)
      }
    }

    image.src = url

    return () => {
      cancelled = true
    }
  }, [url])

  return dimensions
}

function FloorplanGuideImage({
  guide,
  isInteractive,
  isSelected,
  activeInteractionMode,
  onGuideSelect,
  onGuideTranslateStart,
}: {
  guide: GuideNode
  isInteractive: boolean
  isSelected: boolean
  activeInteractionMode: GuideInteractionMode | null
  onGuideSelect: (guideId: GuideNode['id']) => void
  onGuideTranslateStart: (guide: GuideNode, event: ReactPointerEvent<SVGRectElement>) => void
}) {
  const resolvedUrl = useResolvedAssetUrl(guide.url)
  const dimensions = useGuideImageDimensions(resolvedUrl)

  if (!(guide.opacity > 0 && guide.scale > 0 && resolvedUrl && dimensions)) {
    return null
  }

  const aspectRatio = dimensions.width / dimensions.height
  const planWidth = getGuideWidth(guide.scale)
  const planHeight = getGuideHeight(planWidth, aspectRatio)
  const centerX = toSvgX(guide.position[0])
  const centerY = toSvgY(guide.position[2])
  const rotationDeg = (-guide.rotation[1] * 180) / Math.PI

  return (
    <g
      opacity={clamp(guide.opacity / 100, 0, 1)}
      transform={`translate(${centerX} ${centerY}) rotate(${rotationDeg})`}
    >
      {isInteractive ? (
        <rect
          fill="transparent"
          height={planHeight}
          onClick={(event) => {
            event.stopPropagation()
            onGuideSelect(guide.id)
          }}
          onPointerDown={(event) => {
            if (event.button === 0) {
              event.stopPropagation()
              if (isSelected) {
                onGuideTranslateStart(guide, event)
              }
            }
          }}
          pointerEvents="all"
          style={{
            cursor:
              isSelected && activeInteractionMode === 'translate'
                ? 'grabbing'
                : isSelected
                  ? 'grab'
                  : 'pointer',
          }}
          width={planWidth}
          x={-planWidth / 2}
          y={-planHeight / 2}
        />
      ) : null}
      <image
        height={planHeight}
        href={resolvedUrl}
        pointerEvents="none"
        preserveAspectRatio="none"
        width={planWidth}
        x={-planWidth / 2}
        y={-planHeight / 2}
      />
    </g>
  )
}

const FloorplanGridLayer = memo(function FloorplanGridLayer({
  majorGridPath,
  minorGridPath,
  palette,
  showGrid,
}: {
  majorGridPath: string
  minorGridPath: string
  palette: FloorplanPalette
  showGrid: boolean
}) {
  if (!showGrid) {
    return null
  }

  return (
    <>
      <path
        d={minorGridPath}
        fill="none"
        opacity={0.2}
        shapeRendering="crispEdges"
        stroke={palette.minorGrid}
        strokeWidth="0.015"
      />

      <path
        d={majorGridPath}
        fill="none"
        opacity={0.45}
        shapeRendering="crispEdges"
        stroke={palette.majorGrid}
        strokeWidth="0.03"
      />
    </>
  )
})

const FloorplanGuideLayer = memo(function FloorplanGuideLayer({
  guides,
  isInteractive,
  selectedGuideId,
  activeGuideInteractionGuideId,
  activeGuideInteractionMode,
  onGuideSelect,
  onGuideTranslateStart,
}: {
  guides: GuideNode[]
  isInteractive: boolean
  selectedGuideId: GuideNode['id'] | null
  activeGuideInteractionGuideId: GuideNode['id'] | null
  activeGuideInteractionMode: GuideInteractionMode | null
  onGuideSelect: (guideId: GuideNode['id']) => void
  onGuideTranslateStart: (guide: GuideNode, event: ReactPointerEvent<SVGRectElement>) => void
}) {
  if (!guides.length) {
    return null
  }

  const orderedGuides =
    selectedGuideId && guides.some((guide) => guide.id === selectedGuideId)
      ? [
          ...guides.filter((guide) => guide.id !== selectedGuideId),
          guides.find((guide) => guide.id === selectedGuideId)!,
        ]
      : guides

  return (
    <>
      {orderedGuides.map((guide) => (
        <FloorplanGuideImage
          activeInteractionMode={
            activeGuideInteractionGuideId === guide.id ? activeGuideInteractionMode : null
          }
          guide={guide}
          isInteractive={isInteractive}
          isSelected={selectedGuideId === guide.id}
          key={guide.id}
          onGuideSelect={onGuideSelect}
          onGuideTranslateStart={onGuideTranslateStart}
        />
      ))}
    </>
  )
})

function FloorplanGuideSelectionOverlay({
  guide,
  isDarkMode,
  rotationModifierPressed,
  showHandles,
  onCornerHoverChange,
  onCornerPointerDown,
}: {
  guide: GuideNode | null
  isDarkMode: boolean
  rotationModifierPressed: boolean
  showHandles: boolean
  onCornerHoverChange: (corner: GuideCorner | null) => void
  onCornerPointerDown: (
    guide: GuideNode,
    dimensions: GuideImageDimensions,
    corner: GuideCorner,
    event: ReactPointerEvent<SVGCircleElement>,
  ) => void
}) {
  const resolvedUrl = useResolvedAssetUrl(guide?.url ?? '')
  const dimensions = useGuideImageDimensions(resolvedUrl)

  if (!(guide && guide.opacity > 0 && guide.scale > 0 && resolvedUrl && dimensions)) {
    return null
  }

  const aspectRatio = dimensions.width / dimensions.height
  const planWidth = getGuideWidth(guide.scale)
  const planHeight = getGuideHeight(planWidth, aspectRatio)
  const centerX = toSvgX(guide.position[0])
  const centerY = toSvgY(guide.position[2])
  const rotationDeg = (-guide.rotation[1] * 180) / Math.PI
  const selectionStroke = isDarkMode ? '#ffffff' : '#09090b'
  const handleFill = isDarkMode ? '#ffffff' : '#09090b'
  const handleStroke = isDarkMode ? '#0a0e1b' : '#ffffff'

  return (
    <g transform={`translate(${centerX} ${centerY}) rotate(${rotationDeg})`}>
      <rect
        fill="none"
        height={planHeight}
        pointerEvents="none"
        stroke={selectionStroke}
        strokeDasharray="none"
        strokeLinejoin="round"
        strokeWidth={FLOORPLAN_GUIDE_SELECTION_STROKE_WIDTH}
        vectorEffect="non-scaling-stroke"
        width={planWidth}
        x={-planWidth / 2}
        y={-planHeight / 2}
      />

      {showHandles
        ? GUIDE_CORNERS.map((corner) => {
            const [x, y] = getGuideCornerLocalOffset(planWidth, planHeight, corner)

            return (
              <g key={corner}>
                <rect
                  fill={handleFill}
                  height={FLOORPLAN_GUIDE_HANDLE_SIZE}
                  pointerEvents="none"
                  rx={FLOORPLAN_GUIDE_HANDLE_SIZE * 0.22}
                  ry={FLOORPLAN_GUIDE_HANDLE_SIZE * 0.22}
                  stroke={handleStroke}
                  strokeWidth="0.04"
                  vectorEffect="non-scaling-stroke"
                  width={FLOORPLAN_GUIDE_HANDLE_SIZE}
                  x={x - FLOORPLAN_GUIDE_HANDLE_SIZE / 2}
                  y={y - FLOORPLAN_GUIDE_HANDLE_SIZE / 2}
                />
                <circle
                  cx={x}
                  cy={y}
                  fill="transparent"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onPointerDown={(event) => onCornerPointerDown(guide, dimensions, corner, event)}
                  onPointerEnter={() => onCornerHoverChange(corner)}
                  onPointerLeave={() => onCornerHoverChange(null)}
                  pointerEvents="all"
                  r={FLOORPLAN_GUIDE_HANDLE_HIT_RADIUS}
                  stroke="transparent"
                  strokeWidth={FLOORPLAN_GUIDE_HANDLE_HIT_RADIUS * 2}
                  style={{
                    cursor: rotationModifierPressed
                      ? getGuideRotateCursor(isDarkMode)
                      : getGuideResizeCursor(corner, -guide.rotation[1]),
                  }}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )
          })
        : null}
    </g>
  )
}

function FloorplanGuideHandleHint({
  anchor,
  isDarkMode,
  isMacPlatform,
  rotationModifierPressed,
}: {
  anchor: GuideHandleHintAnchor | null
  isDarkMode: boolean
  isMacPlatform: boolean
  rotationModifierPressed: boolean
}) {
  if (!anchor) {
    return null
  }

  const primaryToneClass = isDarkMode
    ? 'text-white drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.5)]'
    : 'text-[#09090b] drop-shadow-[0_1px_1.5px_rgba(255,255,255,0.8)]'

  return (
    <div
      aria-hidden="true"
      className={cn('pointer-events-none absolute z-20 select-none', primaryToneClass)}
      style={{
        left: anchor.x,
        top: anchor.y,
        transform: `translate(calc(-50% + ${anchor.directionX * 12}px), calc(-50% + ${anchor.directionY * 12}px))`,
      }}
    >
      <div className="flex flex-col gap-0.5">
        <div
          className={cn(
            'flex items-center gap-1.5 transition-opacity duration-150',
            rotationModifierPressed ? 'opacity-40' : 'opacity-100',
          )}
        >
          <span className="font-medium text-[11px] lowercase leading-none">resize</span>
          <Icon
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0"
            color="currentColor"
            icon="ph:mouse-left-click-fill"
          />
        </div>

        <div
          className={cn(
            'flex items-center gap-1.5 transition-opacity duration-150',
            rotationModifierPressed ? 'opacity-100' : 'opacity-40',
          )}
        >
          <span className="font-medium text-[11px] lowercase leading-none">rotate</span>
          {isMacPlatform ? (
            <Command aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
          ) : (
            <span className="font-mono text-[10px] uppercase leading-none">ctrl</span>
          )}
          <Icon
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0"
            color="currentColor"
            icon="ph:mouse-left-click-fill"
          />
        </div>
      </div>
    </div>
  )
}

const FloorplanGeometryLayer = memo(function FloorplanGeometryLayer({
  canSelectSlabs,
  canSelectGeometry,
  hoveredOpeningId,
  hoveredWallId,
  onSlabDoubleClick,
  onSlabSelect,
  onOpeningDoubleClick,
  onOpeningHoverChange,
  onOpeningSelect,
  onWallClick,
  onWallDoubleClick,
  onWallHoverChange,
  openingsPolygons,
  palette,
  selectedIdSet,
  slabPolygons,
  wallPolygons,
  unit,
}: {
  canSelectSlabs: boolean
  canSelectGeometry: boolean
  hoveredOpeningId: OpeningNode['id'] | null
  onSlabDoubleClick: (slab: SlabNode) => void
  onSlabSelect: (slabId: SlabNode['id'], event: ReactMouseEvent<SVGElement>) => void
  onOpeningDoubleClick: (opening: OpeningNode) => void
  onOpeningHoverChange: (openingId: OpeningNode['id'] | null) => void
  onOpeningSelect: (openingId: OpeningNode['id'], event: ReactMouseEvent<SVGElement>) => void
  hoveredWallId: WallNode['id'] | null
  onWallClick: (wall: WallNode, event: ReactMouseEvent<SVGElement>) => void
  onWallDoubleClick: (wall: WallNode, event: ReactMouseEvent<SVGElement>) => void
  onWallHoverChange: (wallId: WallNode['id'] | null) => void
  openingsPolygons: OpeningPolygonEntry[]
  palette: FloorplanPalette
  selectedIdSet: ReadonlySet<string>
  slabPolygons: SlabPolygonEntry[]
  wallPolygons: WallPolygonEntry[]
  unit: 'metric' | 'imperial'
}) {
  let minX = Number.POSITIVE_INFINITY,
    maxX = Number.NEGATIVE_INFINITY,
    minZ = Number.POSITIVE_INFINITY,
    maxZ = Number.NEGATIVE_INFINITY
  for (const { wall } of wallPolygons) {
    minX = Math.min(minX, wall.start[0], wall.end[0])
    maxX = Math.max(maxX, wall.start[0], wall.end[0])
    minZ = Math.min(minZ, wall.start[1], wall.end[1])
    maxZ = Math.max(maxZ, wall.start[1], wall.end[1])
  }
  const centerX = minX === Number.POSITIVE_INFINITY ? 0 : (minX + maxX) / 2
  const centerZ = minZ === Number.POSITIVE_INFINITY ? 0 : (minZ + maxZ) / 2
  const wallMeasurements = wallPolygons.flatMap(({ wall }) => {
    const measurement = getWallMeasurementOverlay(wall, centerX, centerZ, unit)
    if (measurement) {
      measurement.isSelected = selectedIdSet.has(wall.id)
    }
    return measurement ? [measurement] : []
  })

  return (
    <>
      {slabPolygons.map(({ slab, polygon, holes, path }) => {
        const isSelected = selectedIdSet.has(slab.id)
        let slabLabel = null

        if (isSelected) {
          const { area, centroid } = getSlabArea(polygon, holes)
          if (area > 0) {
            slabLabel = (
              <text
                dominantBaseline="central"
                fill={palette.measurementStroke}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                fontSize={getMeasureLabelFontSize()}
                fontWeight="600"
                paintOrder="stroke"
                pointerEvents="none"
                stroke={palette.surface}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={getMeasureLabelStrokeWidth()}
                style={{ userSelect: 'none' }}
                textAnchor="middle"
                x={toSvgX(centroid.x)}
                y={toSvgY(centroid.y)}
              >
                {formatArea(area, unit)}
              </text>
            )
          }
        }

        return (
          <g key={slab.id}>
            <path
              clipRule="evenodd"
              d={path}
              fill={isSelected ? palette.selectedSlabFill : palette.slabFill}
              fillRule="evenodd"
              onClick={
                canSelectSlabs
                  ? (event) => {
                      event.stopPropagation()
                      onSlabSelect(slab.id, event)
                    }
                  : undefined
              }
              onDoubleClick={
                canSelectSlabs
                  ? (event) => {
                      event.stopPropagation()
                      onSlabDoubleClick(slab)
                    }
                  : undefined
              }
              pointerEvents={canSelectSlabs ? undefined : 'none'}
              stroke={isSelected ? palette.selectedStroke : palette.slabStroke}
              strokeOpacity={isSelected ? 0.92 : 0.84}
              strokeWidth="0.05"
              style={canSelectSlabs ? { cursor: EDITOR_CURSOR } : undefined}
              vectorEffect="non-scaling-stroke"
            />
            {slabLabel}
          </g>
        )
      })}

      {wallPolygons.map(({ wall, polygon, points }) => {
        const isSelected = selectedIdSet.has(wall.id)
        const isHovered = canSelectGeometry && hoveredWallId === wall.id
        const hoverStroke = isSelected ? palette.selectedStroke : palette.wallHoverStroke
        const hoverSidePaths = getWallHoverSidePaths(polygon, wall)

        return (
          <g
            key={wall.id}
            onPointerEnter={canSelectGeometry ? () => onWallHoverChange(wall.id) : undefined}
            onPointerLeave={canSelectGeometry ? () => onWallHoverChange(null) : undefined}
          >
            {hoverSidePaths?.map((pathData, index) => (
              <path
                d={pathData}
                fill="none"
                key={`glow-${index}`}
                pointerEvents="none"
                stroke={hoverStroke}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeOpacity={isSelected ? 0.22 : 0.16}
                strokeWidth={FLOORPLAN_WALL_HOVER_GLOW_STROKE_WIDTH}
                style={{
                  opacity: isHovered ? 1 : 0,
                  transition: FLOORPLAN_HOVER_TRANSITION,
                }}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hoverSidePaths?.map((pathData, index) => (
              <path
                d={pathData}
                fill="none"
                key={`ring-${index}`}
                pointerEvents="none"
                stroke={hoverStroke}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeOpacity={isSelected ? 0.6 : 0.48}
                strokeWidth={FLOORPLAN_WALL_HOVER_RING_STROKE_WIDTH}
                style={{
                  opacity: isHovered ? 1 : 0,
                  transition: FLOORPLAN_HOVER_TRANSITION,
                }}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {canSelectGeometry && (
              <line
                onClick={(event) => {
                  event.stopPropagation()
                  onWallClick(wall, event)
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  onWallDoubleClick(wall, event)
                }}
                pointerEvents="stroke"
                stroke="transparent"
                strokeLinecap="round"
                strokeWidth={FLOORPLAN_WALL_HIT_STROKE_WIDTH}
                style={{ cursor: EDITOR_CURSOR }}
                vectorEffect="non-scaling-stroke"
                x1={toSvgX(wall.start[0])}
                x2={toSvgX(wall.end[0])}
                y1={toSvgY(wall.start[1])}
                y2={toSvgY(wall.end[1])}
              />
            )}
            <polygon
              data-element="wall"
              fill={isSelected ? palette.selectedFill : palette.wallFill}
              onClick={
                canSelectGeometry
                  ? (event) => {
                      event.stopPropagation()
                      onWallClick(wall, event)
                    }
                  : undefined
              }
              onDoubleClick={
                canSelectGeometry
                  ? (event) => {
                      event.stopPropagation()
                      onWallDoubleClick(wall, event)
                    }
                  : undefined
              }
              points={points}
              stroke={isSelected ? 'none' : palette.wallStroke}
              strokeOpacity={1}
              strokeWidth="0.06"
              style={{ cursor: EDITOR_CURSOR }}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )
      })}

      {openingsPolygons.map(({ opening, polygon, points }) => {
        const isSelected = selectedIdSet.has(opening.id)
        const isHovered = canSelectGeometry && hoveredOpeningId === opening.id
        const isHighlighted = isHovered || isSelected
        const highlightStroke = isSelected ? palette.selectedStroke : palette.wallHoverStroke
        const detailStroke = isSelected ? palette.surface : palette.openingStroke
        const centerLine = getOpeningCenterLine(polygon)

        if (opening.type === 'window') {
          if (polygon.length < 4) return null
          if (!centerLine) return null
          const windowLineStartX = toSvgX(centerLine.start.x)
          const windowLineStartY = toSvgY(centerLine.start.y)
          const windowLineEndX = toSvgX(centerLine.end.x)
          const windowLineEndY = toSvgY(centerLine.end.y)

          return (
            <g
              key={opening.id}
              onClick={
                canSelectGeometry
                  ? (event) => {
                      event.stopPropagation()
                      onOpeningSelect(opening.id, event)
                    }
                  : undefined
              }
              onDoubleClick={
                canSelectGeometry
                  ? (event) => {
                      event.stopPropagation()
                      onOpeningDoubleClick(opening)
                    }
                  : undefined
              }
              onPointerEnter={
                canSelectGeometry
                  ? () => {
                      onWallHoverChange(null)
                      onOpeningHoverChange(opening.id)
                    }
                  : undefined
              }
              onPointerLeave={canSelectGeometry ? () => onOpeningHoverChange(null) : undefined}
              style={{ cursor: EDITOR_CURSOR }}
            >
              {canSelectGeometry && (
                <line
                  pointerEvents="stroke"
                  stroke="transparent"
                  strokeLinecap="round"
                  strokeWidth={FLOORPLAN_OPENING_HIT_STROKE_WIDTH}
                  vectorEffect="non-scaling-stroke"
                  x1={windowLineStartX}
                  x2={windowLineEndX}
                  y1={windowLineStartY}
                  y2={windowLineEndY}
                />
              )}
              <polygon
                fill="none"
                pointerEvents="none"
                points={points}
                stroke={highlightStroke}
                strokeLinejoin="round"
                strokeOpacity={isSelected ? 0.22 : 0.16}
                strokeWidth={FLOORPLAN_WALL_HOVER_GLOW_STROKE_WIDTH}
                style={{
                  opacity: isHighlighted ? 1 : 0,
                  transition: FLOORPLAN_HOVER_TRANSITION,
                }}
                vectorEffect="non-scaling-stroke"
              />
              <polygon
                fill="none"
                pointerEvents="none"
                points={points}
                stroke={highlightStroke}
                strokeLinejoin="round"
                strokeOpacity={isSelected ? 0.6 : 0.48}
                strokeWidth={FLOORPLAN_WALL_HOVER_RING_STROKE_WIDTH}
                style={{
                  opacity: isHighlighted ? 1 : 0,
                  transition: FLOORPLAN_HOVER_TRANSITION,
                }}
                vectorEffect="non-scaling-stroke"
              />
              <polygon
                data-element="window"
                fill={palette.windowFill}
                points={points}
                stroke={isSelected ? palette.selectedStroke : palette.windowStroke}
                strokeOpacity={1}
                strokeWidth={FLOORPLAN_OPENING_STROKE_WIDTH}
              />
              <line
                stroke={isSelected ? palette.selectedStroke : palette.windowStroke}
                strokeWidth={FLOORPLAN_OPENING_DETAIL_STROKE_WIDTH}
                x1={windowLineStartX}
                x2={windowLineEndX}
                y1={windowLineStartY}
                y2={windowLineEndY}
              />
            </g>
          )
        }

        if (opening.type === 'door') {
          if (polygon.length < 4) return null
          if (!centerLine) return null
          const [p1, p2, p3, p4] = polygon
          const svgP1 = toSvgPoint(p1!)
          const svgP2 = toSvgPoint(p2!)
          const svgP3 = toSvgPoint(p3!)
          const svgP4 = toSvgPoint(p4!)
          const cx = (svgP1.x + svgP2.x + svgP3.x + svgP4.x) / 4
          const cy = (svgP1.y + svgP2.y + svgP3.y + svgP4.y) / 4

          const dirX = svgP2.x - svgP1.x
          const dirY = svgP2.y - svgP1.y
          const len = Math.sqrt(dirX * dirX + dirY * dirY)
          const nx = dirX / len
          const ny = dirY / len

          const px = -ny
          const py = nx

          const hingesSide = opening.hingesSide ?? 'left'
          const swingDirection = opening.swingDirection ?? 'inward'
          const width = opening.width
          const sweepFlag =
            hingesSide === 'left'
              ? swingDirection === 'inward'
                ? 0
                : 1
              : swingDirection === 'inward'
                ? 1
                : 0

          const hx = cx - nx * (width / 2) * (hingesSide === 'left' ? 1 : -1)
          const hy = cy - ny * (width / 2) * (hingesSide === 'left' ? 1 : -1)

          const ox = hx + px * width * (swingDirection === 'inward' ? 1 : -1)
          const oy = hy + py * width * (swingDirection === 'inward' ? 1 : -1)

          const ox2 = cx + nx * (width / 2) * (hingesSide === 'left' ? 1 : -1)
          const oy2 = cy + ny * (width / 2) * (hingesSide === 'left' ? 1 : -1)

          return (
            <g
              key={opening.id}
              onClick={
                canSelectGeometry
                  ? (event) => {
                      event.stopPropagation()
                      onOpeningSelect(opening.id, event)
                    }
                  : undefined
              }
              onDoubleClick={
                canSelectGeometry
                  ? (event) => {
                      event.stopPropagation()
                      onOpeningDoubleClick(opening)
                    }
                  : undefined
              }
              onPointerEnter={
                canSelectGeometry
                  ? () => {
                      onWallHoverChange(null)
                      onOpeningHoverChange(opening.id)
                    }
                  : undefined
              }
              onPointerLeave={canSelectGeometry ? () => onOpeningHoverChange(null) : undefined}
              style={{ cursor: EDITOR_CURSOR }}
            >
              {canSelectGeometry && (
                <line
                  pointerEvents="stroke"
                  stroke="transparent"
                  strokeLinecap="round"
                  strokeWidth={FLOORPLAN_OPENING_HIT_STROKE_WIDTH}
                  vectorEffect="non-scaling-stroke"
                  x1={toSvgX(centerLine.start.x)}
                  x2={toSvgX(centerLine.end.x)}
                  y1={toSvgY(centerLine.start.y)}
                  y2={toSvgY(centerLine.end.y)}
                />
              )}
              <polygon
                fill="none"
                pointerEvents="none"
                points={points}
                stroke={highlightStroke}
                strokeLinejoin="round"
                strokeOpacity={isSelected ? 0.22 : 0.16}
                strokeWidth={FLOORPLAN_WALL_HOVER_GLOW_STROKE_WIDTH}
                style={{
                  opacity: isHighlighted ? 1 : 0,
                  transition: FLOORPLAN_HOVER_TRANSITION,
                }}
                vectorEffect="non-scaling-stroke"
              />
              <polygon
                fill="none"
                pointerEvents="none"
                points={points}
                stroke={highlightStroke}
                strokeLinejoin="round"
                strokeOpacity={isSelected ? 0.6 : 0.48}
                strokeWidth={FLOORPLAN_WALL_HOVER_RING_STROKE_WIDTH}
                style={{
                  opacity: isHighlighted ? 1 : 0,
                  transition: FLOORPLAN_HOVER_TRANSITION,
                }}
                vectorEffect="non-scaling-stroke"
              />
              <polygon
                data-element="door"
                fill={palette.doorFill}
                points={points}
                stroke={isSelected ? palette.selectedStroke : palette.doorStroke}
                strokeOpacity={1}
                strokeWidth={FLOORPLAN_OPENING_STROKE_WIDTH}
              />
              <line
                stroke={isSelected ? palette.selectedStroke : palette.doorStroke}
                strokeWidth={FLOORPLAN_OPENING_DETAIL_STROKE_WIDTH}
                x1={hx}
                x2={ox}
                y1={hy}
                y2={oy}
              />
              <path
                d={`M ${ox} ${oy} A ${width} ${width} 0 0 ${sweepFlag} ${ox2} ${oy2}`}
                fill="none"
                stroke={isSelected ? palette.selectedStroke : palette.doorStroke}
                strokeDasharray="0.1 0.1"
                strokeWidth={FLOORPLAN_OPENING_DASHED_STROKE_WIDTH}
              />
            </g>
          )
        }

        return null
      })}

      {wallMeasurements.map((measurement) => (
        <g
          className="wall-dimension"
          key={`measurement-${measurement.wallId}`}
          pointerEvents="none"
          style={{ userSelect: 'none' }}
        >
          <FloorplanMeasurementLine
            isSelected={measurement.isSelected}
            palette={palette}
            segment={measurement.extensionStart}
          />
          <FloorplanMeasurementLine
            isSelected={measurement.isSelected}
            palette={palette}
            segment={measurement.dimensionLineStart}
          />
          <FloorplanMeasurementLine
            isSelected={measurement.isSelected}
            palette={palette}
            segment={measurement.dimensionLineEnd}
          />
          <FloorplanMeasurementLine
            isSelected={measurement.isSelected}
            palette={palette}
            segment={measurement.extensionEnd}
          />
          <text
            dominantBaseline="central"
            fill={palette.measurementStroke}
            fillOpacity={
              measurement.isSelected
                ? FLOORPLAN_MEASUREMENT_LABEL_OPACITY
                : FLOORPLAN_MEASUREMENT_LABEL_OPACITY * 0.4
            }
            fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
            fontSize={getMeasureLabelFontSize()}
            fontWeight="600"
            paintOrder="stroke"
            stroke={palette.surface}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity={measurement.isSelected ? 1 : 0.4}
            strokeWidth={getMeasureLabelStrokeWidth()}
            textAnchor="middle"
            transform={`rotate(${measurement.labelAngleDeg} ${measurement.labelX} ${measurement.labelY}) translate(0, -0.04)`}
            x={measurement.labelX}
            y={measurement.labelY}
          >
            {measurement.label}
          </text>
        </g>
      ))}
    </>
  )
})

const FloorplanSiteLayer = memo(function FloorplanSiteLayer({
  isEditing,
  sitePolygon,
  unit,
  showDimensions = true,
}: {
  isEditing: boolean
  sitePolygon: SitePolygonEntry | null
  unit: 'metric' | 'imperial'
  showDimensions?: boolean
}) {
  if (!sitePolygon) {
    return null
  }

  const polygon = sitePolygon.polygon
  const { area, centroid } = getPolygonAreaAndCentroid(polygon)

  // Compute edge midpoints, lengths, and label offsets
  const edges = polygon.map((p1, i) => {
    const p2 = polygon[(i + 1) % polygon.length]!
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const length = Math.sqrt(dx * dx + dy * dy)
    const midX = (p1.x + p2.x) / 2
    const midY = (p1.y + p2.y) / 2
    // Offset label outward from polygon center
    const nx = -(p2.y - p1.y) / length
    const ny = (p2.x - p1.x) / length
    // Push label away from centroid
    const toCenterX = centroid.x - midX
    const toCenterY = centroid.y - midY
    const dot = nx * toCenterX + ny * toCenterY
    const sign = dot > 0 ? -1 : 1
    const offset = Math.max(0.35, Math.sqrt(area) * 0.05)
    return {
      length,
      labelX: toSvgX(midX + nx * offset * sign),
      labelY: toSvgY(midY + ny * offset * sign),
      label: formatMeasurement(length, unit),
    }
  })

  // Scale font size based on site size — larger sites get bigger labels
  const siteSpan = Math.sqrt(area)
  const edgeFontSize = Math.max(0.2, Math.min(1.2, siteSpan * 0.04))
  const areaFontSize = edgeFontSize * 1.4
  const labelOffset = Math.max(0.35, siteSpan * 0.05)

  return (
    <>
      <polygon
        fill={FLOORPLAN_SITE_COLOR}
        fillOpacity={isEditing ? 0.12 : 0.08}
        pointerEvents="none"
        points={sitePolygon.points}
        stroke={FLOORPLAN_SITE_COLOR}
        strokeDasharray={isEditing ? '0.16 0.1' : undefined}
        strokeLinejoin="round"
        strokeOpacity={isEditing ? 0.92 : 0.72}
        strokeWidth={isEditing ? '0.08' : '0.06'}
        vectorEffect="non-scaling-stroke"
      />

      {/* Edge dimensions — only in site edit mode */}
      {showDimensions && edges.map((edge, i) => (
        <text
          key={`site-edge-${i}`}
          dominantBaseline="central"
          fill={FLOORPLAN_SITE_COLOR}
          fillOpacity={0.9}
          fontSize={edgeFontSize}
          fontWeight="700"
          pointerEvents="none"
          textAnchor="middle"
          x={edge.labelX}
          y={edge.labelY}
        >
          {edge.label}
        </text>
      ))}

      {/* Total area at centroid — only in site edit mode */}
      {showDimensions && <text
        dominantBaseline="central"
        fill={FLOORPLAN_SITE_COLOR}
        fillOpacity={0.75}
        fontSize={areaFontSize}
        fontWeight="800"
        pointerEvents="none"
        textAnchor="middle"
        x={toSvgX(centroid.x)}
        y={toSvgY(centroid.y)}
      >
        {formatArea(area, unit)}
      </text>}
    </>
  )
})

const FloorplanZoneLayer = memo(function FloorplanZoneLayer({
  canSelectZones,
  onZoneSelect,
  palette,
  selectedZoneId,
  zonePolygons,
  unit,
}: {
  canSelectZones: boolean
  onZoneSelect: (zoneId: ZoneNodeType['id'], event: ReactMouseEvent<SVGElement>) => void
  palette: FloorplanPalette
  selectedZoneId: ZoneNodeType['id'] | null
  zonePolygons: ZonePolygonEntry[]
  unit: 'metric' | 'imperial'
}) {
  return (
    <>
      {zonePolygons.map(({ zone, polygon, points }) => {
        const isSelected = selectedZoneId === zone.id
        const { area, centroid } = getPolygonAreaAndCentroid(polygon)
        const label = zone.name || 'Room'
        const labelFontSize = Math.max(0.15, Math.min(0.4, Math.sqrt(area) * 0.08))

        return (
          <g key={zone.id}>
            <polygon
              fill="none"
              pointerEvents="none"
              points={points}
              stroke={isSelected ? palette.selectedStroke : zone.color}
              strokeLinejoin="round"
              strokeOpacity={isSelected ? 0.7 : 0}
              strokeWidth={isSelected ? '0.06' : '0'}
              vectorEffect="non-scaling-stroke"
            />

            {/* Room label */}
            {area > 0.1 && (
              <>
                <text
                  dominantBaseline="central"
                  fill={zone.color}
                  fillOpacity={0.9}
                  fontSize={labelFontSize}
                  fontWeight="700"
                  pointerEvents="none"
                  textAnchor="middle"
                  x={toSvgX(centroid.x)}
                  y={toSvgY(centroid.y) - labelFontSize * 0.7}
                >
                  {label}
                </text>
                <text
                  dominantBaseline="central"
                  fill={zone.color}
                  fillOpacity={0.6}
                  fontSize={labelFontSize * 0.75}
                  fontWeight="500"
                  pointerEvents="none"
                  textAnchor="middle"
                  x={toSvgX(centroid.x)}
                  y={toSvgY(centroid.y) + labelFontSize * 0.5}
                >
                  {formatArea(area, unit)}
                </text>
              </>
            )}

            {canSelectZones && (
              <polygon
                fill="none"
                onClick={(event) => {
                  event.stopPropagation()
                  onZoneSelect(zone.id, event)
                }}
                pointerEvents="stroke"
                points={points}
                stroke="transparent"
                strokeLinejoin="round"
                strokeWidth={FLOORPLAN_WALL_HIT_STROKE_WIDTH}
                style={{ cursor: EDITOR_CURSOR }}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>
        )
      })}
    </>
  )
})

const FloorplanWallEndpointLayer = memo(function FloorplanWallEndpointLayer({
  endpointHandles,
  hoveredEndpointId,
  onWallEndpointPointerDown,
  onEndpointHoverChange,
  palette,
}: {
  endpointHandles: Array<{
    wall: WallNode
    endpoint: WallEndpoint
    point: WallPlanPoint
    isSelected: boolean
    isActive: boolean
  }>
  onWallEndpointPointerDown: (
    wall: WallNode,
    endpoint: WallEndpoint,
    event: ReactPointerEvent<SVGCircleElement>,
  ) => void
  hoveredEndpointId: string | null
  onEndpointHoverChange: (endpointId: string | null) => void
  palette: FloorplanPalette
}) {
  return (
    <>
      {endpointHandles.map(({ wall, endpoint, point, isSelected, isActive }) => {
        const endpointId = `${wall.id}:${endpoint}`
        const isHovered = hoveredEndpointId === endpointId
        const stroke =
          isSelected || isActive ? palette.endpointHandleActiveStroke : palette.endpointHandleStroke
        const hoverStroke =
          isSelected || isActive
            ? palette.endpointHandleActiveStroke
            : palette.endpointHandleHoverStroke
        const outerRadius = isActive ? 0.18 : isSelected ? 0.16 : 0.14
        const svgPoint = toSvgPlanPoint(point)

        return (
          <g
            key={endpointId}
            onClick={(event) => {
              event.stopPropagation()
            }}
            onPointerEnter={() => onEndpointHoverChange(endpointId)}
            onPointerLeave={() => onEndpointHoverChange(null)}
          >
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill="none"
              pointerEvents="none"
              r={outerRadius}
              stroke={hoverStroke}
              strokeOpacity={isActive ? 0.24 : 0.16}
              strokeWidth={FLOORPLAN_ENDPOINT_HOVER_GLOW_STROKE_WIDTH}
              style={{
                opacity: isHovered ? 1 : 0,
                transition: FLOORPLAN_HOVER_TRANSITION,
              }}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill="none"
              pointerEvents="none"
              r={outerRadius}
              stroke={hoverStroke}
              strokeOpacity={isActive ? 0.72 : 0.52}
              strokeWidth={FLOORPLAN_ENDPOINT_HOVER_RING_STROKE_WIDTH}
              style={{
                opacity: isHovered ? 1 : 0,
                transition: FLOORPLAN_HOVER_TRANSITION,
              }}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill={isActive ? palette.endpointHandleActiveFill : palette.endpointHandleFill}
              fillOpacity={0.96}
              pointerEvents="none"
              r={outerRadius}
              stroke={stroke}
              strokeWidth="0.05"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill={stroke}
              pointerEvents="none"
              r={isActive ? 0.08 : 0.06}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill="transparent"
              onPointerDown={(event) => onWallEndpointPointerDown(wall, endpoint, event)}
              pointerEvents="all"
              r={outerRadius}
              stroke="transparent"
              strokeWidth={FLOORPLAN_ENDPOINT_HIT_STROKE_WIDTH}
              style={{ cursor: EDITOR_CURSOR }}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )
      })}
    </>
  )
})

const FloorplanPolygonHandleLayer = memo(function FloorplanPolygonHandleLayer({
  hoveredHandleId,
  midpointHandles,
  onHandleHoverChange,
  onMidpointPointerDown,
  onVertexDoubleClick,
  onVertexPointerDown,
  palette,
  vertexHandles,
}: {
  vertexHandles: Array<{
    nodeId: string
    vertexIndex: number
    point: WallPlanPoint
    isActive: boolean
  }>
  midpointHandles: Array<{
    nodeId: string
    edgeIndex: number
    point: WallPlanPoint
  }>
  hoveredHandleId: string | null
  onHandleHoverChange: (handleId: string | null) => void
  onVertexPointerDown: (
    nodeId: string,
    vertexIndex: number,
    event: ReactPointerEvent<SVGCircleElement>,
  ) => void
  onVertexDoubleClick: (
    nodeId: string,
    vertexIndex: number,
    event: ReactPointerEvent<SVGCircleElement>,
  ) => void
  onMidpointPointerDown: (
    nodeId: string,
    edgeIndex: number,
    event: ReactPointerEvent<SVGCircleElement>,
  ) => void
  palette: FloorplanPalette
}) {
  return (
    <>
      {vertexHandles.map(({ nodeId, vertexIndex, point, isActive }) => {
        const handleId = `${nodeId}:vertex:${vertexIndex}`
        const isHovered = hoveredHandleId === handleId
        const stroke = isActive ? palette.endpointHandleActiveStroke : palette.endpointHandleStroke
        const outerRadius = isActive ? 0.15 : 0.13
        const svgPoint = toSvgPlanPoint(point)

        return (
          <g
            key={handleId}
            onClick={(event) => {
              event.stopPropagation()
            }}
            onPointerEnter={() => onHandleHoverChange(handleId)}
            onPointerLeave={() => onHandleHoverChange(null)}
          >
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill="none"
              pointerEvents="none"
              r={outerRadius}
              stroke={stroke}
              strokeOpacity={0.18}
              strokeWidth={FLOORPLAN_ENDPOINT_HOVER_GLOW_STROKE_WIDTH}
              style={{
                opacity: isHovered ? 1 : 0,
                transition: FLOORPLAN_HOVER_TRANSITION,
              }}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill={isActive ? palette.endpointHandleActiveFill : palette.endpointHandleFill}
              fillOpacity={0.96}
              pointerEvents="none"
              r={outerRadius}
              stroke={stroke}
              strokeWidth="0.045"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill={stroke}
              pointerEvents="none"
              r={isActive ? 0.058 : 0.05}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill="transparent"
              onDoubleClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onVertexDoubleClick(nodeId, vertexIndex, event as any)
              }}
              onPointerDown={(event) => {
                onVertexPointerDown(nodeId, vertexIndex, event)
              }}
              pointerEvents="all"
              r={outerRadius}
              stroke="transparent"
              strokeWidth={FLOORPLAN_ENDPOINT_HIT_STROKE_WIDTH}
              style={{ cursor: EDITOR_CURSOR }}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )
      })}

      {midpointHandles.map(({ nodeId, edgeIndex, point }) => {
        const handleId = `${nodeId}:midpoint:${edgeIndex}`
        const isHovered = hoveredHandleId === handleId
        const stroke = isHovered ? palette.endpointHandleHoverStroke : palette.endpointHandleStroke
        const radius = isHovered ? 0.092 : 0.08
        const svgPoint = toSvgPlanPoint(point)

        return (
          <g
            key={handleId}
            onClick={(event) => {
              event.stopPropagation()
            }}
            onPointerEnter={() => onHandleHoverChange(handleId)}
            onPointerLeave={() => onHandleHoverChange(null)}
          >
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill="none"
              pointerEvents="none"
              r={radius + 0.03}
              stroke={stroke}
              strokeOpacity={0.16}
              strokeWidth={FLOORPLAN_ENDPOINT_HOVER_RING_STROKE_WIDTH}
              style={{
                opacity: isHovered ? 1 : 0,
                transition: FLOORPLAN_HOVER_TRANSITION,
              }}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill={palette.surface}
              fillOpacity={0.94}
              pointerEvents="none"
              r={radius}
              stroke={stroke}
              strokeOpacity={0.9}
              strokeWidth="0.035"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill={stroke}
              fillOpacity={0.82}
              pointerEvents="none"
              r="0.028"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={svgPoint.x}
              cy={svgPoint.y}
              fill="transparent"
              onPointerDown={(event) => onMidpointPointerDown(nodeId, edgeIndex, event)}
              pointerEvents="all"
              r={radius}
              stroke="transparent"
              strokeWidth={FLOORPLAN_ENDPOINT_HIT_STROKE_WIDTH}
              style={{ cursor: EDITOR_CURSOR }}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )
      })}
    </>
  )
})

export function FloorplanPanel() {
  const viewportHostRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const panStateRef = useRef<PanState | null>(null)
  const guideInteractionRef = useRef<GuideInteractionState | null>(null)
  const guideTransformDraftRef = useRef<GuideTransformDraft | null>(null)
  const wallEndpointDragRef = useRef<WallEndpointDragState | null>(null)
  // Bulge handle drag — parallel to endpoint drag (see WallBulgeDragState).
  const wallBulgeDragRef = useRef<WallBulgeDragState | null>(null)
  // Item move/rotate drag — stored as a ref since intra-drag updates don't
  // require React re-renders (we mutate the node directly each pointer-move
  // event and the scene store re-renders the affected SVG element).
  const itemMoveDragRef = useRef<{
    pointerId: number
    itemId: string
    startPlan: [number, number]
    initialPos: [number, number, number]
  } | null>(null)
  const itemRotateDragRef = useRef<{
    pointerId: number
    itemId: string
    centerPlan: [number, number]
    initialRotY: number
    startAngleFromCenter: number
  } | null>(null)
  const siteBoundaryDraftRef = useRef<SiteBoundaryDraft | null>(null)
  const slabBoundaryDraftRef = useRef<SlabBoundaryDraft | null>(null)
  const zoneBoundaryDraftRef = useRef<ZoneBoundaryDraft | null>(null)
  const gestureScaleRef = useRef(1)
  const panelInteractionRef = useRef<PanelInteractionState | null>(null)
  const panelBoundsRef = useRef<ViewportBounds | null>(null)
  const hasUserAdjustedViewportRef = useRef(false)
  const previousLevelIdRef = useRef<string | null>(null)
  const levelMenuCloseTimeoutRef = useRef<number | null>(null)
  const levelId = useViewer((state) => state.selection.levelId)
  const buildingId = useViewer((state) => state.selection.buildingId)
  const selectedZoneId = useViewer((state) => state.selection.zoneId)
  const selectedIds = useViewer((state) => state.selection.selectedIds)
  const setSelection = useViewer((state) => state.setSelection)
  const theme = useViewer((state) => state.theme)
  const unit = useViewer((state) => state.unit)
  const showGrid = useViewer((state) => state.showGrid)
  const showGuides = useViewer((state) => state.showGuides)
  const setShowGuides = useViewer((state) => state.setShowGuides)
  const catalogCategory = useEditor((state) => state.catalogCategory)
  const setCatalogCategory = useEditor((state) => state.setCatalogCategory)
  const setFloorplanOpen = useEditor((state) => state.setFloorplanOpen)
  const isFloorplanHovered = useEditor((state) => state.isFloorplanHovered)
  const setFloorplanHovered = useEditor((state) => state.setFloorplanHovered)
  const selectedReferenceId = useEditor((state) => state.selectedReferenceId)
  const setSelectedReferenceId = useEditor((state) => state.setSelectedReferenceId)
  const setMode = useEditor((state) => state.setMode)
  const movingNode = useEditor((state) => state.movingNode)
  const phase = useEditor((state) => state.phase)
  const mode = useEditor((state) => state.mode)
  const setPhase = useEditor((state) => state.setPhase)
  const setMovingNode = useEditor((state) => state.setMovingNode)
  const structureLayer = useEditor((state) => state.structureLayer)
  const setStructureLayer = useEditor((state) => state.setStructureLayer)
  const setTool = useEditor((state) => state.setTool)
  const tool = useEditor((state) => state.tool)
  const deleteNode = useScene((state) => state.deleteNode)
  const updateNode = useScene((state) => state.updateNode)
  const levelNode = useScene((state) =>
    levelId ? (state.nodes[levelId] as LevelNode | undefined) : undefined,
  )
  const currentBuildingId =
    levelNode?.type === 'level' && levelNode.parentId
      ? (levelNode.parentId as BuildingNode['id'])
      : (buildingId as BuildingNode['id'] | null)
  const site = useScene((state) => {
    for (const rootNodeId of state.rootNodeIds) {
      const node = state.nodes[rootNodeId]
      if (node?.type === 'site') {
        return node as SiteNode
      }
    }

    return null
  })
  const floorplanLevels = useScene(
    useShallow((state) => {
      if (!currentBuildingId) {
        return [] as LevelNode[]
      }

      const buildingNode = state.nodes[currentBuildingId]
      if (!buildingNode || buildingNode.type !== 'building') {
        return [] as LevelNode[]
      }

      return buildingNode.children
        .map((childId) => state.nodes[childId])
        .filter((node): node is LevelNode => node?.type === 'level')
        .sort((a, b) => a.level - b.level)
    }),
  )
  const walls = useScene(
    useShallow((state) => {
      if (!levelId) {
        return [] as WallNode[]
      }

      const nextLevelNode = state.nodes[levelId]
      if (!nextLevelNode || nextLevelNode.type !== 'level') {
        return [] as WallNode[]
      }

      return nextLevelNode.children
        .map((childId) => state.nodes[childId])
        .filter((node): node is WallNode => node?.type === 'wall' && node.visible !== false)
    }),
  )
  const openings = useScene(
    useShallow((state) => {
      if (!levelId) {
        return [] as OpeningNode[]
      }

      const nextLevelNode = state.nodes[levelId]
      if (!nextLevelNode || nextLevelNode.type !== 'level') {
        return [] as OpeningNode[]
      }

      const nextWalls = nextLevelNode.children
        .map((childId) => state.nodes[childId])
        .filter((node): node is WallNode => node?.type === 'wall')

      return nextWalls.flatMap((wall) =>
        wall.children
          .map((childId) => state.nodes[childId])
          .filter((node): node is OpeningNode => (node?.type === 'window' || node?.type === 'door') && node.visible !== false),
      )
    }),
  )
  // Ritn3D: items (furniture / symbols) on the active level. Floor-plan
  // panel renders these as a flat top-down image with rotation; Pascal's
  // 3D ItemRenderer is dead code for us (no live R3F canvas), so this is
  // the ONLY surface where dropped symbols become visible.
  const levelItems = useScene(
    useShallow((state) => {
      if (!levelId) return [] as ItemNode[]
      const lvl = state.nodes[levelId]
      if (!lvl || lvl.type !== 'level') return [] as ItemNode[]
      return lvl.children
        .map((childId) => state.nodes[childId])
        .filter((n): n is ItemNode => n?.type === 'item' && n.visible !== false)
    }),
  )

  // Ritn3D: ghost walls from the level below for multi-floor alignment
  const ghostWalls = useScene(
    useShallow((state) => {
      if (!levelId || !currentBuildingId) return [] as WallNode[]

      const building = state.nodes[currentBuildingId]
      if (!building || building.type !== 'building') return [] as WallNode[]

      const currentLevel = state.nodes[levelId]
      if (!currentLevel || currentLevel.type !== 'level') return [] as WallNode[]
      const currentLevelNum = currentLevel.level ?? 0
      if (currentLevelNum === 0) return [] as WallNode[] // Ground floor has no floor below

      // Find the level below
      const levelBelow = building.children
        .map((childId) => state.nodes[childId])
        .find((node): node is LevelNode => node?.type === 'level' && (node.level ?? 0) === currentLevelNum - 1)

      if (!levelBelow) return [] as WallNode[]

      return levelBelow.children
        .map((childId) => state.nodes[childId])
        .filter((node): node is WallNode => node?.type === 'wall' && node.visible !== false)
    }),
  )

  const slabs = useScene(
    useShallow((state) => {
      if (!levelId) {
        return [] as SlabNode[]
      }

      const nextLevelNode = state.nodes[levelId]
      if (!nextLevelNode || nextLevelNode.type !== 'level') {
        return [] as SlabNode[]
      }

      return nextLevelNode.children
        .map((childId) => state.nodes[childId])
        .filter((node): node is SlabNode => node?.type === 'slab')
    }),
  )
  const levelGuides = useScene(
    useShallow((state) => {
      if (!levelId) {
        return [] as GuideNode[]
      }

      const nextLevelNode = state.nodes[levelId]
      if (!nextLevelNode || nextLevelNode.type !== 'level') {
        return [] as GuideNode[]
      }

      return nextLevelNode.children
        .map((childId) => state.nodes[childId])
        .filter((node): node is GuideNode => node?.type === 'guide')
    }),
  )
  const zones = useScene(
    useShallow((state) => {
      if (!levelId) {
        return [] as ZoneNodeType[]
      }

      const nextLevelNode = state.nodes[levelId]
      if (!nextLevelNode || nextLevelNode.type !== 'level') {
        return [] as ZoneNodeType[]
      }

      return nextLevelNode.children
        .map((childId) => state.nodes[childId])
        .filter((node): node is ZoneNodeType => node?.type === 'zone')
    }),
  )

  // Trace-plan scale calibration. Two-point reference method (standard CAD
  // pattern used by AutoCAD/Bluebeam/Acrobat): user clicks two points on the
  // uploaded plan with a known real-world distance, types the distance, and
  // we adjust guide.scale so plan units match reality. Without this an
  // imported floor plan has arbitrary scale (default 5) and walls measure
  // garbage like 150 m.
  const [calibratingGuideId, setCalibratingGuideId] = useState<string | null>(null)
  const [calibrationP1, setCalibrationP1] = useState<WallPlanPoint | null>(null)
  const [calibrationP2, setCalibrationP2] = useState<WallPlanPoint | null>(null)
  const [calibrationInput, setCalibrationInput] = useState('')
  const [calibrationUnit, setCalibrationUnit] = useState<'m' | 'ft'>('m')
  const [draftStart, setDraftStart] = useState<WallPlanPoint | null>(null)
  const [draftEnd, setDraftEnd] = useState<WallPlanPoint | null>(null)
  // Arc-wall draft state. Three-step machine:
  //   arcDraftStart=null                         -> phase 0: nothing placed yet
  //   arcDraftStart set, arcDraftEnd=null        -> phase 1: end-point preview
  //   arcDraftStart+End set, arcBulgePoint live  -> phase 2: bulge-midpoint preview
  // Next click in phase 2 commits the arc.
  const [arcDraftStart, setArcDraftStart] = useState<WallPlanPoint | null>(null)
  const [arcDraftEnd, setArcDraftEnd] = useState<WallPlanPoint | null>(null)
  const [arcBulgePoint, setArcBulgePoint] = useState<WallPlanPoint | null>(null)
  const [slabDraftPoints, setSlabDraftPoints] = useState<WallPlanPoint[]>([])
  const [zoneDraftPoints, setZoneDraftPoints] = useState<WallPlanPoint[]>([])
  const [siteBoundaryDraft, setSiteBoundaryDraft] = useState<SiteBoundaryDraft | null>(null)
  const [siteVertexDragState, setSiteVertexDragState] = useState<SiteVertexDragState | null>(null)
  const [slabBoundaryDraft, setSlabBoundaryDraft] = useState<SlabBoundaryDraft | null>(null)
  const [slabVertexDragState, setSlabVertexDragState] = useState<SlabVertexDragState | null>(null)
  const [zoneBoundaryDraft, setZoneBoundaryDraft] = useState<ZoneBoundaryDraft | null>(null)
  const [zoneVertexDragState, setZoneVertexDragState] = useState<ZoneVertexDragState | null>(null)
  const [guideTransformDraft, setGuideTransformDraft] = useState<GuideTransformDraft | null>(null)
  const [cursorPoint, setCursorPoint] = useState<WallPlanPoint | null>(null)
  const [floorplanCursorPosition, setFloorplanCursorPosition] = useState<SvgPoint | null>(null)
  const [wallEndpointDraft, setWallEndpointDraft] = useState<WallEndpointDraft | null>(null)
  const [wallBulgeDraft, setWallBulgeDraft] = useState<WallBulgeDraft | null>(null)
  const [hoveredOpeningId, setHoveredOpeningId] = useState<OpeningNode['id'] | null>(null)
  const [hoveredWallId, setHoveredWallId] = useState<WallNode['id'] | null>(null)
  const [hoveredEndpointId, setHoveredEndpointId] = useState<string | null>(null)
  const [hoveredSiteHandleId, setHoveredSiteHandleId] = useState<string | null>(null)
  const [hoveredSlabHandleId, setHoveredSlabHandleId] = useState<string | null>(null)
  const [hoveredZoneHandleId, setHoveredZoneHandleId] = useState<string | null>(null)
  const [hoveredGuideCorner, setHoveredGuideCorner] = useState<GuideCorner | null>(null)
  const [floorplanSelectionTool, setFloorplanSelectionTool] =
    useState<FloorplanSelectionTool>('click')

  // Ritn3D: listen for marquee toggle from sidebar + broadcast state back
  useEffect(() => {
    const handler = () => {
      setFloorplanSelectionTool((prev) => {
        const next = prev === 'click' ? 'marquee' : 'click'
        emitter.emit('floorplan:marquee-state' as any, { active: next === 'marquee' })
        return next
      })
    }
    emitter.on('floorplan:toggle-marquee' as any, handler)
    return () => { emitter.off('floorplan:toggle-marquee' as any, handler) }
  }, [])

  // Broadcast initial state
  useEffect(() => {
    emitter.emit('floorplan:marquee-state' as any, { active: floorplanSelectionTool === 'marquee' })
  }, [floorplanSelectionTool])

  // Scale-calibration trigger: `floorplan:calibrate-scale` event with the
  // guideId starts the 2-point flow. Emitted from the Upload Trace button
  // (auto-start on upload) and the ReferencePanel re-calibrate button.
  useEffect(() => {
    const handler = (data: { guideId: string }) => {
      setCalibratingGuideId(data.guideId)
      setCalibrationP1(null)
      setCalibrationP2(null)
      setCalibrationInput('')
    }
    emitter.on('floorplan:calibrate-scale' as any, handler)
    return () => { emitter.off('floorplan:calibrate-scale' as any, handler) }
  }, [])

  // ESC cancels the calibration flow without applying.
  useEffect(() => {
    if (!calibratingGuideId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCalibratingGuideId(null)
        setCalibrationP1(null)
        setCalibrationP2(null)
        setCalibrationInput('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [calibratingGuideId])

  // Apply the typed real-world distance to the guide's scale.
  //   observed = current plan distance between the two clicked points
  //   real     = user-entered distance in METERS (ft is converted)
  //   newScale = currentScale × (real / observed)
  // This linearity holds because guide width is FLOORPLAN_GUIDE_BASE_WIDTH × scale,
  // and plan coordinates inside the guide scale proportionally.
  const applyCalibration = useCallback(() => {
    if (!(calibratingGuideId && calibrationP1 && calibrationP2)) return
    const raw = calibrationInput.trim()
    if (!raw) return
    const parsed = parseFloat(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) return
    const realMeters = calibrationUnit === 'ft' ? parsed * 0.3048 : parsed

    const dxObs = calibrationP2[0] - calibrationP1[0]
    const dyObs = calibrationP2[1] - calibrationP1[1]
    const observed = Math.hypot(dxObs, dyObs)
    if (observed < 1e-6) return

    const guide = useScene
      .getState()
      .nodes[calibratingGuideId as AnyNodeId] as GuideNode | undefined
    if (!guide) return

    const currentScale = guide.scale ?? 1
    const ratio = realMeters / observed
    const newScale = currentScale * ratio
    updateNode(calibratingGuideId as AnyNodeId, { scale: newScale })

    // Exit calibration.
    setCalibratingGuideId(null)
    setCalibrationP1(null)
    setCalibrationP2(null)
    setCalibrationInput('')
  }, [
    calibratingGuideId,
    calibrationP1,
    calibrationP2,
    calibrationInput,
    calibrationUnit,
    updateNode,
  ])

  const [floorplanMarqueeState, setFloorplanMarqueeState] = useState<FloorplanMarqueeState | null>(
    null,
  )
  const [shiftPressed, setShiftPressed] = useState(false)
  const [rotationModifierPressed, setRotationModifierPressed] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [isDraggingPanel, setIsDraggingPanel] = useState(false)
  const [isMacPlatform, setIsMacPlatform] = useState(true)
  const [activeResizeDirection, setActiveResizeDirection] = useState<ResizeDirection | null>(null)
  const [panelRect, setPanelRect] = useState<PanelRect>({
    x: PANEL_MARGIN,
    y: PANEL_MARGIN,
    width: PANEL_DEFAULT_WIDTH,
    height: PANEL_DEFAULT_HEIGHT,
  })
  const [isLevelMenuOpen, setIsLevelMenuOpen] = useState(false)
  const [isGuideQuickAccessOpen, setIsGuideQuickAccessOpen] = useState(false)
  const [isPanelReady, setIsPanelReady] = useState(false)
  const [surfaceSize, setSurfaceSize] = useState({ width: 1, height: 1 })
  const [viewport, setViewport] = useState<FloorplanViewport | null>(null)

  useEffect(() => {
    if (structureLayer === 'zones' && floorplanSelectionTool === 'marquee') {
      setFloorplanSelectionTool('click')
    }
  }, [floorplanSelectionTool, structureLayer])

  useEffect(() => {
    setIsMacPlatform(navigator.platform.toUpperCase().includes('MAC'))
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset guide panel when level changes
  useEffect(() => {
    setIsGuideQuickAccessOpen(false)
  }, [levelId])

  const sitePolygonEntry = useMemo(() => {
    const polygonPoints = site?.polygon?.points
    if (!(site && polygonPoints)) {
      return null
    }

    const polygon = toFloorplanPolygon(polygonPoints)
    if (polygon.length < 3) {
      return null
    }

    return {
      site,
      polygon,
      points: formatPolygonPoints(polygon),
    }
  }, [site])
  const displaySitePolygon = useMemo(() => {
    if (!sitePolygonEntry) {
      return null
    }

    if (!(siteBoundaryDraft && siteBoundaryDraft.siteId === sitePolygonEntry.site.id)) {
      return sitePolygonEntry
    }

    const polygon = siteBoundaryDraft.polygon.map(toPoint2D)

    return {
      ...sitePolygonEntry,
      polygon,
      points: formatPolygonPoints(polygon),
    }
  }, [siteBoundaryDraft, sitePolygonEntry])
  const movingOpeningType =
    movingNode?.type === 'door' || movingNode?.type === 'window' ? movingNode.type : null

  const activeFloorplanToolConfig = useMemo(() => {
    if (movingOpeningType) {
      return structureTools.find((entry) => entry.id === movingOpeningType) ?? null
    }

    if (mode !== 'build' || !tool) {
      return null
    }

    if (tool === 'item' && catalogCategory) {
      return furnishTools.find((entry) => entry.catalogCategory === catalogCategory) ?? null
    }

    return structureTools.find((entry) => entry.id === tool) ?? null
  }, [catalogCategory, mode, movingOpeningType, tool])
  const activeFloorplanCursorIndicator = useMemo<FloorplanCursorIndicator | null>(() => {
    if (!activeFloorplanToolConfig) {
      return null
    }
    // Tools whose icon is inline-SVG (no PNG asset) — e.g. arc-wall — can't
    // be shown in the asset-only cursor indicator. Falling through to null is
    // fine: the user still gets the standard editor cursor while drawing.
    if (!activeFloorplanToolConfig.iconSrc) {
      return null
    }
    return {
      kind: 'asset',
      iconSrc: activeFloorplanToolConfig.iconSrc,
    }
  }, [activeFloorplanToolConfig])
  const visibleGuides = useMemo<GuideNode[]>(() => {
    if (!showGuides) {
      return []
    }

    return levelGuides.filter((guide) => guide.visible !== false)
  }, [levelGuides, showGuides])
  const guideById = useMemo(
    () => new Map(levelGuides.map((guide) => [guide.id, guide] as const)),
    [levelGuides],
  )
  const displayGuides = useMemo<GuideNode[]>(() => {
    if (!guideTransformDraft) {
      return visibleGuides
    }

    return visibleGuides.map((guide) =>
      guide.id === guideTransformDraft.guideId
        ? {
            ...guide,
            position: [
              guideTransformDraft.position[0],
              guide.position[1],
              guideTransformDraft.position[1],
            ] as [number, number, number],
            rotation: [guide.rotation[0], guideTransformDraft.rotation, guide.rotation[2]] as [
              number,
              number,
              number,
            ],
            scale: guideTransformDraft.scale,
          }
        : guide,
    )
  }, [guideTransformDraft, visibleGuides])
  const selectedGuideId =
    selectedReferenceId && guideById.has(selectedReferenceId as GuideNode['id'])
      ? (selectedReferenceId as GuideNode['id'])
      : null
  const selectedGuide = useMemo(
    () => displayGuides.find((guide) => guide.id === selectedGuideId) ?? null,
    [displayGuides, selectedGuideId],
  )
  const selectedGuideResolvedUrl = useResolvedAssetUrl(selectedGuide?.url ?? '')
  const selectedGuideDimensions = useGuideImageDimensions(selectedGuideResolvedUrl)
  const activeGuideInteractionGuideId = guideTransformDraft
    ? (guideInteractionRef.current?.guideId ?? null)
    : null
  const activeGuideInteractionMode = guideTransformDraft
    ? (guideInteractionRef.current?.mode ?? null)
    : null
  const hasGuideImages = levelGuides.length > 0
  const guideImagesDescription = hasGuideImages
    ? `${levelGuides.length} guide image${levelGuides.length === 1 ? '' : 's'} on this level`
    : 'No guide images on this level'

  const handleGuideOpacityChange = useCallback(
    (guideId: GuideNode['id'], opacity: number) => {
      updateNode(guideId, {
        opacity: Math.round(clamp(opacity, 0, 100)),
      })
    },
    [updateNode],
  )

  const floorplanWalls = useMemo(() => walls.map(getFloorplanWall), [walls])
  const wallMiterData = useMemo(() => calculateLevelMiters(floorplanWalls), [floorplanWalls])
  const wallById = useMemo(() => new Map(walls.map((wall) => [wall.id, wall] as const)), [walls])
  const floorplanWallById = useMemo(
    () => new Map(floorplanWalls.map((wall) => [wall.id, wall] as const)),
    [floorplanWalls],
  )
  const displayWallById = useMemo(() => {
    if (!wallEndpointDraft && !wallBulgeDraft) {
      return wallById
    }

    let map = wallById

    if (wallEndpointDraft) {
      const wall = wallById.get(wallEndpointDraft.wallId)
      if (wall) {
        const next = new Map(map)
        next.set(
          wall.id,
          buildWallWithUpdatedEndpoints(wall, wallEndpointDraft.start, wallEndpointDraft.end),
        )
        map = next
      }
    }

    if (wallBulgeDraft) {
      // Apply live bulge from drag — caller's wall body re-renders with the
      // arc footprint immediately while the user is dragging the handle.
      const wall = map.get(wallBulgeDraft.wallId)
      if (wall) {
        const next = new Map(map)
        next.set(wall.id, { ...wall, bulge: wallBulgeDraft.bulge } as WallNode)
        map = next
      }
    }

    return map
  }, [wallBulgeDraft, wallById, wallEndpointDraft])
  const displayFloorplanWallById = useMemo(() => {
    if (!wallEndpointDraft && !wallBulgeDraft) {
      return floorplanWallById
    }

    let map = floorplanWallById
    const draftedIds = new Set<string>()
    if (wallEndpointDraft) draftedIds.add(wallEndpointDraft.wallId)
    if (wallBulgeDraft) draftedIds.add(wallBulgeDraft.wallId)

    const next = new Map(map)
    for (const id of draftedIds) {
      const previewWall = displayWallById.get(id as WallNode['id'])
      if (previewWall) next.set(previewWall.id, getFloorplanWall(previewWall))
    }
    map = next
    return map
  }, [displayWallById, floorplanWallById, wallBulgeDraft, wallEndpointDraft])
  // Ritn3D: ghost wall polygons from floor below
  const ghostWallPolygons = useMemo(
    () =>
      ghostWalls.map((wall) => {
        const polygon = getWallPlanFootprint(getFloorplanWall(wall), EMPTY_WALL_MITER_DATA)
        return { points: formatPolygonPoints(polygon), wall }
      }),
    [ghostWalls],
  )

  const wallPolygons = useMemo(
    () =>
      walls.map((wall) => {
        const floorplanWall = floorplanWallById.get(wall.id) ?? getFloorplanWall(wall)
        const polygon = getWallPlanFootprint(floorplanWall, wallMiterData)
        return {
          points: formatPolygonPoints(polygon),
          wall,
          polygon,
        }
      }),
    [floorplanWallById, wallMiterData, walls],
  )
  const displayWallPolygons = useMemo(() => {
    // Ritn3D 2026-06-13: this used to only check wallEndpointDraft, so live
    // bulge drags didn't propagate to the rendered polygons — wall stayed
    // straight visually until commit and then SNAPPED to the curve. That's
    // why the user said the arc didn't move with the cursor. Fixed by also
    // re-rendering the polygon for the wall being bulge-drafted; both drafts
    // are already applied to displayWallById, so we just need to rebuild
    // both affected polygons.
    if (!wallEndpointDraft && !wallBulgeDraft) {
      return wallPolygons
    }

    const draftedIds = new Set<string>()
    if (wallEndpointDraft) draftedIds.add(wallEndpointDraft.wallId)
    if (wallBulgeDraft) draftedIds.add(wallBulgeDraft.wallId)

    return wallPolygons.map((entry) => {
      if (!draftedIds.has(entry.wall.id)) return entry
      const previewWall = displayWallById.get(entry.wall.id as WallNode['id'])
      if (!previewWall) return entry
      const previewPolygon = getWallPlanFootprint(
        getFloorplanWall(previewWall),
        EMPTY_WALL_MITER_DATA,
      )
      // Diagnostic: confirms the polygon IS being rebuilt during a bulge
      // drag. If the user reports "wall body doesn't follow my cursor",
      // they should see one of these logs per drag tick. If they don't,
      // displayWallPolygons isn't being consumed by the render path.
      if (wallBulgeDraft && entry.wall.id === wallBulgeDraft.wallId) {
        // eslint-disable-next-line no-console
        console.log('[bulge] polygon rebuild', {
          wallId: entry.wall.id,
          bulge: +previewWall.bulge.toFixed(4),
          pointCount: previewPolygon.length,
        })
      }
      return {
        wall: previewWall,
        polygon: previewPolygon,
        points: formatPolygonPoints(previewPolygon),
      }
    })
  }, [displayWallById, wallBulgeDraft, wallEndpointDraft, wallPolygons])

  const openingsPolygons = useMemo(
    () =>
      openings.flatMap((opening) => {
        const wall = displayFloorplanWallById.get(opening.parentId as WallNode['id'])
        if (!wall) return []
        const polygon = getOpeningFootprint(wall, opening)
        return [
          {
            opening,
            points: formatPolygonPoints(polygon),
            polygon,
          },
        ]
      }),
    [displayFloorplanWallById, openings],
  )
  const slabPolygons = useMemo(
    () =>
      slabs.flatMap((slab) => {
        const polygon = toFloorplanPolygon(slab.polygon)
        if (polygon.length < 3) {
          return []
        }

        const holes = (slab.holes ?? [])
          .map((hole) => toFloorplanPolygon(hole))
          .filter((hole) => hole.length >= 3)

        return [
          {
            slab,
            polygon,
            holes,
            path: formatPolygonPath(polygon, holes),
          },
        ]
      }),
    [slabs],
  )
  const displaySlabPolygons = useMemo(() => {
    if (!slabBoundaryDraft) {
      return slabPolygons
    }

    return slabPolygons.map((entry) =>
      entry.slab.id === slabBoundaryDraft.slabId
        ? {
            ...entry,
            polygon: slabBoundaryDraft.polygon.map(toPoint2D),
            path: formatPolygonPath(slabBoundaryDraft.polygon.map(toPoint2D), entry.holes),
          }
        : entry,
    )
  }, [slabBoundaryDraft, slabPolygons])
  const zonePolygons = useMemo(
    () =>
      zones.flatMap((zone) => {
        const polygon = toFloorplanPolygon(zone.polygon)
        if (polygon.length < 3) {
          return []
        }

        return [
          {
            zone,
            polygon,
            points: formatPolygonPoints(polygon),
          },
        ]
      }),
    [zones],
  )
  const displayZonePolygons = useMemo(() => {
    if (!zoneBoundaryDraft) {
      return zonePolygons
    }

    return zonePolygons.map((entry) =>
      entry.zone.id === zoneBoundaryDraft.zoneId
        ? {
            ...entry,
            polygon: zoneBoundaryDraft.polygon.map(toPoint2D),
            points: formatPolygonPoints(zoneBoundaryDraft.polygon.map(toPoint2D)),
          }
        : entry,
    )
  }, [zoneBoundaryDraft, zonePolygons])
  const selectedOpeningEntry = useMemo(() => {
    if (selectedIds.length !== 1) {
      return null
    }

    return openingsPolygons.find(({ opening }) => opening.id === selectedIds[0]) ?? null
  }, [openingsPolygons, selectedIds])
  const slabById = useMemo(() => new Map(slabs.map((slab) => [slab.id, slab] as const)), [slabs])
  const zoneById = useMemo(() => new Map(zones.map((zone) => [zone.id, zone] as const)), [zones])
  const selectedSlabEntry = useMemo(() => {
    if (selectedIds.length !== 1) {
      return null
    }

    return displaySlabPolygons.find(({ slab }) => slab.id === selectedIds[0]) ?? null
  }, [displaySlabPolygons, selectedIds])
  const selectedZoneEntry = useMemo(() => {
    if (!selectedZoneId) {
      return null
    }

    return displayZonePolygons.find(({ zone }) => zone.id === selectedZoneId) ?? null
  }, [displayZonePolygons, selectedZoneId])

  const isSiteEditActive = phase === 'site' && mode === 'edit'
  const isWallBuildActive = phase === 'structure' && mode === 'build' && tool === 'wall'
  // Arc-wall tool: 3-step state machine (start → end → bulge midpoint).
  const isArcWallBuildActive = phase === 'structure' && mode === 'build' && tool === 'arc-wall'
  const isSlabBuildActive = phase === 'structure' && mode === 'build' && tool === 'slab'
  const isZoneBuildActive = phase === 'structure' && mode === 'build' && tool === 'zone'
  const isDoorBuildActive = phase === 'structure' && mode === 'build' && tool === 'door'
  const isWindowBuildActive = phase === 'structure' && mode === 'build' && tool === 'window'
  const isPolygonBuildActive = isSlabBuildActive || isZoneBuildActive
  const isOpeningBuildActive = isDoorBuildActive || isWindowBuildActive
  const isOpeningMoveActive = movingOpeningType !== null
  const isOpeningPlacementActive = isOpeningBuildActive || isOpeningMoveActive
  const floorplanOpeningLocalY = useMemo(() => {
    if (movingNode?.type === 'door' || movingNode?.type === 'window') {
      return snapToHalf(movingNode.position[1])
    }

    if (isWindowBuildActive) {
      // Floorplan is top-down, so new windows need an explicit wall-local height.
      return snapToHalf(FLOORPLAN_DEFAULT_WINDOW_LOCAL_Y)
    }

    return 0
  }, [isWindowBuildActive, movingNode])
  const isMarqueeSelectionToolActive =
    mode === 'select' &&
    floorplanSelectionTool === 'marquee' &&
    !movingNode &&
    structureLayer !== 'zones'
  const canSelectElementFloorplanGeometry =
    (mode === 'select' || mode === 'delete') && floorplanSelectionTool === 'click' && !movingNode
  const canInteractWithGuides = showGuides && canSelectElementFloorplanGeometry
  const canSelectFloorplanZones =
    mode === 'select' &&
    floorplanSelectionTool === 'click' &&
    !movingNode &&
    structureLayer === 'zones'
  // Ritn3D: always show site boundary so users can see plot while drawing
  const visibleSitePolygon = displaySitePolygon
  const shouldShowSiteBoundaryHandles = isSiteEditActive && visibleSitePolygon !== null
  const shouldShowPersistentWallEndpointHandles = mode === 'select' && !movingNode
  const shouldShowSlabBoundaryHandles =
    mode === 'select' &&
    !movingNode &&
    floorplanSelectionTool === 'click' &&
    selectedSlabEntry !== null
  const shouldShowZoneBoundaryHandles = canSelectFloorplanZones && selectedZoneEntry !== null
  // Ritn3D: always show room/zone labels for context
  const showZonePolygons = phase === 'structure'
  const visibleZonePolygons = useMemo(
    () => (showZonePolygons ? displayZonePolygons : []),
    [displayZonePolygons, showZonePolygons],
  )
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const activeMarqueeBounds = useMemo(() => {
    if (!floorplanMarqueeState) {
      return null
    }

    return getFloorplanSelectionBounds(
      floorplanMarqueeState.startPlanPoint,
      floorplanMarqueeState.currentPlanPoint,
    )
  }, [floorplanMarqueeState])
  const visibleMarqueeBounds = useMemo(() => {
    if (!(floorplanMarqueeState && activeMarqueeBounds)) {
      return null
    }

    const dragDistance = Math.hypot(
      floorplanMarqueeState.currentPlanPoint[0] - floorplanMarqueeState.startPlanPoint[0],
      floorplanMarqueeState.currentPlanPoint[1] - floorplanMarqueeState.startPlanPoint[1],
    )

    return dragDistance > 0 ? activeMarqueeBounds : null
  }, [activeMarqueeBounds, floorplanMarqueeState])
  const visibleSvgMarqueeBounds = useMemo(() => {
    if (!visibleMarqueeBounds) {
      return null
    }

    return toSvgSelectionBounds(visibleMarqueeBounds)
  }, [visibleMarqueeBounds])
  const wallEndpointHandles = useMemo(() => {
    if (isOpeningPlacementActive || movingNode) {
      return []
    }

    return displayWallPolygons.flatMap(({ wall }) => {
      const isSelected = selectedIdSet.has(wall.id)
      const isVisible =
        shouldShowPersistentWallEndpointHandles ||
        isWallBuildActive ||
        isSelected ||
        wallEndpointDraft?.wallId === wall.id
      if (!isVisible) {
        return []
      }

      return (['start', 'end'] as const).map((endpoint) => ({
        wall,
        endpoint,
        point: endpoint === 'start' ? wall.start : wall.end,
        isSelected,
        isActive: wallEndpointDraft?.wallId === wall.id && wallEndpointDraft.endpoint === endpoint,
      }))
    })
  }, [
    displayWallPolygons,
    isOpeningPlacementActive,
    isWallBuildActive,
    movingNode,
    selectedIdSet,
    shouldShowPersistentWallEndpointHandles,
    wallEndpointDraft,
  ])
  // Bulge handles. One per selected wall. Sits at the arc apex when
  // bulge != 0, at chord midpoint when straight (drag perpendicular to
  // convert a straight wall into a curve).
  //
  // Visible in: select mode (Pascal default) OR arc-wall build mode (so the
  // wall the user JUST placed with the Arc Wall tool shows its bulge handle
  // and they can immediately bend it — the whole point of the redesign).
  // Hidden during opening placement / moving to avoid handle clutter.
  const wallBulgeHandles = useMemo(() => {
    if (isOpeningPlacementActive || movingNode) return []
    const allowed = mode === 'select' || tool === 'arc-wall'
    if (!allowed) return []
    return displayWallPolygons.flatMap(({ wall }) => {
      if (!selectedIdSet.has(wall.id)) return []
      const liveBulge = wallBulgeDraft?.wallId === wall.id ? wallBulgeDraft.bulge : wall.bulge ?? 0
      const point = arcMidpoint(wall.start, wall.end, liveBulge)
      return [
        {
          wall,
          point: point as WallPlanPoint,
          isActive: wallBulgeDraft?.wallId === wall.id,
        },
      ]
    })
  }, [
    displayWallPolygons,
    isOpeningPlacementActive,
    mode,
    movingNode,
    selectedIdSet,
    tool,
    wallBulgeDraft,
  ])
  const slabVertexHandles = useMemo(() => {
    if (!shouldShowSlabBoundaryHandles) {
      return []
    }

    return selectedSlabEntry.polygon.map((point, vertexIndex) => ({
      nodeId: selectedSlabEntry.slab.id,
      vertexIndex,
      point: toWallPlanPoint(point),
      isActive:
        slabVertexDragState?.slabId === selectedSlabEntry.slab.id &&
        slabVertexDragState.vertexIndex === vertexIndex,
    }))
  }, [selectedSlabEntry, shouldShowSlabBoundaryHandles, slabVertexDragState])
  const slabMidpointHandles = useMemo(() => {
    if (!(shouldShowSlabBoundaryHandles && !slabVertexDragState)) {
      return []
    }

    return selectedSlabEntry.polygon.map((point, edgeIndex, polygon) => {
      const nextPoint = polygon[(edgeIndex + 1) % polygon.length]
      return {
        nodeId: selectedSlabEntry.slab.id,
        edgeIndex,
        point: [
          (point.x + (nextPoint?.x ?? point.x)) / 2,
          (point.y + (nextPoint?.y ?? point.y)) / 2,
        ] as WallPlanPoint,
      }
    })
  }, [selectedSlabEntry, shouldShowSlabBoundaryHandles, slabVertexDragState])
  const siteVertexHandles = useMemo(() => {
    if (!(shouldShowSiteBoundaryHandles && visibleSitePolygon)) {
      return []
    }

    return visibleSitePolygon.polygon.map((point, vertexIndex) => ({
      nodeId: visibleSitePolygon.site.id,
      vertexIndex,
      point: toWallPlanPoint(point),
      isActive:
        siteVertexDragState?.siteId === visibleSitePolygon.site.id &&
        siteVertexDragState.vertexIndex === vertexIndex,
    }))
  }, [shouldShowSiteBoundaryHandles, siteVertexDragState, visibleSitePolygon])
  const siteMidpointHandles = useMemo(() => {
    if (!(shouldShowSiteBoundaryHandles && visibleSitePolygon && !siteVertexDragState)) {
      return []
    }

    return visibleSitePolygon.polygon.map((point, edgeIndex, polygon) => {
      const nextPoint = polygon[(edgeIndex + 1) % polygon.length]
      return {
        nodeId: visibleSitePolygon.site.id,
        edgeIndex,
        point: [
          (point.x + (nextPoint?.x ?? point.x)) / 2,
          (point.y + (nextPoint?.y ?? point.y)) / 2,
        ] as WallPlanPoint,
      }
    })
  }, [shouldShowSiteBoundaryHandles, siteVertexDragState, visibleSitePolygon])
  const zoneVertexHandles = useMemo(() => {
    if (!shouldShowZoneBoundaryHandles) {
      return []
    }

    return selectedZoneEntry.polygon.map((point, vertexIndex) => ({
      nodeId: selectedZoneEntry.zone.id,
      vertexIndex,
      point: toWallPlanPoint(point),
      isActive:
        zoneVertexDragState?.zoneId === selectedZoneEntry.zone.id &&
        zoneVertexDragState.vertexIndex === vertexIndex,
    }))
  }, [selectedZoneEntry, shouldShowZoneBoundaryHandles, zoneVertexDragState])
  const zoneMidpointHandles = useMemo(() => {
    if (!(shouldShowZoneBoundaryHandles && !zoneVertexDragState)) {
      return []
    }

    return selectedZoneEntry.polygon.map((point, edgeIndex, polygon) => {
      const nextPoint = polygon[(edgeIndex + 1) % polygon.length]
      return {
        nodeId: selectedZoneEntry.zone.id,
        edgeIndex,
        point: [
          (point.x + (nextPoint?.x ?? point.x)) / 2,
          (point.y + (nextPoint?.y ?? point.y)) / 2,
        ] as WallPlanPoint,
      }
    })
  }, [selectedZoneEntry, shouldShowZoneBoundaryHandles, zoneVertexDragState])

  const draftPolygon = useMemo(() => {
    // Arc-wall draft preview. Phase 1: straight preview start->cursor (no
    // bulge yet). Phase 2: actual curved preview with live bulge derived from
    // the cursor's perpendicular offset to the chord.
    if (levelId && arcDraftStart) {
      const previewEnd = arcDraftEnd ?? cursorPoint ?? arcDraftStart
      if (!isWallLongEnough(arcDraftStart, previewEnd)) {
        return null
      }
      let previewBulge = 0
      if (arcDraftEnd && arcBulgePoint) {
        const raw = bulgeFromThreePoints(arcDraftStart, arcDraftEnd, arcBulgePoint)
        previewBulge = Math.max(-2, Math.min(2, raw))
      }
      const draftWall = getFloorplanWall(
        buildDraftWall(levelId, arcDraftStart, previewEnd, previewBulge),
      )
      return getWallPlanFootprint(draftWall, EMPTY_WALL_MITER_DATA)
    }

    if (!(levelId && draftStart && draftEnd && isWallLongEnough(draftStart, draftEnd))) {
      return null
    }

    const draftWall = getFloorplanWall(buildDraftWall(levelId, draftStart, draftEnd))
    // Keep the live draft preview cheap; full level-wide mitering here runs on every mouse move.
    return getWallPlanFootprint(draftWall, EMPTY_WALL_MITER_DATA)
  }, [arcBulgePoint, arcDraftEnd, arcDraftStart, cursorPoint, draftEnd, draftStart, levelId])
  const draftPolygonPoints = useMemo(
    () => (draftPolygon ? formatPolygonPoints(draftPolygon) : null),
    [draftPolygon],
  )
  const activePolygonDraftPoints = useMemo(() => {
    if (isZoneBuildActive) {
      return zoneDraftPoints
    }

    if (isSlabBuildActive) {
      return slabDraftPoints
    }

    return [] as WallPlanPoint[]
  }, [isSlabBuildActive, isZoneBuildActive, slabDraftPoints, zoneDraftPoints])
  const polygonDraftPolylinePoints = useMemo(() => {
    if (!(isPolygonBuildActive && cursorPoint && activePolygonDraftPoints.length > 0)) {
      return null
    }

    return formatPolygonPoints([...activePolygonDraftPoints.map(toPoint2D), toPoint2D(cursorPoint)])
  }, [activePolygonDraftPoints, cursorPoint, isPolygonBuildActive])
  const polygonDraftPolygonPoints = useMemo(() => {
    if (!(isPolygonBuildActive && cursorPoint && activePolygonDraftPoints.length >= 2)) {
      return null
    }

    return formatPolygonPoints([...activePolygonDraftPoints.map(toPoint2D), toPoint2D(cursorPoint)])
  }, [activePolygonDraftPoints, cursorPoint, isPolygonBuildActive])
  const polygonDraftClosingSegment = useMemo(() => {
    if (!(isPolygonBuildActive && cursorPoint && activePolygonDraftPoints.length >= 2)) {
      return null
    }

    const firstPoint = activePolygonDraftPoints[0]
    if (!firstPoint) {
      return null
    }

    return {
      x1: toSvgX(cursorPoint[0]),
      y1: toSvgY(cursorPoint[1]),
      x2: toSvgX(firstPoint[0]),
      y2: toSvgY(firstPoint[1]),
    }
  }, [activePolygonDraftPoints, cursorPoint, isPolygonBuildActive])

  const svgAspectRatio = surfaceSize.width / surfaceSize.height || 1

  const fittedViewport = useMemo(() => {
    const allPoints = [
      ...(visibleSitePolygon ? visibleSitePolygon.polygon : []),
      ...displaySlabPolygons.flatMap((entry) => entry.polygon),
      ...visibleZonePolygons.flatMap((entry) => entry.polygon),
      ...wallPolygons.flatMap((entry) => entry.polygon),
    ]

    if (allPoints.length === 0) {
      return {
        centerX: 0,
        centerY: 0,
        width: Math.max(FALLBACK_VIEW_SIZE, FALLBACK_VIEW_SIZE * svgAspectRatio),
      }
    }

    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY

    for (const point of allPoints) {
      const svgPoint = toSvgPoint(point)
      minX = Math.min(minX, svgPoint.x)
      maxX = Math.max(maxX, svgPoint.x)
      minY = Math.min(minY, svgPoint.y)
      maxY = Math.max(maxY, svgPoint.y)
    }

    const rawWidth = maxX - minX
    const rawHeight = maxY - minY
    const paddedWidth = rawWidth + FLOORPLAN_PADDING * 2
    const paddedHeight = rawHeight + FLOORPLAN_PADDING * 2
    const width = Math.max(FALLBACK_VIEW_SIZE, paddedWidth, paddedHeight * svgAspectRatio)
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2

    return {
      centerX,
      centerY,
      width,
    }
  }, [displaySlabPolygons, svgAspectRatio, visibleSitePolygon, visibleZonePolygons, wallPolygons])

  useEffect(() => {
    const host = viewportHostRef.current
    if (!host) {
      return
    }

    const updateSize = () => {
      const rect = host.getBoundingClientRect()
      setSurfaceSize({
        width: Math.max(rect.width, 1),
        height: Math.max(rect.height, 1),
      })
    }

    updateSize()

    const resizeObserver = new ResizeObserver(updateSize)
    resizeObserver.observe(host)
    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  useEffect(() => {
    const currentBounds = getViewportBounds()
    const persistedRect = readPersistedPanelLayout(currentBounds)
    setPanelRect(persistedRect ?? getInitialPanelRect(currentBounds))
    panelBoundsRef.current = currentBounds
    setIsPanelReady(true)
  }, [])

  useEffect(() => {
    const handleWindowResize = () => {
      const nextBounds = getViewportBounds()
      const previousBounds = panelBoundsRef.current ?? nextBounds
      setPanelRect((currentRect) => adaptPanelRectToBounds(currentRect, previousBounds, nextBounds))
      panelBoundsRef.current = nextBounds
    }

    window.addEventListener('resize', handleWindowResize)
    return () => {
      window.removeEventListener('resize', handleWindowResize)
    }
  }, [])

  useEffect(() => {
    if (!isPanelReady) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      const currentBounds = panelBoundsRef.current ?? getViewportBounds()
      writePersistedPanelLayout({
        rect: panelRect,
        viewport: currentBounds,
      })
    }, 120)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [isPanelReady, panelRect])

  useEffect(() => {
    const levelChanged = previousLevelIdRef.current !== (levelId ?? null)

    if (levelChanged) {
      previousLevelIdRef.current = levelId ?? null
      hasUserAdjustedViewportRef.current = false
      setViewport(fittedViewport)
      return
    }

    if (!hasUserAdjustedViewportRef.current) {
      setViewport(fittedViewport)
    }
  }, [fittedViewport, levelId])

  // Ritn3D: listen for reset view event from sidebar
  useEffect(() => {
    const handler = () => setViewport(fittedViewport)
    emitter.on('floorplan:reset-view' as any, handler)
    return () => { emitter.off('floorplan:reset-view' as any, handler) }
  }, [fittedViewport])

  useEffect(() => {
    if (!(phase === 'site' && levelNode?.type === 'level' && levelNode.level > 0)) {
      return
    }

    setPhase('structure')
  }, [levelNode, phase, setPhase])

  const viewBox = useMemo(() => {
    const currentViewport = viewport ?? fittedViewport
    const width = currentViewport.width
    const height = width / svgAspectRatio

    return {
      minX: currentViewport.centerX - width / 2,
      minY: currentViewport.centerY - height / 2,
      width,
      height,
    }
  }, [fittedViewport, svgAspectRatio, viewport])

  // Ritn3D: update measurement scale based on visible area
  setMeasureScale(viewBox.width)

  const floorplanWorldUnitsPerPixel = useMemo(() => {
    const widthUnitsPerPixel = viewBox.width / Math.max(surfaceSize.width, 1)
    const heightUnitsPerPixel = viewBox.height / Math.max(surfaceSize.height, 1)

    return (widthUnitsPerPixel + heightUnitsPerPixel) / 2
  }, [surfaceSize.height, surfaceSize.width, viewBox.height, viewBox.width])
  const floorplanWallHitTolerance = useMemo(
    () => floorplanWorldUnitsPerPixel * (FLOORPLAN_WALL_HIT_STROKE_WIDTH / 2),
    [floorplanWorldUnitsPerPixel],
  )
  const floorplanOpeningHitTolerance = useMemo(
    () => floorplanWorldUnitsPerPixel * (FLOORPLAN_OPENING_HIT_STROKE_WIDTH / 2),
    [floorplanWorldUnitsPerPixel],
  )
  const selectedOpeningActionMenuPosition = useMemo(() => {
    if (!selectedOpeningEntry) {
      return null
    }

    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY

    for (const point of selectedOpeningEntry.polygon) {
      const svgPoint = toSvgPoint(point)
      minX = Math.min(minX, svgPoint.x)
      maxX = Math.max(maxX, svgPoint.x)
      minY = Math.min(minY, svgPoint.y)
      maxY = Math.max(maxY, svgPoint.y)
    }

    if (
      !(
        Number.isFinite(minX) &&
        Number.isFinite(maxX) &&
        Number.isFinite(minY) &&
        Number.isFinite(maxY)
      )
    ) {
      return null
    }

    if (
      maxX < viewBox.minX ||
      minX > viewBox.minX + viewBox.width ||
      maxY < viewBox.minY ||
      minY > viewBox.minY + viewBox.height
    ) {
      return null
    }

    const anchorX = (((minX + maxX) / 2 - viewBox.minX) / viewBox.width) * surfaceSize.width
    const anchorY = ((minY - viewBox.minY) / viewBox.height) * surfaceSize.height

    return {
      x: Math.min(
        Math.max(anchorX, FLOORPLAN_ACTION_MENU_HORIZONTAL_PADDING),
        surfaceSize.width - FLOORPLAN_ACTION_MENU_HORIZONTAL_PADDING,
      ),
      y: Math.max(anchorY, FLOORPLAN_ACTION_MENU_MIN_ANCHOR_Y),
    }
  }, [selectedOpeningEntry, surfaceSize.height, surfaceSize.width, viewBox])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset hovered corner when selected guide changes
  useEffect(() => {
    setHoveredGuideCorner(null)
  }, [selectedGuide?.id])

  useEffect(() => {
    if (!(selectedGuide && showGuides && canInteractWithGuides)) {
      setHoveredGuideCorner(null)
    }
  }, [canInteractWithGuides, selectedGuide, showGuides])

  const guideHandleHintAnchor = useMemo<GuideHandleHintAnchor | null>(() => {
    if (
      !(
        hoveredGuideCorner &&
        selectedGuide &&
        selectedGuideDimensions &&
        surfaceSize.width > 0 &&
        surfaceSize.height > 0 &&
        viewBox.width > 0 &&
        viewBox.height > 0
      )
    ) {
      return null
    }

    const aspectRatio = selectedGuideDimensions.width / selectedGuideDimensions.height
    if (!(aspectRatio > 0)) {
      return null
    }

    const planWidth = getGuideWidth(selectedGuide.scale)
    const planHeight = getGuideHeight(planWidth, aspectRatio)
    const centerSvg = getGuideCenterSvgPoint(selectedGuide)
    const handleSvg = getGuideCornerSvgPoint(
      centerSvg,
      planWidth,
      planHeight,
      -selectedGuide.rotation[1],
      hoveredGuideCorner,
    )

    if (
      handleSvg.x < viewBox.minX ||
      handleSvg.x > viewBox.minX + viewBox.width ||
      handleSvg.y < viewBox.minY ||
      handleSvg.y > viewBox.minY + viewBox.height
    ) {
      return null
    }

    const centerX = ((centerSvg.x - viewBox.minX) / viewBox.width) * surfaceSize.width
    const centerY = ((centerSvg.y - viewBox.minY) / viewBox.height) * surfaceSize.height
    const handleX = ((handleSvg.x - viewBox.minX) / viewBox.width) * surfaceSize.width
    const handleY = ((handleSvg.y - viewBox.minY) / viewBox.height) * surfaceSize.height

    let directionX = handleX - centerX
    let directionY = handleY - centerY
    const directionLength = Math.hypot(directionX, directionY)

    if (directionLength > 0.001) {
      directionX /= directionLength
      directionY /= directionLength
    } else {
      directionX = 1
      directionY = 0
    }

    const minX = Math.min(FLOORPLAN_GUIDE_HANDLE_HINT_PADDING_X, surfaceSize.width / 2)
    const maxX = Math.max(surfaceSize.width - FLOORPLAN_GUIDE_HANDLE_HINT_PADDING_X, minX)
    const minY = Math.min(FLOORPLAN_GUIDE_HANDLE_HINT_PADDING_Y, surfaceSize.height / 2)
    const maxY = Math.max(surfaceSize.height - FLOORPLAN_GUIDE_HANDLE_HINT_PADDING_Y, minY)

    return {
      x: clamp(handleX + directionX * FLOORPLAN_GUIDE_HANDLE_HINT_OFFSET, minX, maxX),
      y: clamp(handleY + directionY * FLOORPLAN_GUIDE_HANDLE_HINT_OFFSET, minY, maxY),
      directionX,
      directionY,
    }
  }, [
    hoveredGuideCorner,
    selectedGuide,
    selectedGuideDimensions,
    surfaceSize.height,
    surfaceSize.width,
    viewBox,
  ])

  const minViewportWidth = fittedViewport.width * MIN_VIEWPORT_WIDTH_RATIO
  const maxViewportWidth = fittedViewport.width * MAX_VIEWPORT_WIDTH_RATIO

  const palette = useMemo(
    () =>
      theme === 'dark'
        ? {
            surface: '#0a0e1b',
            minorGrid: '#475569',
            majorGrid: '#94a3b8',
            minorGridOpacity: 0.7,
            majorGridOpacity: 0.9,
            slabFill: '#5f6483',
            slabStroke: '#71717a',
            selectedSlabFill: '#b7b5f7',
            wallFill: '#fafafa',
            wallStroke: '#38bdf8',
            wallHoverStroke: '#a1a1aa',
            selectedFill: '#8381ed',
            selectedStroke: '#8381ed',
            draftFill: '#818cf8',
            draftStroke: '#c7d2fe',
            measurementStroke: '#cbd5e1',
            cursor: '#818cf8',
            editCursor: '#8381ed',
            anchor: '#818cf8',
            openingFill: '#0a0e1b',
            openingStroke: '#fafafa',
            doorFill: '#1a0e2e',
            doorStroke: '#f59e0b',
            windowFill: '#0a1e2e',
            windowStroke: '#38bdf8',
            endpointHandleFill: '#09090b',
            endpointHandleStroke: '#a1a1aa',
            endpointHandleHoverStroke: '#d4d4d8',
            endpointHandleActiveFill: '#8381ed',
            endpointHandleActiveStroke: '#8381ed',
          }
        : {
            surface: '#ffffff',
            minorGrid: '#94a3b8',
            majorGrid: '#475569',
            minorGridOpacity: 0.7,
            majorGridOpacity: 0.9,
            slabFill: '#c4c4cc',
            slabStroke: '#52525b',
            selectedSlabFill: '#b7b5f7',
            wallFill: '#171717',
            wallStroke: '#0284c7',
            wallHoverStroke: '#71717a',
            selectedFill: '#8381ed',
            selectedStroke: '#8381ed',
            draftFill: '#6366f1',
            draftStroke: '#4338ca',
            measurementStroke: '#334155',
            cursor: '#6366f1',
            editCursor: '#8381ed',
            anchor: '#4338ca',
            openingFill: '#ffffff',
            openingStroke: '#171717',
            doorFill: '#fef3c7',
            doorStroke: '#d97706',
            windowFill: '#e0f2fe',
            windowStroke: '#0284c7',
            endpointHandleFill: '#ffffff',
            endpointHandleStroke: '#71717a',
            endpointHandleHoverStroke: '#52525b',
            endpointHandleActiveFill: '#8381ed',
            endpointHandleActiveStroke: '#8381ed',
          },
    [theme],
  )
  const floorplanLevelLabel =
    levelNode?.type === 'level' ? getLevelDisplayLabel(levelNode) : 'Select a level'
  const isGroundFloorSelected = levelNode?.type === 'level' && levelNode.level === 0
  const isSiteEditShortcutActive = phase === 'site' && mode === 'edit'
  const canUseSiteEditShortcut = isGroundFloorSelected
  const hasFloorplanLevelSwitcher = floorplanLevels.length > 1
  const gridSteps = useMemo(
    () => getVisibleGridSteps(viewBox.width, surfaceSize.width),
    [surfaceSize.width, viewBox.width],
  )

  const minorGridPath = useMemo(
    () =>
      buildGridPath(
        viewBox.minX,
        viewBox.minX + viewBox.width,
        viewBox.minY,
        viewBox.minY + viewBox.height,
        gridSteps.minorStep,
        {
          excludeStep: gridSteps.majorStep,
        },
      ),
    [gridSteps.majorStep, gridSteps.minorStep, viewBox],
  )
  const majorGridPath = useMemo(
    () =>
      buildGridPath(
        viewBox.minX,
        viewBox.minX + viewBox.width,
        viewBox.minY,
        viewBox.minY + viewBox.height,
        gridSteps.majorStep,
      ),
    [gridSteps.majorStep, viewBox],
  )

  const getSvgPointFromClientPoint = useCallback(
    (clientX: number, clientY: number): SvgPoint | null => {
      const svg = svgRef.current
      const ctm = svg?.getScreenCTM()
      if (!(svg && ctm)) {
        return null
      }

      const screenPoint = svg.createSVGPoint()
      screenPoint.x = clientX
      screenPoint.y = clientY
      const transformedPoint = screenPoint.matrixTransform(ctm.inverse())

      return { x: transformedPoint.x, y: transformedPoint.y }
    },
    [],
  )

  const getPlanPointFromClientPoint = useCallback(
    (clientX: number, clientY: number): WallPlanPoint | null => {
      const svgPoint = getSvgPointFromClientPoint(clientX, clientY)
      if (!svgPoint) {
        return null
      }

      return toPlanPointFromSvgPoint(svgPoint)
    },
    [getSvgPointFromClientPoint],
  )
  useEffect(() => {
    siteBoundaryDraftRef.current = siteBoundaryDraft
  }, [siteBoundaryDraft])

  useEffect(() => {
    slabBoundaryDraftRef.current = slabBoundaryDraft
  }, [slabBoundaryDraft])

  useEffect(() => {
    zoneBoundaryDraftRef.current = zoneBoundaryDraft
  }, [zoneBoundaryDraft])

  useEffect(() => {
    guideTransformDraftRef.current = guideTransformDraft
  }, [guideTransformDraft])

  const updateViewport = useCallback((nextViewport: FloorplanViewport) => {
    hasUserAdjustedViewportRef.current = true
    setViewport(nextViewport)
  }, [])

  const clearGuideInteraction = useCallback(() => {
    guideInteractionRef.current = null
    guideTransformDraftRef.current = null
    setGuideTransformDraft(null)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

  const clearLevelMenuCloseTimeout = useCallback(() => {
    if (levelMenuCloseTimeoutRef.current !== null) {
      window.clearTimeout(levelMenuCloseTimeoutRef.current)
      levelMenuCloseTimeoutRef.current = null
    }
  }, [])

  const openLevelMenu = useCallback(() => {
    if (!hasFloorplanLevelSwitcher) {
      return
    }

    clearLevelMenuCloseTimeout()
    setIsLevelMenuOpen(true)
  }, [clearLevelMenuCloseTimeout, hasFloorplanLevelSwitcher])

  const scheduleLevelMenuClose = useCallback(() => {
    clearLevelMenuCloseTimeout()

    levelMenuCloseTimeoutRef.current = window.setTimeout(() => {
      setIsLevelMenuOpen(false)
      levelMenuCloseTimeoutRef.current = null
    }, FLOORPLAN_LEVEL_MENU_CLOSE_DELAY_MS)
  }, [clearLevelMenuCloseTimeout])

  const handleFloorplanLevelSelect = useCallback(
    (nextLevelId: string) => {
      const resolvedLevelId = nextLevelId as LevelNode['id']

      if (currentBuildingId) {
        setSelection({
          buildingId: currentBuildingId,
          levelId: resolvedLevelId,
        })
      } else {
        setSelection({ levelId: resolvedLevelId })
      }

      clearLevelMenuCloseTimeout()
      setIsLevelMenuOpen(false)
    },
    [clearLevelMenuCloseTimeout, currentBuildingId, setSelection],
  )

  const finishPanelInteraction = useCallback(() => {
    panelInteractionRef.current = null
    setIsDraggingPanel(false)
    setActiveResizeDirection(null)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

  const beginPanelInteraction = useCallback((interaction: PanelInteractionState) => {
    panelInteractionRef.current = interaction
    if (interaction.type === 'drag') {
      setIsDraggingPanel(true)
      setActiveResizeDirection(null)
      document.body.style.cursor = 'grabbing'
    } else if (interaction.direction) {
      setIsDraggingPanel(false)
      setActiveResizeDirection(interaction.direction)
      document.body.style.cursor = resizeCursorByDirection[interaction.direction]
    }

    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const interaction = panelInteractionRef.current
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return
      }

      event.preventDefault()

      const dx = event.clientX - interaction.startClientX
      const dy = event.clientY - interaction.startClientY
      const bounds = getViewportBounds()

      const nextRect =
        interaction.type === 'drag'
          ? movePanelRect(interaction.initialRect, dx, dy, bounds)
          : resizePanelRect(interaction.initialRect, interaction.direction ?? 'se', dx, dy, bounds)

      setPanelRect(nextRect)
    }

    const handlePointerUp = (event: PointerEvent) => {
      const interaction = panelInteractionRef.current
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return
      }

      finishPanelInteraction()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [finishPanelInteraction])

  useEffect(() => {
    return () => {
      finishPanelInteraction()
    }
  }, [finishPanelInteraction])

  useEffect(() => {
    return () => {
      clearLevelMenuCloseTimeout()
    }
  }, [clearLevelMenuCloseTimeout])

  useEffect(() => {
    const interaction = guideInteractionRef.current
    if (interaction && !guideById.has(interaction.guideId)) {
      clearGuideInteraction()
    }
  }, [clearGuideInteraction, guideById])

  useEffect(() => {
    if (!canInteractWithGuides) {
      clearGuideInteraction()
    }
  }, [canInteractWithGuides, clearGuideInteraction])

  useEffect(() => {
    return () => {
      clearGuideInteraction()
    }
  }, [clearGuideInteraction])

  useEffect(() => {
    if (!hasFloorplanLevelSwitcher) {
      setIsLevelMenuOpen(false)
    }
  }, [hasFloorplanLevelSwitcher])

  const handlePanelDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return
      }

      const target = event.target as HTMLElement | null
      if (target?.closest('[data-floorplan-panel-control="true"]')) {
        return
      }

      event.preventDefault()

      beginPanelInteraction({
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        initialRect: panelRect,
        type: 'drag',
      })
    },
    [beginPanelInteraction, panelRect],
  )

  const handleResizeStart = useCallback(
    (direction: ResizeDirection, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      beginPanelInteraction({
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        initialRect: panelRect,
        type: 'resize',
        direction,
      })
    },
    [beginPanelInteraction, panelRect],
  )

  const zoomViewportAtClientPoint = useCallback(
    (clientX: number, clientY: number, widthFactor: number) => {
      if (!Number.isFinite(widthFactor) || widthFactor <= 0) {
        return
      }

      const svgPoint = getSvgPointFromClientPoint(clientX, clientY)
      if (!svgPoint) {
        return
      }

      const currentViewport = viewport ?? fittedViewport
      const currentViewBox = viewBox
      const nextWidth = Math.min(
        maxViewportWidth,
        Math.max(minViewportWidth, currentViewport.width * widthFactor),
      )
      const nextHeight = nextWidth / svgAspectRatio
      const normalizedX = (svgPoint.x - currentViewBox.minX) / currentViewBox.width
      const normalizedY = (svgPoint.y - currentViewBox.minY) / currentViewBox.height
      const nextMinX = svgPoint.x - normalizedX * nextWidth
      const nextMinY = svgPoint.y - normalizedY * nextHeight

      updateViewport({
        centerX: nextMinX + nextWidth / 2,
        centerY: nextMinY + nextHeight / 2,
        width: nextWidth,
      })
    },
    [
      fittedViewport,
      getSvgPointFromClientPoint,
      maxViewportWidth,
      minViewportWidth,
      svgAspectRatio,
      updateViewport,
      viewBox,
      viewport,
    ],
  )

  const clearWallPlacementDraft = useCallback(() => {
    setDraftStart(null)
    setDraftEnd(null)
    // Arc-wall draft shares the "wall placement" lifecycle — same Escape /
    // tool-switch / commit semantics, so we clear it in the same callback.
    setArcDraftStart(null)
    setArcDraftEnd(null)
    setArcBulgePoint(null)
  }, [])
  const clearSlabPlacementDraft = useCallback(() => {
    setSlabDraftPoints([])
  }, [])
  const clearZonePlacementDraft = useCallback(() => {
    setZoneDraftPoints([])
  }, [])

  const clearWallEndpointDrag = useCallback(() => {
    wallEndpointDragRef.current = null
    setWallEndpointDraft(null)
    setHoveredEndpointId(null)
  }, [])
  const clearWallBulgeDrag = useCallback(() => {
    wallBulgeDragRef.current = null
    setWallBulgeDraft(null)
  }, [])
  const clearSiteBoundaryInteraction = useCallback(() => {
    setSiteVertexDragState(null)
    setSiteBoundaryDraft(null)
    setHoveredSiteHandleId(null)
  }, [])
  const clearSlabBoundaryInteraction = useCallback(() => {
    setSlabVertexDragState(null)
    setSlabBoundaryDraft(null)
    setHoveredSlabHandleId(null)
  }, [])
  const clearZoneBoundaryInteraction = useCallback(() => {
    setZoneVertexDragState(null)
    setZoneBoundaryDraft(null)
    setHoveredZoneHandleId(null)
  }, [])

  const clearDraft = useCallback(() => {
    clearWallPlacementDraft()
    clearSlabPlacementDraft()
    clearZonePlacementDraft()
    clearWallEndpointDrag()
    clearSiteBoundaryInteraction()
    clearSlabBoundaryInteraction()
    clearZoneBoundaryInteraction()
    setCursorPoint(null)
  }, [
    clearSiteBoundaryInteraction,
    clearSlabBoundaryInteraction,
    clearSlabPlacementDraft,
    clearZoneBoundaryInteraction,
    clearWallEndpointDrag,
    clearWallPlacementDraft,
    clearZonePlacementDraft,
  ])

  useEffect(() => {
    if (isWallBuildActive || isPolygonBuildActive) {
      return
    }

    clearDraft()
  }, [clearDraft, isPolygonBuildActive, isWallBuildActive])

  useEffect(() => {
    const handleCancel = () => {
      clearDraft()
    }

    emitter.on('tool:cancel', handleCancel)
    return () => {
      emitter.off('tool:cancel', handleCancel)
    }
  }, [clearDraft])

  const createSlabOnCurrentLevel = useCallback(
    (points: WallPlanPoint[]) => {
      if (!levelId) {
        return null
      }

      const { createNode, nodes } = useScene.getState()
      const slabCount = Object.values(nodes).filter((node) => node.type === 'slab').length
      const slab = SlabNode.parse({
        name: `Slab ${slabCount + 1}`,
        polygon: points.map(([x, z]) => [x, z] as [number, number]),
      })

      createNode(slab, levelId)
      sfxEmitter.emit('sfx:structure-build')
      setSelection({ selectedIds: [slab.id] })
      return slab.id
    },
    [levelId, setSelection],
  )
  const createZoneOnCurrentLevel = useCallback(
    (points: WallPlanPoint[]) => {
      if (!levelId) {
        return null
      }

      const { createNode, nodes } = useScene.getState()
      const zoneCount = Object.values(nodes).filter((node) => node.type === 'zone').length
      const zone = ZoneNodeSchema.parse({
        color: PALETTE_COLORS[zoneCount % PALETTE_COLORS.length],
        name: `Zone ${zoneCount + 1}`,
        polygon: points.map(([x, z]) => [x, z] as [number, number]),
      })

      createNode(zone, levelId)
      sfxEmitter.emit('sfx:structure-build')
      setSelection({ zoneId: zone.id })
      return zone.id
    },
    [levelId, setSelection],
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setShiftPressed(true)
      }

      setRotationModifierPressed(
        event.key === 'Meta' || event.key === 'Control' || event.metaKey || event.ctrlKey,
      )
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setShiftPressed(false)
      }

      setRotationModifierPressed(event.metaKey || event.ctrlKey)
    }
    const handleBlur = () => {
      setShiftPressed(false)
      setRotationModifierPressed(false)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [])

  useEffect(() => {
    const handleWindowPointerMove = (event: PointerEvent) => {
      const guideInteraction = guideInteractionRef.current
      if (guideInteraction && event.pointerId === guideInteraction.pointerId) {
        event.preventDefault()

        const svgPoint = getSvgPointFromClientPoint(event.clientX, event.clientY)
        if (!svgPoint) {
          return
        }

        const nextDraft =
          guideInteraction.mode === 'rotate'
            ? buildGuideRotationDraft(guideInteraction, svgPoint, shiftPressed)
            : guideInteraction.mode === 'translate'
              ? buildGuideTranslateDraft(guideInteraction, svgPoint)
              : buildGuideResizeDraft(guideInteraction, svgPoint)

        if (areGuideTransformDraftsEqual(guideTransformDraftRef.current, nextDraft)) {
          return
        }

        guideTransformDraftRef.current = nextDraft
        setGuideTransformDraft(nextDraft)
        return
      }

      // Item move drag — translate node position by the plan-coord delta
      // since pointerdown. Snap to half-meter (matches wall snap) so dropping
      // items at clean coordinates is the default.
      const itemMove = itemMoveDragRef.current
      if (itemMove && event.pointerId === itemMove.pointerId) {
        event.preventDefault()
        const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
        if (!planPoint) return
        const dx = planPoint[0] - itemMove.startPlan[0]
        const dz = planPoint[1] - itemMove.startPlan[1]
        const nx = snapToHalf(itemMove.initialPos[0] + dx)
        const nz = snapToHalf(itemMove.initialPos[2] + dz)
        updateNode(itemMove.itemId as AnyNodeId, {
          position: [nx, itemMove.initialPos[1], nz],
        })
        return
      }

      // Item rotation drag — angle from item center to cursor.
      const itemRot = itemRotateDragRef.current
      if (itemRot && event.pointerId === itemRot.pointerId) {
        event.preventDefault()
        const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
        if (!planPoint) return
        const dx = planPoint[0] - itemRot.centerPlan[0]
        const dz = planPoint[1] - itemRot.centerPlan[1]
        const currentAngle = Math.atan2(dz, dx)
        let nextRotY =
          itemRot.initialRotY + (currentAngle - itemRot.startAngleFromCenter)
        // Shift = snap to 15°.
        if (shiftPressed) {
          const step = Math.PI / 12 // 15°
          nextRotY = Math.round(nextRotY / step) * step
        }
        const node = useScene.getState().nodes[itemRot.itemId as AnyNodeId] as
          | ItemNode
          | undefined
        if (!node) return
        const [rx, , rz] = node.rotation
        updateNode(itemRot.itemId as AnyNodeId, {
          rotation: [rx, nextRotY, rz],
        })
        return
      }

      // Bulge handle drag (RELATIVE): cursor perpendicular delta from drag
      // start, scaled DOWN by SENSITIVITY so small drags produce small
      // curve changes. Earlier "absolute cursor=apex" model meant the user
      // could only get extreme values (cursor on chord = straight, cursor
      // anywhere else = quickly hits the semicircle clamp) — no usable
      // middle ground.
      //
      // With sensitivity = 0.3, a 1m cursor drag perpendicular changes
      // bulge by (2 * 1m * 0.3) / chord. For a 3.5m wall: 0.17 bulge
      // change per 1m drag. Predictable, gentle, you can land any value.
      const bulgeDrag = wallBulgeDragRef.current
      if (bulgeDrag && event.pointerId === bulgeDrag.pointerId) {
        event.preventDefault()
        const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
        if (!planPoint) return

        const chord = Math.hypot(
          bulgeDrag.end[0] - bulgeDrag.start[0],
          bulgeDrag.end[1] - bulgeDrag.start[1],
        )
        if (chord === 0) return

        // Ritn3D 2026-06-17: ABSOLUTE model with hard cap at semicircle.
        // The bulge handle IS the arc's apex. Its perpendicular distance
        // from the chord equals the sagitta. So:
        //     sagitta = cursor_perp
        //     bulge   = 2 * sagitta / chord = 2 * cursor_perp / chord
        // Hard-clamped to [-1, +1] — never beyond semicircle. When the
        // cursor goes past chord/2 the handle stops moving and the curve
        // sits at exactly semicircle.
        // Relative + sensitivity models all failed because they decoupled
        // cursor position from the visible apex. Absolute = "drag the
        // apex to where you want it."
        const dx = (bulgeDrag.end[0] - bulgeDrag.start[0]) / chord
        const dy = (bulgeDrag.end[1] - bulgeDrag.start[1]) / chord
        const vx = planPoint[0] - bulgeDrag.start[0]
        const vy = planPoint[1] - bulgeDrag.start[1]
        const cursorPerp = vx * -dy + vy * dx

        const raw = (2 * cursorPerp) / chord
        const next = Math.max(-1, Math.min(1, raw))
        bulgeDrag.lastBulge = next

        setWallBulgeDraft({ wallId: bulgeDrag.wallId, bulge: next })
        return
      }

      const dragState = wallEndpointDragRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return
      }

      event.preventDefault()

      const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
      if (!planPoint) {
        return
      }

      const snappedPoint = snapWallDraftPoint({
        point: planPoint,
        walls,
        start: dragState.fixedPoint,
        angleSnap: !shiftPressed,
        ignoreWallIds: [dragState.wallId],
      })

      if (pointsEqual(dragState.currentPoint, snappedPoint)) {
        return
      }

      dragState.currentPoint = snappedPoint
      setCursorPoint(snappedPoint)
      setWallEndpointDraft((previousDraft) => {
        const nextDraft = buildWallEndpointDraft(
          dragState.wallId,
          dragState.endpoint,
          dragState.fixedPoint,
          snappedPoint,
        )

        if (
          !(
            previousDraft &&
            pointsEqual(previousDraft.start, nextDraft.start) &&
            pointsEqual(previousDraft.end, nextDraft.end)
          )
        ) {
          sfxEmitter.emit('sfx:grid-snap')
        }

        return nextDraft
      })
    }

    const commitGuideInteraction = (event: PointerEvent) => {
      const interaction = guideInteractionRef.current
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return
      }

      event.preventDefault()

      const guide = guideById.get(interaction.guideId)
      if (!guide) {
        clearGuideInteraction()
        return
      }

      const svgPoint = getSvgPointFromClientPoint(event.clientX, event.clientY)
      const nextDraft = svgPoint
        ? interaction.mode === 'rotate'
          ? buildGuideRotationDraft(interaction, svgPoint, shiftPressed)
          : interaction.mode === 'translate'
            ? buildGuideTranslateDraft(interaction, svgPoint)
            : buildGuideResizeDraft(interaction, svgPoint)
        : guideTransformDraftRef.current

      if (nextDraft && !doesGuideMatchDraft(guide, nextDraft)) {
        updateNode(guide.id, {
          position: [nextDraft.position[0], guide.position[1], nextDraft.position[1]] as [
            number,
            number,
            number,
          ],
          rotation: [guide.rotation[0], nextDraft.rotation, guide.rotation[2]] as [
            number,
            number,
            number,
          ],
          scale: nextDraft.scale,
        })
      }

      clearGuideInteraction()
    }

    const cancelGuideInteraction = (event: PointerEvent) => {
      const interaction = guideInteractionRef.current
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return
      }

      clearGuideInteraction()
    }

    const commitWallEndpointDrag = (event: PointerEvent) => {
      const dragState = wallEndpointDragRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return
      }

      const wall = wallById.get(dragState.wallId)
      if (wall) {
        const nextDraft = buildWallEndpointDraft(
          dragState.wallId,
          dragState.endpoint,
          dragState.fixedPoint,
          dragState.currentPoint,
        )
        const hasChanged = !(
          pointsEqual(nextDraft.start, wall.start) && pointsEqual(nextDraft.end, wall.end)
        )

        if (hasChanged && isWallLongEnough(nextDraft.start, nextDraft.end)) {
          updateNode(wall.id, {
            start: nextDraft.start,
            end: nextDraft.end,
          })
          sfxEmitter.emit('sfx:structure-build')
        }
      }

      clearWallEndpointDrag()
      setCursorPoint(null)
    }

    const cancelWallEndpointDrag = (event: PointerEvent) => {
      const dragState = wallEndpointDragRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return
      }

      clearWallEndpointDrag()
      setCursorPoint(null)
    }

    const commitWallBulgeDrag = (event: PointerEvent) => {
      const dragState = wallBulgeDragRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) return
      const wall = wallById.get(dragState.wallId)
      if (wall) {
        const finalBulge = isStraight(dragState.lastBulge) ? 0 : dragState.lastBulge
        // Diagnostic: print the actual numeric values so a "the curve is
        // still too big" complaint can be debugged. chord = wall length,
        // sagitta = the perpendicular bulge height in plan units (meters).
        // bulge ~= 2 * sagitta / chord; small visible curve = small sagitta.
        const chord = Math.hypot(
          wall.end[0] - wall.start[0],
          wall.end[1] - wall.start[1],
        )
        const sagitta = (chord * Math.abs(finalBulge)) / 2
        // eslint-disable-next-line no-console
        console.log('[bulge] commit', {
          bulge: finalBulge.toFixed(4),
          chord_m: chord.toFixed(3),
          sagitta_m: sagitta.toFixed(3),
        })
        if ((wall.bulge ?? 0) !== finalBulge) {
          updateNode(wall.id, { bulge: finalBulge })
          sfxEmitter.emit('sfx:structure-build')
        }
      }
      setWallBulgeDraft(null)
      clearWallBulgeDrag()
    }

    const cancelWallBulgeDrag = (event: PointerEvent) => {
      const dragState = wallBulgeDragRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) return
      clearWallBulgeDrag()
    }

    // Item move + rotate drag cleanup. Position/rotation are already updated
    // live in the move handler; this just clears the drag state so the next
    // pointer events go through the normal selection/click path.
    const clearItemMoveOrRotate = (event: PointerEvent) => {
      const m = itemMoveDragRef.current
      if (m && event.pointerId === m.pointerId) itemMoveDragRef.current = null
      const r = itemRotateDragRef.current
      if (r && event.pointerId === r.pointerId) itemRotateDragRef.current = null
    }

    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', commitGuideInteraction)
    window.addEventListener('pointercancel', cancelGuideInteraction)
    window.addEventListener('pointerup', commitWallEndpointDrag)
    window.addEventListener('pointercancel', cancelWallEndpointDrag)
    window.addEventListener('pointerup', commitWallBulgeDrag)
    window.addEventListener('pointercancel', cancelWallBulgeDrag)
    window.addEventListener('pointerup', clearItemMoveOrRotate)
    window.addEventListener('pointercancel', clearItemMoveOrRotate)

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', commitGuideInteraction)
      window.removeEventListener('pointercancel', cancelGuideInteraction)
      window.removeEventListener('pointerup', commitWallEndpointDrag)
      window.removeEventListener('pointercancel', cancelWallEndpointDrag)
      window.removeEventListener('pointerup', commitWallBulgeDrag)
      window.removeEventListener('pointercancel', cancelWallBulgeDrag)
      window.removeEventListener('pointerup', clearItemMoveOrRotate)
      window.removeEventListener('pointercancel', clearItemMoveOrRotate)
    }
  }, [
    clearGuideInteraction,
    clearWallBulgeDrag,
    clearWallEndpointDrag,
    getSvgPointFromClientPoint,
    guideById,
    getPlanPointFromClientPoint,
    shiftPressed,
    updateNode,
    wallById,
    walls,
  ])

  // biome-ignore lint/correctness/useExhaustiveDependencies: clear drag state when level changes
  useEffect(() => {
    clearWallEndpointDrag()
  }, [clearWallEndpointDrag, levelId])

  useEffect(() => {
    if (shouldShowSiteBoundaryHandles) {
      return
    }

    clearSiteBoundaryInteraction()
  }, [clearSiteBoundaryInteraction, shouldShowSiteBoundaryHandles])

  useEffect(() => {
    if (shouldShowSlabBoundaryHandles) {
      return
    }

    clearSlabBoundaryInteraction()
  }, [clearSlabBoundaryInteraction, shouldShowSlabBoundaryHandles])

  useEffect(() => {
    if (shouldShowZoneBoundaryHandles) {
      return
    }

    clearZoneBoundaryInteraction()
  }, [clearZoneBoundaryInteraction, shouldShowZoneBoundaryHandles])

  useEffect(() => {
    const dragState = siteVertexDragState
    if (!dragState) {
      return
    }

    const handleWindowPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return
      }

      event.preventDefault()

      const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
      if (!planPoint) {
        return
      }

      const snappedPoint: WallPlanPoint = [snapToHalf(planPoint[0]), snapToHalf(planPoint[1])]
      setCursorPoint(snappedPoint)

      setSiteBoundaryDraft((currentDraft) => {
        if (!currentDraft || currentDraft.siteId !== dragState.siteId) {
          return currentDraft
        }

        const currentPoint = currentDraft.polygon[dragState.vertexIndex]
        if (currentPoint && pointsEqual(currentPoint, snappedPoint)) {
          return currentDraft
        }

        sfxEmitter.emit('sfx:grid-snap')

        const nextPolygon = [...currentDraft.polygon]
        nextPolygon[dragState.vertexIndex] = snappedPoint

        return {
          ...currentDraft,
          polygon: nextPolygon,
        }
      })
    }

    const commitSiteVertexDrag = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return
      }

      const draft = siteBoundaryDraftRef.current
      if (
        draft &&
        site &&
        draft.siteId === site.id &&
        !polygonsEqual(draft.polygon, site.polygon?.points ?? [])
      ) {
        const suppressClick = (clickEvent: MouseEvent) => {
          clickEvent.stopImmediatePropagation()
          clickEvent.preventDefault()
          window.removeEventListener('click', suppressClick, true)
        }
        window.addEventListener('click', suppressClick, true)
        requestAnimationFrame(() => {
          window.removeEventListener('click', suppressClick, true)
        })

        updateNode(draft.siteId, {
          polygon: {
            type: 'polygon',
            points: draft.polygon,
          },
        })
        sfxEmitter.emit('sfx:structure-build')
      }

      clearSiteBoundaryInteraction()
      setCursorPoint(null)
    }

    const cancelSiteVertexDrag = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return
      }

      clearSiteBoundaryInteraction()
      setCursorPoint(null)
    }

    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', commitSiteVertexDrag)
    window.addEventListener('pointercancel', cancelSiteVertexDrag)

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', commitSiteVertexDrag)
      window.removeEventListener('pointercancel', cancelSiteVertexDrag)
    }
  }, [
    clearSiteBoundaryInteraction,
    getPlanPointFromClientPoint,
    site,
    siteVertexDragState,
    updateNode,
  ])

  useEffect(() => {
    const dragState = slabVertexDragState
    if (!dragState) {
      return
    }

    const handleWindowPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return
      }

      event.preventDefault()

      const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
      if (!planPoint) {
        return
      }

      const snappedPoint: WallPlanPoint = [snapToHalf(planPoint[0]), snapToHalf(planPoint[1])]
      setCursorPoint(snappedPoint)

      setSlabBoundaryDraft((currentDraft) => {
        if (!currentDraft || currentDraft.slabId !== dragState.slabId) {
          return currentDraft
        }

        const currentPoint = currentDraft.polygon[dragState.vertexIndex]
        if (currentPoint && pointsEqual(currentPoint, snappedPoint)) {
          return currentDraft
        }

        sfxEmitter.emit('sfx:grid-snap')

        const nextPolygon = [...currentDraft.polygon]
        nextPolygon[dragState.vertexIndex] = snappedPoint

        return {
          ...currentDraft,
          polygon: nextPolygon,
        }
      })
    }

    const commitSlabVertexDrag = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return
      }

      const draft = slabBoundaryDraftRef.current
      const slab = slabById.get(dragState.slabId)
      if (draft && slab && !polygonsEqual(draft.polygon, slab.polygon)) {
        const suppressClick = (clickEvent: MouseEvent) => {
          clickEvent.stopImmediatePropagation()
          clickEvent.preventDefault()
          window.removeEventListener('click', suppressClick, true)
        }
        window.addEventListener('click', suppressClick, true)
        requestAnimationFrame(() => {
          window.removeEventListener('click', suppressClick, true)
        })

        updateNode(draft.slabId, {
          polygon: draft.polygon,
        })
        sfxEmitter.emit('sfx:structure-build')
      }

      clearSlabBoundaryInteraction()
      setCursorPoint(null)
    }

    const cancelSlabVertexDrag = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return
      }

      clearSlabBoundaryInteraction()
      setCursorPoint(null)
    }

    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', commitSlabVertexDrag)
    window.addEventListener('pointercancel', cancelSlabVertexDrag)

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', commitSlabVertexDrag)
      window.removeEventListener('pointercancel', cancelSlabVertexDrag)
    }
  }, [
    clearSlabBoundaryInteraction,
    getPlanPointFromClientPoint,
    slabById,
    slabVertexDragState,
    updateNode,
  ])

  useEffect(() => {
    const dragState = zoneVertexDragState
    if (!dragState) {
      return
    }

    const handleWindowPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return
      }

      event.preventDefault()

      const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
      if (!planPoint) {
        return
      }

      const snappedPoint: WallPlanPoint = [snapToHalf(planPoint[0]), snapToHalf(planPoint[1])]
      setCursorPoint(snappedPoint)

      setZoneBoundaryDraft((currentDraft) => {
        if (!currentDraft || currentDraft.zoneId !== dragState.zoneId) {
          return currentDraft
        }

        const currentPoint = currentDraft.polygon[dragState.vertexIndex]
        if (currentPoint && pointsEqual(currentPoint, snappedPoint)) {
          return currentDraft
        }

        sfxEmitter.emit('sfx:grid-snap')

        const nextPolygon = [...currentDraft.polygon]
        nextPolygon[dragState.vertexIndex] = snappedPoint

        return {
          ...currentDraft,
          polygon: nextPolygon,
        }
      })
    }

    const commitZoneVertexDrag = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return
      }

      const draft = zoneBoundaryDraftRef.current
      const zone = zoneById.get(dragState.zoneId)
      if (draft && zone && !polygonsEqual(draft.polygon, zone.polygon)) {
        const suppressClick = (clickEvent: MouseEvent) => {
          clickEvent.stopImmediatePropagation()
          clickEvent.preventDefault()
          window.removeEventListener('click', suppressClick, true)
        }
        window.addEventListener('click', suppressClick, true)
        requestAnimationFrame(() => {
          window.removeEventListener('click', suppressClick, true)
        })

        updateNode(draft.zoneId, {
          polygon: draft.polygon,
        })
        sfxEmitter.emit('sfx:structure-build')
      }

      clearZoneBoundaryInteraction()
      setCursorPoint(null)
    }

    const cancelZoneVertexDrag = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return
      }

      clearZoneBoundaryInteraction()
      setCursorPoint(null)
    }

    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', commitZoneVertexDrag)
    window.addEventListener('pointercancel', cancelZoneVertexDrag)

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', commitZoneVertexDrag)
      window.removeEventListener('pointercancel', cancelZoneVertexDrag)
    }
  }, [
    clearZoneBoundaryInteraction,
    getPlanPointFromClientPoint,
    updateNode,
    zoneById,
    zoneVertexDragState,
  ])

  useEffect(() => {
    return () => {
      setFloorplanHovered(false)
    }
  }, [setFloorplanHovered])

  const handlePointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 2) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    panStateRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    }
    setIsPanning(true)

    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const endPanning = useCallback((event?: ReactPointerEvent<SVGSVGElement>) => {
    if (event && panStateRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    panStateRef.current = null
    setIsPanning(false)
  }, [])

  const hoveredWallIdRef = useRef<string | null>(null)
  const emitFloorplanWallLeave = useCallback((wallId: string | null) => {
    if (!wallId) {
      return
    }

    const wallNode = useScene.getState().nodes[wallId as AnyNodeId]
    if (!wallNode || wallNode.type !== 'wall') {
      return
    }

    emitter.emit('wall:leave', {
      node: wallNode,
      position: [0, 0, 0],
      localPosition: [0, 0, 0],
      stopPropagation: () => {},
    } as any)
  }, [])

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (panStateRef.current?.pointerId === event.pointerId) {
        const deltaX = event.clientX - panStateRef.current.clientX
        const deltaY = event.clientY - panStateRef.current.clientY
        const worldPerPixelX = viewBox.width / surfaceSize.width
        const worldPerPixelY = viewBox.height / surfaceSize.height

        updateViewport({
          centerX: (viewport ?? fittedViewport).centerX - deltaX * worldPerPixelX,
          centerY: (viewport ?? fittedViewport).centerY - deltaY * worldPerPixelY,
          width: (viewport ?? fittedViewport).width,
        })

        panStateRef.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
        }
        setCursorPoint(null)
        return
      }

      if (guideInteractionRef.current?.pointerId === event.pointerId) {
        return
      }

      if (wallEndpointDragRef.current?.pointerId === event.pointerId) {
        return
      }

      if (slabVertexDragState?.pointerId === event.pointerId) {
        return
      }

      if (siteVertexDragState?.pointerId === event.pointerId) {
        return
      }

      if (zoneVertexDragState?.pointerId === event.pointerId) {
        return
      }

      const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
      if (!planPoint) {
        return
      }

      if (isPolygonBuildActive) {
        const snappedPoint = snapPolygonDraftPoint({
          point: planPoint,
          start: activePolygonDraftPoints[activePolygonDraftPoints.length - 1],
          angleSnap: activePolygonDraftPoints.length > 0 && !shiftPressed,
        })

        setCursorPoint((previousPoint) => {
          const hasChanged = !(previousPoint && pointsEqual(previousPoint, snappedPoint))
          if (hasChanged && activePolygonDraftPoints.length > 0) {
            sfxEmitter.emit('sfx:grid-snap')
          }
          return snappedPoint
        })
        return
      }

      if (isOpeningPlacementActive) {
        const closest = findClosestWallPoint(planPoint, walls)
        if (closest) {
          // Arc-aware: closest.t is arc-length-parametric (0..1) per
          // findClosestWallPoint, and the wall's effective length is arc
          // length. For straight walls bulge=0 -> arcLength collapses to the
          // chord, byte-identical to the legacy path.
          const length = arcLength(closest.wall.start, closest.wall.end, closest.wall.bulge ?? 0)
          const distance = closest.t * length

          const wallEvent = {
            node: closest.wall,
            point: { x: closest.point[0], y: 0, z: closest.point[1] },
            localPosition: [distance, floorplanOpeningLocalY, 0] as [number, number, number],
            normal: closest.normal,
            stopPropagation: () => {},
          }

          if (hoveredWallIdRef.current !== closest.wall.id) {
            if (hoveredWallIdRef.current) {
              emitFloorplanWallLeave(hoveredWallIdRef.current)
            }
            hoveredWallIdRef.current = closest.wall.id
            emitter.emit('wall:enter', wallEvent as any)
          } else {
            emitter.emit('wall:move', wallEvent as any)
          }
        } else if (hoveredWallIdRef.current) {
          emitFloorplanWallLeave(hoveredWallIdRef.current)
          hoveredWallIdRef.current = null
        }
        return
      }

      // Arc-wall pointer move: phase 1 updates the end-preview the same way
      // a straight wall does; phase 2 updates the bulge midpoint (no grid snap
      // here — the bulge is a free perpendicular offset, snapping would feel
      // sticky and ugly on shallow curves).
      if (isArcWallBuildActive) {
        if (!arcDraftStart) {
          // Phase 0: just show the cursor at the snapped grid point.
          const cursor = snapPointToGrid(planPoint)
          setCursorPoint(cursor)
          return
        }
        if (!arcDraftEnd) {
          // Phase 1: live straight-line preview from start to cursor.
          const cursor = snapWallDraftPoint({
            point: planPoint,
            walls,
            start: arcDraftStart,
            angleSnap: !shiftPressed,
          })
          setCursorPoint(cursor)
          return
        }
        // Phase 2: cursor drives the bulge midpoint. No grid snap (continuous
        // adjustment); no SFX (would fire on every pixel).
        setArcBulgePoint(planPoint)
        setCursorPoint(planPoint)
        return
      }

      if (!isWallBuildActive) {
        setCursorPoint(null)
        return
      }

      const snappedPoint = snapWallDraftPoint({
        point: planPoint,
        walls,
        start: draftStart ?? undefined,
        angleSnap: Boolean(draftStart) && !shiftPressed,
      })

      setCursorPoint(snappedPoint)

      if (!draftStart) {
        return
      }

      setDraftEnd((previousEnd) => {
        if (
          !previousEnd ||
          previousEnd[0] !== snappedPoint[0] ||
          previousEnd[1] !== snappedPoint[1]
        ) {
          sfxEmitter.emit('sfx:grid-snap')
        }

        return snappedPoint
      })
    },
    [
      arcDraftEnd,
      arcDraftStart,
      draftStart,
      emitFloorplanWallLeave,
      floorplanOpeningLocalY,
      fittedViewport,
      getPlanPointFromClientPoint,
      activePolygonDraftPoints,
      isArcWallBuildActive,
      isOpeningPlacementActive,
      isPolygonBuildActive,
      isWallBuildActive,
      siteVertexDragState,
      slabVertexDragState,
      shiftPressed,
      surfaceSize.height,
      surfaceSize.width,
      updateViewport,
      viewBox.height,
      viewBox.width,
      viewport,
      walls,
      zoneVertexDragState,
    ],
  )

  const handleSlabPlacementPoint = useCallback(
    (point: WallPlanPoint) => {
      const lastPoint = slabDraftPoints[slabDraftPoints.length - 1]
      if (lastPoint && pointsEqual(lastPoint, point)) {
        return
      }

      const firstPoint = slabDraftPoints[0]
      if (firstPoint && slabDraftPoints.length >= 3 && isPointNearPlanPoint(point, firstPoint)) {
        createSlabOnCurrentLevel(slabDraftPoints)
        clearDraft()
        return
      }

      setSlabDraftPoints((currentPoints) => [...currentPoints, point])
      setCursorPoint(point)
    },
    [clearDraft, createSlabOnCurrentLevel, slabDraftPoints],
  )
  const handleSlabPlacementConfirm = useCallback(
    (point?: WallPlanPoint) => {
      const firstPoint = slabDraftPoints[0]
      const lastPoint = slabDraftPoints[slabDraftPoints.length - 1]

      let nextPoints = slabDraftPoints
      if (point) {
        const isClosingExistingPolygon = Boolean(
          firstPoint && slabDraftPoints.length >= 3 && isPointNearPlanPoint(point, firstPoint),
        )
        const isDuplicatePoint = Boolean(lastPoint && pointsEqual(lastPoint, point))

        if (!(isClosingExistingPolygon || isDuplicatePoint)) {
          nextPoints = [...slabDraftPoints, point]
        }
      }

      if (nextPoints.length < 3) {
        return
      }

      createSlabOnCurrentLevel(nextPoints)
      clearDraft()
    },
    [clearDraft, createSlabOnCurrentLevel, slabDraftPoints],
  )
  const handleZonePlacementPoint = useCallback(
    (point: WallPlanPoint) => {
      const lastPoint = zoneDraftPoints[zoneDraftPoints.length - 1]
      if (lastPoint && pointsEqual(lastPoint, point)) {
        return
      }

      const firstPoint = zoneDraftPoints[0]
      if (firstPoint && zoneDraftPoints.length >= 3 && isPointNearPlanPoint(point, firstPoint)) {
        createZoneOnCurrentLevel(zoneDraftPoints)
        clearDraft()
        return
      }

      setZoneDraftPoints((currentPoints) => [...currentPoints, point])
      setCursorPoint(point)
    },
    [clearDraft, createZoneOnCurrentLevel, zoneDraftPoints],
  )
  const handleZonePlacementConfirm = useCallback(
    (point?: WallPlanPoint) => {
      const firstPoint = zoneDraftPoints[0]
      const lastPoint = zoneDraftPoints[zoneDraftPoints.length - 1]

      let nextPoints = zoneDraftPoints
      if (point) {
        const isClosingExistingPolygon = Boolean(
          firstPoint && zoneDraftPoints.length >= 3 && isPointNearPlanPoint(point, firstPoint),
        )
        const isDuplicatePoint = Boolean(lastPoint && pointsEqual(lastPoint, point))

        if (!(isClosingExistingPolygon || isDuplicatePoint)) {
          nextPoints = [...zoneDraftPoints, point]
        }
      }

      if (nextPoints.length < 3) {
        return
      }

      createZoneOnCurrentLevel(nextPoints)
      clearDraft()
    },
    [clearDraft, createZoneOnCurrentLevel, zoneDraftPoints],
  )

  const handleWallPlacementPoint = useCallback(
    (point: WallPlanPoint) => {
      if (!draftStart) {
        setDraftStart(point)
        setDraftEnd(point)
        setCursorPoint(point)
        return
      }

      if (!isWallLongEnough(draftStart, point)) {
        return
      }

      createWallOnCurrentLevel(draftStart, point)
      clearDraft()
    },
    [clearDraft, draftStart],
  )

  // Arc-wall: 3-step placement. Click 1 sets start, click 2 sets end (with
  // straight preview during phase 1), click 3 commits the arc whose bulge was
  // tracked by the cursor during phase 2 (see handleSvgPointerMove).
  // - Phase 1->2: end snapped, switch to bulge-picking mode.
  // - Phase 2 commit: derive bulge from (start, end, current bulge midpoint),
  //   write the wall with that bulge, clear state.
  // Arc-wall placement: same 2-click flow as the regular Wall tool. Wall
  // commits as STRAIGHT, then is auto-selected so its bulge handle (the
  // accent dot at the midpoint) is immediately visible — user drags it to
  // bend the wall into a curve. Discoverable because they already know the
  // bulge handle from selected walls; no third click, no hidden mode.
  //
  // The selection is queued with a microtask (queueMicrotask) instead of
  // called inline. Inline setSelection mid-tick caused a React warning
  // "Cannot update a component (PanelManager) while rendering" because
  // multiple Zustand stores were churning in the same synchronous burst
  // (createNode → selection → reference reset), and the next pointer event
  // would land in a stale closure with no listeners. Deferring breaks that
  // cycle cleanly.
  const handleArcWallPlacementPoint = useCallback(
    (point: WallPlanPoint) => {
      if (!arcDraftStart) {
        setArcDraftStart(point)
        setArcDraftEnd(point)
        setArcBulgePoint(null)
        setCursorPoint(point)
        return
      }
      if (!isWallLongEnough(arcDraftStart, point)) return
      const wall = createWallOnCurrentLevel(arcDraftStart, point, 0)
      clearDraft()
      if (wall) {
        queueMicrotask(() => {
          useViewer.getState().setSelection({ selectedIds: [wall.id] })
          // EXIT the arc-wall tool back to select mode so the next click
          // doesn't start a new wall. User's complaint: "the cursor goes
          // back to wall start mode" — that's because tool stayed
          // 'arc-wall' and any canvas click placed a new start point,
          // making the bulge handle unreachable in practice. After this:
          // - Cursor returns to normal pointer
          // - The bulge handle is the only interactive thing on the wall
          // - To draw another arc wall, user clicks Arc Wall in the toolbar
          //   again.
          setTool(null)
          setMode('select')
        })
      }
    },
    [arcDraftStart, clearDraft, setMode, setTool],
  )

  const handleBackgroundClick = useCallback(
    (event: ReactMouseEvent<SVGSVGElement>) => {
      if (isPolygonBuildActive && event.detail >= 2) {
        return
      }

      const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
      if (!planPoint) {
        return
      }

      // Trace-scale calibration: clicks become reference-line points instead
      // of tool actions. First click sets P1, second sets P2 and surfaces the
      // distance input. A third click after P2 is set restarts (drop both,
      // start over) — convenient if the user mis-clicked.
      if (calibratingGuideId) {
        event.preventDefault?.()
        if (!calibrationP1) {
          setCalibrationP1(planPoint)
          return
        }
        if (!calibrationP2) {
          setCalibrationP2(planPoint)
          return
        }
        // Both already set — restart.
        setCalibrationP1(planPoint)
        setCalibrationP2(null)
        return
      }

      if (isOpeningPlacementActive) {
        const closest = findClosestWallPoint(planPoint, walls)
        if (closest) {
          // Arc-aware: closest.t is arc-length-parametric (0..1) per
          // findClosestWallPoint, and the wall's effective length is arc
          // length. For straight walls bulge=0 -> arcLength collapses to the
          // chord, byte-identical to the legacy path.
          const length = arcLength(closest.wall.start, closest.wall.end, closest.wall.bulge ?? 0)
          const distance = closest.t * length

          emitter.emit('wall:click', {
            node: closest.wall,
            point: { x: closest.point[0], y: 0, z: closest.point[1] },
            localPosition: [distance, floorplanOpeningLocalY, 0],
            normal: closest.normal,
            stopPropagation: () => {},
          } as any)
        }
        return
      }

      if (isPolygonBuildActive) {
        const snappedPoint = snapPolygonDraftPoint({
          point: planPoint,
          start: activePolygonDraftPoints[activePolygonDraftPoints.length - 1],
          angleSnap: activePolygonDraftPoints.length > 0 && !shiftPressed,
        })

        if (isZoneBuildActive) {
          handleZonePlacementPoint(snappedPoint)
        } else {
          handleSlabPlacementPoint(snappedPoint)
        }
        return
      }

      if (canSelectFloorplanZones) {
        const zoneHit = visibleZonePolygons.find(({ polygon }) =>
          isPointInsidePolygon(toPoint2D(planPoint), polygon),
        )
        if (zoneHit) {
          setSelectedReferenceId(null)
          setSelection({ zoneId: zoneHit.zone.id })
          return
        }
      }

      // Arc-wall tool: 3-step placement. Phase 0/1 use the same snap as the
      // straight wall tool; phase 2 (bulge) does NOT angle-snap because the
      // arc midpoint isn't directional, just an offset.
      if (isArcWallBuildActive) {
        const inPhase2 = Boolean(arcDraftStart && arcDraftEnd)
        const snappedPoint = inPhase2
          ? snapPointToGrid(planPoint)
          : snapWallDraftPoint({
              point: planPoint,
              walls,
              start: arcDraftStart ?? undefined,
              angleSnap: Boolean(arcDraftStart) && !shiftPressed,
            })
        handleArcWallPlacementPoint(snappedPoint)
        return
      }

      if (!isWallBuildActive) {
        if (structureLayer === 'zones') {
          setSelectedReferenceId(null)
          setSelection({ zoneId: null })
        } else {
          setSelectedReferenceId(null)
          setSelection({ selectedIds: [] })
        }
        return
      }

      const snappedPoint = snapWallDraftPoint({
        point: planPoint,
        walls,
        start: draftStart ?? undefined,
        angleSnap: Boolean(draftStart) && !shiftPressed,
      })

      handleWallPlacementPoint(snappedPoint)
    },
    [
      arcDraftEnd,
      arcDraftStart,
      calibratingGuideId,
      calibrationP1,
      calibrationP2,
      draftStart,
      floorplanOpeningLocalY,
      getPlanPointFromClientPoint,
      activePolygonDraftPoints,
      canSelectFloorplanZones,
      handleArcWallPlacementPoint,
      handleSlabPlacementPoint,
      handleZonePlacementPoint,
      handleWallPlacementPoint,
      isArcWallBuildActive,
      isOpeningPlacementActive,
      isPolygonBuildActive,
      isWallBuildActive,
      isZoneBuildActive,
      setSelectedReferenceId,
      setSelection,
      shiftPressed,
      structureLayer,
      visibleZonePolygons,
      walls,
    ],
  )
  const handleBackgroundDoubleClick = useCallback(
    (event: ReactMouseEvent<SVGSVGElement>) => {
      if (!isPolygonBuildActive) {
        return
      }

      const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
      if (!planPoint) {
        return
      }

      const snappedPoint = snapPolygonDraftPoint({
        point: planPoint,
        start: activePolygonDraftPoints[activePolygonDraftPoints.length - 1],
        angleSnap: activePolygonDraftPoints.length > 0 && !shiftPressed,
      })

      if (isZoneBuildActive) {
        handleZonePlacementConfirm(snappedPoint)
      } else {
        handleSlabPlacementConfirm(snappedPoint)
      }
    },
    [
      activePolygonDraftPoints,
      getPlanPointFromClientPoint,
      handleSlabPlacementConfirm,
      handleZonePlacementConfirm,
      isPolygonBuildActive,
      isZoneBuildActive,
      shiftPressed,
    ],
  )

  const commitFloorplanSelection = useCallback(
    (nextSelectedIds: string[]) => {
      if (!(levelId && levelNode) || levelNode.type !== 'level') {
        setSelectedReferenceId(null)
        setSelection({ selectedIds: nextSelectedIds })
        return
      }

      const { selection } = useViewer.getState()
      const nodes = useScene.getState().nodes
      const updates: Parameters<typeof setSelection>[0] = {
        selectedIds: nextSelectedIds,
      }

      if (levelId !== selection.levelId) {
        updates.levelId = levelId
      }

      const parentNode = levelNode.parentId ? nodes[levelNode.parentId as AnyNodeId] : null
      if (parentNode?.type === 'building' && parentNode.id !== selection.buildingId) {
        updates.buildingId = parentNode.id
      }

      setSelectedReferenceId(null)
      setSelection(updates)
    },
    [levelId, levelNode, setSelectedReferenceId, setSelection],
  )

  const addFloorplanSelection = useCallback(
    (nextSelectedIds: string[], modifierKeys?: { meta: boolean; ctrl: boolean }) => {
      const shouldAppend = Boolean(modifierKeys?.meta || modifierKeys?.ctrl)

      if (shouldAppend) {
        if (nextSelectedIds.length === 0) {
          return
        }

        const currentSelectedIds = useViewer.getState().selection.selectedIds
        commitFloorplanSelection(Array.from(new Set([...currentSelectedIds, ...nextSelectedIds])))
        return
      }

      commitFloorplanSelection(nextSelectedIds)
    },
    [commitFloorplanSelection],
  )

  const toggleFloorplanSelection = useCallback(
    (nodeId: string, modifierKeys?: { meta: boolean; ctrl: boolean }) => {
      const shouldToggle = Boolean(modifierKeys?.meta || modifierKeys?.ctrl)

      if (shouldToggle) {
        const currentSelectedIds = useViewer.getState().selection.selectedIds
        commitFloorplanSelection(
          currentSelectedIds.includes(nodeId)
            ? currentSelectedIds.filter((selectedId) => selectedId !== nodeId)
            : [...currentSelectedIds, nodeId],
        )
        return
      }

      commitFloorplanSelection([nodeId])
    },
    [commitFloorplanSelection],
  )

  const getFloorplanHitIdAtPoint = useCallback(
    (planPoint: WallPlanPoint) => {
      const point = toPoint2D(planPoint)

      const openingHit = openingsPolygons.find(({ polygon }) => {
        if (isPointInsidePolygon(point, polygon)) {
          return true
        }

        const centerLine = getOpeningCenterLine(polygon)
        if (!centerLine) {
          return false
        }

        return (
          getDistanceToWallSegment(
            point,
            [centerLine.start.x, centerLine.start.y],
            [centerLine.end.x, centerLine.end.y],
          ) <= floorplanOpeningHitTolerance
        )
      })
      if (openingHit) {
        return openingHit.opening.id
      }

      const wallHit = displayWallPolygons.find(
        ({ wall, polygon }) =>
          isPointInsidePolygon(point, polygon) ||
          getDistanceToWallSegment(point, wall.start, wall.end) <= floorplanWallHitTolerance,
      )
      if (wallHit) {
        return wallHit.wall.id
      }

      const slabHit = displaySlabPolygons.find(({ polygon, holes }) =>
        isPointInsidePolygonWithHoles(point, polygon, holes),
      )
      if (slabHit) {
        return slabHit.slab.id
      }

      return null
    },
    [
      displaySlabPolygons,
      displayWallPolygons,
      floorplanOpeningHitTolerance,
      floorplanWallHitTolerance,
      openingsPolygons,
    ],
  )

  const getFloorplanSelectionIdsInBounds = useCallback(
    (bounds: FloorplanSelectionBounds) => {
      const wallIds = displayWallPolygons
        .filter(({ polygon }) => doesPolygonIntersectSelectionBounds(polygon, bounds))
        .map(({ wall }) => wall.id)
      const openingIds = openingsPolygons
        .filter(({ polygon }) => doesPolygonIntersectSelectionBounds(polygon, bounds))
        .map(({ opening }) => opening.id)
      const slabIds = displaySlabPolygons
        .filter(({ polygon }) => doesPolygonIntersectSelectionBounds(polygon, bounds))
        .map(({ slab }) => slab.id)

      return Array.from(new Set([...wallIds, ...openingIds, ...slabIds]))
    },
    [displaySlabPolygons, displayWallPolygons, openingsPolygons],
  )

  const handleWallSelect = useCallback(
    (wall: WallNode) => {
      // Ritn3D: delete mode — delete wall on click
      if (useEditor.getState().mode === 'delete') {
        sfxEmitter.emit('sfx:structure-delete')
        useScene.getState().deleteNode(wall.id as AnyNodeId)
        return
      }
      commitFloorplanSelection([wall.id])
    },
    [commitFloorplanSelection],
  )

  const handleWallClick = useCallback(
    (wall: WallNode, event: ReactMouseEvent<SVGElement>) => {
      // Ritn3D: delete mode — delete wall on click
      if (useEditor.getState().mode === 'delete') {
        event.stopPropagation()
        sfxEmitter.emit('sfx:structure-delete')
        useScene.getState().deleteNode(wall.id as AnyNodeId)
        return
      }

      const centerX = (wall.start[0] + wall.end[0]) / 2
      const centerZ = (wall.start[1] + wall.end[1]) / 2
      const halfLength = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]) / 2
      const localY = isOpeningPlacementActive ? floorplanOpeningLocalY : 0

      setSelectedReferenceId(null)
      emitter.emit('wall:click', {
        node: wall,
        position: [centerX, 0, centerZ],
        localPosition: [halfLength, localY, 0],
        stopPropagation: () => event.stopPropagation(),
        nativeEvent: event.nativeEvent as any,
      } as any)
    },
    [floorplanOpeningLocalY, isOpeningPlacementActive, setSelectedReferenceId],
  )

  const handleWallDoubleClick = useCallback(
    (wall: WallNode, event: ReactMouseEvent<SVGElement>) => {
      const centerX = (wall.start[0] + wall.end[0]) / 2
      const centerZ = (wall.start[1] + wall.end[1]) / 2
      const halfLength = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]) / 2

      emitter.emit('wall:double-click', {
        node: wall,
        position: [centerX, 0, centerZ],
        localPosition: [halfLength, 0, 0],
        stopPropagation: () => event.stopPropagation(),
        nativeEvent: event.nativeEvent as any,
      } as any)
      emitter.emit('camera-controls:focus', { nodeId: wall.id })
    },
    [],
  )
  const emitFloorplanNodeClick = useCallback(
    (
      nodeId: SlabNode['id'] | OpeningNode['id'] | ZoneNodeType['id'],
      event: ReactMouseEvent<SVGElement>,
    ) => {
      const node = useScene.getState().nodes[nodeId as AnyNodeId]
      if (
        !(
          node &&
          (node.type === 'slab' ||
            node.type === 'door' ||
            node.type === 'window' ||
            node.type === 'zone')
        )
      ) {
        return
      }

      // Ritn3D: delete mode — delete node on click
      if (useEditor.getState().mode === 'delete') {
        sfxEmitter.emit('sfx:structure-delete')
        const parentId = node.parentId
        useScene.getState().deleteNode(nodeId as AnyNodeId)
        if (parentId) useScene.getState().dirtyNodes.add(parentId as AnyNodeId)
        return
      }

      setSelectedReferenceId(null)
      emitter.emit(
        `${node.type}:click` as any,
        {
          localPosition: [0, 0, 0],
          nativeEvent: event.nativeEvent as any,
          node,
          position: [0, 0, 0],
          stopPropagation: () => event.stopPropagation(),
        } as any,
      )
    },
    [setSelectedReferenceId],
  )
  const handleGuideSelect = useCallback(
    (guideId: GuideNode['id']) => {
      setSelectedReferenceId(guideId)
      setSelection({ selectedIds: [], zoneId: null })
    },
    [setSelectedReferenceId, setSelection],
  )
  const handleGuideCornerPointerDown = useCallback(
    (
      guide: GuideNode,
      dimensions: GuideImageDimensions,
      corner: GuideCorner,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0 || !canInteractWithGuides) {
        return
      }

      const aspectRatio = dimensions.width / dimensions.height
      if (!(aspectRatio > 0)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      setHoveredGuideCorner(null)
      handleGuideSelect(guide.id)

      const centerSvg = getGuideCenterSvgPoint(guide)
      const rotationSvg = -guide.rotation[1]
      const width = getGuideWidth(guide.scale)
      const height = getGuideHeight(width, aspectRatio)
      const [cornerOffsetX, cornerOffsetY] = getGuideCornerLocalOffset(width, height, corner)
      const shouldRotate = event.ctrlKey || event.metaKey

      guideInteractionRef.current = {
        pointerId: event.pointerId,
        guideId: guide.id,
        corner,
        mode: shouldRotate ? 'rotate' : 'resize',
        aspectRatio,
        centerSvg,
        oppositeCornerSvg: shouldRotate
          ? null
          : getGuideCornerSvgPoint(
              centerSvg,
              width,
              height,
              rotationSvg,
              oppositeGuideCorner[corner],
            ),
        pointerOffsetSvg: [0, 0],
        rotationSvg,
        cornerBaseAngle: Math.atan2(cornerOffsetY, cornerOffsetX),
        scale: guide.scale,
      }

      document.body.style.userSelect = 'none'
      document.body.style.cursor = shouldRotate
        ? getGuideRotateCursor(theme === 'dark')
        : getGuideResizeCursor(corner, rotationSvg)

      const nextDraft: GuideTransformDraft = {
        guideId: guide.id,
        position: [guide.position[0], guide.position[2]],
        scale: guide.scale,
        rotation: guide.rotation[1],
      }

      guideTransformDraftRef.current = nextDraft
      setGuideTransformDraft(nextDraft)
    },
    [canInteractWithGuides, handleGuideSelect, theme],
  )
  const handleGuideTranslateStart = useCallback(
    (guide: GuideNode, event: ReactPointerEvent<SVGRectElement>) => {
      if (event.button !== 0 || !canInteractWithGuides || selectedGuideId !== guide.id) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const svgPoint = getSvgPointFromClientPoint(event.clientX, event.clientY)
      if (!svgPoint) {
        return
      }

      const centerSvg = getGuideCenterSvgPoint(guide)

      guideInteractionRef.current = {
        pointerId: event.pointerId,
        guideId: guide.id,
        corner: 'nw',
        mode: 'translate',
        aspectRatio: 1,
        centerSvg,
        oppositeCornerSvg: null,
        pointerOffsetSvg: subtractSvgPoints(svgPoint, centerSvg),
        rotationSvg: -guide.rotation[1],
        cornerBaseAngle: 0,
        scale: guide.scale,
      }

      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'grabbing'

      const nextDraft: GuideTransformDraft = {
        guideId: guide.id,
        position: [guide.position[0], guide.position[2]],
        scale: guide.scale,
        rotation: guide.rotation[1],
      }

      guideTransformDraftRef.current = nextDraft
      setGuideTransformDraft(nextDraft)
    },
    [canInteractWithGuides, getSvgPointFromClientPoint, selectedGuideId],
  )

  const handleOpeningSelect = useCallback(
    (openingId: OpeningNode['id'], event: ReactMouseEvent<SVGElement>) => {
      emitFloorplanNodeClick(openingId, event)
    },
    [emitFloorplanNodeClick],
  )
  const handleSlabSelect = useCallback(
    (slabId: SlabNode['id'], event: ReactMouseEvent<SVGElement>) => {
      emitFloorplanNodeClick(slabId, event)
    },
    [emitFloorplanNodeClick],
  )
  const handleZoneSelect = useCallback(
    (zoneId: ZoneNodeType['id'], event: ReactMouseEvent<SVGElement>) => {
      emitFloorplanNodeClick(zoneId, event)
    },
    [emitFloorplanNodeClick],
  )
  const handleSlabDoubleClick = useCallback((slab: SlabNode) => {
    emitter.emit('camera-controls:focus', { nodeId: slab.id })
  }, [])
  const handleOpeningDoubleClick = useCallback((opening: OpeningNode) => {
    emitter.emit('camera-controls:focus', { nodeId: opening.id })
  }, [])
  const handleSelectedOpeningMove = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()

      const opening = selectedOpeningEntry?.opening
      if (!opening) {
        return
      }

      sfxEmitter.emit('sfx:item-pick')
      setMovingNode(opening)
      setSelection({ selectedIds: [] })
    },
    [selectedOpeningEntry, setMovingNode, setSelection],
  )
  const handleSelectedOpeningDuplicate = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()

      const opening = selectedOpeningEntry?.opening
      if (!opening?.parentId) {
        return
      }

      sfxEmitter.emit('sfx:item-pick')
      useScene.temporal.getState().pause()

      const cloned = structuredClone(opening) as Record<string, unknown>
      delete cloned.id
      cloned.metadata = {
        ...(typeof cloned.metadata === 'object' && cloned.metadata !== null ? cloned.metadata : {}),
        isNew: true,
      }

      const duplicate = opening.type === 'door' ? DoorNode.parse(cloned) : WindowNode.parse(cloned)

      useScene.getState().createNode(duplicate, opening.parentId as AnyNodeId)
      setMovingNode(duplicate)
      setSelection({ selectedIds: [] })
    },
    [selectedOpeningEntry, setMovingNode, setSelection],
  )
  const handleSelectedOpeningDelete = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()

      const opening = selectedOpeningEntry?.opening
      if (!opening) {
        return
      }

      sfxEmitter.emit('sfx:item-delete')
      deleteNode(opening.id as AnyNodeId)
      if (opening.parentId) {
        useScene.getState().dirtyNodes.add(opening.parentId as AnyNodeId)
      }
      setSelection({ selectedIds: [] })
    },
    [deleteNode, selectedOpeningEntry, setSelection],
  )

  const handleWallEndpointPointerDown = useCallback(
    (wall: WallNode, endpoint: WallEndpoint, event: ReactPointerEvent<SVGCircleElement>) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      setHoveredEndpointId(null)

      const movingPoint = endpoint === 'start' ? wall.start : wall.end

      if (isWallBuildActive) {
        handleWallPlacementPoint(movingPoint)
        return
      }

      if (mode === 'delete') {
        sfxEmitter.emit('sfx:structure-delete')
        useScene.getState().deleteNode(wall.id as AnyNodeId)
        return
      }

      if (mode !== 'select') {
        return
      }

      clearWallPlacementDraft()
      handleWallSelect(wall)

      const fixedPoint = endpoint === 'start' ? wall.end : wall.start

      wallEndpointDragRef.current = {
        pointerId: event.pointerId,
        wallId: wall.id,
        endpoint,
        fixedPoint,
        currentPoint: movingPoint,
      }

      setWallEndpointDraft(buildWallEndpointDraft(wall.id, endpoint, fixedPoint, movingPoint))
      setCursorPoint(movingPoint)
    },
    [clearWallPlacementDraft, handleWallPlacementPoint, handleWallSelect, isWallBuildActive, mode],
  )

  // Bulge handle pointer-down. Sits at the arc apex (or chord midpoint for
  // straight walls — drag it perpendicular to bend the wall into a curve).
  // Only meaningful in 'select' mode; other modes ignore the press so the
  // user can't accidentally curve a wall while building doors etc.
  const handleWallBulgePointerDown = useCallback(
    (wall: WallNode, event: ReactPointerEvent<SVGCircleElement>) => {
      // eslint-disable-next-line no-console
      console.log('[bulge] pointerDown', {
        button: event.button,
        pointerId: event.pointerId,
        wallId: wall.id,
        wallBulge: wall.bulge,
        mode,
        tool,
      })
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      // Allow in select mode OR while the arc-wall tool is active. Both paths
      // expose the handle (see wallBulgeHandles useMemo); both must allow
      // the drag too.
      if (mode !== 'select' && tool !== 'arc-wall') {
        // eslint-disable-next-line no-console
        console.log('[bulge] BAIL: mode/tool gate failed')
        return
      }
      clearWallPlacementDraft()
      // Only re-select if the wall isn't already selected — avoids a
      // setState cascade through commitFloorplanSelection →
      // setSelectedReferenceId(null) that fires the
      // "Cannot update a component while rendering" React warning and was
      // breaking the next pointerdown's handlers.
      const alreadySelected = useViewer
        .getState()
        .selection.selectedIds.includes(wall.id)
      if (!alreadySelected) {
        handleWallSelect(wall)
      }
      // Capture the cursor's perpendicular distance from the chord AT
      // drag start so the move handler can compute a delta. Without this
      // capture, the bulge was tied to absolute cursor position — once the
      // wall was curved, the user couldn't realistically drag the cursor
      // far enough to make it straight (had to cover the full sagitta in
      // one drag).
      const initialBulge = wall.bulge ?? 0
      const downPlanPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
      const chord = Math.hypot(
        wall.end[0] - wall.start[0],
        wall.end[1] - wall.start[1],
      )
      let initialPerp = 0
      if (downPlanPoint && chord > 0) {
        const dx = (wall.end[0] - wall.start[0]) / chord
        const dy = (wall.end[1] - wall.start[1]) / chord
        const vx = downPlanPoint[0] - wall.start[0]
        const vy = downPlanPoint[1] - wall.start[1]
        initialPerp = vx * -dy + vy * dx
      }
      wallBulgeDragRef.current = {
        pointerId: event.pointerId,
        wallId: wall.id,
        start: wall.start,
        end: wall.end,
        initialBulge,
        initialPerp,
        lastBulge: initialBulge,
      }
      // eslint-disable-next-line no-console
      console.log('[bulge] pointerDown', {
        wallId: wall.id,
        chord_m: +chord.toFixed(3),
        initialBulge: +initialBulge.toFixed(4),
        initialPerp: +initialPerp.toFixed(3),
      })
      setWallBulgeDraft({ wallId: wall.id, bulge: initialBulge })
      // eslint-disable-next-line no-console
      console.log('[bulge] drag STARTED', { wallId: wall.id, initialBulge: wall.bulge ?? 0 })
    },
    [clearWallPlacementDraft, handleWallSelect, mode, tool],
  )
  const handleSlabVertexPointerDown = useCallback(
    (slabId: SlabNode['id'], vertexIndex: number, event: ReactPointerEvent<SVGCircleElement>) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      setHoveredSlabHandleId(null)

      const slabEntry = displaySlabPolygons.find(({ slab }) => slab.id === slabId)
      const vertexPoint = slabEntry?.polygon[vertexIndex]
      if (!(slabEntry && vertexPoint)) {
        return
      }

      setSlabBoundaryDraft({
        slabId,
        polygon: slabEntry.polygon.map(toWallPlanPoint),
      })
      setSlabVertexDragState({
        pointerId: event.pointerId,
        slabId,
        vertexIndex,
      })
      setCursorPoint(toWallPlanPoint(vertexPoint))
    },
    [displaySlabPolygons],
  )
  const handleSlabVertexDoubleClick = useCallback(
    (slabId: SlabNode['id'], vertexIndex: number, event: ReactPointerEvent<SVGCircleElement>) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const slab = slabById.get(slabId)
      if (!(slab && slab.polygon.length > 3)) {
        return
      }

      slabBoundaryDraftRef.current = null
      clearSlabBoundaryInteraction()

      updateNode(slabId, {
        polygon: slab.polygon.filter((_, index) => index !== vertexIndex),
      })
    },
    [clearSlabBoundaryInteraction, slabById, updateNode],
  )
  const handleSlabMidpointPointerDown = useCallback(
    (slabId: SlabNode['id'], edgeIndex: number, event: ReactPointerEvent<SVGCircleElement>) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      setHoveredSlabHandleId(null)

      const slabEntry = displaySlabPolygons.find(({ slab }) => slab.id === slabId)
      if (!slabEntry) {
        return
      }

      const basePolygon = slabEntry.polygon.map(toWallPlanPoint)
      const startPoint = basePolygon[edgeIndex]
      const endPoint = basePolygon[(edgeIndex + 1) % basePolygon.length]
      if (!(startPoint && endPoint)) {
        return
      }

      const insertedPoint: WallPlanPoint = [
        (startPoint[0] + endPoint[0]) / 2,
        (startPoint[1] + endPoint[1]) / 2,
      ]
      const insertIndex = edgeIndex + 1
      const nextPolygon = [
        ...basePolygon.slice(0, insertIndex),
        insertedPoint,
        ...basePolygon.slice(insertIndex),
      ]

      setSlabBoundaryDraft({
        slabId,
        polygon: nextPolygon,
      })
      setSlabVertexDragState({
        pointerId: event.pointerId,
        slabId,
        vertexIndex: insertIndex,
      })
      setCursorPoint(insertedPoint)
    },
    [displaySlabPolygons],
  )
  const handleSiteVertexPointerDown = useCallback(
    (siteId: SiteNode['id'], vertexIndex: number, event: ReactPointerEvent<SVGCircleElement>) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      setHoveredSiteHandleId(null)

      if (!(displaySitePolygon && displaySitePolygon.site.id === siteId)) {
        return
      }

      const vertexPoint = displaySitePolygon.polygon[vertexIndex]
      if (!vertexPoint) {
        return
      }

      setSiteBoundaryDraft({
        siteId,
        polygon: displaySitePolygon.polygon.map(toWallPlanPoint),
      })
      setSiteVertexDragState({
        pointerId: event.pointerId,
        siteId,
        vertexIndex,
      })
      setCursorPoint(toWallPlanPoint(vertexPoint))
    },
    [displaySitePolygon],
  )
  const handleSiteVertexDoubleClick = useCallback(
    (siteId: SiteNode['id'], vertexIndex: number, event: ReactPointerEvent<SVGCircleElement>) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (!(site && site.id === siteId && (site.polygon?.points?.length ?? 0) > 3)) {
        return
      }

      siteBoundaryDraftRef.current = null
      clearSiteBoundaryInteraction()

      updateNode(siteId, {
        polygon: {
          type: 'polygon',
          points: site.polygon.points.filter((_, index) => index !== vertexIndex),
        },
      })
    },
    [clearSiteBoundaryInteraction, site, updateNode],
  )
  const handleSiteMidpointPointerDown = useCallback(
    (siteId: SiteNode['id'], edgeIndex: number, event: ReactPointerEvent<SVGCircleElement>) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      setHoveredSiteHandleId(null)

      if (!(displaySitePolygon && displaySitePolygon.site.id === siteId)) {
        return
      }

      const basePolygon = displaySitePolygon.polygon.map(toWallPlanPoint)
      const startPoint = basePolygon[edgeIndex]
      const endPoint = basePolygon[(edgeIndex + 1) % basePolygon.length]
      if (!(startPoint && endPoint)) {
        return
      }

      const insertedPoint: WallPlanPoint = [
        (startPoint[0] + endPoint[0]) / 2,
        (startPoint[1] + endPoint[1]) / 2,
      ]
      const insertIndex = edgeIndex + 1
      const nextPolygon = [
        ...basePolygon.slice(0, insertIndex),
        insertedPoint,
        ...basePolygon.slice(insertIndex),
      ]

      setSiteBoundaryDraft({
        siteId,
        polygon: nextPolygon,
      })
      setSiteVertexDragState({
        pointerId: event.pointerId,
        siteId,
        vertexIndex: insertIndex,
      })
      setCursorPoint(insertedPoint)
    },
    [displaySitePolygon],
  )
  const handleZoneVertexPointerDown = useCallback(
    (
      zoneId: ZoneNodeType['id'],
      vertexIndex: number,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      setHoveredZoneHandleId(null)

      const zoneEntry = displayZonePolygons.find(({ zone }) => zone.id === zoneId)
      const vertexPoint = zoneEntry?.polygon[vertexIndex]
      if (!(zoneEntry && vertexPoint)) {
        return
      }

      setZoneBoundaryDraft({
        zoneId,
        polygon: zoneEntry.polygon.map(toWallPlanPoint),
      })
      setZoneVertexDragState({
        pointerId: event.pointerId,
        zoneId,
        vertexIndex,
      })
      setCursorPoint(toWallPlanPoint(vertexPoint))
    },
    [displayZonePolygons],
  )
  const handleZoneVertexDoubleClick = useCallback(
    (
      zoneId: ZoneNodeType['id'],
      vertexIndex: number,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const zone = zoneById.get(zoneId)
      if (!(zone && zone.polygon.length > 3)) {
        return
      }

      zoneBoundaryDraftRef.current = null
      clearZoneBoundaryInteraction()

      updateNode(zoneId, {
        polygon: zone.polygon.filter((_, index) => index !== vertexIndex),
      })
    },
    [clearZoneBoundaryInteraction, updateNode, zoneById],
  )
  const handleZoneMidpointPointerDown = useCallback(
    (zoneId: ZoneNodeType['id'], edgeIndex: number, event: ReactPointerEvent<SVGCircleElement>) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      setHoveredZoneHandleId(null)

      const zoneEntry = displayZonePolygons.find(({ zone }) => zone.id === zoneId)
      if (!zoneEntry) {
        return
      }

      const basePolygon = zoneEntry.polygon.map(toWallPlanPoint)
      const startPoint = basePolygon[edgeIndex]
      const endPoint = basePolygon[(edgeIndex + 1) % basePolygon.length]
      if (!(startPoint && endPoint)) {
        return
      }

      const insertedPoint: WallPlanPoint = [
        (startPoint[0] + endPoint[0]) / 2,
        (startPoint[1] + endPoint[1]) / 2,
      ]
      const insertIndex = edgeIndex + 1
      const nextPolygon = [
        ...basePolygon.slice(0, insertIndex),
        insertedPoint,
        ...basePolygon.slice(insertIndex),
      ]

      setZoneBoundaryDraft({
        zoneId,
        polygon: nextPolygon,
      })
      setZoneVertexDragState({
        pointerId: event.pointerId,
        zoneId,
        vertexIndex: insertIndex,
      })
      setCursorPoint(insertedPoint)
    },
    [displayZonePolygons],
  )

  const handlePointerLeave = useCallback(() => {
    if (
      !(
        panStateRef.current ||
        wallEndpointDragRef.current ||
        siteVertexDragState ||
        slabVertexDragState ||
        zoneVertexDragState
      )
    ) {
      setCursorPoint(null)
    }
    setHoveredOpeningId(null)
    setHoveredWallId(null)
    setHoveredEndpointId(null)
    setHoveredSiteHandleId(null)
    setHoveredSlabHandleId(null)
    setHoveredZoneHandleId(null)
    if (hoveredWallIdRef.current) {
      emitFloorplanWallLeave(hoveredWallIdRef.current)
      hoveredWallIdRef.current = null
    }
  }, [emitFloorplanWallLeave, siteVertexDragState, slabVertexDragState, zoneVertexDragState])

  const handleSvgPointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (
        activeFloorplanCursorIndicator &&
        !panStateRef.current &&
        !guideInteractionRef.current &&
        !wallEndpointDragRef.current &&
        !siteVertexDragState &&
        !slabVertexDragState &&
        !zoneVertexDragState
      ) {
        const rect = event.currentTarget.getBoundingClientRect()
        setFloorplanCursorPosition({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        })
      } else {
        setFloorplanCursorPosition(null)
      }

      handlePointerMove(event)
    },
    [
      activeFloorplanCursorIndicator,
      handlePointerMove,
      siteVertexDragState,
      slabVertexDragState,
      zoneVertexDragState,
    ],
  )

  const handleSvgPointerLeave = useCallback(() => {
    setFloorplanCursorPosition(null)
    setHoveredGuideCorner(null)
    handlePointerLeave()
  }, [handlePointerLeave])

  const handleMarqueePointerDown = useCallback(
    (event: ReactPointerEvent<SVGRectElement>) => {
      if (event.button !== 0) {
        return
      }

      const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
      if (!planPoint) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      const rect = svgRef.current?.getBoundingClientRect()
      if (rect) {
        setFloorplanCursorPosition({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        })
      }
      setHoveredOpeningId(null)
      setHoveredWallId(null)
      setHoveredEndpointId(null)
      setFloorplanMarqueeState({
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPlanPoint: planPoint,
        currentPlanPoint: planPoint,
      })

      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [getPlanPointFromClientPoint],
  )

  // ── Symbol drag-and-drop (from sidebar SymbolCatalog) ──
  // The SVG canvas accepts drops carrying FLOORPLAN_SYMBOL_MIME. Each drop
  // creates a real ItemNode in the current level so it shows up in the export
  // JSON's `furniture[]` and behaves like any other selectable scene element.
  // Sensible per-category default dimensions; user can resize via the existing
  // item controls. y=0 = floor level (Pascal's level frame is X-Z, Y-up).
  const handleSymbolDragOver = useCallback(
    (event: React.DragEvent<SVGSVGElement>) => {
      if (event.dataTransfer.types.includes(FLOORPLAN_SYMBOL_MIME)) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }
    },
    [],
  )

  const handleSymbolDrop = useCallback(
    (event: React.DragEvent<SVGSVGElement>) => {
      // Diagnostic: every drop reports what stage it reached. Remove once
      // drag-drop is confirmed working end-to-end.
      const _dbg = (stage: string, extra?: unknown) =>
        // eslint-disable-next-line no-console
        console.log('[symbol-drop]', stage, extra ?? '')

      const raw = event.dataTransfer.getData(FLOORPLAN_SYMBOL_MIME)
      const types = Array.from(event.dataTransfer.types)
      _dbg('fired', { mimeTypes: types, hasFloorplanMime: !!raw })
      if (!raw) {
        _dbg('bailed: no FLOORPLAN_SYMBOL_MIME payload (drag source mismatch?)')
        return
      }
      event.preventDefault()

      type SymbolPayload = { id: string; label: string; src: string; category?: string }
      let dropped: SymbolPayload
      try {
        dropped = JSON.parse(raw) as SymbolPayload
      } catch (err) {
        _dbg('bailed: JSON parse failed', err)
        return
      }
      if (!dropped?.src) {
        _dbg('bailed: payload missing src', dropped)
        return
      }

      if (!levelId) {
        _dbg('bailed: no active levelId — select a level in the sidebar tree first')
        return
      }

      const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
      if (!planPoint) {
        _dbg('bailed: getPlanPointFromClientPoint returned null', {
          x: event.clientX,
          y: event.clientY,
        })
        return
      }
      _dbg('proceeding', { levelId, planPoint, category: dropped.category, id: dropped.id })

      // Per-category default dimensions [w, h, d] in meters. Furniture-shaped
      // averages; user resizes after dropping. Outliers (toilet, lamp) will
      // need per-symbol overrides once we have GLBs to anchor real sizes.
      const DEFAULT_DIMS: Record<string, [number, number, number]> = {
        bathroom: [0.7, 0.9, 0.6],
        kitchen: [0.6, 0.9, 0.6],
        bedroom: [1.6, 1.0, 2.0],
        dining: [1.6, 0.75, 0.9],
        living: [1.8, 0.85, 0.9],
        office: [1.4, 0.75, 0.7],
        outdoor: [2.0, 1.0, 1.0],
        stairs: [1.2, 2.5, 2.5],
      }
      const dims = DEFAULT_DIMS[dropped.category ?? ''] ?? [0.8, 0.8, 0.8]

      try {
        const itemNode = ItemNode.parse({
          parentId: levelId,
          position: [planPoint[0], 0, planPoint[1]],
          asset: {
            id: dropped.id,
            category: dropped.category ?? 'symbol',
            name: dropped.label,
            thumbnail: dropped.src,
            // No GLB yet — Pascal's item-renderer falls back to a placeholder
            // mesh; the SVG src is here for the future furniture-pipeline step.
            src: dropped.src,
            dimensions: dims,
          },
        })
        useScene.getState().createNode(itemNode, levelId as AnyNodeId)
        _dbg('CREATED item node', { id: itemNode.id })
      } catch (err) {
        _dbg('CREATE FAILED', err)
        console.warn('[floorplan] symbol drop failed:', err)
      }
    },
    [getPlanPointFromClientPoint, levelId],
  )

  const handleMarqueePointerMove = useCallback(
    (event: ReactPointerEvent<SVGRectElement>) => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (rect) {
        setFloorplanCursorPosition({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        })
      }

      if (floorplanMarqueeState?.pointerId !== event.pointerId) {
        return
      }

      const planPoint = getPlanPointFromClientPoint(event.clientX, event.clientY)
      if (!planPoint) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      setFloorplanMarqueeState((currentState) => {
        if (!currentState || currentState.pointerId !== event.pointerId) {
          return currentState
        }

        return {
          ...currentState,
          currentPlanPoint: planPoint,
        }
      })
    },
    [floorplanMarqueeState?.pointerId, getPlanPointFromClientPoint],
  )

  const handleMarqueePointerUp = useCallback(
    (event: ReactPointerEvent<SVGRectElement>) => {
      const marqueeState = floorplanMarqueeState
      if (!marqueeState || marqueeState.pointerId !== event.pointerId) {
        return
      }

      const endPlanPoint =
        getPlanPointFromClientPoint(event.clientX, event.clientY) ?? marqueeState.currentPlanPoint
      const modifierKeys = getSelectionModifierKeys(event)
      const dragDistance = Math.hypot(
        event.clientX - marqueeState.startClientX,
        event.clientY - marqueeState.startClientY,
      )

      event.preventDefault()
      event.stopPropagation()

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      if (dragDistance >= FLOORPLAN_MARQUEE_DRAG_THRESHOLD_PX) {
        const bounds = getFloorplanSelectionBounds(marqueeState.startPlanPoint, endPlanPoint)
        const nextSelectedIds = getFloorplanSelectionIdsInBounds(bounds)
        addFloorplanSelection(nextSelectedIds, modifierKeys)
      } else {
        const hitId = getFloorplanHitIdAtPoint(endPlanPoint)

        if (hitId) {
          // Ritn3D: delete mode — delete clicked node directly
          if (useEditor.getState().mode === 'delete') {
            const node = useScene.getState().nodes[hitId as AnyNodeId]
            if (node) {
              sfxEmitter.emit('sfx:structure-delete')
              const parentId = node.parentId
              useScene.getState().deleteNode(hitId as AnyNodeId)
              if (parentId) useScene.getState().dirtyNodes.add(parentId as AnyNodeId)
            }
          } else {
            toggleFloorplanSelection(hitId, modifierKeys)
          }
        } else if (!(modifierKeys.meta || modifierKeys.ctrl)) {
          commitFloorplanSelection([])
        }
      }

      setFloorplanMarqueeState(null)
    },
    [
      addFloorplanSelection,
      commitFloorplanSelection,
      floorplanMarqueeState,
      getFloorplanHitIdAtPoint,
      getFloorplanSelectionIdsInBounds,
      getPlanPointFromClientPoint,
      toggleFloorplanSelection,
    ],
  )

  const handleMarqueePointerCancel = useCallback(
    (event: ReactPointerEvent<SVGRectElement>) => {
      if (floorplanMarqueeState?.pointerId !== event.pointerId) {
        return
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      setFloorplanMarqueeState(null)
      setFloorplanCursorPosition(null)
    },
    [floorplanMarqueeState?.pointerId],
  )

  useEffect(() => {
    if (!isMarqueeSelectionToolActive) {
      setFloorplanMarqueeState(null)
      return
    }

    setFloorplanCursorPosition(null)
    setHoveredOpeningId(null)
    setHoveredWallId(null)
    setHoveredEndpointId(null)
  }, [isMarqueeSelectionToolActive])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) {
      return
    }

    const getFallbackClientPoint = () => {
      const rect = svg.getBoundingClientRect()
      return {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }
    }

    const handleNativeWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()

      const widthFactor = Math.exp(event.deltaY * (event.ctrlKey ? 0.003 : 0.0015))
      zoomViewportAtClientPoint(event.clientX, event.clientY, widthFactor)
    }

    const handleGestureStart = (event: Event) => {
      const gestureEvent = event as GestureLikeEvent
      gestureScaleRef.current = gestureEvent.scale ?? 1
      event.preventDefault()
      event.stopPropagation()
    }

    const handleGestureChange = (event: Event) => {
      const gestureEvent = event as GestureLikeEvent
      const nextScale = gestureEvent.scale ?? 1
      const previousScale = gestureScaleRef.current || 1
      const widthFactor = previousScale / nextScale
      const fallbackClientPoint = getFallbackClientPoint()

      zoomViewportAtClientPoint(
        gestureEvent.clientX ?? fallbackClientPoint.clientX,
        gestureEvent.clientY ?? fallbackClientPoint.clientY,
        widthFactor,
      )

      gestureScaleRef.current = nextScale
      event.preventDefault()
      event.stopPropagation()
    }

    const handleGestureEnd = (event: Event) => {
      gestureScaleRef.current = 1
      event.preventDefault()
      event.stopPropagation()
    }

    svg.addEventListener('wheel', handleNativeWheel, { passive: false })
    svg.addEventListener('gesturestart', handleGestureStart, { passive: false })
    svg.addEventListener('gesturechange', handleGestureChange, { passive: false })
    svg.addEventListener('gestureend', handleGestureEnd, { passive: false })

    return () => {
      svg.removeEventListener('wheel', handleNativeWheel)
      svg.removeEventListener('gesturestart', handleGestureStart)
      svg.removeEventListener('gesturechange', handleGestureChange)
      svg.removeEventListener('gestureend', handleGestureEnd)
    }
  }, [zoomViewportAtClientPoint])

  const restoreGroundLevelStructureSelection = useCallback(() => {
    const sceneNodes = useScene.getState().nodes
    const nextBuildingId =
      currentBuildingId ??
      site?.children
        .map((child) => (typeof child === 'string' ? sceneNodes[child as AnyNodeId] : child))
        .find((node): node is BuildingNode => node?.type === 'building')?.id ??
      null

    const nextGroundLevelId =
      nextBuildingId && nextBuildingId === currentBuildingId
        ? (floorplanLevels.find((level) => level.level === 0)?.id ??
          floorplanLevels[0]?.id ??
          (levelNode?.type === 'level' ? levelNode.id : null))
        : (() => {
            if (!nextBuildingId) {
              return null
            }

            const buildingNode = sceneNodes[nextBuildingId]
            if (!buildingNode || buildingNode.type !== 'building') {
              return null
            }

            const buildingLevels = buildingNode.children
              .map((child) => (typeof child === 'string' ? sceneNodes[child as AnyNodeId] : child))
              .filter((node): node is LevelNode => node?.type === 'level')
              .sort((a, b) => a.level - b.level)

            return (
              buildingLevels.find((level) => level.level === 0)?.id ?? buildingLevels[0]?.id ?? null
            )
          })()

    setPhase('structure')
    setStructureLayer('elements')
    setMode('select')

    const nextSelection: Parameters<typeof setSelection>[0] = {
      selectedIds: [],
      zoneId: null,
    }

    if (nextBuildingId) {
      nextSelection.buildingId = nextBuildingId
    }

    if (nextGroundLevelId) {
      nextSelection.levelId = nextGroundLevelId
    }

    setSelection(nextSelection)
  }, [
    currentBuildingId,
    floorplanLevels,
    levelNode,
    setMode,
    setPhase,
    setSelection,
    setStructureLayer,
    site,
  ])
  const handleFloorplanSelectionToolChange = useCallback(
    (nextTool: FloorplanSelectionTool) => {
      setFloorplanSelectionTool(nextTool)

      if (phase === 'site') {
        restoreGroundLevelStructureSelection()
        return
      }

      if (mode !== 'select') {
        setMode('select')
      }
    },
    [mode, phase, restoreGroundLevelStructureSelection, setMode],
  )
  const handleQuickBuildToolSelect = useCallback(
    (nextTool: FloorplanQuickBuildTool) => {
      setPhase('structure')
      setStructureLayer(nextTool === 'zone' ? 'zones' : 'elements')
      setMode('build')
      setTool(nextTool)
      setCatalogCategory(null)
    },
    [setCatalogCategory, setMode, setPhase, setStructureLayer, setTool],
  )
  const handleSiteEditShortcutSelect = useCallback(() => {
    if (!(levelNode?.type === 'level' && levelNode.level === 0)) {
      return
    }

    if (isSiteEditShortcutActive) {
      restoreGroundLevelStructureSelection()
      return
    }

    setPhase('site')
    setMode('edit')

    if (currentBuildingId) {
      setSelection({
        buildingId: currentBuildingId,
        levelId: levelNode.id,
        selectedIds: [],
        zoneId: null,
      })
      return
    }

    setSelection({
      levelId: levelNode.id,
      selectedIds: [],
      zoneId: null,
    })
  }, [
    currentBuildingId,
    isSiteEditShortcutActive,
    levelNode,
    setMode,
    setPhase,
    setSelection,
    restoreGroundLevelStructureSelection,
  ])
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isEditableTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        Boolean(target?.isContentEditable)

      if (
        isEditableTarget ||
        !isFloorplanHovered ||
        phase !== 'site' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.toLowerCase() !== 'v'
      ) {
        return
      }

      setFloorplanSelectionTool('click')
      restoreGroundLevelStructureSelection()
    }

    window.addEventListener('keydown', handleKeyDown, true)

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isFloorplanHovered, phase, restoreGroundLevelStructureSelection])
  const activeDraftAnchorPoint = draftStart ?? activePolygonDraftPoints[0] ?? null
  const floorplanCursorColor = wallEndpointDraft
    ? palette.editCursor
    : activeDraftAnchorPoint
      ? palette.draftStroke
      : palette.cursor

  return (
    <div
      className="pointer-events-auto fixed z-10 flex flex-col overflow-hidden bg-background"
      onPointerEnter={() => setFloorplanHovered(true)}
      onPointerLeave={() => {
        setFloorplanHovered(false)
        setFloorplanCursorPosition(null)
      }}
      style={{
        cursor: activeResizeDirection ? resizeCursorByDirection[activeResizeDirection] : undefined,
        inset: 0,
        visibility: isPanelReady ? 'visible' : 'hidden',
      }}
    >
      {/* Arc-wall hint: shown briefly after the user places a straight wall
          with the Arc Wall tool. Tells them how to bend it. Disappears once
          they touch the bulge handle or pick another tool. Uses the same
          visual treatment as the scale-calibration banner. */}
      {tool === 'arc-wall' && !arcDraftStart && wallBulgeHandles.length > 0 && (
        <div
          className="pointer-events-none fixed inset-x-0 top-0 z-40 flex items-center justify-center gap-3 border-b border-sky-500/40 bg-sky-500/15 px-4 py-2.5 text-sky-200 backdrop-blur-md"
          style={{ paddingLeft: '320px' }}
        >
          <svg width="18" height="18" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <path d="M5 22 Q 14 2 23 22" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="5" cy="22" r="2.5" fill="currentColor" />
            <circle cx="23" cy="22" r="2.5" fill="currentColor" />
          </svg>
          <span className="font-medium text-sm">
            Drag the blue dot at the wall's middle to bend it into a curve.
          </span>
        </div>
      )}

      {/* Scale calibration banner — visible when calibratingGuideId is set.
          Two-point reference: user clicks two points with a known real-world
          distance, types the distance, scale auto-adjusts. */}
      {calibratingGuideId && (
        <div
          className="pointer-events-auto fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2.5 text-amber-200 backdrop-blur-md"
          style={{ paddingLeft: '320px' }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 21h18" />
            <path d="M6 18 L 18 6" />
            <path d="M5 17 l 2 2 M 9 13 l 2 2 M 13 9 l 2 2 M 17 5 l 2 2" />
          </svg>
          <span className="font-medium text-sm">
            {!calibrationP1 && 'Set scale: click the first endpoint of a known wall on the plan.'}
            {calibrationP1 && !calibrationP2 && 'Now click the second endpoint.'}
            {calibrationP1 && calibrationP2 && 'Enter the real distance to finish — or click again to redo.'}
          </span>
          <button
            type="button"
            onClick={() => {
              setCalibratingGuideId(null)
              setCalibrationP1(null)
              setCalibrationP2(null)
              setCalibrationInput('')
            }}
            className="ml-2 text-xs text-amber-300/80 hover:text-amber-100 underline-offset-2 hover:underline"
          >
            Skip (Esc)
          </button>
        </div>
      )}

      {/* Canvas scale bar — fixed overlay at bottom-left. Picks the nearest
          "nice" length (1, 2, 5, 10, 20, 50, 100 m, etc.) that maps to
          roughly 80-150 screen pixels at the current zoom. Updates live
          with zoom/pan. */}
      {surfaceSize.width > 0 && (() => {
        const pixelsPerMeter = surfaceSize.width / viewBox.width
        if (!Number.isFinite(pixelsPerMeter) || pixelsPerMeter <= 0) return null
        const TARGET_PX = 100
        // Round to a 1-2-5 sequence (architectural / map convention).
        const rawMeters = TARGET_PX / pixelsPerMeter
        const pow10 = Math.pow(10, Math.floor(Math.log10(rawMeters)))
        const mantissa = rawMeters / pow10
        const niceMantissa = mantissa < 1.5 ? 1 : mantissa < 3.5 ? 2 : mantissa < 7.5 ? 5 : 10
        const lengthMeters = niceMantissa * pow10
        const widthPx = lengthMeters * pixelsPerMeter
        const isImperial = unit === 'imperial'
        const labelValue = isImperial ? lengthMeters * 3.28084 : lengthMeters
        const labelDigits = labelValue >= 10 ? 0 : 1
        const label = `${labelValue.toFixed(labelDigits)} ${isImperial ? 'ft' : 'm'}`
        return (
          <div
            className="pointer-events-none absolute z-30 flex flex-col items-start"
            style={{ left: 16, bottom: 16 }}
          >
            <div
              className="flex h-3 items-end justify-between rounded-sm bg-background/85 px-1 ring-1 ring-border/60 backdrop-blur-sm"
              style={{ width: widthPx }}
            >
              <span className="block h-2 w-0.5 bg-foreground/85" />
              <span className="block h-1.5 w-0.5 bg-foreground/55" />
              <span className="block h-2 w-0.5 bg-foreground/85" />
            </div>
            <span className="mt-0.5 rounded-sm bg-background/85 px-1 font-mono text-[10px] text-foreground/85 ring-1 ring-border/60 backdrop-blur-sm">
              {label}
            </span>
          </div>
        )
      })()}

      {/* Ritn3D: resize handles hidden — fullscreen mode */}
      {false && resizeHandleConfigurations.map((handle) => (
        <div
          aria-hidden="true"
          className={handle.className}
          key={handle.direction}
          onPointerDown={(event) => handleResizeStart(handle.direction, event)}
        />
      ))}

      {/* Ritn3D: top bar hidden — fullscreen 2D mode, tools in bottom toolbar */}
      <div
        className="hidden"
        onPointerDown={handlePanelDragStart}
      >
        <div className="flex min-w-0 items-center pr-3">
          <div
            className="min-w-0"
            data-floorplan-panel-control="true"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu
              modal={false}
              onOpenChange={(open) => {
                clearLevelMenuCloseTimeout()
                setIsLevelMenuOpen(hasFloorplanLevelSwitcher ? open : false)
              }}
              open={isLevelMenuOpen}
            >
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    'group/level-switcher flex min-w-0 items-center gap-2 rounded-xl border border-border/45 bg-background/92 py-1 pr-2 pl-1.5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.04)] transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none',
                    hasFloorplanLevelSwitcher
                      ? 'hover:border-border/60 hover:bg-background focus-visible:border-border/60 focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-border/60'
                      : 'cursor-default',
                  )}
                  disabled={!hasFloorplanLevelSwitcher}
                  onPointerEnter={openLevelMenu}
                  onPointerLeave={scheduleLevelMenuClose}
                  type="button"
                >
                  <span className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg bg-background/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                    <img
                      alt=""
                      aria-hidden="true"
                      className="h-4 w-4 object-contain"
                      src="/icons/blueprint.png"
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm tabular-nums">
                    {floorplanLevelLabel}
                  </span>
                  {hasFloorplanLevelSwitcher ? (
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-[transform,opacity,color] duration-150',
                        isLevelMenuOpen
                          ? 'rotate-180 text-foreground/70 opacity-100'
                          : 'opacity-45 group-hover/level-switcher:opacity-70 group-focus-visible/level-switcher:opacity-70',
                      )}
                    />
                  ) : null}
                </button>
              </DropdownMenuTrigger>
              {hasFloorplanLevelSwitcher ? (
                <DropdownMenuContent
                  align="start"
                  className="min-w-52 rounded-xl border-border/45 bg-background/96 p-1 shadow-[0_14px_28px_-18px_rgba(15,23,42,0.55),0_6px_16px_-10px_rgba(15,23,42,0.2)] backdrop-blur-xl"
                  onPointerEnter={openLevelMenu}
                  onPointerLeave={scheduleLevelMenuClose}
                  side="bottom"
                  sideOffset={10}
                >
                  <DropdownMenuRadioGroup
                    onValueChange={handleFloorplanLevelSelect}
                    value={levelId ?? ''}
                  >
                    {floorplanLevels.map((level) => (
                      <DropdownMenuRadioItem
                        className="rounded-lg py-2 pr-3 pl-8 data-[state=checked]:bg-accent/60"
                        key={level.id}
                        value={level.id}
                      >
                        <span className="truncate">{getLevelDisplayLabel(level)}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              ) : null}
            </DropdownMenu>
          </div>
        </div>

        <div
          className="flex items-center gap-1.5"
          data-floorplan-panel-control="true"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-1 rounded-xl border border-border/45 bg-background/92 p-1 shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.04)]">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex">
                  <button
                    aria-label={isSiteEditShortcutActive ? 'Exit site editing' : 'Edit site'}
                    aria-pressed={isSiteEditShortcutActive}
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-lg transition-[background-color,filter,opacity,transform] duration-200 active:scale-[0.96]',
                      isSiteEditShortcutActive
                        ? 'bg-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                        : canUseSiteEditShortcut
                          ? 'opacity-75 grayscale hover:bg-accent hover:opacity-100 hover:grayscale-0'
                          : 'cursor-not-allowed opacity-35 grayscale',
                    )}
                    disabled={!canUseSiteEditShortcut}
                    onClick={handleSiteEditShortcutSelect}
                    type="button"
                  >
                    <img
                      alt=""
                      aria-hidden="true"
                      className="h-4.5 w-4.5 object-contain"
                      src="/icons/site.png"
                    />
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={8}>
                {canUseSiteEditShortcut
                  ? isSiteEditShortcutActive
                    ? 'Exit site editing'
                    : 'Edit site'
                  : 'Site editing is only available on ground level'}
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center rounded-xl border border-border/45 bg-background/92 p-1 shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.04)]">
            <Popover onOpenChange={setIsGuideQuickAccessOpen} open={isGuideQuickAccessOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={showGuides ? 'Hide guide images' : 'Show guide images'}
                    aria-pressed={showGuides}
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-lg transition-[background-color,filter,opacity,transform] duration-200 active:scale-[0.96]',
                      showGuides
                        ? 'bg-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                        : hasGuideImages
                          ? 'opacity-75 grayscale hover:bg-accent hover:opacity-100 hover:grayscale-0'
                          : 'opacity-45 grayscale hover:bg-accent/60 hover:opacity-70',
                    )}
                    onClick={() => setShowGuides(!showGuides)}
                    type="button"
                  >
                    <img
                      alt=""
                      aria-hidden="true"
                      className="h-4.5 w-4.5 object-contain"
                      src="/icons/floorplan.png"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={8}>
                  {showGuides ? 'Hide guide images' : 'Show guide images'}
                </TooltipContent>
              </Tooltip>

              <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border/50" />

              <PopoverTrigger asChild>
                <button
                  aria-expanded={isGuideQuickAccessOpen}
                  aria-haspopup="dialog"
                  aria-label="Adjust guide image opacity"
                  className={cn(
                    'flex h-8 w-7 items-center justify-center rounded-lg transition-[background-color,opacity,transform] duration-200 active:scale-[0.96]',
                    isGuideQuickAccessOpen
                      ? 'bg-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                      : hasGuideImages
                        ? 'opacity-75 hover:bg-accent hover:opacity-100'
                        : 'opacity-45 hover:bg-accent/60 hover:opacity-70',
                  )}
                  type="button"
                >
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-[transform,opacity,color] duration-150',
                      isGuideQuickAccessOpen
                        ? 'rotate-180 text-foreground/70 opacity-100'
                        : 'text-muted-foreground opacity-70',
                    )}
                  />
                </button>
              </PopoverTrigger>

              <PopoverContent
                align="end"
                className="w-80 rounded-xl border-border/45 bg-background/96 p-3 shadow-[0_14px_28px_-18px_rgba(15,23,42,0.55),0_6px_16px_-10px_rgba(15,23,42,0.2)] backdrop-blur-xl"
                side="bottom"
                sideOffset={10}
              >
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                      <img
                        alt=""
                        aria-hidden="true"
                        className="h-4 w-4 object-contain"
                        src="/icons/floorplan.png"
                      />
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium text-foreground text-sm">Guide images</p>
                      <p className="text-muted-foreground text-xs">{guideImagesDescription}</p>
                    </div>
                  </div>

                  {hasGuideImages ? (
                    <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                      {levelGuides.map((guide, index) => (
                        <div
                          className="space-y-2 rounded-xl border border-border/45 bg-background/75 p-2.5"
                          key={guide.id}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <img
                              alt=""
                              aria-hidden="true"
                              className="h-3.5 w-3.5 shrink-0 object-contain opacity-70"
                              src="/icons/floorplan.png"
                            />
                            <p className="truncate font-medium text-foreground text-sm">
                              {guide.name || `Guide image ${index + 1}`}
                            </p>
                          </div>

                          <SliderControl
                            label="Opacity"
                            max={100}
                            min={0}
                            onChange={(value) => handleGuideOpacityChange(guide.id, value)}
                            precision={0}
                            step={1}
                            unit="%"
                            value={guide.opacity}
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-border/45 border-dashed bg-background/60 px-3 py-4 text-muted-foreground text-sm">
                      No guide images on this level yet.
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex items-center gap-1 rounded-xl border border-border/45 bg-background/92 p-1 shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.04)]">
            {FLOORPLAN_QUICK_BUILD_TOOLS.map((quickTool) => {
              const isActive = phase === 'structure' && mode === 'build' && tool === quickTool.id

              return (
                <Tooltip key={quickTool.id}>
                  <TooltipTrigger asChild>
                    <button
                      aria-label={`Activate ${quickTool.label.toLowerCase()} tool`}
                      aria-pressed={isActive}
                      className={cn(
                        'flex h-8 w-8 items-center justify-center rounded-lg transition-[background-color,filter,opacity,transform] duration-200 active:scale-[0.96]',
                        isActive
                          ? 'bg-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                          : 'opacity-75 grayscale hover:bg-accent hover:opacity-100 hover:grayscale-0',
                      )}
                      onClick={() => handleQuickBuildToolSelect(quickTool.id)}
                      type="button"
                    >
                      {quickTool.iconSrc ? (
                        <img
                          alt=""
                          aria-hidden="true"
                          className="h-4.5 w-4.5 object-contain"
                          src={quickTool.iconSrc}
                        />
                      ) : (
                        <span aria-hidden="true" className="block h-4.5 w-4.5">
                          {quickTool.iconNode}
                        </span>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={8}>
                    {quickTool.label}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>

          <div
            className={cn(
              'flex items-center gap-1 rounded-xl border border-border/45 bg-background/92 p-1 shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.04)]',
              mode !== 'select' && 'opacity-60',
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label="Click select"
                  aria-pressed={floorplanSelectionTool === 'click'}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-lg transition-[background-color,transform] duration-200 active:scale-[0.96]',
                    floorplanSelectionTool === 'click'
                      ? 'bg-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                      : 'hover:bg-accent',
                  )}
                  onClick={() => handleFloorplanSelectionToolChange('click')}
                  type="button"
                >
                  <img
                    alt=""
                    aria-hidden="true"
                    className={cn(
                      'h-[18px] w-[18px] object-contain transition-[opacity,filter] duration-200',
                      floorplanSelectionTool === 'click'
                        ? 'opacity-100 grayscale-0'
                        : 'opacity-60 grayscale',
                    )}
                    src="/icons/select.png"
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={8}>
                Click select
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label="Box select"
                  aria-pressed={floorplanSelectionTool === 'marquee'}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-200 active:scale-[0.96]',
                    floorplanSelectionTool === 'marquee'
                      ? 'bg-accent text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                      : 'hover:bg-accent hover:text-foreground',
                  )}
                  onClick={() => handleFloorplanSelectionToolChange('marquee')}
                  type="button"
                >
                  <Icon color="currentColor" height={18} icon="mdi:select-drag" width={18} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={8}>
                Box select
              </TooltipContent>
            </Tooltip>
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="Close floorplan"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/45 bg-background/92 text-muted-foreground shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.04)] transition-[background-color,color,transform] duration-200 hover:bg-accent hover:text-foreground active:scale-[0.96]"
                onClick={() => setFloorplanOpen(false)}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={8}>
              Close floorplan
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="relative min-h-0 flex-1" ref={viewportHostRef}>
        {/* True North compass */}
        <div className="absolute top-3 right-3 z-20 pointer-events-none flex flex-col items-center" style={{ opacity: 0.6 }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <polygon points="12,2 15,10 12,8 9,10" fill="#ef4444" />
            <polygon points="12,22 9,14 12,16 15,14" fill="#94a3b8" />
            <line x1="12" y1="2" x2="12" y2="22" stroke="#64748b" strokeWidth="0.5" />
          </svg>
          <span style={{ fontSize: '8px', fontWeight: 700, color: '#ef4444', marginTop: '1px', letterSpacing: '0.5px' }}>N</span>
        </div>

        {activeFloorplanCursorIndicator && floorplanCursorPosition && !isPanning && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-20 flex h-8 w-8 items-center justify-center rounded-xl border border-white/5 bg-zinc-900/95 shadow-[0_8px_16px_-4px_rgba(0,0,0,0.3),0_4px_8px_-4px_rgba(0,0,0,0.2)]"
            style={{
              left: floorplanCursorPosition.x + FLOORPLAN_CURSOR_INDICATOR_OFFSET_X,
              top: floorplanCursorPosition.y + FLOORPLAN_CURSOR_INDICATOR_OFFSET_Y,
            }}
          >
            {activeFloorplanCursorIndicator.kind === 'asset' ? (
              <img
                alt=""
                aria-hidden="true"
                className="h-5 w-5 object-contain drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]"
                src={activeFloorplanCursorIndicator.iconSrc}
              />
            ) : (
              <Icon
                aria-hidden="true"
                className="drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]"
                color="white"
                height={18}
                icon={activeFloorplanCursorIndicator.icon}
                width={18}
              />
            )}
          </div>
        )}
        {showGuides && canInteractWithGuides && selectedGuide && (
          <FloorplanGuideHandleHint
            anchor={guideHandleHintAnchor}
            isDarkMode={theme === 'dark'}
            isMacPlatform={isMacPlatform}
            rotationModifierPressed={rotationModifierPressed}
          />
        )}
        {selectedOpeningActionMenuPosition && isFloorplanHovered && !movingNode && (
          <div
            className="absolute z-30"
            style={{
              left: selectedOpeningActionMenuPosition.x,
              top: selectedOpeningActionMenuPosition.y,
              transform: `translate(-50%, calc(-100% - ${FLOORPLAN_ACTION_MENU_OFFSET_Y}px))`,
            }}
          >
            <NodeActionMenu
              onDelete={handleSelectedOpeningDelete}
              onDuplicate={handleSelectedOpeningDuplicate}
              onMove={handleSelectedOpeningMove}
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
            />
          </div>
        )}

        {!levelNode && phase !== 'site' ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-muted-foreground text-sm">
            Switch to a building level to view and edit the floorplan.
          </div>
        ) : (
          <svg
            className="h-full w-full touch-none"
            data-floorplan-svg="true"
            onClick={isMarqueeSelectionToolActive ? undefined : handleBackgroundClick}
            onContextMenu={(event) => event.preventDefault()}
            onDoubleClick={isMarqueeSelectionToolActive ? undefined : handleBackgroundDoubleClick}
            onDragOver={handleSymbolDragOver}
            onDrop={handleSymbolDrop}
            onPointerCancel={endPanning}
            onPointerDown={handlePointerDown}
            onPointerLeave={handleSvgPointerLeave}
            onPointerMove={handleSvgPointerMove}
            onPointerUp={endPanning}
            ref={svgRef}
            style={{ cursor: EDITOR_CURSOR }}
            viewBox={`${viewBox.minX} ${viewBox.minY} ${viewBox.width} ${viewBox.height}`}
          >
            <rect
              fill={palette.surface}
              height={viewBox.height}
              width={viewBox.width}
              x={viewBox.minX}
              y={viewBox.minY}
            />

            <FloorplanGridLayer
              majorGridPath={majorGridPath}
              minorGridPath={minorGridPath}
              palette={palette}
              showGrid={showGrid}
            />

            {/* Ritn3D: Ghost floor below — faint dashed walls from level below */}
            {ghostWallPolygons.length > 0 && (
              <g opacity={0.4} pointerEvents="none">
                {ghostWallPolygons.map(({ wall, points }) => (
                  <polygon
                    key={wall.id}
                    fill="#6366f1"
                    fillOpacity={0.12}
                    points={points}
                    stroke="#6366f1"
                    strokeDasharray="0.15 0.08"
                    strokeLinejoin="round"
                    strokeOpacity={0.7}
                    strokeWidth="0.04"
                  />
                ))}
              </g>
            )}

            <FloorplanGuideLayer
              activeGuideInteractionGuideId={activeGuideInteractionGuideId}
              activeGuideInteractionMode={activeGuideInteractionMode}
              guides={displayGuides}
              isInteractive={canInteractWithGuides}
              onGuideSelect={handleGuideSelect}
              onGuideTranslateStart={handleGuideTranslateStart}
              selectedGuideId={selectedGuideId}
            />

            <FloorplanSiteLayer isEditing={isSiteEditActive} sitePolygon={visibleSitePolygon} unit={unit} showDimensions={isSiteEditActive} />

            <FloorplanGeometryLayer
              canSelectGeometry={canSelectElementFloorplanGeometry}
              canSelectSlabs={canSelectElementFloorplanGeometry && structureLayer !== 'zones'}
              hoveredOpeningId={hoveredOpeningId}
              hoveredWallId={hoveredWallId}
              onOpeningDoubleClick={handleOpeningDoubleClick}
              onOpeningHoverChange={setHoveredOpeningId}
              onOpeningSelect={handleOpeningSelect}
              onSlabDoubleClick={handleSlabDoubleClick}
              onSlabSelect={handleSlabSelect}
              onWallClick={handleWallClick}
              onWallDoubleClick={handleWallDoubleClick}
              onWallHoverChange={setHoveredWallId}
              openingsPolygons={openingsPolygons}
              palette={palette}
              selectedIdSet={selectedIdSet}
              slabPolygons={displaySlabPolygons}
              unit={unit}
              wallPolygons={displayWallPolygons}
            />

            <FloorplanZoneLayer
              canSelectZones={canSelectFloorplanZones}
              onZoneSelect={handleZoneSelect}
              palette={palette}
              selectedZoneId={selectedZoneId}
              unit={unit}
              zonePolygons={visibleZonePolygons}
            />

            <FloorplanPolygonHandleLayer
              hoveredHandleId={hoveredSiteHandleId}
              midpointHandles={siteMidpointHandles}
              onHandleHoverChange={setHoveredSiteHandleId}
              onMidpointPointerDown={(nodeId, edgeIndex, event) =>
                handleSiteMidpointPointerDown(nodeId as SiteNode['id'], edgeIndex, event)
              }
              onVertexDoubleClick={(nodeId, vertexIndex, event) =>
                handleSiteVertexDoubleClick(nodeId as SiteNode['id'], vertexIndex, event)
              }
              onVertexPointerDown={(nodeId, vertexIndex, event) =>
                handleSiteVertexPointerDown(nodeId as SiteNode['id'], vertexIndex, event)
              }
              palette={palette}
              vertexHandles={siteVertexHandles}
            />

            {isMarqueeSelectionToolActive && (
              <rect
                fill="transparent"
                height={viewBox.height}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onDoubleClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onPointerCancel={handleMarqueePointerCancel}
                onPointerDown={handleMarqueePointerDown}
                onPointerMove={handleMarqueePointerMove}
                onPointerUp={handleMarqueePointerUp}
                style={{ cursor: EDITOR_CURSOR }}
                width={viewBox.width}
                x={viewBox.minX}
                y={viewBox.minY}
              />
            )}

            {visibleSvgMarqueeBounds && (
              <rect
                fill={palette.selectedFill}
                fillOpacity={0.14}
                height={visibleSvgMarqueeBounds.height}
                pointerEvents="none"
                stroke={palette.selectedStroke}
                strokeDasharray="0.16 0.1"
                strokeWidth="0.05"
                vectorEffect="non-scaling-stroke"
                width={visibleSvgMarqueeBounds.width}
                x={visibleSvgMarqueeBounds.x}
                y={visibleSvgMarqueeBounds.y}
              />
            )}

            {draftPolygon && (
              <>
                <polygon
                  fill={palette.draftFill}
                  fillOpacity={0.35}
                  points={draftPolygonPoints ?? undefined}
                  stroke={palette.draftStroke}
                  strokeDasharray="0.24 0.12"
                  strokeWidth="0.07"
                  vectorEffect="non-scaling-stroke"
                />
                {/* Ritn3D: angle + length label while drawing */}
                {draftStart && draftEnd && (() => {
                  const dx = draftEnd[0] - draftStart[0]
                  const dz = draftEnd[1] - draftStart[1]
                  const length = Math.hypot(dx, dz)
                  if (length < 0.1) return null
                  const angleDeg = ((Math.atan2(-dz, dx) * 180) / Math.PI + 360) % 360
                  const displayAngle = angleDeg > 180 ? angleDeg - 360 : angleDeg
                  const midX = toSvgX((draftStart[0] + draftEnd[0]) / 2)
                  const midY = toSvgY((draftStart[1] + draftEnd[1]) / 2)
                  const fontSize = getMeasureLabelFontSize()
                  const nx = -(-dz / length)
                  const ny = -(dx / length)
                  const offset = fontSize * 2.5
                  return (
                    <text
                      dominantBaseline="central"
                      fill={palette.draftStroke}
                      fillOpacity={0.9}
                      fontSize={fontSize}
                      fontWeight="700"
                      pointerEvents="none"
                      textAnchor="middle"
                      x={midX + nx * offset}
                      y={midY + ny * offset}
                    >
                      {formatMeasurement(length, unit)} · {Math.abs(Math.round(displayAngle))}°
                    </text>
                  )
                })()}
              </>
            )}

            {polygonDraftPolygonPoints && (
              <polygon
                fill={palette.draftFill}
                fillOpacity={0.2}
                points={polygonDraftPolygonPoints}
                stroke="none"
              />
            )}

            {polygonDraftPolylinePoints && (
              <polyline
                fill="none"
                points={polygonDraftPolylinePoints}
                stroke={palette.draftStroke}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="0.08"
                vectorEffect="non-scaling-stroke"
              />
            )}

            {polygonDraftClosingSegment && (
              <line
                stroke={palette.draftStroke}
                strokeDasharray="0.16 0.1"
                strokeLinecap="round"
                strokeOpacity={0.75}
                strokeWidth="0.05"
                vectorEffect="non-scaling-stroke"
                x1={polygonDraftClosingSegment.x1}
                x2={polygonDraftClosingSegment.x2}
                y1={polygonDraftClosingSegment.y1}
                y2={polygonDraftClosingSegment.y2}
              />
            )}

            {activePolygonDraftPoints.map((point, index) => (
              <circle
                cx={toSvgX(point[0])}
                cy={toSvgY(point[1])}
                fill={index === 0 ? palette.anchor : palette.draftStroke}
                fillOpacity={0.95}
                key={`polygon-draft-${index}`}
                pointerEvents="none"
                r={index === 0 ? 0.12 : 0.1}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {/* Ritn3D items (symbols / furniture). Renders the SVG thumbnail
                as a top-down image sized by (dimensions.x × dimensions.z),
                rotated by item.rotation[1] (the Y-axis spin, which is the
                plan-view rotation). Plan-coordinate space units = SVG units
                in this viewBox, so the math is a direct map. */}
            {levelItems.map((item) => {
              const [w, , d] = item.asset.dimensions
              const px = item.position[0]
              const pz = item.position[2]
              const yRotRad = item.rotation[1] ?? 0
              const yRotDeg = (yRotRad * 180) / Math.PI
              const svgC = toSvgPoint({ x: px, y: pz })
              const halfW = w / 2
              const halfD = d / 2
              const isSelected = selectedIdSet.has(item.id)
              return (
                <g
                  key={item.id}
                  transform={`rotate(${yRotDeg} ${svgC.x} ${svgC.y})`}
                >
                  <rect
                    x={svgC.x - halfW}
                    y={svgC.y - halfD}
                    width={w}
                    height={d}
                    fill="#f3f4f6"
                    stroke={isSelected ? '#3b82f6' : 'rgba(120,140,200,0.7)'}
                    strokeWidth={isSelected ? '0.05' : '0.03'}
                    vectorEffect="non-scaling-stroke"
                    style={{ cursor: 'move' }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return
                      event.stopPropagation()
                      // Select the item (replaces selection).
                      setSelection({ selectedIds: [item.id] })
                      // Start move drag.
                      const planPoint = getPlanPointFromClientPoint(
                        event.clientX,
                        event.clientY,
                      )
                      if (!planPoint) return
                      itemMoveDragRef.current = {
                        pointerId: event.pointerId,
                        itemId: item.id,
                        startPlan: planPoint,
                        initialPos: [...item.position] as [number, number, number],
                      }
                      ;(event.currentTarget as Element).setPointerCapture?.(event.pointerId)
                    }}
                  />
                  {item.asset.thumbnail && (
                    <image
                      href={item.asset.thumbnail}
                      x={svgC.x - halfW}
                      y={svgC.y - halfD}
                      width={w}
                      height={d}
                      preserveAspectRatio="xMidYMid meet"
                      pointerEvents="none"
                    />
                  )}
                  {/* Selection accents + rotation handle. Rotation handle sits
                      above the item's "north" edge (in local frame), connected
                      by a thin line — the standard CAD convention. Hold Shift
                      while rotating to snap to 15°. */}
                  {isSelected && (
                    <>
                      <line
                        x1={svgC.x}
                        y1={svgC.y - halfD}
                        x2={svgC.x}
                        y2={svgC.y - halfD - 0.4}
                        stroke="#3b82f6"
                        strokeWidth="0.03"
                        vectorEffect="non-scaling-stroke"
                      />
                      <circle
                        cx={svgC.x}
                        cy={svgC.y - halfD - 0.4}
                        r="0.13"
                        fill="#3b82f6"
                        stroke="#fff"
                        strokeWidth="0.03"
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: 'grab' }}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return
                          event.stopPropagation()
                          const planPoint = getPlanPointFromClientPoint(
                            event.clientX,
                            event.clientY,
                          )
                          if (!planPoint) return
                          const dx = planPoint[0] - px
                          const dz = planPoint[1] - pz
                          itemRotateDragRef.current = {
                            pointerId: event.pointerId,
                            itemId: item.id,
                            centerPlan: [px, pz],
                            initialRotY: yRotRad,
                            startAngleFromCenter: Math.atan2(dz, dx),
                          }
                          ;(event.currentTarget as Element).setPointerCapture?.(
                            event.pointerId,
                          )
                        }}
                      />
                    </>
                  )}
                </g>
              )
            })}

            <FloorplanWallEndpointLayer
              endpointHandles={wallEndpointHandles}
              hoveredEndpointId={hoveredEndpointId}
              onEndpointHoverChange={setHoveredEndpointId}
              onWallEndpointPointerDown={handleWallEndpointPointerDown}
              palette={palette}
            />

            {/* Bulge handles: small accent-coloured dot at each selected
                wall's arc midpoint (or chord midpoint when straight). Drag
                to bend / re-shape the wall. Rendered AFTER endpoints so the
                bulge handle wins for clicks at the wall's exact midpoint of
                a tiny wall — fine for our use. */}
            {wallBulgeHandles.map(({ wall, point, isActive }) => {
              const svg = toSvgPoint({ x: point[0], y: point[1] })
              // Bigger handle + larger hit area so it's easy to grab even at
              // small zoom. Pulsing ring when not actively dragging draws the
              // eye for users who don't know what it does.
              return (
                <g key={`bulge-${wall.id}`}>
                  {/* Hit / halo circle. */}
                  <circle
                    cx={svg.x}
                    cy={svg.y}
                    fill={isActive ? palette.selectedFill : 'rgba(108,180,255,0.32)'}
                    pointerEvents="none"
                    r={0.28}
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Visible body — larger than before so it's findable. */}
                  <circle
                    cx={svg.x}
                    cy={svg.y}
                    fill={isActive ? '#a3c2ff' : '#6cb4ff'}
                    onPointerDown={(event) => handleWallBulgePointerDown(wall, event)}
                    r={0.16}
                    stroke="#ffffff"
                    strokeWidth="0.03"
                    style={{ cursor: 'grab' }}
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Hint dot in the centre. */}
                  <circle
                    cx={svg.x}
                    cy={svg.y}
                    r={0.04}
                    fill="#ffffff"
                    pointerEvents="none"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              )
            })}

            <FloorplanPolygonHandleLayer
              hoveredHandleId={hoveredSlabHandleId}
              midpointHandles={slabMidpointHandles}
              onHandleHoverChange={setHoveredSlabHandleId}
              onMidpointPointerDown={(nodeId, edgeIndex, event) =>
                handleSlabMidpointPointerDown(nodeId as SlabNode['id'], edgeIndex, event)
              }
              onVertexDoubleClick={(nodeId, vertexIndex, event) =>
                handleSlabVertexDoubleClick(nodeId as SlabNode['id'], vertexIndex, event)
              }
              onVertexPointerDown={(nodeId, vertexIndex, event) =>
                handleSlabVertexPointerDown(nodeId as SlabNode['id'], vertexIndex, event)
              }
              palette={palette}
              vertexHandles={slabVertexHandles}
            />

            <FloorplanPolygonHandleLayer
              hoveredHandleId={hoveredZoneHandleId}
              midpointHandles={zoneMidpointHandles}
              onHandleHoverChange={setHoveredZoneHandleId}
              onMidpointPointerDown={(nodeId, edgeIndex, event) =>
                handleZoneMidpointPointerDown(nodeId as ZoneNodeType['id'], edgeIndex, event)
              }
              onVertexDoubleClick={(nodeId, vertexIndex, event) =>
                handleZoneVertexDoubleClick(nodeId as ZoneNodeType['id'], vertexIndex, event)
              }
              onVertexPointerDown={(nodeId, vertexIndex, event) =>
                handleZoneVertexPointerDown(nodeId as ZoneNodeType['id'], vertexIndex, event)
              }
              palette={palette}
              vertexHandles={zoneVertexHandles}
            />

            {selectedGuide && showGuides && (
              <FloorplanGuideSelectionOverlay
                guide={selectedGuide}
                isDarkMode={theme === 'dark'}
                onCornerHoverChange={setHoveredGuideCorner}
                onCornerPointerDown={handleGuideCornerPointerDown}
                rotationModifierPressed={rotationModifierPressed}
                showHandles={canInteractWithGuides}
              />
            )}

            {cursorPoint && (
              <g>
                <circle
                  cx={toSvgX(cursorPoint[0])}
                  cy={toSvgY(cursorPoint[1])}
                  fill={floorplanCursorColor}
                  fillOpacity={0.25}
                  r={FLOORPLAN_CURSOR_MARKER_GLOW_RADIUS}
                />
                <circle
                  cx={toSvgX(cursorPoint[0])}
                  cy={toSvgY(cursorPoint[1])}
                  fill={floorplanCursorColor}
                  fillOpacity={0.9}
                  r={FLOORPLAN_CURSOR_MARKER_CORE_RADIUS}
                />
              </g>
            )}

            {activeDraftAnchorPoint && (
              <circle
                cx={toSvgX(activeDraftAnchorPoint[0])}
                cy={toSvgY(activeDraftAnchorPoint[1])}
                fill={palette.anchor}
                fillOpacity={0.95}
                r="0.14"
                vectorEffect="non-scaling-stroke"
              />
            )}

            {/* Bulge drag chord guide — VERY visible: thick bright magenta
                dashed line so the user can see where "straight" is. The
                chord lives inside the wall body and is invisible by default;
                the user needs to drag the cursor onto this line to make the
                wall straight, so we render it on top of EVERYTHING with
                vector-effect non-scaling-stroke for screen-px width. */}
            {wallBulgeDraft && (() => {
              const drag = wallBulgeDragRef.current
              if (!drag) return null
              const a = toSvgPoint({ x: drag.start[0], y: drag.start[1] })
              const b = toSvgPoint({ x: drag.end[0], y: drag.end[1] })
              return (
                <g key="bulge-chord-guide" pointerEvents="none">
                  {/* White halo for contrast against the dark wall body */}
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="#ffffff"
                    strokeWidth="6"
                    strokeOpacity="0.7"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Bright magenta dashed line on top */}
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="#ec4899"
                    strokeWidth="3"
                    strokeDasharray="8 6"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Endpoint dots so the user can see where the wall ends */}
                  <circle cx={a.x} cy={a.y} r="0.12" fill="#ec4899" stroke="#fff" strokeWidth="0.04" vectorEffect="non-scaling-stroke" />
                  <circle cx={b.x} cy={b.y} r="0.12" fill="#ec4899" stroke="#fff" strokeWidth="0.04" vectorEffect="non-scaling-stroke" />
                </g>
              )
            })()}

            {/* Scale-calibration overlay: dots at P1/P2 + line between them.
                Drawn last so it's on top of everything. */}
            {calibratingGuideId && calibrationP1 && (() => {
              const a = toSvgPoint({ x: calibrationP1[0], y: calibrationP1[1] })
              const b = calibrationP2
                ? toSvgPoint({ x: calibrationP2[0], y: calibrationP2[1] })
                : null
              return (
                <g key="calibration-overlay">
                  {b && (
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke="#fbbf24"
                      strokeWidth="0.06"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  <circle cx={a.x} cy={a.y} r="0.14" fill="#fbbf24" stroke="#000" strokeWidth="0.025" vectorEffect="non-scaling-stroke" />
                  {b && (
                    <circle cx={b.x} cy={b.y} r="0.14" fill="#fbbf24" stroke="#000" strokeWidth="0.025" vectorEffect="non-scaling-stroke" />
                  )}
                </g>
              )
            })()}
          </svg>
        )}

        {/* Ritn3D 2026-06-17: inline curve editor. Drag handle precision is
            limited by pixel density (a 50cm wall has ~25cm of dragable range,
            ~50px on screen — sub-cm precision is impossible). Putting the
            slider + number input INSIDE the canvas, bottom-centre, means the
            user gets a CAD-grade precision control right where their eye is.
            Side-panel slider stays as a redundancy. Hidden during active drag
            so the live drag readout (below) doesn't overlap. */}
        {!wallBulgeDraft && mode === 'select' && selectedIds.length === 1 && (() => {
          const wall = wallById.get(selectedIds[0] as WallNode['id'])
          if (!wall || wall.type !== 'wall') return null
          const chord = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])
          if (chord < 0.01) return null
          const halfChordCm = Math.max(10, Math.floor(chord * 50))
          const bulge = wall.bulge ?? 0
          // Ritn3D 2026-06-17: slider is MAGNITUDE-only (0 = straight, max =
          // semicircle). Direction is a separate Flip toggle. The previous
          // bidirectional ±half-chord slider made the user start in the
          // middle and didn't match how architects think ('curve depth' is
          // unsigned; the side is a separate decision).
          const absDepthCm = Math.round((chord * Math.abs(bulge)) / 2 * 100)
          const sweepDeg = Math.round(Math.abs(4 * Math.atan(bulge) * 180 / Math.PI))
          // Sign defaults to +1 when the wall is currently straight, so the
          // first slider movement always produces a visible curve in a
          // predictable direction. Flip swaps the side.
          const currentSign = bulge > 0 ? 1 : bulge < 0 ? -1 : 1
          const setAbsDepthCm = (cm: number) => {
            const safe = Math.max(0, Math.min(halfChordCm, Math.abs(cm)))
            const nextBulge = (currentSign * 2 * (safe / 100)) / chord
            const clamped = Math.max(-1, Math.min(1, nextBulge))
            updateNode(wall.id, { bulge: Math.abs(clamped) < 1e-5 ? 0 : clamped })
          }
          const flipDirection = () => {
            if (Math.abs(bulge) > 1e-5) updateNode(wall.id, { bulge: -bulge })
          }
          return (
            <div
              className="pointer-events-auto fixed bottom-24 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-amber-500/40 bg-background/95 px-4 py-2 shadow-2xl backdrop-blur-md"
            >
              <span className="text-xs font-semibold text-amber-200">Curve</span>
              <span className="text-[10px] text-zinc-400">flat</span>
              <input
                type="range"
                min={0}
                max={halfChordCm}
                step={1}
                value={absDepthCm}
                onChange={(e) => setAbsDepthCm(Number(e.target.value))}
                className="w-64 accent-amber-500"
              />
              <span className="text-[10px] text-zinc-400">semi</span>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={absDepthCm}
                  min={0}
                  max={halfChordCm}
                  step={1}
                  onChange={(e) => setAbsDepthCm(Number(e.target.value))}
                  className="w-16 rounded border border-border bg-background/60 px-2 py-1 text-right font-mono text-xs text-foreground focus:border-amber-500 focus:outline-none"
                />
                <span className="text-[11px] text-zinc-400">cm</span>
              </div>
              <span className="font-mono text-[11px] text-zinc-500">
                {sweepDeg}°
              </span>
              <button
                type="button"
                onClick={() => setAbsDepthCm(0)}
                className="rounded border border-zinc-600 bg-zinc-700/40 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
              >
                Straight
              </button>
              <button
                type="button"
                onClick={flipDirection}
                disabled={absDepthCm === 0}
                className="rounded border border-zinc-600 bg-zinc-700/40 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-zinc-700/40"
              >
                {bulge >= 0 ? '↻ Flip side' : '↺ Flip side'}
              </button>
            </div>
          )
        })()}

        {/* Bulge live readout — fixed badge bottom-center showing the
            current bulge / sagitta during a drag. Without this the user
            can lose track of what they're producing when the cursor wanders
            and they release at a value they didn't intend. */}
        {wallBulgeDraft && (() => {
          const drag = wallBulgeDragRef.current
          if (!drag) return null
          const chord = Math.hypot(
            drag.end[0] - drag.start[0],
            drag.end[1] - drag.start[1],
          )
          const sagitta = (chord * Math.abs(wallBulgeDraft.bulge)) / 2
          const sweepDeg = Math.abs(4 * Math.atan(wallBulgeDraft.bulge) * 180 / Math.PI)
          const isStraightNow = Math.abs(wallBulgeDraft.bulge) < 1e-5
          return (
            <div
              className="pointer-events-none fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-amber-500/40 bg-background/95 px-4 py-1.5 shadow-2xl backdrop-blur-md"
            >
              <span className="font-mono text-xs font-bold text-amber-200">
                {isStraightNow ? '⟶ STRAIGHT' : `peak: ${(sagitta * 100).toFixed(0)}cm · ${sweepDeg.toFixed(0)}°`}
              </span>
              <span className="text-[10px] text-amber-300/80">
                drag away from wall → bigger curve · drag toward → smaller
              </span>
            </div>
          )
        })()}

        {/* Scale-calibration input panel — appears once both points are set.
            HTML overlay (NOT inside the SVG) so the <input> is a real text
            field with full keyboard handling. Positioned near the bottom of
            the canvas as a small floating card. */}
        {calibratingGuideId && calibrationP1 && calibrationP2 && (
          <div
            className="pointer-events-auto fixed bottom-10 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-amber-500/40 bg-background/95 px-3 py-2.5 shadow-2xl backdrop-blur-md"
          >
            <span className="text-amber-200 text-xs font-medium">Real distance:</span>
            <input
              autoFocus
              type="text"
              inputMode="decimal"
              value={calibrationInput}
              onChange={(e) => setCalibrationInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyCalibration()
              }}
              placeholder="e.g. 3.6"
              className="w-24 rounded-md border border-border bg-background/60 px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
            />
            <div className="flex overflow-hidden rounded-md border border-border">
              <button
                type="button"
                onClick={() => setCalibrationUnit('m')}
                className={cn(
                  'px-2 py-1 text-xs font-medium',
                  calibrationUnit === 'm' ? 'bg-amber-500/30 text-amber-100' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                m
              </button>
              <button
                type="button"
                onClick={() => setCalibrationUnit('ft')}
                className={cn(
                  'px-2 py-1 text-xs font-medium',
                  calibrationUnit === 'ft' ? 'bg-amber-500/30 text-amber-100' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                ft
              </button>
            </div>
            <button
              type="button"
              onClick={applyCalibration}
              className="rounded-md bg-amber-500/80 px-3 py-1 text-xs font-semibold text-amber-950 hover:bg-amber-500"
            >
              Apply
            </button>
          </div>
        )}

      </div>
    </div>
  )
}
