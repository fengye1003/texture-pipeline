# -*- coding: utf-8 -*-
"""提取花纹的「格网边」矩阵 → 求重复周期（判断可平铺模数）"""
import json
from PIL import Image

src = sys.argv[1] if len(sys.argv) > 1 else "pattern-source.png"   # 花纹参考图：python extract-edges.py <图>
im = Image.open(src).convert("RGB")
W, H = im.size
px = im.load()
lum = lambda p: 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
TH = 82

COLS, ROWS = 10, 14          # 由 analyze.py 的线位置得出
mx, my = W / COLS, H / ROWS
print(f"module = {mx:.2f} x {my:.2f} px")

def bright(cx, cy, rad=2):
    """以 (cx,cy) 为中心的一小片里取最亮的 3 个像素均值（线是 1px，需容差）"""
    v = []
    for dy in range(-rad, rad + 1):
        for dx in range(-rad, rad + 1):
            x, y = int(round(cx + dx)), int(round(cy + dy))
            if 0 <= x < W and 0 <= y < H:
                v.append(lum(px[x, y]))
    v.sort(reverse=True)
    return sum(v[:3]) / 3

# ve[c][r] = 第 c 条竖线（c=1..COLS-1，内部）在第 r 行区间内是否存在
ve = [[0] * ROWS for _ in range(COLS + 1)]
he = [[0] * COLS for _ in range(ROWS + 1)]
for c in range(1, COLS):
    for r in range(ROWS):
        ve[c][r] = 1 if bright(c * mx, (r + 0.5) * my) > TH else 0
for r in range(1, ROWS):
    for c in range(COLS):
        he[r][c] = 1 if bright((c + 0.5) * mx, r * my) > TH else 0

print("\n[竖线矩阵] 行=行区间 r0..r13，列=竖线 c1..c9   (1=有线)")
for r in range(ROWS):
    print("  r%02d " % r + "".join(str(ve[c][r]) for c in range(1, COLS)))
print("\n[横线矩阵] 行=横线 r1..r13，列=列区间 c0..c9")
for r in range(1, ROWS):
    print("  h%02d " % r + "".join(str(he[r][c]) for c in range(COLS)))

def period(mat, axis_len, other_len):
    """mat[i][j]，对 i 求最小周期 p 使 mat[i][j]==mat[i+p][j] 对全部 j 成立（边界处跳过）"""
    for p in range(1, axis_len // 2 + 1):
        ok = True
        for i in range(axis_len - p):
            for j in range(other_len):
                if mat[i][j] != mat[i + p][j]:
                    ok = False; break
            if not ok: break
        if ok:
            return p
    return None

pv = period(ve, COLS + 1, ROWS)
ph = period(he, ROWS + 1, COLS)
print(f"\n竖线方向最小周期 = {pv} 个模数；横线方向最小周期 = {ph} 个模数")

json.dump({"ve": ve, "he": he, "module_px": [mx, my], "period": [pv, ph]},
          open(r"scripts\src\edges.json", "w", encoding="utf-8"), indent=1)
print("-> src/edges.json")
