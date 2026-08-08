"use client";

import {
  type AnyNode,
  type SlabNode,
  type SlabSurfaceType,
  useScene,
} from "@ritn3d/core";
import { useViewer } from "@ritn3d/viewer";
import { Edit, Plus, Scissors, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import useEditor from "../../../store/use-editor";
import { ActionButton, ActionGroup } from "../controls/action-button";
import { PanelSection } from "../controls/panel-section";
import { SliderControl } from "../controls/slider-control";
import { PanelWrapper } from "./panel-wrapper";

const SURFACE_TYPES: { id: SlabSurfaceType; label: string }[] = [
  { id: "interior", label: "Interior" },
  { id: "patio", label: "Patio" },
  { id: "deck", label: "Deck" },
  { id: "driveway", label: "Driveway" },
  { id: "garage", label: "Garage" },
  { id: "gravel", label: "Gravel" },
  { id: "grass", label: "Grass" },
  { id: "wood", label: "Wood" },
];

export function SlabPanel() {
  const selectedIds = useViewer((s) => s.selection.selectedIds);
  const setSelection = useViewer((s) => s.setSelection);
  const nodes = useScene((s) => s.nodes);
  const updateNode = useScene((s) => s.updateNode);
  const editingHole = useEditor((s) => s.editingHole);
  const setEditingHole = useEditor((s) => s.setEditingHole);

  const selectedId = selectedIds[0];
  const node = selectedId
    ? (nodes[selectedId as AnyNode["id"]] as SlabNode | undefined)
    : undefined;

  /* Elevation and Surface are ground-floor concepts.
       - Elevation's presets are Sunken / Ground / Raised / Step: steps down
         into a living room, up to a threshold. On an upper storey the slab
         IS the storey datum, and nudging it leaves the walls behind at the
         level's own elevation.
       - Surface offers patio, deck, driveway, gravel, grass. Those are
         outdoor ground materials; a first-floor slab is not a driveway.
     A slab is a child of its level, and LevelNode.level is the storey
     number, so 0 is the only floor these apply to. */
  const slabLevel = useMemo(() => {
    if (!node) return 0;
    const parent = node.parentId
      ? (nodes[node.parentId as AnyNode["id"]] as any)
      : undefined;
    if (parent?.type === "level") return Number(parent.level ?? 0);
    return 0;
  }, [node, nodes]);
  const isGroundLevel = slabLevel === 0;

  const handleUpdate = useCallback(
    (updates: Partial<SlabNode>) => {
      if (!selectedId) return;
      updateNode(selectedId as AnyNode["id"], updates);
    },
    [selectedId, updateNode],
  );

  const handleClose = useCallback(() => {
    setSelection({ selectedIds: [] });
    setEditingHole(null);
  }, [setSelection, setEditingHole]);

  useEffect(() => {
    if (!node) {
      setEditingHole(null);
    }
  }, [node, setEditingHole]);

  useEffect(() => {
    return () => {
      setEditingHole(null);
    };
  }, [setEditingHole]);

  const handleAddHole = useCallback(() => {
    if (!(node && selectedId)) return;

    const polygon = node.polygon;
    let cx = 0;
    let cz = 0;
    for (const [x, z] of polygon) {
      cx += x;
      cz += z;
    }
    cx /= polygon.length;
    cz /= polygon.length;

    const holeSize = 0.5;
    const newHole: Array<[number, number]> = [
      [cx - holeSize, cz - holeSize],
      [cx + holeSize, cz - holeSize],
      [cx + holeSize, cz + holeSize],
      [cx - holeSize, cz + holeSize],
    ];
    const currentHoles = node?.holes || [];
    handleUpdate({ holes: [...currentHoles, newHole] });
    setEditingHole({ nodeId: selectedId, holeIndex: currentHoles.length });
  }, [node, selectedId, handleUpdate, setEditingHole]);

  const handleEditHole = useCallback(
    (index: number) => {
      if (!selectedId) return;
      setEditingHole({ nodeId: selectedId, holeIndex: index });
    },
    [selectedId, setEditingHole],
  );

  const handleDeleteHole = useCallback(
    (index: number) => {
      if (!selectedId) return;
      const currentHoles = node?.holes || [];
      const newHoles = currentHoles.filter((_, i) => i !== index);
      handleUpdate({ holes: newHoles });
      if (
        editingHole?.nodeId === selectedId &&
        editingHole?.holeIndex === index
      ) {
        setEditingHole(null);
      }
    },
    [selectedId, node?.holes, handleUpdate, editingHole, setEditingHole],
  );

  if (!node || node.type !== "slab" || selectedIds.length !== 1) return null;

  const calculateArea = (polygon: Array<[number, number]>): number => {
    if (polygon.length < 3) return 0;
    let area = 0;
    const n = polygon.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const pi = polygon[i];
      const pj = polygon[j];
      if (pi && pj) {
        area += pi[0] * pj[1];
        area -= pj[0] * pi[1];
      }
    }
    return Math.abs(area) / 2;
  };

  const area = calculateArea(node.polygon);

  return (
    <PanelWrapper
      icon="/icons/floor.png"
      onClose={handleClose}
      title={node.name || "Slab"}
      width={320}
    >
      {isGroundLevel && (
        <PanelSection title="Elevation">
          <SliderControl
            label="Height"
            max={1}
            min={-1}
            onChange={(v) => handleUpdate({ elevation: v })}
            precision={3}
            step={0.01}
            unit="m"
            value={Math.round(node.elevation * 1000) / 1000}
          />

          <div className="mt-2 grid grid-cols-2 gap-1.5 px-1 pb-1">
            <ActionButton
              label="Sunken (-15cm)"
              onClick={() => handleUpdate({ elevation: -0.15 })}
            />
            <ActionButton
              label="Ground (0m)"
              onClick={() => handleUpdate({ elevation: 0 })}
            />
            <ActionButton
              label="Raised (+5cm)"
              onClick={() => handleUpdate({ elevation: 0.05 })}
            />
            <ActionButton
              label="Step (+15cm)"
              onClick={() => handleUpdate({ elevation: 0.15 })}
            />
          </div>
        </PanelSection>
      )}

      {isGroundLevel && (
        <PanelSection title="Surface">
          <div className="grid grid-cols-4 gap-1 px-1 pb-1">
            {SURFACE_TYPES.map((s) => {
              const isActive = (node.surfaceType ?? "interior") === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleUpdate({ surfaceType: s.id })}
                  className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                    isActive
                      ? "border-amber-500/50 bg-amber-500/20 text-amber-100"
                      : "border-border/30 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </PanelSection>
      )}

      <PanelSection title="Info">
        <div className="flex items-center justify-between px-2 py-1 text-muted-foreground text-sm">
          <span>Area</span>
          <span className="font-mono text-white">{area.toFixed(2)} m²</span>
        </div>
      </PanelSection>

      <PanelSection title="Floor cuts (stair openings / double-height voids)">
        {node.holes && node.holes.length > 0 ? (
          <div className="flex flex-col gap-1 pb-2">
            {node.holes.map((hole, index) => {
              const holeArea = calculateArea(hole);
              const isEditing =
                editingHole?.nodeId === selectedId &&
                editingHole?.holeIndex === index;
              return (
                <div
                  className={`flex items-center justify-between rounded-lg border p-2 transition-colors ${
                    isEditing
                      ? "border-primary/50 bg-primary/10"
                      : "border-transparent hover:bg-accent/30"
                  }`}
                  key={index}
                >
                  <div className="min-w-0 flex-1">
                    <p
                      className={`font-medium text-xs ${isEditing ? "text-primary" : "text-white"}`}
                    >
                      Hole {index + 1} {isEditing && "(Editing)"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {holeArea.toFixed(2)} m² · {hole.length} pts
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {isEditing ? (
                      <ActionButton
                        className="h-7 bg-primary text-primary-foreground hover:bg-primary/90"
                        label="Done"
                        onClick={() => setEditingHole(null)}
                      />
                    ) : (
                      <>
                        <button
                          className="flex h-7 w-7 items-center justify-center rounded-md bg-[#2C2C2E] text-muted-foreground hover:bg-[#3e3e3e] hover:text-foreground"
                          onClick={() => handleEditHole(index)}
                          type="button"
                        >
                          <Edit className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="flex h-7 w-7 items-center justify-center rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300"
                          onClick={() => handleDeleteHole(index)}
                          type="button"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-2 py-3 text-center text-muted-foreground text-xs">
            No holes
          </div>
        )}

        <div className="px-1 pt-1 pb-1">
          <button
            type="button"
            disabled={editingHole?.nodeId === selectedId}
            onClick={handleAddHole}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Scissors className="h-4 w-4" />
            Cut floor
          </button>
          <p className="px-1 pt-1.5 text-[10px] text-muted-foreground">
            Adds an opening at the slab's centre. Drag its corners to shape the
            void (stair shaft, double-height living room, etc).
          </p>
        </div>
      </PanelSection>
    </PanelWrapper>
  );
}
