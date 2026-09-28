// make-texture.mjs — 由「测量得到的花纹边网格」程序化生成无缝地砖 PBR 贴图
//   默认：砖面为实测深蓝纯色 #222931
//   --stone：砖面改用外部石材照片（src/stone-plate.rgb，由 prepare-stone.py 清缝+压平后导出）
//   输出：albedo / normal(OpenGL+DirectX) / roughness / ao / height(16bit) + 平铺与光照预览
//   用法：node scripts/make-texture.mjs [--module 256] [--out <dir>] [--stone] [--verify]
// 图案来源：analyze.py + reconstruct.py 的像素级测量（5x5 模数周期，跨缝整块已还原）。
// 无缝性：所有采样跑在「全局周期坐标」上，石材偏移也按砖号固定 ⇒ 单元贴图平铺 == 全局渲染。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (!h) return d; return h.includes('=') ? h.slice(h.indexOf('=') + 1) : (argv[argv.indexOf(h) + 1] ?? d); };
const has = (n) => argv.includes(`--${n}`);

const MOD = Number(argOf('module', 256));
const U = MOD * 5;
const USE_STONE = has('stone');
const SUF = USE_STONE ? '-stone' : '';
const OUT = path.resolve(process.cwd(), argOf('out', path.join(HERE, '..', 'out')));

// ── 图案模型（全部来自源图测量；c/r 索引均 mod 5）──────────────────────────
const VbyR = [
  [1, 1, 0, 1, 1],  // r0
  [1, 1, 1, 1, 0],  // r1
  [1, 0, 1, 1, 1],  // r2
  [1, 1, 1, 0, 1],  // r3
  [0, 1, 1, 1, 1],  // r4
];
const HbyR = [
  [1, 1, 1, 0, 1],  // r0
  [0, 1, 1, 1, 1],  // r1
  [1, 1, 0, 1, 1],  // r2
  [1, 1, 1, 1, 0],  // r3
  [1, 0, 1, 1, 1],  // r4
];
const vertEdge = (cb, r) => VbyR[((r % 5) + 5) % 5][(((cb % 5) + 5) % 5)] === 1;
const horizEdge = (rb, c) => HbyR[((rb % 5) + 5) % 5][(((c % 5) + 5) % 5)] === 1;

// ── 单元内的块合并（含跨接缝 wrap）+ 每块砖的「砖内坐标系」────────────────
const TILE_IDX = (c, r) => (((r % 5) + 5) % 5) * 5 + (((c % 5) + 5) % 5);
const tileOf = new Int8Array(25).fill(-1);
const rawDX = new Int8Array(25), rawDY = new Int8Array(25);
let NTILES = 0;
{
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    if (tileOf[TILE_IDX(c, r)] >= 0) continue;
    const id = NTILES++;
    const stack = [[c, r, 0, 0]];
    tileOf[TILE_IDX(c, r)] = id; rawDX[TILE_IDX(c, r)] = 0; rawDY[TILE_IDX(c, r)] = 0;
    while (stack.length) {
      const [cc, rr, dx, dy] = stack.pop();
      const push = (nc, nr, ndx, ndy) => {
        const i = TILE_IDX(nc, nr);
        if (tileOf[i] < 0) { tileOf[i] = id; rawDX[i] = ndx; rawDY[i] = ndy; stack.push([nc, nr, ndx, ndy]); }
      };
      if (!vertEdge(cc + 1, rr)) push(cc + 1, rr, dx + 1, dy);
      if (!vertEdge(cc, rr)) push(cc - 1, rr, dx - 1, dy);
      if (!horizEdge(rr + 1, cc)) push(cc, rr + 1, dx, dy + 1);
      if (!horizEdge(rr, cc)) push(cc, rr - 1, dx, dy - 1);
    }
  }
}
// 归一化到「砖内坐标」：原点 = 该砖自己的左上角（跨接缝的砖因此得到连续坐标）
const tileW = new Int32Array(NTILES), tileH = new Int32Array(NTILES);
const locDX = new Int8Array(25), locDY = new Int8Array(25);
for (let t = 0; t < NTILES; t++) {
  let minx = 99, maxx = -99, miny = 99, maxy = -99;
  for (let i = 0; i < 25; i++) if (tileOf[i] === t) { minx = Math.min(minx, rawDX[i]); maxx = Math.max(maxx, rawDX[i]); miny = Math.min(miny, rawDY[i]); maxy = Math.max(maxy, rawDY[i]); }
  tileW[t] = maxx - minx + 1; tileH[t] = maxy - miny + 1;
  for (let i = 0; i < 25; i++) if (tileOf[i] === t) { locDX[i] = rawDX[i] - minx; locDY[i] = rawDY[i] - miny; }
}
const sizes = new Array(NTILES).fill(0);
for (let i = 0; i < 25; i++) sizes[tileOf[i]]++;
console.log(`图案模型：5x5 模数单元 / ${NTILES} 块砖（各占格数 ${sizes.join('+')} = ${sizes.reduce((a, b) => a + b, 0)}）`);

