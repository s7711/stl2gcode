// Clears the interior of a pocket (recessed area that does NOT go through the
// material) with a raster/zigzag fill, leaving a small margin for a separate
// wall-finishing pass to clean up afterwards.

function clipScanline(points, y) {
  const xs = [];
  const N = points.length;
  for (let i = 0; i < N; i++) {
    const p1 = points[i], p2 = points[(i + 1) % N];
    const y1 = p1[1], y2 = p2[1];
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
      const t = (y - y1) / (y2 - y1);
      xs.push(p1[0] + t * (p2[0] - p1[0]));
    }
  }
  xs.sort((a, b) => a - b);
  return xs;
}

// Returns a serpentine list of cut segments [{x1,y1,x2,y2}] that sweep the
// polygon's interior, spaced by `stepover`.
function rasterFillPolygon(points, stepover) {
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of points) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }

  const rows = [];
  if (maxY - minY < stepover) {
    rows.push((minY + maxY) / 2);
  } else {
    for (let y = minY + stepover / 2; y <= maxY - stepover / 2 + 1e-6; y += stepover) rows.push(y);
  }

  const segments = [];
  rows.forEach((y, rowIndex) => {
    const xs = clipScanline(points, y);
    const spans = [];
    for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
    if (rowIndex % 2 === 1) spans.reverse();
    for (const [xa, xb] of spans) {
      const [x1, x2] = rowIndex % 2 === 1 ? [xb, xa] : [xa, xb];
      segments.push({ x1, y1: y, x2, y2: y });
    }
  });
  return segments;
}
