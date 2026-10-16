import type { AnyNode, AnyNodeId } from "@ritn3d/core";

/**
 * Move, turn and (optionally) resize ONE storey as a rigid body, so a plan
 * detected onto an upper level can be laid over the storey below it.
 *
 * The transform is a similarity in plan coordinates (x, z):
 *     p' = s * p + t      with s = k * e^(i*theta) treated as a complex number
 * Similarity, never a general affine map: no shear or mirror, so wall bulges
 * (tan of a quarter of the arc angle) and opening sizes stay meaningful.
 *
 * Detection gives every storey its own scale (it assumes every door is
 * 80 cm) and its own origin (the image's top-left corner), so two storeys of
 * one building come in offset, sometimes turned, and a few percent apart in
 * size. Two matching point pairs fix all three at once.
 */
export interface LevelTransform {
  /** s = re + i*im: rotation by atan2(im, re), scale by hypot(re, im). */
  re: number;
  im: number;
  tx: number;
  tz: number;
}

type P = [number, number];

/**
 * The similarity that carries a1 -> b1 and a2 -> b2.
 *
 * keepScale: rotate + translate only. The scale is dropped to 1 and the
 * translation chosen so the MIDPOINTS of the two pairs coincide, which splits
 * any residual length mismatch evenly between both ends instead of piling
 * it on the second point.
 *
 * Null when the first two points (nearly) coincide: there is no direction to
 * take a rotation from.
 */
export function similarityFromPairs(
  a1: P,
  a2: P,
  b1: P,
  b2: P,
  keepScale: boolean,
): LevelTransform | null {
  const ax = a2[0] - a1[0];
  const az = a2[1] - a1[1];
  const bx = b2[0] - b1[0];
  const bz = b2[1] - b1[1];
  const aa = ax * ax + az * az;
  if (aa < 1e-8) return null;
  // s = (b2 - b1) / (a2 - a1), complex division.
  let re = (bx * ax + bz * az) / aa;
  let im = (bz * ax - bx * az) / aa;
  if (keepScale) {
    const k = Math.hypot(re, im);
    if (k < 1e-9) return null;
    re /= k;
    im /= k;
    const amx = (a1[0] + a2[0]) / 2;
    const amz = (a1[1] + a2[1]) / 2;
    const bmx = (b1[0] + b2[0]) / 2;
    const bmz = (b1[1] + b2[1]) / 2;
    return {
      re,
      im,
      tx: bmx - (re * amx - im * amz),
      tz: bmz - (im * amx + re * amz),
    };
  }
  return {
    re,
    im,
    tx: b1[0] - (re * a1[0] - im * a1[1]),
    tz: b1[1] - (im * a1[0] + re * a1[1]),
  };
}

export function applyToPoint(t: LevelTransform, p: P): P {
  return [
    t.re * p[0] - t.im * p[1] + t.tx,
    t.im * p[0] + t.re * p[1] + t.tz,
  ];
}

export function transformScale(t: LevelTransform): number {
  return Math.hypot(t.re, t.im);
}

/** Rotation in radians, counter-clockwise in plan (x, z). */
export function transformAngle(t: LevelTransform): number {
  return Math.atan2(t.im, t.re);
}

/**
 * Node updates that apply `t` to everything on `levelId`, as ONE batch for
 * updateNodes (one undo step). Other storeys are never touched -- the
 * calibration's scalePlanBy rescales the whole building, which is the wrong
 * thing here.
 *
 * Rotation conventions, all in plan (x, z) with theta = transformAngle(t):
 *  - stair.rotation: run direction is (cos r, sin r) -- export-json derives
 *    its across-axis as (-sin r, cos r) -- so it turns WITH the plan: r + theta.
 *  - guide.rotation[1], item.rotation[1]: three.js Y rotations, which turn
 *    (x, z) the other way (x' = x cos + z sin): rotation - theta. The 2D guide
 *    draws rotate(-rotation[1]) in SVG space, which agrees.
 *
 * Roofs are NOT moved: a roof group's segments are local to it and carry
 * their own sizes, pitches and polygons. Align a storey before roofing it;
 * callers say so when the level already has one (see levelHasRoofs).
 */
export function levelTransformUpdates(
  nodes: Record<string, AnyNode>,
  levelId: string,
  t: LevelTransform,
): { id: AnyNodeId; data: Partial<AnyNode> }[] {
  const level = nodes[levelId] as any;
  if (!level || level.type !== "level") return [];
  const k = transformScale(t);
  const theta = transformAngle(t);
  const pt = (p: P) => applyToPoint(t, p);
  const poly = (ps: P[] | undefined) => (ps ?? []).map(pt);
  const updates: { id: AnyNodeId; data: Partial<AnyNode> }[] = [];
  const push = (id: string, data: Record<string, unknown>) =>
    updates.push({ id: id as AnyNodeId, data: data as Partial<AnyNode> });

  for (const childId of level.children ?? []) {
    const n = nodes[childId] as any;
    if (!n) continue;
    switch (n.type) {
      case "wall": {
        push(n.id, { start: pt(n.start), end: pt(n.end) });
        // Openings are WALL-LOCAL: position[0] is the distance of the centre
        // along the wall in metres, so it only scales; [1] (height off the
        // floor) and [2] (across the wall) are untouched, as are heights.
        for (const oid of n.children ?? []) {
          const o = nodes[oid] as any;
          if (o?.type !== "door" && o?.type !== "window") continue;
          if (k === 1) continue;
          push(o.id, {
            position: [o.position[0] * k, o.position[1], o.position[2]],
            width: (o.width ?? 0) * k,
          });
        }
        break;
      }
      case "zone":
        push(n.id, { polygon: poly(n.polygon) });
        break;
      case "slab":
      case "ceiling":
        push(n.id, {
          polygon: poly(n.polygon),
          holes: (n.holes ?? []).map((h: P[]) => poly(h)),
        });
        break;
      case "guide": {
        const [x, z] = pt([n.position[0], n.position[2]]);
        push(n.id, {
          position: [x, n.position[1], z],
          rotation: [n.rotation[0], n.rotation[1] - theta, n.rotation[2]],
          scale: (n.scale ?? 1) * k,
        });
        break;
      }
      case "item": {
        const [x, z] = pt([n.position[0], n.position[2]]);
        push(n.id, {
          position: [x, n.position[1], z],
          rotation: [n.rotation[0], n.rotation[1] - theta, n.rotation[2]],
        });
        break;
      }
      case "stair":
        push(n.id, {
          position: pt(n.position),
          rotation: (n.rotation ?? 0) + theta,
          ...(k === 1
            ? {}
            : {
                width: (n.width ?? 0) * k,
                length: (n.length ?? 0) * k,
                ...(typeof n.depth === "number" ? { depth: n.depth * k } : {}),
              }),
        });
        break;
    }
  }
  return updates;
}

export function levelHasRoofs(
  nodes: Record<string, AnyNode>,
  levelId: string,
): boolean {
  const level = nodes[levelId] as any;
  return !!level?.children?.some(
    (id: string) => (nodes[id] as any)?.type === "roof",
  );
}
