# 发布操作

## 制品与来源

正式制品由 `.github/workflows/checks.yml` 构建。推送干净源码后，等待准确提交的完整 Actions 成功，逐项检查 regression、sanitizers、Ubuntu 20.04、Debian 12、musl 和 Windows x64。本地构建用于开发，不能替代已验证发行制品。

发行包含 Worker、网页、在线手册、Ubuntu 20.04 / Debian 12 动态包、Linux x86_64 musl 静态包、Windows x64 ZIP 与源码。包内只提供 `coc-agent` / `coc-client`。版本、提交、源码摘要、协议和归档 SHA256 必须一致。

匹配 `package.json` 的 `v` 标签在全部门禁通过后运行发布作业；`scripts/assemble-release.py` 核对各平台来源和 SHA256，组装下载目录及 GitHub Release。Actions 不持有 Cloudflare 凭据，不自动发布生产 Worker。

## 发布云端

使用已提交脚本准备、核验和部署；不要以手工拼接命令替代其保全及校验。

```bash
# 只准备：等待 CI、下载、验证制品和现有下载站
python3 scripts/deploy-cloud.py --commit HEAD --run-id ACTIONS_RUN_ID

# 发布同一运行的 Worker / 网页，保留现有原生下载
python3 scripts/deploy-cloud.py --commit HEAD --run-id ACTIONS_RUN_ID --apply

# 同时发布同一提交的四平台下载
python3 scripts/deploy-cloud.py --commit HEAD --run-id ACTIONS_RUN_ID --publish-downloads --apply
```

脚本校验完整 Actions 门禁、GitHub artifact 摘要和干净来源，以 CI 保存的配置上传 Worker / 网页；发布前后保全并逐包校验下载站。线上网页、脚本、样式、手册、清单、校验和及健康接口需要核对。

只支持 RegistryDO / HostRelayDO 原生存储，保留现有 namespace、class migration 和数据；不提供数据库后端切换或迁移接口。默认保留线上普通变量；确需让配置替换普通变量时使用 `--replace-vars`，先确保配置列全仍需变量，Secret 保留。不要因默认域名而推断获准部署。

共享 Access Token 轮换需更新原生程序与 Cloudflare Service Auth；Worker 不保存此 Token。`OWNER_SECRET`、CoC Key 和设备凭据继续保密。入口与策略见 [Access 说明](cloudflare-access-coc-auth.md)。

需要通知自动更新时，在全部下载验证后加 `--notify-release --owner-secret-file /absolute/private/owner-secret`。通知只触发检查，不代表 Agent 已安装；安装仍等待空闲。需要删除已废弃 Secret 可显式重复 `--delete-secret NAME`。下载快照恢复可使用 `--preserved-downloads /absolute/path/downloads`，仍须逐包 SHA256 校验。

## 部署 Linux systemd 用户服务 Agent

```bash
# 默认只准备，不改变服务
python3 scripts/deploy-agent.py --commit HEAD \
  --ssh ubuntu@server --binary /opt/coc/coc-agent

# 推送干净 HEAD、等待完整 CI 和目标空闲，再备份安装与验证
python3 scripts/deploy-agent.py --push --commit HEAD \
  --ssh ubuntu@server --binary /opt/coc/coc-agent --apply
```

当前脚本支持公开 GitHub 仓库的 linux-musl Agent 制品；目标需要 Python 3、现有 systemd 用户服务和日志权限，执行端需要 Python 3、curl、SSH/SCP 及可用认证。TLS 与 SSH 主机校验保持启用。项目 remote 名为 github 时可指定 `--push-remote github`，仍校验 URL、不 force-push。

本机用户服务用 `--local` 代替 `--ssh`。`--service` 默认 `coc-agent.service`；`--binary` 必须为 MainPID 对应的现有绝对路径。默认等待 CI 2400 秒、空闲 1800 秒；指标缺失、过期或存在 runtime / 历史读取 / 文件请求不能当作空闲。

脚本检查准确提交及所有必需作业，验证 GitHub artifact SHA256、包内校验和和候选程序 version / commit / sourceDigest / protocol / clean。安装前备份实际运行的 `/proc/MainPID/exe`，原子替换后默认观察 120 秒，检查 PID、运行来源、Relay 握手和连接错误；失败尝试回滚。配置、凭据、SQLite 和备份保留，不替换 CLI。

空闲检查是近期指标快照，不能与新任务形成原子互斥；部署窗口应停止提交新任务。重启活动会话必须明确授权 `--allow-restart-active`。Agent 更新不包含 Worker 发布或 GitHub Release 授权。

## 配套升级与回退

Relay / 网页先部署，再让新版原生程序连接；业务只接受 `delivery:2`，Terminal 要求 Agent 上报 `streaming:2`。配置、凭据、项目目录与历史独立备份，保留未知请求身份，不导入不兼容缓存任务。稳定 Agent 身份和请求准入代次分别处理，不能因更新或过期自动重放副作用。

