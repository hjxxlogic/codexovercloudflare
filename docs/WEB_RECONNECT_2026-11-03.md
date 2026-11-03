# 网页断网恢复修复 · 2026-11-03

用户报告 `tmpwork` 使用中断网后无法恢复，页面显示 `STALE_CONTROLLER: Resume proof does not match the original controller`。只读现场检查时 Agent 仍可 probe，项目和会话快照可读，最近任务已结束；管理端的 busy 仍为 true，未重启 Agent、停止或接管现场会话。具体主机、会话及诊断响应保存在忽略的 `.local/tmpwork-reconnect-2026-11-03/`，不提交会话内容或凭据。

## 原因与修复

确定性回归复现了一条与现场报错一致的路径：服务端已经提交重连的新 socket 身份，但 `attached` 确认未到达浏览器；租约交接又没有保存本次请求实际使用的旧 controller，后续旧凭证被永久拒绝。

- 重连交接保存请求中已经验证的原 controller，允许确认连续丢失和 DO 重建后继续恢复。
- 已受影响的租约可以使用原随机 claim 恢复，必须同时匹配当前认证 owner、当前 controlId 和已经绑定的 delivery stream。后续接管替换 claim 后，旧凭证仍被拒绝；其他 owner、伪造 claim 和错误 stream 均不能恢复。
- 网页控制连接不再重试三次后停止：先三次快速退避，再每 30–60 秒抖动重试。网络恢复或可见页面恢复可提前唤起断开的控制连接，合并同时到达的事件。健康连接不新增周期请求；明确的认证失败、控制权替换和项目只读状态仍停止自动抢占。
- 继续使用原控制代际和持久命令记录，不重发为新任务，不清理浏览器缓存。

## 验证与部署边界

旧实现运行新增 Relay 回归时有两项失败：丢失确认后未保留原 controller，以及已损坏租约无法使用正确的稳定 claim 恢复。修复后对应回归通过；完整 Relay、网页 delivery 和 API 三组共 176 项通过。真实 Chromium 另外验证超过三次失败后的恢复、网络恢复事件合并、草稿保留和恢复不提交新任务。具体最终执行结果见 [测试报告](TEST_REPORT.md)。

用户明确要求针对问题测试通过后先部署，并跳过 GitHub Actions。本次使用 `scripts/deploy-cloud.py --local-build --apply` 发布 Worker / 网页；记录 `localBuild: true`、`ciVerified: false`，沿用既有原生下载，不发布新的原生版本或重启 Agent。准确源码、摘要、部署 ID 及线上验证另记 [发布记录](DEPLOYMENT_STATUS.md)。刷新网页载入新资源后，在原会话点击“重新连接”；无需清理缓存。若其他设备确实接管过，仍须显式接管。
