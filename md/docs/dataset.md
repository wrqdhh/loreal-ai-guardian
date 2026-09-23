# 数据集规范与标注

对应赛题要求中的第二项产出：「一批由 **AI 生成的高仿伪造内容样本**，用于在选定场景下测试或者评估 Agent」。

> 关键约束：**负样本必须真人拍摄。** 拿 AI 生成的图充当真实照片，评测跑出来的只是一个自欺欺人的好数字。

---

## 目录结构

```
dataset/
├── manifest.json          图像样本清单与 ground truth（索引文件）
├── README.md              样本构成与复现步骤
├── raw/                   原始素材（不直接参与评测）
│   ├── real/              真实相机照片 —— 负样本来源，必须真人拍摄
│   ├── ai/                AIGC 图片 —— 正样本来源，必须来自生成模型
│   └── _demo_*/           --demo 模式生成的程序化素材（synthetic=true，不得用于评测）
├── samples/               构造完成的样本图（评测实际读取）
├── masks/                 篡改样本的像素级 mask（灰度 PNG，贴片区=255）
└── text/
    └── text_set.json      文本侧样本与三维度标签
```

`raw/` 只放素材，评测读的是 `samples/`。两者分开是为了让「素材」和「构造结果」可分别追溯与替换。

---

## manifest.json 字段

顶层：

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | string | schema 版本，当前 `1.0` |
| `created` | ISO 时间 | 生成时间 |
| `generator` | string | 生成脚本，恒为 `tools/make_splices.js` |
| `seed` | int \| null | 随机种子，用于复现 |
| `synthetic` | bool | **整份数据集是否为程序化素材**。`true` 时评测结果不具参考价值 |
| `labels` | object | 标签语义说明 |
| `counts` | object | 各标签样本数 |
| `samples` | array | 样本条目 |

样本条目：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一标识，如 `splice_0007` |
| `image` | string | 相对 `dataset/` 的图片路径 |
| `category` | string | 四选一，见下表 |
| `label` | string | `authentic` / `ai_generated` / `tampered` |
| `synthetic` | bool | 该样本是否为程序化素材 |
| `width` / `height` | int | 尺寸 |
| `mask` | string? | 仅篡改类有，相对 `dataset/` 的 mask 路径 |
| `region` | object? | 贴片/处理区域 `{x, y, w, h, shape, feather}` |
| `source` / `donor` | string? | 素材溯源 |
| `text_case` | string? | 配套文本样本的 id（对应 `text/text_set.json` 的 `cases[].id`）。显式指定后评测才会做真正的图文配对，缺省则退回循环取模，详见 [benchmark.md](benchmark.md) |
| `note` | string? | 备注 |

**标签语义**（写死在 manifest 里，避免后人误读）：

- `authentic` —— 真实拍摄，未经合成替换（**可含美颜**）
- `ai_generated` —— 整幅由生成模型产出
- `tampered` —— 真实底图被拼接/替换过局部区域

---

## 四类图像样本

| category | 构造方式 | label | 有 mask | 评测作用 |
|---|---|---|---|---|
| `real_original` | 真实照片原样输出 | authentic | 否 | 测**误报**：真实内容不该被报警 |
| `retouched_real` | 真实照片 + 局部磨皮 + 提亮降对比 | authentic | 否 | 测**最难的一类误报**：美颜不是造假，但统计特征接近造假 |
| `ai_plain` | AIGC 图原样输出 | ai_generated | 否 | 测**召回**：纯生成内容必须抓到 |
| `splice_ai_into_real` | 真实底图上贴一块 AIGC 贴片（羽化边缘） | tampered | 是 | 测**定位**：不仅判对，还要标对位置 |

`retouched_real` 是刻意设计的压力项。美颜会同时压低噪声与色度信号——这正是引擎判断「AI 生成」的主要依据。如果这类样本被大量误报，说明检测器在真实场景里不可用。

