# texture-pipeline

**从一张照片/参考图，到一套可平铺的 PBR 材质。** 零依赖（Node + Python/Pillow），全部脚本自带校验。

> Photo/pattern → **seamless** → complete **PBR maps** (albedo / normal / roughness / metallic / AO / height)
> + packed `ORM` / `glTF metallicRoughness` / `Unity Mask`, plus a **software-rendered material ball** preview.
> Zero dependencies beyond Node ≥ 18 and Python 3 + Pillow.

---

## 它能做什么（一句话验收）

| 输入 | 输出 | 验收判据（脚本自动算） |
|---|---|---|
| 一张**随机纹理**照片（水磨石、斑点石、木纹、水泥…） | 严格无缝的完整 PBR 贴图集 + 材质球预览 | 接缝跳变 ÷ 内部跳变 **< 1.6**；打包通道逐通道求差 **= 0**；法线单位长度偏差 **< 0.03** |
| 一张**规则图案**参考图（编纹砖、人字拼、格栅…） | 同款图案的严格无缝 PBR 贴图集（几何逐像素还原） | 平移一个周期后 30 万随机点采样差异 **= 0**；与原图线掩膜比对命中率 > 90% |

---

## 快速开始（30 秒，用仓库自带的自制样例）

```bash
git clone <this-repo> && cd texture-pipeline

# ① 任意图片 → 裸 RGB（jpg/png/webp 都行）
python scripts/import-image.py examples/sample-speckle.png examples/sample-speckle

# ② 无缝化（对折偏移 + 补丁匹配 + 泊松无缝克隆；自带接缝自检）
node scripts/make-seamless.mjs --in examples/sample-speckle.rgb --w 512 --h 512 --band 64 --out out/sample
#   → out/sample.png / .rgb / .json（json 里含 seamBefore / seamAfter）

# ③ 无缝底色 → 完整 PBR 贴图集
node scripts/make-material.mjs --in-png out/sample.png --suf -sample --name sample --rough-base 0.40

# ④ 校验（打包通道 / 法线长度 / 尺寸）
python scripts/verify-maps.py -sample          # 期望输出 [ALL PASS]

# ⑤（可选）材质球 + 实景地面预览（自写软件 PBR 渲染器，无需任何 3D 软件）
node scripts/render-material-ball.mjs --suf -sample --size 900 --ss 2
```

实测（512×512 自制样例）：接缝跳变 **1.10× / 4.00× → 0.93× / 1.04×**，`verify-maps` 全绿。
样例带一道人工光照渐变，想顺便试试压平：给第 ② 步加 `--flatten 0.6`。

---

## 两条流水线

### A. 随机纹理：照片 → 无缝 → 完整 PBR

```
原图 ──import-image.py──► 裸 RGB
     ──make-seamless.mjs─► 严格无缝（中心裁方 → 对折偏移半张 → 补丁匹配 + 泊松克隆 → 自检）
     ──make-material.mjs─► albedo / normal(GL+DX) / roughness / metallic / AO / height16
                            + ORM / metallicRoughness / unity-mask（三套打包）
     ──render-material-ball.mjs─► 材质球 + 实景地面预览（软件 PBR 渲染）
     ──verify-maps.py────► 打包与法线校验
```

**为什么对折偏移能无缝**：把图对折平移半张后，**图像的四条外边界天然连续**了（原来的左右边贴到了一起，而它们在原图里本来就是相邻像素）；只剩中线那两条缝要补。
**为什么不用 AI 补全**：AI 会生成"另一种随机分布"，且保证不了无缝 —— 实测 AI 生图的接缝跳变是 **1.92× / 2.61×**（见 `docs/03-pitfalls.md` P9）。

### B. 规则图案：参考图 → 精确几何 → 无缝 PBR

