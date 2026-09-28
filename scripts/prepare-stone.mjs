// prepare-stone.mjs — 把石材产品图处理成「无缝合的干净石板」（本流程的唯一真源）
//   输入：src/stone-source.rgb（由 export-stone-raw.py 从 webp 解出）
//   处理：① 检测原图自带的砖缝带  ② 补丁匹配式填补（不做镜像，避免对称痕迹）
//        ③ 压平摄影光照渐变  ④ 落盘 src/stone-plate.rgb + .json
//   用法：node scripts/prepare-stone.mjs [--flatten 0.6] [--feather 3]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (!h) return d; return h.includes('=') ? h.slice(h.indexOf('=') + 1) : (argv[argv.indexOf(h) + 1] ?? d); };
const FLATTEN = Number(argOf('flatten', 0.6));
const FEATHER = Number(argOf('feather', 3));

const meta = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'src', 'stone-source.json'), 'utf8'));
const W = meta.w, H = meta.h;
const src = fs.readFileSync(path.join(HERE, '..', 'src', 'stone-source.rgb'));
const lum = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) lum[i] = (0.299 * src[i * 3] + 0.587 * src[i * 3 + 1] + 0.114 * src[i * 3 + 2]) / 255;
const L = (x, y) => lum[y * W + x];
console.log(`源图 ${W}x${H}`);

// ── ① 检测缝带：缝是贯穿全长的直线 → 用「与 ±gap 处均值之差」的行/列均值做响应 ──
function detectBands(axis, gap = 6, thr = 0.016, mergeGap = 14) {
  const n = axis === 'x' ? W : H, m = axis === 'x' ? H : W;
  const raw = [];
  for (let i = gap; i < n - gap; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) {
      const c = axis === 'x' ? L(i, j) : L(j, i);
      const a = axis === 'x' ? L(i - gap, j) : L(j, i - gap);
      const b = axis === 'x' ? L(i + gap, j) : L(j, i + gap);
      s += c - (a + b) / 2;
    }
    s /= m;
    if (Math.abs(s) > thr) raw.push(i);
  }
  const bands = [];
  for (const i of raw) {
    if (bands.length && i - bands[bands.length - 1][1] <= mergeGap) bands[bands.length - 1][1] = i;
    else bands.push([i, i]);
  }
  // 向外扩 4px 吃掉亮线光晕，并过滤过窄的
  return bands.map(([a, b]) => [Math.max(0, a - 4), Math.min(n - 1, b + 4)]).filter(([a, b]) => b - a >= 4);
}
const XB = detectBands('x'), YB = detectBands('y');
console.log('缝带（已外扩 4px）:', 'x =', JSON.stringify(XB), ' y =', JSON.stringify(YB));

const out = Buffer.from(src);
const P = (x, y, k) => out[(y * W + x) * 3 + k];
const inBand = (i, bands) => bands.some(([a, b]) => i >= a - 4 && i <= b + 4);

// ── ② 补丁匹配 + 泊松无缝克隆填补 ─────────────────────────────────────────
// 对每条缝带：先在没有缝的区域里搜一条等宽真实石纹（代价 = 与缝两侧各 CTX 列的 SSD），
// 再把它「无缝克隆」进来：解 ∇²f = ∇²patch（Dirichlet 边界取缝外真实石纹值）。
// 这样补丁的石纹细节被保留，而亮度/色差沿缝宽平滑接上 —— 既无镜像对称，也无台阶或条纹。
const CTX = 3, STEP = 2;

