import { sceneRegistry, useScene, type ZoneNode } from '@ritn3d/core'
import { useViewer } from '@ritn3d/viewer'
import { useFrame } from '@react-three/fiber'
import useEditor from '../../../store/use-editor'

export const ZoneSystem = () => {
  useFrame(() => {
    const structureLayer = useEditor.getState().structureLayer
    const levelMode = useViewer.getState().levelMode
    const selectedLevelId = useViewer.getState().selection.levelId

    // Ritn3D 2026-07-24: zones are always visible now so auto-detected
    // rooms are always clickable (opens the ZonePanel room-type picker).
    // Was `structureLayer === 'zones'`, but the layer picker was hidden
    // in minimal-launch mode so users could never turn it on.
    const visible = true
    const zones = sceneRegistry.byType.zone || new Set()
    const nodes = useScene.getState().nodes

    zones.forEach((zoneId) => {
      const obj = sceneRegistry.nodes.get(zoneId)
      if (!obj) return

      const zone = nodes[zoneId as ZoneNode['id']] as ZoneNode | undefined

      // In solo mode, hide labels for zones not on the current level
      const isOnSelectedLevel = zone?.parentId === selectedLevelId
      const hideInSoloMode = levelMode === 'solo' && selectedLevelId && !isOnSelectedLevel

      if (obj.visible !== visible) {
        obj.visible = visible
      }

      // Hide label if zone layer is off OR if in solo mode on a different level
      const showLabel = visible && !hideInSoloMode
      const targetOpacity = showLabel ? '1' : '0'
      const labelEl = document.getElementById(`${zoneId}-label`)
      if (labelEl && labelEl.style.opacity !== targetOpacity) {
        labelEl.style.opacity = targetOpacity
      }
    })
  })

  return null
}
