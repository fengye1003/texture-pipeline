// render-material-ball.mjs — 用生成好的 PBR 贴图软件渲染「材质球」与「实景地面」预览
//   零依赖：自带最小 PNG 解码器（zlib 解压 + 5 种滤波反演）+ Cook-Torrance(GGX) 着色
//   用法：node scripts/render-material-ball.mjs [--suf -stone] [--size 900] [--ss 2] [--out <dir>]
//   输出：preview-material-ball<suf>.png（材质球）、preview-floor-perspective<suf>.png（透视地面）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (n, d) => { const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (!h) return d; return h.includes('=') ? h.slice(h.indexOf('=') + 1) : (argv[argv.indexOf(h) + 1] ?? d); };
const SUF = argOf('suf', '-stone');
const SIZE = Number(argOf('size', 900));
const SS = Number(argOf('ss', 2));
const OUT = path.resolve(process.cwd(), argOf('out', path.join(HERE, '..', 'out')));
const IN = OUT;

// ── 最小 PNG 解码器（8/16bit，灰度/RGB/RGBA，非隔行）──────────────────────
function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 8, colorType = 2;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; if (data[12] !== 0) throw new Error('不支持隔行 PNG'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 colorType ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bps = bitDepth / 8;
  const bpp = channels * bps;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (1 + stride)];
    const line = raw.subarray(y * (1 + stride) + 1, y * (1 + stride) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, channels, bitDepth, bps, data: out };
}
const F = (v) => v / 255;
/** 解码 → 双线性 + 环绕采样器，返回 [r,g,b]（0..1，原样，不做色彩空间转换） */
function loader(name) {
  const d = decodePNG(fs.readFileSync(path.join(IN, name)));
  const { w, h, channels, bps, data } = d;
  const at = (x, y, c) => {
    const i = (y * w + x) * channels * bps + c * bps;
    return bps === 2 ? data.readUInt16BE(i) / 65535 : data[i] / 255;
  };
  return (u, v) => {
    let x = (u - Math.floor(u)) * w - 0.5, y = (v - Math.floor(v)) * h - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const X0 = ((x0 % w) + w) % w, X1 = (X0 + 1) % w, Y0 = ((y0 % h) + h) % h, Y1 = (Y0 + 1) % h;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    const g = (X, Y, c) => at(X, Y, c);
    const c0 = channels >= 3 ? 0 : 0, c1 = channels >= 3 ? 1 : 0, c2 = channels >= 3 ? 2 : 0;
    return [
      g(X0, Y0, c0) * w00 + g(X1, Y0, c0) * w10 + g(X0, Y1, c0) * w01 + g(X1, Y1, c0) * w11,
      g(X0, Y0, c1) * w00 + g(X1, Y0, c1) * w10 + g(X0, Y1, c1) * w01 + g(X1, Y1, c1) * w11,
      g(X0, Y0, c2) * w00 + g(X1, Y0, c2) * w10 + g(X0, Y1, c2) * w01 + g(X1, Y1, c2) * w11,
    ];
  };
}

const albedoTex = loader(`tile-albedo${SUF}.png`);
const normalTex = loader(`tile-normal-opengl${SUF}.png`);
const roughTex = loader(`tile-roughness${SUF}.png`);
const aoTex = loader(`tile-ao${SUF}.png`);
const metalTex = loader(`tile-metallic${SUF}.png`);
console.log(`已载入 5 张贴图（albedo / normal / roughness / ao / metallic）`);

// ── 色彩空间与 PBR 数学 ──────────────────────────────────────────────────
const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin2srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const V3 = (x, y, z) => [x, y, z];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mixv = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const cmul = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];   // 逐通道相乘（mul 只做标量乘）