```
参考图 ──pattern/analyze.py──────► 配色 + 网格线位置 + 模数
      ──pattern/extract-edges.py─► 逐格「这条边有没有线」→ 边矩阵 → 最小重复周期
      ──pattern/reconstruct.py───► 合并成矩形块 → 块布局 → 与原图线掩膜比对命中率
      ──make-texture.mjs─────────► 按周期程序化重建（缝宽/倒角/槽底/法线强度/色调全参数化）
```

---

## 目录

```
scripts/
├─ lib/png.mjs                 共享 PNG 编解码（编码 rgb/rgba/gray/gray16；解码 8/16bit）
├─ import-image.py             任意图片 → 裸 RGB + 尺寸 json
├─ make-seamless.mjs           ★ 照片 → 严格无缝（自带接缝自检）
├─ make-material.mjs           ★ 无缝底色 → 完整 PBR 贴图集（含三套打包）
├─ render-material-ball.mjs    ★ 软件 PBR 渲染器（Cook-Torrance GGX）→ 材质球 / 实景地面
├─ verify-maps.py              打包通道 / 法线长度 / 尺寸 校验
├─ inspect-image.py            图片体检（光照均匀度、配色、当前可平铺性）
├─ measure-joint-ref.py        从实铺照片量「缝宽/模数比例 + 砖面与缝的配色」
├─ measure-joint-core.py       量「缝芯」颜色（取芯，避开抗锯齿混色）
├─ diag-scale.py               1:1 像素并排，核对纹理尺度
├─ build-tone-lut.py           参考图 ↔ 源图 的逐通道直方图匹配 LUT
├─ pattern/                    规则图案几何解算三件套
├─ figures/                    交付用对比图 / 总览图 / 缝带宽度实测
└─ relay/                      可选：调用 OpenAI 兼容中转站生图（需自配 relay.local.json）
docs/
├─ 01-pipeline.md              完整工序与原理
├─ 02-pattern-extraction.md    规则图案的几何解算
├─ 03-pitfalls.md              ★ 踩坑表（编号，可单独引用）
└─ 04-verification.md          验收清单（怎么证明"无缝"和"打包正确"）
examples/
├─ make-sample.py              生成自制样例（固定随机种子）
└─ sample-speckle.png          自制样例纹理（MIT，随仓库授权）
```

---

## 设计约定

1. **能测的就不靠眼睛**：所有"看起来对"的结论都配一个可计算的判据（接缝比值、通道求差、法线长度、周期一致性）。
2. **单一真源**：PNG 编解码只有 `scripts/lib/png.mjs` 一份；贴图命名统一 `tile-<通道><后缀>.png`，所以校验/渲染/出图脚本能互相直接复用。
3. **不改原图**：整条链只读输入、只写 `out/`，随时可重跑。
4. **法线强度是物理量**：`--bump` = **高度范围(mm) ÷ 单像素世界尺寸(mm)**，不是随手给的数（见 `docs/03-pitfalls.md` P1）。

---

## 适用范围与边界（如实说）

- **适用**：轴对齐的重复图案；随机/半随机纹理；平面材质（地砖、石材、水磨石、水泥、木纹）。
- **不适用**：斜向/曲线缝隙的图案；有强透视或曲面拍摄的照片；需要真实几何置换的高起伏表面。
- **经验性映射**：`make-material.mjs` 里的"高度/粗糙度 ← 图像"是**经验映射 + 可调参数**，不是物理反演；文档里都标了。
- 仓库**不含任何第三方素材**：`examples/` 里的样例是脚本生成的（MIT）。

## 许可

MIT（见 `LICENSE`）。样例纹理由 `examples/make-sample.py` 生成，同样随仓库以 MIT 授权。

## 关于本仓库

由 **星澄（Hoshino Sumi）** 在与业主的协作中写成：需求、验收与取舍由人定，实现、测量与文档由 Agent 完成；**所有"实测"数字都可在本仓库复现**。配套长文：**[从一张照片到可用的建筑材质：Agent 的纹理模式提取与无缝化流水线](https://eachother.work/zhe-teng-bi-ji-jiao-xue-xiang-cong-yi-zhang-zhao-pian-dao/)**
