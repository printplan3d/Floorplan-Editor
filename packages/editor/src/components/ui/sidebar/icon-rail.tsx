"use client";

import {
  type AnyNodeId,
  DEFAULT_WALL_THICKNESS,
  emitter,
  generateId,
  isStraight,
  LevelNode,
  SlabNode,
  tessellateArc,
  useScene,
  WallNode,
} from "@ritn3d/core";
import { useViewer } from "@ritn3d/viewer";
import {
  MoonIcon,
  ResetViewIcon,
  SunIcon,
  TrashIcon,
} from "../primitives/sidebar-icons";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./../../../components/ui/primitives/tooltip";
import { detectOuterOutlines } from "./../../../lib/detect-rooms";
import { cn } from "./../../../lib/utils";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import useEditor, { type StructureTool } from "./../../../store/use-editor";

// Ritn3D 2026-07-19: undo/redo state from the temporal middleware
// (zundo). useScene.temporal is a StoreApi, not a hook -- wrap it in
// zustand's `useStore(...)` to subscribe reactively so the buttons
// enable/disable in real time as the user makes changes.
function useUndoRedo() {
  const pastLen = useStore(useScene.temporal, (s: any) => s.pastStates.length);
  const futureLen = useStore(
    useScene.temporal,
    (s: any) => s.futureStates.length,
  );
  return {
    canUndo: pastLen > 0,
    canRedo: futureLen > 0,
    undo: () => useScene.temporal.getState().undo(),
    redo: () => useScene.temporal.getState().redo(),
  };
}

export type PanelId = "site" | "settings";

interface IconRailProps {
  activePanel: PanelId;
  onPanelChange: (panel: PanelId) => void;
  appMenuButton?: ReactNode;
  className?: string;
}

// Ritn3D 2026-07-13: 'Site' rail button removed — it was the only entry
// and served no purpose (activePanel defaults to 'site' anyway). Keeping
// the array shape so the rail can still host future panels without a
// refactor.
const panels: { id: PanelId; iconSrc: string; label: string }[] = [];

// Ritn3D 2026-07-19: minimal-mode tool rail. Wall / Arc Wall / Door /
// Window. Room / outdoor surfaces / symbols / buildings / templates are
// intentionally OFF for the first-story-only launch and will come back
// in a later version. Icon path convention matches the existing horizontal
// TOOLS row so no new asset copies are needed.
const ArcWallIconNodeIR = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
    <path
      d="M4 20 Q 12 4 20 20"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      fill="none"
    />
  </svg>
);
/* Barrier presets. Heights are the ordinary building ones: a parapet is
   waist-to-chest, a railing is the guard height stairs already use, a fence
   is taller than a person can lean over. Thickness separates them visually
   on the plan even before the 3D exists — a parapet reads as masonry, the
   other two as thin lines. */
/* Help rows. The first six mirror Flutter's "How to draw" sheet
   (editor_screen.dart _showHelpSheet) so the two apps teach the same thing in
   the same order. The last three are web-only, because Flutter is
   single-storey — and the Floors one exists because "is this floor for the
   level above or below" is genuinely not guessable from the canvas. */
const HELP_ROWS: { title: string; body: string }[] = [
  {
    title: "Wall",
    body: "Click a start point, then an end point. Draw on empty canvas to keep going.",
  },
  {
    title: "Arc wall",
    body: "Same as Wall, then drag the midpoint handle to shape the curve.",
  },
  {
    title: "Door / Window",
    body: "Click on a wall to drop it. Width follows the type you choose — a patio door cannot be single-door width.",
  },
  {
    title: "Select + edit",
    body: "Click anything to open its properties. Corner handles resize, midpoint handles add a corner.",
  },
  {
    title: "Zoom & pan",
    body: "Scroll to zoom, drag empty canvas to pan.",
  },
  {
    title: "Save & resume",
    body: "Leaving asks whether to keep your changes. Discard restores the plan as it was when you opened it.",
  },
  {
    title: "Levels",
    body: "The Levels button switches storeys. You always draw on the level you are on; the storey below shows as a faint amber outline so you can line things up.",
  },
  {
    title: "Floors and roofs",
    body:
      "Add a level and its floor is made for you — that same slab is the roof " +
      "over the storey below, which is how a building is actually built. " +
      "Cut a hole in it for a stairwell or a double-height room, or drag its " +
      "edges out past the walls for a balcony, portico or sun shade. The top " +
      "storey is left open.",
  },
  {
    title: "Stairs",
    body: "A stair rises FROM the level you place it on to the one above, and cuts its own opening in the floor there. Upper storeys also get Barrier: parapet, railing or fence along an open floor edge.",
  },
];

/**
 * Push a closed polygon outward, mitring the corners.
 *
 * detectOuterOutlines traces wall CENTRE-lines, so a floor cut to that shape
 * leaves every wall half hanging over the edge. Offsetting by half the wall
 * thickness reaches the outer face and the storey above stands fully on its
 * floor.
 *
 * Each edge moves along its own outward normal and adjacent lines are
 * intersected, which is exact on the rectilinear plans this mostly sees.
 * Near-parallel neighbours would intersect at infinity, so those fall back to
 * the plain normal offset.
 */
function offsetPolygonOutward(
  poly: [number, number][],
  dist: number,
): [number, number][] {
  const n = poly.length;
  if (n < 3 || dist <= 0) return poly;

  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  const sign = area2 > 0 ? 1 : -1;

  const edges: ([number, number, number, number] | null)[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) {
      edges.push(null);
      continue;
    }
    const nx = (ey / len) * sign;
    const ny = (-ex / len) * sign;
    edges.push([a[0] + nx * dist, a[1] + ny * dist, ex / len, ey / len]);
  }

  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prev = edges[(i - 1 + n) % n];
    const cur = edges[i];
    if (!prev || !cur) {
      out.push(poly[i]!);
      continue;
    }
    const [px, py, pdx, pdy] = prev;
    const [cx, cy, cdx, cdy] = cur;
    const denom = pdx * cdy - pdy * cdx;
    if (Math.abs(denom) < 1e-6) {
      out.push([cx, cy]);
      continue;
    }
    const t = ((cx - px) * cdy - (cy - py) * cdx) / denom;
    out.push([px + pdx * t, py + pdy * t]);
  }
  return out;
}

