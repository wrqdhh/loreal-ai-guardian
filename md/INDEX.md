# agent → Markdown 转换结果

源目录：`agent/`　本目录：`md/`（目录结构一一对应）

每个文本文件产出「同名 + `.md`」，源码放进围栏代码块；
已是 markdown 的文件原样复制；二进制文件（PNG 图片）不转换。

生成方式：`node tools/to_markdown.js`（可重复执行，结果覆盖）

统计：转换 15 个 · 原样复制 5 个 · 跳过 21 个

| # | 源文件 | 转换后 | 语言 | 大小 | 行数 |
|---:|---|---|---|---:|---:|
| 1 | `.gitignore` | [`.gitignore.md`](.gitignore.md) | gitignore | 216 B | 15 |
| 2 | `agent.js` | [`agent.js.md`](agent.js.md) | javascript | 18791 B | 366 |
| 3 | `app.js` | [`app.js.md`](app.js.md) | javascript | 31326 B | 615 |
| 4 | `benchmark.html` | [`benchmark.html.md`](benchmark.html.md) | html | 5176 B | 126 |
| 5 | `benchmark.js` | [`benchmark.js.md`](benchmark.js.md) | javascript | 15227 B | 338 |
| 6 | `dataset/manifest.json` | [`dataset/manifest.json.md`](dataset/manifest.json.md) | json | 4600 B | 187 |
| 7 | `dataset/text/text_set.json` | [`dataset/text/text_set.json.md`](dataset/text/text_set.json.md) | json | 8123 B | 154 |
| 8 | `engine.js` | [`engine.js.md`](engine.js.md) | javascript | 42612 B | 786 |
| 9 | `index.html` | [`index.html.md`](index.html.md) | html | 15801 B | 305 |
| 10 | `samples.js` | [`samples.js.md`](samples.js.md) | javascript | 11575 B | 282 |
| 11 | `selftest.js` | [`selftest.js.md`](selftest.js.md) | javascript | 7975 B | 153 |
| 12 | `tools/make_splices.js` | [`tools/make_splices.js.md`](tools/make_splices.js.md) | javascript | 15279 B | 381 |
| 13 | `tools/png.js` | [`tools/png.js.md`](tools/png.js.md) | javascript | 5746 B | 165 |
| 14 | `tools/to_markdown.js` | [`tools/to_markdown.js.md`](tools/to_markdown.js.md) | javascript | 7091 B | 180 |
| 15 | `tools/verify_dataset.js` | [`tools/verify_dataset.js.md`](tools/verify_dataset.js.md) | javascript | 1438 B | 29 |

## 原样复制（已是 markdown）

| 文件 | 大小 | 行数 |
|---|---:|---:|
| [`README.md`](README.md) | 13966 B | 273 |
| [`dataset/README.md`](dataset/README.md) | 6359 B | 157 |
| [`docs/benchmark.md`](docs/benchmark.md) | 5858 B | 138 |
| [`docs/dataset.md`](docs/dataset.md) | 7317 B | 152 |
| [`docs/tools.md`](docs/tools.md) | 5418 B | 128 |

## 跳过（二进制）

共 21 个图片文件，未转换。
