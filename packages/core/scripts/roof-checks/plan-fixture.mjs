// The operator's plan 0b2efdc6 (read from the localStorage draft 2026-09-25),
// rebuilt as a node graph for off-browser checks. IDs are shortened.
const W = [
  ['w6cz', 0, [-4.2, -0.7], [-11.9, -0.7]], ['7ztr', 0, [-8, -3.5], [-11.8, -3.5]],
  ['hskw', 0, [-9.73, -4.5], [-11.8, -4.5]], ['h1ad', 0, [-9.7, -5.3], [-11.8, -5.3]],
  ['j36b', 0, [-7.8, -5.3], [-8.4, -5.3]], ['y4yo', 0, [-9.7, -6.9], [-11.8, -6.9]],
  ['p2xp', 0, [-8, -7.9], [-9.7, -7.9]], ['c006', 0, [-4.2, -9.4], [-11.8, -9.4]],
  ['l8uu', 0, [-4.2, -0.7], [-4.2, -6]], ['9n3g', 0, [-4.2, -8.7], [-4.2, -9.4]],
  ['aj5o', 0, [-8, -0.7], [-8, -9.4]], ['ey6r', 0, [-9.7, -5.3], [-9.7, -9.4]],
  ['sreg', 0, [-11.8, -1.5], [-11.8, -9.4]], ['7bop', 0, [-11.8, -1.56], [-11.8, -0.7]],
  ['q5wm', 0, [-4.2, -6], [-3.57, -6.63]], ['m8nz', 0, [-3.57, -6.63], [-3.57, -8.03]],
  ['tm1q', 0, [-3.57, -8.03], [-4.2, -8.7]], ['mjq1', 0, [-9.73, -4.5], [-9.73, -5.3]],
  ['183n', 1, [-11.85, -2.27], [-11.85, -6.49]], ['wapl', 1, [-11.85, -2.27], [-6.07, -2.27]],
  ['lt3b', 1, [-6.07, -2.27], [-6.07, -6.74]], ['s3jl', 1, [-6.07, -6.74], [-11.85, -6.49]],
]
const O = [
  ['d', 'xrwx', '7ztr', [0.65, 1.05, 0], 0.78, 2.1], ['d', '446o', 'p2xp', [1.19, 1.05, 0], 0.84, 2.1],
  ['d', 'zcuf', 'c006', [6.36, 1.05, 0], 0.77, 2.1], ['d', 'qw2d', 'c006', [4.95, 1.05, 0], 0.84, 2.1],
  ['d', 'vl7r', 'aj5o', [5.31, 1.05, 0], 0.77, 2.1], ['d', '7y69', 'ey6r', [1.07, 1.05, 0], 0.6, 2.1],
  ['d', 'm0g9', 'mjq1', [0.49, 1.05, 0], 0.5, 2.1], ['w', 'd0uy', 'w6cz', [2.29, 1, 0], 1.68, 1.2],
  ['w', 'oyh7', 'w6cz', [5.39, 1, 0], 1.69, 1.2], ['w', 't67z', 'c006', [2.77, 1, 0], 0.83, 1.2],
  ['w', '6cma', 'l8uu', [2.3, 1, 0], 1.68, 1.2], ['w', 'tsih', 'sreg', [6.44, 1, 0], 1.24, 1.2],
  ['w', 'd9jv', 'sreg', [4.97, 1, 0], 0.52, 1.2], ['w', 'kgj0', 'q5wm', [0.46, 1.5, 0], 0.61, 1.5],
  ['w', 'xvz0', 'm8nz', [0.68, 1.5, 0], 1.1, 1.5], ['w', 'owwg', 'tm1q', [0.48, 1.5, 0], 0.61, 1.5],
  ['w', 'lh3r', '183n', [1.48, 1.5, 0], 1.5, 1.5],
]

export function buildPlan({ dormerWindow = null, extra = {} } = {}) {
  const nodes = {}
  const L = ['level_0', 'level_1']
  L.forEach((id, i) => (nodes[id] = { id, type: 'level', level: i, children: [], parentId: null }))
  for (const [id, lvl, start, end] of W) {
    const wid = `wall_${id}`
    nodes[wid] = { id: wid, type: 'wall', parentId: L[lvl], start, end, height: 2.7, thickness: 0.15, bulge: 0, children: [] }
    nodes[L[lvl]].children.push(wid)
  }
  for (const [t, id, wall, position, width, height] of O) {
    const nid = `${t === 'w' ? 'window' : 'door'}_${id}`
    nodes[nid] = { id: nid, type: t === 'w' ? 'window' : 'door', wallId: `wall_${wall}`, parentId: `wall_${wall}`, position, width, height }
    nodes[`wall_${wall}`].children.push(nid)
  }
  const roofs = [
    ['roof_3clls9', [-3.712, 0, -7.778], 'rseg_l3l6ct',
      { roofType: 'gable', ridgeAxis: 'east-west', width: 1.382, depth: 3.439, roofHeight: 1, position: [0, 0, 0] }],
    ['roof_5unzdb', [-8.147, 0, -2.97], 'rseg_7ywyzq',
      { roofType: 'gable', ridgeAxis: 'north-south', width: 8, depth: 6.501, roofHeight: 3.7, position: [0, 0.134, -0.024],
        dormers: [{ id: 'dorm1', type: 'gable', parentFaceId: 0, ridgeHeight: 1.4996, cheekWidth: 2.5999,
          ridgeOrientation: 'orthogonal', footOnParent: [[0.335, 0.275], [0.565, 0.425]],
          ...(dormerWindow ? { windowId: dormerWindow } : {}) }] }],
    ['roof_tiypbu', [-7.996, 0, -7.331], 'rseg_iz8x9q',
      { roofType: 'gable', ridgeAxis: 'north-south', width: 7.743, depth: 4.102, roofHeight: 3.7, position: [0, 0, 0],
        edgeWeights: [0.577, 0.577, 0.577, 0.7] }],
  ]
  for (const [rid, pos, sid, seg] of roofs) {
    nodes[rid] = { id: rid, type: 'roof', parentId: 'level_0', position: pos, rotation: 0, children: [sid] }
    nodes['level_0'].children.push(rid)
    nodes[sid] = { id: sid, type: 'roof-segment', parentId: rid, rotation: 0, wallHeight: 0, overhang: 0.3, ...seg, ...(extra[sid] ?? {}) }
  }
  return nodes
}

/** World centre + head/sill of a window, for assertions. */
export function windowWorld(nodes, winId) {
  const w = nodes[winId]
  const wall = nodes[w.wallId]
  const L = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])
  const d = [(wall.end[0] - wall.start[0]) / L, (wall.end[1] - wall.start[1]) / L]
  const lvlElev = wall.parentId === 'level_1' ? 2.7 : 0
  const cy = lvlElev + w.position[1]
  return { x: wall.start[0] + d[0] * w.position[0], z: wall.start[1] + d[1] * w.position[0],
    cy, head: cy + w.height / 2, sill: cy - w.height / 2 }
}
