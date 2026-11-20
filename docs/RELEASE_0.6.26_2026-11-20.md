# 0.6.26 发布（2026-11-20）

CW 新建项目使用目录向导。获得对应主机访问权的用户可以浏览远程目录、创建子目录和登记项目。改名和取消注册仍需管理员权限。

- 生产站点为 [r.xlogic.cc](https://r.xlogic.cc)，Cloudflare 版本为 `87684857-1d0f-4ebb-b0f7-99e0801eb191`。
- 发布提交为 `502df2f4c73650fff5baf62c7702ba40c83a1743`，源码摘要为 `a8634d9618483132b9efbdf14c12f6e10fdaa8076aaa96f4f4f54832c3568f81`。
- 六项必需作业均通过。[GitHub Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/44655102122)
- 网页、Worker 与四平台下载来自该次 CI。线上健康接口报告 0.6.26，静态资源逐字节比对通过，下载归档重新下载并核对 SHA256。
- 本机 Agent 的会话结束后，等待中的脚本已安装并启动 0.6.26。收到用户将本轮范围限定为主站和下载包的指令后停止脚本时，安装已经生效。只读核对确认服务处于运行状态，进程的 SHA256 为 `59e90f1167943a2b06caaa0d12d7ef6c63e1930de9119d701bfc39a3f5b6e4fc`，与 CI 制品一致。脚本的 120 秒连接验收已中断。其他主机的安装状态未逐台确认。

| 线上归档                                     | SHA256                                                             |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `coc-0.6.26-linux-x86_64-debian12.tar.gz`    | `02d8bdeda7cb84c4361c882b27f9e766d769143bf9cdf7052b2c5de12ac8bd3b` |
| `coc-0.6.26-linux-x86_64-musl.tar.gz`        | `5746d6dd5b98fc028286198cb2bad8d866cbfb2afdcaeabce80dd58186dba64b` |
| `coc-0.6.26-linux-x86_64-ubuntu20.04.tar.gz` | `7189434e2398f0f5bff3d488cfa61a7e845f04508e03db11087f59ebe707e2eb` |
| `coc-0.6.26-windows-x64.zip`                 | `9b3898aeab3f2ea99be97d5986d772ce7a08e1117af686ad800fbf568d39a22a` |
| `codex-over-cloudflare-0.6.26-source.tar.gz` | `b2fa64a1de80617503db199758efd5652d6a761d27b304daddeaa2d8b784e698` |

部署证据保存在忽略的 `.local/deploy-cloud/44655102122/` 和 `.local/deploy-agent-0.6.26/44655102122/`。