运行实例不会因下载包已发布而自动完成升级。Linux 按自动更新策略等待会话和读取结束；Windows 停止程序后手动替换整包，保留配置和状态。

回退前停止实例、备份当前状态并核对升级后的副作用。新存储不能直接交给不兼容二进制；需要匹配整套组件及一致备份。项目登记权威为 `dataDir/projects.json`，不应使用配置内的初始化数组覆盖当前目录。SQLite 恢复不恢复 Codex 进程或项目文件，见用户手册的备份操作。

## 显式例外与证据

只有用户明确授权跳过 CI 时，才使用 Agent 的 `--local --local-build` 或云端 `--local-build`；默认仍要求干净 HEAD，校验构建来源、备份、空闲和验证，记录 `ciVerified=false`，不能作为 CI 验证发行包。若用户同时明确要求不提交源码，可加 `--allow-uncommitted`；仅允许本地构建，保留真实 `dirty=true`、基准 commit 与完整源码摘要，构建前后源码身份必须相同。不会执行提交、推送或 Actions；现有下载保留，Agent 部署仍等待空闲并支持回滚。

云端 `--cloud-only-after-windows-failure` 只用于用户明确要求的分阶段发布：运行已完成、Windows 为唯一必需失败项、其余全部成功，保留下载且不通知更新。`--skip-native-platform linux-musl` 同样只用于明确批准的暂缓平台，保留其已验证下载并标注限制，不把部分发行冒充完整发行。

部署工具可在干净后继提交使用修复后的工具发布祖先提交 CI 制品，分别记录部署工具与代码来源；不得重新本机构建冒充既有制品。

机器证据默认在 `.local/deploy-cloud/`、`.local/deploy-agent/`。完成实际部署后，按仓库要求记录准确 commit、Actions URL/结果、artifact/包摘要、目标、验证和限制；私有配置与凭据不写入公开记录。源码现状、下载版本和正在运行版本分别核对。

## 运行状态格式

发布前必须核对待使用的状态是否符合当前格式：SQLite 结构完整且 `user_version` 为 `0` 或 `1`、项目目录含完整日志、浏览器 `commandAccounting:2`，DO 到期索引完整（`expiryMigration` 不存在或 `pending:false`）。本项目不提供旧库迁移或配置别名转换；有效无邮箱网页授权保留显式认领入口；不满足时返回格式或升级错误，部署脚本不转换这些业务状态。结构完整的未标记库直接读取，不修改版本；缺列的库不自动升级。具体错误见用户手册。

## 当前线上版本

### 0.6.7 完整部署准备（2026-11-05）

用户要求更新云端 Worker / 网页、四平台下载和本机 systemd Agent。部署源码包含 `dc5a2c5dd22ed32a8587c082f829d1423c79caac` 的 Agent 常驻重试修复。本次走完整 CI 门禁，不沿用此前直接构建例外；成功 CI 制品准备完成后先部署云端，再等待本机 Agent 空闲安装，不中断活动会话。

原 master 提交带有 `[skip ci]`，没有匹配的成功运行；尝试手动 dispatch 被 GitHub 令牌权限拒绝（HTTP 403）。通过本次发布准备文档提交的正常 push 触发 Actions。其它架构分支的成功运行不作为本次部署制品。此段只记录准备状态，实际部署提交、Actions、摘要与验证结果在部署后补齐。

首次运行 `41956523532` 的 Windows 原生登录测试在清理临时数据库时失败：Python SQLite 事务上下文不会关闭连接，Windows 拒绝删除仍打开的文件。测试改用显式关闭连接的上下文，保留事务提交及不修改不支持数据库的断言；修复后重新推送并运行完整门禁，不使用失败运行的制品部署。

用户进一步要求在发布前修复 master 授权复核期间丢帧的问题；待部署提交还将包含有界排队及相关回归，之前成功或正在运行的提交均不能代替最终提交门禁。核查 opaque 分支的两个问题及 master 的差异见 [授权复核审查](AUTHORIZATION_REVIEW_2026-11-05.md)。

同次回归的原生 delivery 测试仍按 15 秒等待畸形中断消息后的重连，小于新版固定 30 秒重试间隔。该重连断言改为等待最多 45 秒，仍要求新的 capabilities 握手，且保留拒绝畸形请求、不消耗序号、不写命令和取消标记的验证；其它操作超时不变。

2026-11-04 10:21（北京时间），`https://r.xlogic.cc` 的 Worker / 网页已直接发布授权刷新竞态修复，源码提交 `ddb83cb6637b8a8ef56a40e0e7793d96e2b189b8`，版本仍为 `0.6.7`。用户明确授权“跳过 github action，直接部署”；使用 `scripts/deploy-cloud.py --commit HEAD --local-build --apply`，干净来源 `dirty=false`、`ciVerified=false`。没有 Actions 运行或 URL，不作为 CI 验证发行制品。源码已推送 origin 与 GitHub，提交含 `[skip ci]`。

