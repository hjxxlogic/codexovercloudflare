# 发布状态：0.5.14

更新时间：2026-10-29。Worker、网页、在线手册及四平台原生下载包已部署。

- 源码 `25a6bc80dc35a2d01a4d940d21abddbcca7f737d`，源码摘要 `64397a6eaa22dbaa87a283eaaa8b304010388325cec9b2533aee32f4b507b2e0`。
- [Actions 40710590901](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40710590901) 已完成且成功：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必要作业全部通过；分支 publish-release 正常跳过。
- 部署目标 `https://r.xlogic.cc`，初次 0.5.14 部署的 Worker 版本 `ac25bf62-6f91-45fe-90fd-9189a49e0a6a`。通过 `scripts/deploy-cloud.py --commit HEAD --publish-downloads --apply` 使用 CI 产物部署，逐一验证 GitHub artifact SHA256 和来源身份，未使用本地构建代替。
- 下载清单已更新为 0.5.14，包含 Ubuntu 20.04、Debian 12、Linux musl、Windows x64 和源码包；线上五个归档均重新下载并核对 SHA256。源码归档采用已核验的 Ubuntu 产物，与发行合并脚本的规范选择一致。
- health 返回 `ok: true`、version `0.5.14`、protocol `1`；首页、JS / CSS、手册、下载清单与校验和均与暂存 CI 资源逐字节一致。未登录 hosts 返回 401，跨域管理登录返回 403；首页 200 且包含 CSP。

保留生产 vars / secrets 和 Durable Object 数据；未直接替换或重启现有 Agent 服务，未创建 GitHub Release，未操作用户会话或调用模型。未验收真实 Cloudflare Access 浏览器邮箱登录、长期稳定性和实际模型任务；本次保留现有 Access 配置，不能据此认定边缘 Access 已启用。

[部署、CI、产物摘要及线上包校验和](assets/release-0.5.14/deployment.json)。完整本机日志保存在忽略目录 `.local/deploy-cloud/40710590901/`。

## 后续 Access 登录修复验收

公钥获取修复源码 `e717628` 的 [Actions 40805956178](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40805956178) 六项必需作业全部成功。用户手工更新 Worker 后恢复网页入口；随后恢复经过 CI 摘要核验的网页产物，修正旧 `dist/web` 覆盖自动管理员登录界面的问题，并保留已验证的 0.5.14 下载包。用户于 2026-10-29 确认管理员权限已恢复；此项为真实浏览器的用户确认，后续手工发布的 Worker 版本 ID 未另行采集。详见[修复与验收记录](TEST_REPORT.md)和[网页恢复证据](assets/access-jwks-2026-10-29/frontend-restore.json)。
