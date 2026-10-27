# 发布状态：0.5.12 + DO 通知与迁移读取优化

更新时间：2026-10-27。Worker 与在线手册已更新，原生下载沿用已验证的 v0.5.12 四平台包。

## 当前 Worker 与网页

- 源码 `08d0ff46606d4c74b3517e088af95f4b9cb72838`，Registry 通知仅送受影响主机，已完成到期迁移不再在每次请求中重复读取完成标记。
- [Actions 40431197988](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40431197988)：regression、sanitizers、Ubuntu 20.04、Debian 12、musl 和 Windows x64 六个检查作业全部成功；分支发布作业跳过。
- 生产 `https://r.xlogic.cc`；Worker `df318752-ee2e-4e23-9b43-3914baadf5cb` 于 `2026-10-27T01:17:29.296851Z` 上线，流量 100%。
- 网页 JS / CSS 复用原内容，在线手册更新；保留生产 vars / secrets 和 DO 数据，无新增迁移。本次未发布新原生版本或发送新版本通知。

## 当前原生下载

- 源码 `3b41fce53a89707c281f7b27683369383fc620ea`，标签 [v0.5.12](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.5.12)。
- Ubuntu 20.04、Debian 12、Linux musl、Windows x64、源码及 SHA256 保持已发布内容。本次从 GitHub Release 获取归档并与原线上校验和逐一核对后复用；Wrangler 仅上传了更新后的手册。
- 原生发行门禁：[Actions 40343777576](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40343777576) 七个作业成功。

## 验证与边界

本地 Vitest 94 项、类型、lint 和 Worker dry-run 通过；源码 CI 包含真实 Wrangler / Chromium 完整回归。线上 health、401 / 403、首页 CSP、首页 / 手册 / 下载清单与 SHA256 字节、手册 UTF-8 和五个归档 HEAD 通过。未提交生产凭据或操作用户设备 / 会话，无模型调用。

实际平台基线已采集，见 [DO 用量分析](do-usage-2026-10-27.md)。本次优化后的请求 / duration / 行读取收益和真实 24 小时受控验收仍待测量，不以旧基线证明新版本节费。

证据见 [测试记录](TEST_REPORT.md)、[部署与 CI](assets/do-usage-2026-10-27/deployment.json) 和 [线上验证](assets/do-usage-2026-10-27/online-verification.json)。完整本机部署日志在忽略目录 `.local/do-optimization-deploy/`。
