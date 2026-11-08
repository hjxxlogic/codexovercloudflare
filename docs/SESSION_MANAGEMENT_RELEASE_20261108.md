# 0.6.17 会话归档与删除发布（2026-11-08）

已将网页、Worker 与四个平台的 0.6.17 下载包发布至 [主站](https://r.xlogic.cc)。本机 Agent / 配套 CLI 已准备好经验证的 CI 制品，按用户选择等待现有会话结束后再更新；记录时仍运行 0.6.16。

## 来源与门禁

- 功能源码提交：`91d3093217162db95168d3565cc9d92411fa2bda`，已推送 GitHub `master`。
- 源码摘要：`81fa083da86fc61a16668d96c31c7d95761fbec8da60a485a3c4ea400388fb12`；干净源码，协议版本 1，`ciVerified=true`。
- [Actions 42437371362](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42437371362) 已完成，六项必需作业全部成功：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64。
- 综合回归通过 16 项 CTest、37 个 Vitest 文件 / 404 项测试，含实际 PTY 与完整浏览器 E2E；未使用 `--skip-tui`。Windows 的 13 项 CTest 通过；其余四项 Linux / sanitizer 作业各有 15 项 CTest 通过、PTY 因缺少隔离工具跳过。
- CI 制品额外验收通过：实际 musl Agent 的加密归档 / 恢复 / 删除接口，原请求恢复、权限及项目隔离、重启不重复执行；实际 CI 网页的手机归档列表、删除确认 / 取消与刷新不复活。使用隔离 fixture，未删除真实用户记录。
- 本机完整测试及首次偶发失败与重跑情况见 [本机测试记录](LOCAL_ALL_TESTS_20261108.md)。

## 主站部署

执行仓库脚本：

```sh
python3 scripts/deploy-cloud.py --commit 91d3093217162db95168d3565cc9d92411fa2bda \
  --run-id 42437371362 --target production --publish-downloads --gh-proxy --apply
```

Cloudflare 版本 ID 为 `049710d0-b247-425e-9c9a-2ee31dd0d3ed`。发布后健康接口返回 `ok=true`、`version=0.6.17`、协议 1；脚本回读网页资源、说明与下载清单，字节与制品一致。四个平台包和源码归档逐项重新下载，SHA256 与 CI 制品相同。保留现有变量、Secret、Access、DO namespace 和用户状态；未发送自动更新通知。

公开 Actions ZIP 使用 GH-Proxy 下载，摘要来自可信 GitHub API；部署过程中同时核对 ZIP 摘要、包内校验和与各平台的源码身份。

## 本机 Agent 等待更新

用户明确选择“等待会话结束后再更新 Agent”。本机 `coc-agent.service` 当时仍有两条打开的会话，其中一条任务运行中；服务进程未重启，配置及项目登记摘要与备份一致。已用仓库备份脚本生成 SQLite 一致性备份，配置、凭据与数据库副本只保存在忽略的私有目录。

后台用户服务 `coc-agent-deploy-0.6.17.service` 已启动，调用 `scripts/deploy-agent.py`，固定上述提交及 Actions run，使用同一经验证的 musl Agent / CLI。未启用 `--allow-restart-active`，日志已确认正在等待；每 20 秒检查空闲，等待上限 24 小时。空闲要求所有会话 runtime、读取器、审批、队列、文件请求和缓冲均清空，仅当前模型轮次结束不足以触发安装。

安装发生时脚本会再次检查目标、备份旧二进制、安装 Agent 与配套 CLI，并验证新服务 120 秒；失败尝试回滚。上述安装仍待会话结束，因此当前主机上的归档 / 删除能力需等 Agent 更新后可用。可查看等待状态：

```sh
systemctl --user status coc-agent-deploy-0.6.17.service
journalctl --user -u coc-agent-deploy-0.6.17.service -n 20 --no-pager
```

待装 Agent 可执行文件 SHA256：`c2c3248490cd8dce38c113e6a44e2c08135a3c5a3b91449623b336d606a5c16c`，与额外接口验收使用的二进制完全相同。

## 已核对摘要

| Actions 制品        | SHA256                                                             |
| ------------------- | ------------------------------------------------------------------ |
| `verified-web`      | `31c9e3bdc237b6b0bc64327dba27d87bc76cef383548ab299237b9b135155fb2` |
| `verified-worker`   | `a2cbda74604a5260e18428befe4d0905f451666cfb732a5b924982ed4425283c` |
| `linux-ubuntu20.04` | `4f8f892b7d1d238fe1d3727e9bd09c67e14321de15fd4a556db32f63037a232f` |
| `linux-debian12`    | `00dc21f41211c4685ecf15c6acc85bc121ebd2383c218f6d789439147584329b` |
| `linux-musl`        | `9521218da187d90c5d7185ca9674186382c2f4e95939ade6564057ceeb13541d` |
| `windows-x64`       | `1e76176d481235bc616cbcc54419548ef4d598e9563e76b0071207ef34bafeac` |

| 线上归档                                     | SHA256                                                             |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `coc-0.6.17-linux-x86_64-debian12.tar.gz`    | `508f5ca0daaa3890af0fad325fbea9616f1cae292cadabe244f6338b089767a3` |
| `coc-0.6.17-linux-x86_64-musl.tar.gz`        | `186f3b99730ecba00734f5c115b2368875c2187c1e9bc2dfa7fec674f28ce8ef` |
| `coc-0.6.17-linux-x86_64-ubuntu20.04.tar.gz` | `f19e596a48b3b9a9c20eb9ba6ba610418bd0972e838254ba24fd7459578dc251` |
| `coc-0.6.17-windows-x64.zip`                 | `3e62f309c0612d4f5181673d328a9b00b6e7c9a2c178dd9e570bbacf353dce70` |
| `codex-over-cloudflare-0.6.17-source.tar.gz` | `e49bd8c32bbbe32bf83f0cd1bacf4defad4479f90269b37cc4e748ad22d23d55` |

## 界面与边界

使用 CI 网页、模拟身份与历史生成的 390 × 844 手机截图：[已归档列表](assets/session-management-20261108/threads-archived-mobile.png)、[删除后列表](assets/session-management-20261108/threads-deleted-mobile.png)。未在真实 iPhone / Safari 上验证。

云端完整证据位于忽略目录 `.local/deploy-cloud/42437371362/deployment.json`；Agent 等待 / 安装结果由 `.local/session-management-0.6.17/agent-queued/42437371362/deployment.json` 自动记录。原始日志、CI 各作业日志、备份和截图保存在 `.local/session-management-0.6.17/`；不提交机器凭据或用户数据库。
