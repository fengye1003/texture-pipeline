// lib/png.mjs —— 共享 PNG 编解码（零依赖，zlib 内置）
//   之前 make-texture.mjs 与 render-material-ball.mjs 各写了一份编/解码 —— 抽出来是**单一真源**。
//   支持：编码 rgb / rgba / gray / gray16；解码 8/16bit、灰度/RGB/RGBA、非隔行（滤波 0~4 全支持）。
import fs from 'node:fs';
import zlib from 'node:zlib';

// ── CRC32 / chunk ────────────────────────────────────────────────────────
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c; }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_T[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii'), crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 编码：mode ∈ 'rgb'(3B) | 'rgba'(4B) | 'gray'(1B) | 'gray16'(2B, 大端) */
export function encodePNG(w, h, pixels, mode = 'rgb') {
  const bitDepth = mode === 'gray16' ? 16 : 8;
  const colorType = mode === 'rgb' ? 2 : mode === 'rgba' ? 6 : 0;
  const bpp = (colorType === 2 ? 3 : colorType === 6 ? 4 : 1) * (bitDepth / 8);
  const stride = w * bpp;
  const raw = Buffer.alloc(h * (1 + stride));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + stride)] = 0;                       // 滤波 0（None）
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (1 + stride) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = bitDepth; ihdr[9] = colorType;           // 10/11/12 默认 0（deflate / 自适应滤波 / 非隔行）
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function savePNG(file, w, h, pixels, mode = 'rgb') {
  fs.writeFileSync(file, encodePNG(w, h, pixels, mode));
  return fs.statSync(file).size;
}

/** 解码 → { w, h, channels, bitDepth, bps, data } */
export function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, bitDepth = 8, colorType = 2, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
      if (interlace !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 colorType ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bps = bitDepth / 8, bpp = channels * bps, stride = w * bpp;
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

export const loadPNG = (file) => decodePNG(fs.readFileSync(file));

/** 把解码结果包装成「双线性 + 环绕」采样器：返回 (u,v) -> [r,g,b]（0..1，不做色彩空间转换） */
export function makeSampler(img) {
  const { w, h, channels, bps, data } = img;
  const at = (x, y, c) => {
    const i = (y * w + x) * channels * bps + c * bps;
    return bps === 2 ? data.readUInt16BE(i) / 65535 : data[i] / 255;
  };
  const c0 = channels >= 3 ? 0 : 0, c1 = channels >= 3 ? 1 : 0, c2 = channels >= 3 ? 2 : 0;
  return (u, v) => {
    const x = (u - Math.floor(u)) * w - 0.5, y = (v - Math.floor(v)) * h - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const X0 = ((x0 % w) + w) % w, X1 = (X0 + 1) % w, Y0 = ((y0 % h) + h) % h, Y1 = (Y0 + 1) % h;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    const g = (X, Y, c) => at(X, Y, c);
    return [
      g(X0, Y0, c0) * w00 + g(X1, Y0, c0) * w10 + g(X0, Y1, c0) * w01 + g(X1, Y1, c0) * w11,
      g(X0, Y0, c1) * w00 + g(X1, Y0, c1) * w10 + g(X0, Y1, c1) * w01 + g(X1, Y1, c1) * w11,
      g(X0, Y0, c2) * w00 + g(X1, Y0, c2) * w10 + g(X0, Y1, c2) * w01 + g(X1, Y1, c2) * w11,
    ];
  };
}

/** 读裸 RGB/RGBA（由 Python 端导出） */
export function loadRaw(file, w, h, channels = 3) {
  const data = fs.readFileSync(file);
  if (data.length !== w * h * channels) throw new Error(`裸数据长度不符：期望 ${w * h * channels}，得到 ${data.length}`);
  return { w, h, channels, bitDepth: 8, bps: 1, data };
}
export const saveRaw = (file, buf) => fs.writeFileSync(file, buf);
