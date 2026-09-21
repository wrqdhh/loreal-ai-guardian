# 数据集工具

三个 Node 脚本，全部**零第三方依赖**（PNG 编解码只用内置 `zlib`），装了 Node 就能跑。

| 文件 | 作用 |
|---|---|
| `tools/png.js` | 最小 PNG 编解码 |
| `tools/make_splices.js` | 构造四类样本 + mask + manifest |
| `tools/verify_dataset.js` | 校验 mask 与标注区域是否一致 |
| `tools/to_markdown.js` | 把源码逐个转成「同名 + `.md`」并生成 `INDEX.md` |

---

## tools/png.js

自己写而不是引第三方包，是因为项目其余部分都是零依赖、可离线跑的——数据集构造脚本也应该能在任何一台装了 Node 的机器上直接执行。

**支持范围**（刻意只做数据集用得到的子集）：

- 位深 8、非隔行
- 颜色类型 `0`(灰度) / `2`(RGB) / `3`(调色板) / `6`(RGBA)
- 解码统一输出 RGBA，编码输出 RGBA 或灰度

**不支持**：16 位深、隔行扫描、Alpha 以外的辅助块（会被忽略）。

### API

```js
var png = require('./png.js');

// 解码 → { width, height, data: Uint8Array(w*h*4) }
var img = png.decodePNG(fs.readFileSync('in.png'));

// 编码 → Buffer
var buf = png.encodePNG(w, h, rgbaUint8Array, grayscale /* true=灰度 */);
```

编码固定使用 filter `None` + `deflateSync(level 9)`：数据集图片不需要极致压缩率，解码速度和可预测性更重要。

---

## tools/make_splices.js

### 用法

```bash
node tools/make_splices.js                # 用 dataset/raw/ 下的真实素材构造
node tools/make_splices.js --seed 42      # 指定种子，保证可复现
node tools/make_splices.js --demo         # 无素材时用程序化素材跑通流程
```

**缺少素材时退出码为 2**，并打印需要准备什么。`--demo` 会先生成 3 张假「真实图」和 3 张假「AI 图」到 `dataset/raw/_demo_*/`，产出的样本全部标记 `synthetic: true`。

> `--demo` 只用来验证工具链没坏。它生成的样本**统计特性和真实照片完全不同**，拿去评测得到的数字没有意义。

### 构造逻辑

| 类别 | 做法 |
|---|---|
| `real_original` | 读真实图，限制最长边 1024（双线性缩放），原样输出 |
| `ai_plain` | 读 AIGC 图，同样限制最长边，原样输出 |
| `splice_ai_into_real` | 从 AIGC 图裁中心区域 → 缩放到目标尺寸 → 按羽化 mask 贴到真实底图上；同时输出 mask |
| `retouched_real` | 真实图 + 局部高斯模糊（半径 2，模拟磨皮）+ 全局提亮降对比（gain 0.92 / lift 12） |

贴片参数随机但可控：形状 `ellipse`/`rect` 二选一，尺寸为底图的 22%–38%，位置随机，边缘羽化 6px。羽化是为了避免留下肉眼可见的硬边——**如果人一眼就能看出拼接，这个样本就太简单了，测不出真实能力**。

### 关键常量

| 常量 | 值 | 含义 |
|---|---|---|
| `MAX_EDGE` | 1024 | 样本最长边，兼顾取证精度与文件体积 |
| `FEATHER` | 6 | 贴片边缘羽化像素数 |
| 默认种子 | 20260921 | 不传 `--seed` 时使用 |

### 可复现性

随机源是 `mulberry32`。**同一 seed + 同一素材 = 同一份数据集**，贴片的位置、形状、尺寸都一致。换素材后同一 seed 也会得到不同结果——seed 只锁定随机序列，不锁定素材。

---

## tools/verify_dataset.js

```bash
node tools/verify_dataset.js
```

只读 `dataset/manifest.json` 和里面的 mask，逐条比对 mask 的实际像素分布与 `region` 记录是否吻合：

- 面积占比：椭圆按 `外接矩形 × 0.785`（π/4）折算后比较，**相对误差 < 12%**
- 质心：mask 实际质心 vs region 中心，**偏移 < 8px**

全部通过输出 `VERIFY=PASS`，否则输出 `VERIFY=FAIL(n)`。

这一步的意义是防止「mask 和标注各说各话」。IoU 评测完全依赖 mask 的准确性，mask 错了，定位指标就是假的。

---

## tools/to_markdown.js

```bash
node tools/to_markdown.js
```

按 `image_tamper_detector-main-md/`（09-20 那批）的规则，把项目里的文本文件逐个转成 Markdown：

- 每个源文件产出 `<原文件名>.md`（如 `engine.js` → `engine.js.md`），源码放进围栏代码块
- 输出位置默认是**源码目录内的 `md/`**（目录结构一一对应），这样 md 与源码同属一个 git 仓库，
  推到 GitHub 后可直接在仓库里阅读；可用 `--out` 指定别处（如 `--out ../agent-md` 放回仓库外）
- 围栏长度自适应：取正文中最长连续反引号 + 1，至少 3 个
- 已是 `.md` 的文件原样复制；只存在于镜像目录的 `.md`（如 `docs/`）在索引里单列
- 二进制文件（PNG 等）跳过
- 镜像目录根部生成 `INDEX.md`，列出转换 / 复制 / 跳过三类条目

脚本可重复执行、结果覆盖。**改动源码后重跑一次才能保持镜像同步**——镜像是快照，不是链接。

---

## 常见问题

**Q：能否用 JPG 素材？**
当前只扫描 `.png`。JPG 会引入额外的压缩链路，污染 ELA 判据——数据集构造阶段应统一用无损 PNG。

**Q：为什么输出都是 PNG？**
同理。样本如果经过 JPEG 压缩，重压缩残差分析测到的就是构造过程本身，而不是伪造痕迹。

**Q：样本图可以人工再编辑吗？**
不建议。任何二次编辑都会改变压缩与噪声统计特征，让 ground truth 与图像实际状态脱节。需要新样本就改素材重新生成。
