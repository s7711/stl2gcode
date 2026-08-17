// Parses ASCII or binary STL into a flat list of triangles:
// [{ n:{x,y,z}, v:[[x,y,z],[x,y,z],[x,y,z]] }, ...]

function parseSTL(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const asText = new TextDecoder('utf-8').decode(bytes.slice(0, 512)).trimStart();
  if (asText.toLowerCase().startsWith('solid')) {
    // Still could be binary with "solid" header lie - sanity check with expected binary size.
    const text = new TextDecoder('utf-8').decode(bytes);
    if (looksLikeAsciiSTL(text)) return parseAsciiSTL(text);
  }
  return parseBinarySTL(arrayBuffer);
}

function looksLikeAsciiSTL(text) {
  return /facet\s+normal/i.test(text.slice(0, 2000));
}

function parseAsciiSTL(text) {
  const triangles = [];
  const facetRe = /facet\s+normal\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)[\s\S]*?outer loop\s*([\s\S]*?)endloop/gi;
  const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/gi;
  let m;
  while ((m = facetRe.exec(text)) !== null) {
    const n = { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) };
    const loopText = m[4];
    const verts = [];
    let vm;
    vertexRe.lastIndex = 0;
    while ((vm = vertexRe.exec(loopText)) !== null) {
      verts.push([parseFloat(vm[1]), parseFloat(vm[2]), parseFloat(vm[3])]);
    }
    if (verts.length === 3) triangles.push({ n, v: verts });
  }
  return triangles;
}

function parseBinarySTL(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const triCount = dv.getUint32(80, true);
  const triangles = [];
  let offset = 84;
  for (let i = 0; i < triCount; i++) {
    const n = {
      x: dv.getFloat32(offset, true),
      y: dv.getFloat32(offset + 4, true),
      z: dv.getFloat32(offset + 8, true)
    };
    offset += 12;
    const verts = [];
    for (let j = 0; j < 3; j++) {
      verts.push([
        dv.getFloat32(offset, true),
        dv.getFloat32(offset + 4, true),
        dv.getFloat32(offset + 8, true)
      ]);
      offset += 12;
    }
    offset += 2; // attribute byte count
    triangles.push({ n, v: verts });
  }
  return triangles;
}
