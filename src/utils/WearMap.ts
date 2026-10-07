// ============================================================
// HipWear — Wear map figure (PNG)
// ------------------------------------------------------------
// Polar (azimuthal-equidistant) projection of the analysed inner surface seen from the
// cup opening: the pole is the centre of the map and the polar angle from the pole is the
// radius. The colour is the radial deviation from the ORIGINAL (unworn) sphere, i.e. the
// local penetration depth in μm. Maps are rotated so that the penetration direction points
// up (12 o'clock), which makes figures of different liners directly comparable.
// ============================================================

import type { MeshData } from '../types';

export interface WearMapInput {
  mesh: MeshData;                              // trimmed inner surface (working mesh)
  center: [number, number, number];            // centre of the original (unworn) sphere
  radius: number;                              // its radius (mm)
  poleAxis: [number, number, number];          // unit vector from the rim plane toward the pole
  penetrationDir?: [number, number, number] | null; // displaced − original centre (any length) or null
  title: string;
  lines: string[];                             // result lines printed next to the map
  maxUm?: number;                              // colour-scale maximum; auto when omitted
  noiseUm?: number;                            // scanner noise σ: deviations within −3σ…0 are drawn as 0
}

// Viridis (perceptually uniform, prints well in grey scale)
const VIRIDIS: [number, number, number][] = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
  [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37],
];

function viridis(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x)), f = x - i;
  const a = VIRIDIS[i], b = VIRIDIS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function niceMax(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1e-9))));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Draw the wear map on a new canvas (1500 × 1000 px) and return it. */
