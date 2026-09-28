// make-seamless.mjs —— 通用「照片/贴图 → 严格无缝平铺」工具
//   思路（随机纹理的教科书解法，不需要 AI 补全）：
//     ① 中心裁成正方形  ② 对折偏移半张（这样外边界天然连续，只在中线留下两条缝）
//     ③ 在「无缝合区域」给每条缝搜一条**最吻合的等宽补丁**（与缝两侧各 CTX 列的 SSD 最小）
//     ④ 泊松无缝克隆贴进去（∇²f = ∇²补丁，Dirichlet 边界取缝外真值）—— 两端严格接上、无台阶无条纹
//     ⑤ 自检：接缝跳变 ÷ 内部相邻跳变（>1.6 判不合格）
//   用法：
//     node make-seamless.mjs --in <raw.rgb> --w 1070 --h 1426 [--band 64] [--flatten 0] [--out out/x.png]
//     node make-seamless.mjs --in-png <a.png> ...
//   输出：<out>.png + <out>.rgb（裸 RGB，供后续工具读）+ 同目录 .json（参数与自检结果）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPNG, loadRaw, savePNG, saveRaw } from './lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (!h) return d; return h.includes('=') ? h.slice(h.indexOf('=') + 1) : (argv[argv.indexOf(h) + 1] ?? d); };

const inRaw = arg('in', null), inPng = arg('in-png', null);
if (!inRaw && !inPng) { console.error('需要 --in <raw.rgb> --w W --h H 或 --in-png <a.png>'); process.exit(2); }

let img;
if (inPng) { img = loadPNG(path.resolve(process.cwd(), inPng)); }
else { img = loadRaw(path.resolve(process.cwd(), inRaw), Number(arg('w')), Number(arg('h')), 3); }
let W = img.w, H = img.h;
console.log(`输入 ${W}x${H}，通道 ${img.channels}`);

const BAND = Number(arg('band', 64));          // 缝带总宽（像素）
const CTX = 3;                                  // 边界上下文列数
const FLATTEN = Number(arg('flatten', 0));      // 摄影光照压平强度 0~1（平扫图给 0）
const outBase = path.resolve(process.cwd(), arg('out', path.join(HERE, '..', 'out', 'seamless')));
fs.mkdirSync(path.dirname(outBase), { recursive: true });

// 统一成 3 通道
let px = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) {
  px[i * 3] = img.data[i * img.channels];
  px[i * 3 + 1] = img.data[i * img.channels + (img.channels >= 3 ? 1 : 0)];
  px[i * 3 + 2] = img.data[i * img.channels + (img.channels >= 3 ? 2 : 0)];
}
const at = (x, y, c) => px[(y * W + x) * 3 + c];

// ── ① 中心裁成正方形 ────────────────────────────────────────────────────
if (W !== H) {
  const S = Math.min(W, H);
  const ox = (W - S) >> 1, oy = (H - S) >> 1;
  const np = Buffer.alloc(S * S * 3);
  for (let y = 0; y < S; y++) px.copy(np, y * S * 3, ((y + oy) * W + ox) * 3, ((y + oy) * W + ox + S) * 3);
  px = np; W = H = S;
  console.log(`裁成正方形 ${W}x${H}`);
}

// ── ② 可选：压平摄影光照（O(N) 滑窗盒式模糊，半径 = W/10）────────────────
if (FLATTEN > 0) {
  const R = Math.round(W / 10);
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = (0.299 * px[i * 3] + 0.587 * px[i * 3 + 1] + 0.114 * px[i * 3 + 2]) / 255;
  const tmp = new Float32Array(W * H), bl = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let k = -R; k <= R; k++) s += lum[y * W + Math.min(W - 1, Math.max(0, k))];
    for (let x = 0; x < W; x++) { tmp[y * W + x] = s / (2 * R + 1); s += lum[y * W + Math.min(W - 1, x + R + 1)] - lum[y * W + Math.max(0, x - R)]; }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let k = -R; k <= R; k++) s += tmp[Math.min(H - 1, Math.max(0, k)) * W + x];
    for (let y = 0; y < H; y++) { bl[y * W + x] = s / (2 * R + 1); s += tmp[Math.min(H - 1, y + R + 1) * W + x] - tmp[Math.max(0, y - R) * W + x]; }
  }
  let mean = 0; for (let i = 0; i < W * H; i++) mean += lum[i]; mean /= W * H;
  for (let i = 0; i < W * H; i++) {
    const k = 1 + (mean / Math.max(0.07, bl[i]) - 1) * FLATTEN;
    for (let c = 0; c < 3; c++) px[i * 3 + c] = Math.min(255, Math.max(0, Math.round(px[i * 3 + c] * k)));
  }
  console.log(`压平光照 ${(FLATTEN * 100).toFixed(0)}%`);
}

