/*
  Ritn3D 2026-07-24: Closed-room auto-detection from wall network.

  Finds every interior face (minimal cycle) in a planar wall graph and
  returns the CCW polygon of each. Called by the AutoRoomDetector system
  on debounced wall changes; new rooms become auto-created ZoneNodes,
  disappearing rooms delete their auto-created zones. Manual zones are
  never touched (see `metadata.autoCreated`).

  Algorithm (standard planar-face traversal):
    1. Cluster wall endpoints into nodes (SNAP tolerance).
    2. Build half-edge structure: each wall contributes two directed edges.
    3. For each unvisited half-edge, trace the face by always picking the
       NEXT clockwise outgoing edge at every junction (right-hand rule
       for the LEFT face of the current half-edge -- this walks the
       interior of a room).
    4. Each traversal yields a face polygon (unique nodes in order).
    5. Reject the outer face (largest signed area OR the one whose
       traversal winds CW instead of CCW after left-face convention).
    6. Reject degenerate faces (< 3 unique nodes, near-zero area).
*/

const SNAP = 0.15 // 15 cm -- editor plans are precise; larger snap merges
                  // intentional close-wall details.
const MIN_ROOM_AREA = 0.5 // m^2 -- reject slivers so drag-in-progress
                          // walls don't briefly spawn tiny rooms.

export interface WallSegment {
  id: string
  start: [number, number]
  end: [number, number]
}

export interface DetectedRoom {
  /** Deterministic signature of the polygon so callers can dedup / match
   *  against existing zones cheaply. */
  signature: string
  /** CCW polygon in world units (metres). */
  polygon: [number, number][]
  /** Metres^2. */
  areaM2: number
}

interface Node {
  x: number
  y: number
}

function polygonSignedArea(poly: [number, number][]): number {
  let a = 0
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % n]
    a += x1 * y2 - x2 * y1
  }
  return a * 0.5
}

function polygonSignature(poly: [number, number][]): string {
  // Rotate so the lowest (x,y) vertex is first, then round to cm.
  // Makes the signature stable regardless of traversal start point.
  let minIdx = 0
  for (let i = 1; i < poly.length; i++) {
    const [px, py] = poly[i]
    const [mx, my] = poly[minIdx]
    if (px < mx - 1e-6 || (Math.abs(px - mx) < 1e-6 && py < my - 1e-6)) minIdx = i
  }
  const rotated: [number, number][] = []
  for (let i = 0; i < poly.length; i++) {
    rotated.push(poly[(minIdx + i) % poly.length])
  }
  return rotated.map(([x, y]) => `${Math.round(x * 100)},${Math.round(y * 100)}`).join('|')
}

export function detectClosedRooms(walls: WallSegment[]): DetectedRoom[] {
  if (walls.length < 3) return []

  // 1. Cluster endpoints
  const nodes: Node[] = []
  const canon = (x: number, y: number): number => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (Math.hypot(n.x - x, n.y - y) < SNAP) return i
    }
    nodes.push({ x, y })
    return nodes.length - 1
  }
  interface Edge { from: number; to: number; wallId: string }
  const edges: Edge[] = []
  for (const w of walls) {
    const a = canon(w.start[0], w.start[1])
    const b = canon(w.end[0], w.end[1])
    if (a === b) continue // degenerate zero-length wall
    edges.push({ from: a, to: b, wallId: w.id })
    edges.push({ from: b, to: a, wallId: w.id }) // reverse half-edge
  }
  if (edges.length === 0) return []

  // 2. Adjacency: for each node, sorted list of outgoing edges by angle.
  const adj: number[][] = Array.from({ length: nodes.length }, () => [])
  for (let i = 0; i < edges.length; i++) adj[edges[i].from].push(i)

  const angleOf = (edgeIdx: number): number => {
    const e = edges[edgeIdx]
    return Math.atan2(nodes[e.to].y - nodes[e.from].y, nodes[e.to].x - nodes[e.from].x)
  }
  for (const list of adj) list.sort((a, b) => angleOf(a) - angleOf(b))

  // 3. Half-edge face traversal. For each unvisited edge, find the "next
  //    edge" by rotating CLOCKWISE from the reverse-of-incoming at the
  //    target node. That walks the LEFT face of the current edge.
  const visited: boolean[] = new Array(edges.length).fill(false)
  const rooms: DetectedRoom[] = []

  const reverseOf = (edgeIdx: number): number => {
    const e = edges[edgeIdx]
    // Its reverse is on adj[e.to] pointing back to e.from with same wallId.
    for (const idx of adj[e.to]) {
      const c = edges[idx]
      if (c.to === e.from && c.wallId === e.wallId) return idx
    }
    return -1
  }

  const nextEdgeInFace = (edgeIdx: number): number => {
    const e = edges[edgeIdx]
    const revIdx = reverseOf(edgeIdx)
    const list = adj[e.to]
    // Find revIdx in list and pick the PREVIOUS one (clockwise from reverse).
    // The list is sorted by angle ascending; previous == largest smaller.
    const revAngle = angleOf(revIdx)
    let best = -1
    let bestDelta = Infinity
    for (const idx of list) {
      if (idx === revIdx) continue
      // Clockwise turn from revAngle to angleOf(idx): (revAngle - a) mod 2pi
      const delta = (revAngle - angleOf(idx) + 2 * Math.PI) % (2 * Math.PI)
      if (delta < bestDelta - 1e-9 && delta > 1e-9) {
        bestDelta = delta
        best = idx
      }
    }
    return best
  }

  for (let start = 0; start < edges.length; start++) {
    if (visited[start]) continue
    const faceEdges: number[] = []
    let cur = start
    let safety = edges.length * 3
    while (!visited[cur] && safety-- > 0) {
      visited[cur] = true
      faceEdges.push(cur)
      const nxt = nextEdgeInFace(cur)
      if (nxt < 0) break
      cur = nxt
      if (cur === start) break
    }
    if (faceEdges.length < 3) continue

    // Build polygon from face edges (node .to of each edge, in order).
    const poly: [number, number][] = []
    const seenNodes = new Set<number>()
    for (const eIdx of faceEdges) {
      const nIdx = edges[eIdx].to
      if (seenNodes.has(nIdx)) continue
      seenNodes.add(nIdx)
      poly.push([nodes[nIdx].x, nodes[nIdx].y])
    }
    if (poly.length < 3) continue

    const signedA = polygonSignedArea(poly)
    // Left-face traversal produces CCW rings for INTERIOR faces (positive
    // signed area). The outer face comes out CW (negative area) -- skip it.
    if (signedA <= 0) continue

    const areaM2 = signedA
    if (areaM2 < MIN_ROOM_AREA) continue

    rooms.push({
      signature: polygonSignature(poly),
      polygon: poly,
      areaM2,
    })
  }

  return rooms
}