`make_splices.js` 对每个真实图各生成一份 `retouched` 与一份 `splice`，因此**样本总数是素材数的 4 倍**（真实 N 张 + AIGC M 张 → N 张 real + M 张 ai + N 张 splice + N 张 retouch）。

---

## mask 规范

- 格式：8 位灰度 PNG（`colorType 0`），与样本图**同尺寸**
- 取值：贴片区域 `255`，其余 `0`（羽化带按 `a > 0.5` 二值化）
- 用途：与 Agent 标出的可疑区域算 IoU

`tools/verify_dataset.js` 会校验 mask 与 `region` 是否对得上，判据是**面积占比相对误差 < 12% 且质心偏移 < 8px**。当前实测：占比误差 6.0%–8.5%，质心偏移 0.7px。

---

## 文本集：text_set.json

三条判定维度，每条样本给出三个布尔标签：

| 维度 | 含义 |
|---|---|
| `ai_written` | 文案由大模型批量生成（句式整齐、缺少具体使用场景与个人瑕疵描述） |
| `ad_violation` | 含绝对化用语、医疗功效宣称或无依据的效果承诺 |
| `shill` | 评论区存在批量灌水、模板化好评、无具体细节的清一色称赞 |

样本条目字段：`id` / `scene` / `title` / `body` / `comments[]` / `labels{}`。

### 当前种子集（10 条）

| id | 标题 | ai_written | ad_violation | shill |
|---|---|:---:|:---:|:---:|
| `t_ai_foundation_01` | 这款粉底液真的改变了我的底妆 | ✔ | ✔ | ✔ |
| `t_ai_serum_02` | 抗老精华天花板，用过就回不去了 | ✔ | ✔ | ✔ |
| `t_ai_mask_03` | 补水面膜的最佳选择 | ✔ | ✔ | ✔ |
| `t_ai_lipstick_04` | 显白神器，素颜也能驾驭 | ✔ | — | ✔ |
| `t_human_foundation_05` | 用了快一个月，说说真实感受 | — | — | — |
| `t_human_serum_06` | 空瓶两支才敢来写 | — | — | — |
| `t_human_mask_07` | 便宜大碗但别指望太多 | — | — | — |
| `t_human_lipstick_08` | 踩雷了，说点不好听的 | — | — | — |
| `t_human_adlaw_09` | 这个真的能美白 | — | ✔ | — |
| `t_ai_sunscreen_10` | 防晒界的全能选手 | ✔ | — | ✔ |

其中 `t_human_adlaw_09` 是刻意的交叉项：**真人写的，但确实违规**——用来验证「文体检测」与「合规检测」两条链路互不干扰。

---

## 如何扩充

**图像侧**

1. 手机实拍 10–20 张 → `dataset/raw/real/`（PNG；JPG 请先转 PNG）
2. 通义万相 / SD / MJ 生成 10–20 张 → `dataset/raw/ai/`
3. `node tools/make_splices.js --seed 42`
4. `node tools/verify_dataset.js`
5. 确认 manifest 中 `synthetic: false`

**文本侧**

当前是**种子集**，规模不足以支撑结论。扩充建议：

- `ai_written=true`：用大模型批量生成，提示词里明确要求「整齐、正面、无具体场景」
- `ai_written=false`：**必须团队手写或合规采集的真实内容**，并在 `source` 字段注明来源
- 每类扩充到 **30 条以上**再出正式评测数字
- 标注完成后复核一遍：真人文案最容易出现的标注错误是「写得太规整被当成 AI」

**一条底线**：种子集里 `ai_written=false` 的条目目前是项目方刻意模拟的真人文风，正式评测前应替换为真实采集内容，否则「真人 vs AI」这道判断题实际上是在考我们自己写得像不像。

---

## 合规

- 素材仅限本人拍摄或本人生成的内容，不使用未授权的他人图片
- 不使用真实平台用户数据；若使用，须脱敏并取得授权
- 数据集仅用于本项目的评测与研究，不作为商业用途