// ── 石材板（可选）─────────────────────────────────────────────────────────
let STONE = null, SW = 0, SH = 0, SREL = null, SCALE = 1;
if (USE_STONE) {
  const meta = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'src', 'stone-plate.json'), 'utf8'));
  SW = meta.w; SH = meta.h;
  STONE = fs.readFileSync(path.join(HERE, '..', 'src', 'stone-plate.rgb'));   // RGB
  // 石板的高频浮雕分量（供法线/粗糙度用）：原值 − 半径 5 的盒式模糊
  const lum = new Float32Array(SW * SH);
  for (let i = 0; i < SW * SH; i++) lum[i] = (0.299 * STONE[i * 3] + 0.587 * STONE[i * 3 + 1] + 0.114 * STONE[i * 3 + 2]) / 255;
  const tmp = new Float32Array(SW * SH), blur = new Float32Array(SW * SH);
  const R = 5;
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) { let s = 0, n = 0; for (let k = -R; k <= R; k++) { const xx = Math.min(SW - 1, Math.max(0, x + k)); s += lum[y * SW + xx]; n++; } tmp[y * SW + x] = s / n; }
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) { let s = 0, n = 0; for (let k = -R; k <= R; k++) { const yy = Math.min(SH - 1, Math.max(0, y + k)); s += tmp[yy * SW + x]; n++; } blur[y * SW + x] = s / n; }
  SREL = new Float32Array(SW * SH);
  for (let i = 0; i < SW * SH; i++) SREL[i] = lum[i] - blur[i];
  // 一块「源图砖」= 1 个模数：源图砖距实测 365px → 1 模数（256px 贴图）显示 365px 石材
  SCALE = 365 / MOD;
  console.log(`石材板：${SW}x${SH}，映射尺度 1 模数 = 365 石材像素（纹理像素≈${SCALE.toFixed(3)} 石材像素）`);
}

