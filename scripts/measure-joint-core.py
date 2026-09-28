# -*- coding: utf-8 -*-
"""量「缝芯」颜色（不被抗锯齿混色带偏）：参考图 vs 我的成品
   做法：在缝带内逐行取局部响应最大的那一列/行像素，聚合成中位数"""
from PIL import Image
import statistics

def joint_core(path, label, axis='x', gap=5, n_lines=3):
    im = Image.open(path).convert("RGB"); W, H = im.size; px = im.load()
    lum = lambda p: 0.299*p[0]+0.587*p[1]+0.114*p[2]
    L = [[lum(px[x, y]) for x in range(W)] for y in range(H)]
    at = lambda x, y: L[min(H-1, max(0, y))][min(W-1, max(0, x))]
    # 1) 找响应最强的若干条缝
    prof = []
    for i in range(gap, (W if axis == 'x' else H) - gap):
        s = 0; m = H if axis == 'x' else W
        for j in range(0, m, 2):
            if axis == 'x': s += at(i, j) - (at(i-gap, j) + at(i+gap, j)) / 2
            else:           s += at(j, i) - (at(j, i-gap) + at(j, i+gap)) / 2
        prof.append((i, s / (m // 2)))
    picks, used = [], []
    for i, v in sorted(prof, key=lambda t: -t[1]):
        if any(abs(i - u) < 30 for u in used): continue
        used.append(i); picks.append(i)
        if len(picks) >= n_lines: break
    # 2) 缝芯像素 = 缝附近 ±4px 里最亮的那个
    cols = [[], [], []]
    for c in picks:
        rng = range(0, H, 2) if axis == 'x' else range(0, W, 2)
        for j in rng:
            best, bv = None, -1
            for d in range(-4, 5):
                x, y = (c + d, j) if axis == 'x' else (j, c + d)
                p = px[min(W-1, max(0, x)), min(H-1, max(0, y))]
                if lum(p) > bv: bv, best = lum(p), p
            for k in range(3): cols[k].append(best[k])
    med = tuple(round(statistics.median(cols[k])) for k in range(3))
    print(f"# {label:22s} 取样 {len(picks)} 条缝 → 缝芯中位色 rgb{med}  #%02x%02x%02x  亮度 {lum(med):.0f}" % med)
    return med

print("# 缝芯颜色对照（axis=x 竖缝）")
a = joint_core(r"scripts\src\joint-ref.png", "参考实铺图")
b = joint_core(r"scripts\out\tile-albedo-stone.png", "我的成品(石材版)")
print(f"\n# 我的缝芯比参考 亮 {b[0]-a[0]:+d}/{b[1]-a[1]:+d}/{b[2]-a[2]:+d}（RGB）")
print(f"# 建议 GROUT_HEX = " + "%02x%02x%02x" % tuple(min(255, max(0, round(104 + (a[k] - b[k])))) for k in range(3)) + "（当前 68605d）")
