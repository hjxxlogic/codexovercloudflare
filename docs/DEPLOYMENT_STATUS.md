# 发布状态：0.5.14

## D1 握手争用修复部署完成 · 2026-10-29

源码 `b7ef5b7e61b2fcbcbf46b7d5e4dcef13c06889f6` 的 [Actions 40852785403](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40852785403) 已完成，regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必需作业全部成功；分支 publish-release 按预期跳过。通过 `scripts/deploy-cloud.py` 校验 GitHub Worker / web 产物 SHA256 和来源后部署至 `https://r.xlogic.cc`。

部署 ID `314c25a4-a53f-49a8-8b4f-9f1b140cd6a4`，Worker 版本 `9b64f656-5d4a-4269-b28e-c30cde5cb4f4`，UTC 11:01:20 发布并接收 100% 流量。保留 `STATE_BACKEND=d1`、原数据库 UUID 和 Cron；没有待执行的数据库迁移。原有 0.5.14 下载归档逐包复核 SHA256 后保留，未更新原生包或重启 Agent。

健康检查、首页 / 静态资源 / 手册 / 下载清单逐字节核验及 13 项公开入口与未授权访问检查通过。本次降低在线回执和握手的 D1 写入争用，但尚未验收真实登录 CW 握手与长期任务稳定性，不能据此宣称用户此前的连接故障已完全消失。

[CI、产物摘要、部署与验收记录](assets/d1-handshake-2026-10-29/deployment.json)。完整本机证据保存在忽略目录 `.local/deploy-cloud/40852785403/`。

## D1 状态分离及并发连接修复 · 2026-10-29

生产已启用 `STATE_BACKEND=d1`，数据库 `coc-relay-state`（UUID `3120cc4f-de73-43b2-b2c0-26c3626b6f76`），Cron `17 * * * *`。初次部署 `76dde28` 后用户发现 CW 无法连接、`BACKPRESSURE` 和 `Handshake unconfirmed`，不能将最初的健康检查视作稳定性验收。

并发修复 `adbe251` 和回执快照修复 `a744e718389209ac1cf4276d9acc7993910784c0` 已提交。最终 [Actions 40849632526](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40849632526) 六项必需作业全部成功，使用核验 SHA256 / 来源的 CI Worker、web 制品部署。部署 ID `d6384301-7155-4756-9efa-e3b7c2b79648`，Worker 版本 `f8e5ab54-e1aa-4246-8230-b2cf73806963` 接收 100% 流量。后续部署仍须通过 `scripts/deploy-cloud.py --state-db-id 3120cc4f-de73-43b2-b2c0-26c3626b6f76` 保留原绑定。

健康、资源逐字节核验及 13 项公开入口 / 访问隔离检查通过；现有 Agent 凭据的只读请求成功。155 项单元测试、内存临时数据库完整 D1 集成 38 项及 CI 精确源码回归通过。用户确认浏览器仍不稳定，继续减少在线写入与确认争用，原待确认任务缺失请求编号，不能断言执行结果；未重发任务或重启 Agent。

已导出生产 D1 到私有目录，并用内存 SQLite 验证可读取；没有取得旧 DO 原始导出，只保存平台元数据 / 恢复时间依据。Registry 和已访问主机自动迁移；Host 对象 36 个，有数据对象从发布前 27 个变为 25 个，不代表历史对象全部清理。未用 owner 凭据执行全量分页迁移；在线对象等自然断开后清理，不按 opaque ID 删除对象。保留原有授权、配置、运行任务和已验证 0.5.14 下载包，未发布原生包或安装 Agent。

[CI、制品、两次部署、核查及限制](assets/d1-relay-2026-10-29/deployment.json)。完整私有证据在忽略目录 `.local/deploy-cloud/40849632526/`、`.local/d1-rollout/`。

## CW 访客入口与邮箱登出部署完成 · 2026-10-29

源码 `a99c36b3b1a90b6987594db94cbfc5b5900027e3` 的 [Actions 40822368692](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40822368692) 六项必需作业全部成功：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64。通过 `scripts/deploy-cloud.py` 核验 CI Worker / web 产物摘要及来源后部署至 `https://r.xlogic.cc`。部署 ID `fe6fc35e-d59c-4851-b977-70e734dfef9e`，Worker 版本 `d076bdd2-96a5-4b3b-b219-fe9242caecd1` 接收 100% 流量。