// 环境：上方冷调 studio 顶光 + 下方暖调地面反弹（近似 IBL，够用且稳定）
function env(dir) {
  const t = dir[1] * 0.5 + 0.5;
  const sky = [1.30, 1.42, 1.60], ground = [0.16, 0.13, 0.11];
  return mixv(ground, sky, Math.pow(t, 0.9));
}
// 三点光：主光（右上偏后，暖白）/ 补光（左，冷）/ 轮廓光（后下方，冷）
const LIGHTS = [
  { dir: norm([-0.55, 0.62, 0.56]), color: [1.00, 0.96, 0.90], power: 3.6 },
  { dir: norm([0.72, 0.30, 0.62]), color: [0.72, 0.80, 1.00], power: 1.1 },
  { dir: norm([0.10, -0.35, -0.93]), color: [0.85, 0.90, 1.00], power: 1.5 },
];

// 三平面投影：把平铺贴图投到球面上时不做球面 UV（否则两极花纹汇聚成"沙滩球"）
// 权重 |N|^k 归一化，逐通道混合三个平面
function triplanar(P, scale, sampler) {
  const w = [Math.abs(P[0]) ** 6, Math.abs(P[1]) ** 6, Math.abs(P[2]) ** 6];
  const s = w[0] + w[1] + w[2] || 1;
  const uvY = [P[2] * scale, P[1] * scale];   // 朝 ±X 看：用 (z,y)
  const uvZ = [P[0] * scale, P[1] * scale];   // 朝 ±Y 看：用 (x,z)
  const uvX = [P[0] * scale, P[2] * scale];   // 朝 ±Z 看：用 (x,y)
  const a = sampler(uvY[0], uvY[1]), b = sampler(uvZ[0], uvZ[1]), c = sampler(uvX[0], uvX[1]);
  return [
    (a[0] * w[0] + b[0] * w[1] + c[0] * w[2]) / s,
    (a[1] * w[0] + b[1] * w[1] + c[1] * w[2]) / s,
    (a[2] * w[0] + b[2] * w[1] + c[2] * w[2]) / s,
  ];
}

