# 0.6.19 发布记录

2026-11-12 发布生产站点与四平台下载，修复 CW 交付分配失效后停留在错误状态，以及会话标签初始化时重复打开同一会话的问题。

## 来源与检查

- 部署源码：`969a26cd6e67e04cf811b85460081236dd64bf1b`；版本 `0.6.19`，协议 1，干净源码。
- 源码摘要：`5b9e8d2f300e6a16515ea519ed57bd14309de4dc814afd3746318f20df62fe2c`。
- [Actions 43203487927](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/43203487927)：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必需检查全部成功。未以本机构建替代 CI 产物。
- 本机浏览器 E2E（`--skip-tui`）、完整 UI 套件、最终 Web 构建、类型与相关格式检查通过；完整 TUI 和端到端由同一提交 CI 验证。

## 云端部署

- 目标：`https://r.xlogic.cc`；Worker `codex-over-cloudflare`。
- 使用 `scripts/deploy-cloud.py --commit 969a26cd6e67e04cf811b85460081236dd64bf1b --run-id 43203487927 --publish-downloads --gh-proxy --apply`。
- Cloudflare 版本 ID：`7efa14de-e7d0-4eef-948f-4e14aa18a8c3`。
- 健康接口返回 `ok=true`、`version=0.6.19`；网页、脚本、样式、在线手册、清单及校验和与准备产物字节一致。四平台安装包与源码已重新下载并核对 SHA256。
- 保留原有配置、凭据、Durable Object 与数据；部署为新功能补充 SETTINGS KV 绑定。未发送自动更新通知，未创建 GitHub Release。

## 本机 Agent 状态

- 目标：本机 `coc-agent.service` 及配套已安装 CLI。候选来自同一 CI 的 musl 包，版本和源码身份已核对。
- 候选 Agent SHA256：`c5cfc909d41572162bb904d795d18c3043383376d5998bbb3656182bf38639ab`。
- 本机更新尚未执行：空闲检查发现 3 个会话实例，安装脚本正在等待；运行版本仍为 `0.6.18`。未使用 `--allow-restart-active`，未重启或中止这些会话。配套 CLI 尚未替换。

## Artifact SHA256

| Artifact            | SHA256                                                             |
| ------------------- | ------------------------------------------------------------------ |
| `verified-web`      | `1d75cefa4a9456e7698b034757bb586be7f143b6e4d0d070be70f32fc8434849` |
| `verified-worker`   | `53e8e04c279190a5a60798905ba87feb01a8ed2d8ad84fbd80f44ce34b0a2caf` |
| `linux-ubuntu20.04` | `86d257f5cb5db9b00aa5d463d027687ccac991c98b1797a70fd5777da90aee18` |
| `linux-debian12`    | `c5ce04511ec3ca02aea7dff84461fefe9e835295c304ea8284ff336a81c43dea` |
| `linux-musl`        | `0acbf4c2186a217177112acbad111ff4ce2847d7e0efb5afd898680c5879da95` |
| `windows-x64`       | `b08b6ae5b89a258d96307922d2082455a1f55287d7aa9d79fc96001ec3e1c2b3` |

## 在线发行归档 SHA256

| 文件                                         | SHA256                                                             |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `coc-0.6.19-linux-x86_64-debian12.tar.gz`    | `80aab1bfbcbd4914f3eade122f4bfafed0cba45d4d0e246ed7b13785fbec0c6c` |
| `coc-0.6.19-linux-x86_64-musl.tar.gz`        | `54014818bc10c08e3885d053327eb0a5803faffadc55e56fd5a37ff944b2024c` |
| `coc-0.6.19-linux-x86_64-ubuntu20.04.tar.gz` | `978bcdfb89db71d4a1531d89cf4700e96d568216745371dbf2ad844b58f4d10b` |
| `coc-0.6.19-windows-x64.zip`                 | `9928cdb7dea7975ea764b36cf62c794a154e0d6917b0b25c42e3918b8ccc3e14` |
| `codex-over-cloudflare-0.6.19-source.tar.gz` | `2f791283fdff4f92432216e3335663a450b754de99218d6a58f2b85b3814904b` |

## 证据与限制

机器本地证据保存在忽略目录 `.local/deploy-cloud/43203487927/`、`.local/release-0.6.19/` 及相应发布日志；不提交凭据、数据库或用户会话内容。传输切换中的不完整文件被摘要校验拒绝后重新下载，最终采用的全部产物与 GitHub 摘要一致。

未对用户报告的生产会话发送测试命令，也未在生产环境调用模型验证。浏览器需刷新后加载新版本；本机 Agent 空闲更新完成前，服务端的活跃分配保留修复尚未安装。存在未确认命令时保持错误并要求核对结果，避免自动重发产生重复操作。