// ── 接缝度量（自检用）────────────────────────────────────────────────────
function seamScore() {
  const cd = (x1, x2) => { let s = 0; for (let y = 0; y < H; y += 2) for (let c = 0; c < 3; c++) s += Math.abs(at(x1, y, c) - at(x2, y, c)); return s / (3 * Math.ceil(H / 2)); };
  const rd = (y1, y2) => { let s = 0; for (let x = 0; x < W; x += 2) for (let c = 0; c < 3; c++) s += Math.abs(at(x, y1, c) - at(x, y2, c)); return s / (3 * Math.ceil(W / 2)); };
  const ic = [], ir = [];
  for (let x = W >> 2; x < (3 * W) >> 2; x += 17) ic.push(cd(x, x + 1));
  for (let y = H >> 2; y < (3 * H) >> 2; y += 17) ir.push(rd(y, y + 1));
  const m = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return { h: cd(W - 1, 0) / m(ic), v: rd(H - 1, 0) / m(ir), innerC: m(ic), innerR: m(ir), edgeC: cd(W - 1, 0), edgeR: rd(H - 1, 0) };
}
const before = seamScore();
console.log(`\n处理前：左右接缝 ${before.h.toFixed(2)}x 内部（${before.edgeC.toFixed(1)} vs ${before.innerC.toFixed(1)}）｜上下 ${before.v.toFixed(2)}x`);

// ── ③ 对折偏移半张：外边界变连续，中线出现两条缝 ─────────────────────────
{
  const np = Buffer.alloc(W * H * 3);
  const hx = W >> 1, hy = H >> 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = (x + hx) % W, sy = (y + hy) % H;
      np[(y * W + x) * 3] = px[(sy * W + sx) * 3];
      np[(y * W + x) * 3 + 1] = px[(sy * W + sx) * 3 + 1];
      np[(y * W + x) * 3 + 2] = px[(sy * W + sx) * 3 + 2];
    }
  }
  px = np;
}
console.log(`已对折偏移半张 → 缝现在位于中线 x=${W >> 1} 与 y=${H >> 1}`);

// ── ④ 补丁匹配 + 泊松无缝克隆 ────────────────────────────────────────────
const CX = (W - BAND) >> 1, CY = (H - BAND) >> 1;            // 缝带起点（竖带 x∈[CX,CX+BAND)，横带 y∈[CY,CY+BAND)）
const inV = (x) => x >= CX - CTX - 2 && x < CX + BAND + CTX + 2;
const inH = (y) => y >= CY - CTX - 2 && y < CY + BAND + CTX + 2;
const P = (x, y, c) => px[(y * W + x) * 3 + c];

function poissonClone(ox, oy, rx, ry, sx, sy, iter) {
  const N = rx * ry;
  const f = new Float32Array(N * 3), lap = new Float32Array(N * 3);
  const S = (i, j, k) => { const x = Math.min(W - 1, Math.max(0, sx + i)), y = Math.min(H - 1, Math.max(0, sy + j)); return px[(y * W + x) * 3 + k]; };
  for (let j = 0; j < ry; j++) for (let i = 0; i < rx; i++) {
    const id = (j * rx + i) * 3;
    for (let k = 0; k < 3; k++) { f[id + k] = S(i, j, k); lap[id + k] = S(i - 1, j, k) + S(i + 1, j, k) + S(i, j - 1, k) + S(i, j + 1, k) - 4 * S(i, j, k); }
  }
  const B = (i, j, k) => { const x = Math.min(W - 1, Math.max(0, ox + i)), y = Math.min(H - 1, Math.max(0, oy + j)); return px[(y * W + x) * 3 + k]; };
  const OMEGA = 1.85;
  for (let it = 0; it < iter; it++) {
    for (let j = 0; j < ry; j++) {
      for (let i = 0; i < rx; i++) {
        const id = (j * rx + i) * 3;
        for (let k = 0; k < 3; k++) {
          const l = i === 0 ? B(-1, j, k) : f[(j * rx + i - 1) * 3 + k];
          const r = i === rx - 1 ? B(rx, j, k) : f[(j * rx + i + 1) * 3 + k];
          const u = j === 0 ? B(i, -1, k) : f[((j - 1) * rx + i) * 3 + k];
          const d = j === ry - 1 ? B(i, ry, k) : f[((j + 1) * rx + i) * 3 + k];
          const target = (l + r + u + d - lap[id + k]) * 0.25;
          f[id + k] += OMEGA * (target - f[id + k]);
        }
      }
    }
  }
  for (let j = 0; j < ry; j++) for (let i = 0; i < rx; i++) {
    const id = (j * rx + i) * 3, o = ((oy + j) * W + ox + i) * 3;
    for (let k = 0; k < 3; k++) px[o + k] = Math.min(255, Math.max(0, Math.round(f[id + k])));
  }
  return iter;
}

