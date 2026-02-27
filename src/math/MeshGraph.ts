// ============================================================
// GeoWear — MeshGraph
// Adjacency graph construction from indexed mesh
// Optimized for large meshes (>1M triangles)
// ============================================================

/**
 * Adjacency graph for mesh vertices.
 * Uses flat arrays for memory efficiency with large meshes.
 */
export class MeshGraph {
  /** Number of unique vertices */
  public readonly vertexCount: number;

  /** For vertex i, neighbors start at offsets[i] and end at offsets[i+1] */
  public readonly offsets: Uint32Array;

  /** Flat array of neighbor vertex indices */
  public readonly neighbors: Uint32Array;

  /** Flat array of edge weights (Euclidean distance) */
  public readonly weights: Float64Array;

  constructor(
    vertexCount: number,
    offsets: Uint32Array,
    neighbors: Uint32Array,
    weights: Float64Array,
  ) {
    this.vertexCount = vertexCount;
    this.offsets = offsets;
    this.neighbors = neighbors;
    this.weights = weights;
  }

  /**
   * Build adjacency graph from indexed mesh data.
   * @param positions Float32Array of xyz positions
   * @param indices Uint32Array of triangle indices
   * @param vertexCount Number of unique vertices
   */
  static build(
    positions: Float32Array,
    indices: Uint32Array,
    vertexCount: number,
  ): MeshGraph {
    const faceCount = indices.length / 3;

    // Pass 1: Count neighbors per vertex (using a Set to avoid duplicates)
    const neighborSets: Set<number>[] = new Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      neighborSets[i] = new Set();
    }

    for (let f = 0; f < faceCount; f++) {
      const i0 = indices[f * 3];
      const i1 = indices[f * 3 + 1];
      const i2 = indices[f * 3 + 2];
      neighborSets[i0].add(i1);
      neighborSets[i0].add(i2);
      neighborSets[i1].add(i0);
      neighborSets[i1].add(i2);
      neighborSets[i2].add(i0);
      neighborSets[i2].add(i1);
    }

    // Build offsets
    const offsets = new Uint32Array(vertexCount + 1);
    let totalEdges = 0;
    for (let i = 0; i < vertexCount; i++) {
      offsets[i] = totalEdges;
      totalEdges += neighborSets[i].size;
    }
    offsets[vertexCount] = totalEdges;

    // Build flat neighbor and weight arrays
    const neighbors = new Uint32Array(totalEdges);
    const weights = new Float64Array(totalEdges);

    for (let i = 0; i < vertexCount; i++) {
      let idx = offsets[i];
      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];

      for (const j of neighborSets[i]) {
        neighbors[idx] = j;
        const dx = positions[j * 3] - px;
        const dy = positions[j * 3 + 1] - py;
        const dz = positions[j * 3 + 2] - pz;
        weights[idx] = Math.sqrt(dx * dx + dy * dy + dz * dz);
        idx++;
      }
    }

    // Free the Sets
    neighborSets.length = 0;

    return new MeshGraph(vertexCount, offsets, neighbors, weights);
  }

  /**
   * Get neighbors and weights for a vertex.
   */
  getNeighbors(vertex: number): Array<{ neighbor: number; weight: number }> {
    const start = this.offsets[vertex];
    const end = this.offsets[vertex + 1];
    const result: Array<{ neighbor: number; weight: number }> = [];
    for (let i = start; i < end; i++) {
      result.push({ neighbor: this.neighbors[i], weight: this.weights[i] });
    }
    return result;
  }

  /**
   * Find boundary vertices (vertices connected to boundary edges).
   * A boundary edge is an edge shared by only one triangle.
   */
  static findBoundaryVertices(indices: Uint32Array, vertexCount: number): Set<number> {
    const edgeCount = new Map<string, number>();
    const faceCount = indices.length / 3;

    for (let f = 0; f < faceCount; f++) {
      const v0 = indices[f * 3];
      const v1 = indices[f * 3 + 1];
      const v2 = indices[f * 3 + 2];

      const edges = [
        [Math.min(v0, v1), Math.max(v0, v1)],
        [Math.min(v1, v2), Math.max(v1, v2)],
        [Math.min(v2, v0), Math.max(v2, v0)],
      ];

      for (const [a, b] of edges) {
        const key = `${a}-${b}`;
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      }
    }

    const boundaryVerts = new Set<number>();
    for (const [key, count] of edgeCount) {
      if (count === 1) {
        const [a, b] = key.split('-').map(Number);
        boundaryVerts.add(a);
        boundaryVerts.add(b);
      }
    }

    return boundaryVerts;
  }
}

/**
 * Min-heap priority queue for Dijkstra's algorithm.
 * Optimized for graph traversal on large meshes.
 */
export class PriorityQueue {
  private heap: Array<{ vertex: number; distance: number }> = [];

  get size(): number {
    return this.heap.length;
  }

  push(vertex: number, distance: number): void {
    this.heap.push({ vertex, distance });
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): { vertex: number; distance: number } | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[i].distance < this.heap[parent].distance) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.heap[left].distance < this.heap[smallest].distance) {
        smallest = left;
      }
      if (right < n && this.heap[right].distance < this.heap[smallest].distance) {
        smallest = right;
      }
      if (smallest !== i) {
        [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
        i = smallest;
      } else {
        break;
      }
    }
  }
}
