import { BuildingNode, generateId, LevelNode, SiteNode, WallNode } from '@pascal-app/core'
import type { SceneGraph } from './scene'

type WallDef = { start: [number, number]; end: [number, number]; name?: string }

function buildTemplate(name: string, walls: WallDef[]): SceneGraph {
  const level0 = LevelNode.parse({ level: 0, children: [] })
  const building = BuildingNode.parse({ children: [level0.id] })
  const site = SiteNode.parse({ children: [building] })

  const nodes: Record<string, unknown> = {
    [site.id]: site,
    [building.id]: building,
    [level0.id]: level0,
  }

  const wallIds: string[] = []
  walls.forEach((w, i) => {
    const wall = WallNode.parse({
      name: w.name || `Wall ${i + 1}`,
      start: w.start,
      end: w.end,
      parentId: level0.id,
    })
    nodes[wall.id] = wall
    wallIds.push(wall.id)
  })

  // Update level children with wall IDs
  ;(nodes[level0.id] as any).children = wallIds

  return {
    nodes,
    rootNodeIds: [site.id],
  }
}

// ── Studio Apartment (~30m²) ──
// Single room: 6m x 5m
const STUDIO: WallDef[] = [
  { start: [0, 0], end: [6, 0], name: 'South Wall' },
  { start: [6, 0], end: [6, 5], name: 'East Wall' },
  { start: [6, 5], end: [0, 5], name: 'North Wall' },
  { start: [0, 5], end: [0, 0], name: 'West Wall' },
  // Bathroom partition
  { start: [0, 3.5], end: [2, 3.5], name: 'Bathroom Wall' },
  { start: [2, 3.5], end: [2, 5], name: 'Bathroom Wall 2' },
]

// ── 1 Bedroom (~45m²) ──
// Living+Kitchen: 5m x 4m, Bedroom: 4m x 3.5m, Bathroom: 2m x 2.5m
const ONE_BED: WallDef[] = [
  // Exterior
  { start: [0, 0], end: [9, 0], name: 'South Wall' },
  { start: [9, 0], end: [9, 5], name: 'East Wall' },
  { start: [9, 5], end: [0, 5], name: 'North Wall' },
  { start: [0, 5], end: [0, 0], name: 'West Wall' },
  // Bedroom partition
  { start: [5, 0], end: [5, 5], name: 'Bedroom Partition' },
  // Bathroom
  { start: [5, 3], end: [7, 3], name: 'Bathroom Wall' },
  { start: [7, 3], end: [7, 5], name: 'Bathroom Wall 2' },
]

// ── 2 Bedroom (~65m²) ──
// Living: 5m x 4m, Kitchen: 3m x 3m, Bed1: 4m x 3.5m, Bed2: 3.5m x 3m, Bath: 2m x 2.5m
const TWO_BED: WallDef[] = [
  // Exterior
  { start: [0, 0], end: [10, 0], name: 'South Wall' },
  { start: [10, 0], end: [10, 7], name: 'East Wall' },
  { start: [10, 7], end: [0, 7], name: 'North Wall' },
  { start: [0, 7], end: [0, 0], name: 'West Wall' },
  // Hallway/living division
  { start: [5, 0], end: [5, 4], name: 'Living Partition' },
  // Bedroom 1
  { start: [0, 4], end: [5, 4], name: 'Bedroom 1 South' },
  // Bedroom 2
  { start: [5, 4], end: [10, 4], name: 'Bedroom 2 South' },
  // Bathroom partition
  { start: [7, 4], end: [7, 7], name: 'Bathroom Partition' },
]

// ── 3 Bedroom (~90m²) ──
const THREE_BED: WallDef[] = [
  // Exterior
  { start: [0, 0], end: [12, 0], name: 'South Wall' },
  { start: [12, 0], end: [12, 8], name: 'East Wall' },
  { start: [12, 8], end: [0, 8], name: 'North Wall' },
  { start: [0, 8], end: [0, 0], name: 'West Wall' },
  // Living/bedroom division
  { start: [5, 0], end: [5, 8], name: 'Central Partition' },
  // Bedroom 1
  { start: [0, 4], end: [5, 4], name: 'Bed 1 Partition' },
  // Bedroom 2
  { start: [5, 4], end: [9, 4], name: 'Bed 2 Partition' },
  { start: [9, 0], end: [9, 4], name: 'Bed 2 East' },
  // Bedroom 3
  { start: [9, 4], end: [12, 4], name: 'Bed 3 Partition' },
  // Bathroom
  { start: [9, 6], end: [12, 6], name: 'Bathroom Partition' },
]

// ── Open Plan (~50m²) ──
// Large open space with one bathroom
const OPEN_PLAN: WallDef[] = [
  // L-shaped exterior
  { start: [0, 0], end: [8, 0], name: 'South Wall' },
  { start: [8, 0], end: [8, 3], name: 'East Wall Lower' },
  { start: [8, 3], end: [10, 3], name: 'Step Wall' },
  { start: [10, 3], end: [10, 7], name: 'East Wall Upper' },
  { start: [10, 7], end: [0, 7], name: 'North Wall' },
  { start: [0, 7], end: [0, 0], name: 'West Wall' },
  // Bathroom
  { start: [0, 5], end: [2.5, 5], name: 'Bathroom Wall' },
  { start: [2.5, 5], end: [2.5, 7], name: 'Bathroom Wall 2' },
]

export type TemplateInfo = {
  id: string
  name: string
  description: string
  area: string
  rooms: number
}

export const TEMPLATES: (TemplateInfo & { build: () => SceneGraph })[] = [
  {
    id: 'studio',
    name: 'Studio',
    description: 'Open layout with bathroom',
    area: '~30m²',
    rooms: 1,
    build: () => buildTemplate('Studio', STUDIO),
  },
  {
    id: '1br',
    name: '1 Bedroom',
    description: 'Living, bedroom, bathroom',
    area: '~45m²',
    rooms: 3,
    build: () => buildTemplate('1 Bedroom', ONE_BED),
  },
  {
    id: '2br',
    name: '2 Bedroom',
    description: 'Living, 2 beds, bathroom',
    area: '~65m²',
    rooms: 5,
    build: () => buildTemplate('2 Bedroom', TWO_BED),
  },
  {
    id: '3br',
    name: '3 Bedroom',
    description: 'Living, 3 beds, bathroom',
    area: '~90m²',
    rooms: 6,
    build: () => buildTemplate('3 Bedroom', THREE_BED),
  },
  {
    id: 'open',
    name: 'Open Plan',
    description: 'L-shaped open space',
    area: '~50m²',
    rooms: 2,
    build: () => buildTemplate('Open Plan', OPEN_PLAN),
  },
]
