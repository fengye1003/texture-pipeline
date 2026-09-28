# -*- coding: utf-8 -*-
"""客观对比：AI 生图版 vs 程序化版
   ① 能不能无缝平铺（接缝跳变 vs 内部平均跳变）② 网格是否规整（缝间距的离散度）③ 配色
   用法：python compare-ai-vs-procedural.py <AI图> [我的图]"""
import sys, statistics
from PIL import Image, ImageDraw

ai_path = sys.argv[1]
my_path = sys.argv[2] if len(sys.argv) > 2 else r"scripts\out\tile-albedo-stone.png"

def load(p):
    im = Image.open(p).convert("RGB")
    return im, im.load(), im.size

def seam_score(px, W, H):
    """接缝跳变 / 内部平均跳变。>2 基本可判"有可见接缝" """
    def col_diff(x1, x2):
        return sum(abs(px[x1, y][c] - px[x2, y][c]) for y in range(0, H, 2) for c in range(3)) / (3 * len(range(0, H, 2)))
    def row_diff(y1, y2):
        return sum(abs(px[x, y1][c] - px[x, y2][c]) for x in range(0, W, 2) for c in range(3)) / (3 * len(range(0, W, 2)))
    inner_c = statistics.mean(col_diff(x, x + 1) for x in range(W // 4, 3 * W // 4, 17))
    inner_r = statistics.mean(row_diff(y, y + 1) for y in range(H // 4, 3 * H // 4, 17))
    return col_diff(W - 1, 0) / inner_c, row_diff(H - 1, 0) / inner_r, inner_c, inner_r

def grid_score(px, W, H):
    """找竖向缝并看间距规整度：gaps 的 (标准差/均值) 越小越规整"""
    lum = lambda p: 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
    L = [[lum(px[x, y]) for x in range(W)] for y in range(H)]
    prof = []
    g = 5
    for x in range(g, W - g):
        s = sum(L[y][x] - (L[y][x - g] + L[y][x + g]) / 2 for y in range(H)) / H
        prof.append((x, s))
    pk = max(v for _, v in prof)
    cand = sorted(x for x, v in prof if v > pk * 0.55)
    groups, cur = [], [cand[0]]
    for i in cand[1:]:
        if i - cur[-1] <= 6: cur.append(i)
        else: groups.append(sum(cur) / len(cur)); cur = [i]
    groups.append(sum(cur) / len(cur))
    gaps = [groups[i + 1] - groups[i] for i in range(len(groups) - 1)]
    if len(gaps) < 2: return None, groups, None
    cv = statistics.pstdev(gaps) / statistics.mean(gaps)
    return cv, groups, gaps

def stats(px, W, H):
    v = sorted(0.299 * px[x, y][0] + 0.587 * px[x, y][1] + 0.114 * px[x, y][2] for y in range(0, H, 3) for x in range(0, W, 3))
    n = len(v)
    return v[int(n * .05)], v[n // 2], v[int(n * .95)]

for label, p in [("AI 生图版", ai_path), ("程序化版", my_path)]:
    im, px, (W, H) = load(p)
    sc, sr, ic, ir = seam_score(px, W, H)
    cv, groups, gaps = grid_score(px, W, H)
    p05, p50, p95 = stats(px, W, H)
    print(f"\n# {label}  {W}x{H}")
    print(f"  无缝性：左右接缝跳变 {sc:.2f}x 内部（{W-1}->0 实际 {ic*sc:.1f}，内部相邻 {ic:.1f}）")
    print(f"          上下接缝跳变 {sr:.2f}x 内部（内部相邻 {ir:.1f}）")
    print(f"          -> {'[OK] 接缝与内部噪声同量级，基本可平铺' if max(sc, sr) < 1.6 else '[NG] 接缝明显，不能直接平铺'}")
    print(f"  网格：检出 {len(groups)} 条竖缝，间距 {[round(x) for x in (gaps or [])]}")
    if cv is not None:
        print(f"          间距离散度（越小越规整）{cv*100:.1f}% -> {'[OK] 规整' if cv < 0.08 else '[注意] 间距不匀'}")
    print(f"  配色：p05 {p05:.0f} / p50 {p50:.0f} / p95 {p95:.0f}")
