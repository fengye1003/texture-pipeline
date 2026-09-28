# -*- coding: utf-8 -*-
"""生成「完整材质总览图」：把各张贴图拼成一张带标签的图，方便一眼看全"""
from PIL import Image, ImageDraw

import sys
D = sys.argv[1] if len(sys.argv) > 1 else "out"
suf = sys.argv[2] if len(sys.argv) > 2 else "-stone"
CELL = 340

items = [
    ("albedo (sRGB)", f"tile-albedo{suf}.png", "rgb"),
    ("normal (OpenGL)", f"tile-normal-opengl{suf}.png", "rgb"),
    ("Roughness", f"tile-roughness{suf}.png", "rgb"),
    ("AO", f"tile-ao{suf}.png", "rgb"),
    ("Metallic (all 0)", f"tile-metallic{suf}.png", "rgb"),
    ("ORM  R=AO G=Rough B=Metal", f"tile-orm{suf}.png", "rgb"),
    ("glTF metallicRoughness", f"tile-metallicRoughness{suf}.png", "rgb"),
    ("Unity Mask (RGBA)", f"tile-unity-mask{suf}.png", "rgb"),
    ("Height 16bit", f"tile-height-16bit{suf}.png", "gray16"),
]
COLS = 3
ROWS = (len(items) + COLS - 1) // COLS
GAP, TOP = 14, 30
W = COLS * CELL + (COLS + 1) * GAP
H = ROWS * (CELL + TOP) + GAP
canvas = Image.new("RGB", (W, H), (12, 12, 14))
d = ImageDraw.Draw(canvas)
for i, (label, fn, kind) in enumerate(items):
    im = Image.open(rf"{D}\{fn}")
    if kind == "gray16":
        im = im.point(lambda v: v / 256).convert("L")
    im = im.convert("RGB").resize((CELL, CELL), Image.LANCZOS)
    cx = GAP + (i % COLS) * (CELL + GAP)
    cy = GAP + (i // COLS) * (CELL + TOP)
    canvas.paste(im, (cx, cy + TOP))
    d.text((cx + 3, cy + 10), label, fill=(210, 210, 215))
canvas.save(rf"{D}\preview-material-maps{suf}.png")
print("->", rf"{D}\preview-material-maps{suf}.png", canvas.size)