/** 通用泊松无缝克隆：把源区域 (sx,sy) 处的 rx×ry 内容克隆进输出区域 (ox,oy) */
function poissonClone(ox, oy, rx, ry, sx, sy) {
  const N = rx * ry;
  const f = new Float32Array(N * 3);
  const lap = new Float32Array(N * 3);
  const S = (i, j, k) => {                       // 源像素（越界钳制）
    const x = Math.min(W - 1, Math.max(0, sx + i)), y = Math.min(H - 1, Math.max(0, sy + j));
    return out[(y * W + x) * 3 + k];
  };
  for (let j = 0; j < ry; j++) for (let i = 0; i < rx; i++) {
    const idx = (j * rx + i) * 3;
    for (let k = 0; k < 3; k++) {
      f[idx + k] = S(i, j, k);
      lap[idx + k] = S(i - 1, j, k) + S(i + 1, j, k) + S(i, j - 1, k) + S(i, j + 1, k) - 4 * S(i, j, k);
    }
  }
  // 区域外侧的固定边界（缝外真实石纹）
  const B = (i, j, k) => {                       // i/j 可为 -1 或 rx/ry
    const x = Math.min(W - 1, Math.max(0, ox + i)), y = Math.min(H - 1, Math.max(0, oy + j));
    return out[(y * W + x) * 3 + k];
  };
  const OMEGA = 1.85;
  const ITER = Math.max(240, Math.round(Math.max(rx, ry) * 0.7));
  for (let it = 0; it < ITER; it++) {
    for (let j = 0; j < ry; j++) {
      const up = j - 1, dn = j + 1;
      for (let i = 0; i < rx; i++) {
        const idx = (j * rx + i) * 3;
        for (let k = 0; k < 3; k++) {
          const l = i === 0 ? B(-1, j, k) : f[(j * rx + i - 1) * 3 + k];
          const r = i === rx - 1 ? B(rx, j, k) : f[(j * rx + i + 1) * 3 + k];
          const u = j === 0 ? B(i, -1, k) : f[(up * rx + i) * 3 + k];
          const d = j === ry - 1 ? B(i, ry, k) : f[(dn * rx + i) * 3 + k];
          const target = (l + r + u + d - lap[idx + k]) * 0.25;
          f[idx + k] += OMEGA * (target - f[idx + k]);
        }
      }
    }
  }
  for (let j = 0; j < ry; j++) for (let i = 0; i < rx; i++) {
    const idx = (j * rx + i) * 3;
    const o = ((oy + j) * W + (ox + i)) * 3;
    for (let k = 0; k < 3; k++) out[o + k] = Math.min(255, Math.max(0, Math.round(f[idx + k])));
  }
  return { rx, ry, iter: ITER };
}

function fillVertical([a, b]) {
  const wBand = b - a + 1;
  const cand = [];
  for (let x0 = 0; x0 + wBand < W; x0 += STEP) if (!inBand(x0, XB) && !inBand(x0 + wBand - 1, XB)) cand.push(x0);
  let best = null;
  for (const x0 of cand) {
    let cost = 0;
    for (let y = 0; y < H; y++) for (let k = 0; k < 3; k++) for (let c = 1; c <= CTX; c++) {
      const d1 = P(x0 + c - 1, y, k) - P(a - c, y, k);
      const d2 = P(x0 + wBand - c, y, k) - P(b + c, y, k);
      cost += d1 * d1 + d2 * d2;
    }
    if (!best || cost < best.cost) best = { x0, cost };
  }
  const rms = Math.sqrt(best.cost / (H * 3 * CTX * 2)) / 255;
  const info = poissonClone(a, 0, wBand, H, best.x0, 0);
  console.log(`  竖缝 x=${a}..${b}（宽 ${wBand}）← 取自 x=${best.x0}..${best.x0 + wBand - 1}，边界 RMS 失配 ${(rms * 100).toFixed(2)}%，泊松 ${info.iter} 轮`);
}

function fillHorizontal([a, b]) {
  const hBand = b - a + 1;
  const cand = [];
  for (let y0 = 0; y0 + hBand < H; y0 += STEP) if (!inBand(y0, YB) && !inBand(y0 + hBand - 1, YB)) cand.push(y0);
  let best = null;
  for (const y0 of cand) {
    let cost = 0;
    for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++) for (let c = 1; c <= CTX; c++) {
      const d1 = P(x, y0 + c - 1, k) - P(x, a - c, k);
      const d2 = P(x, y0 + hBand - c, k) - P(x, b + c, k);
      cost += d1 * d1 + d2 * d2;
    }
    if (!best || cost < best.cost) best = { y0, cost };
  }
  const rms = Math.sqrt(best.cost / (W * 3 * CTX * 2)) / 255;
  const info = poissonClone(0, a, W, hBand, 0, best.y0);
  console.log(`  横缝 y=${a}..${b}（高 ${hBand}）← 取自 y=${best.y0}..${best.y0 + hBand - 1}，边界 RMS 失配 ${(rms * 100).toFixed(2)}%，泊松 ${info.iter} 轮`);
}
for (const b of XB) fillVertical(b);
for (const b of YB) fillHorizontal(b);

