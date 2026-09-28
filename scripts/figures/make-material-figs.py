# -*- coding: utf-8 -*-
"""通用交付图：① <名>-seamless-proof.png（原图 2x2 vs 处理后 2x2 + 接缝 1:1 特写）
              ② <名>-material-maps.png（各张贴图总览）
   用法：python make-material-figs.py <suf> <原图路径> <输出前缀> [缝前指标] [缝后指标]
   例：  python make-material-figs.py -speckle src/speckle-source.jpg out/speckle "2.79/2.99" "1.11/0.78"
"""
import sys
from PIL import Image, ImageDraw

suf, src_path, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
before = sys.argv[4] if len(sys.argv) > 4 else "?"
after = sys.argv[5] if len(sys.argv) > 5 else "?"
import os
OUT = os.environ.get("TEX_OUT", "out")   # 贴图所在目录（默认 ./out）；也可用环境变量 TEX_OUT
name = prefix.split("\\")[-1].split("/")[-1] if ("\\" in prefix or "/" in prefix) else prefix

src = Image.open(src_path).convert("RGB")
W, H = src.size
S = min(W, H)
src = src.crop(((W - S) // 2, (H - S) // 2, (W - S) // 2 + S, (H - S) // 2 + S))
seam = Image.open(f"{prefix}-seamless.png").convert("RGB")

CELL, ZW, ZH = 400, 240, 420
def tile2x2(im):
    s = im.resize((CELL, CELL), Image.LANCZOS)
    c = Image.new("RGB", (CELL * 2, CELL * 2))
    for i in range(2):
        for j in range(2):
            c.paste(s, (i * CELL, j * CELL))
    return c
def seam_zoom(im):
    W2, H2 = im.size
    z = Image.new("RGB", (ZW * 2, ZH))
    y0 = (H2 - ZH // 2) // 2
    z.paste(im.crop((W2 - ZW, y0, W2, y0 + ZH // 2)), (0, 0))
    z.paste(im.crop((0, y0, ZW, y0 + ZH // 2)), (ZW, 0))
    z.paste(im.crop(((W2 - ZW * 2) // 2, H2 - ZH // 2, (W2 - ZW * 2) // 2 + ZW * 2, H2)), (0, ZH // 2))
    return z

a, b = tile2x2(src), tile2x2(seam)
za, zb = seam_zoom(src), seam_zoom(seam)
GAP, TOP = 16, 34
canvas = Image.new("RGB", (CELL * 4 + GAP * 3, CELL * 2 + ZH + 60), (12, 12, 14))
d = ImageDraw.Draw(canvas)
canvas.paste(a, (GAP, TOP)); canvas.paste(b, (GAP * 2 + CELL * 2, TOP))
d.text((GAP + 4, 12), f"ORIGINAL  2x2 tiled  (seam jump {before}x internal)", fill=(240, 190, 190))
d.text((GAP * 2 + CELL * 2 + 4, 12), f"PROCESSED  2x2 tiled  ({after}x = invisible)", fill=(190, 240, 190))
y0 = TOP + CELL * 2 + 26
canvas.paste(za, (GAP + (CELL * 2 - ZW * 2) // 2, y0))
canvas.paste(zb, (GAP * 2 + CELL * 2 + (CELL * 2 - ZW * 2) // 2, y0))
d.text((GAP + 4, y0 - 14), "1:1 zoom across the tile border  (left|right  and  top|bottom joined)", fill=(230, 230, 235))
canvas.save(rf"{OUT}\{name}-seamless-proof.png")
print(f"-> {name}-seamless-proof.png", canvas.size)

items = [("albedo (sRGB)", f"tile-albedo{suf}.png", "rgb"),
         ("normal (OpenGL)", f"tile-normal-opengl{suf}.png", "rgb"),
         ("Roughness", f"tile-roughness{suf}.png", "rgb"),
         ("AO", f"tile-ao{suf}.png", "rgb"),
         ("Metallic (all 0)", f"tile-metallic{suf}.png", "rgb"),
         ("ORM  R=AO G=Rough B=Metal", f"tile-orm{suf}.png", "rgb"),
         ("glTF metallicRoughness", f"tile-metallicRoughness{suf}.png", "rgb"),
         ("Unity Mask (RGBA)", f"tile-unity-mask{suf}.png", "rgb"),
         ("Height 16bit", f"tile-height-16bit{suf}.png", "gray16")]
CC, COLS = 340, 3
ROWS = (len(items) + COLS - 1) // COLS
GAP2, TOP2 = 14, 30
cv = Image.new("RGB", (COLS * CC + (COLS + 1) * GAP2, ROWS * (CC + TOP2) + GAP2), (12, 12, 14))
dd = ImageDraw.Draw(cv)
for i, (label, fn, kind) in enumerate(items):
    im = Image.open(rf"{OUT}\{fn}")
    if kind == "gray16":
        im = im.point(lambda v: v / 256).convert("L")
    im = im.convert("RGB").resize((CC, CC), Image.LANCZOS)
    x = GAP2 + (i % COLS) * (CC + GAP2)
    y = GAP2 + (i // COLS) * (CC + TOP2)
    cv.paste(im, (x, y + TOP2))
    dd.text((x + 3, y + 10), label, fill=(210, 210, 215))
cv.save(rf"{OUT}\{name}-material-maps.png")
print(f"-> {name}-material-maps.png", cv.size)
