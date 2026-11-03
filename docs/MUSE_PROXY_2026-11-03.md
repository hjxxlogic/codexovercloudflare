# 0.6.6：平台代理继承与 CW 会话名称

[发布记录](DEPLOYMENT_STATUS.md) · [用户指南](USER_GUIDE.md) · [脱敏部署证据](assets/muse-proxy-2026-11-03/deployment.json)

## 发布结果

按用户明确要求跳过 GitHub Actions，通过 `scripts/deploy-cloud.py --local-build --local-native-build-dir build-musl-release --apply` 发布干净源码 `65fd465d02c59366f352b46378b520823a12cac7`。Worker `5cedd8e5-16c3-4b02-9509-1630455eaacb`、部署 `cf7a494a-8e1d-4472-8323-886191d5e529` 接收 100% 流量。线上健康返回 0.6.6，网页资源字节和清单内五份归档的 SHA256 全部一致；非静态资源 bindings 与前一版完全一致，保留配置、Secret 及两个 DO namespace。

下载站发布 Linux 0.6.6，三个 musl / Ubuntu 20.04 / Debian 12 入口均来自同一个本机静态 musl 构建。两种程序的干净源码身份及静态 ELF 已检查，归档约 13 MB。Windows 下载保留 0.6.5 并标记 deferredPlatforms。`localBuild=true`、`ciVerified=false`，没有本轮 Actions URL；不表示完成三个发行版或 Windows 的独立 CI 验证。此次发布渠道是生产网站下载。

## Codex 出站环境

新增 `codexProxyMode=inherit|direct|agent`：新旧字段均省略时默认继承父进程代理；direct 清除代理环境；agent 使用 Agent 的显式代理。旧 `codexUseProxy` 显式布尔配置保持兼容，新字段优先。版本探测、会话及历史读取使用相同策略，保留认证、CA、CODEX_HOME 等其他环境。完整配置见用户指南。

远端报告的模型、提供方、实际 Codex 版本和 CA 一致，旧 Agent 清除代理环境是主要嫌疑；受沙箱限制的 curl 失败不能作为 VM 网络因果证据。本轮仍不能据此认定已经解决现场模型连接。

## CW 与 Codex resume 名称

在生产项目 `/home/ubuntu/work/codexovercloudflare` 核对 Codex `thread/list` 与 Agent `/threads`，六条线程的 ID、name、preview 全部一致。实际打开同目录 Codex resume 选择器，仅查看列表，六条名称匹配，没有进入或接管已有会话，也没有模型请求。

真实生产 Chromium 页面在修改前六条中有三个旧标题差异；发布后六条全部匹配，页面无未捕获异常。CW 现在依次采用 Codex name、Codex preview、旧 CoC title，避免旧缓存标题覆盖 Codex 名称。原会话名称、配置及内容未因本次核对而修改，截图和真实标题仅保存在 ignored `.local/`。

## muse-vm 现场状态

UTC `10:23:04` 发送 0.6.6 更新通知前，muse-vm 为 0.6.5 / `875e771`，确认空闲；自动更新开启，platform 为 debian12，新旧 Codex 代理字段均省略。通知后持续返回 `HOST_OFFLINE`，四分钟内未能取得新进程版本。因此尚未确认安装和重连成功，也没有发送原计划的一次最小模型提示词，不能将发布成功描述为 Muse 模型服务已恢复。

当前没有可用的 VM 侧 SSH 或独立执行通道；Agent 离线后不能继续通过其控制通道读取进程日志。已请求 VM 上的 Codex 只读检查实际进程、启动器 / supervisor / systemd 状态、最近启动日志，以及实际可执行文件和 `.previous` 的 `--version`，用于区分进程退出、崩溃、未重新启动与 TLS / DNS / 代理重连失败。隐藏所有认证和代理密钥，不输出完整配置，不调用模型，不擅自修改配置或结束任务。取得现场信息后继续恢复及最小模型验证。

## 验证范围

本机原生及最终静态构建各 11 项 CTest 通过；完整 Vitest 484 项和新增名称回归一项通过。登录保存七项、部署脚本 15 项、类型、协议、格式、完整 Chromium UI 以及静态更新器核心检查通过。最终静态构建曾遇到本机工具链的临时依赖文件路径错误，重编后完整构建和全部静态 CTest 通过。

补充自动更新现场相关检查时发现旧测试夹具的两个问题：musl 构建错误地显式设置不支持的 platform 字段，控制写请求也缺少现行原操作身份。夹具已改为使用 musl 默认选择及带实例绑定的原操作；生产 muse-vm 配置是合法的 debian12，不能将这些夹具错误当作现场根因。修正后，0.6.5 和已发布的 0.6.6 静态 Agent 均通过自动空闲重启、忙碌时等待及会话结束后安装检查。服务器和更新候选均为本地无模型夹具，候选原生 ELF 仅验证更新身份及重启标记，不代替 Muse 上新 Agent 的启动和模型实测。详见部署证据。
