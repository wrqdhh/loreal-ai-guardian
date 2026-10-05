# 项目长期笔记 · TrustGuardian（内容核验 Agent）

天池 / 欧莱雅第二届美妆科技黑客松 · 赛题二「信任守护师」。纯前端、零第三方依赖、可离线，
图像取证在浏览器 Canvas 中完成，无后端无模型。分层：`engine.js` 只出证据，`agent.js` 做价值判断。

## 项目约定

- **`md/` 是 `to_markdown.js` 生成的快照镜像，不是链接。** 改动任何源码或 README.md 后，
  必须跑 `node tools/to_markdown.js` 重新同步，否则镜像与源码脱节。
- 源码目录只放代码与数据，全部 Markdown 集中在 `md/`（含 README 副本与三篇 docs）。
- 分层原则：取证算法可整体替换为训练好的模型，`agent.js` 不需要跟着改。
- 数据集诚信底线：负样本必须真人拍摄，AIGC 图必须来自生成模型；`synthetic: true` 的数据集不得计入评测指标。

## 本机环境要点（踩过坑）

- **Bash 工具的 PATH 是坏的**（`dirname: command not found`），每条命令都要先
  `export PATH="/usr/bin:/bin:$PATH"` 才能用 ls/node/grep 等。
- **后台进程不跨 Bash 调用存活**。起 http server + 跑无头浏览器必须写在**同一条命令**里，
  否则第二次调用时服务已死，Edge 只会 dump 出 connection error 页面。
- 可用运行时：python `C:/Users/18022/.workbuddy/binaries/python/versions/3.13.12/python`；
  Edge `/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`。
- 端到端验证套路（改了浏览器侧逻辑就该跑一次）：
  ```
  python -m http.server 8123 & SRV=$!; sleep 2
  msedge.exe --headless=new --disable-gpu --no-sandbox --user-data-dir=<tmp> \
    --virtual-time-budget=240000 --dump-dom "http://127.0.0.1:8123/benchmark.html#benchmark" > dump.html
  kill $SRV
  ```
  结果在 `BENCH_BEGIN` / `BENCH_END` 之间；`index.html#selfcheck` 同理抓 `SELFCHECK_BEGIN`。
- Node 侧跑不了图像取证（依赖 Canvas），`selftest.js` 只覆盖元数据 / 文本 / 交叉 / 融合，
  所以它的档位预期与页面端到端实测**不同源**，不要拿它校验页面结果。

## 关键阈值（改动前先看清依据）

- 复制-移动平坦块过滤 `varr < 400`：2026-09-23 实测标定。取 100 时 12 张里 9 张误报（合成图周期纹理），
  取 900 只剩 5~7 个候选块、检出能力过弱。**换数据分布必须重新标定。**
- 异常块几何过滤：填充率 ≥ 0.45、面积占比 ≤ 32%。
- 噪声检测平坦度掩膜：局部梯度 ≤ 全图中位 × 2.2。
- 定级：≥70 极高 / ≥48 高 / ≥26 中 / <26 低。

## 发布链路（2026-09-23 确认）

- 远端仓库：`https://github.com/wrqdhh/loreal-ai-guardian`（public，默认分支 `main`）。
- GitHub Pages 从 **main 分支根目录**部署（无 `.github/workflows`），站点
  `https://wrqdhh.github.io/loreal-ai-guardian/`。push 后自动重建，约 1~3 分钟生效。
- 校验线上是否已生效：比对字节数
  `wc -c < 本地文件` vs `curl -s "https://wrqdhh.github.io/loreal-ai-guardian/<file>" | wc -c`；
  或用 `curl -s .../engine.js | grep -n varr` 看关键行。
  **注意别 grep `2500`**——那是注释里提的「早期版本取值」，会误判成未更新。
- 用户嫌 VSCode 提交慢，改用 PowerShell 走 git 命令；中文 commit message 用
  `git -c i18n.commitEncoding=UTF-8 -c i18n.logOutputEncoding=UTF-8 commit -m "..."` 防乱码。
- VSCode 慢的排查结论（2026-09-23）：仓库本身很小（60 文件、.git 12M、dataset 17M），
  **瓶颈不是仓库大小，是 VSCode 默认 push/autofetch 打 github.com 的网络延迟**。
  可关闭 `git.autofetch`、`git.autorefresh`、`git.untrackedChanges` 缓解。

## 本机环境补充坑（2026-10-05 实测，比上面几条更优先）

- **Bash 的 `cd` 会失效**（报 `cd: null directory`），「先 cd 再起服务」的旧写法不再可靠。
  改用 `python -m http.server <port> --bind 127.0.0.1 --directory "<绝对路径>"`，
  完全不依赖工作目录。一个 server 可以连着跑多个 URL 的 dump，不必反复起停。
- **环境里有 HTTP 代理，连 localhost 也会被拦**：curl 不带参数返回 502，Edge 会 dump 出 0 字节。
  curl 加 `--noproxy '*'`，Edge 加 `--no-proxy-server`。
- **PowerShell 工具在本机不回显 stdout**（exit 0 但无输出），排查取数一律走 Bash。

## UI 约定（2026-10-05）

- 品牌图标是内联 SVG（`.mark` 里直接嵌），别换成外链图片或 iconfont —— 零依赖是项目招牌之一。
- 右栏底部 `#cover`「检测覆盖矩阵」是常驻卡，**不属于 `#output`**，
  所以 selfcheck 里 `CARDS`（统计 `#output > .card`）不会因它变化。
- 覆盖矩阵强弱分界是 `severity × confidence ≥ 0.30`。这条不能省，
  否则 `meta-noexif`（EXIF 缺失，0.17）会被标成红色命中，把用户往错的方向引。
- 新增/改动检测器时，`app.js` 里 `CHECKS` 的 `ids` 必须同步 —— 它俩不同源，会静默漂移。
- 左栏 `#history`「核验历史」、右栏 `#ask`「追问助手」也是常驻卡，不在 `#output` 内。
  历史只存摘要（分数/等级/证据 id），不存图片与原文；selfcheck 用 `window.__tgNoHist` 跳过写入。

## 可复现性（2026-10-05 确立，动 samples.js 前必看）

- **演示样本必须确定性生成。** `samples.js` 的 `addNoise()` 原先用 `Math.random()`，
  同一张示例图每次都不一样，splice 样本分数在 57↔75 之间漂。现已改为 mulberry32 + 固定 seed
  （base 720540 / patch 230190 / clean 101），并支持 `?seed-xxx=N` 覆盖。
  **任何样本构造代码里都不要再用 `Math.random()`。**
- ELA 高响应判据 `clusterAnomalies(z,bw,bh, 1, 2.5, 8, 0.45, 0)` 的 areaMax 传的是 0（不限面积），
  与文档写的「面积上限 32%」不一致——那条只用于噪声与 ELA 低响应分支。
  实测对合成样本约 1/3 的随机种子会误报（6 组 seed 中 2 组把正常内容判成 40 分中风险）。
  **z>2.5 + 连通≥8 块这组门槛待真实素材到位后重新标定。**
- `agent.js:241,271` 仍有 `Math.random()*40`，只用于 trace 的模拟耗时显示，不影响分数，暂未处理。