CW 邮箱身份菜单已添加登出；`/guest` 提供完整访客流程，资源、API、WS 使用访客前缀及隔离 Cookie；`/downloads` 前缀公开。线上 13 项无 Cookie / Token 请求检查通过：访客重定向保留查询参数，页面、资源及下载清单 / 手册与暂存产物逐字节一致，邮箱接口确认访客无需邮箱；未授权访客 hosts、设备管理、身份和 WS 请求返回 401 `UNAUTHORIZED`，普通 API 继续受 Access 保护。健康检查通过。

未修改 Cloudflare 边缘策略；既有公开规则已通过上述匿名请求验证。真实浏览器邮箱登出未在线执行，菜单显示条件、中英文和精确跳转目标由 CI Chromium 测试覆盖；完整访客配对、WS 订阅及撤销由隔离 workerd 集成覆盖，未写入生产配对数据。保留生产配置、Secret、Durable Object 数据和原有 0.5.14 下载包；下载快照逐包复核 SHA256，未重新下载线上归档，未发布新原生包或重启 Agent / Client。

[CI、产物摘要、部署与线上验收记录](assets/guest-cw-2026-10-29/deployment.json)。完整本机日志保留在忽略目录 `.local/deploy-cloud/40822368692/`。

## Access 准入职责分离部署完成 · 2026-10-29

源码 `1d22f4562e376fafbf979b184638900f15bf7e35` 的 [Actions 40815244914](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40815244914) 已完成，regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必需作业全部成功。通过 `scripts/deploy-cloud.py` 核验 Worker / web 产物 SHA256 和来源后部署至 `https://r.xlogic.cc`；使用此前已核验的下载快照恢复并逐包复核 SHA256，保留原有 0.5.14 下载包，不使用本地构建替代 CI 产物。

Worker 已移除共享 Access Token JSON、两个 Secret 变量和 Client 请求头二次校验，仅使用已验证 JWT 的邮箱关联用户授权；Cloudflare 独立负责 Service Token 准入。两个遗留 Worker Secret 已删除，`OWNER_SECRET` 保留。最终部署 ID `ed367f6a-f388-4504-a594-2fd66234e9e3`，版本 `33f8c194-b76b-49c5-8ea8-fb8c75ba3a79` 接收 100% 流量。

健康接口 HTTP 200；首页、JS / CSS、在线手册及下载清单逐字节匹配暂存产物。携带有效入口 Token 但无邮箱的请求访问邮箱接口返回 403 `ACCESS_USER_REQUIRED`；无效 CoC API Key 登录返回 401 `UNAUTHORIZED`，说明入口通过不会授予 CoC 权限。未重新验收真实浏览器邮箱登录，也未安装 / 重启远端 Agent / Client 或发布新版原生下载包。新的原生代码及内置轮换凭据已由同一次 CI 构建验证，已有运行程序仍须另行更新。

用户明确授权仅在 `AGENTS.md` 豁免 `config/cloudflare-service-token.json` 并提交轮换值；其他密钥不在豁免范围内。两条独立 Access 策略（普通用户 `Allow`、服务 `Service Auth`）及环境变量覆盖已写入用户指南。

[CI、产物摘要、部署和线上验收记录](assets/access-admission-2026-10-29/deployment.json)。私有诊断保留于忽略目录 `.local/access-diagnosis/`。

## 2026-10-29 Service Token 配置发布

按用户轮换后的本地配置执行 `python3 scripts/deploy-access-token.py --apply`，成功同时更新 Worker 的 `CF_ACCESS_CLIENT_ID` 与 `CF_ACCESS_CLIENT_SECRET`。Cloudflare 部署 ID 为 `61b6147a-4690-418b-ae73-a4e80ecf01ff`，版本 `f3012699-dee7-48de-806e-b5a49b20cd95` 已接收 100% 流量。此项仅发布运行时 Secret，未构建或替换代码 / 下载产物；代码来源与 CI 验证沿用下述记录，不产生新构建摘要。轮换后的密钥没有提交。

发布后携带新凭据访问 `/api/v1/healthz` 和 `/api/v1/auth/email` 仍返回 HTTP 302，未跟随重定向；因此凭据发布成功，但 Access 入口尚未通过验收，不能宣称 Agent 已恢复。现有 Agent 凭据未修改、进程未重启。私有诊断与部署记录位于忽略目录 `.local/access-diagnosis/`。

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
