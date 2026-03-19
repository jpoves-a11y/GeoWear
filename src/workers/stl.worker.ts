// ============================================================
// GeoWear — STL Parser Web Worker
// Offloads STL parsing + vertex welding from the main thread
// ============================================================

interface ParseResult {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  faceCount: number;
  scaleFactor: number;
  displayPositions: Float32Array;
  displayNormals: Float32Array;
}

// ---------- Binary STL Parser ----------

function parseBinarySTL(buffer: ArrayBuffer): {
  positions: Float32Array;
  normals: Float32Array;
  faceCount: number;
} {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);

  const expectedSize = 84 + triangleCount * 50;
  if (buffer.byteLength < expectedSize) {
    throw new Error(
      `Invalid binary STL: expected ${expectedSize} bytes, got ${buffer.byteLength}`
    );
  }

  const vertexCount = triangleCount * 3;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);

  let offset = 84;
  for (let t = 0; t < triangleCount; t++) {
    const nx = view.getFloat32(offset, true);
    offset += 4;
    const ny = view.getFloat32(offset, true);
    offset += 4;
    const nz = view.getFloat32(offset, true);
    offset += 4;

    for (let v = 0; v < 3; v++) {
      const vi = t * 3 + v;
      positions[vi * 3] = view.getFloat32(offset, true);
      offset += 4;
      positions[vi * 3 + 1] = view.getFloat32(offset, true);
      offset += 4;
      positions[vi * 3 + 2] = view.getFloat32(offset, true);
      offset += 4;
      normals[vi * 3] = nx;
      normals[vi * 3 + 1] = ny;
      normals[vi * 3 + 2] = nz;
    }

    offset += 2; // attribute byte count
  }

  return { positions, normals, faceCount: triangleCount };
}

// ---------- ASCII STL detection ----------

function isASCII(buffer: ArrayBuffer): boolean {
  const view = new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength));
  let header = '';
  for (let i = 0; i < view.length; i++) header += String.fromCharCode(view[i]);
  header = header.trim();
  if (!header.startsWith('solid')) return false;

  // Binary STL can also start with "solid" in the header.
  // Verify by checking expected binary size.
  if (buffer.byteLength > 84) {
    const dv = new DataView(buffer);
    const triCount = dv.getUint32(80, true);
    const expectedBinarySize = 84 + triCount * 50;
    if (Math.abs(buffer.byteLength - expectedBinarySize) < 10) {
      return false;
    }
  }

  return true;
}

// ---------- ASCII STL Parser ----------

function parseASCIISTL(buffer: ArrayBuffer): {
  positions: Float32Array;
  normals: Float32Array;
  faceCount: number;
} {
  const text = new TextDecoder().decode(buffer);
  const posArr: number[] = [];
  const normArr: number[] = [];

  const vertexRe = /vertex\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g;
  const normalRe = /facet\s+normal\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g;

  const normalMatches: Array<{ nx: number; ny: number; nz: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = normalRe.exec(text)) !== null) {
    normalMatches.push({
      nx: parseFloat(m[1]),
      ny: parseFloat(m[2]),
      nz: parseFloat(m[3]),
    });
  }

  let vertIdx = 0;
  let faceIdx = 0;
  while ((m = vertexRe.exec(text)) !== null) {
    posArr.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    const norm = normalMatches[faceIdx] || { nx: 0, ny: 0, nz: 0 };
    normArr.push(norm.nx, norm.ny, norm.nz);
    vertIdx++;
    if (vertIdx % 3 === 0) faceIdx++;
  }

  return {
    positions: new Float32Array(posArr),
    normals: new Float32Array(normArr),
    faceCount: posArr.length / 9,
  };
}

// ---------- Vertex welding (spatial hashing) ----------

