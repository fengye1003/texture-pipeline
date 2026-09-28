// probe-image.mjs — 生图通道体检：主站 vs 镜像站（延迟 / 可用模型 / 是否真能出图）
// 用法：
//   node scripts/probe-image.mjs          只探活（免费）
//   node scripts/probe-image.mjs --gen    探活 + 各站真出一张最小图（花钱，用于量真实延迟）
// 纪律：绝不打印 key 正文。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', '..', 'relay.local.json'), 'utf8'));
const IMG = cfg.image;
if (!IMG?.apiKey) { console.error('没有 image.apiKey'); process.exit(2); }
const mask = (k) => `${k.slice(0, 6)}…${k.slice(-4)}(len=${k.length})`;

const ENDPOINTS = [['主站', IMG.baseUrl], ['镜像', IMG.mirrorBaseUrl]].filter(([, u]) => u);
const IMG_RE = /(image|dall|flux|imagen|seedream|kolors|banana|imagine)/i;

async function timed(label, url, opts) {
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120000);
    const r = await fetch(url, { ...opts, signal: ac.signal });
    clearTimeout(timer);
    const text = await r.text();
    return { label, status: r.status, ms: Date.now() - t0, text };
  } catch (e) {
    return { label, status: 0, ms: Date.now() - t0, text: `异常: ${e.message}` };
  }
}

console.log(`生图 key: ${mask(IMG.apiKey)}（主站与镜像通用）\n`);
const results = [];

for (const [name, base] of ENDPOINTS) {
  const r = await timed(name, `${base}/models`, { headers: { authorization: `Bearer ${IMG.apiKey}` } });
  let ids = [];
  try { ids = (JSON.parse(r.text).data || []).map((m) => m.id); } catch {}
  const imgModels = ids.filter((id) => IMG_RE.test(id));
  console.log(`[探活] ${name} ${base}`);
  console.log(`   HTTP ${r.status}  ${r.ms}ms  模型 ${ids.length} 个  其中生图相关 ${imgModels.length} 个`);
  if (imgModels.length) console.log(`   ${imgModels.join(', ')}`);
  if (r.status !== 200) console.log(`   警告：${r.text.slice(0, 220)}`);
  results.push({ name, base, status: r.status, ms: r.ms, nModels: ids.length, imgModels });
}

if (process.argv.includes('--gen')) {
  const prompt = 'a flat solid dark grey square, no text, no objects';
  console.log('\n[真出图] 各站各打一张 1024x1024（量真实延迟与通道健康）');
  for (const [name, base] of ENDPOINTS) {
    const r = await timed(name, `${base}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${IMG.apiKey}` },
      body: JSON.stringify({ model: IMG.model, prompt, n: 1, size: '1024x1024', response_format: 'b64_json' }),
    });
    let bytes = 0, err = '';
    try { const j = JSON.parse(r.text); bytes = j.data?.[0]?.b64_json?.length || 0; if (!bytes) err = JSON.stringify(j).slice(0, 220); }
    catch { err = r.text.slice(0, 220); }
    console.log(`   ${name}: HTTP ${r.status}  ${(r.ms / 1000).toFixed(1)}s  ${bytes ? `出图成功（base64 ${(bytes / 1024).toFixed(0)} KB）` : '未出图 -> ' + err}`);
    results.push({ name, base, gen: { status: r.status, ms: r.ms, bytes } });
  }
}

const ok = results.filter((r) => r.status === 200).sort((a, b) => a.ms - b.ms);
console.log(`\n结论：${ok.length ? ok.map((r) => `${r.name} ${r.ms}ms`).join(' / ') + '（快的优先，慢的作降级备选）' : '两个端点都没探通'}`);
