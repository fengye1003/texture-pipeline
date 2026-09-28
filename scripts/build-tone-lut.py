# -*- coding: utf-8 -*-
"""生成色调映射 LUT：把「我用的石材板」的颜色分布，映射到「用户实铺参考图的砖面」分布
   → 逐通道直方图匹配（分位数对分位数），落盘 tone-lut.json 供 make-texture.mjs 使用。
   用法：python build-tone-lut.py [--blend 1.0]
"""
import json, sys
from PIL import Image
import statistics

blend = 1.0
if '--blend' in sys.argv: blend = float(sys.argv[sys.argv.index('--blend') + 1])

# ── 参考图：取砖面像素（排除缝）──────────────────────────────────────────
ref = Image.open(r"scripts\src\joint-ref.png").convert("RGB")
W, H = ref.size; px = ref.load()
lum = lambda p: 0.299*p[0]+0.587*p[1]+0.114*p[2]
L = [[lum(px[x, y]) for x in range(W)] for y in range(H)]
at = lambda x, y: L[min(H-1, max(0, y))][min(W-1, max(0, x))]
ref_ch = [[], [], []]
for y in range(4, H - 4, 2):
    for x in range(8, W - 8, 2):
        v = at(x, y); loc = (at(x-6, y) + at(x-5, y) + at(x+5, y) + at(x+6, y)) / 4
        if v - loc < 2:                       # 只收砖面，排除高响应的缝
            p = px[x, y]
            for c in range(3): ref_ch[c].append(p[c])
for c in range(3): ref_ch[c].sort()
print(f"# 参考图砖面 {len(ref_ch[0])} 点；p50 = {[ref_ch[c][len(ref_ch[c])//2] for c in range(3)]}")

# ── 我的石材板 ──────────────────────────────────────────────────────────
meta = json.load(open(r"scripts\src\stone-plate.json", encoding="utf-8"))
MW, MH = meta['w'], meta['h']
raw = open(r"scripts\src\stone-plate.rgb", "rb").read()
my_ch = [[], [], []]
for i in range(0, MW * MH, 3):
    for c in range(3): my_ch[c].append(raw[i * 3 + c])
for c in range(3): my_ch[c].sort()
print(f"# 石材板 {len(my_ch[0])} 点；p50 = {[my_ch[c][len(my_ch[c])//2] for c in range(3)]}")

# ── 逐通道直方图匹配 ────────────────────────────────────────────────────
def quantile(sorted_arr, q):
    n = len(sorted_arr)
    if n == 0: return 0
    pos = q * (n - 1)
    lo = int(pos); hi = min(n - 1, lo + 1)
    return sorted_arr[lo] + (sorted_arr[hi] - sorted_arr[lo]) * (pos - lo)

lut = []
for c in range(3):
    src, dst = my_ch[c], ref_ch[c]
    n = len(src)
    col = []
    for v in range(256):
        # src 中小于等于 v 的比例 → 在 dst 中取同分位
        lo, hi = 0, n
        while lo < hi:
            mid = (lo + hi) // 2
            if src[mid] <= v: lo = mid + 1
            else: hi = mid
        q = lo / n
        mapped = quantile(dst, q)
        col.append(round(v + (mapped - v) * blend))
    lut.append(col)
    print(f"# 通道{c}: LUT 关键点 0->{col[0]} 64->{col[64]} 128->{col[128]} 192->{col[192]} 255->{col[255]}")

json.dump({"lut": lut, "blend": blend,
           "ref": "joint-ref.png tile faces", "src": "stone-plate.rgb",
           "ref_p50": [ref_ch[c][len(ref_ch[c])//2] for c in range(3)],
           "src_p50": [my_ch[c][len(my_ch[c])//2] for c in range(3)]},
          open(r"scripts\src\tone-lut.json", "w"), indent=0)
print("# -> src/tone-lut.json")
