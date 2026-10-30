# 发布状态：0.5.17

## 单 Agent 多项目管理 · 2026-10-30

源码 `269859e32efe50e7809cbacb622eb7a2becfe01c` 的 [Actions 41022113021](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41022113021) 六项必需作业全部成功：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64。首次提交 e56d55f 的新端到端测试暴露同页配对链接切换问题，修正后整套 CI 重新通过；没有部署失败运行的制品。

通过 `scripts/deploy-cloud.py --publish-downloads --apply` 校验六份 GitHub 制品摘要和源码身份，将配套 Relay、CW、四平台原生包及源码包发布到 `https://r.xlogic.cc`。部署 ID `5fae8644-fd9b-4131-b29a-7e54b801be31`，Worker 版本 `fcf72234-bf6e-4792-856b-619ce15e0ad3`，UTC 08:07:11 发布，流量 100%。本次使用分支 CI 制品，未创建 GitHub Release 标签。

线上健康版本 0.5.17；首页、JS、CSS、用户手册、下载清单和校验清单共六项字节一致。四个平台安装包及源码包均已重新下载，SHA256 全部匹配。直连大包下载中断后，使用本机已有 HTTPS 代理完成只读核验，没有重复发布；TLS 验证保留。访客健康接口成功，普通和管理员项目管理入口在无 CoC 凭证时均返回 401 UNAUTHORIZED。

保留原 D1 UUID `3120cc4f-de73-43b2-b2c0-26c3626b6f76`、STATE_BACKEND、Cron、Secret 和授权数据；没有待执行的 SQL 迁移。发布前 D1 私有备份通过 SQLite 完整性检查，该快照不包含活动 DO 状态。本机没有运行中的 Agent / systemd 用户服务；未安装或重启其他主机的 Agent/CC，升级归档已在下载页提供。未在生产修改管理员邮箱或登记项目，相关功能已由准确提交的真实 Worker、原生程序和 Chromium CI 覆盖。

[CI、制品与线上归档校验和、部署身份及验收证据](assets/multi-project-2026-10-30/deployment.json)。私有日志和下载在忽略目录 `.local/deploy-cloud/41022113021/`；备份在 `.local/multi-project-release/private/`。

## Agent 邮箱关联、网页更新通知与 CW 底部刷新 · 2026-10-30

最终云端源码 `97af93b2799bbfc6b617e6f964daa295000243d1` 的 [Actions 40999119690](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40999119690) 六项必需作业全部成功：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64。通过仓库 `scripts/deploy-cloud.py` 校验 Worker / web 制品摘要和源码身份后发布至 `https://r.xlogic.cc`。部署 ID `6957ac12-fda2-4230-b4a9-af5f6ffb53d6`，Worker 版本 `7bbddd2d-b8ea-402b-8578-2fe2378b4409`，UTC 04:02:13 发布并接收 100% 流量。

管理员页新增发布通知按钮，以及每台 Agent 的多个关联邮箱配置；Agent 也可通过本地配置 / 命令提供默认邮箱，管理员可覆盖、清空或恢复默认。使用关联邮箱完成 CW 身份验证的用户自动获得该主机访问权。CW 向下滚动或滑动到底会同步当前会话，合并连续手势，保留草稿与连接，不增加周期轮询。health 已改为读取包版本，线上确认返回 0.5.16。

原生 0.5.16 包来自 `d67186a41e2419a06a1676e770c82c875be20c22` 的 [Actions 40994952207](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40994952207)，该运行六项必需作业同样全部成功，四平台制品经 GitHub 摘要与源码校验后发布；线上四个平台安装包及源码包已逐包下载并核对 SHA256。最终云端部署保留这些原始 0.5.16 包，不改写同版本归档。

线上首页、JS / CSS、手册、下载清单与暂存产物逐字节一致，8 项健康 / 访客 / 未授权入口检查通过。保留原 D1 UUID `3120cc4f-de73-43b2-b2c0-26c3626b6f76`、`STATE_BACKEND=d1`、Cron、Secret 和配置；没有待执行的 schema migration。首次发布前 D1 私有导出通过 SQLite 完整性检查，该快照不包含活动 DO 状态。网络操作使用用户指定 HTTPS 代理并保留 TLS 校验。

未用生产管理员身份提交邮箱修改或实际发送升级通知，相关流程由合成身份的 CI 浏览器 / 服务端回归验证。未重启 Agent、打断活动任务或调用模型；用户可在管理员页通知已启用自动更新的 Agent，Agent 空闲后执行升级。完整摘要、CI / 部署身份、线上验收与限制见[发布证据](assets/agent-email-access-2026-10-30/deployment.json)，私有日志在忽略目录 `.local/deploy-cloud/40999119690/` 及 `.local/deploy-cloud/40994952207/`。

## 活动 DO / 空闲 D1 分层部署完成 · 2026-10-29

源码 `fc89396aedee08eea8110376b5e206a9d72155e1` 的 [Actions 40866589978](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40866589978) 六项必需作业全部成功，涵盖两种模式的完整原生 / Chromium 回归及真实空闲归档、重启和再激活测试。通过该提交的独立干净检出运行 `scripts/deploy-cloud.py`，校验 CI Worker / web 产物 SHA256 和来源后部署至 `https://r.xlogic.cc`；原工作区的追加 CI 文档保留。

部署 ID `c8528db4-1383-49c5-9317-3a6b5defe0b7`，Worker 版本 `b7d06f6b-387d-49b3-866f-b84a227c446d`，UTC 12:02:22 发布并接收 100% 流量。保留原 `STATE_DB` UUID `3120cc4f-de73-43b2-b2c0-26c3626b6f76`、`STATE_BACKEND=d1`、Cron、生产配置和 Secret；没有待执行的 SQL schema migration。原有 0.5.14 下载归档逐包复核 SHA256 后保留。

发布前已将 D1 导出到私有目录，用内存 SQLite 验证完整性通过：5 个 scope、118 条记录，未发现新的 DO 所有权标记。发布后健康、首页 / JS / CSS / 手册 / 下载清单字节一致性，以及 13 项公开入口和未授权 HTTP / WebSocket 检查全部通过。

活动会话状态改由 DO 原生持久存储负责，主机全部连接及在途工作结束、持续空闲 60 秒后分批归档。发布后的只读位置汇总尚无新标记；主机在后续业务请求时惰性接入新机制，本次未强制迁移全部主机、重启 Agent 或重发任务。真实登录 CW 与生产长期稳定性仍需使用中验收。发布前 D1 备份不能代替此后活动 DO 状态的备份，禁止回退到不识别所有权标记的旧代码。

[CI、产物摘要、备份校验、部署和线上验收记录](assets/d1-active-session-2026-10-29/deployment.json)。完整本机证据在忽略目录 `.local/deploy-cloud/40866589978/`，D1 原始导出位于其私有子目录。

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
