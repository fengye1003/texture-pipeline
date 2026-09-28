// make-material.mjs —— 通用「平铺底色 → 完整 PBR 贴图集」
//   输入：一张**已经无缝**的底色图（石板/水磨石/木纹…这类"平面材质"，没有砖缝几何）
//   输出：albedo / normal(OpenGL+DirectX) / roughness / metallic / ao / height16
//         + ORM / metallicRoughness / unity-mask 三套打包 + 3x3 平铺与打光预览
//   与 make-texture.mjs 的分工：那个管「规则几何（砖缝/倒角）」，这个管「平面材质（靠图像本身推贴图）」。
//   用法：
//     node make-material.mjs --in-png out/terrazzo-seamless.png --suf -terrazzo \
//          [--relief 1.0] [--bump 1.8] [--rough-base 0.30] [--rough-var 0.12] [--out out]
//   依赖：lib/png.mjs（共享编解码）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPNG, loadRaw, savePNG } from './lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (!h) return d; return h.includes('=') ? h.slice(h.indexOf('=') + 1) : (argv[argv.indexOf(h) + 1] ?? d); };

const SUF = arg('suf', '');
const OUT = path.resolve(process.cwd(), arg('out', path.join(HERE, '..', 'out')));
const RELIEF = Number(arg('relief', 1.0));        // 高程来自图像高频的强度
const BUMP = Number(arg('bump', 1.8));            // 法线强度 = 高度范围(mm) ÷ 单像素世界尺寸(mm)
const ROUGH_BASE = Number(arg('rough-base', 0.30));
const ROUGH_VAR = Number(arg('rough-var', 0.12));
const NAME = arg('name', 'material');

// ── 读入（png 或 raw）────────────────────────────────────────────────────
let img;
if (arg('in-png')) img = loadPNG(path.resolve(process.cwd(), arg('in-png')));
else if (arg('in')) img = loadRaw(path.resolve(process.cwd(), arg('in')), Number(arg('w')), Number(arg('h')), 3);
else { console.error('需要 --in-png <无缝图.png> 或 --in <raw.rgb> --w W --h H'); process.exit(2); }
const W = img.w, H = img.h;
const src = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) {
  const ch = img.channels >= 3 ? c : 0;
  src[i * 3 + c] = img.bps === 2 ? (img.data.readUInt16BE((i * img.channels + ch) * 2) >> 8) : img.data[i * img.channels + ch];
}
console.log(`输入 ${W}x${H}（${NAME}）；参数 relief ${RELIEF} / bump ${BUMP} / rough ${ROUGH_BASE}±${ROUGH_VAR}`);

// ── 亮度 + 环绕盒式模糊（用于高频与低频分解）────────────────────────────
const lum = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) lum[i] = (0.299 * src[i * 3] + 0.587 * src[i * 3 + 1] + 0.114 * src[i * 3 + 2]) / 255;
function boxBlur(arr, r) {                       // 环绕（贴图必须周期，否则模糊会在边缘出假边）
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  const n = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += arr[y * W + ((k % W) + W) % W];
    for (let x = 0; x < W; x++) { tmp[y * W + x] = s / n; s += arr[y * W + ((x + r + 1) % W + W) % W] - arr[y * W + ((x - r) % W + W) % W]; }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[(((k % H) + H) % H) * W + x];
    for (let y = 0; y < H; y++) { out[y * W + x] = s / n; s += tmp[(((y + r + 1) % H + H) % H) * W + x] - tmp[(((y - r) % H + H) % H) * W + x]; }
  }
  return out;
}
const fine = boxBlur(lum, 2);        // 细节尺度
const mid = boxBlur(lum, 16);        // 骨料尺度
console.log('已分解 细节 / 骨料 两个尺度');

// ── 高度场：细节高频 + 「骨料凸出」低频项 ────────────────────────────────
// 物理直觉：抛光水磨石整体很平，但硬骨料比基体耐磨 ⇒ 骨料略凸（这里用"暗色骨料=凸"的经验映射）
const height = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) {
  const hp = lum[i] - fine[i];                  // 细节（微浮雕 / 麻点）
  const agg = 0.5 - mid[i];                     // 骨料项（暗→凸）
  height[i] = 0.5 + (hp * 2.2 + agg * 0.55) * RELIEF;
}
// 归一化到 0..1（保守：用分位裁剪，避免个别极值把整体压扁）
{
  const v = Float32Array.from(height).sort();
  const lo = v[Math.floor(v.length * 0.005)], hi = v[Math.floor(v.length * 0.995)];
  for (let i = 0; i < W * H; i++) height[i] = Math.min(1, Math.max(0, (height[i] - lo) / Math.max(1e-6, hi - lo)));
}

// ── 法线（中心差分 + 环绕）──────────────────────────────────────────────
function normalFromHeight(h, strength) {
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const xm = (x - 1 + W) % W, xp = (x + 1) % W, ym = (y - 1 + H) % H, yp = (y + 1) % H;
    const dzdx = (h[y * W + xp] - h[y * W + xm]) * strength * 0.5;
    const dzdy = (h[yp * W + x] - h[ym * W + x]) * strength * 0.5;
    let nx = -dzdx, ny = -dzdy, nz = 1;
    const L = Math.hypot(nx, ny, nz), i = (y * W + x) * 3;
    out[i] = Math.round(((nx / L) * 0.5 + 0.5) * 255);
    out[i + 1] = Math.round(((ny / L) * 0.5 + 0.5) * 255);
    out[i + 2] = Math.round(((nz / L) * 0.5 + 0.5) * 255);
  }
  return out;
}
const nrm = normalFromHeight(height, BUMP);
const nrmDX = Buffer.from(nrm);
for (let i = 1; i < nrmDX.length; i += 3) nrmDX[i] = 255 - nrmDX[i];

