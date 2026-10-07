// ============================================================
// HipWear — phantom regression tests
// ------------------------------------------------------------
// Synthetic liners with KNOWN femoral-head penetration are measured with the same
// pipeline as the web app. Each case checks the measured linear / volumetric wear
// against the ground truth with the tolerances established in the phantom validation
// (Two-Sphere Auto: error ≤ 2 % from 0.5 mm at ≥ 30° from the cup axis).
//
// Run:  npm test   (builds this file with Vite for Node and executes it)
// A failing case sets a non-zero exit code, so CI marks the pull request ✗.
// ============================================================

import { WearAnalysisPipeline } from '../src/analysis/WearAnalysis';
import { separateFaces } from '../src/analysis/MeshProcessor';
import { DEFAULT_PARAMS, type AnalysisParams, type AnalysisResults } from '../src/types';
import { makeLiner, trueWearVolumeAbovePlane, punchHoles } from './phantom';

const print = (s: string) => process.stdout.write(s + '\n');
// The pipeline logs every step; keep the test output readable.
console.log = () => {};
console.warn = () => {};

interface Case {
  name: string;
  liner: { delta: number; alphaDeg: number; R: number; noiseUm: number; lfUm?: number; dR?: number; seed?: number; holes?: { th: number; ph: number; r: number }[] };
  mode?: 'two-sphere-auto' | 'manual-geodesic';
  params?: Partial<AnalysisParams>;
  check: (m: Measured, t: Truth) => string[]; // returns failure messages
}
interface Measured { linearUm: number; volumeMm3: number; detected?: boolean; angleDeg?: number | null; linSdUm?: number | null; volSdMm3?: number | null; volMeasuredRadius?: number | null; radiusUsed?: number; altVolumeMm3?: number | null; raw: AnalysisResults }
interface Truth { linearUm: number; volumeMm3: number }

const relErr = (m: number, t: number) => Math.abs(m - t) / Math.max(t, 1e-9);
const within = (label: string, m: number, t: number, tol: number) =>
  relErr(m, t) <= tol ? [] : [`${label}: measured ${m.toFixed(1)} vs true ${t.toFixed(1)} (error ${(relErr(m, t) * 100).toFixed(1)} % > ${(tol * 100).toFixed(0)} %)`];