function weldVertices(
  positions: Float32Array,
  normals: Float32Array,
  tolerance: number = 1e-6
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const vertexCount = positions.length / 3;
  const hashMap = new Map<string, number>();
  const newPositions: number[] = [];
  const newNormals: number[] = [];
  const indices = new Uint32Array(vertexCount);
  let uniqueCount = 0;
  const factor = 1 / tolerance;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const key = `${Math.round(x * factor)},${Math.round(y * factor)},${Math.round(z * factor)}`;
    const existing = hashMap.get(key);
    if (existing !== undefined) {
      indices[i] = existing;
      newNormals[existing * 3] += normals[i * 3];
      newNormals[existing * 3 + 1] += normals[i * 3 + 1];
      newNormals[existing * 3 + 2] += normals[i * 3 + 2];
    } else {
      hashMap.set(key, uniqueCount);
      indices[i] = uniqueCount;
      newPositions.push(x, y, z);
      newNormals.push(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      uniqueCount++;
    }
  }

  for (let i = 0; i < uniqueCount; i++) {
    const nx = newNormals[i * 3];
    const ny = newNormals[i * 3 + 1];
    const nz = newNormals[i * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-12) {
      newNormals[i * 3] /= len;
      newNormals[i * 3 + 1] /= len;
      newNormals[i * 3 + 2] /= len;
    }
  }

  return {
    positions: new Float32Array(newPositions),
    normals: new Float32Array(newNormals),
    indices,
  };
}

function buildTriangleIndices(weldedIndices: Uint32Array): Uint32Array {
  const triCount = weldedIndices.length / 3;
  const result = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount; i++) {
    result[i * 3] = weldedIndices[i * 3];
    result[i * 3 + 1] = weldedIndices[i * 3 + 1];
    result[i * 3 + 2] = weldedIndices[i * 3 + 2];
  }
  return result;
}

// ---------- Auto-detect unit scale ----------

function detectScale(positions: Float32Array): number {
  const n = positions.length / 3;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3],
      y = positions[i * 3 + 1],
      z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const diag = Math.sqrt(
    (maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2
  );
  if (diag > 5000) return 0.001;
  if (diag < 0.1) return 1000;
  return 1;
}

// ---------- Worker message handler ----------

self.onmessage = function (e: MessageEvent) {
  const { type, buffer } = e.data;

  if (type === 'parse') {
    try {
      self.postMessage({
        type: 'progress',
        message: 'Parsing STL...',
        progress: 0,
      });

      let parsed;
      if (isASCII(buffer)) {
        parsed = parseASCIISTL(buffer);
      } else {
        parsed = parseBinarySTL(buffer);
      }

      if (parsed.positions.length === 0) {
        throw new Error('STL file contains no vertices');
      }
      if (parsed.faceCount === 0) {
        throw new Error('STL file contains no faces');
      }

      self.postMessage({
        type: 'progress',
        message: 'Detecting units...',
        progress: 0.2,
      });

      const scaleFactor = detectScale(parsed.positions);
      if (scaleFactor !== 1) {
        for (let i = 0; i < parsed.positions.length; i++) {
          parsed.positions[i] *= scaleFactor;
        }
      }

      // Validate
      for (let i = 0; i < Math.min(parsed.positions.length, 300); i++) {
        if (!isFinite(parsed.positions[i])) {
          throw new Error('STL contains invalid coordinate values');
        }
      }

      // Keep a copy of the display-ready data (non-indexed, per-face normals)
      const displayPositions = new Float32Array(parsed.positions);
      const displayNormals = new Float32Array(parsed.normals);

      self.postMessage({
        type: 'progress',
        message: 'Welding vertices...',
        progress: 0.5,
      });

      const welded = weldVertices(parsed.positions, parsed.normals, 1e-6);
      const indices = buildTriangleIndices(welded.indices);

      self.postMessage({
        type: 'progress',
        message: 'Transfer to main thread...',
        progress: 0.9,
      });

      const result: ParseResult = {
        positions: welded.positions,
        normals: welded.normals,
        indices,
        vertexCount: welded.positions.length / 3,
        faceCount: indices.length / 3,
        scaleFactor,
        displayPositions,
        displayNormals,
      };

      // Transfer ownership (zero-copy) of all typed arrays
      self.postMessage(
        { type: 'result', result },
        {
          transfer: [
            result.positions.buffer,
            result.normals.buffer,
            result.indices.buffer,
            displayPositions.buffer,
            displayNormals.buffer,
          ],
        }
      );
    } catch (err) {
      self.postMessage({ type: 'error', error: (err as Error).message });
    }
  }
};