const BARRIER_PRESETS: {
  id: "parapet" | "railing" | "fence";
  label: string;
  barrierType: "solid" | "railing" | "fence";
  height: number;
  thickness: number;
  hint: string;
}[] = [
  {
    id: "parapet",
    label: "Parapet",
    barrierType: "solid",
    height: 1.0,
    thickness: 0.15,
    hint: "A solid low wall around a balcony or roof edge. Renders as masonry.",
  },
  {
    id: "railing",
    label: "Railing",
    barrierType: "railing",
    height: 1.1,
    thickness: 0.06,
    hint: "Posts, balusters and a handrail — the same generator the stairs use.",
  },
  {
    id: "fence",
    label: "Fence",
    barrierType: "fence",
    height: 1.8,
    thickness: 0.08,
    hint: "Taller, closer posts. For boundaries rather than fall protection.",
  },
];

const MINIMAL_TOOLS: {
  id: StructureTool;
  label: string;
  icon?: string;
  iconNode?: ReactNode;
  /* Shown on hover. The rail's own labels are 9px and clipped to one word,
     so they name a tool without ever explaining it — which is how you end up
     drawing a floor without knowing which storey it lands on. */
  hint?: string;
}[] = [
  {
    id: "wall",
    label: "Wall",
    icon: "/icons/wall.png",
    hint: "Click a start point, then an end point. Draws on the level you are on.",
  },
  {
    id: "arc-wall",
    label: "Arc Wall",
    iconNode: ArcWallIconNodeIR,
    hint: "Same as Wall, then drag the midpoint handle to curve it.",
  },
  {
    id: "door",
    label: "Door",
    icon: "/icons/door.png",
    hint: "Click a wall to place a door. Width follows the type you pick.",
  },
  {
    id: "window",
    label: "Window",
    icon: "/icons/window.png",
    hint: "Click a wall to place a window.",
  },
  {
    id: "stair",
    label: "Stair",
    icon: "/symbols/stairs/staircase.svg",
    hint: "Click to place. It rises FROM this level to the one above, and cuts its own opening.",
  },
  // Floor slabs. The tool and its polygon-draw path already existed in
  // floorplan-panel; it was simply never listed on the rail the webapp
  // renders, so there was no way to draw one. Real slabs are not the wall
  // outline — balconies, sun shades and porticos all extend past it — so an
  // upper storey's floor being auto-derived is a DEFAULT, not the answer.
  {
    id: "slab",
    label: "Floor",
    icon: "/icons/floor.png",
    hint: "Each level already has its floor. Use this to add another — a balcony, portico or sun shade beyond the walls.",
  },
];

// Ritn3D 2026-07-19: Select-mode icon (arrow cursor). Distinct from
// build-mode tools -- Select doesn't draw, it manipulates existing
// elements. Icon: standard 8-pixel cursor arrow.
const SelectIconNode = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
    <path
      d="M4 3 L4 17 L8 14 L11 20 L13 19 L10 13 L15 13 Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      fill="currentColor"
      fillOpacity="0.15"
    />
  </svg>
);
const UndoIconNode = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
    <path
      d="M9 6 L4 11 L9 16"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M4 11 H14 A5 5 0 0 1 19 16 V19"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

// Ritn3D 2026-07-24 iOS parity: Calibrate + Trace as first-class rail
// tools (iOS `PlanTool.swift` surfaces them in ToolPalette). Calibrate
// fires the existing floorplan:calibrate-scale event -- user then
// clicks two known-distance points on the canvas to set scale. Trace
// opens the site panel where the guide/reference upload UI lives.
const CalibrateIconNode = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
    <path
      d="M3 12 H21"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <path
      d="M6 9 V15 M12 9 V15 M18 9 V15"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <path
      d="M4 6 L5 5 L5 6 M20 6 L19 5 L19 6"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const TraceIconNode = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
    <rect
      x="4"
      y="4"
      width="16"
      height="16"
      rx="1.5"
      stroke="currentColor"
      strokeWidth="1.4"
      fill="none"
      strokeDasharray="2.5 2"
    />
    <path
      d="M8 10 L11 15 L14 12 L16 16"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);
const RedoIconNode = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
    <path
      d="M15 6 L20 11 L15 16"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M20 11 H10 A5 5 0 0 0 5 16 V19"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);
const GridSnapIconNode = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
    <path
      d="M4 4h16v16H4z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeOpacity="0.35"
      fill="none"
    />
    <path
      d="M9 4v16 M15 4v16 M4 9h16 M4 15h16"
      stroke="currentColor"
      strokeWidth="1"
      strokeOpacity="0.35"
    />
    <circle cx="9" cy="9" r="1.4" fill="currentColor" />
    <circle cx="15" cy="9" r="1.4" fill="currentColor" />
    <circle cx="9" cy="15" r="1.4" fill="currentColor" />
    <circle cx="15" cy="15" r="1.4" fill="currentColor" />
  </svg>
);
const OrthoIconNode = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
    <path
      d="M6 18 V6 H18"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M6 18 L18 18"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeOpacity="0.35"
    />
  </svg>
);

