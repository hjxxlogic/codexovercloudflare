# r2 当前部署

2026-11-04 将不透明中继架构部署到 **https://r2.xlogic.cc**。Worker 保留权限管理，Agent / Client 承担加密业务、控制权和可靠传输。旧站及既有本机 Agent 不属于本次升级范围。

## 来源与制品

- 部署源码：`a61423f4f1cbd82b018dbcf3f29c1ac2acb43859`，版本 `0.6.7`。
- [该提交的完整 Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41764690561) 成功：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必需作业全部通过。分支运行的 release 发布作业按条件跳过。
- 使用 `scripts/deploy-cloud.py --target r2` 部署经过摘要和来源校验的 CI Worker / 网页制品，同时发布四个平台安装包与源码包；没有部署本机构建的发行制品。
- Worker：`codex-over-cloudflare-r2`；最终 Version ID：`c43346e0-d76c-404a-b93a-b759cc16055c`。
- [公开验证记录](assets/r2-deployment-2026-11-04/verification.json) 包含源码摘要、全部 artifact SHA256、在线安装包摘要、静态资源核对和隔离断言。凭据、配置、原始日志仅保存在忽略的 `.local/r2-deployment/` 与 `.local/deploy-cloud/`。

本记录和后续测试脚本修正属于部署后的证据整理；线上产品源码仍为上述已通过 CI 的准确提交。

## 线上验证

健康检查成功，网页静态资源与 CI 制品逐字节一致；从 r2 下载四个平台安装包和源码包，SHA256 全部匹配。

本机 CTest 13/13、Vitest 35 文件 / 379 项、启用 Terminal 的完整 E2E 46 项通过；平台 CI 结果与本机结果分别记录。

使用 CI musl Agent、独立临时配置 / SQLite / 项目、真实 Cloudflare 和 Chromium 运行隔离测试，覆盖：

- 加密项目、配置读取及权限拒绝；原请求重复创建不重复执行。
- 控制握手、模型列表、提示词及流式完成；文件字节和历史读取。
- 控制接管、相同 claim 的稳定重试 ticket。
- 中继可见密文不包含测试提示词或会话 ID；Worker 目录不含业务 build / operationInstance。
- 浏览器选择主机与项目、创建会话、发送任务、刷新后恢复历史且回复不重复；桌面及手机视口无页面异常。

[桌面截图](assets/r2-deployment-2026-11-04/desktop.png) · [手机截图](assets/r2-deployment-2026-11-04/mobile.png)。复现入口见 [发布操作](RELEASE.md#独立-r2-测试站)。测试结束停止临时 Agent 并撤销其关联授权；未安装常驻 r2 Agent。

## 隔离与验证边界

r2 使用独立域名、Worker、两个 Durable Object namespace 和 owner secret。发布前后核对，旧站 Worker 版本保持 `0c4458c6-4b89-466e-ba86-fc84c58966c1`，既有 Agent 的 PID、启动时间及 active 状态保持一致；未替换其二进制、配置或数据库，未调用服务重启。此核对以实际 r2 发布前为基准，不将其他操作此前造成的变化归因于本次发布。

Access 入口已启用。测试使用 Service Auth 准入及 CoC 访客授权，包含 HTTP 与 WebSocket；未执行邮箱 / OTP 登录。原生连接须配置允许 r2 origin 的独立 Access 文件，见 [用户手册](USER_GUIDE.md#独立-r2-测试站)。

业务测试使用模拟 Codex，没有调用真实模型。此次未演练生产数据库迁移 / 回退，也未完成跨网络长时间稳定性测试；本机真实 Codex 协议与 TUI 初始化结果见 [测试验收](OPAQUE_RELAY_TEST_PLAN.md)。测试通过不代表旧站或既有 Agent 已升级到新架构。