export function renderWearMap(inp: WearMapInput): HTMLCanvasElement {
  const W = 1500, H = 1000, cx = 500, cy = 545, RM = 410;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);

  const { positions: P, indices: I, vertexCount: n, faceCount } = inp.mesh;
  const [ox, oy, oz] = inp.center;
  let w = inp.poleAxis;
  const wl = Math.hypot(w[0], w[1], w[2]) || 1; w = [w[0] / wl, w[1] / wl, w[2] / wl];

  // In-plane basis: e2 ("up" on the map) along the projected penetration direction when known
  const pd = inp.penetrationDir;
  let up: number[] = pd && Math.hypot(pd[0], pd[1], pd[2]) > 1e-9 ? [...pd] : Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let dw = up[0] * w[0] + up[1] * w[1] + up[2] * w[2];
  up = [up[0] - dw * w[0], up[1] - dw * w[1], up[2] - dw * w[2]];
  if (Math.hypot(up[0], up[1], up[2]) < 1e-6) { up = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; dw = up[0] * w[0] + up[1] * w[1] + up[2] * w[2]; up = [up[0] - dw * w[0], up[1] - dw * w[1], up[2] - dw * w[2]]; }
  const ul = Math.hypot(up[0], up[1], up[2]); const e2 = up.map(v => v / ul);
  // e1 = w × e2: seen from the opening (looking along +w, toward the pole) right × up = −w
  const e1 = [w[1] * e2[2] - w[2] * e2[1], w[2] * e2[0] - w[0] * e2[2], w[0] * e2[1] - w[1] * e2[0]];

  // Per-vertex projection and deviation
  const X = new Float32Array(n), Y = new Float32Array(n), D = new Float32Array(n);
  let thMax = 0;
  const TH = new Float32Array(n), PH = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const vx = P[i * 3] - ox, vy = P[i * 3 + 1] - oy, vz = P[i * 3 + 2] - oz;
    const d = Math.hypot(vx, vy, vz) || 1e-12;
    D[i] = (d - inp.radius) * 1000;
    const th = Math.acos(Math.max(-1, Math.min(1, (vx * w[0] + vy * w[1] + vz * w[2]) / d)));
    TH[i] = th; PH[i] = Math.atan2(vx * e2[0] + vy * e2[1] + vz * e2[2], vx * e1[0] + vy * e1[1] + vz * e1[2]);
    if (th > thMax) thMax = th;
  }
  const thScale = Math.max(thMax, (60 * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const r = (TH[i] / thScale) * RM;
    X[i] = cx + r * Math.cos(PH[i]);
    Y[i] = cy - r * Math.sin(PH[i]);
  }

  // Colour scale
  let maxUm = inp.maxUm ?? 0;
  if (!(maxUm > 0)) {
    const pos: number[] = [];
    const step = Math.max(1, Math.floor(n / 200000));
    for (let i = 0; i < n; i += step) if (D[i] > 0) pos.push(D[i]);
    pos.sort((a, b) => a - b);
    const p995 = pos.length ? pos[Math.min(pos.length - 1, Math.floor(0.995 * (pos.length - 1)))] : 0;
    maxUm = niceMax(Math.max(50, p995));
  }

  // Faces (small negative deviations are scanner noise on the unworn surface: drawn as 0).
  // Triangles added when scan holes were closed are long and thin (fans to the hole centre or across
  // the hole): they carry no measured data, so faces with an edge much longer than the typical mesh
  // edge are left blank instead of being painted as if they were surface.
  const negBand = 3 * Math.max(0, inp.noiseUm ?? 0);
  const edge = (u: number, v: number) => Math.hypot(P[u * 3] - P[v * 3], P[u * 3 + 1] - P[v * 3 + 1], P[u * 3 + 2] - P[v * 3 + 2]);
  const sample: number[] = [];
  const fStep = Math.max(1, Math.floor(faceCount / 20000));
  for (let f = 0; f < faceCount; f += fStep) {
    const a = I[f * 3], b = I[f * 3 + 1], c = I[f * 3 + 2];
    if (a < n && b < n && c < n) sample.push(Math.max(edge(a, b), edge(b, c), edge(c, a)));
  }
  sample.sort((x, y) => x - y);
  const maxEdge = sample.length ? 5 * sample[Math.floor(sample.length / 2)] : Infinity;
  g.lineWidth = 0.6;
  for (let f = 0; f < faceCount; f++) {
    const a = I[f * 3], b = I[f * 3 + 1], c = I[f * 3 + 2];
    if (a >= n || b >= n || c >= n) continue;
    if (Math.max(edge(a, b), edge(b, c), edge(c, a)) > maxEdge) continue;
    const v = (D[a] + D[b] + D[c]) / 3;
    let col: string;
    if (v < -negBand) col = 'rgb(214,214,214)';
    else { const [r, gg, bb] = viridis(v / maxUm); col = `rgb(${r | 0},${gg | 0},${bb | 0})`; }
    g.fillStyle = col; g.strokeStyle = col;
    g.beginPath(); g.moveTo(X[a], Y[a]); g.lineTo(X[b], Y[b]); g.lineTo(X[c], Y[c]); g.closePath();
    g.fill(); g.stroke();
  }

  // Graticule: polar angles every 30°
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1; g.setLineDash([6, 6]);
  g.font = '18px sans-serif'; g.fillStyle = '#444';
  for (let deg = 30; deg <= (thMax * 180) / Math.PI + 0.1; deg += 30) {
    const r = ((deg * Math.PI) / 180 / thScale) * RM;
    g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.stroke();
    g.fillText(`${deg}°`, cx + r * 0.72 + 4, cy + r * 0.72 + 4);
  }
  g.setLineDash([]);
  g.beginPath(); g.arc(cx, cy, 4, 0, 2 * Math.PI); g.fillStyle = '#000'; g.fill();
  g.fillText('pole', cx + 8, cy - 8);

  // Penetration direction arrow (toward the projected direction, i.e. straight up)
  if (pd && Math.hypot(pd[0], pd[1], pd[2]) > 1e-9) {
    const pl = Math.hypot(pd[0], pd[1], pd[2]);
    const ang = Math.acos(Math.max(-1, Math.min(1, (pd[0] * w[0] + pd[1] * w[1] + pd[2] * w[2]) / pl)));
    const r = Math.min(RM, (ang / thScale) * RM);
    g.strokeStyle = '#d62728'; g.fillStyle = '#d62728'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy - r); g.stroke();
    g.beginPath(); g.moveTo(cx, cy - r - 16); g.lineTo(cx - 10, cy - r + 4); g.lineTo(cx + 10, cy - r + 4); g.closePath(); g.fill();
    g.font = 'bold 18px sans-serif';
    g.fillText(`penetration ${(ang * 180 / Math.PI).toFixed(0)}° from the axis`, cx + 14, Math.max(cy - r + 2, 128));
  }

  // Colour bar
  const bx = 1010, by = 170, bw = 34, bh = 520;
  for (let k = 0; k < bh; k++) {
    const [r, gg, bb] = viridis(1 - k / bh);
    g.fillStyle = `rgb(${r | 0},${gg | 0},${bb | 0})`; g.fillRect(bx, by + k, bw, 1);
  }
  g.strokeStyle = '#000'; g.lineWidth = 1; g.strokeRect(bx, by, bw, bh);
  g.fillStyle = '#000'; g.font = '18px sans-serif';
  for (let k = 0; k <= 5; k++) {
    const v = (maxUm * (5 - k)) / 5;
    const yy = by + (bh * k) / 5;
    g.beginPath(); g.moveTo(bx + bw, yy); g.lineTo(bx + bw + 6, yy); g.stroke();
    g.fillText(`${v.toFixed(0)}`, bx + bw + 10, yy + 6);
  }
  g.fillText('penetration (μm)', bx - 10, by - 18);
  g.fillStyle = 'rgb(214,214,214)'; g.fillRect(bx, by + bh + 20, bw, 20);
  g.strokeRect(bx, by + bh + 20, bw, 20);
  g.fillStyle = '#000'; g.fillText(negBand > 0 ? `< −${negBand.toFixed(0)} (inside the original sphere)` : '< 0 (inside the original sphere)', bx + bw + 10, by + bh + 36);
  g.strokeRect(bx, by + bh + 48, bw, 20);
  g.fillText('no data (scan holes)', bx + bw + 10, by + bh + 64);

  // Title and results
  g.fillStyle = '#000'; g.font = 'bold 30px sans-serif';
  g.fillText(inp.title, 40, 55);
  g.font = '17px sans-serif'; g.fillStyle = '#555';
  g.fillText('View from the cup opening · polar angle from the pole as radius · penetration direction up · depth relative to the original sphere', 40, 88);
  g.fillStyle = '#000'; g.font = '19px sans-serif';
  let ty = 800;
  for (const line of inp.lines) { g.fillText(line, 1010, ty); ty += 28; if (ty > H - 20) break; }
  g.font = '15px sans-serif'; g.fillStyle = '#777';
  g.fillText(`HipWear · ${new Date().toISOString().slice(0, 10)}`, 40, H - 20);
  return cv;
}
