// Offsets a simple polygon (or circle) by a signed distance.
// Positive distance = grow away from the loop's own centroid (used for outer
// part boundaries, so the cutter's edge - not its center - lands on the true line).
// Negative distance = shrink toward the centroid (used for holes/pockets, for the
// same reason).
//
// Concave corners (and very acute convex ones) need special care: naively
// extending both edges to their intersection (a "mitre" join) can overshoot far
// past what the tool can actually reach - mildly at a shallow angle, wildly at a
// tight one. Rather than trying to classify "is this corner too tight" up front,
// we just measure the overshoot directly: if the mitre point is further from the
// original vertex than a small multiple of the offset distance, it's wrong, and
// we replace it with a round join instead - an arc of radius = offset distance,
// centered on the original vertex. That's the correct general fix (it's how
// real offset libraries handle this), and it needs no separate case-by-case
// convex/concave logic: the same distance check catches both a long spike on a
// sharp convex corner and a wrong-side crossing on a tight concave one.
const MITER_LIMIT = 2.0; // mitre allowed up to 2x the offset distance before falling back to a round join
const SIMPLIFY_TOLERANCE = 0.05; // mm - collapses STL tessellation noise around corners before offsetting

function offsetLoop(loop, distance) {
  if (loop.isCircle) {
    return { isCircle: true, center: loop.centroid, radius: loop.circleRadius + distance };
  }
  return { isCircle: false, path: offsetPolygon(loop.points, distance) };
}

// Returns { start:[x,y], segments:[{type:'line',to} | {type:'arc',to,center,radius,ccw}] }
function offsetPolygon(rawPoints, distance) {
  const points = simplifyClosedLoop(rawPoints, SIMPLIFY_TOLERANCE);
  const N = points.length;

  // Outward-normal rule: which side of an edge counts as "outward" has to be
  // decided per edge, but testing "which side is the centroid on" breaks down
  // for concave shapes - a notch or tab can put the centroid right on (or past)
  // an edge's own line, flipping the answer the wrong way exactly where it
  // matters most. Using the loop's overall winding direction instead (shoelace
  // sign, computed once) gives every edge a fixed, unambiguous outward side -
  // always a 90-degree rotation of its own travel direction - regardless of
  // how the shape bends.
  let signedArea = 0;
  for (let i = 0; i < N; i++) {
    const a = points[i], b = points[(i + 1) % N];
    signedArea += a[0] * b[1] - b[0] * a[1];
  }
  const ccwWinding = signedArea > 0;

  // Each edge's own offset line, before any corner trimming/joining.
  const offsetLines = [];
  for (let i = 0; i < N; i++) {
    const p1 = points[i], p2 = points[(i + 1) % N];
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = ccwWinding ? dy / len : -dy / len;
    const ny = ccwWinding ? -dx / len : dx / len;

    offsetLines.push({
      p1: [p1[0] + nx * distance, p1[1] + ny * distance],
      p2: [p2[0] + nx * distance, p2[1] + ny * distance]
    });
  }

  // Decide, per vertex, whether the two adjacent offset edges meet at a plain
  // mitre point or need a round join.
  const joins = [];
  for (let i = 0; i < N; i++) {
    const prevEdge = offsetLines[(i - 1 + N) % N];
    const curEdge = offsetLines[i];
    const M = lineIntersect(prevEdge.p1, prevEdge.p2, curEdge.p1, curEdge.p2);
    const vertex = points[i];

    if (M) {
      const mitreDist = Math.hypot(M[0] - vertex[0], M[1] - vertex[1]);
      if (mitreDist <= MITER_LIMIT * Math.abs(distance)) {
        joins.push({ type: 'point', point: M });
        continue;
      }
    }

    // Round join: arc from where edge(i-1)'s offset line naturally ends to
    // where edge(i)'s offset line naturally starts, centered on the original
    // vertex, radius = |distance|. Always sweeps the minor arc.
    const from = prevEdge.p2, to = curEdge.p1;
    const a1 = Math.atan2(from[1] - vertex[1], from[0] - vertex[0]);
    const a2 = Math.atan2(to[1] - vertex[1], to[0] - vertex[0]);
    let diff = ((a2 - a1 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    joins.push({ type: 'arc', from, to, center: vertex, radius: Math.abs(distance), ccw: diff > 0 });
  }

  // Walk the joins/edges in order to build the final path.
  const j0 = joins[0];
  const start = j0.type === 'point' ? j0.point : j0.from;
  const segments = [];
  let pos = start;

  if (j0.type === 'arc') {
    segments.push({ type: 'arc', to: j0.to, center: j0.center, radius: j0.radius, ccw: j0.ccw });
    pos = j0.to;
  }

  for (let i = 1; i < N; i++) {
    const j = joins[i];
    const target = j.type === 'point' ? j.point : j.from;
    segments.push({ type: 'line', to: target });
    pos = target;
    if (j.type === 'arc') {
      segments.push({ type: 'arc', to: j.to, center: j.center, radius: j.radius, ccw: j.ccw });
      pos = j.to;
    }
  }
  segments.push({ type: 'line', to: start }); // close the loop along the last edge

  return { start, segments };
}

function lineIntersect(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null; // parallel edges (a straight run, no real corner)
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
  return [p1[0] + t * d1x, p1[1] + t * d1y];
}

// Flattens a line/arc path into a plain point list (tessellating arcs), for
// consumers that just need "a polygon" (e.g. the pocket raster-fill clipper)
// rather than an exact toolpath.
function flattenPathToPoints(path, arcStepDeg) {
  arcStepDeg = arcStepDeg || 5;
  const pts = [path.start];
  let pos = path.start;
  for (const seg of path.segments) {
    if (seg.type === 'line') {
      pts.push(seg.to);
      pos = seg.to;
    } else {
      const a1 = Math.atan2(pos[1] - seg.center[1], pos[0] - seg.center[0]);
      let a2 = Math.atan2(seg.to[1] - seg.center[1], seg.to[0] - seg.center[0]);
      let sweep = a2 - a1;
      if (seg.ccw && sweep < 0) sweep += 2 * Math.PI;
      if (!seg.ccw && sweep > 0) sweep -= 2 * Math.PI;
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (arcStepDeg * Math.PI / 180)));
      for (let s = 1; s <= steps; s++) {
        const a = a1 + sweep * (s / steps);
        pts.push([seg.center[0] + seg.radius * Math.cos(a), seg.center[1] + seg.radius * Math.sin(a)]);
      }
      pos = seg.to;
    }
  }
  return pts;
}

// Ramer-Douglas-Peucker simplification, adapted for a closed loop (splits at
// the first point so the standard open-polyline algorithm applies, then
// re-closes). Collapses STL tessellation noise - dense clusters of near-
// collinear points that CAD tools often leave around a corner - back down to
// the handful of vertices that actually matter, before corner classification.
function simplifyClosedLoop(points, tolerance) {
  if (points.length < 5) return points.slice();
  const extended = points.concat([points[0]]);
  const simplified = rdpSimplify(extended, tolerance);
  simplified.pop();
  return simplified.length >= 3 ? simplified : points.slice();
}

function rdpSimplify(points, tolerance) {
  if (points.length < 3) return points.slice();
  const first = points[0], last = points[points.length - 1];
  let maxDist = -1, maxIdx = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > tolerance) {
    const left = rdpSimplify(points.slice(0, maxIdx + 1), tolerance);
    const right = rdpSimplify(points.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function perpendicularDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}
