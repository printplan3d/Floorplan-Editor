"use client";

import { Icon } from "@iconify/react";
import {
  type AnyNode,
  type AnyNodeId,
  arcLength,
  arcMidpoint,
  type BuildingNode,
  bulgeFromThreePoints,
  calculateLevelMiters,
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  DoorNode,
  emitter,
  getWallPlanFootprint,
  type GuideNode,
  isStraight,
  ItemNode,
  LevelNode,
  loadAssetUrl,
  type Point2D,
  pointAndTangentAtT,
  type SiteNode,
  SlabNode,
  StairNode,
  suggestStairFootprint,
  tessellateArc,
  useScene,
  type WallNode,
  WindowNode,
  ZoneNode as ZoneNodeSchema,
  type ZoneNode as ZoneNodeType,
} from "@ritn3d/core";
import {
  DEFAULT_LEVEL_HEIGHT,
  getLevelHeight,
  useViewer,
} from "@ritn3d/viewer";
import { ChevronDown, Command, Plus, X } from "lucide-react";
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { sfxEmitter } from "../../lib/sfx-bus";
import { cn } from "../../lib/utils";
import useEditor from "../../store/use-editor";
import { FLOORPLAN_SYMBOL_MIME } from "../ui/symbol-catalog";
import { snapToHalf } from "../tools/item/placement-math";
import {
  createWallOnCurrentLevel,
  isWallLongEnough,
  snapPointToGrid,
  snapWallDraftPoint,
  WALL_GRID_STEP,
  type WallPlanPoint,
} from "../tools/wall/wall-drafting";
import { furnishTools } from "../ui/action-menu/furnish-tools";
import {
  buildStairPlan,
  isPointInStairPlan,
  polygonToPath,
  type StairPlan,
  toStairSvg,
} from "../../lib/stair-plan";
import { tools as structureTools } from "../ui/action-menu/structure-tools";
import { SliderControl } from "../ui/controls/slider-control";
import { PALETTE_COLORS } from "../ui/primitives/color-dot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/primitives/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/primitives/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../ui/primitives/tooltip";
import { NodeActionMenu } from "./node-action-menu";

// 2026-07-28: bumped 12 -> 15 so a new empty plan opens with a bit
// more breathing room around the origin. With the 1 m grid this
// shows ~15 boxes across the viewport, comfortable for orienting a
// typical home floor plan (12-15 m wide) before drawing.
const FALLBACK_VIEW_SIZE = 15;
const FLOORPLAN_PADDING = 2;
const MIN_VIEWPORT_WIDTH_RATIO = 0.08;
const MAX_VIEWPORT_WIDTH_RATIO = 40;
const PANEL_MIN_WIDTH = 420;
const PANEL_MIN_HEIGHT = 320;
const PANEL_DEFAULT_WIDTH = 560;
const PANEL_DEFAULT_HEIGHT = 360;
const PANEL_MARGIN = 16;
const PANEL_DEFAULT_BOTTOM_OFFSET = 96;
const MIN_GRID_SCREEN_SPACING = 8;
const GRID_COORDINATE_PRECISION = 6;
const MAJOR_GRID_STEP = WALL_GRID_STEP * 2;
const FLOORPLAN_WALL_THICKNESS_SCALE = 1.18;
const FLOORPLAN_MIN_VISIBLE_WALL_THICKNESS = 0.13;

/**
 * Width of a newly placed door / window, in metres.
 *
 * Ritn3D 2026-08-01: single source for BOTH the placement ghost and the node
 * that gets created. They had drifted: the ghost drew a window 1.0 m wide
 * while WindowNode's schema default made the actual window 1.5 m, so users
 * got an opening 50% wider than the one they aimed with. Doors happened to
 * agree at 0.9 only by coincidence.
 *
 * Creation now passes these explicitly instead of relying on the schema
 * defaults, so the two cannot drift apart again.
 */
const NEW_OPENING_WIDTH_M = { door: 0.9, window: 1.5 } as const;
const FLOORPLAN_MAX_EXTRA_THICKNESS = 0.035;
const FLOORPLAN_PANEL_LAYOUT_STORAGE_KEY =
  "pascal-editor-floorplan-panel-layout";
const EMPTY_WALL_MITER_DATA = calculateLevelMiters([]);
const EDITOR_CURSOR = "url('/cursor.svg') 4 2, default";
const FLOORPLAN_CURSOR_INDICATOR_OFFSET_X = 20;
const FLOORPLAN_CURSOR_INDICATOR_OFFSET_Y = 14;
const FLOORPLAN_CURSOR_MARKER_CORE_RADIUS = 0.06;
const FLOORPLAN_CURSOR_MARKER_GLOW_RADIUS = 0.2;
const FLOORPLAN_HOVER_TRANSITION = "opacity 180ms cubic-bezier(0.2, 0, 0, 1)";
const FLOORPLAN_WALL_HIT_STROKE_WIDTH = 18;
const FLOORPLAN_WALL_HOVER_GLOW_STROKE_WIDTH = 18;
const FLOORPLAN_WALL_HOVER_RING_STROKE_WIDTH = 8;
const FLOORPLAN_OPENING_HIT_STROKE_WIDTH = 16;
const FLOORPLAN_OPENING_STROKE_WIDTH = 0.05;
const FLOORPLAN_OPENING_DETAIL_STROKE_WIDTH = 0.02;
const FLOORPLAN_OPENING_DASHED_STROKE_WIDTH = 0.02;
const FLOORPLAN_ENDPOINT_HIT_STROKE_WIDTH = 18;
const FLOORPLAN_ENDPOINT_HOVER_GLOW_STROKE_WIDTH = 16;
const FLOORPLAN_ENDPOINT_HOVER_RING_STROKE_WIDTH = 7;
const FLOORPLAN_MARQUEE_DRAG_THRESHOLD_PX = 4;
// Measurement sizing scales with viewport — larger canvas = bigger labels
// Base values for a ~10m viewport, scaled by viewWidth/10
let _measureScale = 1;
function setMeasureScale(viewBoxWidth: number) {
  _measureScale = Math.max(0.5, Math.min(3, viewBoxWidth / 10));
}
const FLOORPLAN_MEASUREMENT_OFFSET_BASE = 0.46;
const FLOORPLAN_MEASUREMENT_EXTENSION_OVERSHOOT_BASE = 0.08;
const FLOORPLAN_MEASUREMENT_LABEL_GAP_BASE = 0.56;
const FLOORPLAN_MEASUREMENT_LABEL_LINE_PADDING_BASE = 0.14;
const FLOORPLAN_MEASUREMENT_LABEL_FONT_SIZE_BASE = 0.17;
const FLOORPLAN_MEASUREMENT_LABEL_STROKE_WIDTH_BASE = 0.06;

// Dynamic getters
function getMeasureOffset() {
  return FLOORPLAN_MEASUREMENT_OFFSET_BASE * _measureScale;
}
function getMeasureExtOvershoot() {
  return FLOORPLAN_MEASUREMENT_EXTENSION_OVERSHOOT_BASE * _measureScale;
}
function getMeasureLabelGap() {
  return FLOORPLAN_MEASUREMENT_LABEL_GAP_BASE * _measureScale;
}
function getMeasureLabelLinePadding() {
  return FLOORPLAN_MEASUREMENT_LABEL_LINE_PADDING_BASE * _measureScale;
}
function getMeasureLabelFontSize() {
  return FLOORPLAN_MEASUREMENT_LABEL_FONT_SIZE_BASE * _measureScale;
}
function getMeasureLabelStrokeWidth() {
  return FLOORPLAN_MEASUREMENT_LABEL_STROKE_WIDTH_BASE * _measureScale;
}

// Fixed (pixel-based via vectorEffect, no scaling needed)
const FLOORPLAN_MEASUREMENT_LINE_WIDTH = 2.0;
const FLOORPLAN_MEASUREMENT_LINE_OUTLINE_WIDTH = 4.0;
const FLOORPLAN_MEASUREMENT_LINE_OPACITY = 0.9;
const FLOORPLAN_MEASUREMENT_LINE_OUTLINE_OPACITY = 1.0;
const FLOORPLAN_MEASUREMENT_LABEL_OPACITY = 0.95;

// Compat aliases for code that still uses the old constants
const FLOORPLAN_MEASUREMENT_OFFSET = FLOORPLAN_MEASUREMENT_OFFSET_BASE;
const FLOORPLAN_MEASUREMENT_EXTENSION_OVERSHOOT =
  FLOORPLAN_MEASUREMENT_EXTENSION_OVERSHOOT_BASE;
const FLOORPLAN_MEASUREMENT_LABEL_FONT_SIZE =
  FLOORPLAN_MEASUREMENT_LABEL_FONT_SIZE_BASE;
const FLOORPLAN_MEASUREMENT_LABEL_STROKE_WIDTH =
  FLOORPLAN_MEASUREMENT_LABEL_STROKE_WIDTH_BASE;
const FLOORPLAN_MEASUREMENT_LABEL_GAP = FLOORPLAN_MEASUREMENT_LABEL_GAP_BASE;
const FLOORPLAN_MEASUREMENT_LABEL_LINE_PADDING =
  FLOORPLAN_MEASUREMENT_LABEL_LINE_PADDING_BASE;
const FLOORPLAN_ACTION_MENU_HORIZONTAL_PADDING = 60;
const FLOORPLAN_ACTION_MENU_MIN_ANCHOR_Y = 56;
const FLOORPLAN_ACTION_MENU_OFFSET_Y = 10;
const FLOORPLAN_DEFAULT_WINDOW_LOCAL_Y = 1.5;
const FLOORPLAN_LEVEL_MENU_CLOSE_DELAY_MS = 120;
// Match the guide plane footprint used in the 3D renderer so the 2D overlay aligns.
const FLOORPLAN_GUIDE_BASE_WIDTH = 10;
const FLOORPLAN_GUIDE_MIN_SCALE = 0.01;
const FLOORPLAN_GUIDE_HANDLE_SIZE = 0.22;
const FLOORPLAN_GUIDE_HANDLE_HIT_RADIUS = 0.3;
const FLOORPLAN_GUIDE_SELECTION_STROKE_WIDTH = 0.05;
const FLOORPLAN_GUIDE_HANDLE_HINT_OFFSET = 72;
const FLOORPLAN_GUIDE_HANDLE_HINT_PADDING_X = 92;
const FLOORPLAN_GUIDE_HANDLE_HINT_PADDING_Y = 48;
const FLOORPLAN_GUIDE_ROTATION_SNAP_DEGREES = 45;
const FLOORPLAN_GUIDE_ROTATION_FINE_SNAP_DEGREES = 1;
const FLOORPLAN_SITE_COLOR = "#10b981";

type FloorplanViewport = {
  centerX: number;
  centerY: number;
  width: number;
};

type SvgPoint = {
  x: number;
  y: number;
};

type PanState = {
  pointerId: number;
  clientX: number;
  clientY: number;
};

type GestureLikeEvent = Event & {
  clientX?: number;
  clientY?: number;
  scale?: number;
};

type PanelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type PanelInteractionState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  initialRect: PanelRect;
  type: "drag" | "resize";
  direction?: ResizeDirection;
};

type ViewportBounds = {
  width: number;
  height: number;
};

type OpeningNode = WindowNode | DoorNode;

type WallEndpoint = "start" | "end";

type FloorplanSelectionTool = "click" | "marquee";

type FloorplanCursorIndicator =
  | {
      kind: "asset";
      iconSrc: string;
    }
  | {
      kind: "icon";
      icon: string;
    };

// Ritn3D: 'arc-wall' added to the floor-plan toolbar. The structureTools
// entry uses iconNode (inline SVG) since we don't have a PNG for the arc
// wall yet — the render below conditionally uses iconNode when iconSrc is
// missing.
const FLOORPLAN_QUICK_BUILD_TOOL_IDS = [
  "wall",
  "arc-wall",
  "door",
  "window",
  "slab",
  "zone",
  "stair",
] as const;

type FloorplanQuickBuildTool = (typeof FLOORPLAN_QUICK_BUILD_TOOL_IDS)[number];

const FLOORPLAN_QUICK_BUILD_TOOL_LABELS: Record<
  FloorplanQuickBuildTool,
  string
> = {
  wall: "Wall",
  "arc-wall": "Arc Wall",
  door: "Door",
  window: "Window",
  slab: "Floor",
  zone: "Zone",
  stair: "Stair",
};

const FLOORPLAN_QUICK_BUILD_TOOL_FALLBACK_ICONS: Record<
  FloorplanQuickBuildTool,
  string | undefined
> = {
  wall: "/icons/wall.png",
  "arc-wall": undefined, // uses iconNode from structureTools
  door: "/icons/door.png",
  window: "/icons/window.png",
  slab: "/icons/floor.png",
  zone: "/icons/zone.png",
  stair: "/symbols/stairs/staircase.svg",
};

const FLOORPLAN_QUICK_BUILD_TOOLS = FLOORPLAN_QUICK_BUILD_TOOL_IDS.map((id) => {
  const toolConfig = structureTools.find((entry) => entry.id === id);

  return {
    id,
    iconSrc:
      toolConfig?.iconSrc ?? FLOORPLAN_QUICK_BUILD_TOOL_FALLBACK_ICONS[id],
    iconNode: toolConfig?.iconNode,
    label: FLOORPLAN_QUICK_BUILD_TOOL_LABELS[id],
  };
});

function getLevelDisplayLabel(level: LevelNode) {
  return level.name || `Level ${level.level}`;
}

type PersistedPanelLayout = {
  rect: PanelRect;
  viewport: ViewportBounds;
};

type FloorplanSelectionBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type FloorplanMarqueeState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPlanPoint: WallPlanPoint;
  currentPlanPoint: WallPlanPoint;
};

type WallEndpointDragState = {
  pointerId: number;
  wallId: WallNode["id"];
  endpoint: WallEndpoint;
  fixedPoint: WallPlanPoint;
  currentPoint: WallPlanPoint;
};

const GUIDE_CORNERS = ["nw", "ne", "se", "sw"] as const;

type GuideCorner = (typeof GUIDE_CORNERS)[number];

type GuideInteractionMode = "resize" | "rotate" | "translate";

type GuideTransformDraft = {
  guideId: GuideNode["id"];
  position: WallPlanPoint;
  scale: number;
  rotation: number;
};

type GuideHandleHintAnchor = {
  x: number;
  y: number;
  directionX: number;
  directionY: number;
};

type GuideInteractionState = {
  pointerId: number;
  guideId: GuideNode["id"];
  corner: GuideCorner;
  mode: GuideInteractionMode;
  aspectRatio: number;
  centerSvg: SvgPoint;
  oppositeCornerSvg: SvgPoint | null;
  pointerOffsetSvg: WallPlanPoint;
  rotationSvg: number;
  cornerBaseAngle: number;
  scale: number;
};

type WallEndpointDraft = {
  wallId: WallNode["id"];
  endpoint: WallEndpoint;
  start: WallPlanPoint;
  end: WallPlanPoint;
};

// Bulge drag — separate state from endpoint drag because the operation
// modifies a different field (wall.bulge) and the cursor is interpreted as
// the perpendicular offset midpoint, not a new endpoint. Lives in parallel
// with WallEndpointDragState so the existing endpoint drag is unchanged.
type WallBulgeDragState = {
  pointerId: number;
  wallId: WallNode["id"];
  start: WallPlanPoint;
  end: WallPlanPoint;
  // Relative drag state. We track the cursor's perpendicular offset and
  // chord-aligned offset at drag start, plus the wall's bulge at drag start.
  // On each pointer-move we compute the CHANGE in cursor perp vs drag start
  // and apply that delta to the initial bulge. That way small drag = small
  // bulge change regardless of how curved the wall already is.
  initialBulge: number;
  initialPerp: number;
  lastBulge: number;
  lastLogAt?: number;
};

type WallBulgeDraft = {
  wallId: WallNode["id"];
  bulge: number;
};

/** A slab edge being curved. edgeIndex i curves polygon[i] -> polygon[i+1]. */
type SlabBulgeDraft = {
  slabId: SlabNode["id"];
  /** null = an edge of the outline; a number = that hole's ring. */
  holeIndex: number | null;
  edgeIndex: number;
  bulge: number;
};

type SlabBoundaryDraft = {
  slabId: SlabNode["id"];
  polygon: WallPlanPoint[];
};

type SlabVertexDragState = {
  pointerId: number;
  slabId: SlabNode["id"];
  vertexIndex: number;
};

type SiteBoundaryDraft = {
  siteId: SiteNode["id"];
  polygon: WallPlanPoint[];
};

type SiteVertexDragState = {
  pointerId: number;
  siteId: SiteNode["id"];
  vertexIndex: number;
};

type ZoneBoundaryDraft = {
  zoneId: ZoneNodeType["id"];
  polygon: WallPlanPoint[];
};

type ZoneVertexDragState = {
  pointerId: number;
  zoneId: ZoneNodeType["id"];
  vertexIndex: number;
};

type WallPolygonEntry = {
  wall: WallNode;
  polygon: Point2D[];
  points: string;
};

type OpeningPolygonEntry = {
  opening: OpeningNode;
  polygon: Point2D[];
  points: string;
};

type SlabPolygonEntry = {
  slab: SlabNode;
  polygon: Point2D[];
  holes: Point2D[][];
  path: string;
};

type SitePolygonEntry = {
  site: SiteNode;
  polygon: Point2D[];
  points: string;
};

type ZonePolygonEntry = {
  zone: ZoneNodeType;
  polygon: Point2D[];
  points: string;
};

type FloorplanPalette = {
  surface: string;
  minorGrid: string;
  majorGrid: string;
  minorGridOpacity: number;
  majorGridOpacity: number;
  slabFill: string;
  slabStroke: string;
  selectedSlabFill: string;
  wallFill: string;
  wallStroke: string;
  wallHoverStroke: string;
  selectedFill: string;
  selectedStroke: string;
  draftFill: string;
  draftStroke: string;
  cursor: string;
  editCursor: string;
  anchor: string;
  openingFill: string;
  openingStroke: string;
  doorFill: string;
  doorStroke: string;
  windowFill: string;
  windowStroke: string;
  measurementStroke: string;
  // The storey below, drawn as an underlay. Deliberately a hue used nowhere
  // else on the plan: sharing the canvas blue-grey made the ghost read as
  // part of the current level rather than beneath it.
  ghostStroke: string;
  endpointHandleFill: string;
  endpointHandleStroke: string;
  endpointHandleHoverStroke: string;
  endpointHandleActiveFill: string;
  endpointHandleActiveStroke: string;
};

const resizeCursorByDirection: Record<ResizeDirection, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
  sw: "nesw-resize",
};

const resizeHandleConfigurations: Array<{
  direction: ResizeDirection;
  className: string;
}> = [
  {
    direction: "n",
    className: "absolute top-0 left-4 right-4 z-20 h-2 cursor-ns-resize",
  },
  {
    direction: "s",
    className: "absolute right-4 bottom-0 left-4 z-20 h-2 cursor-ns-resize",
  },
  {
    direction: "e",
    className: "absolute top-4 right-0 bottom-4 z-20 w-2 cursor-ew-resize",
  },
  {
    direction: "w",
    className: "absolute top-4 bottom-4 left-0 z-20 w-2 cursor-ew-resize",
  },
  {
    direction: "ne",
    className: "absolute top-0 right-0 z-20 h-4 w-4 cursor-nesw-resize",
  },
  {
    direction: "nw",
    className: "absolute top-0 left-0 z-20 h-4 w-4 cursor-nwse-resize",
  },
  {
    direction: "se",
    className: "absolute right-0 bottom-0 z-20 h-4 w-4 cursor-nwse-resize",
  },
  {
    direction: "sw",
    className: "absolute bottom-0 left-0 z-20 h-4 w-4 cursor-nesw-resize",
  },
];

const guideCornerSigns: Record<GuideCorner, { x: -1 | 1; y: -1 | 1 }> = {
  nw: { x: -1, y: -1 },
  ne: { x: 1, y: -1 },
  se: { x: 1, y: 1 },
  sw: { x: -1, y: 1 },
};

const oppositeGuideCorner: Record<GuideCorner, GuideCorner> = {
  nw: "se",
  ne: "sw",
  se: "nw",
  sw: "ne",
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getSelectionModifierKeys(event?: {
  metaKey?: boolean;
  ctrlKey?: boolean;
}) {
  return {
    meta: Boolean(event?.metaKey),
    ctrl: Boolean(event?.ctrlKey),
  };
}

function toPoint2D(point: WallPlanPoint): Point2D {
  return { x: point[0], y: point[1] };
}

function toWallPlanPoint(point: Point2D): WallPlanPoint {
  return [point.x, point.y];
}

function toSvgX(value: number): number {
  return -value;
}

function toSvgY(value: number): number {
  return -value;
}

function toSvgPoint(point: Point2D): SvgPoint {
  return {
    x: toSvgX(point.x),
    y: toSvgY(point.y),
  };
}

function toSvgPlanPoint(point: WallPlanPoint): SvgPoint {
  return {
    x: toSvgX(point[0]),
    y: toSvgY(point[1]),
  };
}

function toPlanPointFromSvgPoint(svgPoint: SvgPoint): WallPlanPoint {
  return [toSvgX(svgPoint.x), toSvgY(svgPoint.y)];
}

function rotateVector([x, y]: WallPlanPoint, angle: number): WallPlanPoint {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [x * cos - y * sin, x * sin + y * cos];
}

function addVectorToSvgPoint(
  point: SvgPoint,
  [dx, dy]: WallPlanPoint,
): SvgPoint {
  return {
    x: point.x + dx,
    y: point.y + dy,
  };
}

function subtractSvgPoints(point: SvgPoint, origin: SvgPoint): WallPlanPoint {
  return [point.x - origin.x, point.y - origin.y];
}

function midpointBetweenSvgPoints(start: SvgPoint, end: SvgPoint): SvgPoint {
  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  };
}

function getGuideWidth(scale: number) {
  return FLOORPLAN_GUIDE_BASE_WIDTH * scale;
}

function getGuideHeight(width: number, aspectRatio: number) {
  return width / aspectRatio;
}

function getGuideCenterSvgPoint(guide: GuideNode): SvgPoint {
  return {
    x: toSvgX(guide.position[0]),
    y: toSvgY(guide.position[2]),
  };
}

function getGuideCornerLocalOffset(
  width: number,
  height: number,
  corner: GuideCorner,
): WallPlanPoint {
  const signs = guideCornerSigns[corner];
  return [(width / 2) * signs.x, (height / 2) * signs.y];
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
  );
}

function snapAngleToIncrement(angle: number, incrementDegrees: number) {
  const incrementRadians = (incrementDegrees * Math.PI) / 180;
  return Math.round(angle / incrementRadians) * incrementRadians;
}

function toPositiveAngleDegrees(angle: number) {
  const angleDegrees = (angle * 180) / Math.PI;
  return ((angleDegrees % 180) + 180) % 180;
}

function getResizeCursorForAngle(angle: number) {
  const normalizedDegrees = toPositiveAngleDegrees(angle);

  if (normalizedDegrees < 22.5 || normalizedDegrees >= 157.5) {
    return "ew-resize";
  }

  if (normalizedDegrees < 67.5) {
    return "nwse-resize";
  }

  if (normalizedDegrees < 112.5) {
    return "ns-resize";
  }

  return "nesw-resize";
}

function getGuideResizeCursor(corner: GuideCorner, rotationSvg: number) {
  const signs = guideCornerSigns[corner];
  return getResizeCursorForAngle(Math.atan2(signs.y, signs.x) + rotationSvg);
}

function buildCursorUrl(
  svgMarkup: string,
  hotspotX: number,
  hotspotY: number,
  fallback: string,
) {
  return `url("data:image/svg+xml,${encodeURIComponent(svgMarkup)}") ${hotspotX} ${hotspotY}, ${fallback}`;
}

function getGuideRotateCursor(isDarkMode: boolean) {
  const strokeColor = isDarkMode ? "#ffffff" : "#09090b";
  const outlineColor = isDarkMode ? "#0a0e1b" : "#ffffff";
  const svgMarkup = `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M7 15.75a6 6 0 1 0 1.9-8.28" stroke="${outlineColor}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M7 5.5v4.5h4.5" stroke="${outlineColor}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M7 15.75a6 6 0 1 0 1.9-8.28" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M7 5.5v4.5h4.5" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `.trim();

  return buildCursorUrl(svgMarkup, 12, 12, "pointer");
}

function buildGuideTranslateDraft(
  interaction: GuideInteractionState,
  pointerSvg: SvgPoint,
): GuideTransformDraft {
  const centerSvg = addVectorToSvgPoint(pointerSvg, [
    -interaction.pointerOffsetSvg[0],
    -interaction.pointerOffsetSvg[1],
  ]);

  return {
    guideId: interaction.guideId,
    position: toPlanPointFromSvgPoint(centerSvg),
    scale: interaction.scale,
    rotation: normalizeAngle(-interaction.rotationSvg),
  };
}

function normalizeAngle(angle: number) {
  let nextAngle = angle;

  while (nextAngle <= -Math.PI) {
    nextAngle += Math.PI * 2;
  }

  while (nextAngle > Math.PI) {
    nextAngle -= Math.PI * 2;
  }

  return nextAngle;
}

function areGuideTransformDraftsEqual(
  previousDraft: GuideTransformDraft | null,
  nextDraft: GuideTransformDraft | null,
  epsilon = 1e-6,
) {
  if (previousDraft === nextDraft) {
    return true;
  }

  if (!(previousDraft && nextDraft)) {
    return false;
  }

  return (
    previousDraft.guideId === nextDraft.guideId &&
    Math.abs(previousDraft.position[0] - nextDraft.position[0]) <= epsilon &&
    Math.abs(previousDraft.position[1] - nextDraft.position[1]) <= epsilon &&
    Math.abs(previousDraft.scale - nextDraft.scale) <= epsilon &&
    Math.abs(previousDraft.rotation - nextDraft.rotation) <= epsilon
  );
}

function doesGuideMatchDraft(
  guide: GuideNode,
  draft: GuideTransformDraft,
  epsilon = 1e-6,
) {
  return (
    Math.abs(guide.position[0] - draft.position[0]) <= epsilon &&
    Math.abs(guide.position[2] - draft.position[1]) <= epsilon &&
    Math.abs(guide.scale - draft.scale) <= epsilon &&
    Math.abs(normalizeAngle(guide.rotation[1] - draft.rotation)) <= epsilon
  );
}

function buildGuideResizeDraft(
  interaction: GuideInteractionState,
  pointerSvg: SvgPoint,
): GuideTransformDraft {
  const signs = guideCornerSigns[interaction.corner];
  const minWidth = FLOORPLAN_GUIDE_BASE_WIDTH * FLOORPLAN_GUIDE_MIN_SCALE;
  const diagonal = [
    signs.x * interaction.aspectRatio,
    signs.y,
  ] as WallPlanPoint;
  const oppositeCornerSvg =
    interaction.oppositeCornerSvg ?? interaction.centerSvg;
  const relativePointer = rotateVector(
    subtractSvgPoints(pointerSvg, oppositeCornerSvg),
    -interaction.rotationSvg,
  );
  const projectedHeight =
    (relativePointer[0] * diagonal[0] + relativePointer[1] * diagonal[1]) /
    (interaction.aspectRatio ** 2 + 1);
  const width = Math.max(minWidth, projectedHeight * interaction.aspectRatio);
  const height = getGuideHeight(width, interaction.aspectRatio);
  const draggedCornerSvg = addVectorToSvgPoint(
    oppositeCornerSvg,
    rotateVector([signs.x * width, signs.y * height], interaction.rotationSvg),
  );
  const centerSvg = midpointBetweenSvgPoints(
    oppositeCornerSvg,
    draggedCornerSvg,
  );

  return {
    guideId: interaction.guideId,
    position: toPlanPointFromSvgPoint(centerSvg),
    scale: width / FLOORPLAN_GUIDE_BASE_WIDTH,
    rotation: normalizeAngle(-interaction.rotationSvg),
  };
}

function buildGuideRotationDraft(
  interaction: GuideInteractionState,
  pointerSvg: SvgPoint,
  useFineIncrement: boolean,
): GuideTransformDraft {
  const pointerVector = subtractSvgPoints(pointerSvg, interaction.centerSvg);

  if (pointerVector[0] ** 2 + pointerVector[1] ** 2 <= 1e-6) {
    return {
      guideId: interaction.guideId,
      position: toPlanPointFromSvgPoint(interaction.centerSvg),
      scale: interaction.scale,
      rotation: normalizeAngle(-interaction.rotationSvg),
    };
  }

  const rawRotationSvg =
    Math.atan2(pointerVector[1], pointerVector[0]) -
    interaction.cornerBaseAngle;
  const snappedRotationSvg = snapAngleToIncrement(
    rawRotationSvg,
    useFineIncrement
      ? FLOORPLAN_GUIDE_ROTATION_FINE_SNAP_DEGREES
      : FLOORPLAN_GUIDE_ROTATION_SNAP_DEGREES,
  );

  return {
    guideId: interaction.guideId,
    position: toPlanPointFromSvgPoint(interaction.centerSvg),
    scale: interaction.scale,
    rotation: normalizeAngle(-snappedRotationSvg),
  };
}

function toSvgSelectionBounds(bounds: FloorplanSelectionBounds) {
  return {
    x: toSvgX(bounds.maxX),
    y: toSvgY(bounds.maxY),
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
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
  };
}

function isPointInsideSelectionBounds(
  point: Point2D,
  bounds: FloorplanSelectionBounds,
) {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
}

function isPointInsidePolygon(point: Point2D, polygon: Point2D[]) {
  let isInside = false;

  for (
    let currentIndex = 0, previousIndex = polygon.length - 1;
    currentIndex < polygon.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const current = polygon[currentIndex];
    const previous = polygon[previousIndex];

    if (!(current && previous)) {
      continue;
    }

    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) /
          (previous.y - current.y) +
          current.x;

    if (intersects) {
      isInside = !isInside;
    }
  }

  return isInside;
}

function getLineOrientation(start: Point2D, end: Point2D, point: Point2D) {
  return (
    (end.x - start.x) * (point.y - start.y) -
    (end.y - start.y) * (point.x - start.x)
  );
}

function isPointOnSegment(point: Point2D, start: Point2D, end: Point2D) {
  const epsilon = 1e-9;

  return (
    Math.abs(getLineOrientation(start, end, point)) <= epsilon &&
    point.x >= Math.min(start.x, end.x) - epsilon &&
    point.x <= Math.max(start.x, end.x) + epsilon &&
    point.y >= Math.min(start.y, end.y) - epsilon &&
    point.y <= Math.max(start.y, end.y) + epsilon
  );
}

function doSegmentsIntersect(
  firstStart: Point2D,
  firstEnd: Point2D,
  secondStart: Point2D,
  secondEnd: Point2D,
) {
  const orientation1 = getLineOrientation(firstStart, firstEnd, secondStart);
  const orientation2 = getLineOrientation(firstStart, firstEnd, secondEnd);
  const orientation3 = getLineOrientation(secondStart, secondEnd, firstStart);
  const orientation4 = getLineOrientation(secondStart, secondEnd, firstEnd);

  const hasProperIntersection =
    ((orientation1 > 0 && orientation2 < 0) ||
      (orientation1 < 0 && orientation2 > 0)) &&
    ((orientation3 > 0 && orientation4 < 0) ||
      (orientation3 < 0 && orientation4 > 0));

  if (hasProperIntersection) {
    return true;
  }

  return (
    isPointOnSegment(secondStart, firstStart, firstEnd) ||
    isPointOnSegment(secondEnd, firstStart, firstEnd) ||
    isPointOnSegment(firstStart, secondStart, secondEnd) ||
    isPointOnSegment(firstEnd, secondStart, secondEnd)
  );
}

function doesPolygonIntersectSelectionBounds(
  polygon: Point2D[],
  bounds: FloorplanSelectionBounds,
) {
  if (polygon.length === 0) {
    return false;
  }

  if (polygon.some((point) => isPointInsideSelectionBounds(point, bounds))) {
    return true;
  }

  const boundsCorners: [Point2D, Point2D, Point2D, Point2D] = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];

  if (boundsCorners.some((corner) => isPointInsidePolygon(corner, polygon))) {
    return true;
  }

  const boundsEdges = [
    [boundsCorners[0], boundsCorners[1]],
    [boundsCorners[1], boundsCorners[2]],
    [boundsCorners[2], boundsCorners[3]],
    [boundsCorners[3], boundsCorners[0]],
  ] as const;

  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];

    if (!(start && end)) {
      continue;
    }

    for (const [edgeStart, edgeEnd] of boundsEdges) {
      if (doSegmentsIntersect(start, end, edgeStart, edgeEnd)) {
        return true;
      }
    }
  }

  return false;
}

function getDistanceToWallSegment(
  point: Point2D,
  start: WallPlanPoint,
  end: WallPlanPoint,
) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared <= Number.EPSILON) {
    return Math.hypot(point.x - start[0], point.y - start[1]);
  }

  const projection = clamp(
    ((point.x - start[0]) * dx + (point.y - start[1]) * dy) / lengthSquared,
    0,
    1,
  );
  const projectedX = start[0] + dx * projection;
  const projectedY = start[1] + dy * projection;

  return Math.hypot(point.x - projectedX, point.y - projectedY);
}

function getViewportBounds(): ViewportBounds {
  if (typeof window === "undefined") {
    return {
      width: PANEL_DEFAULT_WIDTH + PANEL_MARGIN * 2,
      height: PANEL_DEFAULT_HEIGHT + PANEL_MARGIN * 2,
    };
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function getPanelSizeLimits(bounds: ViewportBounds) {
  const maxWidth = Math.max(1, bounds.width - PANEL_MARGIN * 2);
  const maxHeight = Math.max(1, bounds.height - PANEL_MARGIN * 2);

  return {
    maxHeight,
    maxWidth,
    minHeight: Math.min(PANEL_MIN_HEIGHT, maxHeight),
    minWidth: Math.min(PANEL_MIN_WIDTH, maxWidth),
  };
}

function constrainPanelRect(
  rect: PanelRect,
  bounds: ViewportBounds,
): PanelRect {
  const { minWidth, maxWidth, minHeight, maxHeight } =
    getPanelSizeLimits(bounds);
  const width = clamp(rect.width, minWidth, maxWidth);
  const height = clamp(rect.height, minHeight, maxHeight);
  const x = clamp(
    rect.x,
    PANEL_MARGIN,
    Math.max(PANEL_MARGIN, bounds.width - PANEL_MARGIN - width),
  );
  const y = clamp(
    rect.y,
    PANEL_MARGIN,
    Math.max(PANEL_MARGIN, bounds.height - PANEL_MARGIN - height),
  );

  return { x, y, width, height };
}

function getPanelPositionRatios(rect: PanelRect, bounds: ViewportBounds) {
  const availableX = Math.max(bounds.width - rect.width - PANEL_MARGIN * 2, 0);
  const availableY = Math.max(
    bounds.height - rect.height - PANEL_MARGIN * 2,
    0,
  );

  return {
    xRatio: availableX > 0 ? (rect.x - PANEL_MARGIN) / availableX : 0.5,
    yRatio: availableY > 0 ? (rect.y - PANEL_MARGIN) / availableY : 0.5,
  };
}

function adaptPanelRectToBounds(
  rect: PanelRect,
  previousBounds: ViewportBounds,
  nextBounds: ViewportBounds,
): PanelRect {
  const normalizedRect = constrainPanelRect(rect, previousBounds);
  const { xRatio, yRatio } = getPanelPositionRatios(
    normalizedRect,
    previousBounds,
  );
  const { minWidth, maxWidth, minHeight, maxHeight } =
    getPanelSizeLimits(nextBounds);
  const width = clamp(normalizedRect.width, minWidth, maxWidth);
  const height = clamp(normalizedRect.height, minHeight, maxHeight);
  const availableX = Math.max(nextBounds.width - width - PANEL_MARGIN * 2, 0);
  const availableY = Math.max(nextBounds.height - height - PANEL_MARGIN * 2, 0);

  return constrainPanelRect(
    {
      x: PANEL_MARGIN + availableX * xRatio,
      y: PANEL_MARGIN + availableY * yRatio,
      width,
      height,
    },
    nextBounds,
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidPanelRect(value: unknown): value is PanelRect {
  return (
    typeof value === "object" &&
    value !== null &&
    isFiniteNumber((value as PanelRect).x) &&
    isFiniteNumber((value as PanelRect).y) &&
    isFiniteNumber((value as PanelRect).width) &&
    isFiniteNumber((value as PanelRect).height)
  );
}

function isValidViewportBounds(value: unknown): value is ViewportBounds {
  return (
    typeof value === "object" &&
    value !== null &&
    isFiniteNumber((value as ViewportBounds).width) &&
    isFiniteNumber((value as ViewportBounds).height)
  );
}

function readPersistedPanelLayout(
  currentBounds: ViewportBounds,
): PanelRect | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const rawLayout = window.localStorage.getItem(
      FLOORPLAN_PANEL_LAYOUT_STORAGE_KEY,
    );
    if (!rawLayout) {
      return null;
    }

    const parsedLayout = JSON.parse(rawLayout) as Partial<PersistedPanelLayout>;
    if (!(
      isValidPanelRect(parsedLayout.rect) &&
      isValidViewportBounds(parsedLayout.viewport)
    )) {
      return null;
    }

    return adaptPanelRectToBounds(
      parsedLayout.rect,
      parsedLayout.viewport,
      currentBounds,
    );
  } catch {
    return null;
  }
}

function writePersistedPanelLayout(layout: PersistedPanelLayout) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    FLOORPLAN_PANEL_LAYOUT_STORAGE_KEY,
    JSON.stringify(layout),
  );
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
  );
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
  );
}

function resizePanelRect(
  initialRect: PanelRect,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  bounds: ViewportBounds,
): PanelRect {
  const right = initialRect.x + initialRect.width;
  const bottom = initialRect.y + initialRect.height;

  let x = initialRect.x;
  let y = initialRect.y;
  let width = initialRect.width;
  let height = initialRect.height;

  if (direction.includes("e")) width = initialRect.width + dx;
  if (direction.includes("s")) height = initialRect.height + dy;
  if (direction.includes("w")) width = initialRect.width - dx;
  if (direction.includes("n")) height = initialRect.height - dy;

  const maxWidth = Math.max(PANEL_MIN_WIDTH, bounds.width - PANEL_MARGIN * 2);
  const maxHeight = Math.max(
    PANEL_MIN_HEIGHT,
    bounds.height - PANEL_MARGIN * 2,
  );
  width = clamp(width, PANEL_MIN_WIDTH, maxWidth);
  height = clamp(height, PANEL_MIN_HEIGHT, maxHeight);

  if (direction.includes("w")) {
    x = right - width;
  }
  if (direction.includes("n")) {
    y = bottom - height;
  }

  x = clamp(
    x,
    PANEL_MARGIN,
    Math.max(PANEL_MARGIN, bounds.width - PANEL_MARGIN - width),
  );
  y = clamp(
    y,
    PANEL_MARGIN,
    Math.max(PANEL_MARGIN, bounds.height - PANEL_MARGIN - height),
  );

  if (direction.includes("w")) {
    width = right - x;
  } else {
    width = Math.min(width, bounds.width - PANEL_MARGIN - x);
  }

  if (direction.includes("n")) {
    height = bottom - y;
  } else {
    height = Math.min(height, bounds.height - PANEL_MARGIN - y);
  }

  return constrainPanelRect({ x, y, width, height }, bounds);
}

function formatPolygonPoints(points: Point2D[]): string {
  return points
    .map((point) => {
      const svgPoint = toSvgPoint(point);
      return `${svgPoint.x},${svgPoint.y}`;
    })
    .join(" ");
}

function formatPolygonPath(points: Point2D[], holes: Point2D[][] = []): string {
  const formatSubpath = (subpathPoints: Point2D[]) => {
    const [firstPoint, ...restPoints] = subpathPoints;
    if (!firstPoint) {
      return null;
    }

    const firstSvgPoint = toSvgPoint(firstPoint);

    return [
      `M ${firstSvgPoint.x} ${firstSvgPoint.y}`,
      ...restPoints.map((point) => {
        const svgPoint = toSvgPoint(point);
        return `L ${svgPoint.x} ${svgPoint.y}`;
      }),
      "Z",
    ].join(" ");
  };

  return [points, ...holes].map(formatSubpath).filter(Boolean).join(" ");
}

function toWallPlanPointFromTuple([x, y]: [number, number]): WallPlanPoint {
  return [x, y] as WallPlanPoint;
}

function toFloorplanPolygon1([x, y]: [number, number]): Point2D {
  return { x, y };
}

function toFloorplanPolygon(points: Array<[number, number]>): Point2D[] {
  return points.map(([x, y]) => ({ x, y }));
}

/**
 * Expand a slab outline's curved edges into a polyline.
 *
 * `bulges[i]` curves the edge polygon[i] -> polygon[i + 1], last entry
 * closing back to [0], same DXF convention as WallNode.bulge.
 *
 * Tessellating rather than emitting SVG `A` commands is deliberate, and it is
 * what curved walls already do for the plan. One expansion feeds the SVG
 * path, the area, the hit-test, the PDF export and — via the translator — the
 * Blender pipeline, so none of them can disagree about where the edge is.
 * True arcs would render a shade smoother and put the plan on a different
 * code path from the geometry, which is the class of bug that has cost the
 * most here.
 *
 * Straight outlines return the input array untouched, so the common case
 * allocates nothing.
 */
function tessellateSlabOutline(
  polygon: Array<[number, number]>,
  bulges: number[] | undefined,
): Array<[number, number]> {
  if (!bulges?.some((b) => !isStraight(b ?? 0))) {
    return polygon;
  }

  const out: Array<[number, number]> = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const bulge = bulges[i] ?? 0;

    if (isStraight(bulge)) {
      out.push(a);
      continue;
    }

    // Drop each arc's final sample: it is the next edge's first point, and
    // duplicated vertices upset the shoelace area and the boolean in Blender.
    const samples = tessellateArc(a, b, bulge);
    for (let s = 0; s < samples.length - 1; s++) {
      const pt = samples[s]!;
      out.push([pt[0], pt[1]]);
    }
  }
  return out;
}

function isPointInsidePolygonWithHoles(
  point: Point2D,
  polygon: Point2D[],
  holes: Point2D[][] = [],
) {
  return (
    isPointInsidePolygon(point, polygon) &&
    !holes.some((hole) => isPointInsidePolygon(point, hole))
  );
}

function isPointNearPlanPoint(
  a: WallPlanPoint,
  b: WallPlanPoint,
  threshold = 0.25,
) {
  return Math.abs(a[0] - b[0]) < threshold && Math.abs(a[1] - b[1]) < threshold;
}

function calculatePolygonSnapPoint(
  lastPoint: WallPlanPoint,
  currentPoint: WallPlanPoint,
): WallPlanPoint {
  const [x1, y1] = lastPoint;
  const [x, y] = currentPoint;
  const dx = x - x1;
  const dy = y - y1;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const horizontalDist = absDy;
  const verticalDist = absDx;
  const diagonalDist = Math.abs(absDx - absDy);
  const minDist = Math.min(horizontalDist, verticalDist, diagonalDist);

  if (minDist === diagonalDist) {
    const diagonalLength = Math.min(absDx, absDy);
    return [
      x1 + Math.sign(dx) * diagonalLength,
      y1 + Math.sign(dy) * diagonalLength,
    ];
  }

  if (minDist === horizontalDist) {
    return [x, y1];
  }

  return [x1, y];
}

function snapPolygonDraftPoint({
  point,
  start,
  angleSnap,
}: {
  point: WallPlanPoint;
  start?: WallPlanPoint;
  angleSnap: boolean;
}): WallPlanPoint {
  const snappedPoint: WallPlanPoint = [
    snapToHalf(point[0]),
    snapToHalf(point[1]),
  ];

  if (!(start && angleSnap)) {
    return snappedPoint;
  }

  return calculatePolygonSnapPoint(start, snappedPoint);
}

function pointMatchesWallPlanPoint(
  point: Point2D | undefined,
  planPoint: WallPlanPoint,
  epsilon = 1e-6,
): boolean {
  if (!point) {
    return false;
  }

  return (
    Math.abs(point.x - planPoint[0]) <= epsilon &&
    Math.abs(point.y - planPoint[1]) <= epsilon
  );
}

function getWallHoverSidePaths(
  polygon: Point2D[],
  wall: WallNode,
): [string, string] | null {
  if (polygon.length < 4) {
    return null;
  }

  // Ritn3D 2026-06-17: arc walls. Their footprint polygon is
  // [outer[0..N], inner[N..0]] with N+1 tessellated points per side. The
  // straight-wall fast path below took polygon[0]/polygon[1] and drew ONE
  // straight line, which renders as a chord stub diving across the arc.
  // For arc walls trace the full tessellated outer and inner polylines.
  const isArc = Math.abs(wall.bulge ?? 0) > 1e-6;
  if (isArc && polygon.length % 2 === 0) {
    const half = polygon.length / 2;
    const outerPts = polygon.slice(0, half);
    const innerPts = polygon.slice(half).reverse();
    const buildPath = (pts: Point2D[]) => {
      if (pts.length < 2) return "";
      const svgPts = pts.map(toSvgPoint);
      const first = svgPts[0]!;
      let d = `M ${first.x} ${first.y}`;
      for (let i = 1; i < svgPts.length; i++) {
        const p = svgPts[i]!;
        d += ` L ${p.x} ${p.y}`;
      }
      return d;
    };
    const outerPath = buildPath(outerPts);
    const innerPath = buildPath(innerPts);
    if (!outerPath || !innerPath) return null;
    return [outerPath, innerPath];
  }

  const startRight = polygon[0];
  const endRight = polygon[1];
  const hasEndCenterPoint = pointMatchesWallPlanPoint(polygon[2], wall.end);
  const endLeft = polygon[hasEndCenterPoint ? 3 : 2];
  const lastPoint = polygon[polygon.length - 1];
  const hasStartCenterPoint = pointMatchesWallPlanPoint(lastPoint, wall.start);
  const startLeft =
    polygon[hasStartCenterPoint ? polygon.length - 2 : polygon.length - 1];

  if (!(startRight && endRight && endLeft && startLeft)) {
    return null;
  }

  const svgStartRight = toSvgPoint(startRight);
  const svgEndRight = toSvgPoint(endRight);
  const svgStartLeft = toSvgPoint(startLeft);
  const svgEndLeft = toSvgPoint(endLeft);

  return [
    `M ${svgStartRight.x} ${svgStartRight.y} L ${svgEndRight.x} ${svgEndRight.y}`,
    `M ${svgStartLeft.x} ${svgStartLeft.y} L ${svgEndLeft.x} ${svgEndLeft.y}`,
  ];
}

function buildDraftWall(
  levelId: string,
  start: WallPlanPoint,
  end: WallPlanPoint,
  bulge = 0,
): WallNode {
  return {
    object: "node",
    id: "wall_draft" as WallNode["id"],
    type: "wall",
    // Transient preview, but the node type requires it now. A draft is
    // always an ordinary wall — the barrier type is applied on commit.
    barrierType: "solid",
    name: "Draft wall",
    parentId: levelId,
    visible: true,
    metadata: {},
    children: [],
    start,
    end,
    bulge,
    // 2026-08-01: thickness/height became schema defaults rather than
    // optional, so they're required on the inferred type. This literal is
    // hand-built (not WallNode.parse'd) because it's a transient preview, so
    // it has to carry them explicitly — and it must use the same values the
    // committed wall will, or the ghost would be a different width to the
    // wall it becomes.
    thickness: DEFAULT_WALL_THICKNESS,
    height: DEFAULT_WALL_HEIGHT,
    frontSide: "unknown",
    backSide: "unknown",
  };
}

function pointsEqual(a: WallPlanPoint, b: WallPlanPoint): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function polygonsEqual(
  a: WallPlanPoint[],
  b: Array<[number, number]>,
): boolean {
  return (
    a.length === b.length &&
    a.every((point, index) => {
      const otherPoint = b[index];
      if (!otherPoint) {
        return false;
      }

      return pointsEqual(point, otherPoint);
    })
  );
}

function buildWallEndpointDraft(
  wallId: WallNode["id"],
  endpoint: WallEndpoint,
  fixedPoint: WallPlanPoint,
  movingPoint: WallPlanPoint,
): WallEndpointDraft {
  return {
    wallId,
    endpoint,
    start: endpoint === "start" ? movingPoint : fixedPoint,
    end: endpoint === "end" ? movingPoint : fixedPoint,
  };
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
  };
}

function getFloorplanWallThickness(wall: WallNode): number {
  const baseThickness = wall.thickness ?? DEFAULT_WALL_THICKNESS;
  const scaledThickness = baseThickness * FLOORPLAN_WALL_THICKNESS_SCALE;

  return Math.min(
    baseThickness + FLOORPLAN_MAX_EXTRA_THICKNESS,
    Math.max(
      baseThickness,
      scaledThickness,
      FLOORPLAN_MIN_VISIBLE_WALL_THICKNESS,
    ),
  );
}

function getFloorplanWall(wall: WallNode): WallNode {
  return {
    ...wall,
    // Slightly exaggerate thin walls so the 2D blueprint reads clearly without drifting far from BIM.
    thickness: getFloorplanWallThickness(wall),
  };
}

type WallMeasurementOverlay = {
  wallId: WallNode["id"];
  dimensionLineEnd: { x1: number; y1: number; x2: number; y2: number };
  dimensionLineStart: { x1: number; y1: number; x2: number; y2: number };
  extensionStart: { x1: number; y1: number; x2: number; y2: number };
  extensionEnd: { x1: number; y1: number; x2: number; y2: number };
  label: string;
  labelX: number;
  labelY: number;
  labelAngleDeg: number;
  isSelected?: boolean;
};

function formatMeasurement(value: number, unit: "metric" | "imperial") {
  if (unit === "imperial") {
    const feet = value * 3.280_84;
    const wholeFeet = Math.floor(feet);
    const inches = Math.round((feet - wholeFeet) * 12);
    if (inches === 12) return `${wholeFeet + 1}'0"`;
    return `${wholeFeet}'${inches}"`;
  }
  return `${Number.parseFloat(value.toFixed(2))}m`;
}

function getPolygonAreaAndCentroid(polygon: Point2D[]) {
  let cx = 0;
  let cy = 0;
  let area = 0;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const p1 = polygon[j]!;
    const p2 = polygon[i]!;
    const f = p1.x * p2.y - p2.x * p1.y;
    cx += (p1.x + p2.x) * f;
    cy += (p1.y + p2.y) * f;
    area += f;
  }

  area /= 2;

  if (Math.abs(area) < 1e-9) {
    return { area: 0, centroid: polygon[0] ?? { x: 0, y: 0 } };
  }

  cx /= 6 * area;
  cy /= 6 * area;

  return { area: Math.abs(area), centroid: { x: cx, y: cy } };
}

function getSlabArea(polygon: Point2D[], holes: Point2D[][]) {
  const outer = getPolygonAreaAndCentroid(polygon);
  let totalArea = outer.area;
  for (const hole of holes) {
    totalArea -= getPolygonAreaAndCentroid(hole).area;
  }
  return { area: Math.max(0, totalArea), centroid: outer.centroid };
}

function formatArea(areaSqM: number, unit: "metric" | "imperial") {
  if (unit === "imperial") {
    const areaSqFt = areaSqM * 10.763_910_4;
    return (
      <>
        {Math.round(areaSqFt).toLocaleString()} ft
        <tspan baselineShift="super" fontSize="0.75em">
          2
        </tspan>
      </>
    );
  }
  return (
    <>
      {Number.parseFloat(areaSqM.toFixed(1))} m
      <tspan baselineShift="super" fontSize="0.75em">
        2
      </tspan>
    </>
  );
}

function FloorplanMeasurementLine({
  palette,
  segment,
  isSelected,
}: {
  palette: FloorplanPalette;
  segment: { x1: number; y1: number; x2: number; y2: number };
  isSelected?: boolean;
}) {
  const lineOpacity = isSelected
    ? FLOORPLAN_MEASUREMENT_LINE_OPACITY
    : FLOORPLAN_MEASUREMENT_LINE_OPACITY * 0.4;
  const outlineOpacity = isSelected
    ? FLOORPLAN_MEASUREMENT_LINE_OUTLINE_OPACITY
    : FLOORPLAN_MEASUREMENT_LINE_OUTLINE_OPACITY * 0.4;

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
  );
}

function getWallMeasurementOverlay(
  wall: WallNode,
  centerX: number,
  centerZ: number,
  unit: "metric" | "imperial",
): WallMeasurementOverlay | null {
  const dx = wall.end[0] - wall.start[0];
  const dz = wall.end[1] - wall.start[1];
  const length = Math.hypot(dx, dz);

  if (length < 0.1) {
    return null;
  }

  const nx = -dz / length;
  const nz = dx / length;
  const midX = (wall.start[0] + wall.end[0]) / 2;
  const midZ = (wall.start[1] + wall.end[1]) / 2;
  const cx = midX - centerX;
  const cz = midZ - centerZ;
  const dot = cx * nx + cz * nz;
  const outX = dot >= 0 ? nx : -nx;
  const outZ = dot >= 0 ? nz : -nz;
  const label = formatMeasurement(length, unit);
  const mOffset = getMeasureOffset();
  const mOvershoot = getMeasureExtOvershoot();
  const dimensionLine = {
    x1: toSvgX(wall.start[0] + outX * mOffset),
    y1: toSvgY(wall.start[1] + outZ * mOffset),
    x2: toSvgX(wall.end[0] + outX * mOffset),
    y2: toSvgY(wall.end[1] + outZ * mOffset),
  };

  const extensionStart = {
    x1: toSvgX(wall.start[0]),
    y1: toSvgY(wall.start[1]),
    x2: toSvgX(wall.start[0] + outX * (mOffset + mOvershoot)),
    y2: toSvgY(wall.start[1] + outZ * (mOffset + mOvershoot)),
  };

  const extensionEnd = {
    x1: toSvgX(wall.end[0]),
    y1: toSvgY(wall.end[1]),
    x2: toSvgX(wall.end[0] + outX * (mOffset + mOvershoot)),
    y2: toSvgY(wall.end[1] + outZ * (mOffset + mOvershoot)),
  };

  const svgDx = dimensionLine.x2 - dimensionLine.x1;
  const svgDy = dimensionLine.y2 - dimensionLine.y1;
  const svgLength = Math.hypot(svgDx, svgDy);
  let labelAngleDeg = (Math.atan2(svgDy, svgDx) * 180) / Math.PI;

  if (labelAngleDeg > 90) {
    labelAngleDeg -= 180;
  } else if (labelAngleDeg <= -90) {
    labelAngleDeg += 180;
  }

  if (svgLength < 1e-6) {
    return null;
  }

  const dirSvgX = svgDx / svgLength;
  const dirSvgY = svgDy / svgLength;
  const labelGapHalf = Math.min(
    getMeasureLabelGap() / 2,
    Math.max(0, svgLength / 2 - getMeasureLabelLinePadding()),
  );
  const labelX = (dimensionLine.x1 + dimensionLine.x2) / 2;
  const labelY = (dimensionLine.y1 + dimensionLine.y2) / 2;
  const dimensionLineStart = {
    x1: dimensionLine.x1,
    y1: dimensionLine.y1,
    x2: labelX - dirSvgX * labelGapHalf,
    y2: labelY - dirSvgY * labelGapHalf,
  };
  const dimensionLineEnd = {
    x1: labelX + dirSvgX * labelGapHalf,
    y1: labelY + dirSvgY * labelGapHalf,
    x2: dimensionLine.x2,
    y2: dimensionLine.y2,
  };

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
  };
}

function getOpeningFootprint(
  wall: WallNode,
  node: WindowNode | DoorNode,
): Point2D[] {
  const width = node.width;
  const depth = wall.thickness ?? DEFAULT_WALL_THICKNESS;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;

  // Position is distance along the wall from start. For straight walls that's
  // chord distance; for arcs it's arc length. arcLength() collapses to chord
  // length when bulge == 0, so both cases go through the same formula.
  const bulge = wall.bulge ?? 0;
  const totalLen = arcLength(wall.start, wall.end, bulge);
  if (totalLen < 1e-9) return [];

  // Normalize position into [0, 1] parametric arc length so we can ask the
  // arc helper for (point, tangent) at that t. For straight walls this gives
  // exactly the legacy result (linear interpolation along chord).
  const t = Math.max(0, Math.min(1, node.position[0] / totalLen));
  const { point, tangent } = pointAndTangentAtT(wall.start, wall.end, bulge, t);

  const dirX = tangent[0];
  const dirZ = tangent[1];
  const perpX = -dirZ;
  const perpZ = dirX;
  const cx = point[0];
  const cz = point[1];

  return [
    {
      x: cx - dirX * halfWidth + perpX * halfDepth,
      y: cz - dirZ * halfWidth + perpZ * halfDepth,
    },
    {
      x: cx + dirX * halfWidth + perpX * halfDepth,
      y: cz + dirZ * halfWidth + perpZ * halfDepth,
    },
    {
      x: cx + dirX * halfWidth - perpX * halfDepth,
      y: cz + dirZ * halfWidth - perpZ * halfDepth,
    },
    {
      x: cx - dirX * halfWidth - perpX * halfDepth,
      y: cz - dirZ * halfWidth - perpZ * halfDepth,
    },
  ];
}

function getOpeningCenterLine(polygon: Point2D[]) {
  if (polygon.length < 4) {
    return null;
  }

  const [p1, p2, p3, p4] = polygon;

  return {
    start: {
      x: (p1!.x + p4!.x) / 2,
      y: (p1!.y + p4!.y) / 2,
    },
    end: {
      x: (p2!.x + p3!.x) / 2,
      y: (p2!.y + p3!.y) / 2,
    },
  };
}

function normalizeGridCoordinate(value: number): number {
  return Number(value.toFixed(GRID_COORDINATE_PRECISION));
}

function isGridAligned(value: number, step: number): boolean {
  if (!(Number.isFinite(step) && step > 0)) {
    return false;
  }

  const normalizedValue = normalizeGridCoordinate(value / step);
  return Math.abs(normalizedValue - Math.round(normalizedValue)) < 1e-4;
}

// Keep visible grid spacing above a minimum pixel size.
// Uses 1-2-5 sequence for smooth zoom transitions (like engineering graph paper).
function getVisibleGridSteps(
  viewportWidth: number,
  surfaceWidth: number,
): {
  minorStep: number;
  majorStep: number;
} {
  const pixelsPerUnit = surfaceWidth / Math.max(viewportWidth, Number.EPSILON);
  let minorStep = WALL_GRID_STEP;

  // 2026-07-27: 1-2-4 sequence (was 1-2-5). 1-2-5 produced 2.5m boxes
  // at typical domestic-plan zoom, which reads as huge for a house
  // that's 12m across. 1-2-4 doubles each step so the sequence is
  //   0.5 → 1.0 → 2.0 → 5.0 (via next decade) → 10 → 20 → 50 → ...
  // dropping the awkward 2.5m stop.
  const multipliers = [1, 2, 4];
  let scale = 1;
  let mIdx = 0;
  while (
    WALL_GRID_STEP * scale * multipliers[mIdx]! * pixelsPerUnit <
    MIN_GRID_SCREEN_SPACING
  ) {
    mIdx++;
    if (mIdx >= multipliers.length) {
      mIdx = 0;
      scale *= 10;
    }
  }
  minorStep = WALL_GRID_STEP * scale * multipliers[mIdx]!;

  return {
    minorStep,
    // 2026-07-28 (rev 2): user wants major = 1 m for domestic plans.
    // With minor at 0.5 m and multiplier * 2, major = 1 m -- one grid
    // box == 1 m, which matches how homeowners read plans. MAJOR_GRID_STEP
    // floor stays at 1 m so we never go below.
    majorStep: Math.max(MAJOR_GRID_STEP, minorStep * 2),
  };
}

function buildGridPath(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  step: number,
  options?: {
    excludeStep?: number;
  },
): string {
  if (!(Number.isFinite(step) && step > 0)) {
    return "";
  }

  const commands: string[] = [];
  const startXIndex = Math.floor(minX / step);
  const endXIndex = Math.ceil(maxX / step);
  const startYIndex = Math.floor(minY / step);
  const endYIndex = Math.ceil(maxY / step);
  const gridMinX = normalizeGridCoordinate(minX);
  const gridMaxX = normalizeGridCoordinate(maxX);
  const gridMinY = normalizeGridCoordinate(minY);
  const gridMaxY = normalizeGridCoordinate(maxY);

  for (let index = startXIndex; index <= endXIndex; index += 1) {
    const x = index * step;
    if (options?.excludeStep && isGridAligned(x, options.excludeStep)) {
      continue;
    }

    const gridX = normalizeGridCoordinate(x);
    commands.push(`M ${gridX} ${gridMinY} L ${gridX} ${gridMaxY}`);
  }

  for (let index = startYIndex; index <= endYIndex; index += 1) {
    const y = index * step;
    if (options?.excludeStep && isGridAligned(y, options.excludeStep)) {
      continue;
    }

    const gridY = normalizeGridCoordinate(y);
    commands.push(`M ${gridMinX} ${gridY} L ${gridMaxX} ${gridY}`);
  }

  return commands.join(" ");
}

function findClosestWallPoint(
  point: WallPlanPoint,
  walls: WallNode[],
  maxDistance = 0.5,
): {
  wall: WallNode;
  point: WallPlanPoint;
  t: number;
  normal: [number, number, number];
} | null {
  let best: {
    wall: WallNode;
    point: WallPlanPoint;
    t: number;
    normal: [number, number, number];
  } | null = null;
  let bestDistSq = maxDistance * maxDistance;

  for (const wall of walls) {
    const bulge = wall.bulge ?? 0;
    if (isStraight(bulge)) {
      // Straight wall — original fast chord projection.
      const [x1, z1] = wall.start;
      const [x2, z2] = wall.end;
      const dx = x2 - x1;
      const dz = z2 - z1;
      const lengthSq = dx * dx + dz * dz;
      if (lengthSq < 1e-9) continue;
      let t = ((point[0] - x1) * dx + (point[1] - z1) * dz) / lengthSq;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + t * dx;
      const pz = z1 + t * dz;
      const distSq = (point[0] - px) ** 2 + (point[1] - pz) ** 2;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = { wall, point: [px, pz], t, normal: [0, 0, 1] };
      }
      continue;
    }

    // Curved wall — tessellate the arc, find closest point on the polyline.
    // `t` returned is arc-length-parametric (cumulative segment length /
    // total) — same semantic the rendering / placement code expects. Slower
    // than the chord projection (O(segments) per wall) but only runs while
    // a placement tool is hovering; furniture catalogs hover-test elsewhere.
    const samples = tessellateArc(wall.start, wall.end, bulge);
    if (samples.length < 2) continue;
    // Pre-compute cumulative segment lengths for t-parameter mapping.
    const cum: number[] = [0];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      cum.push(cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const totalLen = cum[cum.length - 1]!;
    if (totalLen < 1e-9) continue;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      const sx = b[0] - a[0];
      const sz = b[1] - a[1];
      const segLenSq = sx * sx + sz * sz;
      if (segLenSq < 1e-12) continue;
      let segT = ((point[0] - a[0]) * sx + (point[1] - a[1]) * sz) / segLenSq;
      segT = Math.max(0, Math.min(1, segT));
      const px = a[0] + segT * sx;
      const pz = a[1] + segT * sz;
      const distSq = (point[0] - px) ** 2 + (point[1] - pz) ** 2;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        const arcLenAtHit = cum[i - 1]! + segT * Math.sqrt(segLenSq);
        const t = arcLenAtHit / totalLen;
        best = { wall, point: [px, pz], t, normal: [0, 0, 1] };
      }
    }
  }

  return best;
}

type GuideImageDimensions = {
  width: number;
  height: number;
};

function useResolvedAssetUrl(url: string) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setResolvedUrl(null);
      return;
    }

    let cancelled = false;
    setResolvedUrl(null);

    loadAssetUrl(url).then((nextUrl) => {
      if (!cancelled) {
        setResolvedUrl(nextUrl);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return resolvedUrl;
}

function useGuideImageDimensions(url: string | null) {
  const [dimensions, setDimensions] = useState<GuideImageDimensions | null>(
    null,
  );

  useEffect(() => {
    if (!url) {
      setDimensions(null);
      return;
    }

    let cancelled = false;
    const image = new globalThis.Image();

    image.onload = () => {
      if (cancelled) {
        return;
      }

      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;

      if (!(width > 0 && height > 0)) {
        setDimensions(null);
        return;
      }

      setDimensions({ width, height });
    };

    image.onerror = () => {
      if (!cancelled) {
        setDimensions(null);
      }
    };

    image.src = url;

    return () => {
      cancelled = true;
    };
  }, [url]);

  return dimensions;
}

function FloorplanGuideImage({
  guide,
  isInteractive,
  isSelected,
  activeInteractionMode,
  onGuideSelect,
  onGuideTranslateStart,
}: {
  guide: GuideNode;
  isInteractive: boolean;
  isSelected: boolean;
  activeInteractionMode: GuideInteractionMode | null;
  onGuideSelect: (guideId: GuideNode["id"]) => void;
  onGuideTranslateStart: (
    guide: GuideNode,
    event: ReactPointerEvent<SVGRectElement>,
  ) => void;
}) {
  const resolvedUrl = useResolvedAssetUrl(guide.url);
  const dimensions = useGuideImageDimensions(resolvedUrl);

  if (!(guide.opacity > 0 && guide.scale > 0 && resolvedUrl && dimensions)) {
    return null;
  }

  const aspectRatio = dimensions.width / dimensions.height;
  const planWidth = getGuideWidth(guide.scale);
  const planHeight = getGuideHeight(planWidth, aspectRatio);
  const centerX = toSvgX(guide.position[0]);
  const centerY = toSvgY(guide.position[2]);
  const rotationDeg = (-guide.rotation[1] * 180) / Math.PI;

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
            event.stopPropagation();
            onGuideSelect(guide.id);
          }}
          onPointerDown={(event) => {
            if (event.button === 0) {
              event.stopPropagation();
              if (isSelected) {
                onGuideTranslateStart(guide, event);
              }
            }
          }}
          pointerEvents="all"
          style={{
            cursor:
              isSelected && activeInteractionMode === "translate"
                ? "grabbing"
                : isSelected
                  ? "grab"
                  : "pointer",
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
  );
}

const FloorplanGridLayer = memo(function FloorplanGridLayer({
  majorGridPath,
  minorGridPath,
  palette,
  showGrid,
}: {
  majorGridPath: string;
  minorGridPath: string;
  palette: FloorplanPalette;
  showGrid: boolean;
}) {
  if (!showGrid) {
    return null;
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
  );
});

const FloorplanGuideLayer = memo(function FloorplanGuideLayer({
  guides,
  isInteractive,
  selectedGuideId,
  activeGuideInteractionGuideId,
  activeGuideInteractionMode,
  onGuideSelect,
  onGuideTranslateStart,
}: {
  guides: GuideNode[];
  isInteractive: boolean;
  selectedGuideId: GuideNode["id"] | null;
  activeGuideInteractionGuideId: GuideNode["id"] | null;
  activeGuideInteractionMode: GuideInteractionMode | null;
  onGuideSelect: (guideId: GuideNode["id"]) => void;
  onGuideTranslateStart: (
    guide: GuideNode,
    event: ReactPointerEvent<SVGRectElement>,
  ) => void;
}) {
  if (!guides.length) {
    return null;
  }

  const orderedGuides =
    selectedGuideId && guides.some((guide) => guide.id === selectedGuideId)
      ? [
          ...guides.filter((guide) => guide.id !== selectedGuideId),
          guides.find((guide) => guide.id === selectedGuideId)!,
        ]
      : guides;

  return (
    <>
      {orderedGuides.map((guide) => (
        <FloorplanGuideImage
          activeInteractionMode={
            activeGuideInteractionGuideId === guide.id
              ? activeGuideInteractionMode
              : null
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
  );
});

function FloorplanGuideSelectionOverlay({
  guide,
  isDarkMode,
  rotationModifierPressed,
  showHandles,
  onCornerHoverChange,
  onCornerPointerDown,
}: {
  guide: GuideNode | null;
  isDarkMode: boolean;
  rotationModifierPressed: boolean;
  showHandles: boolean;
  onCornerHoverChange: (corner: GuideCorner | null) => void;
  onCornerPointerDown: (
    guide: GuideNode,
    dimensions: GuideImageDimensions,
    corner: GuideCorner,
    event: ReactPointerEvent<SVGCircleElement>,
  ) => void;
}) {
  const resolvedUrl = useResolvedAssetUrl(guide?.url ?? "");
  const dimensions = useGuideImageDimensions(resolvedUrl);

  if (!(
    guide &&
    guide.opacity > 0 &&
    guide.scale > 0 &&
    resolvedUrl &&
    dimensions
  )) {
    return null;
  }

  const aspectRatio = dimensions.width / dimensions.height;
  const planWidth = getGuideWidth(guide.scale);
  const planHeight = getGuideHeight(planWidth, aspectRatio);
  const centerX = toSvgX(guide.position[0]);
  const centerY = toSvgY(guide.position[2]);
  const rotationDeg = (-guide.rotation[1] * 180) / Math.PI;
  const selectionStroke = isDarkMode ? "#ffffff" : "#09090b";
  const handleFill = isDarkMode ? "#ffffff" : "#09090b";
  const handleStroke = isDarkMode ? "#0a0e1b" : "#ffffff";

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
            const [x, y] = getGuideCornerLocalOffset(
              planWidth,
              planHeight,
              corner,
            );

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
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onPointerDown={(event) =>
                    onCornerPointerDown(guide, dimensions, corner, event)
                  }
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
            );
          })
        : null}
    </g>
  );
}

function FloorplanGuideHandleHint({
  anchor,
  isDarkMode,
  isMacPlatform,
  rotationModifierPressed,
}: {
  anchor: GuideHandleHintAnchor | null;
  isDarkMode: boolean;
  isMacPlatform: boolean;
  rotationModifierPressed: boolean;
}) {
  if (!anchor) {
    return null;
  }

  const primaryToneClass = isDarkMode
    ? "text-white drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.5)]"
    : "text-[#09090b] drop-shadow-[0_1px_1.5px_rgba(255,255,255,0.8)]";

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute z-20 select-none",
        primaryToneClass,
      )}
      style={{
        left: anchor.x,
        top: anchor.y,
        transform: `translate(calc(-50% + ${anchor.directionX * 12}px), calc(-50% + ${anchor.directionY * 12}px))`,
      }}
    >
      <div className="flex flex-col gap-0.5">
        <div
          className={cn(
            "flex items-center gap-1.5 transition-opacity duration-150",
            rotationModifierPressed ? "opacity-40" : "opacity-100",
          )}
        >
          <span className="font-medium text-[11px] lowercase leading-none">
            resize
          </span>
          <Icon
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0"
            color="currentColor"
            icon="ph:mouse-left-click-fill"
          />
        </div>

        <div
          className={cn(
            "flex items-center gap-1.5 transition-opacity duration-150",
            rotationModifierPressed ? "opacity-100" : "opacity-40",
          )}
        >
          <span className="font-medium text-[11px] lowercase leading-none">
            rotate
          </span>
          {isMacPlatform ? (
            <Command
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0"
              strokeWidth={2.2}
            />
          ) : (
            <span className="font-mono text-[10px] uppercase leading-none">
              ctrl
            </span>
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
  );
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
  stairPlans,
  ghost,
  onStairSelect,
  onStairPointerDown,
  wallPolygons,
  unit,
  worldUnitsPerPixel,
}: {
  canSelectSlabs: boolean;
  canSelectGeometry: boolean;
  hoveredOpeningId: OpeningNode["id"] | null;
  onSlabDoubleClick: (slab: SlabNode) => void;
  onSlabSelect: (
    slabId: SlabNode["id"],
    event: ReactMouseEvent<SVGElement>,
  ) => void;
  onOpeningDoubleClick: (opening: OpeningNode) => void;
  onOpeningHoverChange: (openingId: OpeningNode["id"] | null) => void;
  onOpeningSelect: (
    openingId: OpeningNode["id"],
    event: ReactMouseEvent<SVGElement>,
  ) => void;
  hoveredWallId: WallNode["id"] | null;
  onWallClick: (wall: WallNode, event: ReactMouseEvent<SVGElement>) => void;
  onWallDoubleClick: (
    wall: WallNode,
    event: ReactMouseEvent<SVGElement>,
  ) => void;
  onWallHoverChange: (wallId: WallNode["id"] | null) => void;
  openingsPolygons: OpeningPolygonEntry[];
  palette: FloorplanPalette;
  selectedIdSet: ReadonlySet<string>;
  slabPolygons: SlabPolygonEntry[];
  stairPlans: StairPlan[];
  ghost: {
    /** depth 1 is the storey directly below; higher is further down. */
    walls: {
      start: [number, number];
      end: [number, number];
      depth?: number;
    }[];
    stairs: StairPlan[];
  } | null;
  onStairSelect: (
    stairId: StairNode["id"],
    event: ReactMouseEvent<SVGElement>,
  ) => void;
  onStairPointerDown: (
    stairId: StairNode["id"],
    event: ReactPointerEvent<SVGElement>,
  ) => void;
  wallPolygons: WallPolygonEntry[];
  unit: "metric" | "imperial";
  /** World units (metres) per screen pixel at the current zoom. Door symbols
   *  need it to keep their across-wall offsets legible — see doorInflate. */
  worldUnitsPerPixel: number;
}) {
  /* Flutter's door offsets are metres, scaled by its camera. On a phone you
     are zoomed well in, so a 0.03 m panel gap lands as a few visible pixels.
     With a whole storey on screen the same 0.03 m falls under one pixel while
     the strokes stay a fixed 1.5, and patio and sliding collapse into a bare
     line — which is exactly what they did.

     So inflate a symbol's across-wall offsets, by ONE factor per symbol, only
     as far as its smallest distinguishing feature needs to clear
     DOOR_MIN_FEATURE_PX. The factor is 1 whenever the zoom already shows the
     feature, so at reading zoom these are Flutter's numbers exactly and the
     proportions never change — the symbol is the same, it just stops
     disappearing when you zoom out. Capped so a zoomed-out plan cannot grow
     a door symbol into the middle of the room. */
  const DOOR_MIN_FEATURE_PX = 4;
  const DOOR_MAX_INFLATE = 3;
  const doorInflate = (featureMeters: number) => {
    const px = featureMeters / Math.max(worldUnitsPerPixel, 1e-9);
    if (!Number.isFinite(px) || px <= 0) return 1;
    return Math.min(DOOR_MAX_INFLATE, Math.max(1, DOOR_MIN_FEATURE_PX / px));
  };

  let minX = Number.POSITIVE_INFINITY,
    maxX = Number.NEGATIVE_INFINITY,
    minZ = Number.POSITIVE_INFINITY,
    maxZ = Number.NEGATIVE_INFINITY;
  for (const { wall } of wallPolygons) {
    minX = Math.min(minX, wall.start[0], wall.end[0]);
    maxX = Math.max(maxX, wall.start[0], wall.end[0]);
    minZ = Math.min(minZ, wall.start[1], wall.end[1]);
    maxZ = Math.max(maxZ, wall.start[1], wall.end[1]);
  }
  const centerX = minX === Number.POSITIVE_INFINITY ? 0 : (minX + maxX) / 2;
  const centerZ = minZ === Number.POSITIVE_INFINITY ? 0 : (minZ + maxZ) / 2;
  // Ritn3D 2026-08-01: annotate only the wall being worked on.
  //
  // Every wall used to render its own dimension set — four grey measurement
  // lines (extensionStart, dimensionLineStart, dimensionLineEnd,
  // extensionEnd) plus a label. On a 31-wall plan imported from a detection
  // that is 124 grey lines laid over the drawing.
  //
  // They read as clickable geometry, but the group is pointerEvents="none",
  // so a click on one falls through to the background zone hit-test and
  // selects a room instead. A user reported exactly that — "each dot and grey
  // line opens room selection" — and had to ask what the lines even were.
  //
  // Showing them on hover/selection keeps the measurement available precisely
  // when it's wanted (placing or adjusting a wall) without burying the plan
  // under its own annotations. Nothing is lost: hover any wall to read it.
  const wallMeasurements = wallPolygons.flatMap(({ wall }) => {
    const isSelected = selectedIdSet.has(wall.id);
    const isHovered = hoveredWallId === wall.id;
    if (!isSelected && !isHovered) return [];
    const measurement = getWallMeasurementOverlay(wall, centerX, centerZ, unit);
    if (measurement) {
      measurement.isSelected = isSelected;
    }
    return measurement ? [measurement] : [];
  });

  return (
    <>
      {slabPolygons.map(({ slab, polygon, holes, path }) => {
        const isSelected = selectedIdSet.has(slab.id);
        // Ritn3D 2026-06-18: colour and label slabs by surface type so the
        // user can tell a Patio from a Garage from a Driveway at a glance.
        // Interior slabs keep the neutral palette so existing floor plans
        // read the same.
        const surfaceType = (slab as any).surfaceType ?? "interior";
        const surfaceFill =
          surfaceType === "patio"
            ? "#c8b78a"
            : surfaceType === "deck"
              ? "#a78458"
              : surfaceType === "driveway"
                ? "#8f9098"
                : surfaceType === "garage"
                  ? "#9aa2ac"
                  : surfaceType === "gravel"
                    ? "#b8b4a5"
                    : surfaceType === "grass"
                      ? "#8ab073"
                      : surfaceType === "wood"
                        ? "#b7885a"
                        : null;
        const fillColour = isSelected
          ? palette.selectedSlabFill
          : (surfaceFill ?? palette.slabFill);
        const { area, centroid } = getSlabArea(polygon, holes);
        let slabLabel = null;
        if (area > 0) {
          const showName = surfaceType !== "interior";
          const nameLine = showName ? (slab.name ?? surfaceType) : null;
          const areaLine = isSelected ? formatArea(area, unit) : null;
          const lines: Array<{ content: React.ReactNode; isName: boolean }> =
            [];
          if (nameLine) lines.push({ content: nameLine, isName: true });
          if (areaLine) lines.push({ content: areaLine, isName: false });
          if (lines.length > 0) {
            const fs = getMeasureLabelFontSize();
            slabLabel = (
              <g pointerEvents="none" style={{ userSelect: "none" }}>
                {lines.map((line, i) => (
                  <text
                    key={i}
                    dominantBaseline="central"
                    fill={palette.measurementStroke}
                    fontFamily={
                      line.isName
                        ? "Inter Tight, Inter, sans-serif"
                        : "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                    }
                    fontSize={fs}
                    fontWeight={line.isName ? "600" : "500"}
                    paintOrder="stroke"
                    stroke={palette.surface}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={getMeasureLabelStrokeWidth()}
                    textAnchor="middle"
                    x={toSvgX(centroid.x)}
                    y={
                      toSvgY(centroid.y) +
                      (i - (lines.length - 1) / 2) * fs * 1.2
                    }
                  >
                    {line.content}
                  </text>
                ))}
              </g>
            );
          }
        }

        return (
          <g key={slab.id}>
            <path
              clipRule="evenodd"
              d={path}
              fill={fillColour}
              /* The fill had no opacity at all, so a floor covering the plan
                 buried the walls, rooms and openings under solid colour. A
                 slab is the surface everything else sits ON, so it has to
                 read as underneath. Selected is lifted a little, since then
                 it is the thing being worked on. */
              fillOpacity={isSelected ? 0.3 : 0.18}
              fillRule="evenodd"
              onClick={
                canSelectSlabs
                  ? (event) => {
                      event.stopPropagation();
                      onSlabSelect(slab.id, event);
                    }
                  : undefined
              }
              onDoubleClick={
                canSelectSlabs
                  ? (event) => {
                      event.stopPropagation();
                      onSlabDoubleClick(slab);
                    }
                  : undefined
              }
              pointerEvents={canSelectSlabs ? undefined : "none"}
              stroke={isSelected ? palette.selectedStroke : palette.slabStroke}
              strokeOpacity={isSelected ? 0.92 : 0.84}
              strokeWidth="0.05"
              style={canSelectSlabs ? { cursor: EDITOR_CURSOR } : undefined}
              vectorEffect="non-scaling-stroke"
            />
            {slabLabel}
          </g>
        );
      })}

      {/* Order matters, and this was wrong: the ghost and the stairs used to
          be emitted BEFORE the slab map, so a level's own floor slab painted
          straight over both. Adding a level — which now creates a slab — made
          the whole canvas go solid and hid the storey below entirely.

          Slabs are the floor, so they go under. Everything you place ON that
          floor is drawn after it, and walls last of all. */}
      {/* The storey below, as a reference. Drawn first so everything on the
          current level sits over it, and non-interactive so it can never
          steal a click from the floor you are actually editing. */}
      {ghost && (
        /* 0.55, not 0.22: at the old value the ghost sat on the edge of
           legibility, which is why it leaned on the canvas hue to be seen at
           all. A warm hue carries the "this is underneath" meaning on its
           own, so the opacity is free to rise until the outline is actually
           readable.

           Strokes are in SCREEN pixels here, not metres. In world units the
           width and dash shrank with the zoom, so the ghost thinned out
           exactly when the whole storey was in frame — which is when you
           most want to see what is under you. */
        <g data-element="ghost" opacity={0.55} pointerEvents="none">
          {ghost.walls.map((w, i) => (
            <line
              key={`gw${i}`}
              // Each storey further down is drawn at 55% of the one above it,
              // with a floor so the ground outline never vanishes entirely.
              opacity={Math.max(0.3, 0.55 ** ((w.depth ?? 1) - 1))}
              stroke={palette.ghostStroke}
              strokeDasharray="7 5"
              strokeWidth={1.6}
              vectorEffect="non-scaling-stroke"
              x1={-w.start[0]}
              x2={-w.end[0]}
              y1={-w.start[1]}
              y2={-w.end[1]}
            />
          ))}
          {ghost.stairs.map((plan) => (
            <g key={`gs${plan.stair.id}`}>
              <path
                d={polygonToPath(plan.outline)}
                fill={palette.ghostStroke}
                fillOpacity={0.16}
                stroke={palette.ghostStroke}
                strokeDasharray="7 5"
                strokeWidth={1.4}
                vectorEffect="non-scaling-stroke"
              />
              {plan.treadLines.map((line, i) => {
                const a = toStairSvg(line[0]);
                const b = toStairSvg(line[1]);
                return (
                  <line
                    key={i}
                    stroke={palette.ghostStroke}
                    strokeWidth={0.9}
                    vectorEffect="non-scaling-stroke"
                    x1={a.x}
                    x2={b.x}
                    y1={a.y}
                    y2={b.y}
                  />
                );
              })}
            </g>
          ))}
        </g>
      )}

      {/* Stairs. Drawn above slabs because a stair sits ON the floor, and
          hit-tested in the same order — clicking one should select the stair,
          not the slab underneath it. */}
      {stairPlans.map((plan) => {
        const isSelected = selectedIdSet.has(plan.stair.id);
        const stroke = plan.warns
          ? "#f59e0b"
          : isSelected
            ? "#7c6cf7"
            : "#5b5b66";
        return (
          <g key={plan.stair.id}>
            <path
              data-element="stair"
              d={polygonToPath(plan.outline)}
              fill={
                isSelected ? "rgba(124,108,247,0.16)" : "rgba(120,116,110,0.10)"
              }
              stroke={stroke}
              strokeWidth={isSelected ? 0.05 : 0.03}
              style={{ cursor: "move" }}
              onClick={(event) => onStairSelect(plan.stair.id, event)}
              onPointerDown={(event) =>
                onStairPointerDown(plan.stair.id, event)
              }
            />
            {plan.landing && (
              <path
                data-element="stair"
                d={polygonToPath(plan.landing)}
                fill={
                  isSelected
                    ? "rgba(124,108,247,0.10)"
                    : "rgba(120,116,110,0.06)"
                }
                stroke={stroke}
                strokeWidth={0.02}
                pointerEvents="none"
              />
            )}
            {plan.treadLines.map((line, i) => {
              // Same node -> SVG negation the paths get; a raw line here would
              // draw the treads mirrored away from their own outline.
              const a = toStairSvg(line[0]);
              const b = toStairSvg(line[1]);
              return (
                <line
                  data-element="stair"
                  key={i}
                  pointerEvents="none"
                  stroke={stroke}
                  strokeWidth={0.02}
                  x1={a.x}
                  x2={b.x}
                  y1={a.y}
                  y2={b.y}
                />
              );
            })}
            {plan.arrow && (
              <g data-element="stair" pointerEvents="none">
                <line
                  stroke={stroke}
                  strokeWidth={0.035}
                  x1={toStairSvg(plan.arrow.shaft[0]).x}
                  x2={toStairSvg(plan.arrow.shaft[1]).x}
                  y1={toStairSvg(plan.arrow.shaft[0]).y}
                  y2={toStairSvg(plan.arrow.shaft[1]).y}
                />
                <path d={polygonToPath(plan.arrow.head)} fill={stroke} />
              </g>
            )}
          </g>
        );
      })}

      {wallPolygons.map(({ wall, polygon, points }) => {
        const isSelected = selectedIdSet.has(wall.id);
        const isHovered = canSelectGeometry && hoveredWallId === wall.id;
        const hoverStroke = isSelected
          ? palette.selectedStroke
          : palette.wallHoverStroke;
        const hoverSidePaths = getWallHoverSidePaths(polygon, wall);

        return (
          <g
            key={wall.id}
            onPointerEnter={
              canSelectGeometry ? () => onWallHoverChange(wall.id) : undefined
            }
            onPointerLeave={
              canSelectGeometry ? () => onWallHoverChange(null) : undefined
            }
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
                  event.stopPropagation();
                  onWallClick(wall, event);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  onWallDoubleClick(wall, event);
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
                      event.stopPropagation();
                      onWallClick(wall, event);
                    }
                  : undefined
              }
              onDoubleClick={
                canSelectGeometry
                  ? (event) => {
                      event.stopPropagation();
                      onWallDoubleClick(wall, event);
                    }
                  : undefined
              }
              points={points}
              stroke={isSelected ? "none" : palette.wallStroke}
              strokeOpacity={1}
              strokeWidth="0.06"
              style={{ cursor: EDITOR_CURSOR }}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}

      {openingsPolygons.map(({ opening, polygon, points }) => {
        const isSelected = selectedIdSet.has(opening.id);
        const isHovered = canSelectGeometry && hoveredOpeningId === opening.id;
        const isHighlighted = isHovered || isSelected;
        const highlightStroke = isSelected
          ? palette.selectedStroke
          : palette.wallHoverStroke;
        const detailStroke = isSelected
          ? palette.surface
          : palette.openingStroke;
        const centerLine = getOpeningCenterLine(polygon);

        if (opening.type === "window") {
          if (polygon.length < 4) return null;
          if (!centerLine) return null;
          const windowLineStartX = toSvgX(centerLine.start.x);
          const windowLineStartY = toSvgY(centerLine.start.y);
          const windowLineEndX = toSvgX(centerLine.end.x);
          const windowLineEndY = toSvgY(centerLine.end.y);

          return (
            <g
              key={opening.id}
              onClick={
                canSelectGeometry
                  ? (event) => {
                      event.stopPropagation();
                      onOpeningSelect(opening.id, event);
                    }
                  : undefined
              }
              onDoubleClick={
                canSelectGeometry
                  ? (event) => {
                      event.stopPropagation();
                      onOpeningDoubleClick(opening);
                    }
                  : undefined
              }
              onPointerEnter={
                canSelectGeometry
                  ? () => {
                      onWallHoverChange(null);
                      onOpeningHoverChange(opening.id);
                    }
                  : undefined
              }
              onPointerLeave={
                canSelectGeometry ? () => onOpeningHoverChange(null) : undefined
              }
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
                stroke={
                  isSelected ? palette.selectedStroke : palette.windowStroke
                }
                strokeOpacity={1}
                strokeWidth={FLOORPLAN_OPENING_STROKE_WIDTH}
              />
              <line
                stroke={
                  isSelected ? palette.selectedStroke : palette.windowStroke
                }
                strokeWidth={FLOORPLAN_OPENING_DETAIL_STROKE_WIDTH}
                x1={windowLineStartX}
                x2={windowLineEndX}
                y1={windowLineStartY}
                y2={windowLineEndY}
              />
            </g>
          );
        }

        if (opening.type === "door") {
          if (polygon.length < 4) return null;
          if (!centerLine) return null;
          const [p1, p2, p3, p4] = polygon;
          const svgP1 = toSvgPoint(p1!);
          const svgP2 = toSvgPoint(p2!);
          const svgP3 = toSvgPoint(p3!);
          const svgP4 = toSvgPoint(p4!);
          const cx = (svgP1.x + svgP2.x + svgP3.x + svgP4.x) / 4;
          const cy = (svgP1.y + svgP2.y + svgP3.y + svgP4.y) / 4;

          const dirX = svgP2.x - svgP1.x;
          const dirY = svgP2.y - svgP1.y;
          const len = Math.sqrt(dirX * dirX + dirY * dirY);
          const nx = dirX / len;
          const ny = dirY / len;

          const px = -ny;
          const py = nx;

          // p1→p2 runs along the wall (length = door width), so p2→p3 is the
          // across-wall side: the wall thickness, in SVG units.
          const thickness = Math.hypot(svgP3.x - svgP2.x, svgP3.y - svgP2.y);

          const hingesSide = opening.hingesSide ?? "left";
          const swingDirection = opening.swingDirection ?? "inward";
          const width = opening.width;
          const sweepFlag =
            hingesSide === "left"
              ? swingDirection === "inward"
                ? 0
                : 1
              : swingDirection === "inward"
                ? 1
                : 0;

          const hx = cx - nx * (width / 2) * (hingesSide === "left" ? 1 : -1);
          const hy = cy - ny * (width / 2) * (hingesSide === "left" ? 1 : -1);

          const ox = hx + px * width * (swingDirection === "inward" ? 1 : -1);
          const oy = hy + py * width * (swingDirection === "inward" ? 1 : -1);

          const ox2 = cx + nx * (width / 2) * (hingesSide === "left" ? 1 : -1);
          const oy2 = cy + ny * (width / 2) * (hingesSide === "left" ? 1 : -1);

          return (
            <g
              key={opening.id}
              onClick={
                canSelectGeometry
                  ? (event) => {
                      event.stopPropagation();
                      onOpeningSelect(opening.id, event);
                    }
                  : undefined
              }
              onDoubleClick={
                canSelectGeometry
                  ? (event) => {
                      event.stopPropagation();
                      onOpeningDoubleClick(opening);
                    }
                  : undefined
              }
              onPointerEnter={
                canSelectGeometry
                  ? () => {
                      onWallHoverChange(null);
                      onOpeningHoverChange(opening.id);
                    }
                  : undefined
              }
              onPointerLeave={
                canSelectGeometry ? () => onOpeningHoverChange(null) : undefined
              }
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
              {/* Ritn3D 2026-07-19: differentiate door style on the 2D
                  plan so users can see at a glance what they placed.
                    - patio: two parallel sliding panels, NO swing arc,
                      slide arrows along the wall.
                    - glass: current leaf + swing arc but with translucent
                      blue tint on the leaf polygon (matches 3D glass).
                    - pedestrian / other: default leaf + swing arc. */}
              {(() => {
                /* Door symbols, ported from the Flutter editor's painter on
                   MASTER (lib/features/editor/ui/editor_painter.dart).

                   Flutter is the reference because the same plan is drawn in
                   the mobile app and in downloaded plans; a symbol that
                   differs between them is worse than a plain one. Its five
                   types map 1:1 onto the web's, with 'pedestrian' being the
                   schema name for 'single':

                     single/pedestrian  leaf + swing arc
                     double             two half-width leaves, hinged at
                                        OPPOSITE ends, tips meeting mid-opening
                     glass              single swing plus three hatch strokes
                                        across the leaf
                     patio              two half-length panels at +/-0.03 m,
                                        the fixed leaf one side and the sliding
                                        leaf the other, plus a short arrow
                     sliding            ONE panel on a track: a faint track
                                        line at 0.06 m, the panel at 0.12 m,
                                        and an arrow at 0.22 m. No swing arc —
                                        the arrow is what separates it from a
                                        fixed partition.

                   Numbers are Flutter's, not approximations of them. 'garage'
                   has no Flutter type and falls through to the plain leaf,
                   which is what Flutter's own `default:` does. */
                /* Stroke widths are in SCREEN PIXELS, not metres, because
                   these carry vector-effect="non-scaling-stroke". Written as
                   0.04 / 0.025 they rendered at four hundredths of a pixel —
                   present in the DOM, selectable on hover, and invisible.
                   Flutter's paints are 1.5 for the panel and 1 for the track
                   and hatch, so those are the numbers used here. */
                const doorStyle = (opening as any).style ?? "pedestrian";
                const strokeColor = isSelected
                  ? palette.selectedStroke
                  : palette.doorStroke;
                const sgn = swingDirection === "inward" ? 1 : -1;
                const half = width / 2;
                // Ends of the opening, and the along-wall unit vector.
                const aX = cx - nx * half;
                const aY = cy - ny * half;
                const bX = cx + nx * half;
                const bY = cy + ny * half;

                /* Jamb ticks. Flutter draws these for EVERY door type before
                   it switches on the type at all (framePaint, strokeWidth 2,
                   full ink rather than the faded panel colour), and their
                   absence here is why a patio or sliding door looked like a
                   bare line: those two types have no swing arc, so the ticks
                   are the only thing marking the opening as a door. Length is
                   Flutter's wall.thickness / 2 + 0.05, drawn to BOTH sides.
                   Ink colour, so they sit with the wall rather than the leaf. */
                const tick = thickness / 2 + 0.05;
                const jambColor = isSelected
                  ? palette.selectedStroke
                  : palette.wallStroke;
                const jambs = (
                  <>
                    {(
                      [
                        [aX, aY],
                        [bX, bY],
                      ] as const
                    ).map(([jx, jy], i) => (
                      <line
                        key={`jamb${i}`}
                        stroke={jambColor}
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                        x1={jx - px * tick}
                        y1={jy - py * tick}
                        x2={jx + px * tick}
                        y2={jy + py * tick}
                      />
                    ))}
                  </>
                );

                if (doorStyle === "double") {
                  const aOx = aX + px * half * sgn;
                  const aOy = aY + py * half * sgn;
                  const bOx = bX + px * half * sgn;
                  const bOy = bY + py * half * sgn;
                  return (
                    <g data-element="door-symbol">
                      {jambs}
                      <line
                        stroke={strokeColor}
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                        x1={aX}
                        x2={aOx}
                        y1={aY}
                        y2={aOy}
                      />
                      <path
                        d={`M ${aOx} ${aOy} A ${half} ${half} 0 0 ${sgn > 0 ? 0 : 1} ${cx} ${cy}`}
                        fill="none"
                        stroke={strokeColor}
                        strokeDasharray="4 3"
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                      />
                      <line
                        stroke={strokeColor}
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                        x1={bX}
                        x2={bOx}
                        y1={bY}
                        y2={bOy}
                      />
                      <path
                        d={`M ${bOx} ${bOy} A ${half} ${half} 0 0 ${sgn > 0 ? 1 : 0} ${cx} ${cy}`}
                        fill="none"
                        stroke={strokeColor}
                        strokeDasharray="4 3"
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  );
                }

                if (doorStyle === "patio") {
                  // The whole symbol is two panels staggered by 0.03 m. That
                  // stagger IS the symbol, so it is the feature to keep legible.
                  const off = 0.03 * doorInflate(0.03);
                  return (
                    <g data-element="door-symbol">
                      {jambs}
                      <line
                        stroke={strokeColor}
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                        x1={aX + px * off}
                        y1={aY + py * off}
                        x2={cx + px * off}
                        y2={cy + py * off}
                      />
                      <line
                        stroke={strokeColor}
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                        x1={cx - px * off}
                        y1={cy - py * off}
                        x2={bX - px * off}
                        y2={bY - py * off}
                      />
                      <line
                        stroke={strokeColor}
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                        x1={cx}
                        y1={cy}
                        x2={cx + nx * width * 0.1}
                        y2={cy + ny * width * 0.1}
                      />
                    </g>
                  );
                }

                if (doorStyle === "garage") {
                  /* A sectional overhead door: no swing, no sliding track.
                     With no branch of its own it fell through to the
                     pedestrian swing arc, which is not merely plain but
                     wrong — it read as a hinged door and gave no hint the
                     opening was a garage.

                     In plan it is the panel itself, sitting on the opening
                     line, with its section joints ticked across. The ticks
                     are what separate it at a glance from a blocked-up
                     opening; the panel is deliberately heavier than a
                     pedestrian leaf because a garage door is one slab. */
                  const k = doorInflate(0.05);
                  const panelOff = 0.05 * k * sgn;
                  const tick = 0.07;
                  const SECTIONS = 4;
                  const ticks = [];
                  for (let s = 1; s < SECTIONS; s++) {
                    const t = s / SECTIONS;
                    const jx = aX + (bX - aX) * t + px * panelOff;
                    const jy = aY + (bY - aY) * t + py * panelOff;
                    ticks.push(
                      <line
                        key={s}
                        opacity={0.55}
                        stroke={strokeColor}
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                        x1={jx - px * tick}
                        y1={jy - py * tick}
                        x2={jx + px * tick}
                        y2={jy + py * tick}
                      />,
                    );
                  }
                  return (
                    <g data-element="door-symbol">
                      {jambs}
                      <line
                        stroke={strokeColor}
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                        x1={aX + px * panelOff}
                        y1={aY + py * panelOff}
                        x2={bX + px * panelOff}
                        y2={bY + py * panelOff}
                      />
                      {ticks}
                    </g>
                  );
                }

                if (doorStyle === "sliding") {
                  // Panel reads against its track, so the 0.06 m between
                  // them is the feature. The arrow keeps Flutter's fixed
                  // 0.10 m clearance beyond the panel rather than being
                  // inflated too, or it swings out into the room.
                  const k = doorInflate(0.06);
                  const trackOff = 0.06 * k * sgn;
                  const panelOff = 0.12 * k * sgn;
                  const arrowOff = panelOff + 0.1 * sgn;
                  const headLen = 0.14;
                  const tipX = cx + nx * headLen + px * arrowOff;
                  const tipY = cy + ny * headLen + py * arrowOff;
                  const baseX = cx - nx * headLen + px * arrowOff;
                  const baseY = cy - ny * headLen + py * arrowOff;
                  return (
                    <g data-element="door-symbol">
                      {jambs}
                      <line
                        opacity={0.45}
                        stroke={strokeColor}
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                        x1={aX + px * trackOff}
                        y1={aY + py * trackOff}
                        x2={bX + px * trackOff}
                        y2={bY + py * trackOff}
                      />
                      <line
                        stroke={strokeColor}
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                        x1={aX + px * panelOff}
                        y1={aY + py * panelOff}
                        x2={bX + px * panelOff}
                        y2={bY + py * panelOff}
                      />
                      <line
                        opacity={0.45}
                        stroke={strokeColor}
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                        x1={baseX}
                        y1={baseY}
                        x2={tipX}
                        y2={tipY}
                      />
                      {[1, -1].map((s) => (
                        <line
                          key={s}
                          opacity={0.45}
                          stroke={strokeColor}
                          strokeWidth={1}
                          vectorEffect="non-scaling-stroke"
                          x1={tipX}
                          y1={tipY}
                          x2={
                            cx +
                            nx * (headLen - 0.06) +
                            px * (arrowOff + s * 0.05 * k * sgn)
                          }
                          y2={
                            cy +
                            ny * (headLen - 0.06) +
                            py * (arrowOff + s * 0.05 * k * sgn)
                          }
                        />
                      ))}
                    </g>
                  );
                }

                // single / pedestrian / glass / garage — leaf plus swing arc.
                return (
                  <g data-element="door-symbol">
                    {jambs}
                    <line
                      stroke={strokeColor}
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                      x1={hx}
                      x2={ox}
                      y1={hy}
                      y2={oy}
                    />
                    <path
                      d={`M ${ox} ${oy} A ${width} ${width} 0 0 ${sweepFlag} ${ox2} ${oy2}`}
                      fill="none"
                      stroke={strokeColor}
                      strokeDasharray="4 3"
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                    {/* 5 strokes at 0.6 alpha, width 1.2 — Flutter's current
                        numbers. This was ported at its OLDER values (3 at
                        0.35), which Flutter had already raised with the note
                        that a glass door "read as an ordinary one at a
                        glance". Same symptom here, same fix. */}
                    {doorStyle === "glass" &&
                      [1, 2, 3, 4, 5].map((i) => {
                        const t = i / 6;
                        const alongX = aX + nx * width * t;
                        const alongY = aY + ny * width * t;
                        return (
                          <line
                            key={i}
                            opacity={0.6}
                            stroke={strokeColor}
                            strokeWidth={1.2}
                            vectorEffect="non-scaling-stroke"
                            x1={alongX + px * width * 0.15 * sgn}
                            y1={alongY + py * width * 0.15 * sgn}
                            x2={alongX + px * width * 0.55 * sgn}
                            y2={alongY + py * width * 0.55 * sgn}
                          />
                        );
                      })}
                  </g>
                );
              })()}
            </g>
          );
        }

        return null;
      })}

      {wallMeasurements.map((measurement) => (
        <g
          className="wall-dimension"
          key={`measurement-${measurement.wallId}`}
          pointerEvents="none"
          style={{ userSelect: "none" }}
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
  );
});

const FloorplanSiteLayer = memo(function FloorplanSiteLayer({
  isEditing,
  sitePolygon,
  unit,
  showDimensions = true,
}: {
  isEditing: boolean;
  sitePolygon: SitePolygonEntry | null;
  unit: "metric" | "imperial";
  showDimensions?: boolean;
}) {
  if (!sitePolygon) {
    return null;
  }

  const polygon = sitePolygon.polygon;
  const { area, centroid } = getPolygonAreaAndCentroid(polygon);

  // Compute edge midpoints, lengths, and label offsets
  const edges = polygon.map((p1, i) => {
    const p2 = polygon[(i + 1) % polygon.length]!;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    // Offset label outward from polygon center
    const nx = -(p2.y - p1.y) / length;
    const ny = (p2.x - p1.x) / length;
    // Push label away from centroid
    const toCenterX = centroid.x - midX;
    const toCenterY = centroid.y - midY;
    const dot = nx * toCenterX + ny * toCenterY;
    const sign = dot > 0 ? -1 : 1;
    const offset = Math.max(0.35, Math.sqrt(area) * 0.05);
    return {
      length,
      labelX: toSvgX(midX + nx * offset * sign),
      labelY: toSvgY(midY + ny * offset * sign),
      label: formatMeasurement(length, unit),
    };
  });

  // Scale font size based on site size — larger sites get bigger labels
  const siteSpan = Math.sqrt(area);
  const edgeFontSize = Math.max(0.2, Math.min(1.2, siteSpan * 0.04));
  const areaFontSize = edgeFontSize * 1.4;
  const labelOffset = Math.max(0.35, siteSpan * 0.05);

  return (
    <>
      <polygon
        fill={FLOORPLAN_SITE_COLOR}
        fillOpacity={isEditing ? 0.12 : 0.08}
        pointerEvents="none"
        points={sitePolygon.points}
        stroke={FLOORPLAN_SITE_COLOR}
        strokeDasharray={isEditing ? "0.16 0.1" : undefined}
        strokeLinejoin="round"
        strokeOpacity={isEditing ? 0.92 : 0.72}
        strokeWidth={isEditing ? "0.08" : "0.06"}
        vectorEffect="non-scaling-stroke"
      />

      {/* Edge dimensions — only in site edit mode */}
      {showDimensions &&
        edges.map((edge, i) => (
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
      {showDimensions && (
        <text
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
        </text>
      )}
    </>
  );
});

const FloorplanZoneLayer = memo(function FloorplanZoneLayer({
  canSelectZones,
  onZoneSelect,
  palette,
  selectedZoneId,
  zonePolygons,
  unit,
}: {
  canSelectZones: boolean;
  onZoneSelect: (
    zoneId: ZoneNodeType["id"],
    event: ReactMouseEvent<SVGElement>,
  ) => void;
  palette: FloorplanPalette;
  selectedZoneId: ZoneNodeType["id"] | null;
  zonePolygons: ZonePolygonEntry[];
  unit: "metric" | "imperial";
}) {
  return (
    <>
      {zonePolygons.map(({ zone, polygon, points }) => {
        const isSelected = selectedZoneId === zone.id;
        const { area, centroid } = getPolygonAreaAndCentroid(polygon);
        const label = zone.name || "Room";
        const labelFontSize = Math.max(
          0.15,
          Math.min(0.4, Math.sqrt(area) * 0.08),
        );

        return (
          <g key={zone.id}>
            <polygon
              fill="none"
              pointerEvents="none"
              points={points}
              stroke={isSelected ? palette.selectedStroke : zone.color}
              strokeLinejoin="round"
              strokeOpacity={isSelected ? 0.7 : 0}
              strokeWidth={isSelected ? "0.06" : "0"}
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

            {/* Ritn3D 2026-08-01: hit the room's INTERIOR, not its outline.
                This was an 18px transparent stroke along the zone boundary.
                Zone boundaries run along wall centrelines, so that put a
                room-sized hit strip directly over every wall bounding a
                room — and since this layer renders after the geometry layer,
                it won. Clicking such a wall selected the room; only walls
                that bounded no room stayed selectable.
                Meanwhile fill="none" meant room interiors caught nothing, so
                a click in open floor fell through to the guide image's
                full-size rect and selected the background photo instead.
                Filling instead of stroking fixes both: walls stay clickable
                (they render above this layer now) and open floor selects the
                room it's in. */}
            {canSelectZones && (
              <polygon
                fill="transparent"
                onClick={(event) => {
                  event.stopPropagation();
                  onZoneSelect(zone.id, event);
                }}
                pointerEvents="fill"
                points={points}
                style={{ cursor: EDITOR_CURSOR }}
              />
            )}
          </g>
        );
      })}
    </>
  );
});

const FloorplanWallEndpointLayer = memo(function FloorplanWallEndpointLayer({
  endpointHandles,
  hoveredEndpointId,
  onWallEndpointPointerDown,
  onEndpointHoverChange,
  palette,
}: {
  endpointHandles: Array<{
    wall: WallNode;
    endpoint: WallEndpoint;
    point: WallPlanPoint;
    isSelected: boolean;
    isActive: boolean;
  }>;
  onWallEndpointPointerDown: (
    wall: WallNode,
    endpoint: WallEndpoint,
    event: ReactPointerEvent<SVGCircleElement>,
  ) => void;
  hoveredEndpointId: string | null;
  onEndpointHoverChange: (endpointId: string | null) => void;
  palette: FloorplanPalette;
}) {
  return (
    <>
      {endpointHandles.map(
        ({ wall, endpoint, point, isSelected, isActive }) => {
          const endpointId = `${wall.id}:${endpoint}`;
          const isHovered = hoveredEndpointId === endpointId;
          const stroke =
            isSelected || isActive
              ? palette.endpointHandleActiveStroke
              : palette.endpointHandleStroke;
          const hoverStroke =
            isSelected || isActive
              ? palette.endpointHandleActiveStroke
              : palette.endpointHandleHoverStroke;
          const outerRadius = isActive ? 0.18 : isSelected ? 0.16 : 0.14;
          const svgPoint = toSvgPlanPoint(point);

          return (
            <g
              key={endpointId}
              onClick={(event) => {
                event.stopPropagation();
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
                fill={
                  isActive
                    ? palette.endpointHandleActiveFill
                    : palette.endpointHandleFill
                }
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
                onPointerDown={(event) =>
                  onWallEndpointPointerDown(wall, endpoint, event)
                }
                pointerEvents="all"
                r={outerRadius}
                stroke="transparent"
                strokeWidth={FLOORPLAN_ENDPOINT_HIT_STROKE_WIDTH}
                style={{ cursor: EDITOR_CURSOR }}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        },
      )}
    </>
  );
});

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
    nodeId: string;
    vertexIndex: number;
    point: WallPlanPoint;
    isActive: boolean;
  }>;
  midpointHandles: Array<{
    nodeId: string;
    edgeIndex: number;
    point: WallPlanPoint;
  }>;
  hoveredHandleId: string | null;
  onHandleHoverChange: (handleId: string | null) => void;
  onVertexPointerDown: (
    nodeId: string,
    vertexIndex: number,
    event: ReactPointerEvent<SVGCircleElement>,
  ) => void;
  onVertexDoubleClick: (
    nodeId: string,
    vertexIndex: number,
    event: ReactPointerEvent<SVGCircleElement>,
  ) => void;
  onMidpointPointerDown: (
    nodeId: string,
    edgeIndex: number,
    event: ReactPointerEvent<SVGCircleElement>,
  ) => void;
  palette: FloorplanPalette;
}) {
  return (
    <>
      {vertexHandles.map(({ nodeId, vertexIndex, point, isActive }) => {
        const handleId = `${nodeId}:vertex:${vertexIndex}`;
        const isHovered = hoveredHandleId === handleId;
        const stroke = isActive
          ? palette.endpointHandleActiveStroke
          : palette.endpointHandleStroke;
        const outerRadius = isActive ? 0.15 : 0.13;
        const svgPoint = toSvgPlanPoint(point);

        return (
          <g
            key={handleId}
            onClick={(event) => {
              event.stopPropagation();
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
              fill={
                isActive
                  ? palette.endpointHandleActiveFill
                  : palette.endpointHandleFill
              }
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
                event.preventDefault();
                event.stopPropagation();
                onVertexDoubleClick(nodeId, vertexIndex, event as any);
              }}
              onPointerDown={(event) => {
                onVertexPointerDown(nodeId, vertexIndex, event);
              }}
              pointerEvents="all"
              r={outerRadius}
              stroke="transparent"
              strokeWidth={FLOORPLAN_ENDPOINT_HIT_STROKE_WIDTH}
              style={{ cursor: EDITOR_CURSOR }}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}

      {midpointHandles.map(({ nodeId, edgeIndex, point }) => {
        const handleId = `${nodeId}:midpoint:${edgeIndex}`;
        const isHovered = hoveredHandleId === handleId;
        const stroke = isHovered
          ? palette.endpointHandleHoverStroke
          : palette.endpointHandleStroke;
        const radius = isHovered ? 0.092 : 0.08;
        const svgPoint = toSvgPlanPoint(point);

        return (
          <g
            key={handleId}
            onClick={(event) => {
              event.stopPropagation();
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
              onPointerDown={(event) =>
                onMidpointPointerDown(nodeId, edgeIndex, event)
              }
              pointerEvents="all"
              r={radius}
              stroke="transparent"
              strokeWidth={FLOORPLAN_ENDPOINT_HIT_STROKE_WIDTH}
              style={{ cursor: EDITOR_CURSOR }}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </>
  );
});

export function FloorplanPanel() {
  const viewportHostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const panStateRef = useRef<PanState | null>(null);
  const guideInteractionRef = useRef<GuideInteractionState | null>(null);
  const guideTransformDraftRef = useRef<GuideTransformDraft | null>(null);
  const wallEndpointDragRef = useRef<WallEndpointDragState | null>(null);
  // Bulge handle drag — parallel to endpoint drag (see WallBulgeDragState).
  const wallBulgeDragRef = useRef<WallBulgeDragState | null>(null);
  /** Dragging a floor cut: one corner of it, or the whole ring. */
  const slabHoleDragRef = useRef<{
    pointerId: number;
    slabId: SlabNode["id"];
    holeIndex: number;
    vertexIndex: number | null; // null = moving the whole hole
    origin: [number, number];
    startRing: [number, number][];
  } | null>(null);
  const slabBulgeDragRef = useRef<{
    pointerId: number;
    slabId: SlabNode["id"];
    holeIndex: number | null;
    edgeIndex: number;
    start: [number, number];
    end: [number, number];
    lastBulge: number;
  } | null>(null);
  // Item move/rotate drag — stored as a ref since intra-drag updates don't
  // require React re-renders (we mutate the node directly each pointer-move
  // event and the scene store re-renders the affected SVG element).
  const itemMoveDragRef = useRef<{
    pointerId: number;
    itemId: string;
    startPlan: [number, number];
    initialPos: [number, number, number];
  } | null>(null);
  const itemRotateDragRef = useRef<{
    pointerId: number;
    itemId: string;
    centerPlan: [number, number];
    initialRotY: number;
    startAngleFromCenter: number;
  } | null>(null);
  const siteBoundaryDraftRef = useRef<SiteBoundaryDraft | null>(null);
  const slabBoundaryDraftRef = useRef<SlabBoundaryDraft | null>(null);
  const zoneBoundaryDraftRef = useRef<ZoneBoundaryDraft | null>(null);
  const gestureScaleRef = useRef(1);
  const panelInteractionRef = useRef<PanelInteractionState | null>(null);
  const panelBoundsRef = useRef<ViewportBounds | null>(null);
  const hasUserAdjustedViewportRef = useRef(false);
  const previousLevelIdRef = useRef<string | null>(null);
  const levelMenuCloseTimeoutRef = useRef<number | null>(null);
  const levelId = useViewer((state) => state.selection.levelId);
  const buildingId = useViewer((state) => state.selection.buildingId);
  const selectedZoneId = useViewer((state) => state.selection.zoneId);
  const selectedIds = useViewer((state) => state.selection.selectedIds);
  const setSelection = useViewer((state) => state.setSelection);
  const theme = useViewer((state) => state.theme);
  const unit = useViewer((state) => state.unit);
  const showGrid = useViewer((state) => state.showGrid);
  const showGuides = useViewer((state) => state.showGuides);
  const setShowGuides = useViewer((state) => state.setShowGuides);
  const catalogCategory = useEditor((state) => state.catalogCategory);
  const setCatalogCategory = useEditor((state) => state.setCatalogCategory);
  const setFloorplanOpen = useEditor((state) => state.setFloorplanOpen);
  const isFloorplanHovered = useEditor((state) => state.isFloorplanHovered);
  const setFloorplanHovered = useEditor((state) => state.setFloorplanHovered);
  const selectedReferenceId = useEditor((state) => state.selectedReferenceId);
  const setSelectedReferenceId = useEditor(
    (state) => state.setSelectedReferenceId,
  );
  const setMode = useEditor((state) => state.setMode);
  const movingNode = useEditor((state) => state.movingNode);
  const phase = useEditor((state) => state.phase);
  const mode = useEditor((state) => state.mode);
  const setPhase = useEditor((state) => state.setPhase);
  const setMovingNode = useEditor((state) => state.setMovingNode);
  const structureLayer = useEditor((state) => state.structureLayer);
  const setStructureLayer = useEditor((state) => state.setStructureLayer);
  const setTool = useEditor((state) => state.setTool);
  const tool = useEditor((state) => state.tool);
  const deleteNode = useScene((state) => state.deleteNode);
  const updateNode = useScene((state) => state.updateNode);
  // Batch form -- used by scale calibration so rescaling the whole plan lands
  // as a single undo step rather than one per wall.
  const updateNodes = useScene((state) => state.updateNodes);
  const levelNode = useScene((state) =>
    levelId ? (state.nodes[levelId] as LevelNode | undefined) : undefined,
  );
  const currentBuildingId =
    levelNode?.type === "level" && levelNode.parentId
      ? (levelNode.parentId as BuildingNode["id"])
      : (buildingId as BuildingNode["id"] | null);
  const site = useScene((state) => {
    for (const rootNodeId of state.rootNodeIds) {
      const node = state.nodes[rootNodeId];
      if (node?.type === "site") {
        return node as SiteNode;
      }
    }

    return null;
  });
  const floorplanLevels = useScene(
    useShallow((state) => {
      if (!currentBuildingId) {
        return [] as LevelNode[];
      }

      const buildingNode = state.nodes[currentBuildingId];
      if (!buildingNode || buildingNode.type !== "building") {
        return [] as LevelNode[];
      }

      return buildingNode.children
        .map((childId) => state.nodes[childId])
        .filter((node): node is LevelNode => node?.type === "level")
        .sort((a, b) => a.level - b.level);
    }),
  );
  const walls = useScene(
    useShallow((state) => {
      if (!levelId) {
        return [] as WallNode[];
      }

      const nextLevelNode = state.nodes[levelId];
      if (!nextLevelNode || nextLevelNode.type !== "level") {
        return [] as WallNode[];
      }

      return nextLevelNode.children
        .map((childId) => state.nodes[childId])
        .filter(
          (node): node is WallNode =>
            node?.type === "wall" && node.visible !== false,
        );
    }),
  );
  const openings = useScene(
    useShallow((state) => {
      if (!levelId) {
        return [] as OpeningNode[];
      }

      const nextLevelNode = state.nodes[levelId];
      if (!nextLevelNode || nextLevelNode.type !== "level") {
        return [] as OpeningNode[];
      }

      const nextWalls = nextLevelNode.children
        .map((childId) => state.nodes[childId])
        .filter((node): node is WallNode => node?.type === "wall");

      return nextWalls.flatMap((wall) =>
        wall.children
          .map((childId) => state.nodes[childId])
          .filter(
            (node): node is OpeningNode =>
              (node?.type === "window" || node?.type === "door") &&
              node.visible !== false,
          ),
      );
    }),
  );
  // Ritn3D: items (furniture / symbols) on the active level. Floor-plan
  // panel renders these as a flat top-down image with rotation; Pascal's
  // 3D ItemRenderer is dead code for us (no live R3F canvas), so this is
  // the ONLY surface where dropped symbols become visible.
  const levelItems = useScene(
    useShallow((state) => {
      if (!levelId) return [] as ItemNode[];
      const lvl = state.nodes[levelId];
      if (!lvl || lvl.type !== "level") return [] as ItemNode[];
      return lvl.children
        .map((childId) => state.nodes[childId])
        .filter(
          (n): n is ItemNode => n?.type === "item" && n.visible !== false,
        );
    }),
  );

  // Ritn3D: ghost walls from the level below for multi-floor alignment
  const ghostWalls = useScene(
    useShallow((state) => {
      if (!levelId || !currentBuildingId) return [] as WallNode[];

      const building = state.nodes[currentBuildingId];
      if (!building || building.type !== "building") return [] as WallNode[];

      const currentLevel = state.nodes[levelId];
      if (!currentLevel || currentLevel.type !== "level")
        return [] as WallNode[];
      const currentLevelNum = currentLevel.level ?? 0;
      if (currentLevelNum === 0) return [] as WallNode[]; // Ground floor has no floor below

      // Find the level below
      const levelBelow = building.children
        .map((childId) => state.nodes[childId])
        .find(
          (node): node is LevelNode =>
            node?.type === "level" && (node.level ?? 0) === currentLevelNum - 1,
        );

      if (!levelBelow) return [] as WallNode[];

      return levelBelow.children
        .map((childId) => state.nodes[childId])
        .filter(
          (node): node is WallNode =>
            node?.type === "wall" && node.visible !== false,
        );
    }),
  );

  const slabs = useScene(
    useShallow((state) => {
      if (!levelId) {
        return [] as SlabNode[];
      }

      const nextLevelNode = state.nodes[levelId];
      if (!nextLevelNode || nextLevelNode.type !== "level") {
        return [] as SlabNode[];
      }

      return nextLevelNode.children
        .map((childId) => state.nodes[childId])
        .filter((node): node is SlabNode => node?.type === "slab");
    }),
  );
  // Ritn3D 2026-08-07: levels, for the canvas level switcher.
  //
  // The sidebar's site tree — which is where Pascal put "Add level" — is hard
  // disabled in app-sidebar.tsx behind `{false && ...}` for the first-storey
  // launch. That left multi-storey completely unreachable: the pipeline could
  // render a second floor, the exporter could describe one, and nothing in
  // the UI could create or even show one. This puts it on the canvas, where
  // the rest of this editor lives, rather than reviving that panel.
  // ── Ghost of the storey below ─────────────────────────────────────
  // Drawing an upper floor blind is guesswork: you cannot see where the walls
  // below run, and — the case that actually bites — you cannot see where the
  // stair lands, so a room ends up sitting on top of the landing.
  //
  // Walls and stair footprints only. Not floors or zones: the point is a
  // faint reference, and filled shapes at low opacity read as smudge rather
  // than structure.
  // NOT a useShallow selector. Returning a fresh object of fresh arrays from
  // a store selector makes useShallow compare the ARRAY REFERENCES — new on
  // every read — so the selector reads as changed every time and the
  // component re-renders forever. That surfaced as the page crashing the
  // moment a second level existed, since that is when this returns non-null.
  //
  // useMemo over the node map instead: recomputed when the scene actually
  // changes, stable between renders when it has not.
  const sceneNodes = useScene((state) => state.nodes);
  const levelBelowGhost = useMemo(() => {
    if (!levelId) return null;
    const lvl = sceneNodes[levelId];
    if (!lvl || lvl.type !== "level") return null;
    const bId = lvl.parentId;
    if (!bId) return null;
    const building = sceneNodes[bId as AnyNodeId];
    if (!building || building.type !== "building") return null;

    /* EVERY storey below, not just the nearest. Standing on level 2 you want
       the ground-floor outline as well — that is what tells you whether a
       wall you are drawing lands over structure or over thin air. Depth 1 is
       the storey directly beneath; each further one is drawn fainter, so the
       stack reads back-to-front without any of it competing with the level
       you are editing. */
    const mine = (lvl as LevelNode).level ?? 0;
    const below: LevelNode[] = [];
    for (const childId of building.children) {
      const c = sceneNodes[childId];
      if (c?.type !== "level") continue;
      if (((c as LevelNode).level ?? 0) < mine) below.push(c as LevelNode);
    }
    if (!below.length) return null;
    // Nearest first, so depth is just the index + 1.
    below.sort((a, b) => (b.level ?? 0) - (a.level ?? 0));

    const walls: {
      start: [number, number];
      end: [number, number];
      depth: number;
    }[] = [];
    const stairs: StairNode[] = [];
    below.forEach((lv, i) => {
      const depth = i + 1;
      for (const childId of lv.children) {
        const c = sceneNodes[childId];
        if (c?.type === "wall") {
          walls.push({
            start: c.start as [number, number],
            end: c.end as [number, number],
            depth,
          });
        } else if (c?.type === "stair" && depth === 1) {
          // Stair symbols only from the storey directly below. A stair three
          // floors down tells you nothing about where you are building and
          // its treads make the underlay unreadable.
          stairs.push(c as StairNode);
        }
      }
    });
    return walls.length || stairs.length ? { walls, stairs } : null;
  }, [levelId, sceneNodes]);

  const levelsOnBuilding = useScene(
    useShallow((state) => {
      if (!buildingId) {
        return [] as LevelNode[];
      }
      const building = state.nodes[buildingId];
      if (!building || building.type !== "building") {
        return [] as LevelNode[];
      }
      return building.children
        .map((childId) => state.nodes[childId])
        .filter((child): child is LevelNode => child?.type === "level")
        .slice()
        .sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    }),
  );

  const handleSelectLevel = useCallback(
    (id: LevelNode["id"]) => {
      setSelection({ levelId: id, selectedIds: [] });
    },
    [setSelection],
  );

  const handleAddLevel = useCallback(() => {
    if (!buildingId) return;
    const { createNode, nodes } = useScene.getState();
    const building = nodes[buildingId];
    if (!building || building.type !== "building") return;

    // Number from the highest EXISTING level, not the count. Deleting a middle
    // storey would otherwise hand the next one a number already in use, and
    // the exporter stacks storeys by that number.
    const existing = building.children
      .map((childId) => nodes[childId])
      .filter((child): child is LevelNode => child?.type === "level");
    const nextNumber =
      existing.reduce((max, lvl) => Math.max(max, lvl.level ?? 0), -1) + 1;

    const level = LevelNode.parse({
      level: nextNumber,
      children: [],
      parentId: buildingId,
    });
    createNode(level, buildingId);
    setSelection({ levelId: level.id, selectedIds: [] });
    sfxEmitter.emit("sfx:structure-build");
  }, [buildingId, setSelection]);

  const stairs = useScene(
    useShallow((state) => {
      if (!levelId) {
        return [] as StairNode[];
      }
      const node = state.nodes[levelId];
      if (!node || node.type !== "level") {
        return [] as StairNode[];
      }
      return node.children
        .map((childId) => state.nodes[childId])
        .filter((child): child is StairNode => child?.type === "stair");
    }),
  );
  const levelGuides = useScene(
    useShallow((state) => {
      if (!levelId) {
        return [] as GuideNode[];
      }

      const nextLevelNode = state.nodes[levelId];
      if (!nextLevelNode || nextLevelNode.type !== "level") {
        return [] as GuideNode[];
      }

      return nextLevelNode.children
        .map((childId) => state.nodes[childId])
        .filter((node): node is GuideNode => node?.type === "guide");
    }),
  );
  const zones = useScene(
    useShallow((state) => {
      if (!levelId) {
        return [] as ZoneNodeType[];
      }

      const nextLevelNode = state.nodes[levelId];
      if (!nextLevelNode || nextLevelNode.type !== "level") {
        return [] as ZoneNodeType[];
      }

      return nextLevelNode.children
        .map((childId) => state.nodes[childId])
        .filter((node): node is ZoneNodeType => node?.type === "zone");
    }),
  );

  // Two-point scale calibration. Standard CAD pattern (AutoCAD/Bluebeam/
  // Acrobat): the user clicks two points a known real-world distance apart,
  // types that distance, and we rescale so plan units match reality.
  //
  // There are two things it can be pointed at, and which one is wrong depends
  // on what is on the canvas:
  //
  //   guideId: string  -- TRACING. No geometry exists yet; the photo underlay
  //                       is what needs sizing so the user traces at true
  //                       scale. An uncalibrated guide defaults to scale 5,
  //                       which makes walls measure garbage like 150 m.
  //
  //   guideId: null    -- A DETECTED OR DRAWN PLAN. The geometry itself
  //                       carries the error: detection derives scale by
  //                       assuming every door is 80 cm
  //                       (floorplan_api.py STANDARD_DOOR_WIDTH_CM), so a plan
  //                       drawn with 36" doors comes out ~12.5% small. Here we
  //                       scale the PLAN, not the underlay.
  //
  // Was guide-only until 2026-08-02, which meant calibration silently did
  // nothing on a plan that had walls but no photo. Mirrors iOS
  // CalibrationOverlay.apply().
  const [calibration, setCalibration] = useState<{
    guideId: string | null;
  } | null>(null);
  const [calibrationP1, setCalibrationP1] = useState<WallPlanPoint | null>(
    null,
  );
  const [calibrationP2, setCalibrationP2] = useState<WallPlanPoint | null>(
    null,
  );
  // Ritn3D 2026-06-18: door/window placement preview. Mirrors the AutoCAD
  // "insert" ghost — the user sees exactly where the opening will land
  // before they click. Wall is the projected-onto wall, point is the
  // apex on the wall's centreline, normal is the wall's outward-pointing
  // perpendicular (used to orient the preview swing / sill).
  const [openingPreview, setOpeningPreview] = useState<{
    wallId: WallNode["id"];
    point: WallPlanPoint;
    normal: WallPlanPoint;
  } | null>(null);
  // Ritn3D 2026-08-01: doors/windows cannot be placed on arc walls. The
  // translator maps an opening to the SINGLE arc sub-wall containing its
  // centre (_remap_opening), and sub-walls are ~8cm at sagitta 1.5mm --
  // so a 0.9m door asks the cutter to punch through an 8cm segment and
  // produces a sliver. The block is correct; what was wrong is that it
  // was SILENT, so the tool read as broken. This flag drives an
  // explanatory chip while an opening tool hovers a curved wall.
  const [arcOpeningBlocked, setArcOpeningBlocked] = useState(false);
  const [calibrationInput, setCalibrationInput] = useState("");
  const [calibrationUnit, setCalibrationUnit] = useState<"m" | "ft">("m");
  const [draftStart, setDraftStart] = useState<WallPlanPoint | null>(null);
  const [draftEnd, setDraftEnd] = useState<WallPlanPoint | null>(null);
  // Arc-wall draft state. Three-step machine:
  //   arcDraftStart=null                         -> phase 0: nothing placed yet
  //   arcDraftStart set, arcDraftEnd=null        -> phase 1: end-point preview
  //   arcDraftStart+End set, arcBulgePoint live  -> phase 2: bulge-midpoint preview
  // Next click in phase 2 commits the arc.
  const [arcDraftStart, setArcDraftStart] = useState<WallPlanPoint | null>(
    null,
  );
  const [arcDraftEnd, setArcDraftEnd] = useState<WallPlanPoint | null>(null);
  const [arcBulgePoint, setArcBulgePoint] = useState<WallPlanPoint | null>(
    null,
  );
  const [slabDraftPoints, setSlabDraftPoints] = useState<WallPlanPoint[]>([]);
  const [zoneDraftPoints, setZoneDraftPoints] = useState<WallPlanPoint[]>([]);
  const [siteBoundaryDraft, setSiteBoundaryDraft] =
    useState<SiteBoundaryDraft | null>(null);
  const [siteVertexDragState, setSiteVertexDragState] =
    useState<SiteVertexDragState | null>(null);
  const [slabBoundaryDraft, setSlabBoundaryDraft] =
    useState<SlabBoundaryDraft | null>(null);
  const [slabVertexDragState, setSlabVertexDragState] =
    useState<SlabVertexDragState | null>(null);
  const [zoneBoundaryDraft, setZoneBoundaryDraft] =
    useState<ZoneBoundaryDraft | null>(null);
  const [zoneVertexDragState, setZoneVertexDragState] =
    useState<ZoneVertexDragState | null>(null);
  const [guideTransformDraft, setGuideTransformDraft] =
    useState<GuideTransformDraft | null>(null);
  const [cursorPoint, setCursorPoint] = useState<WallPlanPoint | null>(null);
  const [floorplanCursorPosition, setFloorplanCursorPosition] =
    useState<SvgPoint | null>(null);
  const [wallEndpointDraft, setWallEndpointDraft] =
    useState<WallEndpointDraft | null>(null);
  const [wallBulgeDraft, setWallBulgeDraft] = useState<WallBulgeDraft | null>(
    null,
  );
  const [slabBulgeDraft, setSlabBulgeDraft] = useState<SlabBulgeDraft | null>(
    null,
  );
  const [slabHoleDraft, setSlabHoleDraft] = useState<{
    slabId: SlabNode["id"];
    holeIndex: number;
    ring: [number, number][];
  } | null>(null);
  const [hoveredOpeningId, setHoveredOpeningId] = useState<
    OpeningNode["id"] | null
  >(null);
  const [hoveredWallId, setHoveredWallId] = useState<WallNode["id"] | null>(
    null,
  );
  const [hoveredEndpointId, setHoveredEndpointId] = useState<string | null>(
    null,
  );
  const [hoveredSiteHandleId, setHoveredSiteHandleId] = useState<string | null>(
    null,
  );
  const [hoveredSlabHandleId, setHoveredSlabHandleId] = useState<string | null>(
    null,
  );
  const [hoveredZoneHandleId, setHoveredZoneHandleId] = useState<string | null>(
    null,
  );
  const [hoveredGuideCorner, setHoveredGuideCorner] =
    useState<GuideCorner | null>(null);
  const [floorplanSelectionTool, setFloorplanSelectionTool] =
    useState<FloorplanSelectionTool>("click");

  // Ritn3D: listen for marquee toggle from sidebar + broadcast state back
  useEffect(() => {
    const handler = () => {
      setFloorplanSelectionTool((prev) => {
        const next = prev === "click" ? "marquee" : "click";
        emitter.emit("floorplan:marquee-state" as any, {
          active: next === "marquee",
        });
        return next;
      });
    };
    emitter.on("floorplan:toggle-marquee" as any, handler);
    return () => {
      emitter.off("floorplan:toggle-marquee" as any, handler);
    };
  }, []);

  // Broadcast initial state
  useEffect(() => {
    emitter.emit("floorplan:marquee-state" as any, {
      active: floorplanSelectionTool === "marquee",
    });
  }, [floorplanSelectionTool]);

  // Scale-calibration trigger: `floorplan:calibrate-scale` starts the 2-point
  // flow. Emitted from the Upload Trace button (auto-start on upload), the
  // ReferencePanel re-calibrate button, and Wall Review's "Set scale".
  //
  // Omit guideId (or pass null) to calibrate the PLAN rather than an underlay.
  // seedLongestWall pre-places both points on the longest wall so the common
  // case is "type the number" instead of "work out what to click"; after the
  // importer's collinear merge that wall is normally a full building side.
  // Deliberately not the plan's overall diagonal — a diagonal is not something
  // anyone can go and measure. Both points stay draggable. Mirrors iOS
  // FloorPlanEditorView.armCalibration().
  useEffect(() => {
    const handler = (data?: {
      guideId?: string | null;
      seedLongestWall?: boolean;
    }) => {
      setCalibration({ guideId: data?.guideId ?? null });
      setCalibrationInput("");
      let p1: WallPlanPoint | null = null;
      let p2: WallPlanPoint | null = null;
      if (data?.seedLongestWall) {
        const walls = Object.values(useScene.getState().nodes).filter(
          (n): n is WallNode => (n as AnyNode)?.type === "wall",
        );
        let best = 0;
        for (const w of walls) {
          const len = Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
          if (len > best) {
            best = len;
            p1 = [w.start[0], w.start[1]] as WallPlanPoint;
            p2 = [w.end[0], w.end[1]] as WallPlanPoint;
          }
        }
      }
      setCalibrationP1(p1);
      setCalibrationP2(p2);
    };
    emitter.on("floorplan:calibrate-scale" as any, handler);
    return () => {
      emitter.off("floorplan:calibrate-scale" as any, handler);
    };
  }, []);

  // ESC cancels the calibration flow without applying.
  useEffect(() => {
    if (!calibration) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCalibration(null);
        setCalibrationP1(null);
        setCalibrationP2(null);
        setCalibrationInput("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [calibration]);

  // Scale every plan coordinate by k, about the world origin.
  //
  // One shared origin, never per-wall: scaling each wall about its own centre
  // would change every wall's length correctly and every junction's position
  // wrongly, pulling the plan apart at the corners. A uniform scale about a
  // single point is a similarity transform, so angles, junctions and arc
  // shapes all survive.
  //
  // What does NOT scale:
  //   heights (position[1], wall height, opening height) -- the error is
  //     horizontal only. It comes from px -> m via door width; storey height
  //     is a real-world default and is already correct.
  //   wall thickness -- likewise a default (0.15 m), not detection-derived.
  //   bulge -- tan(arc_angle/4), an angle. Similarity preserves it.
  //   item dimensions -- a sofa is the size it is; only where it sits moves.
  //
  // Diverges from iOS scalePlan(by:) in one respect: iOS openings store
  // positionAlongWall as a 0..1 RATIO, so they ride their wall for free and
  // iOS only has to scale width. Web stores the along-wall distance in
  // METRES, which does not survive a rescale on its own -- see the door case
  // below.
  //
  // Single updateNodes call so zundo records it as ONE undo step.
  const scalePlanBy = useCallback(
    (k: number) => {
      if (!Number.isFinite(k) || k <= 0 || Math.abs(k - 1) < 1e-9) return;
      const nodes = useScene.getState().nodes as Record<string, AnyNode>;
      const updates: { id: AnyNodeId; data: Partial<AnyNode> }[] = [];

      for (const node of Object.values(nodes)) {
        const n = node as any;
        switch (n?.type) {
          case "wall":
            updates.push({
              id: n.id,
              data: {
                start: [n.start[0] * k, n.start[1] * k],
                end: [n.end[0] * k, n.end[1] * k],
              } as Partial<AnyNode>,
            });
            break;
          case "door":
          case "window":
            // position is WALL-LOCAL, not world: [0] is the centre's distance
            // along the wall in metres, [1] is height off the floor, [2] is the
            // offset across the wall's thickness. Only [0] scales -- a door 3 m
            // along a wall that just grew to 3.36 m has to move with it, or it
            // drifts toward the wall's start. [1] and [2] are vertical and
            // thickness-wise, neither of which this correction touches.
            updates.push({
              id: n.id,
              data: {
                position: [n.position[0] * k, n.position[1], n.position[2]],
                width: (n.width ?? 0) * k,
              } as Partial<AnyNode>,
            });
            break;
          case "zone":
            updates.push({
              id: n.id,
              data: {
                polygon: (n.polygon ?? []).map((p: [number, number]) => [
                  p[0] * k,
                  p[1] * k,
                ]),
              } as Partial<AnyNode>,
            });
            break;
          case "slab":
            updates.push({
              id: n.id,
              data: {
                polygon: (n.polygon ?? []).map((p: [number, number]) => [
                  p[0] * k,
                  p[1] * k,
                ]),
                holes: (n.holes ?? []).map((h: [number, number][]) =>
                  h.map((p) => [p[0] * k, p[1] * k]),
                ),
              } as Partial<AnyNode>,
            });
            break;
          case "guide":
            // Position AND scale, so a plan that also has a photo underlay
            // stays registered against the geometry instead of drifting.
            updates.push({
              id: n.id,
              data: {
                position: [n.position[0] * k, n.position[1], n.position[2] * k],
                scale: (n.scale ?? 1) * k,
              } as Partial<AnyNode>,
            });
            break;
          case "item":
            updates.push({
              id: n.id,
              data: {
                position: [n.position[0] * k, n.position[1], n.position[2] * k],
              } as Partial<AnyNode>,
            });
            break;
        }
      }
      if (updates.length) updateNodes(updates);
    },
    [updateNodes],
  );

  // Apply the typed real-world distance.
  //   observed = current plan distance between the two clicked points
  //   real     = user-entered distance in METERS (ft is converted)
  //   ratio    = real / observed
  //
  // Calibrating a guide multiplies guide.scale by the ratio -- linear because
  // guide width is FLOORPLAN_GUIDE_BASE_WIDTH × scale, so plan coordinates
  // inside it scale proportionally. Calibrating the plan applies the same
  // ratio to the geometry instead. Either way scale is a pure multiplier, so
  // nothing needs re-detecting afterwards.
  const applyCalibration = useCallback(() => {
    if (!(calibration && calibrationP1 && calibrationP2)) return;
    const raw = calibrationInput.trim();
    if (!raw) return;
    // Accept a comma decimal separator -- most of Europe types 3,5 not 3.5.
    const parsed = parseFloat(raw.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const realMeters = calibrationUnit === "ft" ? parsed * 0.3048 : parsed;

    const dxObs = calibrationP2[0] - calibrationP1[0];
    const dyObs = calibrationP2[1] - calibrationP1[1];
    const observed = Math.hypot(dxObs, dyObs);
    if (observed < 1e-6) return;

    const ratio = realMeters / observed;

    // WHICH thing is wrong depends on what is on the canvas, NOT on how
    // calibration was started. Deciding from the trigger was wrong: the
    // ReferencePanel and icon-rail buttons pass a guideId, so re-calibrating
    // a detected plan from inside the editor resized only the photo and left
    // the geometry alone -- the plan appeared to ignore the second attempt.
    //
    // No walls  -> tracing. The geometry does not exist yet, so the underlay
    //              is what needs sizing, and the user traces at true scale.
    // Walls     -> a detected or drawn plan. The geometry itself carries the
    //              error, so scale the plan; scalePlanBy takes any guide with
    //              it, so a plan that has both stays registered.
    //
    // Same condition iOS uses in CalibrationOverlay.apply().
    const sceneNodes = useScene.getState().nodes as Record<string, AnyNode>;
    const hasWalls = Object.values(sceneNodes).some(
      (n) => (n as any)?.type === "wall",
    );

    if (!hasWalls) {
      /* Scale the guide on THIS level.

         The fallback took the first guide anywhere in the scene, which is
         fine while a plan has one. Trace a multi-storey building and each
         level has its own, so calibrating the first floor could rescale the
         ground floor's image instead — leaving the one you were measuring
         untouched and silently resizing one you were not looking at.

         calibration.guideId is set when calibration was triggered from a
         specific guide (the upload flow does this), so it still wins. */
      const guideId =
        calibration.guideId ??
        Object.values(sceneNodes).find(
          (n) =>
            (n as any)?.type === "guide" &&
            (!levelId || (n as any)?.parentId === levelId),
        )?.id;
      if (!guideId) return;
      const guide = sceneNodes[guideId as AnyNodeId] as GuideNode | undefined;
      if (!guide) return;
      updateNode(guideId as AnyNodeId, { scale: (guide.scale ?? 1) * ratio });
    } else {
      scalePlanBy(ratio);
    }

    // Exit calibration.
    setCalibration(null);
    setCalibrationP1(null);
    setCalibrationP2(null);
    setCalibrationInput("");

    // 2026-07-28: after calibration the world size just changed, often a
    // lot (a guide goes 5m default -> 15m real; a plan can move 12%).
    // Fit-to-view so the user sees the whole thing instead of a corner of a
    // now-bigger drawing. Small delay lets React commit the update before
    // the fittedViewport memo recomputes.
    window.setTimeout(() => {
      emitter.emit("floorplan:reset-view" as any);
    }, 50);
  }, [
    calibration,
    calibrationP1,
    calibrationP2,
    calibrationInput,
    calibrationUnit,
    updateNode,
    scalePlanBy,
  ]);

  const [floorplanMarqueeState, setFloorplanMarqueeState] =
    useState<FloorplanMarqueeState | null>(null);
  const [shiftPressed, setShiftPressed] = useState(false);
  // 2026-07-27: persistent snap/ortho toggles from the sidebar. Shift
  // still works as a per-instance override (XOR). Effective values are
  // derived here and threaded into every snapWallDraftPoint call below
  // so both toggle + shift agree on a single interpretation.
  const gridSnapEnabled = useEditor((s) => s.gridSnapEnabled);
  const orthoEnabled = useEditor((s) => s.orthoEnabled);
  const orthoActive = orthoEnabled !== shiftPressed;
  const snapActive = gridSnapEnabled !== shiftPressed;
  const [rotationModifierPressed, setRotationModifierPressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [isDraggingPanel, setIsDraggingPanel] = useState(false);
  const [isMacPlatform, setIsMacPlatform] = useState(true);
  const [activeResizeDirection, setActiveResizeDirection] =
    useState<ResizeDirection | null>(null);
  const [panelRect, setPanelRect] = useState<PanelRect>({
    x: PANEL_MARGIN,
    y: PANEL_MARGIN,
    width: PANEL_DEFAULT_WIDTH,
    height: PANEL_DEFAULT_HEIGHT,
  });
  const [isLevelMenuOpen, setIsLevelMenuOpen] = useState(false);
  const [isGuideQuickAccessOpen, setIsGuideQuickAccessOpen] = useState(false);
  const [isPanelReady, setIsPanelReady] = useState(false);
  const [surfaceSize, setSurfaceSize] = useState({ width: 1, height: 1 });
  const [viewport, setViewport] = useState<FloorplanViewport | null>(null);

  useEffect(() => {
    if (structureLayer === "zones" && floorplanSelectionTool === "marquee") {
      setFloorplanSelectionTool("click");
    }
  }, [floorplanSelectionTool, structureLayer]);

  useEffect(() => {
    setIsMacPlatform(navigator.platform.toUpperCase().includes("MAC"));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset guide panel when level changes
  useEffect(() => {
    setIsGuideQuickAccessOpen(false);
  }, [levelId]);

  const sitePolygonEntry = useMemo(() => {
    const polygonPoints = site?.polygon?.points;
    if (!(site && polygonPoints)) {
      return null;
    }

    const polygon = toFloorplanPolygon(polygonPoints);
    if (polygon.length < 3) {
      return null;
    }

    return {
      site,
      polygon,
      points: formatPolygonPoints(polygon),
    };
  }, [site]);
  const displaySitePolygon = useMemo(() => {
    if (!sitePolygonEntry) {
      return null;
    }

    if (!(
      siteBoundaryDraft && siteBoundaryDraft.siteId === sitePolygonEntry.site.id
    )) {
      return sitePolygonEntry;
    }

    const polygon = siteBoundaryDraft.polygon.map(toPoint2D);

    return {
      ...sitePolygonEntry,
      polygon,
      points: formatPolygonPoints(polygon),
    };
  }, [siteBoundaryDraft, sitePolygonEntry]);
  const movingOpeningType =
    movingNode?.type === "door" || movingNode?.type === "window"
      ? movingNode.type
      : null;

  const activeFloorplanToolConfig = useMemo(() => {
    if (movingOpeningType) {
      return (
        structureTools.find((entry) => entry.id === movingOpeningType) ?? null
      );
    }

    if (mode !== "build" || !tool) {
      return null;
    }

    if (tool === "item" && catalogCategory) {
      return (
        furnishTools.find(
          (entry) => entry.catalogCategory === catalogCategory,
        ) ?? null
      );
    }

    return structureTools.find((entry) => entry.id === tool) ?? null;
  }, [catalogCategory, mode, movingOpeningType, tool]);
  const activeFloorplanCursorIndicator =
    useMemo<FloorplanCursorIndicator | null>(() => {
      if (!activeFloorplanToolConfig) {
        return null;
      }
      // Tools whose icon is inline-SVG (no PNG asset) — e.g. arc-wall — can't
      // be shown in the asset-only cursor indicator. Falling through to null is
      // fine: the user still gets the standard editor cursor while drawing.
      if (!activeFloorplanToolConfig.iconSrc) {
        return null;
      }
      return {
        kind: "asset",
        iconSrc: activeFloorplanToolConfig.iconSrc,
      };
    }, [activeFloorplanToolConfig]);
  const visibleGuides = useMemo<GuideNode[]>(() => {
    if (!showGuides) {
      return [];
    }

    return levelGuides.filter((guide) => guide.visible !== false);
  }, [levelGuides, showGuides]);
  const guideById = useMemo(
    () => new Map(levelGuides.map((guide) => [guide.id, guide] as const)),
    [levelGuides],
  );
  const displayGuides = useMemo<GuideNode[]>(() => {
    if (!guideTransformDraft) {
      return visibleGuides;
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
            rotation: [
              guide.rotation[0],
              guideTransformDraft.rotation,
              guide.rotation[2],
            ] as [number, number, number],
            scale: guideTransformDraft.scale,
          }
        : guide,
    );
  }, [guideTransformDraft, visibleGuides]);
  const selectedGuideId =
    selectedReferenceId && guideById.has(selectedReferenceId as GuideNode["id"])
      ? (selectedReferenceId as GuideNode["id"])
      : null;
  const selectedGuide = useMemo(
    () => displayGuides.find((guide) => guide.id === selectedGuideId) ?? null,
    [displayGuides, selectedGuideId],
  );
  const selectedGuideResolvedUrl = useResolvedAssetUrl(
    selectedGuide?.url ?? "",
  );
  const selectedGuideDimensions = useGuideImageDimensions(
    selectedGuideResolvedUrl,
  );
  const activeGuideInteractionGuideId = guideTransformDraft
    ? (guideInteractionRef.current?.guideId ?? null)
    : null;
  const activeGuideInteractionMode = guideTransformDraft
    ? (guideInteractionRef.current?.mode ?? null)
    : null;
  const hasGuideImages = levelGuides.length > 0;
  const guideImagesDescription = hasGuideImages
    ? `${levelGuides.length} guide image${levelGuides.length === 1 ? "" : "s"} on this level`
    : "No guide images on this level";

  const handleGuideOpacityChange = useCallback(
    (guideId: GuideNode["id"], opacity: number) => {
      updateNode(guideId, {
        opacity: Math.round(clamp(opacity, 0, 100)),
      });
    },
    [updateNode],
  );

  const floorplanWalls = useMemo(() => walls.map(getFloorplanWall), [walls]);
  const wallMiterData = useMemo(
    () => calculateLevelMiters(floorplanWalls),
    [floorplanWalls],
  );
  const wallById = useMemo(
    () => new Map(walls.map((wall) => [wall.id, wall] as const)),
    [walls],
  );
  const floorplanWallById = useMemo(
    () => new Map(floorplanWalls.map((wall) => [wall.id, wall] as const)),
    [floorplanWalls],
  );
  const displayWallById = useMemo(() => {
    if (!wallEndpointDraft && !wallBulgeDraft) {
      return wallById;
    }

    let map = wallById;

    if (wallEndpointDraft) {
      const wall = wallById.get(wallEndpointDraft.wallId);
      if (wall) {
        const next = new Map(map);
        next.set(
          wall.id,
          buildWallWithUpdatedEndpoints(
            wall,
            wallEndpointDraft.start,
            wallEndpointDraft.end,
          ),
        );
        map = next;
      }
    }

    if (wallBulgeDraft) {
      // Apply live bulge from drag — caller's wall body re-renders with the
      // arc footprint immediately while the user is dragging the handle.
      const wall = map.get(wallBulgeDraft.wallId);
      if (wall) {
        const next = new Map(map);
        next.set(wall.id, { ...wall, bulge: wallBulgeDraft.bulge } as WallNode);
        map = next;
      }
    }

    return map;
  }, [wallBulgeDraft, wallById, wallEndpointDraft]);
  const displayFloorplanWallById = useMemo(() => {
    if (!wallEndpointDraft && !wallBulgeDraft) {
      return floorplanWallById;
    }

    let map = floorplanWallById;
    const draftedIds = new Set<string>();
    if (wallEndpointDraft) draftedIds.add(wallEndpointDraft.wallId);
    if (wallBulgeDraft) draftedIds.add(wallBulgeDraft.wallId);

    const next = new Map(map);
    for (const id of draftedIds) {
      const previewWall = displayWallById.get(id as WallNode["id"]);
      if (previewWall) next.set(previewWall.id, getFloorplanWall(previewWall));
    }
    map = next;
    return map;
  }, [displayWallById, floorplanWallById, wallBulgeDraft, wallEndpointDraft]);
  // Ritn3D: ghost wall polygons from floor below
  const ghostWallPolygons = useMemo(
    () =>
      ghostWalls.map((wall) => {
        const polygon = getWallPlanFootprint(
          getFloorplanWall(wall),
          EMPTY_WALL_MITER_DATA,
        );
        return { points: formatPolygonPoints(polygon), wall };
      }),
    [ghostWalls],
  );

  const wallPolygons = useMemo(
    () =>
      walls.map((wall) => {
        const floorplanWall =
          floorplanWallById.get(wall.id) ?? getFloorplanWall(wall);
        const polygon = getWallPlanFootprint(floorplanWall, wallMiterData);
        return {
          points: formatPolygonPoints(polygon),
          wall,
          polygon,
        };
      }),
    [floorplanWallById, wallMiterData, walls],
  );
  const displayWallPolygons = useMemo(() => {
    // Ritn3D 2026-06-13: this used to only check wallEndpointDraft, so live
    // bulge drags didn't propagate to the rendered polygons — wall stayed
    // straight visually until commit and then SNAPPED to the curve. That's
    // why the user said the arc didn't move with the cursor. Fixed by also
    // re-rendering the polygon for the wall being bulge-drafted; both drafts
    // are already applied to displayWallById, so we just need to rebuild
    // both affected polygons.
    if (!wallEndpointDraft && !wallBulgeDraft) {
      return wallPolygons;
    }

    const draftedIds = new Set<string>();
    if (wallEndpointDraft) draftedIds.add(wallEndpointDraft.wallId);
    if (wallBulgeDraft) draftedIds.add(wallBulgeDraft.wallId);

    return wallPolygons.map((entry) => {
      if (!draftedIds.has(entry.wall.id)) return entry;
      const previewWall = displayWallById.get(entry.wall.id as WallNode["id"]);
      if (!previewWall) return entry;
      const previewPolygon = getWallPlanFootprint(
        getFloorplanWall(previewWall),
        EMPTY_WALL_MITER_DATA,
      );
      return {
        wall: previewWall,
        polygon: previewPolygon,
        points: formatPolygonPoints(previewPolygon),
      };
    });
  }, [displayWallById, wallBulgeDraft, wallEndpointDraft, wallPolygons]);

  const openingsPolygons = useMemo(
    () =>
      openings.flatMap((opening) => {
        const wall = displayFloorplanWallById.get(
          opening.parentId as WallNode["id"],
        );
        if (!wall) return [];
        const polygon = getOpeningFootprint(wall, opening);
        return [
          {
            opening,
            points: formatPolygonPoints(polygon),
            polygon,
          },
        ];
      }),
    [displayFloorplanWallById, openings],
  );
  const slabPolygons = useMemo(
    () =>
      slabs.flatMap((slab) => {
        // Curved edges expand here, at the single place the display polygon
        // is derived, so the path, area and hit-test below all inherit them.
        // A live bulge drag overrides its one edge so the floor re-curves
        // under the cursor instead of snapping only on release.
        let bulges = slab.bulges;
        if (
          slabBulgeDraft?.slabId === slab.id &&
          slabBulgeDraft.holeIndex === null
        ) {
          bulges = [...(slab.bulges ?? [])];
          while (bulges.length < slab.polygon.length) bulges.push(0);
          bulges[slabBulgeDraft.edgeIndex] = slabBulgeDraft.bulge;
        }
        const polygon = toFloorplanPolygon(
          tessellateSlabOutline(slab.polygon, bulges),
        );
        if (polygon.length < 3) {
          return [];
        }

        // A hole being dragged renders from the draft, so the cut moves
        // under the cursor rather than jumping on release.
        const rawHoles = (slab.holes ?? []).map((hole, i) =>
          slabHoleDraft?.slabId === slab.id && slabHoleDraft.holeIndex === i
            ? slabHoleDraft.ring
            : hole,
        );
        /* Stairwell voids, DERIVED from the stairs below rather than stored.
           A stair rising to this storey opens its floor, and the pipeline
           cuts exactly this footprint at render time. Deriving it means the
           void follows the stair when it is moved, resized or switched from
           straight to U — cutting it in as a real hole would leave a hole
           where the stair used to be the moment you dragged it.

           Display only. Never written back to the node, so there is nothing
           for the user to manage or accidentally delete. Level height is
           irrelevant here: the footprint depends on the stair's own length
           and width, not on how many treads it needs. */
        const stairVoids = (levelBelowGhost?.stairs ?? []).map((st) =>
          buildStairPlan(st, DEFAULT_LEVEL_HEIGHT).outline.map(
            (q) => [q.x, q.y] as [number, number],
          ),
        );

        const holes = [...rawHoles, ...stairVoids]
          .map((hole, i) => {
            let hb = slab.holeBulges?.[i];
            if (
              slabBulgeDraft?.slabId === slab.id &&
              slabBulgeDraft.holeIndex === i
            ) {
              hb = [...(hb ?? [])];
              while (hb.length < hole.length) hb.push(0);
              hb[slabBulgeDraft.edgeIndex] = slabBulgeDraft.bulge;
            }
            return toFloorplanPolygon(tessellateSlabOutline(hole, hb));
          })
          .filter((hole) => hole.length >= 3);

        return [
          {
            slab,
            polygon,
            holes,
            path: formatPolygonPath(polygon, holes),
          },
        ];
      }),
    [slabs, slabBulgeDraft, slabHoleDraft, levelBelowGhost],
  );
  // Tread count follows the storey height, so the symbol is rebuilt whenever
  // the level's walls change — a taller storey genuinely has more steps and
  // the plan should show them.
  const stairLevelHeight = useScene(
    useShallow((state) =>
      levelId
        ? getLevelHeight(levelId, state.nodes) || DEFAULT_LEVEL_HEIGHT
        : DEFAULT_LEVEL_HEIGHT,
    ),
  );
  const ghostStairPlans = useMemo(
    () =>
      (levelBelowGhost?.stairs ?? []).map((st) =>
        buildStairPlan(st, stairLevelHeight),
      ),
    [levelBelowGhost, stairLevelHeight],
  );

  const stairPlans = useMemo(
    () => stairs.map((stair) => buildStairPlan(stair, stairLevelHeight)),
    [stairs, stairLevelHeight],
  );

  const displaySlabPolygons = useMemo(() => {
    if (!slabBoundaryDraft) {
      return slabPolygons;
    }

    return slabPolygons.map((entry) =>
      entry.slab.id === slabBoundaryDraft.slabId
        ? {
            ...entry,
            polygon: slabBoundaryDraft.polygon.map(toPoint2D),
            path: formatPolygonPath(
              slabBoundaryDraft.polygon.map(toPoint2D),
              entry.holes,
            ),
          }
        : entry,
    );
  }, [slabBoundaryDraft, slabPolygons]);
  const zonePolygons = useMemo(
    () =>
      zones.flatMap((zone) => {
        const polygon = toFloorplanPolygon(zone.polygon);
        if (polygon.length < 3) {
          return [];
        }

        return [
          {
            zone,
            polygon,
            points: formatPolygonPoints(polygon),
          },
        ];
      }),
    [zones],
  );
  const displayZonePolygons = useMemo(() => {
    if (!zoneBoundaryDraft) {
      return zonePolygons;
    }

    return zonePolygons.map((entry) =>
      entry.zone.id === zoneBoundaryDraft.zoneId
        ? {
            ...entry,
            polygon: zoneBoundaryDraft.polygon.map(toPoint2D),
            points: formatPolygonPoints(
              zoneBoundaryDraft.polygon.map(toPoint2D),
            ),
          }
        : entry,
    );
  }, [zoneBoundaryDraft, zonePolygons]);
  const selectedOpeningEntry = useMemo(() => {
    if (selectedIds.length !== 1) {
      return null;
    }

    return (
      openingsPolygons.find(({ opening }) => opening.id === selectedIds[0]) ??
      null
    );
  }, [openingsPolygons, selectedIds]);
  const slabById = useMemo(
    () => new Map(slabs.map((slab) => [slab.id, slab] as const)),
    [slabs],
  );
  const zoneById = useMemo(
    () => new Map(zones.map((zone) => [zone.id, zone] as const)),
    [zones],
  );
  const selectedSlabEntry = useMemo(() => {
    if (selectedIds.length !== 1) {
      return null;
    }

    return (
      displaySlabPolygons.find(({ slab }) => slab.id === selectedIds[0]) ?? null
    );
  }, [displaySlabPolygons, selectedIds]);
  const selectedZoneEntry = useMemo(() => {
    if (!selectedZoneId) {
      return null;
    }

    return (
      displayZonePolygons.find(({ zone }) => zone.id === selectedZoneId) ?? null
    );
  }, [displayZonePolygons, selectedZoneId]);

  const isSiteEditActive = phase === "site" && mode === "edit";
  const isWallBuildActive =
    phase === "structure" && mode === "build" && tool === "wall";
  // Arc-wall tool: 3-step state machine (start → end → bulge midpoint).
  const isArcWallBuildActive =
    phase === "structure" && mode === "build" && tool === "arc-wall";
  const isSlabBuildActive =
    phase === "structure" && mode === "build" && tool === "slab";
  const isZoneBuildActive =
    phase === "structure" && mode === "build" && tool === "zone";
  // A stair is placed with ONE click, not a polygon — its shape comes
  // from the variant and footprint in the panel, not from points the
  // user traces. So it is deliberately not part of isPolygonBuildActive.
  const isStairBuildActive =
    phase === "structure" && mode === "build" && tool === "stair";
  const isDoorBuildActive =
    phase === "structure" && mode === "build" && tool === "door";
  const isWindowBuildActive =
    phase === "structure" && mode === "build" && tool === "window";
  const isPolygonBuildActive = isSlabBuildActive || isZoneBuildActive;
  const isOpeningBuildActive = isDoorBuildActive || isWindowBuildActive;
  // Clear the ghost preview when the tool goes away.
  useEffect(() => {
    if (!isOpeningBuildActive && openingPreview) setOpeningPreview(null);
    // Drop the arc-block chip too -- it's only meaningful while an
    // opening tool is live.
    if (!isOpeningBuildActive && arcOpeningBlocked) setArcOpeningBlocked(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpeningBuildActive]);
  const isOpeningMoveActive = movingOpeningType !== null;
  const isOpeningPlacementActive = isOpeningBuildActive || isOpeningMoveActive;
  const floorplanOpeningLocalY = useMemo(() => {
    if (movingNode?.type === "door" || movingNode?.type === "window") {
      return snapToHalf(movingNode.position[1]);
    }

    if (isWindowBuildActive) {
      // Floorplan is top-down, so new windows need an explicit wall-local height.
      return snapToHalf(FLOORPLAN_DEFAULT_WINDOW_LOCAL_Y);
    }

    return 0;
  }, [isWindowBuildActive, movingNode]);
  const isMarqueeSelectionToolActive =
    mode === "select" &&
    floorplanSelectionTool === "marquee" &&
    !movingNode &&
    structureLayer !== "zones";
  const canSelectElementFloorplanGeometry =
    (mode === "select" || mode === "delete") &&
    floorplanSelectionTool === "click" &&
    !movingNode;
  // 2026-07-28: disable guide interactions while a calibration is in
  // flight. Otherwise the guide image is a large SVG rect that catches
  // clicks BEFORE the wall/background handlers, so the user's 2-point
  // reference clicks get swallowed by "select this guide". Turning
  // interactions off makes the guide render-only during calibration.
  const canInteractWithGuides =
    showGuides && canSelectElementFloorplanGeometry && !calibration;
  // Ritn3D 2026-07-27: zones are always selectable in select mode.
  // Was gated on structureLayer === 'zones' but the layer picker is
  // hidden in minimal launch mode, so users could see auto-detected
  // zones but never click them to change the room type.
  const canSelectFloorplanZones =
    mode === "select" && floorplanSelectionTool === "click" && !movingNode;
  // Ritn3D: always show site boundary so users can see plot while drawing
  const visibleSitePolygon = displaySitePolygon;
  const shouldShowSiteBoundaryHandles =
    isSiteEditActive && visibleSitePolygon !== null;
  // 2026-08-01: retired. Wall endpoint handles are now per-wall (hover or
  // selection) rather than shown for every wall at once — see the
  // wallEndpointHandles memo for why.
  const shouldShowSlabBoundaryHandles =
    mode === "select" &&
    !movingNode &&
    floorplanSelectionTool === "click" &&
    selectedSlabEntry !== null;
  const shouldShowZoneBoundaryHandles =
    canSelectFloorplanZones && selectedZoneEntry !== null;
  // Ritn3D: always show room/zone labels for context
  const showZonePolygons = phase === "structure";
  const visibleZonePolygons = useMemo(
    () => (showZonePolygons ? displayZonePolygons : []),
    [displayZonePolygons, showZonePolygons],
  );
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const activeMarqueeBounds = useMemo(() => {
    if (!floorplanMarqueeState) {
      return null;
    }

    return getFloorplanSelectionBounds(
      floorplanMarqueeState.startPlanPoint,
      floorplanMarqueeState.currentPlanPoint,
    );
  }, [floorplanMarqueeState]);
  const visibleMarqueeBounds = useMemo(() => {
    if (!(floorplanMarqueeState && activeMarqueeBounds)) {
      return null;
    }

    const dragDistance = Math.hypot(
      floorplanMarqueeState.currentPlanPoint[0] -
        floorplanMarqueeState.startPlanPoint[0],
      floorplanMarqueeState.currentPlanPoint[1] -
        floorplanMarqueeState.startPlanPoint[1],
    );

    return dragDistance > 0 ? activeMarqueeBounds : null;
  }, [activeMarqueeBounds, floorplanMarqueeState]);
  const visibleSvgMarqueeBounds = useMemo(() => {
    if (!visibleMarqueeBounds) {
      return null;
    }

    return toSvgSelectionBounds(visibleMarqueeBounds);
  }, [visibleMarqueeBounds]);
  const wallEndpointHandles = useMemo(() => {
    if (isOpeningPlacementActive || movingNode) {
      return [];
    }

    return displayWallPolygons.flatMap(({ wall }) => {
      const isSelected = selectedIdSet.has(wall.id);
      // Ritn3D 2026-08-01: endpoint handles follow the wall you're actually
      // on, instead of every wall at once.
      //
      // Each handle's hit target is r≈0.14 plus an 18px non-scaling stroke,
      // and handles render ABOVE the walls. Showing them persistently put two
      // large targets on every wall — 62 of them on a 31-wall plan — and on a
      // short wall the two ends' hit areas overlap and cover the whole
      // segment. The wall body then can't be clicked at all: the handle eats
      // it. A user hit exactly this ("some walls are only selected when I
      // click on those dots") after importing a detected plan.
      //
      // Hover is enough to bring them back, so dragging an endpoint still
      // takes one motion — move onto the wall, grab the dot. Selected walls
      // and active drafts keep theirs regardless, and wall-build mode still
      // shows all of them for snapping.
      const isVisible =
        isWallBuildActive ||
        isSelected ||
        hoveredWallId === wall.id ||
        wallEndpointDraft?.wallId === wall.id;
      if (!isVisible) {
        return [];
      }

      return (["start", "end"] as const).map((endpoint) => ({
        wall,
        endpoint,
        point: endpoint === "start" ? wall.start : wall.end,
        isSelected,
        isActive:
          wallEndpointDraft?.wallId === wall.id &&
          wallEndpointDraft.endpoint === endpoint,
      }));
    });
  }, [
    displayWallPolygons,
    hoveredWallId,
    isOpeningPlacementActive,
    isWallBuildActive,
    movingNode,
    selectedIdSet,
    wallEndpointDraft,
  ]);
  // Bulge handles. One per selected wall. Sits at the arc apex when
  // bulge != 0, at chord midpoint when straight (drag perpendicular to
  // convert a straight wall into a curve).
  //
  // Visible in: select mode (Pascal default) OR arc-wall build mode (so the
  // wall the user JUST placed with the Arc Wall tool shows its bulge handle
  // and they can immediately bend it — the whole point of the redesign).
  // Hidden during opening placement / moving to avoid handle clutter.
  const wallBulgeHandles = useMemo(() => {
    if (isOpeningPlacementActive || movingNode) return [];
    const allowed = mode === "select" || tool === "arc-wall";
    if (!allowed) return [];
    return displayWallPolygons.flatMap(({ wall }) => {
      if (!selectedIdSet.has(wall.id)) return [];
      const liveBulge =
        wallBulgeDraft?.wallId === wall.id
          ? wallBulgeDraft.bulge
          : (wall.bulge ?? 0);
      const point = arcMidpoint(wall.start, wall.end, liveBulge);
      return [
        {
          wall,
          point: point as WallPlanPoint,
          isActive: wallBulgeDraft?.wallId === wall.id,
        },
      ];
    });
  }, [
    displayWallPolygons,
    isOpeningPlacementActive,
    mode,
    movingNode,
    selectedIdSet,
    tool,
    wallBulgeDraft,
  ]);
  const slabVertexHandles = useMemo(() => {
    if (!shouldShowSlabBoundaryHandles) {
      return [];
    }

    // Raw corners — the display polygon is tessellated, and a curved slab
    // would otherwise sprout a drag handle on every arc sample.
    return selectedSlabEntry.slab.polygon
      .map(toFloorplanPolygon1)
      .map((point, vertexIndex) => ({
        nodeId: selectedSlabEntry.slab.id,
        vertexIndex,
        point: toWallPlanPoint(point),
        isActive:
          slabVertexDragState?.slabId === selectedSlabEntry.slab.id &&
          slabVertexDragState.vertexIndex === vertexIndex,
      }));
  }, [selectedSlabEntry, shouldShowSlabBoundaryHandles, slabVertexDragState]);
  const slabMidpointHandles = useMemo(() => {
    if (!(shouldShowSlabBoundaryHandles && !slabVertexDragState)) {
      return [];
    }

    return selectedSlabEntry.slab.polygon
      .map(toFloorplanPolygon1)
      .map((point, edgeIndex, polygon) => {
        const nextPoint = polygon[(edgeIndex + 1) % polygon.length];
        return {
          nodeId: selectedSlabEntry.slab.id,
          edgeIndex,
          point: [
            (point.x + (nextPoint?.x ?? point.x)) / 2,
            (point.y + (nextPoint?.y ?? point.y)) / 2,
          ] as WallPlanPoint,
        };
      });
  }, [selectedSlabEntry, shouldShowSlabBoundaryHandles, slabVertexDragState]);
  const siteVertexHandles = useMemo(() => {
    if (!(shouldShowSiteBoundaryHandles && visibleSitePolygon)) {
      return [];
    }

    return visibleSitePolygon.polygon.map((point, vertexIndex) => ({
      nodeId: visibleSitePolygon.site.id,
      vertexIndex,
      point: toWallPlanPoint(point),
      isActive:
        siteVertexDragState?.siteId === visibleSitePolygon.site.id &&
        siteVertexDragState.vertexIndex === vertexIndex,
    }));
  }, [shouldShowSiteBoundaryHandles, siteVertexDragState, visibleSitePolygon]);
  const siteMidpointHandles = useMemo(() => {
    if (!(
      shouldShowSiteBoundaryHandles &&
      visibleSitePolygon &&
      !siteVertexDragState
    )) {
      return [];
    }

    return visibleSitePolygon.polygon.map((point, edgeIndex, polygon) => {
      const nextPoint = polygon[(edgeIndex + 1) % polygon.length];
      return {
        nodeId: visibleSitePolygon.site.id,
        edgeIndex,
        point: [
          (point.x + (nextPoint?.x ?? point.x)) / 2,
          (point.y + (nextPoint?.y ?? point.y)) / 2,
        ] as WallPlanPoint,
      };
    });
  }, [shouldShowSiteBoundaryHandles, siteVertexDragState, visibleSitePolygon]);
  const zoneVertexHandles = useMemo(() => {
    if (!shouldShowZoneBoundaryHandles) {
      return [];
    }

    return selectedZoneEntry.polygon.map((point, vertexIndex) => ({
      nodeId: selectedZoneEntry.zone.id,
      vertexIndex,
      point: toWallPlanPoint(point),
      isActive:
        zoneVertexDragState?.zoneId === selectedZoneEntry.zone.id &&
        zoneVertexDragState.vertexIndex === vertexIndex,
    }));
  }, [selectedZoneEntry, shouldShowZoneBoundaryHandles, zoneVertexDragState]);
  const zoneMidpointHandles = useMemo(() => {
    if (!(shouldShowZoneBoundaryHandles && !zoneVertexDragState)) {
      return [];
    }

    return selectedZoneEntry.polygon.map((point, edgeIndex, polygon) => {
      const nextPoint = polygon[(edgeIndex + 1) % polygon.length];
      return {
        nodeId: selectedZoneEntry.zone.id,
        edgeIndex,
        point: [
          (point.x + (nextPoint?.x ?? point.x)) / 2,
          (point.y + (nextPoint?.y ?? point.y)) / 2,
        ] as WallPlanPoint,
      };
    });
  }, [selectedZoneEntry, shouldShowZoneBoundaryHandles, zoneVertexDragState]);

  const draftPolygon = useMemo(() => {
    // Arc-wall draft preview. Phase 1: straight preview start->cursor (no
    // bulge yet). Phase 2: actual curved preview with live bulge derived from
    // the cursor's perpendicular offset to the chord.
    if (levelId && arcDraftStart) {
      const previewEnd = arcDraftEnd ?? cursorPoint ?? arcDraftStart;
      if (!isWallLongEnough(arcDraftStart, previewEnd)) {
        return null;
      }
      let previewBulge = 0;
      if (arcDraftEnd && arcBulgePoint) {
        const raw = bulgeFromThreePoints(
          arcDraftStart,
          arcDraftEnd,
          arcBulgePoint,
        );
        previewBulge = Math.max(-2, Math.min(2, raw));
      }
      const draftWall = getFloorplanWall(
        buildDraftWall(levelId, arcDraftStart, previewEnd, previewBulge),
      );
      return getWallPlanFootprint(draftWall, EMPTY_WALL_MITER_DATA);
    }

    if (!(
      levelId &&
      draftStart &&
      draftEnd &&
      isWallLongEnough(draftStart, draftEnd)
    )) {
      return null;
    }

    const draftWall = getFloorplanWall(
      buildDraftWall(levelId, draftStart, draftEnd),
    );
    // Keep the live draft preview cheap; full level-wide mitering here runs on every mouse move.
    return getWallPlanFootprint(draftWall, EMPTY_WALL_MITER_DATA);
  }, [
    arcBulgePoint,
    arcDraftEnd,
    arcDraftStart,
    cursorPoint,
    draftEnd,
    draftStart,
    levelId,
  ]);
  const draftPolygonPoints = useMemo(
    () => (draftPolygon ? formatPolygonPoints(draftPolygon) : null),
    [draftPolygon],
  );
  const activePolygonDraftPoints = useMemo(() => {
    if (isZoneBuildActive) {
      return zoneDraftPoints;
    }

    if (isSlabBuildActive) {
      return slabDraftPoints;
    }

    return [] as WallPlanPoint[];
  }, [isSlabBuildActive, isZoneBuildActive, slabDraftPoints, zoneDraftPoints]);
  const polygonDraftPolylinePoints = useMemo(() => {
    if (!(
      isPolygonBuildActive &&
      cursorPoint &&
      activePolygonDraftPoints.length > 0
    )) {
      return null;
    }

    return formatPolygonPoints([
      ...activePolygonDraftPoints.map(toPoint2D),
      toPoint2D(cursorPoint),
    ]);
  }, [activePolygonDraftPoints, cursorPoint, isPolygonBuildActive]);
  const polygonDraftPolygonPoints = useMemo(() => {
    if (!(
      isPolygonBuildActive &&
      cursorPoint &&
      activePolygonDraftPoints.length >= 2
    )) {
      return null;
    }

    return formatPolygonPoints([
      ...activePolygonDraftPoints.map(toPoint2D),
      toPoint2D(cursorPoint),
    ]);
  }, [activePolygonDraftPoints, cursorPoint, isPolygonBuildActive]);
  const polygonDraftClosingSegment = useMemo(() => {
    if (!(
      isPolygonBuildActive &&
      cursorPoint &&
      activePolygonDraftPoints.length >= 2
    )) {
      return null;
    }

    const firstPoint = activePolygonDraftPoints[0];
    if (!firstPoint) {
      return null;
    }

    return {
      x1: toSvgX(cursorPoint[0]),
      y1: toSvgY(cursorPoint[1]),
      x2: toSvgX(firstPoint[0]),
      y2: toSvgY(firstPoint[1]),
    };
  }, [activePolygonDraftPoints, cursorPoint, isPolygonBuildActive]);

  const svgAspectRatio = surfaceSize.width / surfaceSize.height || 1;

  const fittedViewport = useMemo(() => {
    // Ritn3D 2026-06-18: include guide images in the fit bounds so the
    // 'reset view' shortcut + the auto-zoom-after-upload both frame the
    // plan trace. Width-as-diameter is a conservative square bound — we
    // don't know the image aspect ratio at fit time without loading the
    // bitmap, so use the longer-dimension fallback (width for landscape
    // images, height ≥ width for portrait).
    const guideCornerPoints: Point2D[] = levelGuides.flatMap((g) => {
      if (!g.visible || g.opacity <= 0 || g.scale <= 0) return [];
      const w = getGuideWidth(g.scale);
      const cx = g.position[0];
      const cy = g.position[2];
      const half = w / 2;
      return [
        { x: cx - half, y: cy - half },
        { x: cx + half, y: cy - half },
        { x: cx + half, y: cy + half },
        { x: cx - half, y: cy + half },
      ];
    });
    const allPoints = [
      ...(visibleSitePolygon ? visibleSitePolygon.polygon : []),
      ...displaySlabPolygons.flatMap((entry) => entry.polygon),
      ...visibleZonePolygons.flatMap((entry) => entry.polygon),
      ...wallPolygons.flatMap((entry) => entry.polygon),
      ...guideCornerPoints,
    ];

    if (allPoints.length === 0) {
      return {
        centerX: 0,
        centerY: 0,
        width: Math.max(
          FALLBACK_VIEW_SIZE,
          FALLBACK_VIEW_SIZE * svgAspectRatio,
        ),
      };
    }

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const point of allPoints) {
      const svgPoint = toSvgPoint(point);
      minX = Math.min(minX, svgPoint.x);
      maxX = Math.max(maxX, svgPoint.x);
      minY = Math.min(minY, svgPoint.y);
      maxY = Math.max(maxY, svgPoint.y);
    }

    const rawWidth = maxX - minX;
    const rawHeight = maxY - minY;
    const paddedWidth = rawWidth + FLOORPLAN_PADDING * 2;
    const paddedHeight = rawHeight + FLOORPLAN_PADDING * 2;
    const width = Math.max(
      FALLBACK_VIEW_SIZE,
      paddedWidth,
      paddedHeight * svgAspectRatio,
    );
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    return {
      centerX,
      centerY,
      width,
    };
  }, [
    displaySlabPolygons,
    levelGuides,
    svgAspectRatio,
    visibleSitePolygon,
    visibleZonePolygons,
    wallPolygons,
  ]);

  useEffect(() => {
    const host = viewportHostRef.current;
    if (!host) {
      return;
    }

    const updateSize = () => {
      const rect = host.getBoundingClientRect();
      setSurfaceSize({
        width: Math.max(rect.width, 1),
        height: Math.max(rect.height, 1),
      });
    };

    updateSize();

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(host);
    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const currentBounds = getViewportBounds();
    const persistedRect = readPersistedPanelLayout(currentBounds);
    setPanelRect(persistedRect ?? getInitialPanelRect(currentBounds));
    panelBoundsRef.current = currentBounds;
    setIsPanelReady(true);
  }, []);

  useEffect(() => {
    const handleWindowResize = () => {
      const nextBounds = getViewportBounds();
      const previousBounds = panelBoundsRef.current ?? nextBounds;
      setPanelRect((currentRect) =>
        adaptPanelRectToBounds(currentRect, previousBounds, nextBounds),
      );
      panelBoundsRef.current = nextBounds;
    };

    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, []);

  useEffect(() => {
    if (!isPanelReady) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const currentBounds = panelBoundsRef.current ?? getViewportBounds();
      writePersistedPanelLayout({
        rect: panelRect,
        viewport: currentBounds,
      });
    }, 120);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isPanelReady, panelRect]);

  useEffect(() => {
    const levelChanged = previousLevelIdRef.current !== (levelId ?? null);

    if (levelChanged) {
      previousLevelIdRef.current = levelId ?? null;
      hasUserAdjustedViewportRef.current = false;
      setViewport(fittedViewport);
      return;
    }

    if (!hasUserAdjustedViewportRef.current) {
      setViewport(fittedViewport);
    }
  }, [fittedViewport, levelId]);

  // Ritn3D: listen for reset view event from sidebar
  useEffect(() => {
    const handler = () => setViewport(fittedViewport);
    emitter.on("floorplan:reset-view" as any, handler);
    return () => {
      emitter.off("floorplan:reset-view" as any, handler);
    };
  }, [fittedViewport]);

  useEffect(() => {
    if (!(
      phase === "site" &&
      levelNode?.type === "level" &&
      levelNode.level > 0
    )) {
      return;
    }

    setPhase("structure");
  }, [levelNode, phase, setPhase]);

  const viewBox = useMemo(() => {
    const currentViewport = viewport ?? fittedViewport;
    const width = currentViewport.width;
    const height = width / svgAspectRatio;

    return {
      minX: currentViewport.centerX - width / 2,
      minY: currentViewport.centerY - height / 2,
      width,
      height,
    };
  }, [fittedViewport, svgAspectRatio, viewport]);

  // Ritn3D: update measurement scale based on visible area
  setMeasureScale(viewBox.width);

  const floorplanWorldUnitsPerPixel = useMemo(() => {
    const widthUnitsPerPixel = viewBox.width / Math.max(surfaceSize.width, 1);
    const heightUnitsPerPixel =
      viewBox.height / Math.max(surfaceSize.height, 1);

    return (widthUnitsPerPixel + heightUnitsPerPixel) / 2;
  }, [surfaceSize.height, surfaceSize.width, viewBox.height, viewBox.width]);
  /* One curve handle per edge of the selected floor, dragged perpendicular
     to bow that edge — the same gesture a selected wall already uses.

     Position needs care: the edge midpoint is already taken by the
     insert-vertex handle. On a curved edge the arc midpoint is naturally
     clear of it, so use that. On a straight edge the two coincide, so the
     handle is pushed out along the edge normal by a fixed SCREEN distance —
     constant separation at every zoom, and the moment a drag starts the
     handle becomes the true arc midpoint and sits under the cursor. */
  const slabBulgeHandles = useMemo(() => {
    if (!shouldShowSlabBoundaryHandles || slabVertexDragState) {
      return [];
    }

    const corners = selectedSlabEntry.slab.polygon;
    if (corners.length < 3) return [];
    const stored = selectedSlabEntry.slab.bulges ?? [];
    const clearance = floorplanWorldUnitsPerPixel * 14;

    const outlineHandles = corners.map((start, edgeIndex) => {
      const end = corners[(edgeIndex + 1) % corners.length]!;
      const isDragging =
        slabBulgeDraft?.slabId === selectedSlabEntry.slab.id &&
        slabBulgeDraft.edgeIndex === edgeIndex;
      const bulge = isDragging
        ? slabBulgeDraft.bulge
        : (stored[edgeIndex] ?? 0);

      let point: [number, number];
      if (isStraight(bulge)) {
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const len = Math.hypot(dx, dy) || 1;
        point = [
          (start[0] + end[0]) / 2 - (dy / len) * clearance,
          (start[1] + end[1]) / 2 + (dx / len) * clearance,
        ];
      } else {
        point = arcMidpoint(start, end, bulge) as [number, number];
      }

      return {
        nodeId: selectedSlabEntry.slab.id,
        holeIndex: null as number | null,
        edgeIndex,
        point: point as WallPlanPoint,
        isActive: isDragging,
      };
    });

    /* Same handle on every hole edge, so a stairwell opening can be curved
       exactly like the floor outline. Offset uses the ring's own normal, so
       on a hole the handle sits OUTSIDE the cut rather than in the middle of
       it where the move-grab area already lives. */
    const holeHandles = (selectedSlabEntry.slab.holes ?? []).flatMap(
      (hole, holeIndex) => {
        if (hole.length < 3) return [];
        const hb = selectedSlabEntry.slab.holeBulges?.[holeIndex] ?? [];
        return hole.map((start, edgeIndex) => {
          const end = hole[(edgeIndex + 1) % hole.length]!;
          const isDragging =
            slabBulgeDraft?.slabId === selectedSlabEntry.slab.id &&
            slabBulgeDraft.holeIndex === holeIndex &&
            slabBulgeDraft.edgeIndex === edgeIndex;
          const bulge = isDragging
            ? slabBulgeDraft.bulge
            : (hb[edgeIndex] ?? 0);
          let point: [number, number];
          if (isStraight(bulge)) {
            const dx = end[0] - start[0];
            const dy = end[1] - start[1];
            const len = Math.hypot(dx, dy) || 1;
            point = [
              (start[0] + end[0]) / 2 - (dy / len) * clearance,
              (start[1] + end[1]) / 2 + (dx / len) * clearance,
            ];
          } else {
            point = arcMidpoint(start, end, bulge) as [number, number];
          }
          return {
            nodeId: selectedSlabEntry.slab.id,
            holeIndex: holeIndex as number | null,
            edgeIndex,
            point: point as WallPlanPoint,
            isActive: isDragging,
          };
        });
      },
    );

    return [...outlineHandles, ...holeHandles];
  }, [
    floorplanWorldUnitsPerPixel,
    selectedSlabEntry,
    shouldShowSlabBoundaryHandles,
    slabBulgeDraft,
    slabVertexDragState,
  ]);
  /* Corner handles for every floor cut on the selected slab. Shown without
     going through the panel's "edit" button — a cut you can see is a cut you
     should be able to grab. */
  const slabHoleHandles = useMemo(() => {
    if (!shouldShowSlabBoundaryHandles || slabVertexDragState) return [];
    const slab = selectedSlabEntry.slab;
    return (slab.holes ?? []).flatMap((hole, holeIndex) => {
      const live =
        slabHoleDraft?.slabId === slab.id &&
        slabHoleDraft.holeIndex === holeIndex
          ? slabHoleDraft.ring
          : hole;
      return live.map((pt, vertexIndex) => ({
        slabId: slab.id,
        holeIndex,
        vertexIndex,
        point: [pt[0], pt[1]] as WallPlanPoint,
      }));
      // Curve handles for hole edges are emitted separately below, so a hole
      // corner and its curve handle never fight for the same pointer.
    });
  }, [
    selectedSlabEntry,
    shouldShowSlabBoundaryHandles,
    slabHoleDraft,
    slabVertexDragState,
  ]);

  const floorplanWallHitTolerance = useMemo(
    () => floorplanWorldUnitsPerPixel * (FLOORPLAN_WALL_HIT_STROKE_WIDTH / 2),
    [floorplanWorldUnitsPerPixel],
  );
  const floorplanOpeningHitTolerance = useMemo(
    () =>
      floorplanWorldUnitsPerPixel * (FLOORPLAN_OPENING_HIT_STROKE_WIDTH / 2),
    [floorplanWorldUnitsPerPixel],
  );
  const selectedOpeningActionMenuPosition = useMemo(() => {
    if (!selectedOpeningEntry) {
      return null;
    }

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const point of selectedOpeningEntry.polygon) {
      const svgPoint = toSvgPoint(point);
      minX = Math.min(minX, svgPoint.x);
      maxX = Math.max(maxX, svgPoint.x);
      minY = Math.min(minY, svgPoint.y);
      maxY = Math.max(maxY, svgPoint.y);
    }

    if (!(
      Number.isFinite(minX) &&
      Number.isFinite(maxX) &&
      Number.isFinite(minY) &&
      Number.isFinite(maxY)
    )) {
      return null;
    }

    if (
      maxX < viewBox.minX ||
      minX > viewBox.minX + viewBox.width ||
      maxY < viewBox.minY ||
      minY > viewBox.minY + viewBox.height
    ) {
      return null;
    }

    const anchorX =
      (((minX + maxX) / 2 - viewBox.minX) / viewBox.width) * surfaceSize.width;
    const anchorY =
      ((minY - viewBox.minY) / viewBox.height) * surfaceSize.height;

    return {
      x: Math.min(
        Math.max(anchorX, FLOORPLAN_ACTION_MENU_HORIZONTAL_PADDING),
        surfaceSize.width - FLOORPLAN_ACTION_MENU_HORIZONTAL_PADDING,
      ),
      y: Math.max(anchorY, FLOORPLAN_ACTION_MENU_MIN_ANCHOR_Y),
    };
  }, [selectedOpeningEntry, surfaceSize.height, surfaceSize.width, viewBox]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset hovered corner when selected guide changes
  useEffect(() => {
    setHoveredGuideCorner(null);
  }, [selectedGuide?.id]);

  useEffect(() => {
    if (!(selectedGuide && showGuides && canInteractWithGuides)) {
      setHoveredGuideCorner(null);
    }
  }, [canInteractWithGuides, selectedGuide, showGuides]);

  const guideHandleHintAnchor = useMemo<GuideHandleHintAnchor | null>(() => {
    if (!(
      hoveredGuideCorner &&
      selectedGuide &&
      selectedGuideDimensions &&
      surfaceSize.width > 0 &&
      surfaceSize.height > 0 &&
      viewBox.width > 0 &&
      viewBox.height > 0
    )) {
      return null;
    }

    const aspectRatio =
      selectedGuideDimensions.width / selectedGuideDimensions.height;
    if (!(aspectRatio > 0)) {
      return null;
    }

    const planWidth = getGuideWidth(selectedGuide.scale);
    const planHeight = getGuideHeight(planWidth, aspectRatio);
    const centerSvg = getGuideCenterSvgPoint(selectedGuide);
    const handleSvg = getGuideCornerSvgPoint(
      centerSvg,
      planWidth,
      planHeight,
      -selectedGuide.rotation[1],
      hoveredGuideCorner,
    );

    if (
      handleSvg.x < viewBox.minX ||
      handleSvg.x > viewBox.minX + viewBox.width ||
      handleSvg.y < viewBox.minY ||
      handleSvg.y > viewBox.minY + viewBox.height
    ) {
      return null;
    }

    const centerX =
      ((centerSvg.x - viewBox.minX) / viewBox.width) * surfaceSize.width;
    const centerY =
      ((centerSvg.y - viewBox.minY) / viewBox.height) * surfaceSize.height;
    const handleX =
      ((handleSvg.x - viewBox.minX) / viewBox.width) * surfaceSize.width;
    const handleY =
      ((handleSvg.y - viewBox.minY) / viewBox.height) * surfaceSize.height;

    let directionX = handleX - centerX;
    let directionY = handleY - centerY;
    const directionLength = Math.hypot(directionX, directionY);

    if (directionLength > 0.001) {
      directionX /= directionLength;
      directionY /= directionLength;
    } else {
      directionX = 1;
      directionY = 0;
    }

    const minX = Math.min(
      FLOORPLAN_GUIDE_HANDLE_HINT_PADDING_X,
      surfaceSize.width / 2,
    );
    const maxX = Math.max(
      surfaceSize.width - FLOORPLAN_GUIDE_HANDLE_HINT_PADDING_X,
      minX,
    );
    const minY = Math.min(
      FLOORPLAN_GUIDE_HANDLE_HINT_PADDING_Y,
      surfaceSize.height / 2,
    );
    const maxY = Math.max(
      surfaceSize.height - FLOORPLAN_GUIDE_HANDLE_HINT_PADDING_Y,
      minY,
    );

    return {
      x: clamp(
        handleX + directionX * FLOORPLAN_GUIDE_HANDLE_HINT_OFFSET,
        minX,
        maxX,
      ),
      y: clamp(
        handleY + directionY * FLOORPLAN_GUIDE_HANDLE_HINT_OFFSET,
        minY,
        maxY,
      ),
      directionX,
      directionY,
    };
  }, [
    hoveredGuideCorner,
    selectedGuide,
    selectedGuideDimensions,
    surfaceSize.height,
    surfaceSize.width,
    viewBox,
  ]);

  const minViewportWidth = fittedViewport.width * MIN_VIEWPORT_WIDTH_RATIO;
  const maxViewportWidth = fittedViewport.width * MAX_VIEWPORT_WIDTH_RATIO;

  const palette = useMemo(
    () =>
      theme === "dark"
        ? {
            surface: "#0a0e1b",
            minorGrid: "#475569",
            majorGrid: "#94a3b8",
            minorGridOpacity: 0.7,
            majorGridOpacity: 0.9,
            slabFill: "#5f6483",
            slabStroke: "#71717a",
            selectedSlabFill: "#b7b5f7",
            wallFill: "#fafafa",
            wallStroke: "#38bdf8",
            wallHoverStroke: "#a1a1aa",
            selectedFill: "#8381ed",
            selectedStroke: "#8381ed",
            draftFill: "#818cf8",
            draftStroke: "#c7d2fe",
            measurementStroke: "#cbd5e1",
            // Amber. Everything else on the plan is cool — sky walls and
            // windows, indigo selection, blue-grey grid — so a warm outline
            // is the one thing that cannot be misread as part of the current
            // level. Sage was tried first and was still too easy to lose.
            ghostStroke: "#e0a33c",
            cursor: "#818cf8",
            editCursor: "#8381ed",
            anchor: "#818cf8",
            openingFill: "#0a0e1b",
            openingStroke: "#fafafa",
            doorFill: "#1a0e2e",
            doorStroke: "#f59e0b",
            windowFill: "#0a1e2e",
            windowStroke: "#38bdf8",
            endpointHandleFill: "#09090b",
            endpointHandleStroke: "#a1a1aa",
            endpointHandleHoverStroke: "#d4d4d8",
            endpointHandleActiveFill: "#8381ed",
            endpointHandleActiveStroke: "#8381ed",
          }
        : {
            surface: "#ffffff",
            minorGrid: "#94a3b8",
            majorGrid: "#475569",
            minorGridOpacity: 0.7,
            majorGridOpacity: 0.9,
            slabFill: "#c4c4cc",
            slabStroke: "#52525b",
            selectedSlabFill: "#b7b5f7",
            wallFill: "#171717",
            wallStroke: "#0284c7",
            wallHoverStroke: "#71717a",
            selectedFill: "#8381ed",
            selectedStroke: "#8381ed",
            draftFill: "#6366f1",
            draftStroke: "#4338ca",
            measurementStroke: "#334155",
            // Deeper than the dark theme's amber so it still carries on white.
            ghostStroke: "#b9791a",
            cursor: "#6366f1",
            editCursor: "#8381ed",
            anchor: "#4338ca",
            openingFill: "#ffffff",
            openingStroke: "#171717",
            doorFill: "#fef3c7",
            doorStroke: "#d97706",
            windowFill: "#e0f2fe",
            windowStroke: "#0284c7",
            endpointHandleFill: "#ffffff",
            endpointHandleStroke: "#71717a",
            endpointHandleHoverStroke: "#52525b",
            endpointHandleActiveFill: "#8381ed",
            endpointHandleActiveStroke: "#8381ed",
          },
    [theme],
  );
  const floorplanLevelLabel =
    levelNode?.type === "level"
      ? getLevelDisplayLabel(levelNode)
      : "Select a level";
  const isGroundFloorSelected =
    levelNode?.type === "level" && levelNode.level === 0;
  const isSiteEditShortcutActive = phase === "site" && mode === "edit";
  const canUseSiteEditShortcut = isGroundFloorSelected;
  const hasFloorplanLevelSwitcher = floorplanLevels.length > 1;
  const gridSteps = useMemo(
    () => getVisibleGridSteps(viewBox.width, surfaceSize.width),
    [surfaceSize.width, viewBox.width],
  );

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
  );
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
  );

  const getSvgPointFromClientPoint = useCallback(
    (clientX: number, clientY: number): SvgPoint | null => {
      const svg = svgRef.current;
      const ctm = svg?.getScreenCTM();
      if (!(svg && ctm)) {
        return null;
      }

      const screenPoint = svg.createSVGPoint();
      screenPoint.x = clientX;
      screenPoint.y = clientY;
      const transformedPoint = screenPoint.matrixTransform(ctm.inverse());

      return { x: transformedPoint.x, y: transformedPoint.y };
    },
    [],
  );

  const getPlanPointFromClientPoint = useCallback(
    (clientX: number, clientY: number): WallPlanPoint | null => {
      const svgPoint = getSvgPointFromClientPoint(clientX, clientY);
      if (!svgPoint) {
        return null;
      }

      return toPlanPointFromSvgPoint(svgPoint);
    },
    [getSvgPointFromClientPoint],
  );
  useEffect(() => {
    siteBoundaryDraftRef.current = siteBoundaryDraft;
  }, [siteBoundaryDraft]);

  useEffect(() => {
    slabBoundaryDraftRef.current = slabBoundaryDraft;
  }, [slabBoundaryDraft]);

  useEffect(() => {
    zoneBoundaryDraftRef.current = zoneBoundaryDraft;
  }, [zoneBoundaryDraft]);

  useEffect(() => {
    guideTransformDraftRef.current = guideTransformDraft;
  }, [guideTransformDraft]);

  const updateViewport = useCallback((nextViewport: FloorplanViewport) => {
    hasUserAdjustedViewportRef.current = true;
    setViewport(nextViewport);
  }, []);

  const clearGuideInteraction = useCallback(() => {
    guideInteractionRef.current = null;
    guideTransformDraftRef.current = null;
    setGuideTransformDraft(null);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  const clearLevelMenuCloseTimeout = useCallback(() => {
    if (levelMenuCloseTimeoutRef.current !== null) {
      window.clearTimeout(levelMenuCloseTimeoutRef.current);
      levelMenuCloseTimeoutRef.current = null;
    }
  }, []);

  const openLevelMenu = useCallback(() => {
    if (!hasFloorplanLevelSwitcher) {
      return;
    }

    clearLevelMenuCloseTimeout();
    setIsLevelMenuOpen(true);
  }, [clearLevelMenuCloseTimeout, hasFloorplanLevelSwitcher]);

  const scheduleLevelMenuClose = useCallback(() => {
    clearLevelMenuCloseTimeout();

    levelMenuCloseTimeoutRef.current = window.setTimeout(() => {
      setIsLevelMenuOpen(false);
      levelMenuCloseTimeoutRef.current = null;
    }, FLOORPLAN_LEVEL_MENU_CLOSE_DELAY_MS);
  }, [clearLevelMenuCloseTimeout]);

  const handleFloorplanLevelSelect = useCallback(
    (nextLevelId: string) => {
      const resolvedLevelId = nextLevelId as LevelNode["id"];

      if (currentBuildingId) {
        setSelection({
          buildingId: currentBuildingId,
          levelId: resolvedLevelId,
        });
      } else {
        setSelection({ levelId: resolvedLevelId });
      }

      clearLevelMenuCloseTimeout();
      setIsLevelMenuOpen(false);
    },
    [clearLevelMenuCloseTimeout, currentBuildingId, setSelection],
  );

  const finishPanelInteraction = useCallback(() => {
    panelInteractionRef.current = null;
    setIsDraggingPanel(false);
    setActiveResizeDirection(null);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  const beginPanelInteraction = useCallback(
    (interaction: PanelInteractionState) => {
      panelInteractionRef.current = interaction;
      if (interaction.type === "drag") {
        setIsDraggingPanel(true);
        setActiveResizeDirection(null);
        document.body.style.cursor = "grabbing";
      } else if (interaction.direction) {
        setIsDraggingPanel(false);
        setActiveResizeDirection(interaction.direction);
        document.body.style.cursor =
          resizeCursorByDirection[interaction.direction];
      }

      document.body.style.userSelect = "none";
    },
    [],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const interaction = panelInteractionRef.current;
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
      }

      event.preventDefault();

      const dx = event.clientX - interaction.startClientX;
      const dy = event.clientY - interaction.startClientY;
      const bounds = getViewportBounds();

      const nextRect =
        interaction.type === "drag"
          ? movePanelRect(interaction.initialRect, dx, dy, bounds)
          : resizePanelRect(
              interaction.initialRect,
              interaction.direction ?? "se",
              dx,
              dy,
              bounds,
            );

      setPanelRect(nextRect);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const interaction = panelInteractionRef.current;
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
      }

      finishPanelInteraction();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [finishPanelInteraction]);

  useEffect(() => {
    return () => {
      finishPanelInteraction();
    };
  }, [finishPanelInteraction]);

  useEffect(() => {
    return () => {
      clearLevelMenuCloseTimeout();
    };
  }, [clearLevelMenuCloseTimeout]);

  useEffect(() => {
    const interaction = guideInteractionRef.current;
    if (interaction && !guideById.has(interaction.guideId)) {
      clearGuideInteraction();
    }
  }, [clearGuideInteraction, guideById]);

  useEffect(() => {
    if (!canInteractWithGuides) {
      clearGuideInteraction();
    }
  }, [canInteractWithGuides, clearGuideInteraction]);

  useEffect(() => {
    return () => {
      clearGuideInteraction();
    };
  }, [clearGuideInteraction]);

  useEffect(() => {
    if (!hasFloorplanLevelSwitcher) {
      setIsLevelMenuOpen(false);
    }
  }, [hasFloorplanLevelSwitcher]);

  const handlePanelDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-floorplan-panel-control="true"]')) {
        return;
      }

      event.preventDefault();

      beginPanelInteraction({
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        initialRect: panelRect,
        type: "drag",
      });
    },
    [beginPanelInteraction, panelRect],
  );

  const handleResizeStart = useCallback(
    (direction: ResizeDirection, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      beginPanelInteraction({
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        initialRect: panelRect,
        type: "resize",
        direction,
      });
    },
    [beginPanelInteraction, panelRect],
  );

  const zoomViewportAtClientPoint = useCallback(
    (clientX: number, clientY: number, widthFactor: number) => {
      if (!Number.isFinite(widthFactor) || widthFactor <= 0) {
        return;
      }

      const svgPoint = getSvgPointFromClientPoint(clientX, clientY);
      if (!svgPoint) {
        return;
      }

      const currentViewport = viewport ?? fittedViewport;
      const currentViewBox = viewBox;
      const nextWidth = Math.min(
        maxViewportWidth,
        Math.max(minViewportWidth, currentViewport.width * widthFactor),
      );
      const nextHeight = nextWidth / svgAspectRatio;
      const normalizedX =
        (svgPoint.x - currentViewBox.minX) / currentViewBox.width;
      const normalizedY =
        (svgPoint.y - currentViewBox.minY) / currentViewBox.height;
      const nextMinX = svgPoint.x - normalizedX * nextWidth;
      const nextMinY = svgPoint.y - normalizedY * nextHeight;

      updateViewport({
        centerX: nextMinX + nextWidth / 2,
        centerY: nextMinY + nextHeight / 2,
        width: nextWidth,
      });
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
  );

  const clearWallPlacementDraft = useCallback(() => {
    setDraftStart(null);
    setDraftEnd(null);
    // Arc-wall draft shares the "wall placement" lifecycle — same Escape /
    // tool-switch / commit semantics, so we clear it in the same callback.
    setArcDraftStart(null);
    setArcDraftEnd(null);
    setArcBulgePoint(null);
  }, []);
  const clearSlabPlacementDraft = useCallback(() => {
    setSlabDraftPoints([]);
  }, []);
  const clearZonePlacementDraft = useCallback(() => {
    setZoneDraftPoints([]);
  }, []);

  const clearWallEndpointDrag = useCallback(() => {
    wallEndpointDragRef.current = null;
    setWallEndpointDraft(null);
    setHoveredEndpointId(null);
  }, []);
  const clearWallBulgeDrag = useCallback(() => {
    wallBulgeDragRef.current = null;
    setWallBulgeDraft(null);
  }, []);
  const clearSiteBoundaryInteraction = useCallback(() => {
    setSiteVertexDragState(null);
    setSiteBoundaryDraft(null);
    setHoveredSiteHandleId(null);
  }, []);
  const clearSlabBoundaryInteraction = useCallback(() => {
    setSlabVertexDragState(null);
    setSlabBoundaryDraft(null);
    setHoveredSlabHandleId(null);
  }, []);
  const clearZoneBoundaryInteraction = useCallback(() => {
    setZoneVertexDragState(null);
    setZoneBoundaryDraft(null);
    setHoveredZoneHandleId(null);
  }, []);

  const clearDraft = useCallback(() => {
    clearWallPlacementDraft();
    clearSlabPlacementDraft();
    clearZonePlacementDraft();
    clearWallEndpointDrag();
    clearSiteBoundaryInteraction();
    clearSlabBoundaryInteraction();
    clearZoneBoundaryInteraction();
    setCursorPoint(null);
  }, [
    clearSiteBoundaryInteraction,
    clearSlabBoundaryInteraction,
    clearSlabPlacementDraft,
    clearZoneBoundaryInteraction,
    clearWallEndpointDrag,
    clearWallPlacementDraft,
    clearZonePlacementDraft,
  ]);

  useEffect(() => {
    if (isWallBuildActive || isPolygonBuildActive) {
      return;
    }

    clearDraft();
  }, [clearDraft, isPolygonBuildActive, isWallBuildActive]);

  useEffect(() => {
    const handleCancel = () => {
      clearDraft();
    };

    emitter.on("tool:cancel", handleCancel);
    return () => {
      emitter.off("tool:cancel", handleCancel);
    };
  }, [clearDraft]);

  const createSlabOnCurrentLevel = useCallback(
    (points: WallPlanPoint[]) => {
      if (!levelId) {
        return null;
      }

      /* Cut mode: the ring just drawn becomes a HOLE in the armed slab
         rather than a new floor.

         This check lives here, not at the call sites, because a polygon can
         be finished two ways — clicking back on the first point, or
         double-click/Enter through handleSlabPlacementConfirm. It was
         originally only on the first, so closing a cut the other way drew a
         second slab on top of the floor instead of opening it. One choke
         point, one behaviour. */
      const cutting = useEditor.getState().cuttingSlabId;
      if (cutting) {
        const slab = slabById.get(cutting as SlabNode["id"]);
        if (slab) {
          updateNode(slab.id, {
            holes: [
              ...(slab.holes ?? []),
              points.map((q) => [q[0], q[1]] as [number, number]),
            ],
          });
          setSelection({ selectedIds: [slab.id] });
          sfxEmitter.emit("sfx:structure-build");
        }
        useEditor.getState().setCuttingSlabId(null);
        useEditor.getState().setMode("select");
        useEditor.getState().setTool(null);
        return null;
      }

      const { createNode, nodes } = useScene.getState();
      const slabCount = Object.values(nodes).filter(
        (node) => node.type === "slab",
      ).length;
      // Ritn3D 2026-06-18: outdoor surface tools (patio/deck/driveway/...)
      // set pendingSlabSurfaceType before activating the slab tool. Read it
      // here and reset to 'interior' so a subsequent generic slab draw goes
      // back to default. Naming follows the surface so the tree shows
      // 'Patio 1', 'Driveway 1' etc.
      const pendingType = useEditor.getState().pendingSlabSurfaceType;
      const isOutdoor = pendingType !== "interior";
      const label = pendingType.charAt(0).toUpperCase() + pendingType.slice(1);
      const slab = SlabNode.parse({
        name: isOutdoor ? `${label} ${slabCount + 1}` : `Slab ${slabCount + 1}`,
        polygon: points.map(([x, z]) => [x, z] as [number, number]),
        surfaceType: pendingType,
      });

      createNode(slab, levelId);
      if (isOutdoor) useEditor.getState().setPendingSlabSurfaceType("interior");
      sfxEmitter.emit("sfx:structure-build");
      setSelection({ selectedIds: [slab.id] });
      return slab.id;
    },
    [levelId, setSelection],
  );
  const createStairOnCurrentLevel = useCallback(
    (point: WallPlanPoint) => {
      if (!levelId) {
        return null;
      }

      const { createNode, nodes } = useScene.getState();
      const stairCount = Object.values(nodes).filter(
        (node) => node.type === "stair",
      ).length;

      // Sized to THIS storey on arrival rather than dropped at a fixed
      // default. Step count is forced by the floor-to-floor height, so a
      // one-size footprint is comfortable on a 2.4 m storey and punishing on
      // a 3.6 m one — the stair would land already flagged as too steep,
      // which is a poor first impression of a constraint the user has not
      // even met yet.
      const height =
        getLevelHeight(levelId as AnyNodeId, nodes) || DEFAULT_LEVEL_HEIGHT;
      const fit = suggestStairFootprint("straight", 1.0, height);

      const stair = StairNode.parse({
        name: `Stair ${stairCount + 1}`,
        position: [point[0], point[1]] as [number, number],
        variant: "straight",
        width: 1.0,
        length: Math.round(fit.length * 100) / 100,
        depth: Math.round(fit.depth * 100) / 100,
      });

      createNode(stair, levelId);
      sfxEmitter.emit("sfx:structure-build");
      setSelection({ selectedIds: [stair.id] });
      // Straight back to select, so the panel opens on the stair just placed
      // — the footprint almost always wants adjusting, and that is the point
      // of placing it explicitly.
      useEditor.getState().setMode("select");
      useEditor.getState().setTool(null);
      return stair.id;
    },
    [levelId, setSelection],
  );
  const createZoneOnCurrentLevel = useCallback(
    (points: WallPlanPoint[]) => {
      if (!levelId) {
        return null;
      }

      const { createNode, nodes } = useScene.getState();
      const zoneCount = Object.values(nodes).filter(
        (node) => node.type === "zone",
      ).length;
      const zone = ZoneNodeSchema.parse({
        color: PALETTE_COLORS[zoneCount % PALETTE_COLORS.length],
        name: `Zone ${zoneCount + 1}`,
        polygon: points.map(([x, z]) => [x, z] as [number, number]),
      });

      createNode(zone, levelId);
      sfxEmitter.emit("sfx:structure-build");
      setSelection({ zoneId: zone.id });
      return zone.id;
    },
    [levelId, setSelection],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        setShiftPressed(true);
      }

      setRotationModifierPressed(
        event.key === "Meta" ||
          event.key === "Control" ||
          event.metaKey ||
          event.ctrlKey,
      );
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        setShiftPressed(false);
      }

      setRotationModifierPressed(event.metaKey || event.ctrlKey);
    };
    const handleBlur = () => {
      setShiftPressed(false);
      setRotationModifierPressed(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  useEffect(() => {
    const handleWindowPointerMove = (event: PointerEvent) => {
      const guideInteraction = guideInteractionRef.current;
      if (guideInteraction && event.pointerId === guideInteraction.pointerId) {
        event.preventDefault();

        const svgPoint = getSvgPointFromClientPoint(
          event.clientX,
          event.clientY,
        );
        if (!svgPoint) {
          return;
        }

        const nextDraft =
          guideInteraction.mode === "rotate"
            ? buildGuideRotationDraft(guideInteraction, svgPoint, shiftPressed)
            : guideInteraction.mode === "translate"
              ? buildGuideTranslateDraft(guideInteraction, svgPoint)
              : buildGuideResizeDraft(guideInteraction, svgPoint);

        if (
          areGuideTransformDraftsEqual(
            guideTransformDraftRef.current,
            nextDraft,
          )
        ) {
          return;
        }

        guideTransformDraftRef.current = nextDraft;
        setGuideTransformDraft(nextDraft);
        return;
      }

      // Item move drag — translate node position by the plan-coord delta
      // since pointerdown. Snap to half-meter (matches wall snap) so dropping
      // items at clean coordinates is the default.
      const itemMove = itemMoveDragRef.current;
      if (itemMove && event.pointerId === itemMove.pointerId) {
        event.preventDefault();
        const planPoint = getPlanPointFromClientPoint(
          event.clientX,
          event.clientY,
        );
        if (!planPoint) return;
        const dx = planPoint[0] - itemMove.startPlan[0];
        const dz = planPoint[1] - itemMove.startPlan[1];
        const nx = snapToHalf(itemMove.initialPos[0] + dx);
        const nz = snapToHalf(itemMove.initialPos[2] + dz);
        updateNode(itemMove.itemId as AnyNodeId, {
          position: [nx, itemMove.initialPos[1], nz],
        });
        return;
      }

      // Item rotation drag — angle from item center to cursor.
      const itemRot = itemRotateDragRef.current;
      if (itemRot && event.pointerId === itemRot.pointerId) {
        event.preventDefault();
        const planPoint = getPlanPointFromClientPoint(
          event.clientX,
          event.clientY,
        );
        if (!planPoint) return;
        const dx = planPoint[0] - itemRot.centerPlan[0];
        const dz = planPoint[1] - itemRot.centerPlan[1];
        const currentAngle = Math.atan2(dz, dx);
        let nextRotY =
          itemRot.initialRotY + (currentAngle - itemRot.startAngleFromCenter);
        // Shift = snap to 15°.
        if (shiftPressed) {
          const step = Math.PI / 12; // 15°
          nextRotY = Math.round(nextRotY / step) * step;
        }
        const node = useScene.getState().nodes[itemRot.itemId as AnyNodeId] as
          ItemNode | undefined;
        if (!node) return;
        const [rx, , rz] = node.rotation;
        updateNode(itemRot.itemId as AnyNodeId, {
          rotation: [rx, nextRotY, rz],
        });
        return;
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
      const bulgeDrag = wallBulgeDragRef.current;
      if (bulgeDrag && event.pointerId === bulgeDrag.pointerId) {
        event.preventDefault();
        const planPoint = getPlanPointFromClientPoint(
          event.clientX,
          event.clientY,
        );
        if (!planPoint) return;

        const chord = Math.hypot(
          bulgeDrag.end[0] - bulgeDrag.start[0],
          bulgeDrag.end[1] - bulgeDrag.start[1],
        );
        if (chord === 0) return;

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
        const dx = (bulgeDrag.end[0] - bulgeDrag.start[0]) / chord;
        const dy = (bulgeDrag.end[1] - bulgeDrag.start[1]) / chord;
        const vx = planPoint[0] - bulgeDrag.start[0];
        const vy = planPoint[1] - bulgeDrag.start[1];
        const cursorPerp = vx * -dy + vy * dx;

        const raw = (2 * cursorPerp) / chord;
        const next = Math.max(-1, Math.min(1, raw));
        bulgeDrag.lastBulge = next;

        setWallBulgeDraft({ wallId: bulgeDrag.wallId, bulge: next });
        return;
      }

      const dragState = wallEndpointDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      event.preventDefault();

      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) {
        return;
      }

      const snappedPoint = snapWallDraftPoint({
        point: planPoint,
        walls,
        start: dragState.fixedPoint,
        angleSnap: orthoActive,
        freehand: !snapActive,
        ignoreWallIds: [dragState.wallId],
      });

      if (pointsEqual(dragState.currentPoint, snappedPoint)) {
        return;
      }

      dragState.currentPoint = snappedPoint;
      setCursorPoint(snappedPoint);
      setWallEndpointDraft((previousDraft) => {
        const nextDraft = buildWallEndpointDraft(
          dragState.wallId,
          dragState.endpoint,
          dragState.fixedPoint,
          snappedPoint,
        );

        if (!(
          previousDraft &&
          pointsEqual(previousDraft.start, nextDraft.start) &&
          pointsEqual(previousDraft.end, nextDraft.end)
        )) {
          sfxEmitter.emit("sfx:grid-snap");
        }

        return nextDraft;
      });
    };

    const commitGuideInteraction = (event: PointerEvent) => {
      const interaction = guideInteractionRef.current;
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
      }

      event.preventDefault();

      const guide = guideById.get(interaction.guideId);
      if (!guide) {
        clearGuideInteraction();
        return;
      }

      const svgPoint = getSvgPointFromClientPoint(event.clientX, event.clientY);
      const nextDraft = svgPoint
        ? interaction.mode === "rotate"
          ? buildGuideRotationDraft(interaction, svgPoint, shiftPressed)
          : interaction.mode === "translate"
            ? buildGuideTranslateDraft(interaction, svgPoint)
            : buildGuideResizeDraft(interaction, svgPoint)
        : guideTransformDraftRef.current;

      if (nextDraft && !doesGuideMatchDraft(guide, nextDraft)) {
        updateNode(guide.id, {
          position: [
            nextDraft.position[0],
            guide.position[1],
            nextDraft.position[1],
          ] as [number, number, number],
          rotation: [
            guide.rotation[0],
            nextDraft.rotation,
            guide.rotation[2],
          ] as [number, number, number],
          scale: nextDraft.scale,
        });
      }

      clearGuideInteraction();
    };

    const cancelGuideInteraction = (event: PointerEvent) => {
      const interaction = guideInteractionRef.current;
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
      }

      clearGuideInteraction();
    };

    const commitWallEndpointDrag = (event: PointerEvent) => {
      const dragState = wallEndpointDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      const wall = wallById.get(dragState.wallId);
      if (wall) {
        const nextDraft = buildWallEndpointDraft(
          dragState.wallId,
          dragState.endpoint,
          dragState.fixedPoint,
          dragState.currentPoint,
        );
        const hasChanged = !(
          pointsEqual(nextDraft.start, wall.start) &&
          pointsEqual(nextDraft.end, wall.end)
        );

        if (hasChanged && isWallLongEnough(nextDraft.start, nextDraft.end)) {
          updateNode(wall.id, {
            start: nextDraft.start,
            end: nextDraft.end,
          });
          sfxEmitter.emit("sfx:structure-build");
        }
      }

      clearWallEndpointDrag();
      setCursorPoint(null);
    };

    const cancelWallEndpointDrag = (event: PointerEvent) => {
      const dragState = wallEndpointDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      clearWallEndpointDrag();
      setCursorPoint(null);
    };

    const commitWallBulgeDrag = (event: PointerEvent) => {
      const dragState = wallBulgeDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      const wall = wallById.get(dragState.wallId);
      if (wall) {
        const finalBulge = isStraight(dragState.lastBulge)
          ? 0
          : dragState.lastBulge;
        if ((wall.bulge ?? 0) !== finalBulge) {
          updateNode(wall.id, { bulge: finalBulge });
          sfxEmitter.emit("sfx:structure-build");
        }
      }
      setWallBulgeDraft(null);
      clearWallBulgeDrag();
    };

    const cancelWallBulgeDrag = (event: PointerEvent) => {
      const dragState = wallBulgeDragRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      clearWallBulgeDrag();
    };

    // Item move + rotate drag cleanup. Position/rotation are already updated
    // live in the move handler; this just clears the drag state so the next
    // pointer events go through the normal selection/click path.
    const clearItemMoveOrRotate = (event: PointerEvent) => {
      const m = itemMoveDragRef.current;
      if (m && event.pointerId === m.pointerId) itemMoveDragRef.current = null;
      const r = itemRotateDragRef.current;
      if (r && event.pointerId === r.pointerId)
        itemRotateDragRef.current = null;
    };

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", commitGuideInteraction);
    window.addEventListener("pointercancel", cancelGuideInteraction);
    window.addEventListener("pointerup", commitWallEndpointDrag);
    window.addEventListener("pointercancel", cancelWallEndpointDrag);
    window.addEventListener("pointerup", commitWallBulgeDrag);
    window.addEventListener("pointercancel", cancelWallBulgeDrag);
    window.addEventListener("pointerup", clearItemMoveOrRotate);
    window.addEventListener("pointercancel", clearItemMoveOrRotate);

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", commitGuideInteraction);
      window.removeEventListener("pointercancel", cancelGuideInteraction);
      window.removeEventListener("pointerup", commitWallEndpointDrag);
      window.removeEventListener("pointercancel", cancelWallEndpointDrag);
      window.removeEventListener("pointerup", commitWallBulgeDrag);
      window.removeEventListener("pointercancel", cancelWallBulgeDrag);
      window.removeEventListener("pointerup", clearItemMoveOrRotate);
      window.removeEventListener("pointercancel", clearItemMoveOrRotate);
    };
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
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: clear drag state when level changes
  useEffect(() => {
    clearWallEndpointDrag();
  }, [clearWallEndpointDrag, levelId]);

  useEffect(() => {
    if (shouldShowSiteBoundaryHandles) {
      return;
    }

    clearSiteBoundaryInteraction();
  }, [clearSiteBoundaryInteraction, shouldShowSiteBoundaryHandles]);

  useEffect(() => {
    if (shouldShowSlabBoundaryHandles) {
      return;
    }

    clearSlabBoundaryInteraction();
  }, [clearSlabBoundaryInteraction, shouldShowSlabBoundaryHandles]);

  useEffect(() => {
    if (shouldShowZoneBoundaryHandles) {
      return;
    }

    clearZoneBoundaryInteraction();
  }, [clearZoneBoundaryInteraction, shouldShowZoneBoundaryHandles]);

  useEffect(() => {
    const dragState = siteVertexDragState;
    if (!dragState) {
      return;
    }

    const handleWindowPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }

      event.preventDefault();

      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) {
        return;
      }

      const snappedPoint: WallPlanPoint = [
        snapToHalf(planPoint[0]),
        snapToHalf(planPoint[1]),
      ];
      setCursorPoint(snappedPoint);

      setSiteBoundaryDraft((currentDraft) => {
        if (!currentDraft || currentDraft.siteId !== dragState.siteId) {
          return currentDraft;
        }

        const currentPoint = currentDraft.polygon[dragState.vertexIndex];
        if (currentPoint && pointsEqual(currentPoint, snappedPoint)) {
          return currentDraft;
        }

        sfxEmitter.emit("sfx:grid-snap");

        const nextPolygon = [...currentDraft.polygon];
        nextPolygon[dragState.vertexIndex] = snappedPoint;

        return {
          ...currentDraft,
          polygon: nextPolygon,
        };
      });
    };

    const commitSiteVertexDrag = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }

      const draft = siteBoundaryDraftRef.current;
      if (
        draft &&
        site &&
        draft.siteId === site.id &&
        !polygonsEqual(draft.polygon, site.polygon?.points ?? [])
      ) {
        const suppressClick = (clickEvent: MouseEvent) => {
          clickEvent.stopImmediatePropagation();
          clickEvent.preventDefault();
          window.removeEventListener("click", suppressClick, true);
        };
        window.addEventListener("click", suppressClick, true);
        requestAnimationFrame(() => {
          window.removeEventListener("click", suppressClick, true);
        });

        updateNode(draft.siteId, {
          polygon: {
            type: "polygon",
            points: draft.polygon,
          },
        });
        sfxEmitter.emit("sfx:structure-build");
      }

      clearSiteBoundaryInteraction();
      setCursorPoint(null);
    };

    const cancelSiteVertexDrag = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }

      clearSiteBoundaryInteraction();
      setCursorPoint(null);
    };

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", commitSiteVertexDrag);
    window.addEventListener("pointercancel", cancelSiteVertexDrag);

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", commitSiteVertexDrag);
      window.removeEventListener("pointercancel", cancelSiteVertexDrag);
    };
  }, [
    clearSiteBoundaryInteraction,
    getPlanPointFromClientPoint,
    site,
    siteVertexDragState,
    updateNode,
  ]);

  useEffect(() => {
    const dragState = slabVertexDragState;
    if (!dragState) {
      return;
    }

    const handleWindowPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }

      event.preventDefault();

      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) {
        return;
      }

      const snappedPoint: WallPlanPoint = [
        snapToHalf(planPoint[0]),
        snapToHalf(planPoint[1]),
      ];
      setCursorPoint(snappedPoint);

      setSlabBoundaryDraft((currentDraft) => {
        if (!currentDraft || currentDraft.slabId !== dragState.slabId) {
          return currentDraft;
        }

        const currentPoint = currentDraft.polygon[dragState.vertexIndex];
        if (currentPoint && pointsEqual(currentPoint, snappedPoint)) {
          return currentDraft;
        }

        sfxEmitter.emit("sfx:grid-snap");

        const nextPolygon = [...currentDraft.polygon];
        nextPolygon[dragState.vertexIndex] = snappedPoint;

        return {
          ...currentDraft,
          polygon: nextPolygon,
        };
      });
    };

    const commitSlabVertexDrag = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }

      const draft = slabBoundaryDraftRef.current;
      const slab = slabById.get(dragState.slabId);
      if (draft && slab && !polygonsEqual(draft.polygon, slab.polygon)) {
        const suppressClick = (clickEvent: MouseEvent) => {
          clickEvent.stopImmediatePropagation();
          clickEvent.preventDefault();
          window.removeEventListener("click", suppressClick, true);
        };
        window.addEventListener("click", suppressClick, true);
        requestAnimationFrame(() => {
          window.removeEventListener("click", suppressClick, true);
        });

        updateNode(draft.slabId, {
          polygon: draft.polygon,
        });
        sfxEmitter.emit("sfx:structure-build");
      }

      clearSlabBoundaryInteraction();
      setCursorPoint(null);
    };

    const cancelSlabVertexDrag = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }

      clearSlabBoundaryInteraction();
      setCursorPoint(null);
    };

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", commitSlabVertexDrag);
    window.addEventListener("pointercancel", cancelSlabVertexDrag);

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", commitSlabVertexDrag);
      window.removeEventListener("pointercancel", cancelSlabVertexDrag);
    };
  }, [
    clearSlabBoundaryInteraction,
    getPlanPointFromClientPoint,
    slabById,
    slabVertexDragState,
    updateNode,
  ]);

  useEffect(() => {
    const dragState = zoneVertexDragState;
    if (!dragState) {
      return;
    }

    const handleWindowPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }

      event.preventDefault();

      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) {
        return;
      }

      const snappedPoint: WallPlanPoint = [
        snapToHalf(planPoint[0]),
        snapToHalf(planPoint[1]),
      ];
      setCursorPoint(snappedPoint);

      setZoneBoundaryDraft((currentDraft) => {
        if (!currentDraft || currentDraft.zoneId !== dragState.zoneId) {
          return currentDraft;
        }

        const currentPoint = currentDraft.polygon[dragState.vertexIndex];
        if (currentPoint && pointsEqual(currentPoint, snappedPoint)) {
          return currentDraft;
        }

        sfxEmitter.emit("sfx:grid-snap");

        const nextPolygon = [...currentDraft.polygon];
        nextPolygon[dragState.vertexIndex] = snappedPoint;

        return {
          ...currentDraft,
          polygon: nextPolygon,
        };
      });
    };

    const commitZoneVertexDrag = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }

      const draft = zoneBoundaryDraftRef.current;
      const zone = zoneById.get(dragState.zoneId);
      if (draft && zone && !polygonsEqual(draft.polygon, zone.polygon)) {
        const suppressClick = (clickEvent: MouseEvent) => {
          clickEvent.stopImmediatePropagation();
          clickEvent.preventDefault();
          window.removeEventListener("click", suppressClick, true);
        };
        window.addEventListener("click", suppressClick, true);
        requestAnimationFrame(() => {
          window.removeEventListener("click", suppressClick, true);
        });

        updateNode(draft.zoneId, {
          polygon: draft.polygon,
        });
        sfxEmitter.emit("sfx:structure-build");
      }

      clearZoneBoundaryInteraction();
      setCursorPoint(null);
    };

    const cancelZoneVertexDrag = (event: PointerEvent) => {
      if (event.pointerId !== dragState.pointerId) {
        return;
      }

      clearZoneBoundaryInteraction();
      setCursorPoint(null);
    };

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", commitZoneVertexDrag);
    window.addEventListener("pointercancel", cancelZoneVertexDrag);

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", commitZoneVertexDrag);
      window.removeEventListener("pointercancel", cancelZoneVertexDrag);
    };
  }, [
    clearZoneBoundaryInteraction,
    getPlanPointFromClientPoint,
    updateNode,
    zoneById,
    zoneVertexDragState,
  ]);

  useEffect(() => {
    return () => {
      setFloorplanHovered(false);
    };
  }, [setFloorplanHovered]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (event.button !== 2) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      panStateRef.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      setIsPanning(true);

      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const endPanning = useCallback((event?: ReactPointerEvent<SVGSVGElement>) => {
    if (
      event &&
      panStateRef.current &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    panStateRef.current = null;
    setIsPanning(false);
  }, []);

  const hoveredWallIdRef = useRef<string | null>(null);
  const emitFloorplanWallLeave = useCallback((wallId: string | null) => {
    if (!wallId) {
      return;
    }

    const wallNode = useScene.getState().nodes[wallId as AnyNodeId];
    if (!wallNode || wallNode.type !== "wall") {
      return;
    }

    emitter.emit("wall:leave", {
      node: wallNode,
      position: [0, 0, 0],
      localPosition: [0, 0, 0],
      stopPropagation: () => {},
    } as any);
  }, []);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (panStateRef.current?.pointerId === event.pointerId) {
        const deltaX = event.clientX - panStateRef.current.clientX;
        const deltaY = event.clientY - panStateRef.current.clientY;
        const worldPerPixelX = viewBox.width / surfaceSize.width;
        const worldPerPixelY = viewBox.height / surfaceSize.height;

        updateViewport({
          centerX:
            (viewport ?? fittedViewport).centerX - deltaX * worldPerPixelX,
          centerY:
            (viewport ?? fittedViewport).centerY - deltaY * worldPerPixelY,
          width: (viewport ?? fittedViewport).width,
        });

        panStateRef.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
        };
        setCursorPoint(null);
        return;
      }

      if (guideInteractionRef.current?.pointerId === event.pointerId) {
        return;
      }

      if (wallEndpointDragRef.current?.pointerId === event.pointerId) {
        return;
      }

      if (slabVertexDragState?.pointerId === event.pointerId) {
        return;
      }

      if (siteVertexDragState?.pointerId === event.pointerId) {
        return;
      }

      if (zoneVertexDragState?.pointerId === event.pointerId) {
        return;
      }

      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) {
        return;
      }

      if (isPolygonBuildActive) {
        const snappedPoint = snapPolygonDraftPoint({
          point: planPoint,
          start: activePolygonDraftPoints[activePolygonDraftPoints.length - 1],
          angleSnap: activePolygonDraftPoints.length > 0 && orthoActive,
        });

        setCursorPoint((previousPoint) => {
          const hasChanged = !(
            previousPoint && pointsEqual(previousPoint, snappedPoint)
          );
          if (hasChanged && activePolygonDraftPoints.length > 0) {
            sfxEmitter.emit("sfx:grid-snap");
          }
          return snappedPoint;
        });
        return;
      }

      if (isOpeningPlacementActive) {
        const closest = findClosestWallPoint(planPoint, walls);
        // 2026-07-27: skip preview on arc walls -- placement rejects
        // them on click, so previewing is misleading.
        // 2026-08-01: raise `arcOpeningBlocked` so the UI can EXPLAIN the
        // rejection instead of the click just doing nothing.
        if (closest && Math.abs(closest.wall.bulge ?? 0) > 1e-6) {
          if (openingPreview) setOpeningPreview(null);
          if (!arcOpeningBlocked) setArcOpeningBlocked(true);
          if (hoveredWallIdRef.current) {
            emitFloorplanWallLeave(hoveredWallIdRef.current);
            hoveredWallIdRef.current = null;
          }
          return;
        }
        if (arcOpeningBlocked) setArcOpeningBlocked(false);
        if (closest) {
          const length = arcLength(
            closest.wall.start,
            closest.wall.end,
            closest.wall.bulge ?? 0,
          );
          const distance = closest.t * length;
          const nx = closest.wall.end[1] - closest.wall.start[1];
          const nz = -(closest.wall.end[0] - closest.wall.start[0]);
          const nlen = Math.hypot(nx, nz) || 1;
          setOpeningPreview({
            wallId: closest.wall.id,
            point: [closest.point[0], closest.point[1]],
            normal: [nx / nlen, nz / nlen],
          });

          const wallEvent = {
            node: closest.wall,
            point: { x: closest.point[0], y: 0, z: closest.point[1] },
            localPosition: [distance, floorplanOpeningLocalY, 0] as [
              number,
              number,
              number,
            ],
            normal: closest.normal,
            stopPropagation: () => {},
          };

          if (hoveredWallIdRef.current !== closest.wall.id) {
            if (hoveredWallIdRef.current) {
              emitFloorplanWallLeave(hoveredWallIdRef.current);
            }
            hoveredWallIdRef.current = closest.wall.id;
            emitter.emit("wall:enter", wallEvent as any);
          } else {
            emitter.emit("wall:move", wallEvent as any);
          }
        } else {
          if (openingPreview) setOpeningPreview(null);
          if (hoveredWallIdRef.current) {
            emitFloorplanWallLeave(hoveredWallIdRef.current);
            hoveredWallIdRef.current = null;
          }
        }
        return;
      }

      // Arc-wall pointer move: phase 1 updates the end-preview the same way
      // a straight wall does; phase 2 updates the bulge midpoint (no grid snap
      // here — the bulge is a free perpendicular offset, snapping would feel
      // sticky and ugly on shallow curves).
      if (isArcWallBuildActive) {
        if (!arcDraftStart) {
          // Phase 0: just show the cursor at the snapped grid point.
          const cursor = snapPointToGrid(planPoint);
          setCursorPoint(cursor);
          return;
        }
        if (!arcDraftEnd) {
          // Phase 1: live straight-line preview from start to cursor.
          const cursor = snapWallDraftPoint({
            point: planPoint,
            walls,
            start: arcDraftStart,
            angleSnap: orthoActive,
            freehand: !snapActive,
          });
          setCursorPoint(cursor);
          return;
        }
        // Phase 2: cursor drives the bulge midpoint. No grid snap (continuous
        // adjustment); no SFX (would fire on every pixel).
        setArcBulgePoint(planPoint);
        setCursorPoint(planPoint);
        return;
      }

      if (!isWallBuildActive) {
        setCursorPoint(null);
        return;
      }

      const snappedPoint = snapWallDraftPoint({
        point: planPoint,
        walls,
        start: draftStart ?? undefined,
        angleSnap: Boolean(draftStart) && orthoActive,
        freehand: !snapActive,
      });

      setCursorPoint(snappedPoint);

      if (!draftStart) {
        return;
      }

      setDraftEnd((previousEnd) => {
        if (
          !previousEnd ||
          previousEnd[0] !== snappedPoint[0] ||
          previousEnd[1] !== snappedPoint[1]
        ) {
          sfxEmitter.emit("sfx:grid-snap");
        }

        return snappedPoint;
      });
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
      orthoActive,
      snapActive,
      surfaceSize.height,
      surfaceSize.width,
      updateViewport,
      viewBox.height,
      viewBox.width,
      viewport,
      walls,
      zoneVertexDragState,
    ],
  );

  const handleSlabPlacementPoint = useCallback(
    (point: WallPlanPoint) => {
      const lastPoint = slabDraftPoints[slabDraftPoints.length - 1];
      if (lastPoint && pointsEqual(lastPoint, point)) {
        return;
      }

      const firstPoint = slabDraftPoints[0];
      if (
        firstPoint &&
        slabDraftPoints.length >= 3 &&
        isPointNearPlanPoint(point, firstPoint)
      ) {
        createSlabOnCurrentLevel(slabDraftPoints);
        clearDraft();
        return;
      }

      setSlabDraftPoints((currentPoints) => [...currentPoints, point]);
      setCursorPoint(point);
    },
    [
      clearDraft,
      createSlabOnCurrentLevel,
      setSelection,
      slabById,
      slabDraftPoints,
      updateNode,
    ],
  );
  const handleSlabPlacementConfirm = useCallback(
    (point?: WallPlanPoint) => {
      const firstPoint = slabDraftPoints[0];
      const lastPoint = slabDraftPoints[slabDraftPoints.length - 1];

      let nextPoints = slabDraftPoints;
      if (point) {
        const isClosingExistingPolygon = Boolean(
          firstPoint &&
          slabDraftPoints.length >= 3 &&
          isPointNearPlanPoint(point, firstPoint),
        );
        const isDuplicatePoint = Boolean(
          lastPoint && pointsEqual(lastPoint, point),
        );

        if (!(isClosingExistingPolygon || isDuplicatePoint)) {
          nextPoints = [...slabDraftPoints, point];
        }
      }

      if (nextPoints.length < 3) {
        return;
      }

      createSlabOnCurrentLevel(nextPoints);
      clearDraft();
    },
    [clearDraft, createSlabOnCurrentLevel, slabDraftPoints],
  );
  const handleZonePlacementPoint = useCallback(
    (point: WallPlanPoint) => {
      const lastPoint = zoneDraftPoints[zoneDraftPoints.length - 1];
      if (lastPoint && pointsEqual(lastPoint, point)) {
        return;
      }

      const firstPoint = zoneDraftPoints[0];
      if (
        firstPoint &&
        zoneDraftPoints.length >= 3 &&
        isPointNearPlanPoint(point, firstPoint)
      ) {
        createZoneOnCurrentLevel(zoneDraftPoints);
        clearDraft();
        return;
      }

      setZoneDraftPoints((currentPoints) => [...currentPoints, point]);
      setCursorPoint(point);
    },
    [clearDraft, createZoneOnCurrentLevel, zoneDraftPoints],
  );
  const handleZonePlacementConfirm = useCallback(
    (point?: WallPlanPoint) => {
      const firstPoint = zoneDraftPoints[0];
      const lastPoint = zoneDraftPoints[zoneDraftPoints.length - 1];

      let nextPoints = zoneDraftPoints;
      if (point) {
        const isClosingExistingPolygon = Boolean(
          firstPoint &&
          zoneDraftPoints.length >= 3 &&
          isPointNearPlanPoint(point, firstPoint),
        );
        const isDuplicatePoint = Boolean(
          lastPoint && pointsEqual(lastPoint, point),
        );

        if (!(isClosingExistingPolygon || isDuplicatePoint)) {
          nextPoints = [...zoneDraftPoints, point];
        }
      }

      if (nextPoints.length < 3) {
        return;
      }

      createZoneOnCurrentLevel(nextPoints);
      clearDraft();
    },
    [clearDraft, createZoneOnCurrentLevel, zoneDraftPoints],
  );

  const handleWallPlacementPoint = useCallback(
    (point: WallPlanPoint) => {
      if (!draftStart) {
        setDraftStart(point);
        setDraftEnd(point);
        setCursorPoint(point);
        return;
      }

      if (!isWallLongEnough(draftStart, point)) {
        return;
      }

      createWallOnCurrentLevel(draftStart, point);
      clearDraft();
    },
    [clearDraft, draftStart],
  );

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
        setArcDraftStart(point);
        setArcDraftEnd(point);
        setArcBulgePoint(null);
        setCursorPoint(point);
        return;
      }
      if (!isWallLongEnough(arcDraftStart, point)) return;
      const wall = createWallOnCurrentLevel(arcDraftStart, point, 0);
      clearDraft();
      if (wall) {
        queueMicrotask(() => {
          useViewer.getState().setSelection({ selectedIds: [wall.id] });
          // EXIT the arc-wall tool back to select mode so the next click
          // doesn't start a new wall. User's complaint: "the cursor goes
          // back to wall start mode" — that's because tool stayed
          // 'arc-wall' and any canvas click placed a new start point,
          // making the bulge handle unreachable in practice. After this:
          // - Cursor returns to normal pointer
          // - The bulge handle is the only interactive thing on the wall
          // - To draw another arc wall, user clicks Arc Wall in the toolbar
          //   again.
          setTool(null);
          setMode("select");
        });
      }
    },
    [arcDraftStart, clearDraft, setMode, setTool],
  );

  const handleBackgroundClick = useCallback(
    (event: ReactMouseEvent<SVGSVGElement>) => {
      if (isPolygonBuildActive && event.detail >= 2) {
        return;
      }

      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) {
        return;
      }

      // Trace-scale calibration: clicks become reference-line points instead
      // of tool actions. First click sets P1, second sets P2 and surfaces the
      // distance input. A third click after P2 is set restarts (drop both,
      // start over) — convenient if the user mis-clicked.
      if (calibration) {
        event.preventDefault?.();
        if (!calibrationP1) {
          setCalibrationP1(planPoint);
          return;
        }
        if (!calibrationP2) {
          setCalibrationP2(planPoint);
          return;
        }
        // Both already set — restart.
        setCalibrationP1(planPoint);
        setCalibrationP2(null);
        return;
      }

      if (isOpeningPlacementActive) {
        const closest = findClosestWallPoint(planPoint, walls);
        // 2026-07-27: block opening placement on arc walls. iOS/Flutter
        // do the same: doors and windows only sample the wall as a
        // straight rectangle for the boolean cutter, so a bulged wall
        // creates a mis-cut hole (visible sliver + wrong-angle door
        // hinge).
        // 2026-08-01: keep the block, but stop swallowing the click in
        // silence -- a user hit this and reported the door tool as
        // inaccessible. `arcOpeningBlocked` renders an explanatory chip.
        if (closest && Math.abs(closest.wall.bulge ?? 0) > 1e-6) {
          setArcOpeningBlocked(true);
          return;
        }
        if (closest) {
          const length = arcLength(
            closest.wall.start,
            closest.wall.end,
            closest.wall.bulge ?? 0,
          );
          const distance = closest.t * length;
          const wall = closest.wall;
          const isDoor = tool === "door";
          const state = useScene.getState();
          const existing = Object.values(state.nodes).filter((n) => {
            if (n.type !== (isDoor ? "door" : "window")) return false;
            const parentWall = n.parentId
              ? state.nodes[n.parentId as AnyNodeId]
              : undefined;
            return parentWall?.parentId === levelId;
          }).length;
          const name = `${isDoor ? "Door" : "Window"} ${existing + 1}`;
          const wallDx = wall.end[0] - wall.start[0];
          const wallDy = wall.end[1] - wall.start[1];
          const wallAngle = Math.atan2(wallDy, wallDx);
          if (isDoor) {
            const node = DoorNode.parse({
              name,
              position: [distance, 0, 0],
              rotation: [0, wallAngle, 0],
              side: "front",
              wallId: wall.id,
              parentId: wall.id,
              // Set explicitly rather than leaning on the schema default, so
              // the ghost the user aimed with and the node they get are
              // driven by the same constant. See NEW_OPENING_WIDTH_M.
              width: NEW_OPENING_WIDTH_M.door,
            });
            state.createNode(node, wall.id as AnyNodeId);
            useViewer.getState().setSelection({ selectedIds: [node.id] });
          } else {
            const node = WindowNode.parse({
              name,
              position: [distance, floorplanOpeningLocalY, 0],
              rotation: [0, wallAngle, 0],
              side: "front",
              wallId: wall.id,
              parentId: wall.id,
              width: NEW_OPENING_WIDTH_M.window,
            });
            state.createNode(node, wall.id as AnyNodeId);
            useViewer.getState().setSelection({ selectedIds: [node.id] });
          }
          sfxEmitter.emit("sfx:item-place");
          setOpeningPreview(null);
        }
        return;
      }

      // Placed on the CLICK handler, not pointer-move. The polygon
      // branch this sits above appears in BOTH, because the move
      // handler draws the rubber-band preview — putting stair
      // creation in that one spawned a stair on every mouse move.
      if (isStairBuildActive) {
        createStairOnCurrentLevel(planPoint);
        return;
      }

      if (isPolygonBuildActive) {
        const snappedPoint = snapPolygonDraftPoint({
          point: planPoint,
          start: activePolygonDraftPoints[activePolygonDraftPoints.length - 1],
          angleSnap: activePolygonDraftPoints.length > 0 && orthoActive,
        });

        if (isZoneBuildActive) {
          handleZonePlacementPoint(snappedPoint);
        } else {
          handleSlabPlacementPoint(snappedPoint);
        }
        return;
      }

      // Stairs are hit-tested BEFORE zones. A stair is almost always drawn
      // inside a room, and the zone polygon covers the whole room — so the
      // zone swallowed every click and a placed stair could never be
      // reselected. Testing the smaller, more specific object first is the
      // same order the slab/wall tests already use.
      const stairClick = stairPlans.find((plan) =>
        isPointInStairPlan(toPoint2D(planPoint), plan),
      );
      if (stairClick) {
        setSelectedReferenceId(null);
        setSelection({ selectedIds: [stairClick.stair.id], zoneId: null });
        return;
      }

      if (canSelectFloorplanZones) {
        const zoneHit = visibleZonePolygons.find(({ polygon }) =>
          isPointInsidePolygon(toPoint2D(planPoint), polygon),
        );
        if (zoneHit) {
          setSelectedReferenceId(null);
          setSelection({ zoneId: zoneHit.zone.id });
          return;
        }
      }

      // Arc-wall tool: 3-step placement. Phase 0/1 use the same snap as the
      // straight wall tool; phase 2 (bulge) does NOT angle-snap because the
      // arc midpoint isn't directional, just an offset.
      if (isArcWallBuildActive) {
        const inPhase2 = Boolean(arcDraftStart && arcDraftEnd);
        const snappedPoint = inPhase2
          ? snapPointToGrid(planPoint)
          : snapWallDraftPoint({
              point: planPoint,
              walls,
              start: arcDraftStart ?? undefined,
              angleSnap: Boolean(arcDraftStart) && orthoActive,
              freehand: !snapActive,
            });
        handleArcWallPlacementPoint(snappedPoint);
        return;
      }

      if (!isWallBuildActive) {
        if (structureLayer === "zones") {
          setSelectedReferenceId(null);
          setSelection({ zoneId: null });
        } else {
          setSelectedReferenceId(null);
          setSelection({ selectedIds: [] });
        }
        return;
      }

      const snappedPoint = snapWallDraftPoint({
        point: planPoint,
        walls,
        start: draftStart ?? undefined,
        angleSnap: Boolean(draftStart) && orthoActive,
        freehand: !snapActive,
      });

      handleWallPlacementPoint(snappedPoint);
    },
    [
      arcDraftEnd,
      arcDraftStart,
      calibration,
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
      isStairBuildActive,
      createStairOnCurrentLevel,
      setSelectedReferenceId,
      setSelection,
      shiftPressed,
      orthoActive,
      snapActive,
      structureLayer,
      visibleZonePolygons,
      walls,
    ],
  );
  const handleBackgroundDoubleClick = useCallback(
    (event: ReactMouseEvent<SVGSVGElement>) => {
      if (!isPolygonBuildActive) {
        return;
      }

      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) {
        return;
      }

      const snappedPoint = snapPolygonDraftPoint({
        point: planPoint,
        start: activePolygonDraftPoints[activePolygonDraftPoints.length - 1],
        angleSnap: activePolygonDraftPoints.length > 0 && orthoActive,
      });

      if (isZoneBuildActive) {
        handleZonePlacementConfirm(snappedPoint);
      } else {
        handleSlabPlacementConfirm(snappedPoint);
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
      orthoActive,
      snapActive,
    ],
  );

  const commitFloorplanSelection = useCallback(
    (nextSelectedIds: string[]) => {
      if (!(levelId && levelNode) || levelNode.type !== "level") {
        setSelectedReferenceId(null);
        setSelection({ selectedIds: nextSelectedIds });
        return;
      }

      const { selection } = useViewer.getState();
      const nodes = useScene.getState().nodes;
      const updates: Parameters<typeof setSelection>[0] = {
        selectedIds: nextSelectedIds,
      };

      if (levelId !== selection.levelId) {
        updates.levelId = levelId;
      }

      const parentNode = levelNode.parentId
        ? nodes[levelNode.parentId as AnyNodeId]
        : null;
      if (
        parentNode?.type === "building" &&
        parentNode.id !== selection.buildingId
      ) {
        updates.buildingId = parentNode.id;
      }

      setSelectedReferenceId(null);
      setSelection(updates);
    },
    [levelId, levelNode, setSelectedReferenceId, setSelection],
  );

  const addFloorplanSelection = useCallback(
    (
      nextSelectedIds: string[],
      modifierKeys?: { meta: boolean; ctrl: boolean },
    ) => {
      const shouldAppend = Boolean(modifierKeys?.meta || modifierKeys?.ctrl);

      if (shouldAppend) {
        if (nextSelectedIds.length === 0) {
          return;
        }

        const currentSelectedIds = useViewer.getState().selection.selectedIds;
        commitFloorplanSelection(
          Array.from(new Set([...currentSelectedIds, ...nextSelectedIds])),
        );
        return;
      }

      commitFloorplanSelection(nextSelectedIds);
    },
    [commitFloorplanSelection],
  );

  const toggleFloorplanSelection = useCallback(
    (nodeId: string, modifierKeys?: { meta: boolean; ctrl: boolean }) => {
      const shouldToggle = Boolean(modifierKeys?.meta || modifierKeys?.ctrl);

      if (shouldToggle) {
        const currentSelectedIds = useViewer.getState().selection.selectedIds;
        commitFloorplanSelection(
          currentSelectedIds.includes(nodeId)
            ? currentSelectedIds.filter((selectedId) => selectedId !== nodeId)
            : [...currentSelectedIds, nodeId],
        );
        return;
      }

      commitFloorplanSelection([nodeId]);
    },
    [commitFloorplanSelection],
  );

  const getFloorplanHitIdAtPoint = useCallback(
    (planPoint: WallPlanPoint) => {
      const point = toPoint2D(planPoint);

      const openingHit = openingsPolygons.find(({ polygon }) => {
        if (isPointInsidePolygon(point, polygon)) {
          return true;
        }

        const centerLine = getOpeningCenterLine(polygon);
        if (!centerLine) {
          return false;
        }

        return (
          getDistanceToWallSegment(
            point,
            [centerLine.start.x, centerLine.start.y],
            [centerLine.end.x, centerLine.end.y],
          ) <= floorplanOpeningHitTolerance
        );
      });
      if (openingHit) {
        return openingHit.opening.id;
      }

      const wallHit = displayWallPolygons.find(
        ({ wall, polygon }) =>
          isPointInsidePolygon(point, polygon) ||
          getDistanceToWallSegment(point, wall.start, wall.end) <=
            floorplanWallHitTolerance,
      );
      if (wallHit) {
        return wallHit.wall.id;
      }

      // Before slabs: a stair sits on top of the floor, so a click inside its
      // footprint means the stair.
      const stairHit = stairPlans.find((plan) =>
        isPointInStairPlan(point, plan),
      );
      if (stairHit) {
        return stairHit.stair.id;
      }

      const slabHit = displaySlabPolygons.find(({ polygon, holes }) =>
        isPointInsidePolygonWithHoles(point, polygon, holes),
      );
      if (slabHit) {
        return slabHit.slab.id;
      }

      return null;
    },
    [
      displaySlabPolygons,
      displayWallPolygons,
      stairPlans,
      floorplanOpeningHitTolerance,
      floorplanWallHitTolerance,
      openingsPolygons,
    ],
  );

  const getFloorplanSelectionIdsInBounds = useCallback(
    (bounds: FloorplanSelectionBounds) => {
      const wallIds = displayWallPolygons
        .filter(({ polygon }) =>
          doesPolygonIntersectSelectionBounds(polygon, bounds),
        )
        .map(({ wall }) => wall.id);
      const openingIds = openingsPolygons
        .filter(({ polygon }) =>
          doesPolygonIntersectSelectionBounds(polygon, bounds),
        )
        .map(({ opening }) => opening.id);
      const slabIds = displaySlabPolygons
        .filter(({ polygon }) =>
          doesPolygonIntersectSelectionBounds(polygon, bounds),
        )
        .map(({ slab }) => slab.id);

      return Array.from(new Set([...wallIds, ...openingIds, ...slabIds]));
    },
    [displaySlabPolygons, displayWallPolygons, openingsPolygons],
  );

  const handleWallSelect = useCallback(
    (wall: WallNode) => {
      // Ritn3D: delete mode — delete wall on click
      if (useEditor.getState().mode === "delete") {
        sfxEmitter.emit("sfx:structure-delete");
        useScene.getState().deleteNode(wall.id as AnyNodeId);
        return;
      }
      commitFloorplanSelection([wall.id]);
    },
    [commitFloorplanSelection],
  );

  const handleWallClick = useCallback(
    (wall: WallNode, event: ReactMouseEvent<SVGElement>) => {
      // 2026-07-27: calibration mode intercepts wall clicks -- the wall
      // is exactly what you WANT to click on during calibration (its
      // known length is your reference). Capture the point and let the
      // handleBackgroundClick calibration logic take over instead of
      // opening the WallPanel. Fixes "click Set Scale, then can't click
      // two points" -- previously wall clicks stole the event.
      if (calibration) {
        event.stopPropagation();
        const planPoint = getPlanPointFromClientPoint(
          event.clientX,
          event.clientY,
        );
        if (!planPoint) return;
        if (!calibrationP1) {
          setCalibrationP1(planPoint);
        } else if (!calibrationP2) {
          setCalibrationP2(planPoint);
        } else {
          setCalibrationP1(planPoint);
          setCalibrationP2(null);
        }
        return;
      }
      // Ritn3D: delete mode — delete wall on click
      if (useEditor.getState().mode === "delete") {
        event.stopPropagation();
        sfxEmitter.emit("sfx:structure-delete");
        useScene.getState().deleteNode(wall.id as AnyNodeId);
        return;
      }

      const centerX = (wall.start[0] + wall.end[0]) / 2;
      const centerZ = (wall.start[1] + wall.end[1]) / 2;
      const halfLength =
        Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]) /
        2;
      const localY = isOpeningPlacementActive ? floorplanOpeningLocalY : 0;

      setSelectedReferenceId(null);

      // Ritn3D 2026-07-04: SELECT the wall on click when we're not in an
      // opening-placement mode (where a click means "insert door here").
      // Selection opens WallPanel via PanelManager — was missing before,
      // so users couldn't edit a wall after placing it.
      if (!isOpeningPlacementActive) {
        handleWallSelect(wall);
      }

      emitter.emit("wall:click", {
        node: wall,
        position: [centerX, 0, centerZ],
        localPosition: [halfLength, localY, 0],
        stopPropagation: () => event.stopPropagation(),
        nativeEvent: event.nativeEvent as any,
      } as any);
    },
    [
      floorplanOpeningLocalY,
      isOpeningPlacementActive,
      setSelectedReferenceId,
      handleWallSelect,
      calibration,
      calibrationP1,
      calibrationP2,
      getPlanPointFromClientPoint,
    ],
  );

  const handleWallDoubleClick = useCallback(
    (wall: WallNode, event: ReactMouseEvent<SVGElement>) => {
      const centerX = (wall.start[0] + wall.end[0]) / 2;
      const centerZ = (wall.start[1] + wall.end[1]) / 2;
      const halfLength =
        Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]) /
        2;

      emitter.emit("wall:double-click", {
        node: wall,
        position: [centerX, 0, centerZ],
        localPosition: [halfLength, 0, 0],
        stopPropagation: () => event.stopPropagation(),
        nativeEvent: event.nativeEvent as any,
      } as any);
      emitter.emit("camera-controls:focus", { nodeId: wall.id });
    },
    [],
  );
  const emitFloorplanNodeClick = useCallback(
    (
      nodeId:
        | SlabNode["id"]
        | OpeningNode["id"]
        | ZoneNodeType["id"]
        | StairNode["id"],
      event: ReactMouseEvent<SVGElement>,
    ) => {
      const node = useScene.getState().nodes[nodeId as AnyNodeId];
      if (!(
        node &&
        (node.type === "slab" ||
          node.type === "door" ||
          node.type === "window" ||
          node.type === "zone")
      )) {
        return;
      }

      // Ritn3D: delete mode — delete node on click
      if (useEditor.getState().mode === "delete") {
        sfxEmitter.emit("sfx:structure-delete");
        const parentId = node.parentId;
        useScene.getState().deleteNode(nodeId as AnyNodeId);
        if (parentId) useScene.getState().dirtyNodes.add(parentId as AnyNodeId);
        return;
      }

      setSelectedReferenceId(null);

      // Ritn3D 2026-07-04: actually SELECT the clicked node so PanelManager
      // opens the corresponding side panel (SlabPanel / DoorPanel /
      // WindowPanel). Zones use a separate selection field (zoneId) per
      // the app's existing convention; everything else uses selectedIds.
      if (node.type === "zone") {
        setSelection({ selectedIds: [], zoneId: nodeId as ZoneNodeType["id"] });
      } else {
        setSelection({ selectedIds: [nodeId], zoneId: null });
      }

      emitter.emit(
        `${node.type}:click` as any,
        {
          localPosition: [0, 0, 0],
          nativeEvent: event.nativeEvent as any,
          node,
          position: [0, 0, 0],
          stopPropagation: () => event.stopPropagation(),
        } as any,
      );
    },
    [setSelectedReferenceId, setSelection],
  );
  const handleGuideSelect = useCallback(
    (guideId: GuideNode["id"]) => {
      setSelectedReferenceId(guideId);
      setSelection({ selectedIds: [], zoneId: null });
    },
    [setSelectedReferenceId, setSelection],
  );
  const handleGuideCornerPointerDown = useCallback(
    (
      guide: GuideNode,
      dimensions: GuideImageDimensions,
      corner: GuideCorner,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0 || !canInteractWithGuides) {
        return;
      }

      const aspectRatio = dimensions.width / dimensions.height;
      if (!(aspectRatio > 0)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      setHoveredGuideCorner(null);
      handleGuideSelect(guide.id);

      const centerSvg = getGuideCenterSvgPoint(guide);
      const rotationSvg = -guide.rotation[1];
      const width = getGuideWidth(guide.scale);
      const height = getGuideHeight(width, aspectRatio);
      const [cornerOffsetX, cornerOffsetY] = getGuideCornerLocalOffset(
        width,
        height,
        corner,
      );
      const shouldRotate = event.ctrlKey || event.metaKey;

      guideInteractionRef.current = {
        pointerId: event.pointerId,
        guideId: guide.id,
        corner,
        mode: shouldRotate ? "rotate" : "resize",
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
      };

      document.body.style.userSelect = "none";
      document.body.style.cursor = shouldRotate
        ? getGuideRotateCursor(theme === "dark")
        : getGuideResizeCursor(corner, rotationSvg);

      const nextDraft: GuideTransformDraft = {
        guideId: guide.id,
        position: [guide.position[0], guide.position[2]],
        scale: guide.scale,
        rotation: guide.rotation[1],
      };

      guideTransformDraftRef.current = nextDraft;
      setGuideTransformDraft(nextDraft);
    },
    [canInteractWithGuides, handleGuideSelect, theme],
  );
  const handleGuideTranslateStart = useCallback(
    (guide: GuideNode, event: ReactPointerEvent<SVGRectElement>) => {
      if (
        event.button !== 0 ||
        !canInteractWithGuides ||
        selectedGuideId !== guide.id
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const svgPoint = getSvgPointFromClientPoint(event.clientX, event.clientY);
      if (!svgPoint) {
        return;
      }

      const centerSvg = getGuideCenterSvgPoint(guide);

      guideInteractionRef.current = {
        pointerId: event.pointerId,
        guideId: guide.id,
        corner: "nw",
        mode: "translate",
        aspectRatio: 1,
        centerSvg,
        oppositeCornerSvg: null,
        pointerOffsetSvg: subtractSvgPoints(svgPoint, centerSvg),
        rotationSvg: -guide.rotation[1],
        cornerBaseAngle: 0,
        scale: guide.scale,
      };

      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";

      const nextDraft: GuideTransformDraft = {
        guideId: guide.id,
        position: [guide.position[0], guide.position[2]],
        scale: guide.scale,
        rotation: guide.rotation[1],
      };

      guideTransformDraftRef.current = nextDraft;
      setGuideTransformDraft(nextDraft);
    },
    [canInteractWithGuides, getSvgPointFromClientPoint, selectedGuideId],
  );

  const handleOpeningSelect = useCallback(
    (openingId: OpeningNode["id"], event: ReactMouseEvent<SVGElement>) => {
      emitFloorplanNodeClick(openingId, event);
    },
    [emitFloorplanNodeClick],
  );
  const handleSlabSelect = useCallback(
    (slabId: SlabNode["id"], event: ReactMouseEvent<SVGElement>) => {
      emitFloorplanNodeClick(slabId, event);
    },
    [emitFloorplanNodeClick],
  );
  // ── Dragging a stair ──────────────────────────────────────────────
  // Pointer capture on the footprint itself, with the offset from the click
  // to the stair's origin held for the duration — grabbing the middle and
  // having it jump so its corner meets the cursor is the classic version of
  // this bug.
  //
  // A drag only starts once the pointer has actually travelled; below that
  // threshold the gesture stays a click, so selecting a stair by tapping it
  // still works and does not nudge it by a pixel.
  const stairDragRef = useRef<{
    pointerId: number;
    stairId: StairNode["id"];
    grabOffset: [number, number];
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);

  const handleStairPointerDown = useCallback(
    (stairId: StairNode["id"], event: ReactPointerEvent<SVGElement>) => {
      if (event.button !== 0) return;
      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) return;
      const node = useScene.getState().nodes[stairId] as StairNode | undefined;
      if (!node) return;

      event.stopPropagation();
      // One drag should be ONE undo step. Without pausing, a drag writes an
      // update per frame and buries every earlier action in the history.
      useScene.temporal.getState().pause();
      stairDragRef.current = {
        pointerId: event.pointerId,
        stairId,
        grabOffset: [
          planPoint[0] - node.position[0],
          planPoint[1] - node.position[1],
        ],
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
      };
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    },
    [getPlanPointFromClientPoint],
  );

  const handleStairPointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const drag = stairDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      if (!drag.moved) {
        const dx = event.clientX - drag.startClientX;
        const dy = event.clientY - drag.startClientY;
        if (Math.hypot(dx, dy) < 3) return; // still a click, not a drag
        drag.moved = true;
      }

      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) return;

      // Snap the stair's ORIGIN, not the cursor. Snapping the cursor and then
      // subtracting the grab offset lands the stair off-grid by whatever that
      // offset happened to be — the stair would move in grid steps but never
      // sit on a grid line. The origin is the corner the footprint is built
      // from and the corner the pipeline places, so it is the thing that
      // should land on the grid.
      //
      // Honours the same Grid-snap toggle as the wall tools, with Shift
      // inverting it, via the shared `snapActive`.
      const origin: WallPlanPoint = [
        planPoint[0] - drag.grabOffset[0],
        planPoint[1] - drag.grabOffset[1],
      ];
      const placed = snapActive ? snapPointToGrid(origin) : origin;

      useScene.getState().updateNode(drag.stairId, {
        position: [placed[0], placed[1]] as [number, number],
      });
    },
    [getPlanPointFromClientPoint, snapActive],
  );

  const handleStairPointerUp = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const drag = stairDragRef.current;
      if (drag && drag.pointerId === event.pointerId) {
        stairDragRef.current = null;
        useScene.temporal.getState().resume();
      }
    },
    [],
  );

  const handleStairSelect = useCallback(
    (stairId: StairNode["id"], event: ReactMouseEvent<SVGElement>) => {
      emitFloorplanNodeClick(stairId, event);
    },
    [emitFloorplanNodeClick],
  );
  const handleZoneSelect = useCallback(
    (zoneId: ZoneNodeType["id"], event: ReactMouseEvent<SVGElement>) => {
      emitFloorplanNodeClick(zoneId, event);
    },
    [emitFloorplanNodeClick],
  );
  const handleSlabDoubleClick = useCallback((slab: SlabNode) => {
    emitter.emit("camera-controls:focus", { nodeId: slab.id });
  }, []);
  const handleOpeningDoubleClick = useCallback((opening: OpeningNode) => {
    emitter.emit("camera-controls:focus", { nodeId: opening.id });
  }, []);
  const handleSelectedOpeningMove = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();

      const opening = selectedOpeningEntry?.opening;
      if (!opening) {
        return;
      }

      sfxEmitter.emit("sfx:item-pick");
      setMovingNode(opening);
      setSelection({ selectedIds: [] });
    },
    [selectedOpeningEntry, setMovingNode, setSelection],
  );
  const handleSelectedOpeningDuplicate = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();

      const opening = selectedOpeningEntry?.opening;
      if (!opening?.parentId) {
        return;
      }

      sfxEmitter.emit("sfx:item-pick");
      useScene.temporal.getState().pause();

      const cloned = structuredClone(opening) as Record<string, unknown>;
      delete cloned.id;
      cloned.metadata = {
        ...(typeof cloned.metadata === "object" && cloned.metadata !== null
          ? cloned.metadata
          : {}),
        isNew: true,
      };

      const duplicate =
        opening.type === "door"
          ? DoorNode.parse(cloned)
          : WindowNode.parse(cloned);

      useScene.getState().createNode(duplicate, opening.parentId as AnyNodeId);
      setMovingNode(duplicate);
      setSelection({ selectedIds: [] });
    },
    [selectedOpeningEntry, setMovingNode, setSelection],
  );
  const handleSelectedOpeningDelete = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();

      const opening = selectedOpeningEntry?.opening;
      if (!opening) {
        return;
      }

      sfxEmitter.emit("sfx:item-delete");
      deleteNode(opening.id as AnyNodeId);
      if (opening.parentId) {
        useScene.getState().dirtyNodes.add(opening.parentId as AnyNodeId);
      }
      setSelection({ selectedIds: [] });
    },
    [deleteNode, selectedOpeningEntry, setSelection],
  );

  const handleWallEndpointPointerDown = useCallback(
    (
      wall: WallNode,
      endpoint: WallEndpoint,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setHoveredEndpointId(null);

      const movingPoint = endpoint === "start" ? wall.start : wall.end;

      if (isWallBuildActive) {
        handleWallPlacementPoint(movingPoint);
        return;
      }

      if (mode === "delete") {
        sfxEmitter.emit("sfx:structure-delete");
        useScene.getState().deleteNode(wall.id as AnyNodeId);
        return;
      }

      if (mode !== "select") {
        return;
      }

      clearWallPlacementDraft();
      handleWallSelect(wall);

      const fixedPoint = endpoint === "start" ? wall.end : wall.start;

      wallEndpointDragRef.current = {
        pointerId: event.pointerId,
        wallId: wall.id,
        endpoint,
        fixedPoint,
        currentPoint: movingPoint,
      };

      setWallEndpointDraft(
        buildWallEndpointDraft(wall.id, endpoint, fixedPoint, movingPoint),
      );
      setCursorPoint(movingPoint);
    },
    [
      clearWallPlacementDraft,
      handleWallPlacementPoint,
      handleWallSelect,
      isWallBuildActive,
      mode,
    ],
  );

  // Bulge handle pointer-down. Sits at the arc apex (or chord midpoint for
  // straight walls — drag it perpendicular to bend the wall into a curve).
  // Only meaningful in 'select' mode; other modes ignore the press so the
  // user can't accidentally curve a wall while building doors etc.
  const handleWallBulgePointerDown = useCallback(
    (wall: WallNode, event: ReactPointerEvent<SVGCircleElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      // Allow in select mode OR while the arc-wall tool is active. Both paths
      // expose the handle (see wallBulgeHandles useMemo); both must allow
      // the drag too.
      if (mode !== "select" && tool !== "arc-wall") {
        return;
      }
      clearWallPlacementDraft();
      // Only re-select if the wall isn't already selected — avoids a
      // setState cascade through commitFloorplanSelection →
      // setSelectedReferenceId(null) that fires the
      // "Cannot update a component while rendering" React warning and was
      // breaking the next pointerdown's handlers.
      const alreadySelected = useViewer
        .getState()
        .selection.selectedIds.includes(wall.id);
      if (!alreadySelected) {
        handleWallSelect(wall);
      }
      // Capture the cursor's perpendicular distance from the chord AT
      // drag start so the move handler can compute a delta. Without this
      // capture, the bulge was tied to absolute cursor position — once the
      // wall was curved, the user couldn't realistically drag the cursor
      // far enough to make it straight (had to cover the full sagitta in
      // one drag).
      const initialBulge = wall.bulge ?? 0;
      const downPlanPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      const chord = Math.hypot(
        wall.end[0] - wall.start[0],
        wall.end[1] - wall.start[1],
      );
      let initialPerp = 0;
      if (downPlanPoint && chord > 0) {
        const dx = (wall.end[0] - wall.start[0]) / chord;
        const dy = (wall.end[1] - wall.start[1]) / chord;
        const vx = downPlanPoint[0] - wall.start[0];
        const vy = downPlanPoint[1] - wall.start[1];
        initialPerp = vx * -dy + vy * dx;
      }
      wallBulgeDragRef.current = {
        pointerId: event.pointerId,
        wallId: wall.id,
        start: wall.start,
        end: wall.end,
        initialBulge,
        initialPerp,
        lastBulge: initialBulge,
      };
      setWallBulgeDraft({ wallId: wall.id, bulge: initialBulge });
    },
    [clearWallPlacementDraft, handleWallSelect, mode, tool],
  );
  const handleSlabVertexPointerDown = useCallback(
    (
      slabId: SlabNode["id"],
      vertexIndex: number,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setHoveredSlabHandleId(null);

      const slabEntry = displaySlabPolygons.find(
        ({ slab }) => slab.id === slabId,
      );
      const vertexPoint = slabEntry?.polygon[vertexIndex];
      if (!(slabEntry && vertexPoint)) {
        return;
      }

      // RAW corners, not slabEntry.polygon: that is the tessellated display
      // outline now, and seeding an edit from it would write ~50 polyline
      // points back as the slab's corners and flatten every arc.
      setSlabBoundaryDraft({
        slabId,
        polygon: slabEntry.slab.polygon.map(toWallPlanPointFromTuple),
      });
      setSlabVertexDragState({
        pointerId: event.pointerId,
        slabId,
        vertexIndex,
      });
      setCursorPoint(toWallPlanPoint(vertexPoint));
    },
    [displaySlabPolygons],
  );
  const handleSlabVertexDoubleClick = useCallback(
    (
      slabId: SlabNode["id"],
      vertexIndex: number,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const slab = slabById.get(slabId);
      if (!(slab && slab.polygon.length > 3)) {
        return;
      }

      slabBoundaryDraftRef.current = null;
      clearSlabBoundaryInteraction();

      updateNode(slabId, {
        polygon: slab.polygon.filter((_, index) => index !== vertexIndex),
      });
    },
    [clearSlabBoundaryInteraction, slabById, updateNode],
  );
  const handleSlabMidpointPointerDown = useCallback(
    (
      slabId: SlabNode["id"],
      edgeIndex: number,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setHoveredSlabHandleId(null);

      const slabEntry = displaySlabPolygons.find(
        ({ slab }) => slab.id === slabId,
      );
      if (!slabEntry) {
        return;
      }

      // RAW corners, not slabEntry.polygon: that is the tessellated display
      // outline now, and seeding an edit from it would write ~50 polyline
      // points back as the slab's corners and flatten every arc.
      const basePolygon = slabEntry.slab.polygon.map(toWallPlanPointFromTuple);
      const startPoint = basePolygon[edgeIndex];
      const endPoint = basePolygon[(edgeIndex + 1) % basePolygon.length];
      if (!(startPoint && endPoint)) {
        return;
      }

      const insertedPoint: WallPlanPoint = [
        (startPoint[0] + endPoint[0]) / 2,
        (startPoint[1] + endPoint[1]) / 2,
      ];
      const insertIndex = edgeIndex + 1;
      const nextPolygon = [
        ...basePolygon.slice(0, insertIndex),
        insertedPoint,
        ...basePolygon.slice(insertIndex),
      ];

      setSlabBoundaryDraft({
        slabId,
        polygon: nextPolygon,
      });
      setSlabVertexDragState({
        pointerId: event.pointerId,
        slabId,
        vertexIndex: insertIndex,
      });
      setCursorPoint(insertedPoint);
    },
    [displaySlabPolygons],
  );
  /* Curve one edge of a floor. Mirrors the wall bulge drag: the handle IS
     the arc apex, so its perpendicular distance from the chord is the
     sagitta and bulge = 2 * sagitta / chord, hard-clamped to a semicircle.
     Absolute rather than relative, for the reason recorded on the wall
     version — a relative model decouples the cursor from the visible apex
     and you can never drag a curved edge back to straight. */
  const handleSlabBulgePointerDown = useCallback(
    (
      slabId: SlabNode["id"],
      holeIndex: number | null,
      edgeIndex: number,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setHoveredSlabHandleId(null);

      const slab = slabById.get(slabId);
      if (!slab) return;
      const ring =
        holeIndex === null ? slab.polygon : (slab.holes?.[holeIndex] ?? []);
      if (ring.length < 3) return;
      const start = ring[edgeIndex];
      const end = ring[(edgeIndex + 1) % ring.length];
      if (!(start && end)) return;

      const initialBulge =
        (holeIndex === null
          ? slab.bulges?.[edgeIndex]
          : slab.holeBulges?.[holeIndex]?.[edgeIndex]) ?? 0;
      slabBulgeDragRef.current = {
        pointerId: event.pointerId,
        slabId,
        holeIndex,
        edgeIndex,
        start,
        end,
        lastBulge: initialBulge,
      };
      setSlabBulgeDraft({ slabId, holeIndex, edgeIndex, bulge: initialBulge });
    },
    [slabById],
  );

  useEffect(() => {
    if (!slabBulgeDraft) return;

    const onMove = (event: PointerEvent) => {
      const drag = slabBulgeDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();

      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) return;

      const chord = Math.hypot(
        drag.end[0] - drag.start[0],
        drag.end[1] - drag.start[1],
      );
      if (chord === 0) return;

      const dx = (drag.end[0] - drag.start[0]) / chord;
      const dy = (drag.end[1] - drag.start[1]) / chord;
      const vx = planPoint[0] - drag.start[0];
      const vy = planPoint[1] - drag.start[1];
      const cursorPerp = vx * -dy + vy * dx;

      const next = Math.max(-1, Math.min(1, (2 * cursorPerp) / chord));
      drag.lastBulge = next;
      setSlabBulgeDraft({
        slabId: drag.slabId,
        holeIndex: drag.holeIndex,
        edgeIndex: drag.edgeIndex,
        bulge: next,
      });
    };

    const commit = (event: PointerEvent) => {
      const drag = slabBulgeDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      const slab = slabById.get(drag.slabId);
      if (slab) {
        const finalBulge = isStraight(drag.lastBulge) ? 0 : drag.lastBulge;
        const ring =
          drag.holeIndex === null
            ? slab.polygon
            : (slab.holes?.[drag.holeIndex] ?? []);
        const current =
          (drag.holeIndex === null
            ? slab.bulges?.[drag.edgeIndex]
            : slab.holeBulges?.[drag.holeIndex]?.[drag.edgeIndex]) ?? 0;
        if (current !== finalBulge) {
          // Pad to one entry per edge before writing: a slab drawn before
          // bulges existed has none at all, and a sparse array would put the
          // curve on whichever edge happened to land at that index later.
          const nextBulges = [
            ...((drag.holeIndex === null
              ? slab.bulges
              : slab.holeBulges?.[drag.holeIndex]) ?? []),
          ];
          while (nextBulges.length < ring.length) nextBulges.push(0);
          nextBulges[drag.edgeIndex] = finalBulge;
          if (drag.holeIndex === null) {
            updateNode(slab.id, { bulges: nextBulges });
          } else {
            // Pad the OUTER array too, so hole 2 curving before hole 0 does
            // not land its bulges on hole 0's ring.
            const allHoleBulges = [...(slab.holeBulges ?? [])];
            while (allHoleBulges.length < (slab.holes?.length ?? 0)) {
              allHoleBulges.push([]);
            }
            allHoleBulges[drag.holeIndex] = nextBulges;
            updateNode(slab.id, { holeBulges: allHoleBulges });
          }
          // Same re-assert: curving one edge should not deselect the floor
          // you are shaping.
          setSelection({ selectedIds: [slab.id] });
          sfxEmitter.emit("sfx:structure-build");
        }
      }
      slabBulgeDragRef.current = null;
      setSlabBulgeDraft(null);
    };

    const cancel = (event: PointerEvent) => {
      const drag = slabBulgeDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      slabBulgeDragRef.current = null;
      setSlabBulgeDraft(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", commit);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [
    getPlanPointFromClientPoint,
    setSelection,
    slabBulgeDraft,
    slabById,
    updateNode,
  ]);

  const handleSlabHolePointerDown = useCallback(
    (
      slabId: SlabNode["id"],
      holeIndex: number,
      vertexIndex: number | null,
      event: ReactPointerEvent<SVGElement>,
    ) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const slab = slabById.get(slabId);
      const ring = slab?.holes?.[holeIndex];
      if (!ring || ring.length < 3) return;
      const origin = getPlanPointFromClientPoint(event.clientX, event.clientY);
      if (!origin) return;

      slabHoleDragRef.current = {
        pointerId: event.pointerId,
        slabId,
        holeIndex,
        vertexIndex,
        origin,
        startRing: ring.map((q) => [q[0], q[1]] as [number, number]),
      };
      setSlabHoleDraft({
        slabId,
        holeIndex,
        ring: ring.map((q) => [q[0], q[1]] as [number, number]),
      });
    },
    [getPlanPointFromClientPoint, slabById],
  );

  useEffect(() => {
    if (!slabHoleDraft) return;

    const onMove = (event: PointerEvent) => {
      const drag = slabHoleDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) return;

      let ring: [number, number][];
      if (drag.vertexIndex === null) {
        // Whole cut: translate by the cursor delta, snapped, so the shape is
        // preserved exactly rather than re-snapping each corner separately.
        const dx = snapToHalf(planPoint[0] - drag.origin[0]);
        const dy = snapToHalf(planPoint[1] - drag.origin[1]);
        ring = drag.startRing.map((q) => [q[0] + dx, q[1] + dy]);
      } else {
        ring = drag.startRing.map((q) => [q[0], q[1]]);
        ring[drag.vertexIndex] = [
          snapToHalf(planPoint[0]),
          snapToHalf(planPoint[1]),
        ];
      }
      setSlabHoleDraft({
        slabId: drag.slabId,
        holeIndex: drag.holeIndex,
        ring,
      });
    };

    const commit = (event: PointerEvent) => {
      const drag = slabHoleDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const slab = slabById.get(drag.slabId);
      const draft = slabHoleDraft;
      if (slab && draft && draft.ring.length >= 3) {
        const nextHoles = (slab.holes ?? []).map((h, i) =>
          i === draft.holeIndex ? draft.ring : h,
        );
        updateNode(slab.id, { holes: nextHoles });
        // updateNode clears the selection, so adjusting one corner of a cut
        // dropped the slab and you had to reselect it before the next nudge.
        // The ceiling hole editor re-asserts for the same reason.
        setSelection({ selectedIds: [slab.id] });
        sfxEmitter.emit("sfx:structure-build");
      }
      slabHoleDragRef.current = null;
      setSlabHoleDraft(null);
    };

    const cancel = (event: PointerEvent) => {
      const drag = slabHoleDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      slabHoleDragRef.current = null;
      setSlabHoleDraft(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", commit);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [
    getPlanPointFromClientPoint,
    setSelection,
    slabById,
    slabHoleDraft,
    updateNode,
  ]);

  const handleSiteVertexPointerDown = useCallback(
    (
      siteId: SiteNode["id"],
      vertexIndex: number,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setHoveredSiteHandleId(null);

      if (!(displaySitePolygon && displaySitePolygon.site.id === siteId)) {
        return;
      }

      const vertexPoint = displaySitePolygon.polygon[vertexIndex];
      if (!vertexPoint) {
        return;
      }

      setSiteBoundaryDraft({
        siteId,
        polygon: displaySitePolygon.polygon.map(toWallPlanPoint),
      });
      setSiteVertexDragState({
        pointerId: event.pointerId,
        siteId,
        vertexIndex,
      });
      setCursorPoint(toWallPlanPoint(vertexPoint));
    },
    [displaySitePolygon],
  );
  const handleSiteVertexDoubleClick = useCallback(
    (
      siteId: SiteNode["id"],
      vertexIndex: number,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (!(
        site &&
        site.id === siteId &&
        (site.polygon?.points?.length ?? 0) > 3
      )) {
        return;
      }

      siteBoundaryDraftRef.current = null;
      clearSiteBoundaryInteraction();

      updateNode(siteId, {
        polygon: {
          type: "polygon",
          points: site.polygon.points.filter(
            (_, index) => index !== vertexIndex,
          ),
        },
      });
    },
    [clearSiteBoundaryInteraction, site, updateNode],
  );
  const handleSiteMidpointPointerDown = useCallback(
    (
      siteId: SiteNode["id"],
      edgeIndex: number,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setHoveredSiteHandleId(null);

      if (!(displaySitePolygon && displaySitePolygon.site.id === siteId)) {
        return;
      }

      const basePolygon = displaySitePolygon.polygon.map(toWallPlanPoint);
      const startPoint = basePolygon[edgeIndex];
      const endPoint = basePolygon[(edgeIndex + 1) % basePolygon.length];
      if (!(startPoint && endPoint)) {
        return;
      }

      const insertedPoint: WallPlanPoint = [
        (startPoint[0] + endPoint[0]) / 2,
        (startPoint[1] + endPoint[1]) / 2,
      ];
      const insertIndex = edgeIndex + 1;
      const nextPolygon = [
        ...basePolygon.slice(0, insertIndex),
        insertedPoint,
        ...basePolygon.slice(insertIndex),
      ];

      setSiteBoundaryDraft({
        siteId,
        polygon: nextPolygon,
      });
      setSiteVertexDragState({
        pointerId: event.pointerId,
        siteId,
        vertexIndex: insertIndex,
      });
      setCursorPoint(insertedPoint);
    },
    [displaySitePolygon],
  );
  const handleZoneVertexPointerDown = useCallback(
    (
      zoneId: ZoneNodeType["id"],
      vertexIndex: number,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setHoveredZoneHandleId(null);

      const zoneEntry = displayZonePolygons.find(
        ({ zone }) => zone.id === zoneId,
      );
      const vertexPoint = zoneEntry?.polygon[vertexIndex];
      if (!(zoneEntry && vertexPoint)) {
        return;
      }

      setZoneBoundaryDraft({
        zoneId,
        polygon: zoneEntry.polygon.map(toWallPlanPoint),
      });
      setZoneVertexDragState({
        pointerId: event.pointerId,
        zoneId,
        vertexIndex,
      });
      setCursorPoint(toWallPlanPoint(vertexPoint));
    },
    [displayZonePolygons],
  );
  const handleZoneVertexDoubleClick = useCallback(
    (
      zoneId: ZoneNodeType["id"],
      vertexIndex: number,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const zone = zoneById.get(zoneId);
      if (!(zone && zone.polygon.length > 3)) {
        return;
      }

      zoneBoundaryDraftRef.current = null;
      clearZoneBoundaryInteraction();

      updateNode(zoneId, {
        polygon: zone.polygon.filter((_, index) => index !== vertexIndex),
      });
    },
    [clearZoneBoundaryInteraction, updateNode, zoneById],
  );
  const handleZoneMidpointPointerDown = useCallback(
    (
      zoneId: ZoneNodeType["id"],
      edgeIndex: number,
      event: ReactPointerEvent<SVGCircleElement>,
    ) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setHoveredZoneHandleId(null);

      const zoneEntry = displayZonePolygons.find(
        ({ zone }) => zone.id === zoneId,
      );
      if (!zoneEntry) {
        return;
      }

      const basePolygon = zoneEntry.polygon.map(toWallPlanPoint);
      const startPoint = basePolygon[edgeIndex];
      const endPoint = basePolygon[(edgeIndex + 1) % basePolygon.length];
      if (!(startPoint && endPoint)) {
        return;
      }

      const insertedPoint: WallPlanPoint = [
        (startPoint[0] + endPoint[0]) / 2,
        (startPoint[1] + endPoint[1]) / 2,
      ];
      const insertIndex = edgeIndex + 1;
      const nextPolygon = [
        ...basePolygon.slice(0, insertIndex),
        insertedPoint,
        ...basePolygon.slice(insertIndex),
      ];

      setZoneBoundaryDraft({
        zoneId,
        polygon: nextPolygon,
      });
      setZoneVertexDragState({
        pointerId: event.pointerId,
        zoneId,
        vertexIndex: insertIndex,
      });
      setCursorPoint(insertedPoint);
    },
    [displayZonePolygons],
  );

  const handlePointerLeave = useCallback(() => {
    if (!(
      panStateRef.current ||
      wallEndpointDragRef.current ||
      siteVertexDragState ||
      slabVertexDragState ||
      zoneVertexDragState
    )) {
      setCursorPoint(null);
    }
    setHoveredOpeningId(null);
    setHoveredWallId(null);
    setHoveredEndpointId(null);
    setHoveredSiteHandleId(null);
    setHoveredSlabHandleId(null);
    setHoveredZoneHandleId(null);
    if (hoveredWallIdRef.current) {
      emitFloorplanWallLeave(hoveredWallIdRef.current);
      hoveredWallIdRef.current = null;
    }
  }, [
    emitFloorplanWallLeave,
    siteVertexDragState,
    slabVertexDragState,
    zoneVertexDragState,
  ]);

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
        const rect = event.currentTarget.getBoundingClientRect();
        setFloorplanCursorPosition({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      } else {
        setFloorplanCursorPosition(null);
      }

      handlePointerMove(event);
    },
    [
      activeFloorplanCursorIndicator,
      handlePointerMove,
      siteVertexDragState,
      slabVertexDragState,
      zoneVertexDragState,
    ],
  );

  const handleSvgPointerLeave = useCallback(() => {
    setFloorplanCursorPosition(null);
    setHoveredGuideCorner(null);
    handlePointerLeave();
  }, [handlePointerLeave]);

  const handleMarqueePointerDown = useCallback(
    (event: ReactPointerEvent<SVGRectElement>) => {
      if (event.button !== 0) {
        return;
      }

      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const rect = svgRef.current?.getBoundingClientRect();
      if (rect) {
        setFloorplanCursorPosition({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      }
      setHoveredOpeningId(null);
      setHoveredWallId(null);
      setHoveredEndpointId(null);
      setFloorplanMarqueeState({
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPlanPoint: planPoint,
        currentPlanPoint: planPoint,
      });

      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [getPlanPointFromClientPoint],
  );

  // ── Symbol drag-and-drop (from sidebar SymbolCatalog) ──
  // The SVG canvas accepts drops carrying FLOORPLAN_SYMBOL_MIME. Each drop
  // creates a real ItemNode in the current level so it shows up in the export
  // JSON's `furniture[]` and behaves like any other selectable scene element.
  // Sensible per-category default dimensions; user can resize via the existing
  // item controls. y=0 = floor level (Pascal's level frame is X-Z, Y-up).
  const handleSymbolDragOver = useCallback(
    (event: React.DragEvent<SVGSVGElement>) => {
      if (event.dataTransfer.types.includes(FLOORPLAN_SYMBOL_MIME)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    },
    [],
  );

  const handleSymbolDrop = useCallback(
    (event: React.DragEvent<SVGSVGElement>) => {
      // Diagnostic: every drop reports what stage it reached. Remove once
      // drag-drop is confirmed working end-to-end.
      const _dbg = (stage: string, extra?: unknown) =>
        // eslint-disable-next-line no-console
        console.log("[symbol-drop]", stage, extra ?? "");

      const raw = event.dataTransfer.getData(FLOORPLAN_SYMBOL_MIME);
      const types = Array.from(event.dataTransfer.types);
      _dbg("fired", { mimeTypes: types, hasFloorplanMime: !!raw });
      if (!raw) {
        _dbg(
          "bailed: no FLOORPLAN_SYMBOL_MIME payload (drag source mismatch?)",
        );
        return;
      }
      event.preventDefault();

      type SymbolPayload = {
        id: string;
        label: string;
        src: string;
        category?: string;
      };
      let dropped: SymbolPayload;
      try {
        dropped = JSON.parse(raw) as SymbolPayload;
      } catch (err) {
        _dbg("bailed: JSON parse failed", err);
        return;
      }
      if (!dropped?.src) {
        _dbg("bailed: payload missing src", dropped);
        return;
      }

      if (!levelId) {
        _dbg(
          "bailed: no active levelId — select a level in the sidebar tree first",
        );
        return;
      }

      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) {
        _dbg("bailed: getPlanPointFromClientPoint returned null", {
          x: event.clientX,
          y: event.clientY,
        });
        return;
      }
      _dbg("proceeding", {
        levelId,
        planPoint,
        category: dropped.category,
        id: dropped.id,
      });

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
      };
      const dims = DEFAULT_DIMS[dropped.category ?? ""] ?? [0.8, 0.8, 0.8];

      try {
        const itemNode = ItemNode.parse({
          parentId: levelId,
          position: [planPoint[0], 0, planPoint[1]],
          asset: {
            id: dropped.id,
            category: dropped.category ?? "symbol",
            name: dropped.label,
            thumbnail: dropped.src,
            // No GLB yet — Pascal's item-renderer falls back to a placeholder
            // mesh; the SVG src is here for the future furniture-pipeline step.
            src: dropped.src,
            dimensions: dims,
          },
        });
        useScene.getState().createNode(itemNode, levelId as AnyNodeId);
        _dbg("CREATED item node", { id: itemNode.id });
      } catch (err) {
        _dbg("CREATE FAILED", err);
        console.warn("[floorplan] symbol drop failed:", err);
      }
    },
    [getPlanPointFromClientPoint, levelId],
  );

  const handleMarqueePointerMove = useCallback(
    (event: ReactPointerEvent<SVGRectElement>) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (rect) {
        setFloorplanCursorPosition({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      }

      if (floorplanMarqueeState?.pointerId !== event.pointerId) {
        return;
      }

      const planPoint = getPlanPointFromClientPoint(
        event.clientX,
        event.clientY,
      );
      if (!planPoint) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      setFloorplanMarqueeState((currentState) => {
        if (!currentState || currentState.pointerId !== event.pointerId) {
          return currentState;
        }

        return {
          ...currentState,
          currentPlanPoint: planPoint,
        };
      });
    },
    [floorplanMarqueeState?.pointerId, getPlanPointFromClientPoint],
  );

  const handleMarqueePointerUp = useCallback(
    (event: ReactPointerEvent<SVGRectElement>) => {
      const marqueeState = floorplanMarqueeState;
      if (!marqueeState || marqueeState.pointerId !== event.pointerId) {
        return;
      }

      const endPlanPoint =
        getPlanPointFromClientPoint(event.clientX, event.clientY) ??
        marqueeState.currentPlanPoint;
      const modifierKeys = getSelectionModifierKeys(event);
      const dragDistance = Math.hypot(
        event.clientX - marqueeState.startClientX,
        event.clientY - marqueeState.startClientY,
      );

      event.preventDefault();
      event.stopPropagation();

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (dragDistance >= FLOORPLAN_MARQUEE_DRAG_THRESHOLD_PX) {
        const bounds = getFloorplanSelectionBounds(
          marqueeState.startPlanPoint,
          endPlanPoint,
        );
        const nextSelectedIds = getFloorplanSelectionIdsInBounds(bounds);
        addFloorplanSelection(nextSelectedIds, modifierKeys);
      } else {
        const hitId = getFloorplanHitIdAtPoint(endPlanPoint);

        if (hitId) {
          // Ritn3D: delete mode — delete clicked node directly
          if (useEditor.getState().mode === "delete") {
            const node = useScene.getState().nodes[hitId as AnyNodeId];
            if (node) {
              sfxEmitter.emit("sfx:structure-delete");
              const parentId = node.parentId;
              useScene.getState().deleteNode(hitId as AnyNodeId);
              if (parentId)
                useScene.getState().dirtyNodes.add(parentId as AnyNodeId);
            }
          } else {
            toggleFloorplanSelection(hitId, modifierKeys);
          }
        } else if (!(modifierKeys.meta || modifierKeys.ctrl)) {
          commitFloorplanSelection([]);
        }
      }

      setFloorplanMarqueeState(null);
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
  );

  const handleMarqueePointerCancel = useCallback(
    (event: ReactPointerEvent<SVGRectElement>) => {
      if (floorplanMarqueeState?.pointerId !== event.pointerId) {
        return;
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      setFloorplanMarqueeState(null);
      setFloorplanCursorPosition(null);
    },
    [floorplanMarqueeState?.pointerId],
  );

  useEffect(() => {
    if (!isMarqueeSelectionToolActive) {
      setFloorplanMarqueeState(null);
      return;
    }

    setFloorplanCursorPosition(null);
    setHoveredOpeningId(null);
    setHoveredWallId(null);
    setHoveredEndpointId(null);
  }, [isMarqueeSelectionToolActive]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }

    const getFallbackClientPoint = () => {
      const rect = svg.getBoundingClientRect();
      return {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
    };

    const handleNativeWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const widthFactor = Math.exp(
        event.deltaY * (event.ctrlKey ? 0.003 : 0.0015),
      );
      zoomViewportAtClientPoint(event.clientX, event.clientY, widthFactor);
    };

    const handleGestureStart = (event: Event) => {
      const gestureEvent = event as GestureLikeEvent;
      gestureScaleRef.current = gestureEvent.scale ?? 1;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleGestureChange = (event: Event) => {
      const gestureEvent = event as GestureLikeEvent;
      const nextScale = gestureEvent.scale ?? 1;
      const previousScale = gestureScaleRef.current || 1;
      const widthFactor = previousScale / nextScale;
      const fallbackClientPoint = getFallbackClientPoint();

      zoomViewportAtClientPoint(
        gestureEvent.clientX ?? fallbackClientPoint.clientX,
        gestureEvent.clientY ?? fallbackClientPoint.clientY,
        widthFactor,
      );

      gestureScaleRef.current = nextScale;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleGestureEnd = (event: Event) => {
      gestureScaleRef.current = 1;
      event.preventDefault();
      event.stopPropagation();
    };

    svg.addEventListener("wheel", handleNativeWheel, { passive: false });
    svg.addEventListener("gesturestart", handleGestureStart, {
      passive: false,
    });
    svg.addEventListener("gesturechange", handleGestureChange, {
      passive: false,
    });
    svg.addEventListener("gestureend", handleGestureEnd, { passive: false });

    return () => {
      svg.removeEventListener("wheel", handleNativeWheel);
      svg.removeEventListener("gesturestart", handleGestureStart);
      svg.removeEventListener("gesturechange", handleGestureChange);
      svg.removeEventListener("gestureend", handleGestureEnd);
    };
  }, [zoomViewportAtClientPoint]);

  const restoreGroundLevelStructureSelection = useCallback(() => {
    const sceneNodes = useScene.getState().nodes;
    const nextBuildingId =
      currentBuildingId ??
      site?.children
        .map((child) =>
          typeof child === "string" ? sceneNodes[child as AnyNodeId] : child,
        )
        .find((node): node is BuildingNode => node?.type === "building")?.id ??
      null;

    const nextGroundLevelId =
      nextBuildingId && nextBuildingId === currentBuildingId
        ? (floorplanLevels.find((level) => level.level === 0)?.id ??
          floorplanLevels[0]?.id ??
          (levelNode?.type === "level" ? levelNode.id : null))
        : (() => {
            if (!nextBuildingId) {
              return null;
            }

            const buildingNode = sceneNodes[nextBuildingId];
            if (!buildingNode || buildingNode.type !== "building") {
              return null;
            }

            const buildingLevels = buildingNode.children
              .map((child) =>
                typeof child === "string"
                  ? sceneNodes[child as AnyNodeId]
                  : child,
              )
              .filter((node): node is LevelNode => node?.type === "level")
              .sort((a, b) => a.level - b.level);

            return (
              buildingLevels.find((level) => level.level === 0)?.id ??
              buildingLevels[0]?.id ??
              null
            );
          })();

    setPhase("structure");
    setStructureLayer("elements");
    setMode("select");

    const nextSelection: Parameters<typeof setSelection>[0] = {
      selectedIds: [],
      zoneId: null,
    };

    if (nextBuildingId) {
      nextSelection.buildingId = nextBuildingId;
    }

    if (nextGroundLevelId) {
      nextSelection.levelId = nextGroundLevelId;
    }

    setSelection(nextSelection);
  }, [
    currentBuildingId,
    floorplanLevels,
    levelNode,
    setMode,
    setPhase,
    setSelection,
    setStructureLayer,
    site,
  ]);
  const handleFloorplanSelectionToolChange = useCallback(
    (nextTool: FloorplanSelectionTool) => {
      setFloorplanSelectionTool(nextTool);

      if (phase === "site") {
        restoreGroundLevelStructureSelection();
        return;
      }

      if (mode !== "select") {
        setMode("select");
      }
    },
    [mode, phase, restoreGroundLevelStructureSelection, setMode],
  );
  const handleQuickBuildToolSelect = useCallback(
    (nextTool: FloorplanQuickBuildTool) => {
      setPhase("structure");
      setStructureLayer(nextTool === "zone" ? "zones" : "elements");
      setMode("build");
      setTool(nextTool);
      setCatalogCategory(null);
    },
    [setCatalogCategory, setMode, setPhase, setStructureLayer, setTool],
  );
  const handleSiteEditShortcutSelect = useCallback(() => {
    if (!(levelNode?.type === "level" && levelNode.level === 0)) {
      return;
    }

    if (isSiteEditShortcutActive) {
      restoreGroundLevelStructureSelection();
      return;
    }

    setPhase("site");
    setMode("edit");

    if (currentBuildingId) {
      setSelection({
        buildingId: currentBuildingId,
        levelId: levelNode.id,
        selectedIds: [],
        zoneId: null,
      });
      return;
    }

    setSelection({
      levelId: levelNode.id,
      selectedIds: [],
      zoneId: null,
    });
  }, [
    currentBuildingId,
    isSiteEditShortcutActive,
    levelNode,
    setMode,
    setPhase,
    setSelection,
    restoreGroundLevelStructureSelection,
  ]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditableTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        Boolean(target?.isContentEditable);

      if (
        isEditableTarget ||
        !isFloorplanHovered ||
        phase !== "site" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.toLowerCase() !== "v"
      ) {
        return;
      }

      setFloorplanSelectionTool("click");
      restoreGroundLevelStructureSelection();
    };

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isFloorplanHovered, phase, restoreGroundLevelStructureSelection]);
  const activeDraftAnchorPoint =
    draftStart ?? activePolygonDraftPoints[0] ?? null;
  const floorplanCursorColor = wallEndpointDraft
    ? palette.editCursor
    : activeDraftAnchorPoint
      ? palette.draftStroke
      : palette.cursor;

  return (
    <div
      className="pointer-events-auto fixed z-10 flex flex-col overflow-hidden bg-background"
      onPointerEnter={() => setFloorplanHovered(true)}
      onPointerLeave={() => {
        setFloorplanHovered(false);
        setFloorplanCursorPosition(null);
      }}
      style={{
        cursor: activeResizeDirection
          ? resizeCursorByDirection[activeResizeDirection]
          : undefined,
        inset: 0,
        visibility: isPanelReady ? "visible" : "hidden",
      }}
    >
      {/* Freehand-snap hint — when wall/arc-wall build is active and NO shift
          is currently held, show a subtle bottom-right chip advertising the
          Shift-for-freehand shortcut. Critical for tracing scanned plans
          where walls fall between grid nodes. */}
      {(tool === "wall" || tool === "arc-wall") &&
        mode === "build" &&
        orthoActive && (
          <div className="pointer-events-none fixed bottom-4 right-4 z-30 rounded-[5px] border border-hair bg-paper/90 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.05em] text-ink/55 backdrop-blur-sm">
            Hold Shift for freehand · off-grid
          </div>
        )}

      {/* Ritn3D 2026-08-01: arc-wall opening block, made visible.
          Placing a door/window on a curved wall is rejected (see the
          pointer-up handler). It used to fail silently, which reads as a
          broken tool -- a trial user reported exactly that. Now we say
          what happened and what to do instead. */}
      {arcOpeningBlocked && isOpeningBuildActive && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2.5 rounded-[6px] border border-amber-300/70 bg-amber-50/95 px-3.5 py-2 text-amber-900 shadow-sm backdrop-blur-sm">
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
            className="shrink-0"
          >
            <circle
              cx="7"
              cy="7"
              r="5.75"
              stroke="currentColor"
              strokeWidth="1.15"
            />
            <path
              d="M7 4V7.5"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
            <circle cx="7" cy="9.9" r="0.6" fill="currentColor" />
          </svg>
          <span className="text-[12.5px] leading-tight tracking-[-0.005em]">
            {tool === "door" ? "Doors" : "Windows"} can&rsquo;t be placed on
            curved walls yet — place it on a straight wall.
          </span>
        </div>
      )}

      {/* Arc-wall hint: shown briefly after the user places a straight wall
          with the Arc Wall tool. Tells them how to bend it. Disappears once
          they touch the bulge handle or pick another tool. Uses the same
          visual treatment as the scale-calibration banner. */}
      {tool === "arc-wall" && !arcDraftStart && wallBulgeHandles.length > 0 && (
        <div
          className="pointer-events-none fixed inset-x-0 top-0 z-40 flex items-center justify-center gap-3 border-b border-hair bg-paper/95 px-4 py-2.5 text-ink/70 backdrop-blur-md"
          style={{ paddingLeft: "320px" }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 28 28"
            fill="none"
            aria-hidden="true"
            className="text-[var(--color-accent)]"
          >
            <path
              d="M5 22 Q 14 2 23 22"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <circle cx="5" cy="22" r="2.5" fill="currentColor" />
            <circle cx="23" cy="22" r="2.5" fill="currentColor" />
          </svg>
          <span className="font-medium text-[13px] tracking-[-0.005em]">
            Drag the blue dot at the wall's middle to bend it into a curve.
          </span>
        </div>
      )}

      {/* Scale calibration banner — paper / ink system banner, ink fill so it
          reads as a top-of-app alert. Webapp aesthetic: ink bar with paper
          text, hairline accent stroke, mono caps for the inline action. */}
      {calibration && (
        <div
          className="pointer-events-auto fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 bg-ink px-4 py-3 text-paper shadow-[0_4px_12px_rgba(22,24,28,0.12)]"
          style={{ paddingLeft: "320px" }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="text-[var(--color-accent)] opacity-90"
          >
            <path d="M3 21h18" />
            <path d="M6 18 L 18 6" />
            <path d="M5 17 l 2 2 M 9 13 l 2 2 M 13 9 l 2 2 M 17 5 l 2 2" />
          </svg>
          {/* Guidance matters more than the mechanics here: the failure mode
              is not "user can't click twice", it's picking a span they can't
              actually go and measure. Naming the two things that work — the
              building's full width, or a wall already dimensioned on the
              plan — is what makes the number they type trustworthy. A longer
              span also dilutes endpoint error proportionally. */}
          <span className="font-medium text-[13.5px] tracking-[-0.005em]">
            {!calibrationP1 &&
              "Set scale: click two points you know the real distance between — the full width of the building, or a wall with a dimension printed on the plan."}
            {calibrationP1 && !calibrationP2 && "Now click the second point."}
            {calibrationP1 &&
              calibrationP2 &&
              "Enter the real distance to finish — or click again to redo."}
          </span>
          <button
            type="button"
            onClick={() => {
              setCalibration(null);
              setCalibrationP1(null);
              setCalibrationP2(null);
              setCalibrationInput("");
            }}
            className="ml-2 rounded-[5px] border border-paper/20 bg-transparent px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.05em] text-paper/80 hover:bg-paper/10 hover:text-paper"
          >
            Skip · Esc
          </button>
        </div>
      )}

      {/* Canvas scale bar — fixed overlay at bottom-left. Picks the nearest
          "nice" length (1, 2, 5, 10, 20, 50, 100 m, etc.) that maps to
          roughly 80-150 screen pixels at the current zoom. Updates live
          with zoom/pan. */}
      {surfaceSize.width > 0 &&
        (() => {
          const pixelsPerMeter = surfaceSize.width / viewBox.width;
          if (!Number.isFinite(pixelsPerMeter) || pixelsPerMeter <= 0)
            return null;
          const TARGET_PX = 100;
          // Round to a 1-2-5 sequence (architectural / map convention).
          const rawMeters = TARGET_PX / pixelsPerMeter;
          const pow10 = Math.pow(10, Math.floor(Math.log10(rawMeters)));
          const mantissa = rawMeters / pow10;
          const niceMantissa =
            mantissa < 1.5 ? 1 : mantissa < 3.5 ? 2 : mantissa < 7.5 ? 5 : 10;
          const lengthMeters = niceMantissa * pow10;
          const widthPx = lengthMeters * pixelsPerMeter;
          const isImperial = unit === "imperial";
          const labelValue = isImperial ? lengthMeters * 3.28084 : lengthMeters;
          const labelDigits = labelValue >= 10 ? 0 : 1;
          const label = `${labelValue.toFixed(labelDigits)} ${isImperial ? "ft" : "m"}`;
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
          );
        })()}

      {/* Ritn3D: resize handles hidden — fullscreen mode */}
      {false &&
        resizeHandleConfigurations.map((handle) => (
          <div
            aria-hidden="true"
            className={handle.className}
            key={handle.direction}
            onPointerDown={(event) =>
              handleResizeStart(handle.direction, event)
            }
          />
        ))}

      {/* Ritn3D: top bar hidden — fullscreen 2D mode, tools in bottom toolbar */}
      <div className="hidden" onPointerDown={handlePanelDragStart}>
        <div className="flex min-w-0 items-center pr-3">
          <div
            className="min-w-0"
            data-floorplan-panel-control="true"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu
              modal={false}
              onOpenChange={(open) => {
                clearLevelMenuCloseTimeout();
                setIsLevelMenuOpen(hasFloorplanLevelSwitcher ? open : false);
              }}
              open={isLevelMenuOpen}
            >
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    "group/level-switcher flex min-w-0 items-center gap-2 rounded-xl border border-border/45 bg-background/92 py-1 pr-2 pl-1.5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.04)] transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none",
                    hasFloorplanLevelSwitcher
                      ? "hover:border-border/60 hover:bg-background focus-visible:border-border/60 focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-border/60"
                      : "cursor-default",
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
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-[transform,opacity,color] duration-150",
                        isLevelMenuOpen
                          ? "rotate-180 text-foreground/70 opacity-100"
                          : "opacity-45 group-hover/level-switcher:opacity-70 group-focus-visible/level-switcher:opacity-70",
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
                    value={levelId ?? ""}
                  >
                    {floorplanLevels.map((level) => (
                      <DropdownMenuRadioItem
                        className="rounded-lg py-2 pr-3 pl-8 data-[state=checked]:bg-accent/60"
                        key={level.id}
                        value={level.id}
                      >
                        <span className="truncate">
                          {getLevelDisplayLabel(level)}
                        </span>
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
                    aria-label={
                      isSiteEditShortcutActive
                        ? "Exit site editing"
                        : "Edit site"
                    }
                    aria-pressed={isSiteEditShortcutActive}
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-lg transition-[background-color,filter,opacity,transform] duration-200 active:scale-[0.96]",
                      isSiteEditShortcutActive
                        ? "bg-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                        : canUseSiteEditShortcut
                          ? "opacity-75 grayscale hover:bg-accent hover:opacity-100 hover:grayscale-0"
                          : "cursor-not-allowed opacity-35 grayscale",
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
                    ? "Exit site editing"
                    : "Edit site"
                  : "Site editing is only available on ground level"}
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center rounded-xl border border-border/45 bg-background/92 p-1 shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.04)]">
            <Popover
              onOpenChange={setIsGuideQuickAccessOpen}
              open={isGuideQuickAccessOpen}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={
                      showGuides ? "Hide guide images" : "Show guide images"
                    }
                    aria-pressed={showGuides}
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-lg transition-[background-color,filter,opacity,transform] duration-200 active:scale-[0.96]",
                      showGuides
                        ? "bg-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                        : hasGuideImages
                          ? "opacity-75 grayscale hover:bg-accent hover:opacity-100 hover:grayscale-0"
                          : "opacity-45 grayscale hover:bg-accent/60 hover:opacity-70",
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
                  {showGuides ? "Hide guide images" : "Show guide images"}
                </TooltipContent>
              </Tooltip>

              <span
                aria-hidden="true"
                className="mx-0.5 h-5 w-px bg-border/50"
              />

              <PopoverTrigger asChild>
                <button
                  aria-expanded={isGuideQuickAccessOpen}
                  aria-haspopup="dialog"
                  aria-label="Adjust guide image opacity"
                  className={cn(
                    "flex h-8 w-7 items-center justify-center rounded-lg transition-[background-color,opacity,transform] duration-200 active:scale-[0.96]",
                    isGuideQuickAccessOpen
                      ? "bg-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                      : hasGuideImages
                        ? "opacity-75 hover:bg-accent hover:opacity-100"
                        : "opacity-45 hover:bg-accent/60 hover:opacity-70",
                  )}
                  type="button"
                >
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 transition-[transform,opacity,color] duration-150",
                      isGuideQuickAccessOpen
                        ? "rotate-180 text-foreground/70 opacity-100"
                        : "text-muted-foreground opacity-70",
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
                      <p className="font-medium text-foreground text-sm">
                        Guide images
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {guideImagesDescription}
                      </p>
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
                            onChange={(value) =>
                              handleGuideOpacityChange(guide.id, value)
                            }
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

          {/* Level switcher. Same pill as the tool strip beside it so it reads
              as part of the canvas furniture rather than a panel. Ground floor
              is "G" because that is what people call it; everything above is
              its storey number. */}
          {levelsOnBuilding.length > 0 && (
            <div className="flex items-center gap-1 rounded-xl border border-border/45 bg-background/92 p-1 shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.04)]">
              {levelsOnBuilding.map((lvl) => {
                const isActive = lvl.id === levelId;
                const number = lvl.level ?? 0;
                return (
                  <Tooltip key={lvl.id}>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={`Show level ${number}`}
                        aria-pressed={isActive}
                        className={cn(
                          "flex h-8 min-w-8 items-center justify-center rounded-lg px-2 font-medium text-[12px] transition-[background-color,opacity,transform] duration-200 active:scale-[0.96]",
                          isActive
                            ? "bg-accent text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                            : "text-muted-foreground opacity-75 hover:bg-accent hover:opacity-100",
                        )}
                        onClick={() => handleSelectLevel(lvl.id)}
                        type="button"
                      >
                        {number === 0 ? "G" : number}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={8}>
                      {lvl.name ||
                        (number === 0 ? "Ground floor" : `Level ${number}`)}
                    </TooltipContent>
                  </Tooltip>
                );
              })}

              <div
                aria-hidden="true"
                className="mx-0.5 h-5 w-px bg-border/45"
              />

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label="Add a level above"
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground opacity-75 transition-[background-color,opacity,transform] duration-200 hover:bg-accent hover:opacity-100 active:scale-[0.96]"
                    onClick={handleAddLevel}
                    type="button"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={8}>
                  Add a level above
                </TooltipContent>
              </Tooltip>
            </div>
          )}

          <div className="flex items-center gap-1 rounded-xl border border-border/45 bg-background/92 p-1 shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.04)]">
            {FLOORPLAN_QUICK_BUILD_TOOLS.map((quickTool) => {
              const isActive =
                phase === "structure" &&
                mode === "build" &&
                tool === quickTool.id;

              return (
                <Tooltip key={quickTool.id}>
                  <TooltipTrigger asChild>
                    <button
                      aria-label={`Activate ${quickTool.label.toLowerCase()} tool`}
                      aria-pressed={isActive}
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-lg transition-[background-color,filter,opacity,transform] duration-200 active:scale-[0.96]",
                        isActive
                          ? "bg-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                          : "opacity-75 grayscale hover:bg-accent hover:opacity-100 hover:grayscale-0",
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
              );
            })}
          </div>

          <div
            className={cn(
              "flex items-center gap-1 rounded-xl border border-border/45 bg-background/92 p-1 shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.04)]",
              mode !== "select" && "opacity-60",
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label="Click select"
                  aria-pressed={floorplanSelectionTool === "click"}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-lg transition-[background-color,transform] duration-200 active:scale-[0.96]",
                    floorplanSelectionTool === "click"
                      ? "bg-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                      : "hover:bg-accent",
                  )}
                  onClick={() => handleFloorplanSelectionToolChange("click")}
                  type="button"
                >
                  <img
                    alt=""
                    aria-hidden="true"
                    className={cn(
                      "h-[18px] w-[18px] object-contain transition-[opacity,filter] duration-200",
                      floorplanSelectionTool === "click"
                        ? "opacity-100 grayscale-0"
                        : "opacity-60 grayscale",
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
                  aria-pressed={floorplanSelectionTool === "marquee"}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-200 active:scale-[0.96]",
                    floorplanSelectionTool === "marquee"
                      ? "bg-accent text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                      : "hover:bg-accent hover:text-foreground",
                  )}
                  onClick={() => handleFloorplanSelectionToolChange("marquee")}
                  type="button"
                >
                  <Icon
                    color="currentColor"
                    height={18}
                    icon="mdi:select-drag"
                    width={18}
                  />
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
        <div
          className="absolute top-3 right-3 z-20 pointer-events-none flex flex-col items-center"
          style={{ opacity: 0.6 }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <polygon points="12,2 15,10 12,8 9,10" fill="#ef4444" />
            <polygon points="12,22 9,14 12,16 15,14" fill="#94a3b8" />
            <line
              x1="12"
              y1="2"
              x2="12"
              y2="22"
              stroke="#64748b"
              strokeWidth="0.5"
            />
          </svg>
          <span
            style={{
              fontSize: "8px",
              fontWeight: 700,
              color: "#ef4444",
              marginTop: "1px",
              letterSpacing: "0.5px",
            }}
          >
            N
          </span>
        </div>

        {/* Ritn3D 2026-06-18: suppress the floating tool-icon card while the
            door/window ghost is already showing what will be placed —
            otherwise the icon covers the ghost. Icon still shows in the
            same tool when hovering off any wall so users can see the mode. */}
        {activeFloorplanCursorIndicator &&
          floorplanCursorPosition &&
          !isPanning &&
          !openingPreview && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-20 flex h-8 w-8 items-center justify-center rounded-xl border border-white/5 bg-zinc-900/95 shadow-[0_8px_16px_-4px_rgba(0,0,0,0.3),0_4px_8px_-4px_rgba(0,0,0,0.2)]"
              style={{
                left:
                  floorplanCursorPosition.x +
                  FLOORPLAN_CURSOR_INDICATOR_OFFSET_X,
                top:
                  floorplanCursorPosition.y +
                  FLOORPLAN_CURSOR_INDICATOR_OFFSET_Y,
              }}
            >
              {activeFloorplanCursorIndicator.kind === "asset" ? (
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
            isDarkMode={theme === "dark"}
            isMacPlatform={isMacPlatform}
            rotationModifierPressed={rotationModifierPressed}
          />
        )}
        {selectedOpeningActionMenuPosition &&
          isFloorplanHovered &&
          !movingNode && (
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

        {!levelNode && phase !== "site" ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-muted-foreground text-sm">
            Switch to a building level to view and edit the floorplan.
          </div>
        ) : (
          <svg
            className="h-full w-full touch-none"
            data-floorplan-svg="true"
            onClick={
              isMarqueeSelectionToolActive ? undefined : handleBackgroundClick
            }
            onContextMenu={(event) => event.preventDefault()}
            onDoubleClick={
              isMarqueeSelectionToolActive
                ? undefined
                : handleBackgroundDoubleClick
            }
            onDragOver={handleSymbolDragOver}
            onDrop={handleSymbolDrop}
            onPointerCancel={(event) => {
              handleStairPointerUp(event);
              endPanning(event);
            }}
            onPointerDown={handlePointerDown}
            onPointerLeave={handleSvgPointerLeave}
            onPointerMove={(event) => {
              handleStairPointerMove(event);
              handleSvgPointerMove(event);
            }}
            onPointerUp={(event) => {
              handleStairPointerUp(event);
              endPanning(event);
            }}
            ref={svgRef}
            style={{
              cursor: isOpeningBuildActive ? "crosshair" : EDITOR_CURSOR,
            }}
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

            <FloorplanSiteLayer
              isEditing={isSiteEditActive}
              sitePolygon={visibleSitePolygon}
              unit={unit}
              showDimensions={isSiteEditActive}
            />

            {/* Ritn3D 2026-08-01: zones render BELOW the geometry layer.
                SVG hit-testing is top-down, so whatever renders last wins the
                click. With zones last, the room hit area covered every wall
                bounding it and those walls became unselectable — a user could
                only click walls that bounded no room.
                Rooms are areas and walls are precise targets, so walls must
                win. Zone labels sit at room centroids, which walls don't
                cover, so nothing is visually occluded by the swap. */}
            <FloorplanZoneLayer
              canSelectZones={canSelectFloorplanZones}
              onZoneSelect={handleZoneSelect}
              palette={palette}
              selectedZoneId={selectedZoneId}
              unit={unit}
              zonePolygons={visibleZonePolygons}
            />

            <FloorplanGeometryLayer
              canSelectGeometry={canSelectElementFloorplanGeometry}
              canSelectSlabs={
                canSelectElementFloorplanGeometry && structureLayer !== "zones"
              }
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
              stairPlans={stairPlans}
              ghost={
                levelBelowGhost
                  ? { walls: levelBelowGhost.walls, stairs: ghostStairPlans }
                  : null
              }
              onStairSelect={handleStairSelect}
              onStairPointerDown={handleStairPointerDown}
              unit={unit}
              wallPolygons={displayWallPolygons}
              worldUnitsPerPixel={floorplanWorldUnitsPerPixel}
            />

            <FloorplanPolygonHandleLayer
              hoveredHandleId={hoveredSiteHandleId}
              midpointHandles={siteMidpointHandles}
              onHandleHoverChange={setHoveredSiteHandleId}
              onMidpointPointerDown={(nodeId, edgeIndex, event) =>
                handleSiteMidpointPointerDown(
                  nodeId as SiteNode["id"],
                  edgeIndex,
                  event,
                )
              }
              onVertexDoubleClick={(nodeId, vertexIndex, event) =>
                handleSiteVertexDoubleClick(
                  nodeId as SiteNode["id"],
                  vertexIndex,
                  event,
                )
              }
              onVertexPointerDown={(nodeId, vertexIndex, event) =>
                handleSiteVertexPointerDown(
                  nodeId as SiteNode["id"],
                  vertexIndex,
                  event,
                )
              }
              palette={palette}
              vertexHandles={siteVertexHandles}
            />

            {isMarqueeSelectionToolActive && (
              <rect
                fill="transparent"
                height={viewBox.height}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
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
                {draftStart &&
                  draftEnd &&
                  (() => {
                    const dx = draftEnd[0] - draftStart[0];
                    const dz = draftEnd[1] - draftStart[1];
                    const length = Math.hypot(dx, dz);
                    if (length < 0.1) return null;
                    const angleDeg =
                      ((Math.atan2(-dz, dx) * 180) / Math.PI + 360) % 360;
                    const displayAngle =
                      angleDeg > 180 ? angleDeg - 360 : angleDeg;
                    const midX = toSvgX((draftStart[0] + draftEnd[0]) / 2);
                    const midY = toSvgY((draftStart[1] + draftEnd[1]) / 2);
                    const fontSize = getMeasureLabelFontSize();
                    const nx = -(-dz / length);
                    const ny = -(dx / length);
                    const offset = fontSize * 2.5;
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
                        {formatMeasurement(length, unit)} ·{" "}
                        {Math.abs(Math.round(displayAngle))}°
                      </text>
                    );
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
              const [w, , d] = item.asset.dimensions;
              const px = item.position[0];
              const pz = item.position[2];
              const yRotRad = item.rotation[1] ?? 0;
              const yRotDeg = (yRotRad * 180) / Math.PI;
              const svgC = toSvgPoint({ x: px, y: pz });
              const halfW = w / 2;
              const halfD = d / 2;
              const isSelected = selectedIdSet.has(item.id);
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
                    stroke={isSelected ? "#3b82f6" : "rgba(120,140,200,0.7)"}
                    strokeWidth={isSelected ? "0.05" : "0.03"}
                    vectorEffect="non-scaling-stroke"
                    style={{ cursor: "move" }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.stopPropagation();
                      // Select the item (replaces selection).
                      setSelection({ selectedIds: [item.id] });
                      // Start move drag.
                      const planPoint = getPlanPointFromClientPoint(
                        event.clientX,
                        event.clientY,
                      );
                      if (!planPoint) return;
                      itemMoveDragRef.current = {
                        pointerId: event.pointerId,
                        itemId: item.id,
                        startPlan: planPoint,
                        initialPos: [...item.position] as [
                          number,
                          number,
                          number,
                        ],
                      };
                      (event.currentTarget as Element).setPointerCapture?.(
                        event.pointerId,
                      );
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
                        y2={svgC.y - halfD - 0.5}
                        stroke="#3b82f6"
                        strokeWidth="2"
                        vectorEffect="non-scaling-stroke"
                      />
                      {/* Curved-arrow rotate icon under the dot so the affordance is obvious */}
                      <g
                        transform={`translate(${svgC.x} ${svgC.y - halfD - 0.5})`}
                        pointerEvents="none"
                      >
                        <circle
                          r="0.32"
                          fill="#3b82f6"
                          stroke="#fff"
                          strokeWidth="2"
                          vectorEffect="non-scaling-stroke"
                        />
                        <path
                          d="M -0.13 -0.05 A 0.16 0.16 0 1 1 -0.13 0.05"
                          fill="none"
                          stroke="#fff"
                          strokeWidth="2"
                          strokeLinecap="round"
                          vectorEffect="non-scaling-stroke"
                        />
                        <path
                          d="M -0.18 0.02 L -0.13 0.08 L -0.08 0.02"
                          fill="none"
                          stroke="#fff"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          vectorEffect="non-scaling-stroke"
                        />
                      </g>
                      <circle
                        cx={svgC.x}
                        cy={svgC.y - halfD - 0.5}
                        r="0.4"
                        fill="transparent"
                        style={{ cursor: "grab" }}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          event.stopPropagation();
                          const planPoint = getPlanPointFromClientPoint(
                            event.clientX,
                            event.clientY,
                          );
                          if (!planPoint) return;
                          const dx = planPoint[0] - px;
                          const dz = planPoint[1] - pz;
                          itemRotateDragRef.current = {
                            pointerId: event.pointerId,
                            itemId: item.id,
                            centerPlan: [px, pz],
                            initialRotY: yRotRad,
                            startAngleFromCenter: Math.atan2(dz, dx),
                          };
                          (event.currentTarget as Element).setPointerCapture?.(
                            event.pointerId,
                          );
                        }}
                      />
                    </>
                  )}
                </g>
              );
            })}

            <FloorplanWallEndpointLayer
              endpointHandles={wallEndpointHandles}
              hoveredEndpointId={hoveredEndpointId}
              onEndpointHoverChange={setHoveredEndpointId}
              onWallEndpointPointerDown={handleWallEndpointPointerDown}
              palette={palette}
            />

            {/* Ritn3D 2026-06-18: Door / window placement ghost. Shown when
                the user is in the door/window tool AND hovering over a wall.
                Semi-transparent rectangle centred on the projected point,
                oriented perpendicular to the wall's normal. Mirrors the
                AutoCAD 'insert' preview. Click commits — see the pointer-up
                handler upstream. */}
            {openingPreview &&
              isOpeningBuildActive &&
              (() => {
                const wall = wallById.get(openingPreview.wallId);
                if (!wall) return null;
                const [px, py] = openingPreview.point;
                const width =
                  tool === "door"
                    ? NEW_OPENING_WIDTH_M.door
                    : NEW_OPENING_WIDTH_M.window;
                const depth = (wall.thickness ?? DEFAULT_WALL_THICKNESS) + 0.06;
                const wallAngle = Math.atan2(
                  wall.end[1] - wall.start[1],
                  wall.end[0] - wall.start[0],
                );
                const cSvg = toSvgPoint({ x: px, y: py });
                const angleDeg = (wallAngle * 180) / Math.PI;
                const halfW = width / 2;
                const halfD = depth / 2;
                return (
                  <g
                    pointerEvents="none"
                    transform={`rotate(${angleDeg} ${cSvg.x} ${cSvg.y})`}
                  >
                    {/* Halo — semi-transparent wide fill to lift the ghost off the wall */}
                    <rect
                      x={cSvg.x - halfW - 0.06}
                      y={cSvg.y - halfD - 0.06}
                      width={width + 0.12}
                      height={depth + 0.12}
                      fill="#2f6dab"
                      fillOpacity="0.12"
                      rx="0.04"
                    />
                    {/* Opening rectangle — solid, high-contrast, straddling the wall */}
                    <rect
                      x={cSvg.x - halfW}
                      y={cSvg.y - halfD}
                      width={width}
                      height={depth}
                      fill="#2f6dab"
                      fillOpacity="0.55"
                      stroke="#1e4f80"
                      strokeWidth="0.09"
                      vectorEffect="non-scaling-stroke"
                    />
                    {/* Bold jamb ticks at both ends */}
                    <line
                      x1={cSvg.x - halfW}
                      y1={cSvg.y - halfD - 0.08}
                      x2={cSvg.x - halfW}
                      y2={cSvg.y + halfD + 0.08}
                      stroke="#1e4f80"
                      strokeWidth="0.14"
                      vectorEffect="non-scaling-stroke"
                      strokeLinecap="round"
                    />
                    <line
                      x1={cSvg.x + halfW}
                      y1={cSvg.y - halfD - 0.08}
                      x2={cSvg.x + halfW}
                      y2={cSvg.y + halfD + 0.08}
                      stroke="#1e4f80"
                      strokeWidth="0.14"
                      vectorEffect="non-scaling-stroke"
                      strokeLinecap="round"
                    />
                    {/* Door swing quarter-arc — solid line, bright */}
                    {tool === "door" && (
                      <path
                        d={`M ${cSvg.x - halfW} ${cSvg.y - halfD} A ${width} ${width} 0 0 1 ${cSvg.x + halfW} ${cSvg.y - halfD}`}
                        fill="none"
                        stroke="#2f6dab"
                        strokeOpacity="0.9"
                        strokeWidth="0.055"
                        strokeDasharray="0.16 0.10"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                    {/* Window centreline — bold dashed line inside the rect */}
                    {tool === "window" && (
                      <line
                        x1={cSvg.x - halfW}
                        y1={cSvg.y}
                        x2={cSvg.x + halfW}
                        y2={cSvg.y}
                        stroke="#1e4f80"
                        strokeWidth="0.06"
                        strokeDasharray="0.10 0.06"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                    {/* Centre anchor — larger, white-ringed, high contrast */}
                    <circle
                      cx={cSvg.x}
                      cy={cSvg.y}
                      r="0.11"
                      fill="#2f6dab"
                      stroke="#fff"
                      strokeWidth="0.08"
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                );
              })()}

            {/* Bulge handles: small accent-coloured dot at each selected
                wall's arc midpoint (or chord midpoint when straight). Drag
                to bend / re-shape the wall. Rendered AFTER endpoints so the
                bulge handle wins for clicks at the wall's exact midpoint of
                a tiny wall — fine for our use. */}
            {wallBulgeHandles.map(({ wall, point, isActive }) => {
              const svg = toSvgPoint({ x: point[0], y: point[1] });
              // Bigger handle + larger hit area so it's easy to grab even at
              // small zoom. Pulsing ring when not actively dragging draws the
              // eye for users who don't know what it does.
              return (
                <g key={`bulge-${wall.id}`}>
                  {/* Hit / halo circle. */}
                  <circle
                    cx={svg.x}
                    cy={svg.y}
                    fill={
                      isActive ? palette.selectedFill : "rgba(108,180,255,0.32)"
                    }
                    pointerEvents="none"
                    r={0.28}
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Visible body — larger than before so it's findable. */}
                  <circle
                    cx={svg.x}
                    cy={svg.y}
                    fill={isActive ? "#a3c2ff" : "#6cb4ff"}
                    onPointerDown={(event) =>
                      handleWallBulgePointerDown(wall, event)
                    }
                    r={0.16}
                    stroke="#ffffff"
                    strokeWidth="0.03"
                    style={{ cursor: "grab" }}
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
              );
            })}

            {/* Floor cuts: a grab area filling each hole so the whole cut
                can be dragged, plus a handle per corner to reshape it.
                Rendered before the curve handles so a corner handle sitting
                over a hole still wins the pointer. */}
            {slabHoleHandles.length > 0 &&
              selectedSlabEntry &&
              (selectedSlabEntry?.slab.holes ?? []).map((hole, holeIndex) => {
                const live =
                  slabHoleDraft?.slabId === selectedSlabEntry.slab.id &&
                  slabHoleDraft.holeIndex === holeIndex
                    ? slabHoleDraft.ring
                    : hole;
                if (live.length < 3) return null;
                const pts = live
                  .map((q) => {
                    const sp = toSvgPoint({ x: q[0], y: q[1] });
                    return sp.x + "," + sp.y;
                  })
                  .join(" ");
                return (
                  <polygon
                    key={"hole-body-" + holeIndex}
                    fill="rgba(239,68,68,0.10)"
                    onPointerDown={(event) =>
                      handleSlabHolePointerDown(
                        selectedSlabEntry.slab.id,
                        holeIndex,
                        null,
                        event,
                      )
                    }
                    points={pts}
                    stroke="#ef4444"
                    strokeDasharray="5 4"
                    strokeWidth={1.2}
                    style={{ cursor: "move" }}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            {slabHoleHandles.map(
              ({ slabId, holeIndex, vertexIndex, point }) => {
                const svg = toSvgPoint({ x: point[0], y: point[1] });
                return (
                  <circle
                    key={"hole-" + holeIndex + "-" + vertexIndex}
                    cx={svg.x}
                    cy={svg.y}
                    fill="#ef4444"
                    onPointerDown={(event) =>
                      handleSlabHolePointerDown(
                        slabId,
                        holeIndex,
                        vertexIndex,
                        event,
                      )
                    }
                    r={0.14}
                    stroke="#ffffff"
                    strokeWidth="0.03"
                    style={{ cursor: "grab" }}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              },
            )}

            {/* Floor curve handles. Same visual language as the wall bulge
                handle, in a warmer tint so the two are not confused when a
                slab and a wall are both selected. */}
            {slabBulgeHandles.map(
              ({ nodeId, holeIndex, edgeIndex, point, isActive }) => {
                const svg = toSvgPoint({ x: point[0], y: point[1] });
                return (
                  <g key={`slab-bulge-${nodeId}-${edgeIndex}`}>
                    <circle
                      cx={svg.x}
                      cy={svg.y}
                      fill={
                        isActive
                          ? palette.selectedFill
                          : "rgba(224,163,60,0.30)"
                      }
                      pointerEvents="none"
                      r={0.28}
                      vectorEffect="non-scaling-stroke"
                    />
                    <circle
                      cx={svg.x}
                      cy={svg.y}
                      fill={isActive ? "#f2c98a" : "#e0a33c"}
                      onPointerDown={(event) =>
                        handleSlabBulgePointerDown(
                          nodeId,
                          holeIndex,
                          edgeIndex,
                          event,
                        )
                      }
                      r={0.16}
                      stroke="#ffffff"
                      strokeWidth="0.03"
                      style={{ cursor: "grab" }}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                );
              },
            )}

            <FloorplanPolygonHandleLayer
              hoveredHandleId={hoveredSlabHandleId}
              midpointHandles={slabMidpointHandles}
              onHandleHoverChange={setHoveredSlabHandleId}
              onMidpointPointerDown={(nodeId, edgeIndex, event) =>
                handleSlabMidpointPointerDown(
                  nodeId as SlabNode["id"],
                  edgeIndex,
                  event,
                )
              }
              onVertexDoubleClick={(nodeId, vertexIndex, event) =>
                handleSlabVertexDoubleClick(
                  nodeId as SlabNode["id"],
                  vertexIndex,
                  event,
                )
              }
              onVertexPointerDown={(nodeId, vertexIndex, event) =>
                handleSlabVertexPointerDown(
                  nodeId as SlabNode["id"],
                  vertexIndex,
                  event,
                )
              }
              palette={palette}
              vertexHandles={slabVertexHandles}
            />

            <FloorplanPolygonHandleLayer
              hoveredHandleId={hoveredZoneHandleId}
              midpointHandles={zoneMidpointHandles}
              onHandleHoverChange={setHoveredZoneHandleId}
              onMidpointPointerDown={(nodeId, edgeIndex, event) =>
                handleZoneMidpointPointerDown(
                  nodeId as ZoneNodeType["id"],
                  edgeIndex,
                  event,
                )
              }
              onVertexDoubleClick={(nodeId, vertexIndex, event) =>
                handleZoneVertexDoubleClick(
                  nodeId as ZoneNodeType["id"],
                  vertexIndex,
                  event,
                )
              }
              onVertexPointerDown={(nodeId, vertexIndex, event) =>
                handleZoneVertexPointerDown(
                  nodeId as ZoneNodeType["id"],
                  vertexIndex,
                  event,
                )
              }
              palette={palette}
              vertexHandles={zoneVertexHandles}
            />

            {selectedGuide && showGuides && (
              <FloorplanGuideSelectionOverlay
                guide={selectedGuide}
                isDarkMode={theme === "dark"}
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
            {wallBulgeDraft &&
              (() => {
                const drag = wallBulgeDragRef.current;
                if (!drag) return null;
                const a = toSvgPoint({ x: drag.start[0], y: drag.start[1] });
                const b = toSvgPoint({ x: drag.end[0], y: drag.end[1] });
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
                    <circle
                      cx={a.x}
                      cy={a.y}
                      r="0.12"
                      fill="#ec4899"
                      stroke="#fff"
                      strokeWidth="0.04"
                      vectorEffect="non-scaling-stroke"
                    />
                    <circle
                      cx={b.x}
                      cy={b.y}
                      r="0.12"
                      fill="#ec4899"
                      stroke="#fff"
                      strokeWidth="0.04"
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                );
              })()}

            {/* Ritn3D Batch 7: alignment guides. Fires during:
                (a) wall endpoint edit drag (wallEndpointDraft), OR
                (b) new-wall drawing -- either first anchor placed and
                    cursor moving (draftStart + cursorPoint), or preview
                    end being nudged (draftStart + draftEnd).
                Compares the moving point against every other wall
                endpoint on the level; if X or Y matches within
                ALIGN_TOL, draws a dashed guide line + endpoint dot.
                Purely visual -- snap logic is in snapWallDraftPoint. */}
            {(() => {
              let moving: [number, number] | null = null;
              let excludeWallId: string | null = null;
              let sameWallOther: [number, number] | null = null;

              if (wallEndpointDraft) {
                const d = wallEndpointDraft;
                moving =
                  d.endpoint === "start"
                    ? [d.start[0], d.start[1]]
                    : [d.end[0], d.end[1]];
                excludeWallId = d.wallId;
                sameWallOther =
                  d.endpoint === "start"
                    ? [d.end[0], d.end[1]]
                    : [d.start[0], d.start[1]];
              } else if (
                draftStart &&
                (isWallBuildActive || isArcWallBuildActive)
              ) {
                const other = draftEnd ?? cursorPoint;
                if (other) {
                  moving = [other[0], other[1]];
                  sameWallOther = [draftStart[0], draftStart[1]];
                }
              } else if (
                (isWallBuildActive || isArcWallBuildActive) &&
                cursorPoint
              ) {
                // 2026-07-27: also fire during first-point placement --
                // user requested guides for wall point A too. No anchor
                // yet, so compare cursor position against every existing
                // wall endpoint on the level.
                moving = [cursorPoint[0], cursorPoint[1]];
              } else if (isOpeningPlacementActive && openingPreview) {
                // 2026-07-27: alignment guides while placing a door or
                // window. `openingPreview.point` is the projected point
                // on the wall centerline. Guides show when the opening's
                // center X or Y matches an existing opening's center on
                // another wall (typical scenario: aligning a window with
                // a door on the parallel wall of the same room).
                moving = [openingPreview.point[0], openingPreview.point[1]];
              }

              if (!moving) return null;

              const ALIGN_TOL = 0.25; // 25cm
              const otherEndpoints: [number, number][] = [];
              if (sameWallOther) otherEndpoints.push(sameWallOther);
              for (const w of walls) {
                if (excludeWallId && w.id === excludeWallId) continue;
                otherEndpoints.push([w.start[0], w.start[1]]);
                otherEndpoints.push([w.end[0], w.end[1]]);
              }
              // 2026-07-27: when placing an opening, also compare against
              // every existing door/window CENTER (world coord). Catches
              // the "align this door with the window on the parallel
              // wall" case that endpoint-only alignment misses.
              if (isOpeningPlacementActive) {
                const wallById = new Map(walls.map((w) => [w.id, w]));
                const allNodes = useScene.getState().nodes;
                for (const n of Object.values(allNodes)) {
                  const t = (n as any).type;
                  if (t !== "door" && t !== "window") continue;
                  const wid = (n as any).parentId || (n as any).wallId;
                  const w = wallById.get(wid);
                  if (!w) continue;
                  const pos = (n as any).position?.[0];
                  if (typeof pos !== "number") continue;
                  const len = arcLength(w.start, w.end, w.bulge ?? 0);
                  if (len <= 0) continue;
                  const t01 = Math.max(0, Math.min(1, pos / len));
                  const { point } = pointAndTangentAtT(
                    w.start,
                    w.end,
                    w.bulge ?? 0,
                    t01,
                  );
                  otherEndpoints.push([point[0], point[1]]);
                }
              }
              const xHits = otherEndpoints.filter(
                (p) => Math.abs(p[0] - moving![0]) < ALIGN_TOL,
              );
              const yHits = otherEndpoints.filter(
                (p) => Math.abs(p[1] - moving![1]) < ALIGN_TOL,
              );
              if (xHits.length === 0 && yHits.length === 0) return null;

              const guides: React.ReactElement[] = [];
              const mSvg = toSvgPoint({ x: moving[0], y: moving[1] });
              if (xHits.length > 0) {
                guides.push(
                  <line
                    key="align-x-line"
                    x1={mSvg.x}
                    x2={mSvg.x}
                    y1={viewBox.minY}
                    y2={viewBox.minY + viewBox.height}
                    stroke="#ec4899"
                    strokeWidth="1.5"
                    strokeDasharray="8 5"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />,
                );
                for (const p of xHits.slice(0, 5)) {
                  const s = toSvgPoint({ x: p[0], y: p[1] });
                  guides.push(
                    <circle
                      key={`align-x-dot-${p[0].toFixed(3)}-${p[1].toFixed(3)}`}
                      cx={s.x}
                      cy={s.y}
                      r="0.12"
                      fill="#ec4899"
                      stroke="#ffffff"
                      strokeWidth="0.03"
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />,
                  );
                }
              }
              if (yHits.length > 0) {
                guides.push(
                  <line
                    key="align-y-line"
                    x1={viewBox.minX}
                    x2={viewBox.minX + viewBox.width}
                    y1={mSvg.y}
                    y2={mSvg.y}
                    stroke="#ec4899"
                    strokeWidth="1.5"
                    strokeDasharray="8 5"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />,
                );
                for (const p of yHits.slice(0, 5)) {
                  const s = toSvgPoint({ x: p[0], y: p[1] });
                  guides.push(
                    <circle
                      key={`align-y-dot-${p[0].toFixed(3)}-${p[1].toFixed(3)}`}
                      cx={s.x}
                      cy={s.y}
                      r="0.12"
                      fill="#ec4899"
                      stroke="#ffffff"
                      strokeWidth="0.03"
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />,
                  );
                }
              }
              return <g key="alignment-guides">{guides}</g>;
            })()}

            {/* Scale-calibration overlay: dots at P1/P2 + line between them.
                Drawn last so it's on top of everything. */}
            {calibration &&
              calibrationP1 &&
              (() => {
                const a = toSvgPoint({
                  x: calibrationP1[0],
                  y: calibrationP1[1],
                });
                const b = calibrationP2
                  ? toSvgPoint({ x: calibrationP2[0], y: calibrationP2[1] })
                  : null;
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
                    <circle
                      cx={a.x}
                      cy={a.y}
                      r="0.14"
                      fill="#fbbf24"
                      stroke="#000"
                      strokeWidth="0.025"
                      vectorEffect="non-scaling-stroke"
                    />
                    {b && (
                      <circle
                        cx={b.x}
                        cy={b.y}
                        r="0.14"
                        fill="#fbbf24"
                        stroke="#000"
                        strokeWidth="0.025"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                  </g>
                );
              })()}
          </svg>
        )}

        {/* Scale-calibration input panel — appears once both points are set.
            HTML overlay (NOT inside the SVG) so the <input> is a real text
            field with full keyboard handling. Positioned near the bottom of
            the canvas as a small floating card. */}
        {calibration && calibrationP1 && calibrationP2 && (
          <div className="pointer-events-auto fixed bottom-10 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-md border border-hair bg-paper px-3 py-2 shadow-[0_8px_28px_rgba(22,24,28,0.10)]">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.05em] text-ink/55">
              Real distance
            </span>
            <input
              autoFocus
              type="text"
              inputMode="decimal"
              value={calibrationInput}
              onChange={(e) => setCalibrationInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyCalibration();
              }}
              placeholder="3.6"
              className="w-24 rounded border border-hair bg-paper px-2 py-1 text-[13px] tabular-nums text-ink placeholder:text-ink/30 focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/30"
            />
            <div className="flex overflow-hidden rounded border border-hair">
              <button
                type="button"
                onClick={() => setCalibrationUnit("m")}
                className={cn(
                  "px-2 py-1 text-[12px] font-medium",
                  calibrationUnit === "m"
                    ? "bg-ink text-paper"
                    : "text-ink/60 hover:bg-ink/[0.05] hover:text-ink",
                )}
              >
                m
              </button>
              <button
                type="button"
                onClick={() => setCalibrationUnit("ft")}
                className={cn(
                  "px-2 py-1 text-[12px] font-medium",
                  calibrationUnit === "ft"
                    ? "bg-ink text-paper"
                    : "text-ink/60 hover:bg-ink/[0.05] hover:text-ink",
                )}
              >
                ft
              </button>
            </div>
            <button
              type="button"
              onClick={applyCalibration}
              className="rounded bg-[var(--color-accent)] px-3 py-1 text-[12.5px] font-semibold text-white hover:opacity-90"
            >
              Apply
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
