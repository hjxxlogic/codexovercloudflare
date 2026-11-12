# 0.6.20 发布记录

2026-11-12 发布主站 Relay、网页及四平台下载，修复已复现的异步错误边界和失败连接清理问题。

## 行为

- Worker 等待 DO 转发、Host 等待通道升级的异步结果，异常进入既有错误响应逻辑；保留认证、权限及背压状态码。
- 已接受的新连接在调度或 welcome 发送失败后退休；清理失败不覆盖原始升级故障。
- channel-error 通知发送失败后仍执行连接清理，保留其他连接；失败阶段和协议错误码进入脱敏日志。

## 来源与检查

- 部署源码：`bfb6283dbca999d1914c050df6b089613161db23`，版本 `0.6.20`、协议 1、干净源码。
- 源码摘要：`9ad17f82e675747216343281c569386c10b47814b973f0d708aa5890e269ea42`。
- [Actions 43241338652](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/43241338652)：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必需作业全部成功；自动 publish-release 作业按工作流条件跳过，云端发布由仓库脚本执行。
- 本机完整检查：CTest 16/16、Vitest 39 个文件 / 452 项、真实 Worker + 原生 Agent + Chromium 加密端到端、TypeScript 与完整 lint 通过。本机原生测试使用版本升级前已有构建；最终 0.6.20 四平台原生包与 Worker / 网页均采用上述准确提交的 CI 制品。

## 发布与在线核验

- 目标：`https://r.xlogic.cc`；Worker `codex-over-cloudflare`。
- 命令：`python3 scripts/deploy-cloud.py --commit bfb6283dbca999d1914c050df6b089613161db23 --run-id 43241338652 --publish-downloads --gh-proxy --timeout 5400 --apply`。
- Cloudflare 版本：`b4a41d3e-f501-4de1-913e-24dae62a4ddc`。
- 发布脚本校验 GitHub Artifact SHA256、源码 commit / sourceDigest / dirty 身份；四平台包与源码来自同一次成功 CI。
- 健康接口回读 `ok=true`、`version=0.6.20`、协议 1；首页、脚本、样式、在线手册、下载清单及 SHA256SUMS 与准备产物逐字节一致；四平台安装包与源码包已重新下载并核对 SHA256。
- 保留原有变量、Secret、SETTINGS KV 与 DO 绑定及持久数据；未向运行中的 Agent 发送自动更新通知，也未安装或重启本机 Agent / CLI。未创建 GitHub Release。

## Artifact SHA256

| Artifact            | SHA256                                                             |
| ------------------- | ------------------------------------------------------------------ |
| `verified-web`      | `7ea4bd1d48a04baf7eee6723fc2d2f6f15669fbd8806f863a1657afb569d24fc` |
| `verified-worker`   | `ca817313dcef5f81b9d0efff79a4a119189d33e7a85862e0bb5dcaa3c80fb1e0` |
| `linux-ubuntu20.04` | `772c054d81d4f91caebc1a418fad5bc030c70530025bb864d52b76d3b20a7ffb` |
| `linux-debian12`    | `a1d8843f65c57fa85e997e540d83bd3cf777b762d02c9c0cde9097b10323a129` |
| `linux-musl`        | `c1aa7ae7b518333564002e9aa7234c56e07aa766c4acb2555f47e21a047bc5d7` |
| `windows-x64`       | `6beb7dd93f745b39fce26d02cfd2911db1cbe7db7f7bb55a7e0e3d694eda21f5` |

## 在线发行归档 SHA256

| 文件                                         | SHA256                                                             |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `coc-0.6.20-linux-x86_64-debian12.tar.gz`    | `19f364e1600a802708d8d47c2827ae8c17cc6c6ad7f1ef3a627f28a12c3969a5` |
| `coc-0.6.20-linux-x86_64-musl.tar.gz`        | `393da26c75d977da6c4f2aa2e54fb404a4478ce9223af596d84572b1d701f87d` |
| `coc-0.6.20-linux-x86_64-ubuntu20.04.tar.gz` | `a2ea712bb70ec1e0fa76df574b32df4516b13bbb06754bf84d3a1660e0334231` |
| `coc-0.6.20-windows-x64.zip`                 | `7acc455a36c873bcc3d4ac6471629871868a4317f1072ade6ca7242e7783a9a2` |
| `codex-over-cloudflare-0.6.20-source.tar.gz` | `9021ef3c92afd30249ab3794756160e4bb6c5048253528397f9febedb2eaa2c5` |

## 证据与限制

原始证据位于忽略目录 `.local/deploy-cloud/43241338652/`，发布日志 `.local/relay-fix-release.log`；本机测试日志 `.local/relay-fix-full-tests.log`、`.local/relay-fix-opaque.log` 和 `.local/relay-fix-lint.log`。下载中断后由脚本重试续传，所有最终制品摘要一致。

生产分析未取得历史堆栈，因此本次仅确认修复本地可复现的代码缺口，不宣称已证明全部历史脚本异常的根因或修复 Cloudflare 平台内部错误。未对用户生产会话发送测试任务或调用模型；发布后长期异常率仍需观察。诊断日志仅含阶段与错误码，不包含原始异常文本或底层堆栈，不能替代完整平台诊断。

本文件为发布后的证据补充；线上制品源码身份仍为上述功能提交。
