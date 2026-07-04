import { type AnyNode, type AnyNodeId, useScene } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { Eye, EyeOff } from 'lucide-react'

interface TreeNodeActionsProps {
  node: AnyNode
}

export function TreeNodeActions({ node }: TreeNodeActionsProps) {
  const updateNode = useScene((state) => state.updateNode)
  const updateNodes = useScene((state) => state.updateNodes)
  const selectedIds = useViewer((state) => state.selection.selectedIds)
  const isVisible = node.visible !== false

  const toggleVisibility = (e: React.MouseEvent) => {
    e.stopPropagation()
    const newVisibility = !isVisible
    if (selectedIds?.includes(node.id)) {
      updateNodes(
        selectedIds.map((id) => ({
          id: id as AnyNodeId,
          data: { visible: newVisibility },
        })),
      )
    } else {
      updateNode(node.id, { visible: newVisibility })
    }
  }

  return (
    <div className="flex items-center gap-0.5">
      <button
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
        onClick={toggleVisibility}
        title={isVisible ? 'Hide' : 'Show'}
      >
        {isVisible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3 opacity-50" />}
      </button>
    </div>
  )
}
