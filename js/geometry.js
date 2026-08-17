// Turns the flattened, nested-panel STL (all parts extruded to a common thickness,
// sitting in the XY plane) into 2D part outlines, hole loops, and recessed pockets.
//
// Approach: connected components of same-facing, same-height triangles trace out
// closed 2D loops (any boundary edge with no matching reverse edge elsewhere in the
// component is a silhouette edge; chaining those gives one outer loop plus one loop
// per hole/gap). This is applied twice:
//   - to the bottom face (normal ~ (0,0,-1)) to get each physical part's outline
//     and through-holes (a hole is just a gap in the mesh, so its rim is its own loop).
//   - to the top face (normal ~ (0,0,1)), split out by Z-height, to find recessed
//     pockets: any top-facing region sitting below the material's full thickness is
//     a pocket floor, and its loop is the pocket's plan shape.

function keyPt(v, precision) {
  return Math.round(v[0] * precision) + ',' + Math.round(v[1] * precision) + ',' + Math.round(v[2] * precision);
}

function edgesOf(tri) {
  return [[tri.v[0], tri.v[1]], [tri.v[1], tri.v[2]], [tri.v[2], tri.v[0]]];
}

// Connected components (triangles sharing an edge) + boundary loops for an
// arbitrary triangle subset. Returns [{ triIndices, bbox, loops: [LoopInfo] }].
function extractComponents(triangles, precision) {
  const n = triangles.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }

  const edgeOwner = new Map();
  for (let i = 0; i < n; i++) {
    for (const [a, b] of edgesOf(triangles[i])) {
      const k = keyPt(a, precision) + '|' + keyPt(b, precision);
      if (!edgeOwner.has(k)) edgeOwner.set(k, []);
      edgeOwner.get(k).push(i);
    }
  }
  for (let i = 0; i < n; i++) {
    for (const [a, b] of edgesOf(triangles[i])) {
      const revKey = keyPt(b, precision) + '|' + keyPt(a, precision);
      const owners = edgeOwner.get(revKey);
      if (owners) for (const j of owners) union(i, j);
    }
  }

  const compMap = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!compMap.has(r)) compMap.set(r, []);
    compMap.get(r).push(i);
  }

  const components = [];
  for (const triIdxs of compMap.values()) {
    const compEdgeSet = new Set();
    for (const i of triIdxs) for (const [a, b] of edgesOf(triangles[i])) {
      compEdgeSet.add(keyPt(a, precision) + '|' + keyPt(b, precision));
    }

    const boundaryEdges = [];
    for (const i of triIdxs) {
      for (const [a, b] of edgesOf(triangles[i])) {
        const revKey = keyPt(b, precision) + '|' + keyPt(a, precision);
        if (!compEdgeSet.has(revKey)) boundaryEdges.push([a, b]);
      }
    }

    const byStart = new Map();
    for (const e of boundaryEdges) {
      const k = keyPt(e[0], precision);
      if (!byStart.has(k)) byStart.set(k, []);
      byStart.get(k).push(e);
    }
    const used = new Set();
    const loops = [];
    for (const e of boundaryEdges) {
      if (used.has(e)) continue;
      const loopPts = [];
      let cur = e;
      const startKey = keyPt(e[0], precision);
      let guard = 0;
      while (guard++ < 100000) {
        used.add(cur);
        loopPts.push(cur[0]);
        const nextKey = keyPt(cur[1], precision);
        const cands = byStart.get(nextKey);
        if (!cands) break;
        const next = cands.find(c => !used.has(c));
        if (!next) break;
        cur = next;
        if (keyPt(cur[0], precision) === startKey) break;
      }
      if (loopPts.length >= 3) loops.push(loopPts.map(p => [p[0], p[1]]));
    }

    if (loops.length === 0) continue;

    let bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const i of triIdxs) {
      for (const v of triangles[i].v) {
        bbox.minX = Math.min(bbox.minX, v[0]); bbox.maxX = Math.max(bbox.maxX, v[0]);
        bbox.minY = Math.min(bbox.minY, v[1]); bbox.maxY = Math.max(bbox.maxY, v[1]);
      }
    }

    // Collapse STL tessellation noise (dense point clusters CAD tools often
    // leave around a corner) before it can confuse circle-detection or offsetting.
    components.push({ triIndices: triIdxs, bbox, loops: loops.map(pts => makeLoopInfo(simplifyClosedLoop(pts, SIMPLIFY_TOLERANCE))) });
  }
  return components;
}