export function IconRail({
  activePanel,
  onPanelChange,
  appMenuButton,
  className,
}: IconRailProps) {
  // Levels on the active building, ground-first. `useShallow` so switching
  // tools does not re-render the rail on every unrelated scene write.
  const activeLevelId = useViewer((state) => state.selection.levelId);
  const activeBuildingId = useViewer((state) => state.selection.buildingId);
  const setViewerSelection = useViewer((state) => state.setSelection);
  const levelsOnBuilding = useScene(
    useShallow((state) => {
      // Fall back to the ACTIVE LEVEL's parent when no building is selected.
      // selection.buildingId is not reliably set in the webapp's flow, and
      // keying the control on it alone made the whole thing invisible.
      const bId =
        activeBuildingId ??
        (activeLevelId
          ? (state.nodes[activeLevelId]?.parentId as string | null)
          : null);
      if (!bId) return [] as LevelNode[];
      const building = state.nodes[bId as AnyNodeId];
      if (!building || building.type !== "building") return [] as LevelNode[];
      return building.children
        .map((childId) => state.nodes[childId])
        .filter((c): c is LevelNode => c?.type === "level")
        .slice()
        .sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    }),
  );
  const activeLevelNumber = useScene((state) =>
    activeLevelId
      ? ((state.nodes[activeLevelId] as LevelNode | undefined)?.level ?? null)
      : null,
  );

  const [levelsOpen, setLevelsOpen] = useState(false);
  const [barriersOpen, setBarriersOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const railRef = useRef<HTMLDivElement | null>(null);
  const [railRect, setRailRect] = useState<DOMRect | null>(null);

  // Measured on open, and kept in step with resizes while it is open. The
  // panel is fixed-positioned against the viewport, so it has to be told
  // where the rail actually is rather than inheriting it.
  useEffect(() => {
    if (!levelsOpen) return;
    const measure = () =>
      setRailRect(railRef.current?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [levelsOpen]);

  const deleteLevel = (lvl: LevelNode) => {
    // Everything ON the level goes with it — walls, slabs, stairs — so this
    // asks first. It is not an undo-sized action for someone who has drawn a
    // whole storey.
    const n = lvl.level ?? 0;
    const count = lvl.children.length;
    const label = lvl.name || `Level ${n}`;
    if (
      !window.confirm(
        count > 0
          ? `Delete ${label} and the ${count} item${count === 1 ? "" : "s"} on it?`
          : `Delete ${label}?`,
      )
    ) {
      return;
    }

    const { deleteNode, nodes } = useScene.getState();
    // Move off the level FIRST. Deleting the level you are standing on leaves
    // selection.levelId pointing at a node that no longer exists, and the
    // canvas renders nothing with no way back.
    if (activeLevelId === lvl.id) {
      const sibling = levelsOnBuilding.find((l) => l.id !== lvl.id);
      setViewerSelection({
        levelId: sibling ? sibling.id : null,
        selectedIds: [],
      });
    }
    // Children first: deleteNode does not cascade, and orphaned walls left in
    // the node map still export.
    for (const childId of lvl.children) {
      if (nodes[childId]) deleteNode(childId as AnyNodeId);
    }
    deleteNode(lvl.id as AnyNodeId);
  };

  const selectLevel = (id: LevelNode["id"]) => {
    setViewerSelection({ levelId: id, selectedIds: [] });
  };

  const addLevel = () => {
    const { createNode, nodes } = useScene.getState();
    const bId =
      activeBuildingId ??
      (activeLevelId
        ? (nodes[activeLevelId]?.parentId as string | null)
        : null);
    if (!bId) return;
    const building = nodes[bId as AnyNodeId];
    if (!building || building.type !== "building") return;

    // Numbered from the highest EXISTING level, not the count: deleting a
    // middle storey would otherwise reuse a number, and the exporter stacks
    // storeys by that number, so two levels would silently overlap.
    const existing = building.children
      .map((childId) => nodes[childId])
      .filter((c): c is LevelNode => c?.type === "level");
    const next = existing.reduce((mx, l) => Math.max(mx, l.level ?? 0), -1) + 1;

    const level = LevelNode.parse({ level: next, children: [], parentId: bId });
    createNode(level, bId as AnyNodeId);

    /* The roof over the storey below, which is this storey's floor — one
       object, exactly as a building is actually built.

       Made HERE rather than in Blender at render time. The pipeline used to
       synthesise it, which put a floor in the 3D model that had no
       counterpart in the editor: nothing to cut a stairwell through, nothing
       to drag out into a balcony. As a real slab, every tool that already
       works on floors works on this one.

       Traced from the storey below's outline, so an L-shaped plan follows
       the L instead of boxing over the notch. Offset by half the wall
       thickness because the trace follows wall centre-lines — without it
       every wall above would hang half off its own floor. */
    const belowLevel = levelsOnBuilding.find(
      (l) => (l.level ?? 0) === next - 1,
    );
    if (belowLevel) {
      const nodes = useScene.getState().nodes;
      /* Structural walls only — a railing or a fence does not hold a storey
         up, and must not shape the floor of the one above.

         Fence a garden, add a level, and the outline traced around those
         fence posts laid a floor over the whole garden: standing on the
         grass in walk mode you were under a roof. A parapet stays in, since
         it is a genuine low wall and a balcony above one is ordinary
         construction — only 'railing' and 'fence' are unambiguously not
         structure. ('solid' is the schema default, so it cannot be used to
         tell a parapet from a plain wall; that distinction is not needed
         here.) */
      const belowWalls = belowLevel.children
        .map((id) => nodes[id as AnyNodeId])
        .filter(
          (n): n is any =>
            n?.type === "wall" &&
            n.barrierType !== "railing" &&
            n.barrierType !== "fence",
        );
      if (belowWalls.length >= 3) {
        const maxThickness = belowWalls.reduce(
          (m, w) => Math.max(m, w.thickness ?? DEFAULT_WALL_THICKNESS),
          DEFAULT_WALL_THICKNESS,
        );
        /* Arc walls must be expanded BEFORE tracing. detectOuterOutlines
           walks the wall graph, whose nodes are wall ENDPOINTS — so a curved
           wall contributes its chord and nothing else. The floor then cut
           straight across every curve, leaving the bulge hanging over
           nothing and z-fighting the wall where the two disagreed.

           Each arc becomes a chain of short segments with synthetic ids, so
           the tracer sees an ordinary polyline and the outline follows the
           curve. Same resolution the pipeline uses for its own arc
           tessellation, so the floor edge and the wall agree. */
        const traceSegments: {
          id: string;
          start: [number, number];
          end: [number, number];
        }[] = [];
        for (const w of belowWalls) {
          const bulge = w.bulge ?? 0;
          if (isStraight(bulge)) {
            traceSegments.push({
              id: w.id,
              start: w.start as [number, number],
              end: w.end as [number, number],
            });
            continue;
          }
          const pts = tessellateArc(w.start, w.end, bulge);
          for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i]!;
            const b = pts[i + 1]!;
            traceSegments.push({
              id: `${w.id}__arc${i}`,
              start: [a[0], a[1]],
              end: [b[0], b[1]],
            });
          }
        }
        const outlines = detectOuterOutlines(traceSegments);
        for (const outline of outlines) {
          const poly = offsetPolygonOutward(outline, maxThickness / 2);
          if (poly.length < 3) continue;
          const slab = SlabNode.parse({
            name: `Floor ${next}`,
            parentId: level.id,
            polygon: poly,
            // Sits AT the storey datum. The presets that nudge a floor up or
            // down are ground-floor thresholds and steps, not this.
            elevation: 0,
          });
          createNode(slab, level.id as AnyNodeId);
        }
      }
    }

    // No slab is created here, deliberately.
    //
    // An earlier version made one covering the level below's footprint, so a
    // new storey would have a floor. It did give it one — and it also put a
    // full-bleed filled rectangle over the entire canvas, which is the first
    // thing you see after adding a level and which hides everything under it.
    // Adding an opaque object the user did not ask for, to solve a problem
    // they cannot see, is a bad trade.
    //
    // The floor is the PIPELINE's job now: any storey above the ground with
    // no slab of its own gets one synthesised from the footprint below at
    // render time. Drawing a slab by hand still works and still wins — that
    // is how a mezzanine or a partial floor gets made.
    setViewerSelection({ levelId: level.id, selectedIds: [] });
  };

  const theme = useViewer((state) => state.theme);
  const setTheme = useViewer((state) => state.setTheme);
  const unit = useViewer((state) => state.unit);
  const setUnit = useViewer((state) => state.setUnit);
  const mode = useEditor((s) => s.mode);
  const tool = useEditor((s) => s.tool);
  const setMode = useEditor((s) => s.setMode);
  const gridSnapEnabled = useEditor((s) => s.gridSnapEnabled);
  const setGridSnapEnabled = useEditor((s) => s.setGridSnapEnabled);
  const orthoEnabled = useEditor((s) => s.orthoEnabled);
  const setOrthoEnabled = useEditor((s) => s.setOrthoEnabled);
  const { canUndo, canRedo, undo, redo } = useUndoRedo();
  const [mounted, setMounted] = useState(false);
  const traceInputRef = useRef<HTMLInputElement>(null);

  // Ritn3D 2026-07-27: Trace tool now opens a file picker directly and
  // creates a GuideNode from the chosen image on the active level.
  // Previously it opened the Site panel which required extra clicks.
  const handleTraceFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    if (!isImage) {
      // Fall back to opening the site panel for PDF uploads -- that
      // path already handles pdf.js rendering.
      onPanelChange("site");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const state = useScene.getState() as any;
      const nodes = state.nodes as Record<string, any>;
      /* The level you are LOOKING at, not the first one in the map.
         Object.values(nodes).find(type === 'level') returns whichever level
         happens to be first — the ground floor — so on a multi-storey plan
         every trace image was parented to G regardless of the level open.
         The canvas only draws the active level's guides, so the image was
         invisible on the level you uploaded it from AND silently stacked on
         the ground floor. Tracing an upper storey was impossible.
         The Calibrate button below already scopes to activeLevelId; this is
         the one place that did not. */
      const activeId = useViewer.getState().selection.levelId;
      const level =
        (activeId && nodes[activeId]?.type === "level"
          ? nodes[activeId]
          : null) ??
        Object.values(nodes).find((n: any) => n.type === "level");
      if (!level) return;
      const guide = {
        id: generateId("guide"),
        type: "guide" as const,
        parentId: level.id,
        visible: true,
        url: dataUrl,
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: 5,
        opacity: 40,
      };
      state.createNode(guide, level.id);
      // 2026-07-28: auto-start scale calibration right after upload.
      // Without this, first-time users don't discover the calibrate
      // flow and their trace ends up at editor-default scale (1 unit
      // = 5m, way off). Small delay so the guide has time to render
      // before the calibration overlay banner appears.
      setTimeout(() => {
        emitter.emit("floorplan:calibrate-scale" as any, { guideId: guide.id });
      }, 200);
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  const pickTool = (id: StructureTool) => {
    // Match what the (now-hidden) horizontal tools row did: enter build
    // mode on the structure/elements layer with the chosen tool.
    useEditor.getState().setPhase("structure");
    useEditor.getState().setStructureLayer("elements");
    useEditor.getState().setCatalogCategory(null);
    useEditor.getState().setMode("build");
    /* Disarm the barrier when the user picks a different tool. It stays
       armed across consecutive walls on purpose — a balcony has several
       edges and re-picking Railing for each one would be tedious — but it
       must not survive into the next Wall you draw after moving on, or you
       get a 1.1 m room wall and no idea why. */
    if (id !== "wall") useEditor.getState().setPendingBarrier(null);
    useEditor.getState().setTool(id);
  };

  const pickSelect = () => {
    useEditor.getState().setPendingBarrier(null);
    useEditor.getState().setMode("select");
  };

  // Small helper for consistent styling of the icon+label buttons.
  const RailButton = ({
    isActive,
    onClick,
    disabled,
    label,
    iconNode,
    imgSrc,
    hint,
  }: {
    isActive: boolean;
    onClick: () => void;
    disabled?: boolean;
    label: string;
    iconNode?: ReactNode;
    imgSrc?: string;
    hint?: string;
  }) => (
    <button
      type="button"
      /* Native title rather than a custom tooltip: it survives the rail's
         overflow-y-auto clipping, needs no portal, and cannot be knocked out
         of position by the flyout. */
      title={hint ? `${label} — ${hint}` : label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        // 2026-07-28: tighter vertical rhythm so all icons fit on a
        // typical laptop viewport without scrolling. py-1 + gap-0
        // saves ~5 px per row across 15+ buttons.
        // shrink-0: without it flexbox compresses the buttons once the
        // rail overflows, and the bottom of the rail — units, theme —
        // collapses into an unreadable stack.
        "flex w-full shrink-0 flex-col items-center gap-0 px-1 py-1 transition-all",
        disabled
          ? "opacity-35 cursor-not-allowed"
          : isActive
            ? "bg-[var(--color-accent)]/12 text-[var(--color-accent)]"
            : "text-ink/70 hover:bg-ink/[0.04] hover:text-ink",
      )}
    >
      {imgSrc ? (
        <img
          alt={label}
          src={imgSrc}
          className={cn(
            "h-[18px] w-[18px] object-contain",
            !isActive && !disabled && "opacity-60 saturate-0",
          )}
        />
      ) : (
        <span className="flex h-[18px] w-[18px] items-center justify-center">
          {iconNode}
        </span>
      )}
      <span className="font-medium text-[9px] leading-[1.05]">{label}</span>
    </button>
  );

  // Named rather than returned directly so the levels rail can be rendered
  // as a SIBLING through a portal — it cannot live inside this element,
  // which scrolls and therefore clips absolutely positioned children.
  const rail = (
    <div
      ref={railRef}
      className={cn(
        // w-16 (64 px) gives room for the 5-char labels ("Arc W…" gets
        // truncated at 5 chars, "Wall"/"Door"/"Win" fit comfortably).
        // 2026-07-28: overflow-y-auto so the rail scrolls when too many
        // toggles push the theme + unit buttons off-screen (had this
        // problem after adding grid-snap + ortho toggles).
        "flex h-full w-16 shrink-0 flex-col items-stretch overflow-y-auto border-r border-hair bg-paper py-1 scrollbar-thin",
        className,
      )}
    >
      {/* App menu slot */}
      {appMenuButton}

      {/* Divider — only when there's something above it worth dividing from */}
      {(appMenuButton || panels.length > 0) && (
        <div className="mb-1 h-px w-full bg-hair" />
      )}

      {/* Select tool -- always at the very top so it's the default
          "back to safe mode" shortcut after any build action. */}
      <RailButton
        isActive={mode === "select"}
        onClick={pickSelect}
        label="Select"
        iconNode={SelectIconNode}
      />

      {/* Ritn3D 2026-07-19: minimal build tools with labels under each. */}
      {MINIMAL_TOOLS.map((t) => (
        <RailButton
          key={t.id}
          hint={t.hint}
          isActive={mode === "build" && tool === t.id}
          onClick={() => pickTool(t.id)}
          label={t.label}
          imgSrc={t.icon}
          iconNode={t.iconNode}
        />
      ))}

      {/* Ritn3D 2026-08-07: levels open as a SECOND RAIL beside this one.

          It cannot be a child of this rail. The rail scrolls
          (overflow-y-auto), and an overflow container CLIPS absolutely
          positioned descendants — so a flyout rendered here was cut off at
          the rail's edge and effectively invisible. It goes through a portal
          to document.body and is positioned against the rail's own rect, so
          nothing can clip it. */}
      {levelsOnBuilding.length > 0 && (
        <RailButton
          isActive={levelsOpen}
          label="Levels"
          onClick={() => setLevelsOpen((v) => !v)}
          iconNode={
            <span className="flex h-5 w-5 items-center justify-center rounded border border-current font-semibold text-[10px]">
              {activeLevelNumber === null
                ? "-"
                : activeLevelNumber === 0
                  ? "G"
                  : activeLevelNumber}
            </span>
          }
        />
      )}

      {/* Barriers. Upper storeys only: on the ground floor a slab edge is a
          patio or a path, and offering to railing it would be wrong far more
          often than right. */}
      {(activeLevelNumber ?? 0) > 0 && (
        <RailButton
          isActive={barriersOpen}
          label="Barrier"
          hint="Parapet, railing or fence along a balcony or roof edge."
          onClick={() => setBarriersOpen((v) => !v)}
          iconNode={
            <span className="flex h-[18px] w-[18px] items-end justify-between px-[2px]">
              <span className="h-3 w-[1.5px] bg-current" />
              <span className="h-3 w-[1.5px] bg-current" />
              <span className="h-3 w-[1.5px] bg-current" />
            </span>
          }
        />
      )}

      {/* Ritn3D 2026-07-24 iOS parity: Calibrate + Trace rail tools.
          2026-07-27: Calibrate must fire with a guideId or the panel
          handler noops. Auto-pick the first guide (underlay image) on
          the active level; alert if none is loaded so users know they
          need to upload a trace first. */}
      <RailButton
        isActive={false}
        onClick={() => {
          const state = useScene.getState();
          const activeLevelId = useViewer.getState().selection.levelId;
          const guide = Object.values(state.nodes).find(
            (n: any) => n.type === "guide" && n.parentId === activeLevelId,
          ) as any;
          if (!guide) {
            alert(
              "No trace image to calibrate. Click the Trace button and pick a photo first, then calibrate its scale.",
            );
            return;
          }
          // Also select the guide so the ReferencePanel opens with the
          // Set-Scale button visible and highlighted -- confirms the
          // click did something even before the user places the 2 points.
          useViewer.getState().setSelection({ selectedIds: [guide.id] });
          emitter.emit("floorplan:calibrate-scale" as any, {
            guideId: guide.id,
          });
        }}
        label="Calibrate"
        iconNode={CalibrateIconNode}
      />
      <RailButton
        isActive={false}
        onClick={() => traceInputRef.current?.click()}
        label="Trace"
        iconNode={TraceIconNode}
      />
      <input
        ref={traceInputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={handleTraceFile}
      />

      {/* 2026-07-27/28: persistent snap / ortho toggles. Compact labels
          (just 'Grid' / 'Ortho') so the rail doesn't push the theme +
          unit toggles off-screen. Shift key still overrides per-drag
          -- tooltip shows current state on hover. */}
      <div className="my-0.5 h-px w-full bg-hair" />
      <RailButton
        isActive={gridSnapEnabled}
        onClick={() => setGridSnapEnabled(!gridSnapEnabled)}
        label={gridSnapEnabled ? "Grid snap on" : "Grid snap off"}
        iconNode={GridSnapIconNode}
      />
      <RailButton
        isActive={orthoEnabled}
        onClick={() => setOrthoEnabled(!orthoEnabled)}
        label={orthoEnabled ? "Ortho on" : "Ortho off"}
        iconNode={OrthoIconNode}
      />

      {/* Undo / Redo — grouped just below the build tools */}
      <div className="my-0.5 h-px w-full bg-hair" />
      <RailButton
        isActive={false}
        onClick={undo}
        disabled={!canUndo}
        label="Undo"
        iconNode={UndoIconNode}
      />
      <RailButton
        isActive={false}
        onClick={redo}
        disabled={!canRedo}
        label="Redo"
        iconNode={RedoIconNode}
      />

      {/* Divider between tools and utility icons below */}
      <div className="my-0.5 h-px w-full bg-hair" />

      {panels.map((panel) => {
        const isActive = activePanel === panel.id;
        return (
          <Tooltip key={panel.id}>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-md transition-all",
                  isActive
                    ? "bg-ink/[0.06] text-[var(--color-accent)]"
                    : "text-ink/55 hover:bg-ink/[0.04] hover:text-ink",
                )}
                onClick={() => onPanelChange(panel.id)}
                type="button"
              >
                <img
                  alt={panel.label}
                  className={cn(
                    "h-6 w-6 object-contain transition-all",
                    !isActive && "opacity-50 saturate-0",
                  )}
                  src={panel.iconSrc}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{panel.label}</TooltipContent>
          </Tooltip>
        );
      })}

      {/* Spacer. min-h keeps a gap even when the rail is full, so the
          utilities never butt up against the tools above them. */}
      <div className="min-h-3 flex-1 shrink" />

      {/* Help sits with the utilities rather than the tools: it is not
          something you draw with, and it belongs where you look when you are
          stuck rather than in the middle of the drawing flow. */}
      <RailButton
        isActive={helpOpen}
        label="Help"
        hint="How to draw — walls, doors, levels, floors and stairs."
        onClick={() => setHelpOpen((v) => !v)}
        iconNode={
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-current font-semibold text-[11px]">
            ?
          </span>
        }
      />

      {/* Utility icons at bottom -- Reset View, Clear, Units, Theme. */}
      <RailButton
        isActive={false}
        onClick={() => emitter.emit("floorplan:reset-view" as any)}
        label="Fit"
        iconNode={<ResetViewIcon size={16} />}
      />
      <RailButton
        isActive={false}
        onClick={() => {
          // Ritn3D 2026-07-27: previous emit('floorplan:clear-canvas') went to
          // AppSidebar which is hidden in minimal-launch mode -> the listener
          // never fired. Inline the clear logic so it works from the rail alone.
          const ok = window.confirm(
            "Clear the whole canvas?\n\n" +
              "This deletes every wall, door, window, room, guide, and item on " +
              "the active level. You can undo with Ctrl+Z.",
          );
          if (!ok) return;
          const { levelId } = useViewer.getState().selection;
          if (!levelId) return;
          const nodes = useScene.getState().nodes as any;
          const levelNode = nodes[levelId as any];
          if (levelNode?.type !== "level") return;
          const childIds = [...((levelNode as any).children || [])];
          for (const cid of childIds) {
            useScene.getState().deleteNode(cid as any);
          }
          useViewer.getState().setSelection({ selectedIds: [] });
        }}
        label="Clear"
        iconNode={<TrashIcon size={15} />}
      />

      {/* Unit Toggle — segmented pair labelled m / ft */}
      {mounted && (
        <div className="mx-2 my-1 flex shrink-0 flex-col rounded-md border border-hair overflow-hidden">
          <button
            className={cn(
              "flex h-7 items-center justify-center font-semibold text-[11px] transition-all",
              unit === "metric"
                ? "bg-ink text-paper"
                : "text-ink/60 hover:text-ink hover:bg-ink/[0.04]",
            )}
            onClick={() => setUnit("metric")}
            type="button"
          >
            m
          </button>
          <div className="h-px bg-hair" />
          <button
            className={cn(
              "flex h-7 items-center justify-center font-semibold text-[11px] transition-all",
              unit === "imperial"
                ? "bg-ink text-paper"
                : "text-ink/60 hover:text-ink hover:bg-ink/[0.04]",
            )}
            onClick={() => setUnit("imperial")}
            type="button"
          >
            ft
          </button>
        </div>
      )}

      {/* Theme Toggle */}
      {mounted && (
        <RailButton
          isActive={false}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          label={theme === "dark" ? "Light" : "Dark"}
          iconNode={
            <motion.div
              animate={{ rotate: 0, opacity: 1 }}
              initial={{ rotate: -90, opacity: 0 }}
              key={theme}
              transition={{ duration: 0.25, ease: "easeOut" }}
            >
              {theme === "dark" ? (
                <SunIcon size={15} />
              ) : (
                <MoonIcon size={15} />
              )}
            </motion.div>
          }
        />
      )}
    </div>
  );

  /* One click, every exposed edge. An edge counts as exposed when no wall on
     this level runs along it — that is what makes it a balcony lip rather
     than the top of a wall. Offered rather than applied silently: the
     pipeline cannot tell a balcony from a flat roof nobody walks on, so the
     user confirms and can then edit or delete any of them, because they are
     ordinary walls. */
  const addBarriersToExposedEdges = (
    preset: (typeof BARRIER_PRESETS)[number],
  ) => {
    const levelId = useViewer.getState().selection.levelId;
    if (!levelId) return;
    const { nodes, createNode } = useScene.getState();
    const level = nodes[levelId as AnyNodeId];
    if (!level || level.type !== "level") return;

    const children = level.children
      .map((id) => nodes[id as AnyNodeId])
      .filter(Boolean);
    const slabs = children.filter((n) => n?.type === "slab") as any[];
    const walls = children.filter((n) => n?.type === "wall") as any[];
    if (!slabs.length) {
      window.alert(
        "No floor on this level yet — draw one first, then add barriers to its edges.",
      );
      return;
    }

    /* How far a wall may sit off an edge and still count as being ON it.
       Walls are drawn on the slab's edge line, but thickness, mitring and
       half-metre snapping all move the stored centre-line a little, so an
       exact test would find nothing. 0.35 m is wider than any wall we build
       and far narrower than a room. */
    const ON_EDGE_TOL = 0.35;
    /* Gaps shorter than this are not worth a barrier — they are mitre slop
       at a corner, not an opening someone can fall through. */
    const MIN_GAP = 0.4;
    /* How far off an edge to look for floor. Big enough to clear the edge
       itself and any snapping slop, small enough not to reach across a
       narrow balcony and find the floor on its far side. */
    const PROBE = 0.25;

    const pointInRing = (
      x: number,
      y: number,
      ring: [number, number][],
    ): boolean => {
      let inside = false;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        if (
          a[1] > y !== b[1] > y &&
          x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
        ) {
          inside = !inside;
        }
      }
      return inside;
    };

    /** Is there floor at this point — any slab on this level, minus its holes? */
    const isFloored = (x: number, y: number): boolean =>
      slabs.some((sl) => {
        const poly = (sl.polygon ?? []) as [number, number][];
        if (poly.length < 3 || !pointInRing(x, y, poly)) return false;
        const holes = (sl.holes ?? []) as [number, number][][];
        return !holes.some((h) => h.length >= 3 && pointInRing(x, y, h));
      });

    const pending: [[number, number], [number, number]][] = [];
    for (const sl of slabs) {
      const poly = (sl.polygon ?? []) as number[][];
      const slabBulges = (sl.bulges ?? []) as number[];

      /* Straight spans to run the gap logic over.

         A curved slab edge is ONE entry in `polygon` with a bulge — walking
         consecutive points treats it as the chord, so a railing round a
         curved balcony was built straight across the opening it was meant to
         guard. Tessellating first turns the arc into short straight spans
         that trace the curve, which is exactly what the translator already
         does to an arc WALL before Blender sees it: many small segments read
         as a curve, and every downstream stage stays straight-line only.

         Computing a bulge for each partial span was the alternative and is a
         trap — a sub-chord's bulge is NOT the parent's, and getting that
         wrong is a bug we have already shipped once on room areas. */
      const spans: {
        p0: [number, number];
        p1: [number, number];
        arcSub: boolean;
      }[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        if (!(a && b)) continue;
        const s: [number, number] = [a[0] ?? 0, a[1] ?? 0];
        const e: [number, number] = [b[0] ?? 0, b[1] ?? 0];
        const bulge = slabBulges[i] ?? 0;
        if (isStraight(bulge)) {
          spans.push({ p0: s, p1: e, arcSub: false });
          continue;
        }
        const pts = tessellateArc(s, e, bulge, 0.5);
        for (let k = 0; k + 1 < pts.length; k++) {
          spans.push({
            p0: [pts[k]![0], pts[k]![1]],
            p1: [pts[k + 1]![0], pts[k + 1]![1]],
            arcSub: true,
          });
        }
      }

      for (const span of spans) {
        const p0 = span.p0;
        const p1 = span.p1;
        const ex = p1[0] - p0[0];
        const ey = p1[1] - p0[1];
        const edgeLen = Math.hypot(ex, ey);
        /* MIN_GAP rejects mitre slop at a corner. An arc sub-span is a
           deliberate subdivision, not slop, so it is held to a much smaller
           floor — otherwise tessellating a curve into half-metre pieces
           would discard every one of them and the railing would vanish
           entirely rather than merely cut the chord. */
        if (edgeLen < (span.arcSub ? 0.05 : MIN_GAP)) continue;
        const ux = ex / edgeLen;
        const uy = ey / edgeLen;

        /* Project every wall that lies along this edge onto it, in metres
           from p0. A wall counts only when BOTH ends are near the edge line
           — one endpoint near it just means a wall meeting this edge at a
           corner, which covers none of it. */
        const covered: [number, number][] = [];
        for (const w of walls) {
          const ends = [w.start, w.end] as [number, number][];
          const proj: number[] = [];
          let onEdge = true;
          for (const q of ends) {
            const dx = q[0] - p0[0];
            const dy = q[1] - p0[1];
            const along = dx * ux + dy * uy;
            const perp = Math.abs(dx * -uy + dy * ux);
            if (perp > ON_EDGE_TOL) {
              onEdge = false;
              break;
            }
            proj.push(along);
          }
          if (!onEdge || proj.length !== 2) continue;
          const lo = Math.max(0, Math.min(proj[0]!, proj[1]!));
          const hi = Math.min(edgeLen, Math.max(proj[0]!, proj[1]!));
          if (hi - lo > 0.05) covered.push([lo, hi]);
        }

        // Merge, then walk the gaps between them. Same reasoning as the span
        // length above: within an arc sub-span, a short gap is still real
        // guarding to build, not corner slop.
        const gapMin = span.arcSub ? 0.05 : MIN_GAP;
        covered.sort((m, n) => m[0] - n[0]);
        let cursor = 0;
        const gaps: [number, number][] = [];
        for (const [lo, hi] of covered) {
          if (lo - cursor > gapMin) gaps.push([cursor, lo]);
          cursor = Math.max(cursor, hi);
        }
        if (edgeLen - cursor > gapMin) gaps.push([cursor, edgeLen]);

        for (const [g0, g1] of gaps) {
          /* Floor on BOTH sides means this is a seam between two slabs — a
             balcony drawn onto the storey's floor shares its edge with it —
             not a drop. Railing it puts a fence through the middle of the
             deck, which is exactly what happened. Probed at the gap's own
             midpoint rather than the whole edge's, so an edge that is shared
             for part of its length still gets a barrier on the rest. */
          const mid = (g0 + g1) / 2;
          const mx = p0[0] + ux * mid;
          const my = p0[1] + uy * mid;
          const nx = -uy;
          const ny = ux;
          const floorLeft = isFloored(mx + nx * PROBE, my + ny * PROBE);
          const floorRight = isFloored(mx - nx * PROBE, my - ny * PROBE);
          if (floorLeft && floorRight) continue;

          pending.push([
            [p0[0] + ux * g0, p0[1] + uy * g0],
            [p0[0] + ux * g1, p0[1] + uy * g1],
          ]);
        }
      }
    }

    if (!pending.length) {
      window.alert(
        "Every floor edge on this level already has a wall along it.",
      );
      return;
    }
    if (
      !window.confirm(
        `Add ${pending.length} ${preset.label.toLowerCase()}${pending.length === 1 ? "" : "s"} along the open stretches of this level's floor edges?\n\n` +
          "Only the open parts are covered — where an edge is half walled, the barrier fills the rest.\n\n" +
          "You can move, resize or delete any of them afterwards.",
      )
    ) {
      return;
    }

    /* One id shared by every span of this run.

       A curved slab edge is tessellated into half-metre straight spans —
       the pipeline only takes straight segments, and without that a railing
       round a curved balcony cut the chord. The cost is that one railing
       becomes dozens of WallNodes, and deleting it meant clicking every one.

       The spans stay separate nodes (the geometry needs them) but carry a
       group id, so selection and deletion can treat the run as the single
       thing the user actually drew. Same idea as parent_wall_id on the
       pipeline's arc sub-walls. */
    const groupId = generateId("bgrp");
    let n = 0;
    for (const [a, b] of pending) {
      const wall = WallNode.parse({
        name: `${preset.label} ${++n}`,
        start: a,
        end: b,
        barrierType: preset.barrierType,
        height: preset.height,
        thickness: preset.thickness,
        metadata: { barrierGroupId: groupId },
      });
      createNode(wall, levelId as AnyNodeId);
    }
    setBarriersOpen(false);
  };

  return (
    <>
      {rail}
      {helpOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            <button
              aria-label="Close help"
              className="fixed inset-0 z-[59] cursor-default"
              onClick={() => setHelpOpen(false)}
              type="button"
            />
            <div
              className="fixed z-[60] flex w-72 flex-col overflow-y-auto border-hair border-r bg-paper py-1 shadow-[4px_0_12px_rgba(0,0,0,0.18)] scrollbar-thin"
              style={{
                left: railRect?.right ?? 64,
                top: railRect?.top ?? 0,
                height: railRect?.height ?? "100%",
              }}
            >
              <div className="px-3 py-2 text-[10px] text-ink/50 uppercase tracking-wide">
                How to draw
              </div>
              {HELP_ROWS.map((row) => (
                <div key={row.title} className="px-3 py-2">
                  <div className="font-medium text-[12px] text-ink">
                    {row.title}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-snug text-ink/60">
                    {row.body}
                  </div>
                </div>
              ))}
            </div>
          </>,
          document.body,
        )}
      {barriersOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            <button
              aria-label="Close barriers"
              className="fixed inset-0 z-[59] cursor-default"
              onClick={() => setBarriersOpen(false)}
              type="button"
            />
            <div
              className="fixed z-[60] flex w-56 flex-col overflow-y-auto border-hair border-r bg-paper py-1 shadow-[4px_0_12px_rgba(0,0,0,0.18)] scrollbar-thin"
              style={{
                left: railRect?.right ?? 64,
                top: railRect?.top ?? 0,
                height: railRect?.height ?? "100%",
              }}
            >
              <div className="px-3 py-2 text-[10px] text-ink/50 uppercase tracking-wide">
                Barriers
              </div>
              {BARRIER_PRESETS.map((preset) => (
                <div
                  key={preset.id}
                  className="mx-1 mb-1 rounded-md border border-hair"
                >
                  <button
                    className="flex w-full flex-col items-start gap-0.5 px-2 py-2 text-left hover:bg-ink/[0.04]"
                    onClick={() => {
                      useEditor.getState().setPendingBarrier({
                        barrierType: preset.barrierType,
                        height: preset.height,
                        thickness: preset.thickness,
                      });
                      useEditor.getState().setMode("build");
                      useEditor.getState().setTool("wall");
                      setBarriersOpen(false);
                    }}
                    type="button"
                  >
                    <span className="font-medium text-[12px] text-ink">
                      {preset.label}
                      <span className="ml-1.5 font-normal text-[10px] text-ink/45">
                        {preset.height.toFixed(2)} m
                      </span>
                    </span>
                    <span className="text-[10px] leading-snug text-ink/55">
                      {preset.hint}
                    </span>
                  </button>
                  <button
                    className="w-full border-hair border-t px-2 py-1.5 text-left text-[10.5px] text-[var(--color-accent)] hover:bg-ink/[0.04]"
                    onClick={() => addBarriersToExposedEdges(preset)}
                    type="button"
                  >
                    + Add to every open floor edge
                  </button>
                </div>
              ))}
              <div className="mx-1 mt-1 px-2 py-2 text-[10px] leading-snug text-ink/45">
                Barriers are walls. Draw one anywhere, or use the button above
                to follow the floor edges that have no wall on them. Edit or
                delete them like any other wall.
              </div>
            </div>
          </>,
          document.body,
        )}
      {levelsOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            {/* Click-away, behind the rail so the rail stays usable. */}
            <button
              aria-label="Close levels"
              className="fixed inset-0 z-[59] cursor-default"
              onClick={() => setLevelsOpen(false)}
              type="button"
            />
            <div
              className="fixed z-[60] flex w-52 flex-col overflow-y-auto border-hair border-r bg-paper py-1 shadow-[4px_0_12px_rgba(0,0,0,0.18)] scrollbar-thin"
              style={{
                left: railRect?.right ?? 64,
                top: railRect?.top ?? 0,
                height: railRect?.height ?? "100%",
              }}
            >
              <div className="px-3 py-2 text-[10px] text-ink/50 uppercase tracking-wide">
                Levels
              </div>

              {levelsOnBuilding
                .slice()
                .reverse()
                .map((lvl) => {
                  const n = lvl.level ?? 0;
                  const isActive = lvl.id === activeLevelId;
                  return (
                    <div
                      className={cn(
                        "group mx-1 flex shrink-0 items-center gap-1 rounded-md px-1",
                        isActive ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]",
                      )}
                      key={lvl.id}
                    >
                      <button
                        className="flex flex-1 items-center gap-2 py-2 text-left text-[12px] text-ink"
                        onClick={() => {
                          selectLevel(lvl.id);
                          setLevelsOpen(false);
                        }}
                        type="button"
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-hair font-semibold text-[10px]">
                          {n === 0 ? "G" : n}
                        </span>
                        <span className="truncate">
                          {lvl.name ||
                            (n === 0 ? "Ground floor" : `Level ${n}`)}
                        </span>
                      </button>
                      {/* Ground floor has no delete: a building with no
                          storeys has nowhere to draw. */}
                      {n !== 0 && (
                        <button
                          aria-label={`Delete level ${n}`}
                          className="shrink-0 rounded p-1 text-ink/40 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
                          onClick={() => deleteLevel(lvl)}
                          title={`Delete level ${n}`}
                          type="button"
                        >
                          <TrashIcon />
                        </button>
                      )}
                    </div>
                  );
                })}

              <button
                className="mx-1 mt-1 flex shrink-0 items-center gap-2 rounded-md px-2 py-2 text-[12px] text-ink/70 hover:bg-ink/[0.04] hover:text-ink"
                onClick={addLevel}
                type="button"
              >
                <span className="flex h-5 w-5 items-center justify-center text-[15px] leading-none">
                  +
                </span>
                Add level above
              </button>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

export { panels };
