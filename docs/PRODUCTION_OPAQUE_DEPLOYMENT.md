# 主站不透明中继部署记录

2026-11-06，用户明确授权发布本地构建至 `https://r.xlogic.cc` 并跳过等待 GitHub Actions，随后授权使用已经完成的 Actions 制品，通过 GH-Proxy 下载并发布。

## 实际部署

- Worker / Web：`0.6.14`，源码 `9c546cc1eac2ab0e7e29c8350f3b8eface6871d3`，本地构建，`ciVerified=false`。包含主站遗留租约诊断、逐项核对和备份退役入口。
- 现有 systemd 用户服务 Agent 与配套 CLI：同一 `9c546cc` 本地源码构建，保留原配置、凭据、主机 ID、relayUrl、dataDir 和项目登记；Agent 完成 120 秒连接验证。
- 主站下载：Ubuntu 20.04、Debian 12、静态 musl、Windows x64 四个平台 `0.6.14` 完整包及源码归档，来自 `4a9d4414b734f0060d72b4854c729b4d67dbdbd7`。该提交与当前云端源码的原生代码、构建输入一致。
- [Actions 42178474355](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42178474355) 的 regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 均成功；publish-release 跳过，未创建 tag 或 GitHub Release。使用现成成功结果，没有等待新修复提交的 CI。
- 发布下载使用 `scripts/deploy-downloads.py --gh-proxy`。代理仅接收公开 Actions URL；GitHub 摘要由可信 API 获取，四个 ZIP、包内校验和及线上下载字节全部核对通过。发布前后 Worker 执行模块摘要一致，保留网页、生产变量、Secret、Access 与 DO namespace。

最后一次 Worker 发布版本为 `58dfe832-7796-497d-967c-a02140d9c15f`。组件源码身份、GitHub 制品摘要及线上安装包 SHA256 见 [机器可读证据](assets/opaque-integration/production.json)。本机私有配置、数据库、原始 DO 内容、聊天截图和部署日志保存在忽略的 `.local/production-opaque-20261106/`，不入库。

## 数据与恢复

升级前完成 SQLite 在线备份、配置及项目登记备份，保留生产 Worker 模块和配置。部署前 Agent 的新鲜指标确认运行任务、队列、读取、文件和审批均为空；没有强制中断活动任务。

首次连接被旧 DO 的 8 条活动 / pending 租约阻塞，未决权限操作为零。旧安装工具随后只回退二进制，导致旧 Agent 无法打开已经升级到版本 2 的数据库。停止无效重试后，增加了禁止数据库迁移后只回退二进制的保护，以及基于原空闲证据、停止服务和完整数据库的恢复流程。

通过仅限当前主机的 Agent 凭据导出旧 DO，核对数据库会话均 closed/failed；按原值比较后退役 8 条租约。原始租约另存 DO reconciliation 记录和本地快照，随后完成可续跑迁移。`channelVersion=1`、完成标记为真；880 条旧记录逐项与备份 / reconciliation 原值核对，无缺失或变更。其他离线主机对应对象仍采用首次访问迁移，未将它们标记为已验证。

真实数据库从 `user_version=0` 升为 `2`，完整性检查通过。原 130 个会话标识、43,000 条历史标识和 191 条请求账本均保留，请求指纹和结果没有变化。运行期间用户正常使用可新增会话，原始流式增量缓存也会按既有规则压缩；不把运行中的所有表行数不变作为迁移契约。

加密线上读取返回全部 130 个原会话（两页），三组原历史分别读取 63 / 69 / 105 条并与快照序列和元数据匹配。Chromium 验证桌面、刷新和手机历史显示通过，页面错误为零；验收未发送模型任务。测试浏览器上下文已关闭，临时 Cookie 未持久保存；原始日志保留了测试脚本误用仅限管理员 logout 接口返回 401 的清理错误，该错误发生于全部业务断言通过之后，不将其当作产品验收失败或凭据撤销成功。

## 检查与边界

本机原生 CTest 15 项、Vitest 393 项通过，类型检查和 lint 通过。部署工具回归 Agent 19 项、Cloud 18 项、Web 5 项通过；新增数据库升级回退保护 2 项和原生构建输入一致性 2 项通过。

本机 Agent 已开启自动更新。当前运行和 CI 下载都是 `0.6.14`，同版本不同提交不会自动替换；未来更高版本在启动、重连或管理员发布通知后检查，等待会话与历史读取结束再安装。未广播发布通知，未声称其他 Agent 已升级，也未将本地云端修复标记为经过该 CI 提交验证。