// ── ③ 压平摄影光照（O(N) 滑窗盒式模糊，半径 110）────────────────────────
{
  const R = 110;
  const tmp = new Float32Array(W * H), bl = new Float32Array(W * H);
  const lumOut = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) lumOut[i] = (0.299 * out[i * 3] + 0.587 * out[i * 3 + 1] + 0.114 * out[i * 3 + 2]) / 255;
  for (let y = 0; y < H; y++) {
    let sum = 0;
    for (let x = -R; x <= R; x++) sum += lumOut[y * W + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = sum / (2 * R + 1);
      sum += lumOut[y * W + Math.min(W - 1, x + R + 1)] - lumOut[y * W + Math.max(0, x - R)];
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = -R; y <= R; y++) sum += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      bl[y * W + x] = sum / (2 * R + 1);
      sum += tmp[Math.min(H - 1, y + R + 1) * W + x] - tmp[Math.max(0, y - R) * W + x];
    }
  }
  let mean = 0;
  for (let i = 0; i < W * H; i++) mean += lumOut[i];
  mean /= W * H;
  for (let i = 0; i < W * H; i++) {
    const k = 1 + (mean / Math.max(0.07, bl[i]) - 1) * FLATTEN;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.min(255, Math.max(0, Math.round(out[i * 3 + c] * k)));
  }
  console.log(`压平光照 ${(FLATTEN * 100).toFixed(0)}%（全局均值 ${(mean * 255).toFixed(0)}）`);
}

// ── ④ 落盘 + 自检 ────────────────────────────────────────────────────────
fs.writeFileSync(path.join(HERE, '..', 'src', 'stone-plate.rgb'), out);
fs.writeFileSync(path.join(HERE, '..', 'src', 'stone-plate.json'), JSON.stringify({
  w: W, h: H, mode: 'RGB', origin: meta.origin,
  joints_removed: { x: XB, y: YB }, method: 'patch-match fill (no mirror) + feather',
  lighting_flatten: FLATTEN,
}, null, 1));

// 自检：缝位置是否还有亮线残留（列/行均值相对中位数的偏差）
function residual(axis) {
  const n = axis === 'x' ? W : H, m = axis === 'x' ? H : W;
  const prof = [];
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < m; j += 4) s += (axis === 'x' ? L2(i, j) : L2(j, i)); prof.push(s / (m / 4)); }
  const med = [...prof].sort((a, b) => a - b)[Math.floor(n / 2)];
  const worst = prof.map((v, i) => [i, v - med]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const atBand = (axis === 'x' ? XB : YB).map(([a, b]) => Math.max(...prof.slice(a, b + 1)) - med);
  return { worst: worst.map(([i, d]) => `${i}:${d.toFixed(1)}`), bandResidual: atBand.map((d) => d.toFixed(1)) };
}
function L2(x, y) { return (0.299 * out[(y * W + x) * 3] + 0.587 * out[(y * W + x) * 3 + 1] + 0.114 * out[(y * W + x) * 3 + 2]) / 255; }
const rx = residual('x'), ry = residual('y');
console.log(`残留自检：缝带内最大偏差 竖 ${rx.bandResidual.join('/')}、横 ${ry.bandResidual.join('/')}（单位 0-1 亮度；越低越干净）`);
console.log(`         全图最亮列 ${rx.worst.join(' ')} ／ 最亮行 ${ry.worst.join(' ')}`);
console.log(`-> src/stone-plate.rgb (${out.length} bytes) + stone-plate.json`);
