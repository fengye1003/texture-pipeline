# -*- coding: utf-8 -*-
"""通用：任意图片（jpg/png/webp…）→ 裸 RGB + 尺寸 json
   用法：python import-image.py <输入图> <输出基名>
   输出：<基名>.rgb（RGB 顺序，8bit）+ <基名>.json（{w,h,mode,origin}）
   —— Node 端（make-seamless / make-material）只吃 .rgb，故这一步留在 Python（PIL 解码格式最全）。"""
import sys, json, os
from PIL import Image

if len(sys.argv) < 3:
    print("用法: python import-image.py <输入图> <输出基名>"); sys.exit(2)
inp, base = sys.argv[1], sys.argv[2]
im = Image.open(inp).convert("RGB")
W, H = im.size
open(base + ".rgb", "wb").write(im.tobytes())
json.dump({"w": W, "h": H, "mode": "RGB", "origin": os.path.basename(inp)},
          open(base + ".json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"[OK] {os.path.basename(inp)} -> {base}.rgb  {W}x{H}  ({W*H*3} bytes)")
