# -*- coding: utf-8 -*-
"""解析花纹源图：配色 + 网格几何 + 可平铺模数（纯测量，不做主观判断）"""
import sys, json
from collections import Counter
from PIL import Image

src = sys.argv[1] if len(sys.argv) > 1 else r"scripts\src\pattern-source.png"
im = Image.open(src).convert("RGB")
W, H = im.size
px = im.load()
print(f"# size = {W}x{H}")

# 1) 配色直方图（量化到 8 级，避免抗锯齿噪声）
q = Counter()
for y in range(H):
    for x in range(W):
        r, g, b = px[x, y]
        q[(r // 8 * 8, g // 8 * 8, b // 8 * 8)] += 1
tot = W * H
print("# top colors (quantized 8):")
for c, n in q.most_common(8):
    print(f"#   #{c[0]:02x}{c[1]:02x}{c[2]:02x}  {n:7d}  {100*n/tot:5.2f}%  rgb{c}")

# 亮度分界：找出「线」的阈值
lum = lambda p: 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
vals = sorted(lum(px[x, y]) for y in range(H) for x in range(W))
print(f"# luminance min={vals[0]:.1f} p50={vals[len(vals)//2]:.1f} p99={vals[int(len(vals)*0.99)]:.1f} max={vals[-1]:.1f}")
TH = (vals[0] + vals[-1]) / 2
print(f"# line threshold (mid) = {TH:.1f}")

# 2) 逐列/逐行统计亮像素（线）占比
col = [sum(1 for y in range(H) if lum(px[x, y]) > TH) for x in range(W)]
row = [sum(1 for x in range(W) if lum(px[x, y]) > TH) for y in range(H)]

def peaks(arr, frac=0.5):
    m = max(arr)
    hot = [i for i, v in enumerate(arr) if v > m * frac]
    # 合并相邻
    groups, cur = [], [hot[0]] if hot else []
    for i in hot[1:]:
        if i - cur[-1] <= 2:
            cur.append(i)
        else:
            groups.append(cur); cur = [i]
    if cur: groups.append(cur)
    return [(sum(g) / len(g), max(arr[i] for i in g)) for g in groups]

vp = peaks(col)
hp = peaks(row)
print(f"# vertical lines (x, strength): {[(round(x,1), s) for x, s in vp]}")
print(f"# horizontal lines (y, strength): {[(round(y,1), s) for y, s in hp]}")

# 3) 相邻线间距 → 模数
def gaps(ps):
    xs = [p[0] for p in ps]
    return [round(xs[i+1] - xs[i], 1) for i in range(len(xs) - 1)]

vg, hg = gaps(vp), gaps(hp)
print(f"# vertical gaps: {vg}")
print(f"# horizontal gaps: {hg}")

# 4) 线条粗细：在若干行上测量单像素亮区宽度
widths = []
for y in range(0, H, 17):
    run = 0
    for x in range(W):
        if lum(px[x, y]) > TH:
            run += 1
        elif run:
            widths.append(run); run = 0
    if run: widths.append(run)
print(f"# line pixel widths sample: {sorted(Counter(widths).items())[:10]}")

json.dump({"size": [W, H], "palette": [{"hex": "#%02x%02x%02x" % c, "pct": round(100*n/tot, 2)} for c, n in q.most_common(8)],
           "vlines": [round(p[0], 1) for p in vp], "hlines": [round(p[0], 1) for p in hp],
           "vgaps": vg, "hgaps": hg},
          open(r"scripts\src\analysis.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("# -> src/analysis.json")