function analyzeGeometry(triangles, opts) {
  opts = opts || {};
  const precision = opts.precision || 1000; // ~0.001mm dedup tolerance

  let minZ = Infinity, maxZ = -Infinity;
  for (const t of triangles) {
    for (const v of t.v) { if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2]; }
  }
  const materialThickness = maxZ - minZ;

  // --- Parts + through-holes, from the bottom face ---
  const bottom = triangles.filter(t => t.n.z < -0.9 && Math.abs(t.n.x) < 0.1 && Math.abs(t.n.y) < 0.1);
  const bottomComponents = extractComponents(bottom, precision);

  const parts = bottomComponents.map(comp => {
    let outerIdx = 0, maxAbs = -1;
    comp.loops.forEach((li, idx) => { if (Math.abs(li.area) > maxAbs) { maxAbs = Math.abs(li.area); outerIdx = idx; } });
    const outer = comp.loops[outerIdx];
    const holes = comp.loops.filter((_, idx) => idx !== outerIdx);
    return { bbox: comp.bbox, outer, holes, pockets: [] };
  });

  // --- Recessed pockets, from top-face triangles that sit below full thickness ---
  const top = triangles.filter(t => t.n.z > 0.9 && Math.abs(t.n.x) < 0.1 && Math.abs(t.n.y) < 0.1);
  const zGroups = new Map(); // roundedZ -> triangles
  for (const t of top) {
    const z = Math.round(t.v[0][2] * 20) / 20; // 0.05mm buckets
    if (!zGroups.has(z)) zGroups.set(z, []);
    zGroups.get(z).push(t);
  }
  const topZs = [...zGroups.keys()];
  const fullTopZ = Math.max(...topZs);

  for (const [z, tris] of zGroups) {
    if (Math.abs(z - fullTopZ) < 0.01) continue; // this is the un-recessed top surface, not a pocket
    const depth = fullTopZ - z;
    const pocketComponents = extractComponents(tris, precision);
    for (const comp of pocketComponents) {
      let outerIdx = 0, maxAbs = -1;
      comp.loops.forEach((li, idx) => { if (Math.abs(li.area) > maxAbs) { maxAbs = Math.abs(li.area); outerIdx = idx; } });
      const floorLoop = comp.loops[outerIdx];
      const cx = comp.bbox.minX + (comp.bbox.maxX - comp.bbox.minX) / 2;
      const cy = comp.bbox.minY + (comp.bbox.maxY - comp.bbox.minY) / 2;
      const owner = parts.find(p => cx >= p.bbox.minX && cx <= p.bbox.maxX && cy >= p.bbox.minY && cy <= p.bbox.maxY);
      if (owner) owner.pockets.push({ loop: floorLoop, depth });
    }
  }

  return { materialThickness, parts };
}

// Computes area/centroid, and fits a circle if the loop is close enough to one
// (a hole tessellated as a many-sided polygon reads as circular within tolerance).
function makeLoopInfo(points) {
  let area = 0, cx = 0, cy = 0;
  const N = points.length;
  for (let i = 0; i < N; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % N];
    area += x1 * y2 - x2 * y1;
    cx += x1; cy += y1;
  }
  area /= 2;
  cx /= N; cy /= N;

  const dists = points.map(([x, y]) => Math.hypot(x - cx, y - cy));
  const avgR = dists.reduce((a, b) => a + b, 0) / N;
  const maxDev = Math.max(...dists.map(d => Math.abs(d - avgR)));

  // Radius deviation alone isn't enough: a rectangle with small corner tabs/notches
  // can coincidentally have near-equal centroid distances too. A true tessellated
  // circle is convex everywhere, so every consecutive-edge turn must share the same
  // sign - any tab/notch introduces a concave vertex that flips it. That catches the
  // rectangle-with-tabs case a pure radius check misses.
  const signs = [];
  for (let i = 0; i < N; i++) {
    const prev = points[(i - 1 + N) % N], cur = points[i], next = points[(i + 1) % N];
    const e1x = cur[0] - prev[0], e1y = cur[1] - prev[1];
    const e2x = next[0] - cur[0], e2y = next[1] - cur[1];
    const cross = e1x * e2y - e1y * e2x;
    if (Math.abs(cross) > 1e-6) signs.push(Math.sign(cross));
  }
  const consistentTurning = signs.length > 0 && signs.every(s => s === signs[0]);
  const isCircle = N >= 8 && (maxDev / avgR) < 0.05 && consistentTurning;

  return {
    points,
    area: Math.abs(area),
    centroid: { x: cx, y: cy },
    isCircle,
    circleRadius: isCircle ? avgR : null
  };
}