// 每块砖的石材窗口偏移（按砖号固定 ⇒ 平铺后同一块砖恒定）
// 每块砖还有自己的 90° 倍数旋转：石材本来就是各块随机下料、纹向不一致，同时打破"同一簇白脉反复出现"
const stoneOX = new Float32Array(NTILES), stoneOY = new Float32Array(NTILES), stoneROT = new Int8Array(NTILES);
if (USE_STONE) {
  const rnd1 = (t, s) => ((Math.sin(t * s + 78.233) * 43758.5453) % 1 + 1) % 1;
  for (let t = 0; t < NTILES; t++) {
    stoneROT[t] = Math.floor(rnd1(t, 12.9898) * 4) % 4;
    const Wt = tileW[t] * MOD, Ht = tileH[t] * MOD;
    const winW = (stoneROT[t] % 2 ? Ht : Wt) * SCALE;
    const winH = (stoneROT[t] % 2 ? Wt : Ht) * SCALE;
    stoneOX[t] = 2 + rnd1(t, 39.3468) * Math.max(0, SW - winW - 4);
    stoneOY[t] = 2 + rnd1(t, 91.1700) * Math.max(0, SH - winH - 4);
    if (winW > SW - 4 || winH > SH - 4) console.warn(`  ⚠️ 砖 ${t} 窗口 ${winW.toFixed(0)}x${winH.toFixed(0)} 超出石板 ${SW}x${SH}`);
  }
  console.log('每块砖的石材窗口（旋转 / 偏移）: ' + Array.from({ length: NTILES }, (_, t) => `${t}:${stoneROT[t] * 90}°`).join(' '));
  var tileJit = new Float32Array(NTILES);
  for (let t = 0; t < NTILES; t++) tileJit[t] = (((Math.sin(t * 91.17 + 3.3) * 53758.113) % 1) + 1) % 1 * 0.10 - 0.05;
}

/** 石材双线性采样 → {r,g,b,rel}（01 归一） */
function sampleStone(sx, sy) {
  const x = Math.min(SW - 1.001, Math.max(0, sx)), y = Math.min(SH - 1.001, Math.max(0, sy));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const i00 = y0 * SW + x0, i10 = i00 + 1, i01 = i00 + SW, i11 = i01 + 1;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  const r = (STONE[i00 * 3] * w00 + STONE[i10 * 3] * w10 + STONE[i01 * 3] * w01 + STONE[i11 * 3] * w11) / 255;
  const g = (STONE[i00 * 3 + 1] * w00 + STONE[i10 * 3 + 1] * w10 + STONE[i01 * 3 + 1] * w01 + STONE[i11 * 3 + 1] * w11) / 255;
  const b = (STONE[i00 * 3 + 2] * w00 + STONE[i10 * 3 + 2] * w10 + STONE[i01 * 3 + 2] * w01 + STONE[i11 * 3 + 2] * w11) / 255;
  const rel = SREL[i00] * w00 + SREL[i10] * w10 + SREL[i01] * w01 + SREL[i11] * w11;
  return { r, g, b, rel };
}

// ── 周期噪声 ──────────────────────────────────────────────────────────────
function makeNoise(seed) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const G = 64, grid = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) grid[i] = rnd();
  const sm = (t) => t * t * (3 - 2 * t);
  return (u, v) => {
    const x = (u - Math.floor(u)) * G, y = (v - Math.floor(v)) * G;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = sm(x - x0), fy = sm(y - y0);
    const X0 = ((x0 % G) + G) % G, X1 = (X0 + 1) % G, Y0 = ((y0 % G) + G) % G, Y1 = (Y0 + 1) % G;
    const a = grid[Y0 * G + X0], b = grid[Y0 * G + X1], c = grid[Y1 * G + X0], dd = grid[Y1 * G + X1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + dd * fx) * fy;
  };
}
const nA = makeNoise(1337), nB = makeNoise(90210), nC = makeNoise(424242);

// ── 参数与配色 ────────────────────────────────────────────────────────────
// 缝与配色的可调参数（默认 = 最初按参考花纹实测的值；石材版按实铺参考图另给一组，见 README）
const GROUT_W = Number(argOf('grout-w', 0.047));    // 缝宽（占一个模数的比例）
const BEVEL_W = Number(argOf('bevel-w', 0.055));    // 砖边倒角宽度（占模数比例）
const TILE_GAIN = argOf('tile-gain', '1,1,1').split(',').map(Number);
const GROUT_HEX = argOf('grout-color', '787a7c').replace('#', '');
const hex2rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

