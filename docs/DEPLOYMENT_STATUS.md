# 发布状态：0.5.12 + 管理列表同步修复

更新时间：2026-10-27。Worker 与在线手册已更新，原生下载沿用已验证的 v0.5.12 四平台包。

## 当前 Worker 与网页

- 源码 `ea659cf9f76afa97321f9f3aee60d15339f0e883`，管理操作和手动刷新统一等待设备 / Key / 主机快照，避免通知漏失时已授权设备与唤醒列表不一致；同时包含 DO 通知优化及独立的旧协议主机过滤修复。
- [Actions 40435416363](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40435416363)：regression、sanitizers、Ubuntu 20.04、Debian 12、musl 和 Windows x64 六个检查作业全部成功；分支发布作业跳过。
- 生产 `https://r.xlogic.cc`；Worker `c92768d5-ac11-4c3b-9c79-15ad92499a7e` 于 `2026-10-27T02:02:33.382219Z` 上线，流量 100%。
- 更新网页入口、新 JS 和在线手册，CSS 复用；保留生产 vars / secrets 和 DO 数据，无新增迁移。本次未发布新原生版本或发送新版本通知。

## 当前原生下载

- 源码 `3b41fce53a89707c281f7b27683369383fc620ea`，标签 [v0.5.12](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.5.12)。
- Ubuntu 20.04、Debian 12、Linux musl、Windows x64、源码及 SHA256 保持已发布内容。归档从 GitHub Release 获取并在前次 DO 优化部署前与原线上校验和逐一核对；本次继续复用相同内容。
- 原生发行门禁：[Actions 40343777576](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40343777576) 七个作业成功。

## 验证与边界

本地 Vitest 95 项、类型、lint、Worker dry-run 和 Chromium 丢通知下的管理同步回归通过；源码 CI 包含真实 Wrangler / Chromium 完整回归。线上 health、401 / 403、首页 CSP、HTML / JS / CSS / 手册 / 下载清单与 SHA256 字节、手册 UTF-8 和五个归档 HEAD 通过。用户确认生产同名主机刷新后恢复一致，未将其认定为旧协议记录；未提交生产凭据或操作用户设备 / 会话，无模型调用。

实际平台基线已采集，见 [DO 用量分析](do-usage-2026-10-27.md)。本次优化后的请求 / duration / 行读取收益和真实 24 小时受控验收仍待测量，不以旧基线证明新版本节费。

证据见 [测试记录](TEST_REPORT.md)、[部署与 CI](assets/admin-snapshot-fix-2026-10-27/deployment.json) 和 [线上验证](assets/admin-snapshot-fix-2026-10-27/online-verification.json)。完整本机部署日志在忽略目录 `.local/admin-snapshot-fix/`。
