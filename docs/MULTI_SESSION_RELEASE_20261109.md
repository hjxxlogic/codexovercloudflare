# 0.6.18 同项目多会话（2026-11-09）

已将主站 Worker / 网页、四平台下载包以及本机 Agent / 配套 CLI 升级至 **0.6.18**。

同一项目可打开多个独立 session，同时连接、运行模型任务和处理各自审批。控制权、显式接管及连接关闭按 session 隔离。同一线程仍只能有一个活动 runtime；同一 session 同时只执行一个轮次。项目 Terminal 与模型任务仍互斥，进程、队列、审批和历史额度保持有效。

多个 session 共享项目目录，文件变更彼此可见。需要目录隔离时使用不同 worktree；本次没有引入自动 worktree 或文件合并。

网页保留旧版 Agent 的 PROJECT_READ_ONLY 提示兼容分支，实际并发能力由 0.6.18 Agent 提供，无需修改中继业务协议或数据库结构。

## 验证与部署

本机原生 Agent / CLI / 组件及网页构建、类型、ESLint / Prettier、C++ 格式检查和协议生成一致性检查通过。16 项 CTest、37 个 Vitest 文件 / 409 项测试通过；`test:runtime` 的同项目并行轮次及停止隔离、`test:terminal` 的项目互斥通过。浏览器 E2E 的 3 / 5 个独立浏览器同项目并发、审批隔离及关闭后继续任务场景通过。

最终提交的完整 GitHub Actions 与部署均已完成，详见下文。首次 CI 失败后补充刷新回执恢复，最终本机 Vitest 全部 37 个文件 / 411 项测试及完整 UI、加密浏览器测试通过。

## 首次 CI 失败与修复

首次功能提交 `095a1018aa8128a10d054499a7906a098997ae80` 的 [Actions 42562695827](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42562695827) 五项平台 / sanitizer 作业成功，综合回归在加密浏览器测试失败：任务已有回复，但立即刷新后仍显示待确认，下一条消息发送超时。本机该测试通过；检查发现结果日志已持久化而单独的 pending 标记尚未清除时，刷新会丢失 UI 通知。

补充按原 requestId 从本机持久结果日志恢复 ACK / error 的路径，不重新发送命令、不根据历史正文猜测结果，保留未知结果的待确认状态。增加确定性的 ACK / error 刷新恢复单元测试；浏览器测试继续保留立即刷新及下一次发送的原断言。此次失败未部署。

## 最终来源与 CI

- 部署源码：`76c7056d0589ea7a4345a2ce404e3f060d83e558`，已推送 GitHub 与 Entire 的 `master`；初始多会话提交为 `095a1018aa8128a10d054499a7906a098997ae80`。
- [Actions 42565345127](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42565345127) 完成且成功，regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必需作业全部成功；可选 publish-release 作业未触发。
- 干净源码，`ciVerified=true`，协议 1，源码摘要 `6d0a9bec56fd706a38cd8fdc57be92500d6ecd65af4800d119464d0025c83a87`。全部部署使用该提交的 CI 制品，没有使用本地构建二进制。
- CI 确认原生同项目并行轮次 / 停止隔离、端点控制权隔离、Chromium 3 / 5 个同项目 session 同时进入审批、关闭一条后其他继续运行；加密浏览器立即刷新及后续发送的原断言通过。综合回归包含 16 项 CTest、37 个 Vitest 文件 / 411 项测试和完整浏览器链路。

## 主站与本机部署

云端通过仓库脚本 `scripts/deploy-cloud.py --commit 76c7056d0589ea7a4345a2ce404e3f060d83e558 --run-id 42565345127 --target production --publish-downloads --gh-proxy --apply` 发布至 [主站](https://r.xlogic.cc)，Cloudflare 版本 ID 为 `cb7645c1-a486-4380-a0fe-930a8f1523d0`。

健康接口回读 `ok=true`、`version=0.6.18`、协议 1。首页、全部网页资源、下载说明与清单逐字节匹配；四平台包及源码归档重新下载后的 SHA256 与 CI 制品一致。保留已有变量、Secret、Access、DO 配置和用户状态，未发送自动更新通知。

本机通过 `scripts/deploy-agent.py --push --push-remote github` 推送并等待 CI，随后使用同一脚本的 `--run-id 42565345127 --local --client-binary ... --apply` 安装经校验的 musl Agent 与配套 CLI。脚本在安装前确认无 runtime、审批或在途工作，未使用 `--allow-restart-active`；保存旧二进制备份，保留配置、凭据与数据库。新 Agent 120 秒稳定性观察通过，保持运行并完成中继握手；Agent / CLI 均返回 0.6.18、上述提交与源码摘要。

| 已安装文件 | SHA256                                                             |
| ---------- | ------------------------------------------------------------------ |
| Agent      | `fe3e624d3afd752de6dc0c80687c1048c6b67073444d5bdd5b6fb156ada841b0` |
| CLI        | `5476b4bfb4620e0105723301371de96eb13ac67bd6da23b35af791e6046bd4eb` |

## 制品摘要

公开 ZIP 下载使用 GH-Proxy 加速，SHA256 仍来自可信 GitHub API，并由部署脚本独立校验；不向代理发送凭据。

| Actions 制品        | SHA256                                                             |
| ------------------- | ------------------------------------------------------------------ |
| `verified-web`      | `8c0e971b3f497ada9e683080167edfd603014e3e8305b205b45700e54c73ff8a` |
| `verified-worker`   | `89f73a22db908d9b84a2b2cb3d6a88c2aca198a76a7bbcb73a20ea43c498c528` |
| `windows-x64`       | `c41977a08bc177e2fbcba9ae43a426ae73998fece24850a5592bc876f5ab19e5` |
| `linux-musl`        | `c08472074c74b2f3b71bae89f7659ae411ecbf2bcd25a33c4c6894df694f9117` |
| `linux-ubuntu20.04` | `0926485e828d1f2a442d08b036bcd7d44d6c88d3f5570d8fe3cecaad97c78507` |
| `linux-debian12`    | `6022e349d8849e1e0d62709150221c3a04cc00719970e01223713ce9f2a7f3f9` |

| 线上归档                                     | SHA256                                                             |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `coc-0.6.18-linux-x86_64-debian12.tar.gz`    | `197ae67c15a6f4dfc68110f29677a1f457cb9dff00443ec8d8e41b60f015ffac` |
| `coc-0.6.18-linux-x86_64-musl.tar.gz`        | `82def5bb6726c3c2c58cde448e3c61f53bf5211c5f9ac1335e15cf9fbe210f2f` |
| `coc-0.6.18-linux-x86_64-ubuntu20.04.tar.gz` | `d341a5773b064d77b8a4f77a6ab205b2a9cb5b1e52491b3d1e0fd062b3ed4479` |
| `coc-0.6.18-windows-x64.zip`                 | `7e632f197f68f82309631eaa24f349b77a15a85583526cf5afb636197e4ef4e3` |
| `codex-over-cloudflare-0.6.18-source.tar.gz` | `f4794abd8ab1694c2db58c95084d0f02fa3d767d75d049dccebbf95bcc64d1f4` |

完整云端证据保存在忽略目录 `.local/deploy-cloud/42565345127/deployment.json`；Agent 安装、备份路径、CI 日志及本机测试日志位于 `.local/release-0.6.18/`。本次验证使用模拟 Codex，无真实模型调用；生产验证为版本、服务、静态资源和下载包校验，没有向用户会话提交测试任务。
