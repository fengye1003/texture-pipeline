# -*- coding: utf-8 -*-
"""成品 1:1 体检：把「我的 1 个模数(256px)」与「源图 1 块砖(365px 缩到 256px)」并排，比石材尺度与通透度"""
from PIL import Image
albedo = Image.open(r"scripts\out\tile-albedo-stone.png").convert("RGB")
src = Image.open(r"scripts\src\stone-plate.png").convert("RGB")

# 我的：取单元内一块 1x1 模数的位置（x 0..256, y 0..256 落在某块砖内部）
mine = albedo.crop((0, 0, 512, 512)).resize((512, 512), Image.NEAREST)
# 源：取一块完整砖内部 365x365 → 缩到 365 保持 1:1 石材像素，再并排（同高 512 → 源放大到 512 会失真，故用 365 高）
src_tile = src.crop((520, 340, 520 + 365, 340 + 365))
canvas = Image.new("RGB", (512 + src_tile.width + 20, max(512, src_tile.height)), (16, 16, 18))
canvas.paste(mine, (0, 0))
canvas.paste(src_tile, (532, 0))
canvas.save(r"scripts\src\stone-scale-check.png")
print("-> src/stone-scale-check.png  (左=我的成品 512px=2 模数；右=源图一块砖 365px，两者 1:1 像素)")

# 定量：石材通透度（对比度）
import statistics
def stats(im, name):
    px = im.load(); W, H = im.size
    vals = sorted(0.299*px[x,y][0]+0.587*px[x,y][1]+0.114*px[x,y][2] for y in range(0,H,2) for x in range(0,W,2))
    n = len(vals)
    print(f"{name}: p05={vals[int(n*.05)]:.0f} p50={vals[n//2]:.0f} p95={vals[int(n*.95)]:.0f} 动态范围={vals[int(n*.95)]-vals[int(n*.05)]:.0f} 标准差={statistics.pstdev(vals):.1f}")
stats(src_tile, "源图一块砖(365px)   ")
stats(mine, "我的成品(512px=2模数)")
