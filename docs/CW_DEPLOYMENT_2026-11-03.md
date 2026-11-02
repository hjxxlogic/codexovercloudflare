# CW 工作台本机构建部署 · 2026-11-03

[发布记录](DEPLOYMENT_STATUS.md) · [工作台范围](CW_WORKBENCH.md) · [用户指南](USER_GUIDE.md)

已按用户明确指示使用本机构建、跳过 GitHub Actions，发布网页 / Relay，并升级和重启本机 Agent。随后按用户要求启用本机 Terminal，将四个工作台入口移入功能菜单，并增加拖动分隔条；最终网页更新已直接部署。

| 目标                             | 实际源码 / 结果                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| https://r.xlogic.cc 网页及 Relay | `8e2ae8a447ef599c0e33d1f25b70bad6f1eb0a8e`                                                  |
| Worker version                   | `f283c218-9d27-4601-8f75-902966955de9`，已部署，健康及公共资源字节核验通过                  |
| 本机 Linux coc-agent.service     | `ce22d38f5a3b3766439113530c7de8ced45699c9`，本机构建 0.6.1，空闲时安装，连接稳定验证 120 秒 |
| 本机 Terminal                    | `terminal.enabled=true`，空闲时重启，额外稳定验证 30 秒                                     |
| CI                               | 本次未运行 / 未等待 Actions，无 Actions URL，`ciVerified=false`                             |
| 原生公开下载 / 自动更新通知      | 沿用原清单并重核 SHA-256，未发布新原生包、未发送更新通知                                    |

网页后续两次修正仅涉及浏览器 / Worker，不再次重启 Agent；不同部署源码分别记录，不将它们描述为同一提交的 CI 配套发行。完整产物、来源摘要、二进制 SHA-256 与验证标记见[脱敏部署证据](assets/cw-workbench-2026-11-03/deployment.json)。

## 管理员访问故障恢复

用户手动执行 `npx wrangler deploy` 后出现 `STATE_MIGRATED: Restore the D1 binding; legacy state is no longer authoritative`。根配置遗漏生产 D1 绑定和模式，已迁移的 Registry 正确拒绝读取旧 DO 副本。

先用上次已部署配置恢复原 `STATE_DB`，恢复版本为 `882849c3-d4b6-4018-9d74-8c7d0b9f80ab`；随后完整部署上述新版本。原 D1 UUID、Secret、管理员身份及授权数据保留，schema 无待执行迁移，没有清库、重置迁移标记或创建替代数据库。`wrangler.jsonc` 现固定原生产绑定、`STATE_BACKEND=d1` 和 Cron，发布脚本自动沿用；本地 DO 开发 / 测试显式覆盖 legacy，D1 测试使用独立本地库。

恢复后及本机 Agent 最后一次重启后，现有 Agent 凭据访问生产请求目录均成功。真实邮箱管理员浏览器登录未自动化；用户刷新管理页后使用原身份。

## 界面及 Terminal 验证

- 477 项 Vitest、类型、lint、网页构建通过；部署工具 16 项 Agent / 15 项 cloud 回归、真实 Wrangler D1 迁移通过。
- 整页 Chromium 回归验证功能菜单收纳和自动关闭、文件树 / 预览 / 输出的实际拖动、分隔条键盘调整及偏好保存；最终窄屏边界另经整页复测。
- 完整普通 Worker E2E 通过，包含真实 Linux bubblewrap PTY、菜单入口、Shell 输入 / 输出、拖动终端高度、390×480 短屏、终止和回收；3 / 5 浏览器压力阶段均通过。使用合成项目和 Codex 协议 peer，无真实模型调用。
- 生产资源与专用 CSP 的 Chromium 检查发现并修复 `/diagram.html` → `/diagram` 重定向导致的图表防嵌入冲突，以及 KaTeX 内联字体策略。生产 Markdown / 公式 / Mermaid 桌面和手机检查通过，API 使用合成只读夹具，不操作真实项目。
- 本机 bwrap、prlimit、Bash 可用；实际原生隔离 PTY 专项通过。启用配置仅改变 terminal.enabled，其他字段语义、凭据及数据目录保持一致；SQLite 完整性和各历史表记录数核对通过。未在真实用户项目中打开 Shell。

以下截图使用合成内容：

![可拖动文件树和输出；外观面板由菜单主动打开](assets/cw-workbench-2026-11-03/workbench-resize-desktop.png)

![手机终端及顶边分隔条](assets/cw-workbench-2026-11-03/terminal-mobile.png)

## 保全与后续操作

通过 `scripts/deploy-agent.py --local --local-build --apply` 安装，复用二进制备份、来源 / 摘要校验、空闲检查、重启观察和失败回滚；配置及在线 SQLite 快照保存在 ignored `.local/`，没有提交凭据和现场原始证据。Terminal 按后续明确授权单独启用并重启。

云端通过 `scripts/deploy-cloud.py --local-build --apply` 构建、暂存、部署并核验。此次是明确授权的本机构建例外，不将本地二进制标为 CI 发行制品；完整跨平台和长期性能验证不在本次结论内。

刷新 CW 标签页即可加载最新功能菜单和分隔条，无需清空历史缓存。通过“功能菜单 → Terminal”进入，选择具有控制权的空闲普通 Web 会话后点击“打开终端”；仍保持项目隔离和终端 / 助手任务互斥规则。
