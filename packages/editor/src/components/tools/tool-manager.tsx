import { type AnyNodeId, type CeilingNode, useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import useEditor, { type Phase, type Tool } from '../../store/use-editor'
import { CeilingBoundaryEditor } from './ceiling/ceiling-boundary-editor'
import { CeilingHoleEditor } from './ceiling/ceiling-hole-editor'
import { CeilingTool } from './ceiling/ceiling-tool'
import { RoofTool } from './roof/roof-tool'

// Ritn3D 2026-06-18: tool-manager runs INSIDE the <Viewer> 3D scene, and the
// Viewer is now only mounted for roof and ceiling editing. So this dispatcher
// only handles those two tools — every other tool (wall, door, window, item,
// slab, zone, site polygon) is handled in pure 2D by FloorplanPanel.
const tools: Record<Phase, Partial<Record<Tool, React.FC>>> = {
  site: {},
  structure: {
    ceiling: CeilingTool,
    roof: RoofTool,
  },
  furnish: {},
}

export const ToolManager: React.FC = () => {
  const phase = useEditor((state) => state.phase)
  const mode = useEditor((state) => state.mode)
  const tool = useEditor((state) => state.tool)
  const editingHole = useEditor((state) => state.editingHole)
  const selectedIds = useViewer((state) => state.selection.selectedIds)
  const nodes = useScene((state) => state.nodes)

  // Check if a ceiling is selected
  const selectedCeilingId = selectedIds.find((id) => nodes[id as AnyNodeId]?.type === 'ceiling') as
    | CeilingNode['id']
    | undefined

  const showCeilingBoundaryEditor =
    phase === 'structure' &&
    mode === 'select' &&
    selectedCeilingId !== undefined &&
    (!editingHole || editingHole.nodeId !== selectedCeilingId)

  const showCeilingHoleEditor =
    selectedCeilingId !== undefined &&
    editingHole !== null &&
    editingHole.nodeId === selectedCeilingId

  const showBuildTool = mode === 'build' && tool !== null
  const BuildToolComponent = showBuildTool ? tools[phase]?.[tool] : null

  return (
    <>
      {showCeilingBoundaryEditor && selectedCeilingId && (
        <CeilingBoundaryEditor ceilingId={selectedCeilingId} />
      )}
      {showCeilingHoleEditor && selectedCeilingId && editingHole && (
        <CeilingHoleEditor ceilingId={selectedCeilingId} holeIndex={editingHole.holeIndex} />
      )}
      {BuildToolComponent && <BuildToolComponent />}
    </>
  )
}
