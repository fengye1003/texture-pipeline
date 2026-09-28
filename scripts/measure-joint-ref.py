# -*- coding: utf-8 -*-
"""量「缝」+ 配色：从用户给的实铺参考图测出 缝宽/模数 比例、缝色、砖面色，并与我的成品对照"""
from PIL import Image
import statistics

im = Image.open(r"scripts\src\joint-ref.png").convert("RGB")
W, H = im.size
px = im.load()
lum = lambda p: 0.299*p[0]+0.587*p[1]+0.114*p[2]
L = [[lum(px[x, y]) for x in range(W)] for y in range(H)]
at = lambda x, y: L[min(H-1, max(0, y))][min(W-1, max(0, x))]

joint_px, tile_px = [], []
for y in range(4, H - 4, 2):
    for x in range(8, W - 8, 2):
        v = at(x, y)
        loc = (at(x-6, y) + at(x-5, y) + at(x+5, y) + at(x+6, y)) / 4
        if v - loc > 12: joint_px.append(px[x, y])
        elif v - loc < 2: tile_px.append(px[x, y])

def mean_rgb(a): return tuple(round(sum(c[i] for c in a)/len(a)) for i in range(3)) if a else (0,0,0)
mj, mt = mean_rgb(joint_px), mean_rgb(tile_px)
print(f"# 参考图 {W}x{H}")
print(f"# 缝  : {len(joint_px):6d} px  rgb{mj}  #%02x%02x%02x  亮度 {lum(mj):.0f}" % mj)
print(f"# 砖面: {len(tile_px):6d} px  rgb{mt}  #%02x%02x%02x  亮度 {lum(mt):.0f}" % mt)
tl = sorted(lum(p) for p in tile_px); n = len(tl)
print(f"# 砖面亮度分位: p05={tl[int(n*.05)]:.0f} p25={tl[int(n*.25)]:.0f} p50={tl[n//2]:.0f} p75={tl[int(n*.75)]:.0f} p95={tl[int(n*.95)]:.0f}")

# 我的成品（石材版）同样统计
mine = Image.open(r"scripts\out\tile-albedo-stone.png").convert("RGB")
MW, MH = mine.size
mp = mine.load()
ml = lambda p: 0.299*p[0]+0.587*p[1]+0.114*p[2]
mL = [[ml(mp[x, y]) for x in range(MW)] for y in range(MH)]
mat = lambda x, y: mL[min(MH-1, max(0, y))][min(MW-1, max(0, x))]
mj2, mt2 = [], []
for y in range(8, MH - 8, 2):
    for x in range(8, MW - 8, 2):
        v = mat(x, y)
        loc = (mat(x-12, y) + mat(x-11, y) + mat(x+11, y) + mat(x+12, y)) / 4
        if v - loc > 12: mj2.append(mp[x, y])
        else: mt2.append(mp[x, y])
a, b = mean_rgb(mj2), mean_rgb(mt2)
print(f"\n# 我的成品 {MW}x{MH}")
print(f"# 缝  : {len(mj2):6d} px  rgb{a}  #%02x%02x%02x  亮度 {ml(a):.0f}" % a)
print(f"# 砖面: {len(mt2):6d} px  rgb{b}  #%02x%02x%02x  亮度 {ml(b):.0f}" % b)
print(f"\n# 结论：砖面亮度 参考 {lum(mt):.0f} vs 我的 {ml(b):.0f}（差 {ml(b)-lum(mt):+.0f}）")
print(f"#       缝亮度   参考 {lum(mj):.0f} vs 我的 {ml(a):.0f}（差 {ml(a)-lum(mj):+.0f}）")
