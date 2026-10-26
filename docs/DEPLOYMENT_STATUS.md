# 发布状态：0.5.11 + 管理表格与 CW 自动批准

更新时间：2026-10-26。网页、在线手册和构建缓存已更新；原生下载仍为已验证的 v0.5.11 四平台包。

## 当前网页与 Worker

- 源码 `1d2f526bfa13d103a58ab4a2d3c269842fe978fe`，管理表格和 CW 当前会话自动批准。开关默认关闭，显式启用后包含命令、文件及本轮额外权限；切换会话 / 刷新重置，原策略仍由服务器执行。
- [Actions 40326037786](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40326037786)：六个构建 / 回归作业通过，分支发布作业跳过。
- 生产 `https://r.xlogic.cc`；Worker `ec890616-6aa8-46f7-bfa7-bfe8029727e7`，`2026-10-26T13:02:48.210861Z` 上线，流量 100%。线上资源匹配同一提交的准备产物。
- Linux 编译和 musl 工具链缓存已启用；两轮 Actions 确认保存 / 恢复，实测 regression 构建 175→45 秒、musl 构建 / 测试 328→146 秒，详见 [缓存证据](assets/ci-cache-2026-10-26/verification.json)。

## 当前原生下载

- 源码 `59bb0debfd2d7c7d34acb286a744be9820e0c187`，不可变标签 `v0.5.11`。
- [Release v0.5.11](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.5.11)：Ubuntu 20.04、Debian 12、Linux musl、Windows x64、源码及 SHA256。本次网页部署未改写归档、清单或旧标签，在线手册已更新。
- 原生发行门禁：[Actions 40317904673](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40317904673) 七个作业通过。

## 验证与边界

本地 / CI 完整 E2E 验证管理审批和撤销、三类自动批准及权限 turn scope、目标隔离、断线去重和刷新 / 会话切换重置。UI 检查 1280 / 390 宽度表格、键盘滚动、短屏和双语；Vitest 86 项、类型、格式及构建通过。

线上 health、安全头、401 / 403、手册 UTF-8、全部资源 / 五个归档字节和公开 Chromium 页面检查通过。生产未提交凭据、创建授权或操作既有主机 / 会话，无真实模型调用；保留 vars、secrets、DO 数据和既有授权。实际模型任务与长期负载未在本次生产验证。

证据见 [测试记录](TEST_REPORT.md) 和 [部署元数据](assets/admin-tables-auto-approval-2026-10-26/deployment.json)。本机完整部署日志保存在忽略目录 `.local/admin-tables-deploy/`。发布证据另行提交，源码提交与原生标签保持不变。