const TILE_RGB = [0x22 / 255, 0x29 / 255, 0x31 / 255];   // 无石材时的砖面 #222931
const GROUT_RGB = hex2rgb(GROUT_HEX);
const GROUT_HALF = Math.max(1, Math.round(MOD * GROUT_W / 2));
const BEVEL = Math.max(2, Math.round(MOD * BEVEL_W));
const GROOVE = Number(argOf('groove', 0.30));        // 缝底高度（越小槽越深、打光后缝越黑）
const AO_STRENGTH = Number(argOf('ao', 0.42));       // 缝附近的 AO 强度
const GROUT_FLOOR = GROOVE;
// 色调映射 LUT（由 build-tone-lut.py 生成）：把石材颜色分布映射到参考实铺图
let TONE_LUT = null;
if (has('tone-lut')) { TONE_LUT = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), argOf('tone-lut')), 'utf8')).lut; console.log(`色调 LUT：已载入 ${argOf('tone-lut')}`); }
const lut = (v, c) => (TONE_LUT ? TONE_LUT[c][Math.max(0, Math.min(255, Math.round(v * 255)))] / 255 : v);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
console.log(`参数：缝宽 ${(GROUT_W * 100).toFixed(1)}% 模数（${GROUT_HALF * 2}px）｜倒角 ${BEVEL}px｜槽底 ${GROOVE}｜AO ${AO_STRENGTH}｜砖面增益 ${TILE_GAIN.join('/')}｜缝色 #${GROUT_HEX}`);

const tileShift = new Float32Array(NTILES), tileHue = new Float32Array(NTILES), tileRough = new Float32Array(NTILES);
for (let i = 0; i < NTILES; i++) {
  const h1 = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  tileShift[i] = (h1(i * 3.77) - 0.5) * (USE_STONE ? 0 : 0.085);
  tileHue[i] = (h1(i * 9.13 + 5.2) - 0.5) * (USE_STONE ? 0 : 8);
  tileRough[i] = (h1(i * 5.5) - 0.5) * 0.10;
}