async function measure(c: Case): Promise<{ m: Measured; t: Truth }> {
  const L = c.liner;
  const lin = makeLiner({
    delta: L.delta, alphaDeg: L.alphaDeg, R: L.R, noiseUm: L.noiseUm, lfUm: L.lfUm ?? 0, dR: L.dR ?? 0,
    seed: L.seed ?? 1, nTheta: 150, offset: [0.7, -0.4, 0.3],
  });
  const { d, c0, nInner } = lin;
  const mesh = L.holes ? punchHoles(lin.mesh, nInner, L.R + (L.dR ?? 0), [0.7, -0.4, 0.3], L.holes) : lin.mesh;
  const mode = c.mode ?? 'two-sphere-auto';
  const params: AnalysisParams = { ...DEFAULT_PARAMS, analysisMode: mode, commercialRadius: L.R, ...c.params };
  const p = new WearAnalysisPipeline();
  const sep = separateFaces(mesh);
  p.setSeparation(sep);
  p.setRimInclination(0, 0);
  p.setRimPlaneNormal([...sep.cupAxis] as [number, number, number]);
  if (mode === 'manual-geodesic') {
    // Simulated operator: selects the side opposite to the penetration, within 85° of the pole.
    const dl = Math.hypot(...d) || 1; const dh = d.map(v => v / dl); const sel: number[] = [];
    for (let i = 0; i < nInner; i++) {
      const x = mesh.positions[i * 3] - c0[0], y = mesh.positions[i * 3 + 1] - c0[1], z = mesh.positions[i * 3 + 2] - c0[2];
      const l = Math.hypot(x, y, z);
      if ((x * dh[0] + y * dh[1] + z * dh[2]) / l < -0.05 && -z / l > Math.cos(85 * Math.PI / 180)) {
        sel.push(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
      }
    }
    p.setManualUnwornPositions(new Float32Array(sel), sel.length / 3);
  }
  const r = await p.runFullAnalysis(mesh, params) as AnalysisResults;
  const zs = r.zoneSpheres!;
  const ts = r.twoSphere;
  const m: Measured = {
    linearUm: ts ? ts.linearWearMm * 1000 : zs.wornSphere.center.distanceTo(zs.unwornSphere.center) * 1000,
    volumeMm3: r.wearVolumeResult?.wearVolume ?? NaN,
    detected: ts?.detected, angleDeg: ts?.directionAngleDeg ?? null,
    linSdUm: ts?.linearWearSdMm != null ? ts.linearWearSdMm * 1000 : null,
    volSdMm3: ts?.volumeSdMm3 ?? null,
    volMeasuredRadius: r.wearVolumeResult?.measuredRadius?.wearVolume ?? null,
    radiusUsed: r.commercialSphere?.commercialRadius,
    altVolumeMm3: ts?.alternativeVolumeMm3 ?? null,
    raw: r,
  };
  const Rtrue = L.R + (L.dR ?? 0);
  const t: Truth = {
    linearUm: L.delta * 1000,
    volumeMm3: L.delta > 0 ? trueWearVolumeAbovePlane(Rtrue, d, c0, r.rimPlane!.point, r.rimPlane!.normal, 700, 1400) : 0,
  };
  return { m, t };
}

const cases: Case[] = [
  {
    name: 'Two-Sphere · 0.5 mm at 45°, R14, noise 20 µm + uneven paint ±15 µm',
    liner: { delta: 0.5, alphaDeg: 45, R: 14, noiseUm: 20, lfUm: 15 },
    check: (m, t) => [
      ...(m.detected ? [] : ['wear not detected']),
      // 0.5 mm with uneven paint: single-phantom errors up to ~7 % in the validation (mean ≈ 1 %)
      ...within('linear (µm)', m.linearUm, t.linearUm, 0.10),
      ...within('volume (mm³)', m.volumeMm3, t.volumeMm3, 0.10),
      ...(m.angleDeg != null && Math.abs(m.angleDeg - 45) <= 10 ? [] : [`direction ${m.angleDeg?.toFixed(1)}° (expected 45 ± 10°)`]),
      ...(m.linSdUm != null && m.linSdUm > 0 && m.linSdUm < 100 ? [] : [`linear SD ${m.linSdUm} µm not in (0, 100)`]),
      ...(m.volSdMm3 != null && m.volSdMm3 > 0 && m.volSdMm3 < 60 ? [] : [`volume SD ${m.volSdMm3} mm³ not in (0, 60)`]),
      // the reported uncertainty must cover the true error (±2 SD)
      ...(m.linSdUm != null && Math.abs(m.linearUm - t.linearUm) <= 2 * m.linSdUm ? [] : ['linear error outside ±2 SD']),
      ...(m.volSdMm3 != null && Math.abs(m.volumeMm3 - t.volumeMm3) <= 2 * m.volSdMm3 ? [] : ['volume error outside ±2 SD']),
    ],
  },
  {
    name: 'Two-Sphere · 2 mm at 70°, R16, noise 20 µm',
    liner: { delta: 2.0, alphaDeg: 70, R: 16, noiseUm: 20, lfUm: 15 },
    check: (m, t) => [...within('linear (µm)', m.linearUm, t.linearUm, 0.03), ...within('volume (mm³)', m.volumeMm3, t.volumeMm3, 0.03)],
  },
  {
    name: 'Two-Sphere · 1 mm at 30°, R14, noise 25 µm',
    liner: { delta: 1.0, alphaDeg: 30, R: 14, noiseUm: 25 },
    check: (m, t) => [...within('linear (µm)', m.linearUm, t.linearUm, 0.05), ...within('volume (mm³)', m.volumeMm3, t.volumeMm3, 0.05)],
  },
  {
    name: 'Two-Sphere · 3 mm at 45°, R14 (large wear)',
    liner: { delta: 3.0, alphaDeg: 45, R: 14, noiseUm: 20, lfUm: 15 },
    check: (m, t) => [...within('linear (µm)', m.linearUm, t.linearUm, 0.03), ...within('volume (mm³)', m.volumeMm3, t.volumeMm3, 0.03)],
  },
  {
    name: 'Two-Sphere · no wear (control)',
    liner: { delta: 0, alphaDeg: 0, R: 14, noiseUm: 20 },
    check: (m) => [
      ...(m.detected === false ? [] : ['false wear detected']),
      ...(m.linearUm === 0 ? [] : [`linear ${m.linearUm.toFixed(1)} µm (expected 0)`]),
      ...(m.volumeMm3 < 5 ? [] : [`volume ${m.volumeMm3.toFixed(1)} mm³ (expected < 5)`]),
    ],
  },
  {
    name: 'Two-Sphere · no wear, cavity radius +0.1 mm (machining / paint)',
    liner: { delta: 0, alphaDeg: 0, R: 14, noiseUm: 20, dR: 0.1 },
    check: (m) => [
      ...(m.detected === false ? [] : ['uniform enlargement taken as directional wear']),
      ...(m.linearUm === 0 ? [] : [`linear ${m.linearUm.toFixed(1)} µm (expected 0)`]),
      // the measured-radius volume removes the uniform enlargement
      ...(m.volMeasuredRadius != null && m.volMeasuredRadius < 5 ? [] : [`measured-radius volume ${m.volMeasuredRadius} mm³ (expected < 5)`]),
    ],
  },
  {
    name: 'Two-Sphere · 1 mm at 45° with cavity radius +0.1 mm: measured-radius volume stays exact',
    liner: { delta: 1.0, alphaDeg: 45, R: 14, noiseUm: 20, dR: 0.1 },
    check: (m, t) => [
      ...within('measured-radius volume (mm³)', m.volMeasuredRadius ?? NaN, t.volumeMm3, 0.03),
      ...(m.volumeMm3 > t.volumeMm3 ? [] : ['nominal-radius volume should include the enlargement']),
    ],
  },
  {
    name: 'Two-Sphere · automatic commercial radius (R16 cup, 3 mm wear)',
    liner: { delta: 3.0, alphaDeg: 45, R: 16, noiseUm: 20 },
    params: { commercialRadius: 0 },
    check: (m, t) => [
      ...(m.radiusUsed === 16 ? [] : [`radius ${m.radiusUsed} mm chosen (expected 16)`]),
      ...within('linear (µm)', m.linearUm, t.linearUm, 0.03),
    ],
  },
  {
    name: 'Two-Sphere · inverted direction swaps the spheres (same linear, different volume)',
    liner: { delta: 1.0, alphaDeg: 45, R: 14, noiseUm: 20 },
    params: { twoSphereDirection: 'inverted' },
    check: (m, t) => [
      ...within('linear (µm)', m.linearUm, t.linearUm, 0.05),
      ...(m.angleDeg != null && Math.abs(m.angleDeg - 135) <= 10 ? [] : [`direction ${m.angleDeg?.toFixed(1)}° (expected 135 ± 10°)`]),
      ...(relErr(m.volumeMm3, t.volumeMm3) > 0.2 ? [] : ['inverted volume should differ from the true (non-inverted) volume']),
      // the "other direction" volume reported with the inverted choice is the true (auto) one
      ...within('alternative volume (mm³)', m.altVolumeMm3 ?? NaN, t.volumeMm3, 0.05),
    ],
  },
  {
    name: 'Two-Sphere Auto · 1 mm at 45° with paint 50 µm and ±50 µm scanner accuracy entered (acquisition SD term)',
    liner: { delta: 1.0, alphaDeg: 45, R: 14, noiseUm: 15, lfUm: 10, seed: 3 },
    params: { scanType: 'structured-light', scanPainted: true, paintThicknessUm: 50, otherUncertaintyUm: 50 },
    check: (m, t) => {
      const ts = m.raw.twoSphere!;
      // u_s = √((50/(2√3))² + (50/√3)²) = 32.3 µm → linear term √2·u_s = 45.6 µm
      const acq = (ts.linearSdAcquisitionMm ?? 0) * 1000;
      const errs = [...within('linear (µm)', m.linearUm, t.linearUm, 0.05)];
      if (Math.abs(acq - 45.6) > 0.5) errs.push(`acquisition linear SD ${acq.toFixed(1)} µm, expected 45.6 µm`);
      if ((m.linSdUm ?? 0) < acq) errs.push('total linear SD must include the acquisition term');
      if (!((ts.volumeSdAcquisitionMm3 ?? 0) > 0)) errs.push('acquisition volume SD missing');
      return errs;
    },
  },
  {
    name: 'Sphericity · unworn cup with 15 µm scanner noise stays small (noise filtered out)',
    liner: { delta: 0, alphaDeg: 45, R: 14, noiseUm: 15, seed: 4 },
    check: (m) => {
      const s = m.raw.sphericity;
      if (!s) return ['sphericity missing'];
      return s.sphericityUm < 30 ? [] : [`sphericity ${s.sphericityUm.toFixed(1)} µm ≥ 30 µm for a perfect sphere with noise`];
    },
  },
  {
    name: 'Sphericity · 1 mm at 45° gives ≈ 0.45 mm of form deviation, identical in every mode',
    liner: { delta: 1.0, alphaDeg: 45, R: 14, noiseUm: 15, lfUm: 10, seed: 4 },
    mode: 'manual-geodesic',
    check: (m) => {
      const s = m.raw.sphericity;
      if (!s) return ['sphericity missing'];
      // same surface measured in Two-Sphere Auto, Sphere BestFit and DSM: 411.5 µm
      const errs = s.sphericityUm > 380 && s.sphericityUm < 520 ? [] : [`sphericity ${s.sphericityUm.toFixed(1)} µm outside 380–520 µm`];
      const pct = 100 * (1 - s.sphericityUm / 1000 / s.radiusMm);
      if (!(Math.abs(s.sphericityPercent - pct) < 1e-9 && s.sphericityPercent > 96 && s.sphericityPercent < 98)) errs.push(`sphericity ${s.sphericityPercent.toFixed(3)} % inconsistent with P–V / R`);
      return errs;
    },
  },
  {
    name: 'Holes · 4 mm hole at the pole left open: volume deficit reported as "missing"',
    liner: { delta: 1.0, alphaDeg: 45, R: 14, noiseUm: 15, holes: [{ th: 0, ph: 0, r: 2 }] },
    check: (m, t) => {
      const h = m.raw.wearVolumeResult?.unfilledHoles;
      if (!h || h.count < 1) return ['open hole not reported'];
      const deficit = t.volumeMm3 - m.volumeMm3;
      // the rest of the deficit (≈ 13 mm³) is the normal bias of the cut plane / noise
      return Math.abs(h.missingVolumeMm3 - deficit) < 0.25 * deficit ? [] : [`missing ${h.missingVolumeMm3.toFixed(1)} mm³ vs deficit ${deficit.toFixed(1)} mm³`];
    },
  },
  {
    name: 'Holes · same hole with Repair Inner Face: filled, volume restored, noise not smoothed away',
    liner: { delta: 1.0, alphaDeg: 45, R: 14, noiseUm: 15, holes: [{ th: 0, ph: 0, r: 2 }] },
    params: { repairInnerFace: true },
    check: (m, t) => {
      const errs = [...within('volume (mm³)', m.volumeMm3, t.volumeMm3, 0.05)];
      const h = m.raw.wearVolumeResult?.unfilledHoles;
      if (h && h.count > 0) errs.push(`${h.count} hole(s) still open`);
      const sig = m.raw.twoSphere?.noiseSigmaUm ?? 0;
      if (Math.abs(sig - 15) > 3) errs.push(`noise σ ${sig.toFixed(1)} µm (expected ≈ 15: the fit must see the unsmoothed surface)`);
      return errs;
    },
  },
  {
    name: 'Radius excess · 1 mm at 45° with cavity +0.1 mm: radius-corrected linear wear ≈ true penetration',
    liner: { delta: 1.0, alphaDeg: 45, R: 14, noiseUm: 20, dR: 0.1 },
    check: (m, t) => {
      const ts = m.raw.twoSphere!;
      const corr = (ts.linearCorrectedMm ?? NaN) * 1000;
      const errs = [...within('corrected linear (µm)', corr, t.linearUm, 0.05)];
      if (!(m.raw.wearVolumeResult?.measuredRadius?.wearVolumeSdMm3! > 0)) errs.push('measured-radius volume SD missing');
      if (!(ts.wornAreaMm2! > 0 && ts.wornAreaPct! > 0 && ts.wornAreaPct! < 100)) errs.push('worn area missing');
      return errs;
    },
  },
  {
    name: 'Detection limit · unworn cup reports "not detected" with a finite limit',
    liner: { delta: 0, alphaDeg: 45, R: 14, noiseUm: 15, lfUm: 10 },
    check: (m) => {
      const ts = m.raw.twoSphere!;
      if (ts.detected) return ['false detection'];
      const lod = ts.detectionLimitUm ?? NaN;
      return lod > 40 && lod < 300 ? [] : [`detection limit ${lod} µm outside 40–300 µm`];
    },
  },
  {
    name: 'Manual Geodesic · 0.5 mm at 45° with a simulated operator selection',
    liner: { delta: 0.5, alphaDeg: 45, R: 14, noiseUm: 20 },
    mode: 'manual-geodesic',
    check: (m, t) => [...within('linear (µm)', m.linearUm, t.linearUm, 0.10), ...within('volume (mm³)', m.volumeMm3, t.volumeMm3, 0.10)],
  },
];

async function main() {
  let failed = 0;
  const t0 = Date.now();
  for (const c of cases) {
    const s = Date.now();
    try {
      const { m, t } = await measure(c);
      const errs = c.check(m, t);
      const sdTxt = m.linSdUm != null ? ` (SD ${m.linSdUm.toFixed(1)} µm / ${m.volSdMm3?.toFixed(1)} mm³)` : '';
      const line = `measured/true: lin ${m.linearUm.toFixed(1)}/${t.linearUm.toFixed(1)} µm · vol ${m.volumeMm3.toFixed(1)}/${t.volumeMm3.toFixed(1)} mm³${sdTxt} · ${((Date.now() - s) / 1000).toFixed(1)} s`;
      if (errs.length) { failed++; print(`✗ ${c.name}\n    ${line}\n    - ${errs.join('\n    - ')}`); }
      else print(`✓ ${c.name}\n    ${line}`);
    } catch (e) {
      failed++;
      print(`✗ ${c.name}\n    exception: ${(e as Error).message}`);
    }
  }
  print(`\n${cases.length - failed}/${cases.length} phantom cases passed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (failed) process.exitCode = 1;
}

main();
