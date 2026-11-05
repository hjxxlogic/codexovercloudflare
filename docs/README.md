# 项目文档

- [CW 0.6.10 三级导航与图标操作](CW_NAVIGATION_0.6.10.md)

- [CW 0.6.9 统一导航实施与 Web 验收](CW_NAVIGATION_0.6.9.md)

本文档集描述当前源码支持的功能、约束和操作方法。运行实例与下载包的版本需分别核对，不能从源码版本推断线上状态。

| 阅读目的                   | 文档                                                  |
| -------------------------- | ----------------------------------------------------- |
| 安装、授权、运行与排错     | [用户手册](USER_GUIDE.md)                             |
| 了解功能范围和安全边界     | [项目需求](REQUIREMENTS.md)                           |
| 理解组件、进程与存储       | [技术架构](ARCHITECTURE.md)                           |
| 理解可靠请求、确认和恢复   | [可靠传输协议](RELIABLE_TRANSPORT.md)                 |
| 查询资源预算和状态归属     | [传输状态与资源](TRANSPORT_STATE_INVENTORY.md)        |
| 配置历史保留和正文恢复     | [数据保留与恢复](HISTORY_STORAGE.md)                  |
| 配置入口认证和邮箱授权     | [Cloudflare Access](cloudflare-access-coc-auth.md)    |
| 理解连接授权、撤销和到期   | [Worker 连接授权](WORKER_CONNECTION_AUTHORIZATION.md) |
| 远程读取配置、替换与重启   | [远程配置](REMOTE_CONFIGURATION.md)                   |
| 构建、开发和本机测试       | [开发说明](DEVELOPMENT.md)                            |
| 选择测试入口和了解验证边界 | [测试说明](TEST_REPORT.md)                            |
| 查看 r2 当前部署和线上验证 | [r2 部署记录](R2_DEPLOYMENT.md)                       |
| 发布、部署与回退           | [发布操作](RELEASE.md)                                |

[protocol.generated.json](protocol.generated.json) 由 `packages/protocol` 的 schema 生成，修改协议后运行 `npm run protocol:generate`，不要手工编辑。

[不透明中继架构](OPAQUE_RELAY_DESIGN.md) 说明本次职责迁移：Agent / Client 承担业务路由、控制权和可靠传输，Worker 保留权限管理、连接准入与密文转发。实施用例、运行入口与本机证据见 [设计测试与验收](OPAQUE_RELAY_TEST_PLAN.md)。

[CW Happier 界面计划与实施记录](CW_HAPPIER_UI_PLAN.md) 记录会话视图的上游来源、移植范围、步骤及浏览器验证。

## 维护约定

- 功能、配置和限制写入对应主题，直接修改原说明，避免追加版本补充和重复结论。
- 有歧义时先查相关 Git 提交的先后关系，再核对当前源码、schema 和测试；尚未实现的计划不写成支持能力。
- 测试说明描述覆盖范围和复现入口，检查结果以相应提交的运行日志和 CI 为准。
- 部署时记录准确提交、Actions URL/结果、制品摘要、目标、验证及限制；公开部署证据按仓库要求记录，私有信息与本机日志放在忽略的 `.local/`。文档整理时不把旧部署流水作为当前状态说明。
- 历史变更由 Git 提交记录查询，不在文档目录保留阶段审计、实施流水和过时截图。

[Happier 官方 Web 实测对照](HAPPIER_WEB_COMPARISON_2026-11-05.md) 记录真实单 / 多会话、工具审批、长输出和手机富文本场景。
