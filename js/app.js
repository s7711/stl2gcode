let analysis = null; // { materialThickness, parts }
let originOffset = { x: 0, y: 0 };

const el = id => document.getElementById(id);
const dropZone = el('dropZone');
const fileInput = el('fileInput');
const statusBox = el('status');
const canvas = el('preview');
const ctx = canvas.getContext('2d');

['dragover', 'dragenter'].forEach(evt =>
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(evt =>
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('drag'); }));
dropZone.addEventListener('drop', e => {
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const triangles = parseSTL(reader.result);
      analysis = analyzeGeometry(triangles);
      onAnalysisReady(file.name);
    } catch (err) {
      log('Failed to parse "' + file.name + '": ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function log(msg) {
  statusBox.textContent += msg + '\n';
}

function onAnalysisReady(filename) {
  statusBox.textContent = '';
  log('Loaded ' + filename);
  log('Material thickness (from STL): ' + analysis.materialThickness.toFixed(2) + 'mm');
  log('Parts found: ' + analysis.parts.length);
  const pocketCount = analysis.parts.reduce((sum, p) => sum + p.pockets.length, 0);
  if (pocketCount > 0) {
    log('Recessed pockets found: ' + pocketCount + ' (will be cleared, not cut through - see Program 2)');
    for (const p of analysis.parts) {
      for (const pocket of p.pockets) {
        log('  pocket: depth=' + pocket.depth.toFixed(2) + 'mm, area=' + pocket.loop.area.toFixed(0) + 'mm^2');
      }
    }
  }

  el('materialThickness').value = analysis.materialThickness.toFixed(2);

  let minX = Infinity, minY = Infinity;
  for (const p of analysis.parts) { minX = Math.min(minX, p.bbox.minX); minY = Math.min(minY, p.bbox.minY); }
  originOffset = { x: minX, y: minY };
  el('originX').value = minX.toFixed(2);
  el('originY').value = minY.toFixed(2);

  classifyAndReport();
  draw();
}

function currentParams() {
  return {
    toolDiameter: parseFloat(el('toolDiameter').value),
    materialThickness: parseFloat(el('materialThickness').value),
    stepdown: parseFloat(el('stepdown').value),
    cutThroughExtra: parseFloat(el('cutThroughExtra').value),
    feedRate: parseFloat(el('feedRate').value),
    plungeRate: parseFloat(el('plungeRate').value),
    safeZ: parseFloat(el('safeZ').value),
    pocketStepoverPct: parseFloat(el('pocketStepover').value),
    rampAngleDeg: parseFloat(el('rampAngle').value),
    roughingExtra: parseFloat(el('roughingExtra').value),
    originOffset: { x: parseFloat(el('originX').value), y: parseFloat(el('originY').value) }
  };
}

function smallHoleThreshold() {
  return parseFloat(el('holeThreshold').value);
}

function classifyAndReport() {
  if (!analysis) return;
  const threshold = smallHoleThreshold();
  let smallCount = 0, featureCount = 0, anomalies = 0;
  for (const part of analysis.parts) {
    for (const hole of part.holes) {
      if (hole.area < threshold) {
        if (hole.isCircle) smallCount++;
        else { anomalies++; featureCount++; }
      } else {
        featureCount++;
      }
    }
  }
  log('Hold-down holes (< ' + threshold + ' mm^2, circular): ' + smallCount);
  log('Feature holes (outlines program): ' + featureCount);
  if (anomalies > 0) {
    log('WARNING: ' + anomalies + ' small hole(s) were not circular enough to bore cleanly - sent to outlines program instead.');
  }
}

function collectSmallHoles(threshold) {
  const holes = [];
  for (const part of analysis.parts) {
    for (const hole of part.holes) {
      if (hole.area < threshold && hole.isCircle) holes.push(hole);
    }
  }
  return holes;
}

el('holeThreshold').addEventListener('input', () => { classifyAndReport(); draw(); });
el('originX').addEventListener('input', draw);
el('originY').addEventListener('input', draw);

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!analysis) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of analysis.parts) {
    minX = Math.min(minX, p.bbox.minX); maxX = Math.max(maxX, p.bbox.maxX);
    minY = Math.min(minY, p.bbox.minY); maxY = Math.max(maxY, p.bbox.maxY);
  }
  const margin = 20;
  const scale = Math.min((canvas.width - margin * 2) / (maxX - minX), (canvas.height - margin * 2) / (maxY - minY));

  function toPx(x, y) {
    return [margin + (x - minX) * scale, canvas.height - margin - (y - minY) * scale];
  }

  const threshold = smallHoleThreshold();

  for (const part of analysis.parts) {
    ctx.strokeStyle = '#2b6cb0';
    ctx.lineWidth = 1.5;
    strokeLoop(part.outer, toPx);

    for (const hole of part.holes) {
      ctx.strokeStyle = (hole.area < threshold && hole.isCircle) ? '#e53e3e' : '#dd6b20';
      strokeLoop(hole, toPx);
    }

    ctx.strokeStyle = '#38a169';
    for (const pocket of part.pockets) {
      strokeLoop(pocket.loop, toPx);
    }
  }

  drawOriginMarker(toPx);
}

function drawOriginMarker(toPx) {
  const originXRaw = parseFloat(el('originX').value);
  const originYRaw = parseFloat(el('originY').value);
  if (isNaN(originXRaw) || isNaN(originYRaw)) return;
  const [ox, oy] = toPx(originXRaw, originYRaw);

  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#000000';
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  ctx.arc(ox, oy, 3, 0, Math.PI * 2);
  ctx.stroke();

  const arrowLen = 35;
  drawArrow(ox, oy, ox + arrowLen, oy); // +X: right on screen
  drawArrow(ox, oy, ox, oy - arrowLen); // +Y: up on screen (canvas Y is flipped for drawing)

  ctx.font = '12px monospace';
  ctx.fillText('X', ox + arrowLen + 4, oy + 4);
  ctx.fillText('Y', ox - 4, oy - arrowLen - 6);
}

function drawArrow(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = 7;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function strokeLoop(loop, toPx) {
  ctx.beginPath();
  if (loop.isCircle) {
    const [cx, cy] = toPx(loop.centroid.x, loop.centroid.y);
    const r = loop.circleRadius * Math.abs(toPx(1, 0)[0] - toPx(0, 0)[0]);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  } else {
    loop.points.forEach((p, i) => {
      const [x, y] = toPx(p[0], p[1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
  ctx.stroke();
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

el('downloadHoles').addEventListener('click', () => {
  if (!analysis) return;
  const params = currentParams();
  const threshold = smallHoleThreshold();
  const smallHoles = collectSmallHoles(threshold);
  const gcode = buildHolesProgram(smallHoles, params);
  download('01_holddown_holes.gcode', gcode);
});

el('downloadOutlines').addEventListener('click', () => {
  if (!analysis) return;
  const params = currentParams();
  const threshold = smallHoleThreshold();
  const gcode = buildOutlinesProgram(analysis.parts, params, threshold);
  download('02_outlines.gcode', gcode);
});