// 竖带
{
  let best = null;
  for (let x0 = 0; x0 + BAND < W; x0++) {
    if (inV(x0) || inV(x0 + BAND - 1)) continue;
    let cost = 0;
    for (let y = 0; y < H; y++) for (let c = 0; c < 3; c++) for (let t = 1; t <= CTX; t++) {
      const d1 = P(x0 + t - 1, y, c) - P(CX - t, y, c);
      const d2 = P(x0 + BAND - t, y, c) - P(CX + BAND + t - 1, y, c);
      cost += d1 * d1 + d2 * d2;
    }
    if (!best || cost < best.cost) best = { x0, cost };
  }
  const rms = Math.sqrt(best.cost / (H * 3 * CTX * 2)) / 255;
  const iter = Math.max(240, Math.round(Math.max(BAND, H) * 0.6));
  const t0 = Date.now();
  poissonClone(CX, 0, BAND, H, best.x0, 0, iter);
  console.log(`竖缝带 x=${CX}..${CX + BAND - 1} ← 补丁取自 x=${best.x0}（边界 RMS 失配 ${(rms * 100).toFixed(2)}%，泊松 ${iter} 轮，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
}
// 横带（此时竖带已是干净内容，横带的上下文/补丁都要求避开它）
{
  let best = null;
  for (let y0 = 0; y0 + BAND < H; y0++) {
    if (inH(y0) || inH(y0 + BAND - 1)) continue;
    let cost = 0;
    for (let x = 0; x < W; x++) {
      if (inV(x)) continue;                                   // 跳过竖带列，避免拿刚填的内容当补丁
      for (let c = 0; c < 3; c++) for (let t = 1; t <= CTX; t++) {
        const d1 = P(x, y0 + t - 1, c) - P(x, CY - t, c);
        const d2 = P(x, y0 + BAND - t, c) - P(x, CY + BAND + t - 1, c);
        cost += d1 * d1 + d2 * d2;
      }
    }
    if (!best || cost < best.cost) best = { y0, cost };
  }
  const rms = Math.sqrt(best.cost / (W * 3 * CTX * 2)) / 255;
  const iter = Math.max(240, Math.round(Math.max(BAND, W) * 0.6));
  const t0 = Date.now();
  poissonClone(0, CY, W, BAND, 0, best.y0, iter);
  console.log(`横缝带 y=${CY}..${CY + BAND - 1} ← 补丁取自 y=${best.y0}（边界 RMS 失配 ${(rms * 100).toFixed(2)}%，泊松 ${iter} 轮，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
}

// ── ⑤ 自检 + 落盘 ────────────────────────────────────────────────────────
const after = seamScore();
console.log(`\n处理后：左右接缝 ${after.h.toFixed(2)}x 内部（${after.edgeC.toFixed(1)} vs ${after.innerC.toFixed(1)}）｜上下 ${after.v.toFixed(2)}x（${after.edgeR.toFixed(1)}）`);
const pass = Math.max(after.h, after.v) < 1.6;
console.log(pass ? '  [OK] 接缝已降到内部噪声量级 —— 可严格平铺' : '  [NG] 仍有可见接缝，可加大 --band 再试');

savePNG(outBase + '.png', W, H, px, 'rgb');
saveRaw(outBase + '.rgb', px);
fs.writeFileSync(outBase + '.json', JSON.stringify({
  size: [W, H], band: BAND, flatten: FLATTEN,
  seamBefore: { h: +before.h.toFixed(3), v: +before.v.toFixed(3) },
  seamAfter: { h: +after.h.toFixed(3), v: +after.v.toFixed(3) },
  pass, method: 'offset-half + patch-match + poisson seamless clone',
}, null, 2));
console.log(`-> ${path.relative(process.cwd(), outBase)}.png / .rgb / .json`);
process.exit(pass ? 0 : 1);
