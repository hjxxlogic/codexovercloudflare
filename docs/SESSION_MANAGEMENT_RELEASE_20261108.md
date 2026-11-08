# 0.6.17 会话归档与删除发布（2026-11-08）

已将网页、Worker 与四个平台的 0.6.17 下载包发布至 [主站](https://r.xlogic.cc)。本机 Agent / 配套 CLI 也已使用同一成功 CI 的制品升级至 0.6.17，并通过 120 秒稳定性验证。

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

## 本机 Agent 更新完成

最初按用户要求等待会话结束，未重启运行任务。随后核对两条后台 Web 会话均无任务运行；用户明确同意升级本机 Agent，停止等待服务后通过仓库部署脚本安装同一提交 / Actions 的 musl Agent 和配套 CLI。该次安装显式使用 `--allow-restart-active`，结束两条空闲 runtime，保留会话历史；安装前再次创建 SQLite 一致性备份。

部署脚本核对 GitHub ZIP 摘要、包校验和、干净源码身份后安装并备份原二进制。新进程版本 `0.6.17`、提交 `91d3093217162db95168d3565cc9d92411fa2bda`，源码摘要与上述 CI 一致；连续验证 120 秒通过，`connected=true`。配套 CLI 版本相同，配置和项目登记文件摘要未变，SQLite `quick_check=ok`。凭据、配置、数据库副本及机器路径仅保存在忽略的私有证据目录。

已装 Agent 可执行文件 SHA256：`c2c3248490cd8dce38c113e6a44e2c08135a3c5a3b91449623b336d606a5c16c`；配套 CLI SHA256：`d558d920c27d0bea8f4204d2bdca16ad286ae0eb92d0b0209eba27de471c7e30`。

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

云端完整证据位于忽略目录 `.local/deploy-cloud/42437371362/deployment.json`；Agent 安装结果由 `.local/session-management-0.6.17/agent-queued/42437371362/deployment.json` 自动记录。原始日志、CI 各作业日志、备份和截图保存在 `.local/session-management-0.6.17/`；不提交机器凭据或用户数据库。
