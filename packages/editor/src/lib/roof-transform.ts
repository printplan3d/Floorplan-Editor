/**
 * Roof plan transforms, in the SAME convention the 3D view uses.
 *
 * RoofRenderer / RoofSegmentRenderer apply `rotation-y={node.rotation}`, and
 * three.js rotation about Y maps a local (x, z) to
 *     x' = x cos(θ) + z sin(θ)
 *     z' = -x sin(θ) + z cos(θ)
 * The 2D plan, the Blender export and the cloud-sync encoder used the
 * opposite sign, so any roof rotated by other than 0 / 180 degrees came out
 * turned the other way outside the 3D view: at 90 degrees its edges swapped
 * sides (per-edge pitches, dormers and wall trimming landed on the wrong
 * side) and off-centre segments moved (2026-09-25). Everything that turns a
 * roof's local plan coordinates into world plan coordinates goes through
 * here.
 */

export type PlanPt = [number, number];

/** local (x, z) rotated by θ about Y, three.js convention. */
export function rotateY(x: number, z: number, theta: number): PlanPt {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [x * c + z * s, -x * s + z * c];
}

/** Inverse of rotateY. */
export function unrotateY(x: number, z: number, theta: number): PlanPt {
  return rotateY(x, z, -theta);
}

type RoofLike = { position?: number[]; rotation?: number };
type SegLike = { position?: number[]; rotation?: number };

/** World plan centre and total rotation of a segment inside its roof group. */
export function segmentPlacement(roof: RoofLike, seg: SegLike): { cx: number; cz: number; rot: number } {
  const grot = roof.rotation ?? 0;
  const [ox, oz] = rotateY(seg.position?.[0] ?? 0, seg.position?.[2] ?? 0, grot);
  return {
    cx: (roof.position?.[0] ?? 0) + ox,
    cz: (roof.position?.[2] ?? 0) + oz,
    rot: grot + (seg.rotation ?? 0),
  };
}

/** A segment-local plan point in world plan coordinates. */
export function segmentLocalToWorld(p: { cx: number; cz: number; rot: number }, lx: number, lz: number): PlanPt {
  const [dx, dz] = rotateY(lx, lz, p.rot);
  return [p.cx + dx, p.cz + dz];
}

/** A world plan point in segment-local plan coordinates. */
export function segmentWorldToLocal(p: { cx: number; cz: number; rot: number }, X: number, Z: number): PlanPt {
  return unrotateY(X - p.cx, Z - p.cz, p.rot);
}
