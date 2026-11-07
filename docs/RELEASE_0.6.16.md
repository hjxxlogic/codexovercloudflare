# 0.6.16 Linux 下载发布记录

2026-11-07 按用户明确要求跳过 GitHub Actions，本地构建并发布 Linux 修复包，保留原 Windows 下载。目标：[主站下载页](https://r.xlogic.cc/downloads/)。

- 原生源码提交：`f35edb7b635d32a3b98d3c75aa677cec5e1f39dc`（干净工作树）；修复 HTTP / WebSocket 使用代理前强制本机解析目标域名的问题。
- 源码摘要：`1c7a6ed3db8726fd93807498a7982b760de01bebcd481c75231572f39b3fe9f9`；协议版本 1。
- Actions：未触发，无对应本次发布的 Actions URL / 成功结果；`localBuild=true`、`ciVerified=false`。
- 构建：rootless Docker、Alpine 3.23 / GCC 15.2，完全静态 musl；三个 Linux 下载入口使用同一二进制，打包时校验静态 ELF 与构建身份。
- Windows：保留 0.6.15，提交 `54e210ce04b686b818283d629bb0a8f1e6d8180f`，ZIP 字节与发布前 SHA256 相同；尚未包含本次修复。
- 发布脚本：`scripts/deploy-downloads.py --deployment .local/deploy-cloud/local-3d84f4036a78046f270376ddef24329a8eea0538-f4e6336e6676-web-only/deployment.json --local-build-dir build-musl-0.6.16 --apply`。
- Cloudflare 版本 ID：`13340dd4-f6a6-44dd-a178-3426a0b24beb`。

## 验证

本地常规回归通过 15 项 CTest、37 个 Vitest 文件 / 400 项测试、类型及格式检查。musl 容器回归通过 14 项 CTest，PTY 因容器缺少 bwrap 跳过，随后在宿主机使用 musl 测试程序补跑通过；musl 注册 8 项、HTTPS / WSS 9 组场景及 Access 专项全部通过，包含 `.invalid` 目标域名、代理认证、远程 TUI、未知 CA 和错误证书主机名拒绝。发布工具测试包含本地入口不访问 Actions、原 Worker / 网页复用、脏源码拒绝与 CI 状态记录。

发布后脚本重新下载清单、手册和全部归档，逐项核对 SHA256，结果 passed。前后 Worker 模块摘要均为 `aa9dcf461dc8e05c88c0543a8ed9aefa6c4b59affd657bea1bc5f147a1033438`。主站健康正常，网页 HTML、JS、CSS 和主题资源与原部署字节一致；网页 / Worker 版本仍为 0.6.15。未安装或重启任何 Agent，未发送自动更新通知。

机器本地证据位于 `.local/release-0.6.16/` 和 `.local/deploy-downloads/local-f35edb7b635d32a3b98d3c75aa677cec5e1f39dc/`，不提交凭据或本地状态。

## 发布归档 SHA256

| 文件                                         | SHA256                                                             |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `coc-0.6.15-windows-x64.zip`                 | `36bab4133b6566eabec40003fed7795d6330e77d5179d4a3cec03b6d2a362f74` |
| `coc-0.6.16-linux-x86_64-debian12.tar.gz`    | `8816bfbd15273982d24744e69a96d6aa45f30b0cf7515f4439c1b7f6ed3b5023` |
| `coc-0.6.16-linux-x86_64-musl.tar.gz`        | `6c5bb77d5534e821ca978007a05be93847dfe1d4c558385b8d8f5ffaa927f613` |
| `coc-0.6.16-linux-x86_64-ubuntu20.04.tar.gz` | `40a995808c5823042bb1253cebe3d9ea39d0561ce3868ecea769ee3d168fad3f` |
| `codex-over-cloudflare-0.6.16-source.tar.gz` | `d85ce8e20b003ba67b3709e0880480f322d8aca3d329dcaa85410e45117b478b` |