function sample(gx, gy) {
  const u = ((gx % U) + U) % U, v = ((gy % U) + U) % U;
  const c = Math.floor(u / MOD), r = Math.floor(v / MOD);
  const cx = U % MOD === 0 ? c % 5 : c;   // MOD 整除 U 时 c∈0..4
  const ci = TILE_IDX(cx, r);
  const tid = tileOf[ci];
  const lx = u - c * MOD, ly = v - r * MOD;

  let dx = 1e9;
  for (let k = -4; k <= 4; k++) { const cb = c + k; if (k !== 0 && vertEdge(cb, r)) dx = Math.min(dx, Math.abs(u - cb * MOD)); }
  if (vertEdge(c, r)) dx = Math.min(dx, lx);
  let dy = 1e9;
  for (let k = -4; k <= 4; k++) { const rb = r + k; if (k !== 0 && horizEdge(rb, c)) dy = Math.min(dy, Math.abs(v - rb * MOD)); }
  if (horizEdge(r, c)) dy = Math.min(dy, ly);
  const dist = Math.min(dx, dy);

  const cov = 1 - sstep(GROUT_HALF - 1.5, GROUT_HALF + 1.5, dist);
  const nf = nA(u / U, v / U) - 0.5;
  const grain = nB(u * 9 / U, v * 9 / U) - 0.5;
  const gGrain = nC(u * 3 / U, v * 3 / U) - 0.5;

  // 砖面颜色
  let tr, tg, tb, relief = 0, stoneLum = 0.28;
  if (USE_STONE) {
    const Wt = tileW[tid] * MOD, Ht = tileH[tid] * MOD;
    const tlx = locDX[ci] * MOD + lx, tly = locDY[ci] * MOD + ly;   // 砖内像素坐标
    // 按该砖的旋转把「砖内坐标」映射到石材窗口坐标（0/90/180/270°）
    let sx, sy;
    switch (stoneROT[tid]) {
      case 1: sx = Ht - tly; sy = tlx; break;
      case 2: sx = Wt - tlx; sy = Ht - tly; break;
      case 3: sx = tly; sy = Wt - tlx; break;
      default: sx = tlx; sy = tly;
    }
    const st = sampleStone(stoneOX[tid] + sx * SCALE, stoneOY[tid] + sy * SCALE);
    const jit = 1 + tileJit[tid];
    stoneLum = 0.299 * st.r + 0.587 * st.g + 0.114 * st.b;   // 粗糙度按「未调色」的亮度算，免得调暗后粗糙度跟着跑偏
    tr = lut(st.r * jit * TILE_GAIN[0], 0); tg = lut(st.g * jit * TILE_GAIN[1], 1); tb = lut(st.b * jit * TILE_GAIN[2], 2);
    relief = st.rel * 0.055;                                        // 石材自身微浮雕（抛光面，很轻）
  } else {
    const k = 1 + tileShift[tid] + grain * 0.045;
    tr = TILE_RGB[0] * (1 + tileHue[tid] / 300) * k;
    tg = TILE_RGB[1] * k;
    tb = TILE_RGB[2] * (1 - tileHue[tid] / 300) * k;
  }

  const bevelT = sstep(GROUT_HALF, GROUT_HALF + BEVEL, dist);
  let h = GROUT_FLOOR + (1 - GROUT_FLOOR) * bevelT
    + nf * 0.010 * (1 - cov) + grain * 0.006 * (1 - cov) + gGrain * 0.05 * cov
    + relief * (1 - cov);

  const gk = 1 + gGrain * 0.12;
  let R = tr * (1 - cov) + GROUT_RGB[0] * gk * cov;
  let G = tg * (1 - cov) + GROUT_RGB[1] * gk * cov;
  let B = tb * (1 - cov) + GROUT_RGB[2] * gk * cov;
  const edgeAO = 1 - 0.16 * (1 - sstep(GROUT_HALF, GROUT_HALF + BEVEL * 1.6, dist)) * (1 - cov);
  R *= edgeAO; G *= edgeAO; B *= edgeAO;

  // 粗糙度：石材抛光面（比纯色砖更亮更光滑），缝 0.92
  const faceRough = USE_STONE
    ? clamp01(0.17 + clamp01((stoneLum - 0.22) * 1.4) * 0.16 + tileRough[tid] * 0.5 + nf * 0.05)
    : clamp01(0.26 + tileRough[tid] + nf * 0.08 + grain * 0.05);
  const rough = clamp01(faceRough * (1 - cov) + 0.92 * cov);
  const ao = 1 - AO_STRENGTH * (1 - sstep(GROUT_HALF, GROUT_HALF + BEVEL * 2.2, dist));
  return { R: clamp01(R), G: clamp01(G), B: clamp01(B), h, rough, ao };
}

// ── 渲染 / 法线 / PNG ─────────────────────────────────────────────────────
function render(w, h, ox, oy) {
  const albedo = Buffer.alloc(w * h * 3), height = new Float32Array(w * h);
  const rough = Buffer.alloc(w * h), ao = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = sample(ox + x, oy + y), i = y * w + x;
    albedo[i * 3] = Math.round(s.R * 255); albedo[i * 3 + 1] = Math.round(s.G * 255); albedo[i * 3 + 2] = Math.round(s.B * 255);
    height[i] = s.h; rough[i] = Math.round(s.rough * 255); ao[i] = Math.round(s.ao * 255);
  }
  return { albedo, height, rough, ao, w, h };
}
function normalFromHeight(height, w, h, strength) {
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const xm = (x - 1 + w) % w, xp = (x + 1) % w, ym = (y - 1 + h) % h, yp = (y + 1) % h;
    const dzdx = (height[y * w + xp] - height[y * w + xm]) * strength * 0.5;
    const dzdy = (height[yp * w + x] - height[ym * w + x]) * strength * 0.5;
    let nx = -dzdx, ny = -dzdy, nz = 1;
    const L = Math.hypot(nx, ny, nz);
    const i = (y * w + x) * 3;
    out[i] = Math.round(((nx / L) * 0.5 + 0.5) * 255);
    out[i + 1] = Math.round(((ny / L) * 0.5 + 0.5) * 255);
    out[i + 2] = Math.round(((nz / L) * 0.5 + 0.5) * 255);
  }
  return out;
}
function crc32(buf) {
  let c, table = crc32.t;
  if (!table) { table = crc32.t = new Int32Array(256); for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; } }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii'), crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
