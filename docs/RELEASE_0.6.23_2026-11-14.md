# 0.6.23 Context 显示与子线程隔离发布

CW 输入区显示 Context 剩余比例，详情列出最近上下文占用、模型窗口及剩余 token。Agent 保存最近用量以供快照与重连恢复；使用 last.totalTokens 而非累计消耗，百分比沿用 Codex TUI 的 12k 基线估算。未知用量或窗口显示未知。

Agent 与网页按 threadId 隔离子线程正文、生命周期与用量；网页对实时事件、历史分页和本机缓存恢复均做过滤，保留主线程中启动或等待子 Agent 的工具活动。

用户明确要求提交、部署并跳过 GitHub Actions。本次从干净源码本地构建，仅更新本机 coc-agent.service 与线上 CW 静态网页；网页专用部署复用 `.local/deploy-cloud/43241338652/deployment.json` 中已有 Worker 制品。此历史 CI 成功不代表本次修改通过 CI；本次 localBuild=true、ciVerified=false。不发布原生下载包或 GitHub Release，不更新 CLI，不触发自动更新通知。

功能验证：Vitest 42 个文件 / 490 项、完整浏览器 UI 回归、原生队列集成（主子线程通知隔离与重启恢复）、native-core、TypeScript、网页构建、协议一致性及相关 lint / 格式检查通过。桌面与手机截图见 `.local/ui-stability/cw-context-desktop.png` / `cw-context-mobile.png`。未调用真实模型。

部署脚本等待 Agent 空闲、备份原二进制并观察服务与中继连接 120 秒；网页脚本校验在线静态资源及 Worker 模块保全。原始证据保存在忽略目录 `.local/deploy-agent-0.6.23/` 和 `.local/deploy-cloud/`。

## 已完成部署

- 源码提交：`edc7beeab9db6573dedb2e0e31757a1919764f07`，版本 `0.6.23`，源码干净。
- 源码摘要：`3461ff2dd46ac0d56c22b52a31494a7ad0ad56dfb90a217f205e48aff63819a1`。
- GitHub Actions 按用户要求跳过，无本次 Actions URL；未推送源码。
- 本机 Agent SHA256：`08f9947106b2ce6d7688febc8bc736a238d4dc9f36e87170606339a7f87ef31f`；部署前空闲，备份原程序，安装后 120 秒核验通过，服务 PID 稳定且中继握手成功。回读运行版本、commit 与源码摘要一致，保留配置、凭据和数据库。
- CW 目标：`https://r.xlogic.cc`；Cloudflare 版本：`eeb8b853-2a68-40c8-b40e-7c032e74d5d1`。
- 网页专用发布前后 Worker 模块逐字节一致，`verifiedAfterDeploy=true`；原 Worker `index.js` SHA256：`109b151b7305b0548d5e92a2a2404c0de3a6416b88cb8b2c1396fc393016d235`。保留变量、Secret、Access、KV、DO 及原生下载。
- 首页、全部静态资源、主题、在线手册及下载清单逐字节核验通过，`publicAssetBytesMatch=true`。健康接口 `ok=true`，版本仍为被保留的 Worker `0.6.20`，协议 1；网页和本机 Agent 为 `0.6.23`。
- 首次网页预检查因 OAuth 过期返回 401，未发布；使用 `wrangler whoami` 刷新现有登录后，同一命令部署与核验成功。

命令：

```bash
python3 scripts/deploy-agent.py --local --local-build --binary /home/ubuntu/.local/bin/coc-agent --output .local/deploy-agent-0.6.23 --apply
python3 scripts/deploy-cloud.py --local-build --commit edc7beeab9db6573dedb2e0e31757a1919764f07 --target production --web-only-from .local/deploy-cloud/43241338652/deployment.json --apply
```

静态资源 SHA256：

| 资源                        | SHA256                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| `index.html`                | `5b69207cb4401913ac6e5b2282391c0aa8b5248f53e6ce60d88f1be47d61f255` |
| `assets/index-C5jypYWG.js`  | `b9d2bbdd51a1d78f837ccca28dfaad5e123492d1f5b09add693832a30fad7cc2` |
| `assets/index-6-GeYzcv.css` | `fed73214a983e18a9bbc9d31176b3ca4cb16e30087948d13f7ffb3e34e0590a4` |
