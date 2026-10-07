// ============================================================
// HipWear — Fast STL welding and reduction WITHOUT smoothing
// ------------------------------------------------------------
// Full-resolution scans (hundreds of MB to > 1 GB, 10–20 million triangles) do not fit the
// analysis in a browser tab. Two tools, both used by the STL worker:
//
//  • StlWelder: binary STL triangles are welded on the fly (exact float32 equality, open-
//    addressing hash on typed arrays) while the file is read in chunks, so neither the raw
//    triangle soup nor string keys are ever held in memory.
//
//  • reduceMeshNoSmoothing: vertex clustering on a uniform grid where each cell is represented
//    by ONE ORIGINAL VERTEX (the one closest to the cell centre) — never by an average. The
//    reduced surface passes through measured points only, so scanner noise, paint and wear are
//    sampled, not filtered: σ, the form error and the fitted spheres keep their meaning.
//    Triangles whose corners fall in fewer than three distinct cells are dropped, duplicates
//    are removed and the vertex normals are recomputed from the new faces.
// ============================================================

export interface WeldedMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  faceCount: number;
}

function nextPow2(n: number): number {
  let c = 1;
  while (c < n) c *= 2;
  return c;
}

/** Incremental welder for binary STL triangles (exact float32 equality). */
export class StlWelder {
  private table: Int32Array;
  private mask: number;
  private pos: Float32Array;
  private bits: Uint32Array;          // same memory as pos, for exact comparisons
  private nrm: Float32Array;
  private idx: Uint32Array;
  private u = 0;                      // unique vertices
  private f = 0;                      // faces written

  private faceCapacity: number;

  constructor(faceCapacity: number) {
    this.faceCapacity = Math.max(16, faceCapacity);
    const expected = Math.max(1024, Math.ceil(faceCapacity * 0.6));
    const cap = nextPow2(expected * 2);
    this.table = new Int32Array(cap).fill(-1);
    this.mask = cap - 1;
    this.pos = new Float32Array(expected * 3);
    this.bits = new Uint32Array(this.pos.buffer);
    this.nrm = new Float32Array(expected * 3);
    this.idx = new Uint32Array(this.faceCapacity * 3);
  }

  get faces(): number { return this.f; }

  private growFaces(): void {
    this.faceCapacity *= 2;
    const q = new Uint32Array(this.faceCapacity * 3); q.set(this.idx); this.idx = q;
  }

  private grow(): void {
    const n = this.pos.length * 2;
    const p = new Float32Array(n); p.set(this.pos); this.pos = p; this.bits = new Uint32Array(p.buffer);
    const q = new Float32Array(n); q.set(this.nrm); this.nrm = q;
    // rehash into a larger table to keep the load factor below 0.5
    const cap = nextPow2((n / 3) * 2);
    const t = new Int32Array(cap).fill(-1);
    const m = cap - 1;
    for (let k = 0; k < this.u; k++) {
      let h = this.hash(this.bits[k * 3], this.bits[k * 3 + 1], this.bits[k * 3 + 2]) & m;
      while (t[h] !== -1) h = (h + 1) & m;
      t[h] = k;
    }
    this.table = t; this.mask = m;
  }

  private hash(a: number, b: number, c: number): number {
    return (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) >>> 0;
  }

  private vertex(bx: number, by: number, bz: number, x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    let h = this.hash(bx, by, bz) & this.mask;
    const T = this.table, B = this.bits;
    for (;;) {
      const k = T[h];
      if (k === -1) break;
      if (B[k * 3] === bx && B[k * 3 + 1] === by && B[k * 3 + 2] === bz) {
        this.nrm[k * 3] += nx; this.nrm[k * 3 + 1] += ny; this.nrm[k * 3 + 2] += nz;
        return k;
      }
      h = (h + 1) & this.mask;
    }
    if ((this.u + 1) * 3 > this.pos.length) { this.grow(); return this.vertex(bx, by, bz, x, y, z, nx, ny, nz); }
    const k = this.u++;
    this.pos[k * 3] = x; this.pos[k * 3 + 1] = y; this.pos[k * 3 + 2] = z;
    this.nrm[k * 3] = nx; this.nrm[k * 3 + 1] = ny; this.nrm[k * 3 + 2] = nz;
    T[h] = k;
    return k;
  }