// ── 粗糙度 & AO ─────────────────────────────────────────────────────────
// 亮基体（水泥/树脂基）稍哑、暗骨料（抛光石子）稍亮；AO 来自"凹处"（细节高频的负半部分）
const rough = Buffer.alloc(W * H), ao = Buffer.alloc(W * H);
for (let i = 0; i < W * H; i++) {
  const r = ROUGH_BASE + (mid[i] - 0.5) * ROUGH_VAR * 2 + (lum[i] - fine[i]) * 0.10;
  rough[i] = Math.round(Math.min(255, Math.max(0, r * 255)));
  const cav = Math.max(0, fine[i] - lum[i]) * 2.2;             // 凹处
  ao[i] = Math.round(Math.min(255, Math.max(0, (1 - cav * 0.35) * 255)));
}
const metallic = Buffer.alloc(W * H, 0);                       // 水磨石=电介质，物理为 0

// ── 输出 ────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
const w = (file, px, mode) => { savePNG(path.join(OUT, file), W, H, px, mode); console.log(`  OK ${file}  ${W}x${H}  ${(fs.statSync(path.join(OUT, file)).size / 1024).toFixed(0)} KB`); };
// ★ 预览是 tw×tw 的，不能用 W×H 落盘（之前写错过：1440² 缓冲区按 1070² 写 → 行错位、花纹全糊）
const wAt = (file, ww, hh, px, mode) => { savePNG(path.join(OUT, file), ww, hh, px, mode); console.log(`  OK ${file}  ${ww}x${hh}  ${(fs.statSync(path.join(OUT, file)).size / 1024).toFixed(0)} KB`); };
console.log(`\n[输出] ${path.relative(process.cwd(), OUT)}`);
w(`tile-albedo${SUF}.png`, src, 'rgb');
w(`tile-normal-opengl${SUF}.png`, nrm, 'rgb');
w(`tile-normal-directx${SUF}.png`, nrmDX, 'rgb');
w(`tile-roughness${SUF}.png`, rough, 'gray');
w(`tile-ao${SUF}.png`, ao, 'gray');
w(`tile-metallic${SUF}.png`, metallic, 'gray');
const h16 = Buffer.alloc(W * H * 2);
for (let i = 0; i < W * H; i++) h16.writeUInt16BE(Math.round(height[i] * 65535), i * 2);
w(`tile-height-16bit${SUF}.png`, h16, 'gray16');

const orm = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) { orm[i * 3] = ao[i]; orm[i * 3 + 1] = rough[i]; orm[i * 3 + 2] = 0; }
w(`tile-orm${SUF}.png`, orm, 'rgb');
w(`tile-metallicRoughness${SUF}.png`, Buffer.from(orm), 'rgb');
const mask = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) { mask[i * 4] = 0; mask[i * 4 + 1] = ao[i]; mask[i * 4 + 2] = 0; mask[i * 4 + 3] = 255 - rough[i]; }
w(`tile-unity-mask${SUF}.png`, mask, 'rgba');

// ── 预览：3x3 平铺（看无缝）+ 打光 ───────────────────────────────────────
{
  const S = 3, DS = Math.min(480, W), tw = DS * S;
  const prev = Buffer.alloc(tw * tw * 3), lit = Buffer.alloc(tw * tw * 3);
  const L1 = [0.5, -0.55, 0.66], L2 = [-0.6, 0.45, 0.66];
  for (let y = 0; y < tw; y++) for (let x = 0; x < tw; x++) {
    const sx = Math.round(x / DS * W) % W, sy = Math.round(y / DS * H) % H;
    const si = (sy * W + sx) * 3, di = (y * tw + x) * 3;
    prev[di] = src[si]; prev[di + 1] = src[si + 1]; prev[di + 2] = src[si + 2];
    const nx = nrm[si] / 255 * 2 - 1, ny = nrm[si + 1] / 255 * 2 - 1, nz = nrm[si + 2] / 255 * 2 - 1;
    const lam = Math.max(0, nx * L1[0] + ny * L1[1] + nz * L1[2]) + 0.5 * Math.max(0, nx * L2[0] + ny * L2[1] + nz * L2[2]);
    const k = (0.55 + 0.75 * lam) * (ao[sy * W + sx] / 255);
    lit[di] = Math.min(255, src[si] * k); lit[di + 1] = Math.min(255, src[si + 1] * k); lit[di + 2] = Math.min(255, src[si + 2] * k);
  }
  wAt(`preview-albedo-3x3${SUF}.png`, tw, tw, prev, 'rgb');
  wAt(`preview-lit-3x3${SUF}.png`, tw, tw, lit, 'rgb');}
fs.writeFileSync(path.join(OUT, `${NAME}${SUF}.json`), JSON.stringify({ size: [W, H], relief: RELIEF, bump: BUMP, roughBase: ROUGH_BASE, roughVar: ROUGH_VAR, metallic: 0 }, null, 2));
console.log('完成');
