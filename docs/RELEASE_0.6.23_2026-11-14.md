# 0.6.23 Context 显示与子线程隔离发布

CW 输入区显示 Context 剩余比例，详情列出最近上下文占用、模型窗口及剩余 token。Agent 保存最近用量以供快照与重连恢复；使用 last.totalTokens 而非累计消耗，百分比沿用 Codex TUI 的 12k 基线估算。未知用量或窗口显示未知。

Agent 与网页按 threadId 隔离子线程正文、生命周期与用量；网页对实时事件、历史分页和本机缓存恢复均做过滤，保留主线程中启动或等待子 Agent 的工具活动。

用户明确要求提交、部署并跳过 GitHub Actions。本次从干净源码本地构建，仅更新本机 coc-agent.service 与线上 CW 静态网页；网页专用部署复用 `.local/deploy-cloud/43241338652/deployment.json` 中已有 Worker 制品。此历史 CI 成功不代表本次修改通过 CI；本次 localBuild=true、ciVerified=false。不发布原生下载包或 GitHub Release，不更新 CLI，不触发自动更新通知。

功能验证：Vitest 42 个文件 / 490 项、完整浏览器 UI 回归、原生队列集成（主子线程通知隔离与重启恢复）、native-core、TypeScript、网页构建、协议一致性及相关 lint / 格式检查通过。桌面与手机截图见 `.local/ui-stability/cw-context-desktop.png` / `cw-context-mobile.png`。未调用真实模型。

部署脚本等待 Agent 空闲、备份原二进制并观察服务与中继连接 120 秒；网页脚本校验在线静态资源及 Worker 模块保全。部署结果完成后补充；原始证据保存在忽略目录 `.local/deploy-agent-0.6.23/` 和 `.local/deploy-cloud/`。
