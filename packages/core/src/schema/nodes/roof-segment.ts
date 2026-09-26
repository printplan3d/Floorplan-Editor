import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'

export const RoofType = z.enum(['hip', 'gable', 'shed', 'gambrel', 'dutch', 'mansard', 'flat'])

export type RoofType = z.infer<typeof RoofType>

// Roof material picker — the pipeline maps these to concrete PBR packs
// (roof_slates_03 for slate, terracotta for terracotta, etc). Unknown
// values fall back to the shingle default at parse time. Keep this list
// in sync with SUPPORTED_MATERIALS in blender_pipeline_dev/roof/scene.py.
export const RoofMaterial = z.enum(['slate', 'terracotta', 'metal', 'shingle', 'flat'])

export type RoofMaterial = z.infer<typeof RoofMaterial>

export const RoofSegmentNode = BaseNode.extend({
  id: objectId('rseg'),
  type: nodeType('roof-segment'),
  // Position relative to parent roof group
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  // Rotation around Y axis in radians
  rotation: z.number().default(0),
  // Roof shape type
  roofType: RoofType.default('gable'),
  // Which axis the ridge runs along, INDEPENDENT of width/depth. Set
  // explicitly so a later width/depth edit doesn't silently flip it
  // to whichever axis is currently longer. "auto" keeps the old
  // width>=depth heuristic for anything the user hasn't touched.
  ridgeAxis: z.enum(['auto', 'east-west', 'north-south']).default('auto'),
  // Material (drives the manifest slot the viewer swaps in)
  material: RoofMaterial.default('slate'),
  // Footprint dimensions — width/depth define a rectangle. Ignored when
  // `polygon` is set (four-point mode).
  width: z.number().default(8),
  depth: z.number().default(6),
  // Optional explicit polygon (world plan coords) — when set, the
  // pipeline uses this instead of the width/depth rectangle. Lets the
  // user draw non-rectangular gables (trapezoidal footprints where the
  // two gable ends are different lengths). Four vertices for now;
  // arbitrary N later. Position + rotation still apply as a rigid
  // transform on top of the polygon.
  polygon: z.array(z.tuple([z.number(), z.number()])).optional(),
  // Vertical dimensions
  // `wallHeight` here is NOT the storey wall height — that lives on each
  // WallNode drawn on the level. This is a PARAPET: a short vertical
  // extension added ABOVE the storey wall top, BEFORE the roof pitch
  // begins. The backend uses it verbatim:
  //   base_z = storey_elev + storey_height + wallHeight
  // (editor_scene_translator_dev.py). Set to 0 for a plain roof (eave
  // sitting flush on the storey wall top). Non-zero for mansard-style
  // setbacks. Previous default was 0.5 m, which silently raised every
  // eave 50 cm above the walls the user drew — confusing. Default
  // dropped to 0 on 2026-09-22; existing plans keep their explicit
  // value.
  wallHeight: z.number().default(0),
  roofHeight: z.number().default(2.5),
  // Auto-compute `roofHeight` from any upper-storey walls that sit
  // under this roof polygon. When true, the roof-segment panel writes
  // `max(intersecting_wall.top_z) - eave_z + 1.0m` (or
  // `min(width, depth) / 4` for a single-storey plan with no upper
  // walls) back into `roofHeight` on every scene edit. When false the
  // user drives `roofHeight` by hand, exactly as before. Default is
  // false so plans authored before this field parses lands unchanged;
  // new roofs get `autoRoofHeight: true` at creation time (see
  // roof-tool.tsx). Agreed with the operator 2026-09-22 as part of
  // the L0-roof-covers-L1 multi-storey model.
  autoRoofHeight: z.boolean().default(false),
  // Structure thicknesses
  wallThickness: z.number().default(0.1),
  deckThickness: z.number().default(0.1),
  overhang: z.number().default(0.3),
  shingleThickness: z.number().default(0.05),
  // ---- Shell-rebuild fields ---------------------------------------
  // Per-edge pitch weight — one entry per base-polygon edge (or per
  // width/depth-rectangle edge if no polygon is set). Values are
  // dimensionless multiplicative weights the shell subsystem
  // interprets as tan(pitch_angle). All entries at 1.0 = uniform 45°
  // pitch; different entries produce a variable-pitch roof (Melissa's
  // case — steeper eaves on one pair, shallower on the other).
  // Optional: omitted means the pipeline defaults all edges to
  // tan(pitch_rad) derived from roofHeight / half_span.
  edgeWeights: z.array(z.number()).optional(),
  // Explicit per-face pitch overrides — for when the automatic
  // skeleton produces a face whose pitch we want to force. Each entry
  // names which input-edge indices define the face and the pitch in
  // degrees. Rare; edgeWeights covers the common case.
  facesOverride: z
    .array(
      z.object({
        edgeIds: z.array(z.number()),
        pitchDeg: z.number(),
      }),
    )
    .optional(),
  // Manually-authored dormers on this roof segment. Each dormer is a
  // child roof mass attached to a specific parent face of this
  // segment's skeleton. See blender_pipeline_dev/roof/shell/dormers.py
  // for the primitive builders.
  dormers: z
    .array(
      z.object({
        id: z.string(),
        parentFaceId: z.number(),
        // foot_on_parent in UV coordinates on the parent face:
        // u ∈ [0, 1] along the eave, v ∈ [0, 1] toward the ridge.
        // Two points defining the dormer's footprint rectangle.
        footOnParent: z.tuple([
          z.tuple([z.number(), z.number()]),
          z.tuple([z.number(), z.number()]),
        ]),
        type: z.enum(['gable', 'shed', 'hip']).default('gable'),
        ridgeHeight: z.number().default(0.8),
        cheekWidth: z.number().default(1.2),
        ridgeOrientation: z
          .enum(['orthogonal', 'parallel'])
          .default('orthogonal'),
        window: z
          .object({
            w: z.number().default(0.8),
            h: z.number().default(1.0),
            sill: z.number().default(0.3),
            frameThicknessCm: z.number().default(5),
          })
          .optional(),
        materialCheek: z.string().optional(),
        materialRoof: z.string().optional(),
        // Window this dormer FOLLOWS (2026-09-25). When set, the dormer's
        // position and size come from the window: its front sits on the
        // window's wall, centred on it, wide and tall enough to clear it.
        // Move or resize the window and the dormer follows. footOnParent,
        // cheekWidth and ridgeHeight are ignored while this is set.
        windowId: z.string().optional(),
        // Shed dormers: the pitch of the dormer's own roof, degrees. Unset =
        // a third of the main slope's pitch. Always kept shallower than the
        // main slope (it must meet it).
        pitchDeg: z.number().optional(),
      }),
    )
    .optional(),
  // How this segment's ridge relates to a roof it runs into (an L/T wing, a
  // bay, or a continuation of the same ridge). Unset = automatic: LEVEL for a
  // wing of comparable width (ridges line up, the narrower wing is steeper),
  // INDEPENDENT for a small wing (keeps its own pitch; its ridge dies into
  // the main slope). 'pitch' = same pitch as the main roof, dropped ridge.
  ridgeMatch: z.enum(['level', 'pitch', 'independent']).optional(),
  // Escape hatch: path to a manually-authored OBJ that replaces the
  // pipeline-generated shell for this segment. Validation still runs
  // on the loaded mesh. Rare; used for eyebrow dormers / bay windows /
  // any shape the skeleton subsystem doesn't handle.
  roofOverrideMesh: z.string().optional(),
}).describe(
  dedent`
  Roof segment node - an individual roof module within a roof group.
  Each segment generates a complete architectural volume (walls + roof).
  Multiple segments can be combined to form complex roof shapes.
  - roofType: hip, gable, shed, gambrel, dutch, mansard, flat
  - width/depth: footprint dimensions
  - wallHeight: height of walls below the roof
  - roofHeight: height of the roof peak above the walls
  - wallThickness/deckThickness: structural thicknesses
  - overhang: eave overhang distance
  - shingleThickness: outer shingle layer thickness
  `,
)

export type RoofSegmentNode = z.infer<typeof RoofSegmentNode>