  /** Add the triangles of a chunk of a binary STL body (50 bytes per triangle). */
  addBinaryChunk(buf: ArrayBuffer, byteOffset: number, triangles: number): void {
    const dv = new DataView(buf, byteOffset, triangles * 50);
    for (let t = 0, o = 0; t < triangles; t++, o += 50) {
      if (this.f >= this.faceCapacity) return;
      const nx = dv.getFloat32(o, true), ny = dv.getFloat32(o + 4, true), nz = dv.getFloat32(o + 8, true);
      for (let v = 0; v < 3; v++) {
        const p = o + 12 + v * 12;
        const bx = dv.getUint32(p, true), by = dv.getUint32(p + 4, true), bz = dv.getUint32(p + 8, true);
        this.idx[this.f * 3 + v] = this.vertex(bx, by, bz, dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true), nx, ny, nz);
      }
      this.f++;
    }
  }

  /** Add one triangle given as coordinates (ASCII STL); the face list grows as needed. */
  addTriangle(c: ArrayLike<number>, nx: number, ny: number, nz: number): void {
    if (this.f >= this.faceCapacity) this.growFaces();
    const f32 = new Float32Array(9);
    for (let i = 0; i < 9; i++) f32[i] = c[i];
    const u32 = new Uint32Array(f32.buffer);
    for (let v = 0; v < 3; v++) {
      this.idx[this.f * 3 + v] = this.vertex(u32[v * 3], u32[v * 3 + 1], u32[v * 3 + 2], f32[v * 3], f32[v * 3 + 1], f32[v * 3 + 2], nx, ny, nz);
    }
    this.f++;
  }

  finish(): WeldedMesh {
    const n = this.u;
    const positions = this.pos.slice(0, n * 3);
    const normals = this.nrm.slice(0, n * 3);
    for (let k = 0; k < n; k++) {
      const l = Math.hypot(normals[k * 3], normals[k * 3 + 1], normals[k * 3 + 2]);
      if (l > 1e-12) { normals[k * 3] /= l; normals[k * 3 + 1] /= l; normals[k * 3 + 2] /= l; }
    }
    const indices = this.f * 3 === this.idx.length ? this.idx : this.idx.slice(0, this.f * 3);
    // release the working buffers
    this.table = new Int32Array(0); this.pos = new Float32Array(0); this.bits = new Uint32Array(0); this.nrm = new Float32Array(0); this.idx = new Uint32Array(0);
    return { positions, normals, indices, vertexCount: n, faceCount: indices.length / 3 };
  }
}

