# 0.6.15 主站发布与 DO 优化验收

2026-11-07 发布至 https://r.xlogic.cc，Worker `codex-over-cloudflare`，版本 ID `58c24e00-9db1-4b3d-a274-2f51800d254d`。Worker / 网页、Ubuntu 20.04、Debian 12、musl、Windows x64 下载包及源码包来自同一准确提交 `54e210ce04b686b818283d629bb0a8f1e6d8180f`，源码摘要 `fac08869fd38fbc9fa3be861ee1564d23fb3d56b6e43f6cca5f17eeda83fa1c2`。

[Actions 42343337541](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42343337541) 的 regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必需作业全部成功；分支构建的 GitHub Release 作业按条件跳过，不计为必需门禁。部署只使用已完成 CI 的制品，`ciVerified=true`、`localBuild=false`。

## 发布内容

关闭握手抛错时仍完成关联连接清理；逻辑通道关闭通知无法发送时退休相应上行及其全部关联客户端，避免遗留 link。Host / Registry 到期 alarm 的目标未变时不重复写入或取消，Host 在异步读完 alarm 后读取当前附件期限。

生产依然只直接绑定 RegistryDO / HostRelayDO，无 D1 / R2 绑定。保留现有 namespace、Secret、普通变量、凭据及业务状态；本次没有安装或重启已有 Agent，也没有广播自动更新通知。

## 发布过程与验收

执行仓库 `scripts/deploy-cloud.py --commit 54e210ce04b686b818283d629bb0a8f1e6d8180f --run-id 42343337541 --publish-downloads --gh-proxy --apply`。工具提交 `1712cf9be65821ddbcd74ff42ebc637681d2e880` 独立记录：公开仓库先匿名确认，再通过代理获取公开归档；保留可信 GitHub API 的 SHA256、源码身份和六项 CI 门禁。四平台独立归档并行下载。工具本机 Cloud 20 项、下载发布 2 项回归通过；该工具提交不是已发布业务制品的来源提交。

发布前健康版本 0.6.14，发布后为 0.6.15，协议版本均为 1。网页、脚本、样式、主题、用户手册、下载清单及校验和逐字节一致；四个原生包和源码包从线上重新下载，与已验证 CI 包的 SHA256 全部一致。共享 Access 入口凭据单独使用时，HTTP / WebSocket 业务与管理入口仍按预期拒绝未授权访问。

公开证据：

- [来源、六项作业、制品摘要和线上核验](assets/release-0.6.15-2026-11-07/deployment.json)
- [发布前核验](assets/release-0.6.15-2026-11-07/before.json)、[发布后核验](assets/release-0.6.15-2026-11-07/after.json)
- [四平台与源码包 SHA256](assets/release-0.6.15-2026-11-07/SHA256SUMS)

源码本机验证包括 15 项 CTest 无跳过、36 个 Vitest 文件 / 398 项测试，以及完整加密 E2E、含 PTY 的默认完整 E2E、默认 UI、项目管理、邮箱 / guest 授权、网页空闲用量和唤醒 UI。新增测试调度门禁 2 项单独通过。最终完整 CI 以以上准确提交的六项成功为准。

首次 `847fbc5` CI 在刷新后等待发送按钮超时，未发布。中间 `fcd91fd` 已通过该步骤，但 E2E 仍寻找已移除的列表附加续接按钮；候选已修正管理员授权入口与正文续接路径，默认完整 E2E 本机重跑和最终 CI 均通过。首次发送等待超时的根因没有堆栈证据，未宣称仅靠重跑已解释该失败。

## 测试耗时改进

`797341f` 将三个使用独立端口、临时状态和进程的计费场景并行运行，保留真实 30 秒重连、90 秒 Pong 和全部断言；任一失败使组合命令失败，等待其余场景结束。它属于后续仓库测试工具，未用于替代本次已完成的串行 CI 门禁。

串行 CI 为 514.2 秒；本机并行为 330.3 秒（读取 31.8 秒、失败重试 151.3 秒、空闲 / 心跳恢复 330.3 秒）。约节省 183.9 秒，即该组 35.8%。最终成功 CI 的 regression 为 2,074 秒（34 分 34 秒），折算约减少全程 8.9%；优化后完整 CI 尚未实测，比例是估计。[计时证据](assets/release-0.6.15-2026-11-07/timing.json)

## 验证边界

未对真实用户会话发起模型任务、接管、写操作或重启。线上核验覆盖健康、静态资源、下载包与未授权入口；既有用户会话与长期运行行为不由这些检查替代。DO 修复以本机故障注入和 CI 回归为依据；尚未积累发布后同等时间窗口，不能宣称已测得线上节费比例或消除了所有历史异常。用量基线及历史 Registry 异常归属见 [传输状态与资源](TRANSPORT_STATE_INVENTORY.md#do-调度与线上用量复核)。

完整日志和下载快照留在忽略的 `.local/release-0.6.15-*`、`.local/deploy-cloud/42343337541/`，不提交凭据或机器本地状态。
