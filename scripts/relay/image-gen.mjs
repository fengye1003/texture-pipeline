// image-gen.mjs — 用中转站（AICLI / New API）的 OpenAI 兼容生图接口出图
//   ★ 主站 + 镜像站自动降级：主站失败/超时/5xx/429 => 自动换镜像重试（用户 2026-09-28 指定）
// 用法：
//   node scripts/image-gen.mjs --prompt-file p.txt --model gpt-image-2.5 --size 1024x1024 --n 1
// 可选：
//   --key=image|codex|claude   用哪把令牌（默认 image）
//   --model=<id>               默认取 relay.json 的 image.model
//   --size=WxH                 默认 1024x1024
//   --quality=low|medium|high  默认 high（不被支持时会自动去掉该参数重试）
//   --n=1                      张数
//   --prompt="..." / --prompt-file=<路径>
//   --prefer=mirror|primary    默认 primary（主站优先，镜像兜底）
//   --timeout=180              单次请求秒数（超时即换下一个端点）
//   --out=<目录>  --dry
// 纪律：绝不打印 key；换端点时打印原因。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.resolve(HERE, '..', '..', 'relay.local.json');
const cfg = JSON.parse(fs.readFileSync(RELAY, 'utf8'));

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  return argv[argv.indexOf(hit) + 1] ?? dflt;
};
const has = (n) => argv.includes(`--${n}`);

const keyName = arg('key', 'image');
const spec = keyName === 'claude'
  ? { key: cfg.claude.authToken, base: cfg.claude.baseUrl.replace(/\/$/, '') + '/v1', model: cfg.claude.model }
  : keyName === 'codex'
    ? { key: cfg.codex.apiKey, base: cfg.codex.baseUrl, model: cfg.codex.model }
    : { key: cfg.image?.apiKey, base: cfg.image?.baseUrl, mirror: cfg.image?.mirrorBaseUrl, model: cfg.image?.model };
if (!spec.key) { console.error(`没有 ${keyName} 的令牌（relay.json 缺该段）`); process.exit(2); }

const order = arg('prefer', 'primary') === 'mirror' ? ['mirror', 'primary'] : ['primary', 'mirror'];
const ENDPOINTS = order.map((k) => [k, k === 'mirror' ? spec.mirror : spec.base]).filter(([, u]) => u);

const model = arg('model', spec.model || 'gpt-image-2.5');
const size = arg('size', '1024x1024');
const quality = arg('quality', 'high');
const n = Number(arg('n', 1));
const TIMEOUT = Number(arg('timeout', 180)) * 1000;
const outDir = path.resolve(process.cwd(), arg('out', path.join(HERE, 'out', 'ai')));
const prompt = has('prompt-file')
  ? fs.readFileSync(path.resolve(process.cwd(), arg('prompt-file')), 'utf8').trim()
  : arg('prompt', '').trim();
if (!prompt) { console.error('缺少提示词（--prompt 或 --prompt-file）'); process.exit(2); }

const bodyFor = (withQuality) => {
  const b = { model, prompt, n, size, response_format: 'b64_json' };
  if (withQuality && quality) b.quality = quality;
  return b;
};
if (has('dry')) {
  console.log(`端点顺序: ${ENDPOINTS.map(([k, u]) => `${k}=${u}`).join(' -> ')}`);
  console.log(JSON.stringify({ ...bodyFor(true), prompt: prompt.slice(0, 100) + '...' }, null, 2));
  process.exit(0);
}

const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
fs.mkdirSync(outDir, { recursive: true });

async function attempt(base, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${spec.key}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await r.text();
    return { status: r.status, text, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, text: `网络异常: ${e.message}`, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

const saved = [], log = [];
for (const [name, base] of ENDPOINTS) {
  for (const withQuality of [true, false]) {
    const r = await attempt(base, bodyFor(withQuality));
    let json = null; try { json = JSON.parse(r.text); } catch {}
    const okStatus = r.status === 200 && !json?.error && (json?.data?.length > 0);
    console.log(`[${name}] HTTP ${r.status}  ${(r.ms / 1000).toFixed(1)}s${withQuality ? '' : '（已去掉 quality）'}  ${okStatus ? 'OK' : 'FAIL: ' + (json?.error?.message || r.text.slice(0, 160))}`);
    log.push({ endpoint: name, status: r.status, ms: r.ms, withQuality, ok: !!okStatus, err: okStatus ? null : (json?.error?.message || r.text.slice(0, 160)) });
    if (!okStatus) {
      if (withQuality && (r.status === 400 || r.status === 422)) continue;   // 参数不被支持 -> 去掉 quality 再试
      break;                                                                  // 其它错误 -> 换下一个端点
    }
    for (let i = 0; i < json.data.length; i++) {
      const it = json.data[i];
      let buf;
      if (it.b64_json) buf = Buffer.from(it.b64_json, 'base64');
      else if (it.url) {
        const ir = await fetch(it.url);
        if (!ir.ok) { console.warn(`   下载 ${it.url} -> HTTP ${ir.status}`); continue; }
        buf = Buffer.from(await ir.arrayBuffer());
      } else continue;
      const file = path.join(outDir, `${STAMP}-${model}-${name}-${i + 1}.png`);
      fs.writeFileSync(file, buf);
      console.log(`   OK ${path.basename(file)}  ${(buf.length / 1024).toFixed(0)} KB`);
      saved.push({ file: path.basename(file), endpoint: name, ms: r.ms });
    }
    if (saved.length) {
      fs.writeFileSync(path.join(outDir, `${STAMP}-${model}.json`),
        JSON.stringify({ model, size, quality, n, prompt, endpointUsed: name, elapsedMs: r.ms, files: saved.map((s) => s.file), attempts: log, at: new Date().toISOString() }, null, 2));
      console.log(`\n完成 ${saved.length} 张（走 ${name}，${(r.ms / 1000).toFixed(1)}s）-> ${path.relative(process.cwd(), outDir)}`);
      process.exit(0);
    }
  }
  console.log(`   -> ${name} 未成功，换下一个端点（镜像兜底）`);
}
console.error('所有端点均失败');
process.exit(1);
