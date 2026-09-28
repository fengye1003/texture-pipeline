# -*- coding: utf-8 -*-
"""水磨石原图体检：尺寸 / 光照均匀度 / 配色 / 当前能不能平铺"""
import sys, statistics
from PIL import Image, ImageFilter

src = sys.argv[1]
im = Image.open(src).convert("RGB")
W, H = im.size
px = im.load()
lum = lambda p: 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
print(f"# 尺寸 {W}x{H}  比例 {W/H:.3f}")

# 光照均匀度：4x4 块均值
print("# 4x4 块亮度均值（看有无摄影渐变）:")
for by in range(4):
    row = []
    for bx in range(4):
        s, n = 0.0, 0
        for y in range(by * H // 4, (by + 1) * H // 4, 5):
            for x in range(bx * W // 4, (bx + 1) * W // 4, 5):
                s += lum(px[x, y]); n += 1
        row.append(s / n)
    print("#   " + " ".join(f"{v:6.1f}" for v in row))
allm = [lum(px[x, y]) for y in range(0, H, 5) for x in range(0, W, 5)]
print(f"# 全图 p05 {sorted(allm)[int(len(allm)*.05)]:.0f} / p50 {statistics.median(allm):.0f} / p95 {sorted(allm)[int(len(allm)*.95)]:.0f}")

# 配色
from collections import Counter
q = Counter((px[x, y][0] // 16 * 16, px[x, y][1] // 16 * 16, px[x, y][2] // 16 * 16) for y in range(0, H, 5) for x in range(0, W, 5))
print("# 主色（量化到 16）:", [("#%02x%02x%02x" % c, f"{100*v/len(allm):.1f}%") for c, v in q.most_common(6)])

# 当前的"可平铺性"：接缝跳变 / 内部相邻跳变
def seam(px, W, H, box=None):
    x0, y0, x1, y1 = box or (0, 0, W, H)
    w, h = x1 - x0, y1 - y0
    def cd(x1_, x2_):
        return sum(abs(px[x1_, y][c] - px[x2_, y][c]) for y in range(y0, y1, 2) for c in range(3)) / (3 * len(range(y0, y1, 2)))
    def rd(y1_, y2_):
        return sum(abs(px[x, y1_][c] - px[x, y2_][c]) for x in range(x0, x1, 2) for c in range(3)) / (3 * len(range(x0, x1, 2)))
    ic = statistics.mean(cd(x, x + 1) for x in range(x0 + w // 4, x0 + 3 * w // 4, 13))
    ir = statistics.mean(rd(y, y + 1) for y in range(y0 + h // 4, y0 + 3 * h // 4, 13))
    return cd(x1 - 1, x0) / ic, rd(y1 - 1, y0) / ir, ic, ir
sc, sr, ic, ir = seam(px, W, H)
print(f"\n# 原图可平铺性：左右接缝 {sc:.2f}x 内部（{ic*sc:.1f} vs {ic:.1f}）｜上下 {sr:.2f}x（{ir:.1f}）")
print("#   -> " + ("[NG] 原图不能平铺，需要处理" if max(sc, sr) > 1.6 else "[OK] 已经能平铺"))
