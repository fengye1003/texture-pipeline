# -*- coding: utf-8 -*-
"""生成一个**自制**的样例纹理（斑点石材风），用于仓库开箱即跑。
   —— 刻意做成"不可平铺"且带轻微光照渐变，好让流水线有活干（无缝化 + 压平光照）。
   输出：examples/sample-speckle.png
   用法：python examples/make-sample.py            （默认 512x512，固定随机种子，可复现）
        python examples/make-sample.py 1024         （自定义边长）
"""
import sys, math, random
from PIL import Image

S = int(sys.argv[1]) if len(sys.argv) > 1 else 512
random.seed(20260928)                     # 固定种子 ⇒ 每次生成完全一样，便于对照

BASE = (168, 160, 148)                    # 米灰基体
DARK = (108, 88, 66)                      # 褐色斑点
LIGHT = (206, 202, 194)                   # 浅色颗粒

img = Image.new("RGB", (S, S), BASE)
px = img.load()

# ① 细颗粒噪声（基体本身的质地）
for y in range(S):
    for x in range(S):
        n = random.randint(-10, 10)
        r, g, b = BASE
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))

# ② 斑点：多尺度椭圆，随机朝向（模拟破碎骨料）
def blob(cx, cy, rx, ry, rot, color, alpha):
    ca, sa = math.cos(rot), math.sin(rot)
    R = int(max(rx, ry)) + 2
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            u = dx * ca + dy * sa
            v = -dx * sa + dy * ca
            d = (u / rx) ** 2 + (v / ry) ** 2
            if d > 1.0:
                continue
            w = min(1.0, (1.0 - d) * 2.2) * alpha      # 边缘柔化
            X, Y = (cx + dx) % S, (cy + dy) % S        # 环绕写入（保证生成图本身没有硬边界）
            r, g, b = px[X, Y]
            px[X, Y] = (round(r * (1 - w) + color[0] * w),
                        round(g * (1 - w) + color[1] * w),
                        round(b * (1 - w) + color[2] * w))

for _ in range(int(S * S * 0.012)):                    # 大斑
    blob(random.randrange(S), random.randrange(S), random.uniform(3, 9), random.uniform(2, 6),
         random.uniform(0, math.pi), DARK, random.uniform(0.35, 0.9))
for _ in range(int(S * S * 0.02)):                     # 小斑
    blob(random.randrange(S), random.randrange(S), random.uniform(1.2, 3), random.uniform(1, 2.4),
         random.uniform(0, math.pi), random.choice([DARK, LIGHT]), random.uniform(0.2, 0.6))

# ③ 加一道轻微的光照渐变（模拟拍歪/打光不均）——用来演示 --flatten
for y in range(S):
    k = 1.0 + 0.16 * (y / S - 0.5) * 2
    for x in range(S):
        r, g, b = px[x, y]
        px[x, y] = (min(255, round(r * k)), min(255, round(g * k)), min(255, round(b * k)))

img.save("examples/sample-speckle.png")
print(f"[OK] examples/sample-speckle.png  {S}x{S}（自制、MIT 随仓库授权；刻意不可平铺 + 带光照渐变）")