/** Total area of the mesh (mm²). */
export function meshArea(m: WeldedMesh): number {
  const P = m.positions, I = m.indices;
  let A = 0;
  for (let f = 0; f < m.faceCount; f++) {
    const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    A += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return A;
}

export interface ReductionResult {
  mesh: WeldedMesh;
  cellMm: number;
  originalFaces: number;
  originalVertices: number;
}

function clusterOnce(m: WeldedMesh, h: number): WeldedMesh {
  const P = m.positions, n = m.vertexCount;
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  for (let i = 0; i < n; i++) {
    if (P[i * 3] < mnx) mnx = P[i * 3];
    if (P[i * 3 + 1] < mny) mny = P[i * 3 + 1];
    if (P[i * 3 + 2] < mnz) mnz = P[i * 3 + 2];
  }
  // cell of every vertex (hash of the integer cell coordinates → compact cell id)
  const cap = nextPow2(Math.max(1024, n));
  const keys = new Int32Array(cap * 3);
  const slot = new Int32Array(cap).fill(-1);
  const mask = cap - 1;
  const cellOf = new Int32Array(n);
  let cells = 0;
  const repDist: number[] = [];
  const rep: number[] = [];
  for (let i = 0; i < n; i++) {
    const fx = (P[i * 3] - mnx) / h, fy = (P[i * 3 + 1] - mny) / h, fz = (P[i * 3 + 2] - mnz) / h;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    let s = ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & mask;
    let c = -1;
    for (;;) {
      const k = slot[s];
      if (k === -1) {
        if (cells >= cap) throw new Error('cluster table full');
        c = cells++;
        slot[s] = c; keys[c * 3] = ix; keys[c * 3 + 1] = iy; keys[c * 3 + 2] = iz;
        repDist.push(Infinity); rep.push(-1);
        break;
      }
      if (keys[k * 3] === ix && keys[k * 3 + 1] === iy && keys[k * 3 + 2] === iz) { c = k; break; }
      s = (s + 1) & mask;
    }
    cellOf[i] = c;
    const d = (fx - ix - 0.5) ** 2 + (fy - iy - 0.5) ** 2 + (fz - iz - 0.5) ** 2;
    if (d < repDist[c]) { repDist[c] = d; rep[c] = i; }
  }
  // new triangles (distinct cells only, duplicates removed)
  const I = m.indices;
  const out: number[] = [];
  const fcap = nextPow2(Math.max(1024, m.faceCount));
  const fslot = new Int32Array(fcap).fill(-1);
  const fmask = fcap - 1;
  for (let f = 0; f < m.faceCount; f++) {
    const a = cellOf[I[f * 3]], b = cellOf[I[f * 3 + 1]], c = cellOf[I[f * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    // canonical key: sorted triple (orientation kept in the stored face)
    const s0 = Math.min(a, b, c), s2 = Math.max(a, b, c), s1 = a + b + c - s0 - s2;
    let s = ((Math.imul(s0, 73856093) ^ Math.imul(s1, 19349663) ^ Math.imul(s2, 83492791)) >>> 0) & fmask;
    let dup = false;
    for (;;) {
      const k = fslot[s];
      if (k === -1) break;
      const x = out[k * 3], y = out[k * 3 + 1], z = out[k * 3 + 2];
      const t0 = Math.min(x, y, z), t2 = Math.max(x, y, z), t1 = x + y + z - t0 - t2;
      if (t0 === s0 && t1 === s1 && t2 === s2) { dup = true; break; }
      s = (s + 1) & fmask;
    }
    if (dup) continue;
    fslot[s] = out.length / 3;
    out.push(a, b, c);
  }
  // compact the used cells into the new vertex list (original coordinates of the representative)
  const used = new Int32Array(cells).fill(-1);
  let nv = 0;
  for (let k = 0; k < out.length; k++) { const c = out[k]; if (used[c] === -1) used[c] = nv++; }
  const positions = new Float32Array(nv * 3);
  for (let c = 0; c < cells; c++) {
    const j = used[c]; if (j === -1) continue;
    const r = rep[c];
    positions[j * 3] = P[r * 3]; positions[j * 3 + 1] = P[r * 3 + 1]; positions[j * 3 + 2] = P[r * 3 + 2];
  }
  const indices = new Uint32Array(out.length);
  for (let k = 0; k < out.length; k++) indices[k] = used[out[k]];
  // area-weighted vertex normals from the new faces
  const normals = new Float32Array(nv * 3);
  for (let f = 0; f < indices.length / 3; f++) {
    const a = indices[f * 3] * 3, b = indices[f * 3 + 1] * 3, c = indices[f * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { normals[v] += cx; normals[v + 1] += cy; normals[v + 2] += cz; }
  }
  for (let k = 0; k < nv; k++) {
    const l = Math.hypot(normals[k * 3], normals[k * 3 + 1], normals[k * 3 + 2]);
    if (l > 1e-20) { normals[k * 3] /= l; normals[k * 3 + 1] /= l; normals[k * 3 + 2] /= l; }
  }
  return { positions, normals, indices, vertexCount: nv, faceCount: indices.length / 3 };
}

/**
 * Reduce a mesh to about `targetFaces` triangles without smoothing (see header).
 * The cell size is chosen from the surface area (≈ 2 triangles per cell) and refined once
 * if the result misses the target by more than 25 %.
 */
export function reduceMeshNoSmoothing(m: WeldedMesh, targetFaces: number): ReductionResult {
  const A = meshArea(m);
  let h = Math.sqrt((2 * A) / Math.max(1000, targetFaces));
  let r = clusterOnce(m, h);
  if (Math.abs(r.faceCount - targetFaces) > 0.25 * targetFaces && r.faceCount > 0) {
    h *= Math.sqrt(r.faceCount / targetFaces);
    r = clusterOnce(m, h);
  }
  return { mesh: r, cellMm: h, originalFaces: m.faceCount, originalVertices: m.vertexCount };
}
