# -*- coding: utf-8 -*-
"""重构花纹：合并格网 → 矩形块布局 → 5x5 单元描述 + 与原图线掩膜比对"""
import json
from PIL import Image

src = sys.argv[1] if len(sys.argv) > 1 else "pattern-source.png"   # 花纹参考图：python reconstruct.py <图>
im = Image.open(src).convert("RGB")
W, H = im.size
px = im.load()
lum = lambda p: 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
TH = 82
COLS, ROWS = 10, 14
mx, my = W / COLS, H / ROWS

def bright(cx, cy, rad=2):
    v = []
    for dy in range(-rad, rad + 1):
        for dx in range(-rad, rad + 1):
            x, y = int(round(cx + dx)), int(round(cy + dy))
            if 0 <= x < W and 0 <= y < H:
                v.append(lum(px[x, y]))
    v.sort(reverse=True)
    return sum(v[:3]) / 3

ve = [[0] * ROWS for _ in range(COLS + 1)]
he = [[0] * COLS for _ in range(ROWS + 1)]
for c in range(1, COLS):
    for r in range(ROWS):
        ve[c][r] = 1 if bright(c * mx, (r + 0.5) * my) > TH else 0
for r in range(1, ROWS):
    for c in range(COLS):
        he[r][c] = 1 if bright((c + 0.5) * mx, r * my) > TH else 0
for r in range(ROWS):
    ve[0][r] = ve[COLS][r] = 1
for c in range(COLS):
    he[0][c] = he[ROWS][c] = 1

# ── 贪心合并成最大矩形 ────────────────────────────────────────────────
used = [[False] * COLS for _ in range(ROWS)]
rects = []
for r in range(ROWS):
    for c in range(COLS):
        if used[r][c]:
            continue
        # 向右扩展
        w = 1
        while c + w < COLS and not ve[c + w][r] and not used[r][c + w]:
            w += 1
        # 向下扩展：整行必须都无横线、且未占用
        h = 1
        while r + h < ROWS:
            ok = True
            for k in range(w):
                cc = c + k
                if used[r + h][cc] or he[r + h][cc] or (cc > c and ve[cc][r + h]) or (cc + 1 < c + w and ve[cc + 1][r + h]):
                    ok = False; break
            if not ok: break
            h += 1
        for dr in range(h):
            for dc in range(w):
                used[r + dr][c + dc] = True
        rects.append((c, r, w, h))

print(f"# 共识别 {len(rects)} 块；尺寸分布: {sorted(set((w,h) for _,_,w,h in rects))}")
print("\n# 5x5 单元内的块布局（取左上角单元；列=w, 行=h 的图）")
seen = set()
for (c, r, w, h) in sorted(rects, key=lambda t: (t[1], t[0])):
    key = (c % 5, r % 5, w, h)
    if key in seen: continue
    seen.add(key)
    print(f"#   单元内 x={c%5} y={r%5} → {w}x{h} 格")

# 用块布局渲染到 10x14 网格的 ASCII 图
grid = [["." ] * COLS for _ in range(ROWS)]
letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
for i, (c, r, w, h) in enumerate(rects):
    ch = letters[i % len(letters)]
    for dr in range(h):
        for dc in range(w):
            grid[r + dr][c + dc] = ch
print("\n# 块布局图（同字母=同一块）")
for row in grid:
    print("#   " + " ".join(row))

# ── 与原图线掩膜比对 ──────────────────────────────────────────────────
def render_mask(scale=1.0):
    img = Image.new("L", (W, H), 0)
    d = img.load()
    for (c, r, w, h) in rects:
        x0, y0 = c * mx, r * my
        # 画四条边（线宽 1px）
        for x in range(int(x0), min(W - 1, int(x0 + w * mx)) + 1):
            for yy in (int(y0), int(y0 + h * my)):
                if 0 <= yy < H: d[x, yy] = 255
        for y in range(int(y0), min(H - 1, int(y0 + h * my)) + 1):
            for xx in (int(x0), int(x0 + w * mx)):
                if 0 <= xx < W: d[xx, y] = 255
    return img

m = render_mask()
d = m.load()
# 原图线条掩膜（阈值 + 1px 膨胀）
srcmask = set()
for y in range(H):
    for x in range(W):
        if lum(px[x, y]) > TH:
            srcmask.add((x, y))
gen = {(x, y) for y in range(H) for x in range(W) if d[x, y] > 0}
def dilate(s, r=1):
    o = set()
    for (x, y) in s:
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                o.add((x + dx, y + dy))
    return o
inter = len(gen & dilate(srcmask, 1))
print(f"\n# 生成线像素 {len(gen)}，源线像素 {len(srcmask)}，容差1px 命中 {inter} → 命中率 {100*inter/max(1,len(gen)):.1f}%")
missing = srcmask - dilate(gen, 1)
print(f"# 源图有、生成图没有的线像素（容差1px）：{len(missing)} / {len(srcmask)} = {100*len(missing)/len(srcmask):.1f}%")
# 落一个对照图
Image.blend(im.convert("RGB"), Image.merge("RGB", (m, m, m)), 0.35).save(r"scripts\src\verify-overlay.png")
json.dump({"rects": rects, "module_px": [mx, my]}, open(r"scripts\src\rects.json", "w"), indent=1)
print("# -> src/verify-overlay.png, src/rects.json")
