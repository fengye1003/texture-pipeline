# -*- coding: utf-8 -*-
"""缝带"变平"程度对比（与内容无关的稳健指标）
   指标：中线附近固定 16px 竖条带的**高频能量** ÷ 全图同类条带的**中位数**（1.00 = 完全看不出差别）
   —— 基线用全图中位数，避免"对照区恰好落在缝带里"的污染。"""
from PIL import Image, ImageFilter, ImageDraw
import statistics, os

files = []
for n in (16, 32, 64, 128, 256):
    p = r"scripts\out\terrazzo-seamless.png" if n == 64 else rf"scripts\out\terrazzo-b{n}.png"
    if os.path.exists(p):
        files.append((f"band{n}", p))

def hf_strip(im, x0, x1, y0, y1):
    crop = im.crop((x0, y0, x1, y1)).convert("L")
    blur = crop.filter(ImageFilter.GaussianBlur(1.2))
    a, b = crop.load(), blur.load()
    W, H = crop.size
    return statistics.mean(abs(a[x, y] - b[x, y]) for y in range(0, H, 2) for x in range(0, W, 2))

print("# 缝带中心 16px 条带的高频能量 / 全图同类条带中位数（1.00 = 与普通区域无差别）")
rows = []
for name, p in files:
    im = Image.open(p).convert("RGB")
    W, H = im.size
    cx, band = W // 2, int(name[4:])
    mine = hf_strip(im, cx - 8, cx + 8, 200, H - 200)
    base = []
    for x in range(60, W - 60, 40):
        if abs(x - cx) < band // 2 + 24:          # 排除缝带自身
            continue
        base.append(hf_strip(im, x - 8, x + 8, 200, H - 200))
    med = statistics.median(base)
    rows.append((name, mine, med, mine / med))
    print(f"  {name:8s} 缝带 {mine:5.2f} / 基线中位 {med:5.2f}  ->  {mine/med:.3f}")

print("\n# 判据：比值越接近 1 越好；< 0.85 说明缝带明显偏平")
best = max(rows, key=lambda r: r[3])
print(f"# 本次最佳：{best[0]}（{best[3]:.3f}）")

crops = [(n, Image.open(p).convert("RGB").crop((405, 290, 665, 550))) for n, p in files]
GAP, TOP = 10, 24
cw, ch = crops[0][1].size
canvas = Image.new("RGB", (len(crops) * (cw + GAP) + GAP, ch + TOP + GAP), (18, 18, 20))
d = ImageDraw.Draw(canvas)
for i, (n, c) in enumerate(crops):
    x = GAP + i * (cw + GAP)
    canvas.paste(c, (x, TOP))
    d.text((x + 3, 8), f"{n} 1:1", fill=(215, 215, 220))
canvas.save(r"scripts\out\terrazzo-band-compare.png")
print("-> out/terrazzo-band-compare.png", canvas.size)