function encodePNG(w, h, pixels, mode) {
  const bitDepth = mode === 'gray16' ? 16 : 8;
  const colorType = mode === 'rgb' ? 2 : mode === 'rgba' ? 6 : 0;
  const bpp = (colorType === 2 ? 3 : colorType === 6 ? 4 : 1) * (bitDepth / 8);
  const stride = w * bpp, raw = Buffer.alloc(h * (1 + stride));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + stride)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (1 + stride) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = bitDepth; ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const writePNG = (file, w, h, px, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(w, h, px, mode));
  console.log(`  ✅ ${path.basename(file)}  ${w}x${h}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
};

// ── 主流程 ────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
console.log(`\n生成中（${USE_STONE ? '石材砖面' : '纯色砖面'}）：单元 ${U}x${U}px（模数 ${MOD}px / 缝宽 ${GROUT_HALF * 2}px / 倒角 ${BEVEL}px）…`);
const t0 = Date.now();
// 法线强度 = 高度范围(mm) ÷ 单像素世界尺寸(mm)。
// 例：模数 256px 对应 300mm → 单像素 1.17mm；高度范围给 5mm（缝深 + 石材起伏）→ 强度 ≈ 4.3。
// ⚠️ 曾错取 MOD*0.9（=230）→ 缝口法线陡到 86°（几乎水平），渲染时缝会炸成白边。
const BUMP = Number(argOf('bump', 4.5));
const main = render(U, U, 0, 0);
const nrm = normalFromHeight(main.height, U, U, BUMP);
const nrmDX = Buffer.from(nrm);
for (let i = 1; i < nrmDX.length; i += 3) nrmDX[i] = 255 - nrmDX[i];
const h16 = Buffer.alloc(U * U * 2);
for (let i = 0; i < U * U; i++) h16.writeUInt16BE(Math.round(clamp01(main.height[i]) * 65535), i * 2);

console.log(`\n[输出] ${path.relative(process.cwd(), OUT)}`);
writePNG(path.join(OUT, `tile-albedo${SUF}.png`), U, U, main.albedo, 'rgb');
writePNG(path.join(OUT, `tile-normal-opengl${SUF}.png`), U, U, nrm, 'rgb');
writePNG(path.join(OUT, `tile-normal-directx${SUF}.png`), U, U, nrmDX, 'rgb');
writePNG(path.join(OUT, `tile-roughness${SUF}.png`), U, U, main.rough, 'gray');
writePNG(path.join(OUT, `tile-ao${SUF}.png`), U, U, main.ao, 'gray');
writePNG(path.join(OUT, `tile-height-16bit${SUF}.png`), U, U, h16, 'gray16');

// ── 完整 PBR：金属度 + 三套业界打包 ──────────────────────────────────────
// 石材/陶瓷是电介质：金属度恒为 0（物理正确，不是占位）；F0 ≈ 0.04（IOR 1.5）
const METALLIC = argOf('metallic', '0');   // 允许微调（默认 0）
const metallicVal = Math.round(Math.max(0, Math.min(1, Number(METALLIC))) * 255);
const metal = Buffer.alloc(U * U, metallicVal);
writePNG(path.join(OUT, `tile-metallic${SUF}.png`), U, U, metal, 'gray');

// ① ORM（R=AO, G=Roughness, B=Metallic）—— Unreal 直接吃；glTF 也吃（occlusionTexture 读 R、metallicRoughnessTexture 读 G/B，
//    见 glTF 2.0 规范的 ORM 打包惯例，Materialize / ArmorLab 等开源工作流同此）
const orm = Buffer.alloc(U * U * 3);
for (let i = 0; i < U * U; i++) {
  orm[i * 3] = main.ao[i]; orm[i * 3 + 1] = main.rough[i]; orm[i * 3 + 2] = metallicVal;
}
writePNG(path.join(OUT, `tile-orm${SUF}.png`), U, U, orm, 'rgb');

// ② glTF metallicRoughness（G=Roughness, B=Metallic；R 留 AO 以便同图当 occlusion 用）
writePNG(path.join(OUT, `tile-metallicRoughness${SUF}.png`), U, U, Buffer.from(orm), 'rgb');

// ③ Unity HDRP/Lit Mask Map（R=Metallic, G=AO, B=Detail Mask, A=Smoothness）
const mask = Buffer.alloc(U * U * 4);
for (let i = 0; i < U * U; i++) {
  mask[i * 4] = metallicVal; mask[i * 4 + 1] = main.ao[i]; mask[i * 4 + 2] = 0; mask[i * 4 + 3] = 255 - main.rough[i];
}
writePNG(path.join(OUT, `tile-unity-mask${SUF}.png`), U, U, mask, 'rgba');
console.log(`   （金属度 = ${(metallicVal / 255).toFixed(2)}（石材=电介质，物理上就是 0）；三套打包：ORM / metallicRoughness / Unity Mask）`);

{
  const S = 3, DS = Math.round(U / 2), tw = DS * S;
  const prev = Buffer.alloc(tw * tw * 3), lit = Buffer.alloc(tw * tw * 3);
  const L1 = [0.5, -0.55, 0.66], L2 = [-0.6, 0.45, 0.66];
  for (let y = 0; y < tw; y++) for (let x = 0; x < tw; x++) {
    const sx = Math.round(x / DS * U) % U, sy = Math.round(y / DS * U) % U;
    const si = (sy * U + sx) * 3, di = (y * tw + x) * 3;
    prev[di] = main.albedo[si]; prev[di + 1] = main.albedo[si + 1]; prev[di + 2] = main.albedo[si + 2];
    const nx = nrm[si] / 255 * 2 - 1, ny = nrm[si + 1] / 255 * 2 - 1, nz = nrm[si + 2] / 255 * 2 - 1;
    const lam = Math.max(0, nx * L1[0] + ny * L1[1] + nz * L1[2]) + 0.5 * Math.max(0, nx * L2[0] + ny * L2[1] + nz * L2[2]);
    const k = (0.42 + 0.9 * lam) * (main.ao[sy * U + sx] / 255);
    lit[di] = Math.min(255, main.albedo[si] * k); lit[di + 1] = Math.min(255, main.albedo[si + 1] * k); lit[di + 2] = Math.min(255, main.albedo[si + 2] * k);
  }
  writePNG(path.join(OUT, `preview-albedo-3x3${SUF}.png`), tw, tw, prev, 'rgb');
  writePNG(path.join(OUT, `preview-lit-3x3${SUF}.png`), tw, tw, lit, 'rgb');
}

if (has('verify')) {
  console.log('\n[无缝自检] 随机采样 30 万点，比较 sample(x,y) 与 sample(x+U, y+U)…');
  let maxd = 0, bad = 0, seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 300000; i++) {
    const x = Math.floor(rnd() * U * 3), y = Math.floor(rnd() * U * 3);
    const a = sample(x, y), b = sample(x + U, y + U);
    const d = Math.max(Math.abs(a.R - b.R), Math.abs(a.G - b.G), Math.abs(a.B - b.B), Math.abs(a.h - b.h));
    if (d > maxd) maxd = d;
    if (d > 1e-9) bad++;
  }
  console.log(`  平移一个单元后最大差异 ${maxd.toExponential(2)}（不一致点数 ${bad}/300000）→ ${bad === 0 ? '✅ 严格周期，平铺无缝' : '⚠️ 存在非周期成分'}`);
}
console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

