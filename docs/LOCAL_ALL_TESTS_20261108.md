# 2026-11-08 本机完整测试

针对归档、恢复归档和删除功能的当前工作区执行本机测试。基础 HEAD 为 `fd59fc71f34d8ed7e4de92b762e03566937e4b2a`，包含尚未提交的功能修改；测试二进制的源码摘要为 `a3b9fd941c8f1b2d55d0d9b893d83c73927e24684f850ece3489200822cf8b2b`。本报告在测试后添加，因此不属于该摘要。环境为 Ubuntu 24.04.5 x86_64、Node 22.23.4、CMake 3.28.3、Codex 0.166.0。

## 已完成的检查

| 检查           | 结果与范围                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 构建、静态检查 | `npm run build`、`typecheck`、`lint`、`lint:cpp`、`protocol:check` 通过；Worker 只执行 dry-run                                                                                                                                             |
| 主机单元测试   | `npm test`：16 项 CTest、37 个 Vitest 文件 / 404 项测试通过，CTest 无跳过                                                                                                                                                                  |
| 原生与可靠传输 | `test:projects`、`test:delivery`、`test:queue`、`test:terminal`、`test:operations`、`test:runtime`、`test:configuration`、`test:wake`、`test:tls`、`test:billing` 通过；delivery 初次失败及重跑见下文                                      |
| 历史恢复       | `tests/native-history-recovery.ts` 默认、`--inline`、`--file`、`--file-started` 和 delivery 入口中的 `--retention` 均通过                                                                                                                  |
| 完整浏览器链路 | `test:opaque`、`test:terminal:e2e`、`test:projects:e2e` 通过；完整 E2E 包含 TUI，未使用 `--skip-tui`，并启用真实隔离 PTY                                                                                                                   |
| 浏览器专项     | `test:ui`、`test:ui:navigation`、`test:cache`、`test:operations:web`、`test:uploads:web`、`test:markdown`、`test:billing:web`、`test:access:web` 通过；默认 UI 包含手机缓存额度、归档、恢复归档、删除确认和刷新不复活                      |
| 会话管理       | 完整 `test:threads` 通过：C++ 测试、加密 Agent 接口及手机 UI；`test:threads:codex` 验证真实 Codex JSONL 归档移动、恢复和删除，项目文件保留                                                                                                 |
| 真实 Codex     | `test:codex`、`test:native`、`tests/external-codex.py`、`tests/external-approvals.py` 通过；协议检查与模型任务分别运行                                                                                                                     |
| 真实模型       | `test:task`、`test:native -- --task` 通过，包含经 Worker / DO / Agent 的真实原生 TUI 模型轮次                                                                                                                                              |
| 备份、迁移     | `tests/state-backup.py`、`tests/legacy-upgrade.py` 通过；旧源码固定为 `666d1affbe063d9273ef34f435c5384a0e0e58c2`；`tests/user-database-upgrade.py` 对旧 Store 生成的合成快照通过，未使用真实用户数据库                                     |
| 部署与发布工具 | `tests/release-provenance.py`、`agent-deploy.py`、`deploy-agent-recovery.py`、`deploy-downloads.py`、`deploy-web.py`、`cloud-deploy.py`、`cloudflare-access-tools.py`、`ci-command.py`、`native-login.py` 均通过；部署工具使用隔离 fixture |
| 更新           | `tests/native-update.py` 基础校验、拒绝路径和并发锁通过；自动 / 忙时演练结果见下文                                                                                                                                                         |
| ASan / UBSan   | 独立 Debug 构建，16 项 CTest 全部通过，无跳过                                                                                                                                                                                              |
| Ubuntu 20.04   | 容器原生构建、15 项 CTest 和 8 项 native-login 测试通过；1 项 PTY 跳过                                                                                                                                                                     |
| Debian 12      | 容器原生构建、15 项 CTest 和 8 项 native-login 测试通过；1 项 PTY 跳过                                                                                                                                                                     |
| Alpine musl    | 静态原生构建、15 项 CTest、8 项 native-login 和 musl 更新测试通过；1 项 PTY 跳过                                                                                                                                                           |

## 中间失败与验证边界

首次并行运行 `test:delivery` 时，慢接收端测试的会话已停止，但缺少预期的 `outputError.code=BACKPRESSURE`，断言失败。未修改代码，随后独立重跑 `tests/native-delivery.ts` 通过，再完整重跑 `npm run test:delivery`（含 retention）通过。首次失败仍保留，根因尚未确定；两次重跑通过不等于已经消除偶发问题。

`tests/native-update.py --automatic --busy` 首次在当前工作区运行时，基础用例通过，但自动部分明确拒绝 `dirty=true` 的构建。为保持该断言，在忽略目录中的独立本地仓库提交当前源码快照 `ed549410834f4a9da53bd3352e7e25eda72a482a` 并重新构建；它的源码摘要与上述工作区构建完全一致，主仓库没有因此提交或推送。重新执行 `tests/native-update.py --automatic --busy` 通过，包含默认 CLI 更新、空闲 Agent 更新和活动会话结束前不安装 / 不重启；旧配置、项目及账本校验通过。

Ubuntu 20.04 初次使用 `ctest --test-dir`，旧版 CTest 不支持该参数而报告未发现测试；这次空跑不计通过。改用 `cmake -E chdir <build-dir> ctest --output-on-failure` 后实际完成上述测试。三个发行版容器未安装 bubblewrap，因此 PTY 测试跳过；主机的 PTY、完整浏览器 PTY 及 sanitizer PTY 均实际通过。

Docker Hub 直连超时后，使用 GH-Proxy 拉取公开 Node / Ubuntu 镜像。Debian 使用 `node:22-bookworm-slim`，Ubuntu 使用 `ubuntu:20.04` 加 Node 22，musl 使用本机已有的项目 Alpine 构建镜像。这些是本机容器测试，不是 GitHub Actions 制品验证。

本机为 Linux，没有运行 Windows x64 / MSVC 测试。真实 Codex 使用隔离的 `CODEX_HOME`，只在临时项目及测试记录上操作；测试固定 `COC_NO_STARTUP_REPAIR=1`。没有生产部署，也没有操作现有业务会话或用户数据库。

完整日志、首次失败、重跑、各组 JSON 结果和截图保存在忽略目录 `.local/all-tests-20261108/`。关键文件为 `baseline-results.json`、`native-results.json`、`browser-results.json`、`codex-results.json`、`native-delivery.log`、`native-delivery-reproduce.log`、`native-delivery-recheck.log`、`clean-update.log`、`sanitize-tests.log`、`ubuntu20-ctest.log`、`debian12.log` 和 `musl.log`；不提交其中的认证配置或私有原文。