/** 单点着色：N 世界法线、V 指向相机、uv 纹理坐标（或给 P + triScale 走三平面投影） */
let DBG = argv.includes('--debug') ? 2 : 0;
function shade(N, V, uv, P, triScale) {
  const get = (sampler) => (P && triScale ? triplanar(P, triScale, sampler) : sampler(uv[0], uv[1]));
  const alb = get(albedoTex).map(srgb2lin);
  const nrm = get(normalTex);
  const rough = Math.min(1, Math.max(0.045, get(roughTex)[0]));
  const ao = get(aoTex)[0];
  const metal = get(metalTex)[0];

  // 切线空间法线 → 世界法线
  let T = cross([0, 1, 0], N);
  if (Math.hypot(T[0], T[1], T[2]) < 1e-5) T = [1, 0, 0];
  T = norm(T);
  const B = norm(cross(N, T));
  const nT = [nrm[0] * 2 - 1, nrm[1] * 2 - 1, nrm[2] * 2 - 1];
  N = norm(add(add(mul(T, nT[0]), mul(B, nT[1])), mul(N, nT[2])));

  const F0 = mixv([0.04, 0.04, 0.04], alb, metal);
  const a = rough * rough;
  let color = [0, 0, 0];

  for (const L of LIGHTS) {
    const Ld = L.dir;
    const NdotL = Math.max(0, dot(N, Ld));
    if (NdotL <= 0) continue;
    const H = norm(add(V, Ld));
    const NdotV = Math.max(1e-4, dot(N, V));
    const NdotH = Math.max(0, dot(N, H));
    const VdotH = Math.max(0, dot(V, H));
    // GGX 法线分布
    const d = NdotH * NdotH * (a * a - 1) + 1;
    const D = a * a / (Math.PI * d * d);
    // Smith 几何项（Schlick-GGX，k = a/2 直接光）
    const k = a / 2;
    const G = (NdotV / (NdotV * (1 - k) + k)) * (NdotL / (NdotL * (1 - k) + k));
    // Schlick 菲涅尔
    const Fc = Math.pow(1 - VdotH, 5);
    const Fres = add(F0, mul(add([1, 1, 1], mul(F0, -1)), Fc));
    const spec = mul(Fres, D * G / (4 * NdotV * NdotL + 1e-6));
    const kd = mul(add([1, 1, 1], mul(Fres, -1)), 1 - metal);
    const diff = mul(alb, (1 - metal) * (1 / Math.PI));
    const contrib = mul(L.color, NdotL * L.power);
    color = add(color, [contrib[0] * (kd[0] * diff[0] + spec[0]), contrib[1] * (kd[1] * diff[1] + spec[1]), contrib[2] * (kd[2] * diff[2] + spec[2])]);
  }

  // 环境项：漫反射取法线方向、镜面取反射方向（粗糙度越高越模糊 → 用 lerp 近似）
  const amb = env(N);
  const R = add(mul(N, 2 * dot(N, V)), mul(V, -1));
  const specEnv = mixv(env(N), env(R), 0.6);
  const kd = mul(add([1, 1, 1], mul(F0, -1)), 1 - metal);
  const diffAmb = cmul(mul(alb, 1 - metal), cmul(amb, kd));
  const Frough = mixv(F0, [1, 1, 1], Math.pow(1 - Math.max(dot(N, V), 0), 5));
  const specAmb = [specEnv[0] * Frough[0], specEnv[1] * Frough[1], specEnv[2] * Frough[2]];
  color = add(color, [diffAmb[0] * ao * 0.5, diffAmb[1] * ao * 0.5, diffAmb[2] * ao * 0.5]);
  color = add(color, mul(specAmb, ao * (1 - rough * 0.75) * 0.55));
  if (DBG > 0) {
    DBG--;
    console.log(`  [dbg] uv=${uv.map((t) => t.toFixed(3))} alb=${alb.map((t) => t.toFixed(4))} rough=${rough.toFixed(3)} ao=${ao.toFixed(3)} metal=${metal}`);
    console.log(`        N=${N.map((t) => t.toFixed(3))} V=${V.map((t) => t.toFixed(3))} F0=${F0.map((t) => t.toFixed(3))} color=${color.map((t) => t.toFixed(4))}`);
    console.log(`        NaN? alb=${alb.some(Number.isNaN)} N=${N.some(Number.isNaN)} F0=${F0.some(Number.isNaN)} T=${T.some(Number.isNaN)} B=${B.some(Number.isNaN)}`);
    console.log(`        低层: rough=${rough} amb=${amb.map((t) => t.toFixed(3))} R=${R.map((t) => t.toFixed(3))} specEnv=${specEnv.map((t) => t.toFixed(3))}`);
    console.log(`        Frough=${Frough.map((t) => t.toFixed(3))} diffAmb=${diffAmb.map((t) => t.toFixed(4))} specAmb=${specAmb.map((t) => t.toFixed(4))}`);
  }
  return color;
}

// 色调映射（ACES 近似）+ 曝光
function tonemap(c, exposure) {
  const x = c.map((v) => Math.max(0, v * exposure));
  return x.map((v) => {
    const a = 2.51, b = 0.03, cc = 2.43, d = 0.59, e = 0.14;
    return lin2srgb(Math.min(1, Math.max(0, (v * (a * v + b)) / (v * (cc * v + d) + e))));
  });
}

