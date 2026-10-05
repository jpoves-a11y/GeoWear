// ============================================================
// GeoWear — STL Parser Web Worker
// Reads the STL in chunks, welds vertices on the fly (typed-array hash, no string keys, no
// triangle-soup copies) and, for very large scans, reduces the mesh WITHOUT smoothing so that
// full-resolution files (hundreds of MB – > 1 GB) can be analysed in the browser.
// ============================================================

import { StlWelder, reduceMeshNoSmoothing, type WeldedMesh } from '../utils/MeshReduce';

interface ParseResult {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  faceCount: number;
  scaleFactor: number;
  /** Set when the mesh was reduced at load */
  reduction: { originalFaces: number; originalVertices: number; cellMm: number } | null;
}

const CHUNK_TRIANGLES = 1_000_000; // 50 MB per read

const progress = (message: string, p: number) => self.postMessage({ type: 'progress', message, progress: p });

async function readBytes(src: File | Blob | ArrayBuffer, start: number, end: number): Promise<ArrayBuffer> {
  if (src instanceof ArrayBuffer) return src.slice(start, end);
  return await src.slice(start, end).arrayBuffer();
}

function sizeOf(src: File | Blob | ArrayBuffer): number {
  return src instanceof ArrayBuffer ? src.byteLength : src.size;
}

/** Binary unless the header starts with "solid" AND the size does not match the binary layout. */
async function detectBinary(src: File | Blob | ArrayBuffer): Promise<{ binary: boolean; triangles: number }> {
  const size = sizeOf(src);
  if (size < 84) return { binary: false, triangles: 0 };
  const head = await readBytes(src, 0, 84);
  const dv = new DataView(head);
  const count = dv.getUint32(80, true);
  let text = '';
  const u8 = new Uint8Array(head, 0, 80);
  for (let i = 0; i < u8.length; i++) text += String.fromCharCode(u8[i]);
  const looksAscii = text.trim().startsWith('solid');
  const sizeMatches = Math.abs(size - (84 + count * 50)) < 10;
  if (sizeMatches) return { binary: true, triangles: count };
  if (looksAscii) return { binary: false, triangles: 0 };
  // binary file with a wrong triangle count in the header: trust the file size
  return { binary: true, triangles: Math.floor((size - 84) / 50) };
}

async function weldBinary(src: File | Blob | ArrayBuffer, triangles: number): Promise<WeldedMesh> {
  const w = new StlWelder(triangles);
  for (let done = 0; done < triangles; done += CHUNK_TRIANGLES) {
    const k = Math.min(CHUNK_TRIANGLES, triangles - done);
    const buf = await readBytes(src, 84 + done * 50, 84 + (done + k) * 50);
    w.addBinaryChunk(buf, 0, k);
    progress(`Reading STL… ${Math.round(((done + k) / triangles) * 100)} % (${((done + k) / 1e6).toFixed(1)} M triangles)`, 0.6 * (done + k) / triangles);
  }
  return w.finish();
}

async function weldAscii(src: File | Blob | ArrayBuffer): Promise<WeldedMesh> {
  const size = sizeOf(src);
  const w = new StlWelder(Math.max(1000, Math.round(size / 250)));
  const dec = new TextDecoder();
  const num = '([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)';
  const facetRe = new RegExp(`facet\\s+normal\\s+${num}\\s+${num}\\s+${num}[\\s\\S]*?vertex\\s+${num}\\s+${num}\\s+${num}[\\s\\S]*?vertex\\s+${num}\\s+${num}\\s+${num}[\\s\\S]*?vertex\\s+${num}\\s+${num}\\s+${num}[\\s\\S]*?endfacet`, 'g');
  const CH = 32 * 1024 * 1024;
  let carry = '';
  const c = new Float64Array(9);
  for (let start = 0; start < size; start += CH) {
    const end = Math.min(size, start + CH);
    const text = carry + dec.decode(await readBytes(src, start, end), { stream: end < size });
    let last = 0; let m: RegExpExecArray | null;
    facetRe.lastIndex = 0;
    while ((m = facetRe.exec(text)) !== null) {
      for (let i = 0; i < 9; i++) c[i] = parseFloat(m[4 + i]);
      w.addTriangle(c, parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
      last = facetRe.lastIndex;
    }
    carry = text.slice(last);
    progress(`Reading STL (ASCII)… ${Math.round((end / size) * 100)} %`, 0.6 * end / size);
  }
  return w.finish();
}

function detectScale(P: Float32Array, n: number): number {
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  const diag = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz);
  if (diag > 5000) return 0.001;   // μm → mm
  if (diag < 0.1) return 1000;     // m → mm
  return 1;
}

self.onmessage = async function (e: MessageEvent) {
  const { type } = e.data;
  if (type !== 'parse') return;
  try {
    const src: File | Blob | ArrayBuffer = e.data.file ?? e.data.buffer;
    const maxFaces: number = Number(e.data.maxFaces) || 0;
    progress('Parsing STL...', 0);
    const kind = await detectBinary(src);
    let mesh = kind.binary ? await weldBinary(src, kind.triangles) : await weldAscii(src);
    if (mesh.faceCount === 0 || mesh.vertexCount === 0) throw new Error('STL file contains no faces');
    for (let i = 0; i < Math.min(mesh.positions.length, 300); i++) {
      if (!isFinite(mesh.positions[i])) throw new Error('STL contains invalid coordinate values');
    }

    progress('Detecting units...', 0.65);
    const scaleFactor = detectScale(mesh.positions, mesh.vertexCount);
    if (scaleFactor !== 1) for (let i = 0; i < mesh.positions.length; i++) mesh.positions[i] *= scaleFactor;

    let reduction: ParseResult['reduction'] = null;
    if (maxFaces > 0 && mesh.faceCount > maxFaces) {
      progress(`Reducing ${(mesh.faceCount / 1e6).toFixed(1)} M triangles without smoothing...`, 0.75);
      const r = reduceMeshNoSmoothing(mesh, Math.round(0.8 * maxFaces));
      reduction = { originalFaces: r.originalFaces, originalVertices: r.originalVertices, cellMm: r.cellMm };
      mesh = r.mesh;
    }

    progress('Transfer to main thread...', 0.95);
    const result: ParseResult = {
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      vertexCount: mesh.vertexCount,
      faceCount: mesh.faceCount,
      scaleFactor,
      reduction,
    };
    self.postMessage({ type: 'result', result }, { transfer: [result.positions.buffer, result.normals.buffer, result.indices.buffer] });
  } catch (err) {
    self.postMessage({ type: 'error', error: (err as Error).message });
  }
};
