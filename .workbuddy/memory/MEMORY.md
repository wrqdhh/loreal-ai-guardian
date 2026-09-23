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
