# 评测与指标

`benchmark.js` + `benchmark.html` 用 `dataset/` 里的测试数据给 Agent 打分量化的分。

与 `selftest.js` 的分工：`selftest` 回答「功能对不对」（22 项断言），`benchmark` 回答「效果有多好」（精确率、召回率、误报率、定位 IoU）。

---

## 运行

```bash
python -m http.server 8000
# 打开 http://127.0.0.1:8000/benchmark.html
```

**必须走 http。** `file://` 下浏览器禁止用 `fetch` 读取 `dataset/`，页面会直接报错。

深链接 `benchmark.html#benchmark` 会自动开跑，结果同时渲染到页面上。

---

## 三个评测维度

### 1. 图像级：内容是否被判为可疑（二分类）

以风险分是否达到阈值划分正负类：

| 指标 | 定义 |
|---|---|
| 精确率 P | 报警的样本中，真正有问题的比例 |
| 召回率 R | 有问题的样本中，被抓到的比例 |
| F1 | P 与 R 的调和平均 |
| 误报率 FPR | **真实内容被错判为可疑的比例**（`FP / (FP + TN)`） |
| 准确率 ACC | 全部样本判对的比例 |

正类 = `label` 不是 `authentic`（即 `ai_generated` 或 `tampered`）。

**误报率比准确率更值得看。** 这个 Agent 的用途是内容平台的风险筛查——误报意味着真实创作者的正常内容被打标，那是有实际代价的。

同时按 `category` 分组统计。**重点看 `retouched_real` 这一行的误报数**：美颜真实图被判可疑，说明检测器扛不住真实场景里最常见的干扰。

### 2. 区域级：篡改定位准不准

仅在带 mask 的 `splice_ai_into_real` 样本上计算。

把 Agent 输出的异常团块栅格化成与原图同尺寸的二值预测图（用 bbox 近似），与 ground truth mask 算 IoU：

```
IoU = 交集像素数 / 并集像素数
```

`IoU ≥ 0.30` 记为一次「定位成功」，报告 `meanIoU` 与 `hitRate`。

预测团块的选取有方向性：篡改区不一定都是低响应。当前策略是**先用 `elaLow` + `noiseLow` 团块，若为空再退回 `elaHigh` + `noiseHigh`**。AI 贴片通常比底图更干净（低噪声/低 ELA），但换背景、局部重绘可能相反，所以保留两个方向。

### 3. 文本级：三类判定各自的 P / R / F1

对 `text_set.json` 里每条样本跑文本取证，比对 `ai_written` / `ad_violation` / `shill` 三个标签。判错的话会在日志里输出 `TEXTMISS` 明细（含 `aiScore`），方便定位是阈值问题还是判据问题。

---

## 阈值与工作点

| 常量 | 值 | 说明 |
|---|---|---|
| `TH_HIGH` | 48 | 默认正类门槛，对应 Agent 的「高风险」档 |
| `TH_MID` | 26 | 「中风险」档，用于对照另一组工作点 |
| `IOU_HIT` | 0.30 | 定位成功线 |

改阈值只需在调用时传参：

```js
Benchmark.run({ threshold: 26, includeSynthetic: false })
```

**`threshold` 是工作点选择，不是精度调参。** 合规类判定刻意偏向召回——漏掉违规宣称会让创作者账号受罚，误报只是一次人工复核提示。这个取舍要在报告里写明，不然 0.8 的精确率会被读成能力不足。

---

## 自动化与导出

无头跑 + 抓结果（本项目验证就是这么做的）：

```bash
msedge --headless=new --virtual-time-budget=300000 --dump-dom \
  "http://127.0.0.1:8000/benchmark.html#benchmark"
```

结果写进隐藏的 `<pre id="benchmark-output">`，从 DOM 里找 `BENCH_BEGIN` / `BENCH_END` 之间的行即可。日志格式：

```
DATASET total=… evaluated=… skipped_synthetic=… synthetic=…
IMAGE th=… TP=… FP=… TN=… FN=… P=… R=… F1=… ACC=… FPR=…
  CAT=<category> n=… correct=… falseAlarm=… miss=…
LOCAL n=… meanIoU=… hit=… hitRate=…
TEXT ai_written P=… R=… F1=…
ROW <id> cat=… truth=… pred=… score=… sig=[…] iou=… clusters[…] OK/MISS
TEXTMISS <id> dim=… truth=… pred=… aiScore=…
```

完整报告对象挂在 `window.__benchmarkReport`，包含 `report.rows` 与 `report.textRows` 全量明细，可直接取出来导出 JSON。

`synthetic=true` 的数据集会在日志首行打 `WARN`，提醒这批数字不代表真实检测能力。

---

## 当前基线

文本侧（种子集 10 条）：

| 维度 | P | R | F1 |
|---|---|---|---|
| ai_written | 0.833 | 1.000 | 0.909 |
| ad_violation | 0.800 | 1.000 | 0.889 |
| shill | 0.833 | 1.000 | 0.909 |

图像侧：**没有任何可信数字。** 现有素材是程序化的（真实图误报率 100%、定位 IoU = 0）。这不是算法结论，只说明合成素材的统计特性和真实照片不一样。

**读这组数字时有三点必须清楚：**

1. **样本量太小。** 阈值是在这 10 条上调出来的，属于同分布自评。需要每类 30 条以上、且标注来源独立，才能算有效评测。
2. **合规维度刻意偏向召回**，见上节。
3. **不能对着程序化素材调阈值。** 那样调出来的是对合成噪声的拟合，换真图就崩。真实素材到位前，图像侧的一切数字都不应写进参赛材料。