| 构建或制品           | 身份 / SHA256                                                      |
| -------------------- | ------------------------------------------------------------------ |
| 源码摘要             | `8aaaadc904423d7d594ff9dcac88bd777ae980ec0f5f24683af94c785bde4f90` |
| Worker Version ID    | `0c4458c6-4b89-466e-ba86-fc84c58966c1`                             |
| Worker bundle SHA256 | `3d50bd742f92e9e287f49505a6619a7e9b72fcdc5b6da38fe5c21578ef0dc364` |
| 网页入口 SHA256      | `e41265b8bdaa83376b019a669a8fbfe47455ab119975e11dfd45e78206b2a961` |

部署脚本验证健康接口、69 个静态资源、网页入口、在线手册、下载清单及校验和与准备制品字节一致。既有下载包与 DO 存储配置保留，未发布原生下载、GitHub Release 或更新通知。首次经本机代理尝试在下载保全阶段因 TLS 连接失败退出，尚未上传；改用直连后部署及校验成功。

10:22 启动此前已退出的本机 `coc-agent.service`，沿用原程序、凭据和数据，未安装 Agent 二进制或重启活动实例。10:23 真实 Access 状态验证健康接口、管理主机目录、邮箱授权恢复、3 个项目及首批 100 条会话记录查询通过，未调用模型。截至该快照，14 台有效主机中 7 台有中继连接，7 台仍离线；仅本机完成启动，其余离线实例尚未恢复，不将部署成功当作全部主机恢复。

本地 Vitest 499/499、类型检查、Lint 与 Worker dry-run 通过。机器证据在 `.local/incident-2026-11-04/`，部署来源及文件摘要在 `.local/deploy-cloud/local-ddb83cb6637b8a8ef56a40e0e7793d96e2b189b8-8aaaadc90442/deployment.json`；具体故障链和限制见 [事故记录](INCIDENT-2026-11-04.md)。

### 上一次部署

本次发布前，Worker / 网页已部署审核提交 `589c26b45ed62c74c8610b26fbc48f9b1c42f4e5`，版本为 `0.6.7`。按用户明确授权使用干净 HEAD 本地构建，`dirty=false`、`ciVerified=false`。GitHub Actions dispatch 被当前令牌拒绝（HTTP 403），没有对应成功运行或 Actions URL；本次构建不能作为 CI 验证发行制品。

| 构建或制品           | 身份 / SHA256                                                      |
| -------------------- | ------------------------------------------------------------------ |
| 源码摘要             | `38fe9b59d0e6561dec3ccbddbd6de5028a21364d384f880bd30bdca33cf315f9` |
| Worker Version ID    | `b2c999e6-12de-47f5-959d-70232ff6b7d3`                             |
| Worker bundle SHA256 | `7defb0533db96f974ffabdb0565d5eb878c849cdb5dee671015c5cb7a3f273aa` |
| 网页入口 SHA256      | `e41265b8bdaa83376b019a669a8fbfe47455ab119975e11dfd45e78206b2a961` |
| 待安装 Agent SHA256  | `ce5a2d8655a75084ced7e55555d5c42b2bff1961f8b10859bfed799d524d30ff` |

部署脚本核对健康接口及 69 个静态资源、在线手册、下载清单与校验和的字节一致性。真实 Access 登录状态验证共 13 项 API / 页面步骤通过，包括邮箱授权恢复、主机在线、项目、邮箱专属会话目录、旧会话历史、线程目录、Terminal streaming:2 及旧 HTTP 字节操作拒绝；桌面和手机截图已保存，浏览器无页面错误。本次没有调用模型或提交测试任务。重新构建后的 CTest 11/11、Vitest 492/492 和 Worker dry-run 通过；审核时类型、Lint、协议一致性及 35 项部署工具检查通过。

Linux Agent 候选程序已构建并验证准确提交与摘要。既有 systemd 用户服务仍有 2 个活动 runtime；部署脚本等待空闲 180 秒后退出，未安装、未重启。运行 Agent 保持此前 `0.6.7` 本地构建：基准提交 `c3ffef94afd3bd09c0598df2d19aa0697b463d0c`、源码摘要 `1057fdcd349956a6c3dc51d9d1940e2bb10a416ae212bb33bb9058e69cbaee9c`、`dirty=true`。候选程序不代表已安装；继续部署须等空闲，或取得中断活动会话的明确授权。

配置、项目目录及 SQLite 已备份，未转换存储。原有下载包保留：Linux 和源码 `0.6.6`、Windows `0.6.5`；未发布 GitHub Release 或发送自动更新通知。其它 Agent 不在本次升级范围。

机器证据与私有备份位于忽略的 `.local/deployment-589c26b/`；部署脚本证据位于 `.local/deploy-cloud/local-589c26b45ed62c74c8610b26fbc48f9b1c42f4e5-38fe9b59d0e6/` 和同名 `.local/deploy-agent/` 子目录。
