# 历史订阅失效修复与 CW 侧栏发布（2026-11-08）

已部署至本机 `coc-agent.service` 与 [主站 CW](https://r.xlogic.cc)。订阅被清理时，Agent 使用订阅身份发送一次失效通知，客户端可重建订阅，运行任务继续执行。CW 左侧会话列表只为会话图标着色，状态说明放在悬停提示及读屏标签中。

## 来源与验证

- 功能提交：`8925c7709c84423903db8f54058e847af172a549`，已推送 Entire `origin` 与 GitHub `master`，包含 `[skip ci]`。
- 用户明确要求提交、跳过 GitHub Actions 并部署。该提交的 Actions API 查询结果为 0 个运行；本次本地构建记录 `ciVerified=false`，没有对应 CI 制品或跨平台 CI 验证。
- 从独立干净 worktree 构建，排除原工作区无关未跟踪文件。构建元数据 `dirty=false`，版本保持 `0.6.17`，协议 1，源码摘要 `7008f0d98a7ea882aca3773c7f334757fd1a5a0855de20df1e9932eef19f1577`。
- 本地验证通过 16 项 CTest、37 个 Vitest 文件 / 409 项测试、完整 `npm run test:delivery`、活动会话浏览器专项、类型和格式检查。部署使用的干净构建额外通过 PTY 测试与真实加密端点的订阅失效专项，无模型调用，未操作用户任务。测试范围见 [测试说明](TEST_REPORT.md)。

## 本机 Agent

使用仓库 `scripts/deploy-agent.py --local --local-build --commit HEAD --apply`，指定现有 Agent 与配套 CLI 路径；稳定性验证设置为 120 秒。部署前和安装前均由脚本确认无 runtime、审批、排队命令或在途读写，没有使用 `--allow-restart-active`。

安装前保存配置、项目登记及 SQLite 一致性备份，脚本备份旧二进制。新 Agent / CLI 的提交与源码摘要均匹配上述干净构建；Agent 连续 120 秒保持同一 PID、服务正常、中继握手完成，`connected=true`。配置与项目登记文件摘要未变，数据库 `quick_check=ok`。本机私有项目控制端口及运行令牌按正常启动流程重新生成。

| 已安装文件 | SHA256                                                             |
| ---------- | ------------------------------------------------------------------ |
| Agent      | `9666967fa759aa543bf5ad42de3391489040dd278c4d89df64b6af4f531a0cb1` |
| CLI        | `c398ff0a9e8d0512f1c4892359639a755685b23e914c5c71e4f4d8ffc6a12514` |

## 主站网页

使用仓库 `scripts/deploy-cloud.py --local-build --target production --commit HEAD --web-only-from .local/deploy-cloud/42437371362/deployment.json --apply`。Cloudflare 将执行模块与静态资源绑定到同一版本，本次版本 ID 为 `6fc63814-2494-47c7-9778-64572150ee6e`。

Worker 继续复用已验证的 `91d3093217162db95168d3565cc9d92411fa2bda` 制品，发布前后执行模块 `index.js` SHA256 均为 `910b488cbf0173e1dc6b41f4f9f120d3f6406edf12968b64ffa7b789f2ce7e62`。部署脚本回读首页、网页全部资源、下载说明与清单，字节与准备目录一致；健康接口返回 `ok=true`、`version=0.6.17`、协议 1。保留线上变量、Secret、Access、DO 配置和四平台下载包，没有发送自动更新通知。

首次准备时 Cloudflare OAuth 令牌已过期，校验 API 返回 401；Wrangler 自动刷新后重试完成。首次尝试尚未发布。

| 网页资源                   | SHA256                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| `index.html`               | `2c089ad483230bd241e75046da2d8a2c8c162fa8bee245ed157a120ec7cb5f20` |
| `assets/index-Bp4bQ_55.js` | `2309f38b554fe2eefd0bf0e218f0e55a2acb8e3011c936b57fb06875749febf1` |

侧栏截图：[手机](assets/active-sessions-20261108/active-sidebar-mobile.png)、[深色手机](assets/active-sessions-20261108/active-sidebar-dark-mobile.png)。未在真实 iPhone / Safari 上验证；生产校验为资源和服务检查，没有向用户会话注入故障。

完整云端证据保存在忽略目录 `.local/deploy-cloud/local-8925c7709c84423903db8f54058e847af172a549-7008f0d98a7e-web-only/`；Agent 证据位于 `.local/history-expiry-agent-deploy/local-8925c7709c84423903db8f54058e847af172a549-7008f0d98a7e/`，私有备份位于相邻 `preflight/`。原始日志保存在 `.local/agent-investigation-20261108/`；不提交凭据、数据库或机器本地状态。
