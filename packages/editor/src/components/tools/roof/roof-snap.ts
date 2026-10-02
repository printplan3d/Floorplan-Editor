import type { WallNode } from "@ritn3d/core";
import {
  snapPointToGrid,
  WALL_JOIN_SNAP_RADIUS,
  type WallPlanPoint,
} from "../wall/wall-drafting";

/**
 * Roof corner snapping on the 2D plan (operator 2026-10-02: "when I'm
 * drawing overlapping / intersecting roofs, snap their corners -- it's very
 * hard to do manually and it never comes right").
 *
 * Targets, strongest first, within WALL_JOIN_SNAP_RADIUS:
 *   1. another roof's corner
 *   2. a point on another roof's edge (the eave / end LINE, so overlapping
 *      roofs share it exactly)
 *   3. a wall corner
 * then the grid when grid snap is on. Shift skips the object snaps.
 */

/** One roof segment's footprint corners in world plan coordinates, in order. */
export type RoofOutline = { segId: string; corners: WallPlanPoint[] };

export type RoofSnapKind = "roof-corner" | "roof-edge" | "wall-corner" | "grid" | null;

export type RoofSnap = { point: WallPlanPoint; kind: RoofSnapKind };

function dist2(a: WallPlanPoint, b: WallPlanPoint): number {
  const dx = a[0] - b[0];
  const dz = a[1] - b[1];
  return dx * dx + dz * dz;
}

/** Nearest point on segment ab (inclusive of its ends). */
function nearestOnSegment(p: WallPlanPoint, a: WallPlanPoint, b: WallPlanPoint): WallPlanPoint {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const L2 = dx * dx + dz * dz;
  if (L2 < 1e-12) return a;
  const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2));
  return [a[0] + dx * t, a[1] + dz * t];
}

export function snapRoofPoint(args: {
  point: WallPlanPoint;
  roofs: RoofOutline[];
  walls: WallNode[];
  /** The segment being edited: never snap to itself. */
  ignoreSegId?: string;
  /** Object snaps (roof corners / edges, wall corners). Off while Shift is held. */
  objectSnap: boolean;
  /** Grid snap fallback (the rail's Grid snap toggle). */
  gridSnap: boolean;
  radius?: number;
}): RoofSnap {
  const { point, roofs, walls, ignoreSegId, objectSnap, gridSnap } = args;
  const r2 = (args.radius ?? WALL_JOIN_SNAP_RADIUS) ** 2;
  if (objectSnap) {
    const others = roofs.filter((r) => r.segId !== ignoreSegId);
    const best = (cands: WallPlanPoint[]): WallPlanPoint | null => {
      let out: WallPlanPoint | null = null;
      let bd = r2;
      for (const c of cands) {
        const d = dist2(point, c);
        if (d <= bd) {
          bd = d;
          out = c;
        }
      }
      return out;
    };
    const corner = best(others.flatMap((r) => r.corners));
    if (corner) return { point: [corner[0], corner[1]], kind: "roof-corner" };
    const edgePts: WallPlanPoint[] = [];
    for (const r of others) {
      const n = r.corners.length;
      for (let i = 0; i < n; i++) {
        edgePts.push(nearestOnSegment(point, r.corners[i]!, r.corners[(i + 1) % n]!));
      }
    }
    const edge = best(edgePts);
    if (edge) return { point: edge, kind: "roof-edge" };
    const wallCorner = best(walls.flatMap((w) => [w.start as WallPlanPoint, w.end as WallPlanPoint]));
    if (wallCorner) return { point: [wallCorner[0], wallCorner[1]], kind: "wall-corner" };
  }
  if (gridSnap) return { point: snapPointToGrid(point), kind: "grid" };
  return { point, kind: null };
}