// ── 极简 PNG 编码 ────────────────────────────────────────────────────────
function crc32(buf) {
  let c, t = crc32.t;
  if (!t) { t = crc32.t = new Int32Array(256); for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ t[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function writePNG(file, w, h, rgb) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (1 + w * 3) + 1);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const tb = Buffer.from(type, 'ascii'), crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
    return Buffer.concat([len, tb, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
  console.log(`  ✅ ${path.basename(file)}  ${w}x${h}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}

// ── ① 材质球 ─────────────────────────────────────────────────────────────
{
  const t0 = Date.now();
  const W = SIZE, H = SIZE;
  const img = Buffer.alloc(W * H * 3);
  const camZ = 5.2, tanF = Math.tan(34 * Math.PI / 360);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const nx = ((px + (sx + 0.5) / SS) / W) * 2 - 1;
        const ny = 1 - ((py + (sy + 0.5) / SS) / H) * 2;
        const D = norm([nx * tanF, ny * tanF, -1]);
        const O = [0, 0, camZ];
        const b = dot(O, D), c = dot(O, O) - 1;
        const disc = b * b - c;
        if (disc < 0) {
          // 柔和渐变背景（上亮下暗的摄影棚）
          const t = (ny + 1) / 2;
          acc = add(acc, mixv([0.008, 0.008, 0.011], [0.075, 0.079, 0.090], Math.pow(t, 1.3)));
          continue;
        }
        const t = -b - Math.sqrt(disc);
        const P = add(O, mul(D, t));
        const N = norm(P);
        const V = mul(D, -1);
        // 球面 UV，但把「极点」放到 ±X（左右剪影）⇒ 可见面平滑，收敛处藏在轮廓里
        const rep = Number(argOf('uv-repeat', 1.6));
        const u = 0.5 + Math.atan2(P[1], P[2]) / (2 * Math.PI);
        const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, P[0]))) / Math.PI;
        let col = argv.includes('--tri')
          ? shade(N, V, [0, 0], P, Number(argOf('tri', 1.15)))
          : shade(N, V, [u * rep, v * rep]);
        // 球体边缘的接触阴影暗示（右下角柔和压暗）
        const edge = Math.max(0, -(P[0] * 0.5 + P[1] * 0.75 + P[2] * 0.2));
        col = mul(col, 1 - 0.25 * Math.pow(edge, 2.5));
        acc = add(acc, col);
      }
      const c = tonemap(mul(acc, 1 / (SS * SS)), 1.15);
      const i = (py * W + px) * 3;
      img[i] = Math.round(c[0] * 255); img[i + 1] = Math.round(c[1] * 255); img[i + 2] = Math.round(c[2] * 255);
    }
  }
  writePNG(path.join(OUT, `preview-material-ball${SUF}.png`), W, H, img);
  console.log(`  材质球用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ── ② 透视地面（模拟实景铺装）────────────────────────────────────────────
{
  const t0 = Date.now();
  const W = 1280, H = 720;
  const img = Buffer.alloc(W * H * 3);
  const camY = 1.45, camZ = 3.4, pitch = -32 * Math.PI / 180, tanF = Math.tan(48 * Math.PI / 360);
  const TILE_M = Number(argOf('tile-m', 1.5));       // 一张贴图覆盖的真实尺寸（米）
  const cy = Math.cos(pitch), sy2 = Math.sin(pitch);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let acc = [0, 0, 0];
      for (let s = 0; s < SS; s++) {
        const jx = (s % SS + 0.5) / SS, jy = (Math.floor(s / SS) + 0.5) / SS;
        const nx = ((px + jx) / W) * 2 - 1, ny = 1 - ((py + jy) / H) * 2;
        // 相机空间方向 → 世界（绕 X 轴俯仰）
        const dx = nx * tanF * (W / H), dz = -1, dy = ny * tanF;
        const wx = dx, wy = dy * cy - dz * sy2, wz = dy * sy2 + dz * cy;
        const D = norm([wx, wy, wz]);
        const O = [0, camY, camZ];
        if (D[1] >= -1e-4) { acc = add(acc, [0.020, 0.021, 0.026]); continue; }
        const t = -O[1] / D[1];
        const P = add(O, mul(D, t));
        const u = P[0] / TILE_M, v = -P[2] / TILE_M;
        let col = shade([0, 1, 0], mul(D, -1), [u, v]);
        // 远处雾化，避免高频闪烁
        const fog = Math.min(1, Math.max(0, (t - 4) / 12));
        col = mixv(col, [0.030, 0.032, 0.040], fog * 0.85);
        acc = add(acc, col);
      }
      const c = tonemap(mul(acc, 1 / SS), 1.25);
      const i = (py * W + px) * 3;
      img[i] = Math.round(c[0] * 255); img[i + 1] = Math.round(c[1] * 255); img[i + 2] = Math.round(c[2] * 255);
    }
  }
  writePNG(path.join(OUT, `preview-floor-perspective${SUF}.png`), W, H, img);
  console.log(`  地面用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

