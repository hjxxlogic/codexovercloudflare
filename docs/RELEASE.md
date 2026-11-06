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

## 独立 r2 测试站

`--target r2` 固定使用 `codex-over-cloudflare-r2` 与 `r2.xlogic.cc`，两个 DO 类仅绑定这个 Worker 的独立 namespace；不修改默认 `wrangler.jsonc` 或旧站路由。r2 必须明确指定新 Access 应用的 `--r2-access-aud AUD`，或经授权选择 `--r2-without-access`（仅 CoC 身份与权限）。不沿用旧站 AUD 或 owner secret。

首次部署须准备权限为 0600 的独立 owner secret 文件，并用完整 CI 制品初始化下载站：

```bash
python3 scripts/deploy-cloud.py --commit HEAD --run-id ACTIONS_RUN_ID \
  --target r2 --r2-access-aud AUD --publish-downloads --initialize-downloads \
  --initialize-owner-secret-file /absolute/private/r2-owner --apply
```

仅 Worker / 网页配置中的目标与 Access audience 按显式参数选择；业务代码和四平台包仍必须来自同一完整成功的 Actions。首次初始化只用于新站，后续省略两个 `--initialize-*` 参数以保全原有下载和 Secret；r2 的证据、缓存均与默认目标分开。

线上测试复用本地加密端到端套件，固定请求 r2，启动一个临时独立 Agent，使用临时配置、SQLite 和项目，结束时只撤销测试授权并停止自己的子进程：

```bash
npm run test:opaque -- --online-r2 \
  --agent /absolute/verified-ci/coc-agent \
  --owner-secret-file /absolute/private/r2-owner
```

r2 部署脚本的在线检查还需设置 `COC_ACCESS_CONFIG=/absolute/private/r2-access.json`，使私有配置明确允许 `https://r2.xlogic.cc`。它与浏览器测试的 `--access-config` 分别传递，默认生产配置只允许旧站 origin；不要改写生产配置或把入口凭据发送到其他域。

Access 开启时另传 `--access-config /absolute/private/r2-access.json`，文件须包含 r2 精确 origin 与获准用于该入口的 Service Auth 凭据；原生 Agent 经主入口验证，测试浏览器的 HTTP / WebSocket 同样携带机器入口凭据且仅放行 r2 域请求；网页设备配对测试走现有 `/guest/` 入口，不将 Service Auth 冒充邮箱用户，邮箱登录须另行验证。测试不会安装二进制、调用 systemd 或读取既有 Agent 数据。结果和桌面、手机截图写入忽略的 `.local/r2-deployment/`；模拟 Codex 不调用模型。

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

发布前必须核对待使用的状态是否符合当前格式：SQLite 结构完整且 `user_version` 为 `0`、`1` 或 `2`、项目目录含完整日志、浏览器 `commandAccounting:2`，DO 到期索引完整（`expiryMigration` 不存在或 `pending:false`）。本次支持结构完整的 SQLite 0/1 单向迁移到 2，不提供配置别名转换；有效无邮箱网页授权保留显式认领入口；不满足时返回格式或升级错误，部署脚本不转换这些业务状态。新版写入端将结构完整的 0/1 库升级到 2；缺列的库不自动升级，旧版程序不能读取升级后的库。具体错误见用户手册。

## 当前线上版本

独立测试站 `https://r2.xlogic.cc` 的 Worker / 网页及下载包为 `0.6.7`，源码为 `a61423f4f1cbd82b018dbcf3f29c1ac2acb43859`。该准确提交的六项必需 CI 作业全部成功，使用经过来源与摘要校验的 CI 制品部署，`ciVerified=true`。线上健康、静态资源、下载包及隔离端到端验证通过，详见 [r2 部署记录](R2_DEPLOYMENT.md)。

本次仅部署 r2。旧站 `r.xlogic.cc` 和既有本机 Agent 保持独立，未由此升级；两者运行身份不能从 r2 版本推断。测试 Agent 为临时进程，测试后停止并撤销授权。

### r2 仅更新网页

已有明确的本地预览授权时，可用已验证的 r2 `deployment.json` 保留线上 Worker 执行制品，只重建网页：

```bash
COC_ACCESS_CONFIG=/private/r2-access.json python3 scripts/deploy-cloud.py \
  --local-build --target r2 --commit HEAD \
  --r2-access-aud R2_ACCESS_AUD \
  --web-only-from .local/deploy-cloud/PREVIOUS-r2/deployment.json --apply
```

线上回读的全部下载包 SHA256 与 CI 制品一致：

| 文件 | SHA256 |
| --- | --- |
| `coc-0.6.7-linux-x86_64-debian12.tar.gz` | `b1ccb683ba25c4bced558359c01964543da93e66b8cafa614b756b03d1445c01` |
| `coc-0.6.7-linux-x86_64-musl.tar.gz` | `d7c7f776162b3229e6b0d942730c4958dbafa3d64679fa45096fdc98c11778f9` |
| `coc-0.6.7-linux-x86_64-ubuntu20.04.tar.gz` | `dd84b7f6816237e074a5e11fa38a01ea2e58a3d76502bd1d16551768d8fdace3` |
| `coc-0.6.7-windows-x64.zip` | `be63cb6d16c87950e61c09dcedfa305b780ebaddd97c0b40454e143719b94e8c` |
| `codex-over-cloudflare-0.6.7-source.tar.gz` | `814e94f3764af434029573c01f92d0bf59c90135a4806d37b3aee86788e1f7bc` |

部署脚本逐字节核对网页入口、69 个静态资源、在线手册、下载清单和 SHA256SUMS，再下载核验四平台及源码的全部 5 个归档；健康接口报告 `ok=true`、`version=0.6.7`。部署后仓库线上验证脚本的 HTTP / WebSocket 准入边界检查通过。

本机 Agent 安装前再次确认空闲，备份实际运行二进制并安装同一运行的 musl 制品；120 秒观察内 PID 稳定、Relay 握手完成、没有脚本检查的连接错误，运行 version / commit / sourceDigest / protocol / clean 身份匹配。配置字节和 3 个项目身份保留；私有配置、项目日志和 SQLite 已备份，完整性及当前格式检查通过，不执行迁移，不使用 --allow-restart-active。

本次生产已登录浏览器检查未完成：保存的登录态访问 /auth/email 返回非 JSON 的 Access 响应；CI 浏览器测试已通过，不将其当作已登录生产验证。opaque 分支的两项问题已复现但未修改，该分支不在本次部署中；master 的全 Host 广播及失败重试机制保留，详见 [审查记录](AUTHORIZATION_REVIEW_2026-11-05.md)。未发布 GitHub Release 或发送自动更新通知，其他运行 Agent 未由本次脚本安装。

公开来源、各 artifact ID、摘要、在线验证和本机安装结果见 [部署证据](assets/release-0.6.7-2026-11-05/deployment.json)。私有备份与日志在 `.local/release-0.6.7-20261105/`，脚本原始证据在 `.local/deploy-cloud/41961015104/` 与 `.local/deploy-agent/41961015104/`。


### 发布准备与门禁修复过程（2026-11-05）

用户要求更新云端 Worker / 网页、四平台下载和本机 systemd Agent。部署源码包含 `dc5a2c5dd22ed32a8587c082f829d1423c79caac` 的 Agent 常驻重试修复。本次走完整 CI 门禁，不沿用此前直接构建例外；成功 CI 制品准备完成后先部署云端，再等待本机 Agent 空闲安装，不中断活动会话。

原 master 提交带有 `[skip ci]`，没有匹配的成功运行；尝试手动 dispatch 被 GitHub 令牌权限拒绝（HTTP 403）。通过本次发布准备文档提交的正常 push 触发 Actions。其它架构分支的成功运行不作为本次部署制品。此段只记录准备状态，实际部署提交、Actions、摘要与验证结果在部署后补齐。

首次运行 `41956523532` 的 Windows 原生登录测试在清理临时数据库时失败：Python SQLite 事务上下文不会关闭连接，Windows 拒绝删除仍打开的文件。测试改用显式关闭连接的上下文，保留事务提交及不修改不支持数据库的断言；修复后重新推送并运行完整门禁，不使用失败运行的制品部署。

用户进一步要求在发布前修复 master 授权复核期间丢帧的问题；待部署提交还将包含有界排队及相关回归，之前成功或正在运行的提交均不能代替最终提交门禁。核查 opaque 分支的两个问题及 master 的差异见 [授权复核审查](AUTHORIZATION_REVIEW_2026-11-05.md)。

同次回归的原生 delivery 测试仍按 15 秒等待畸形中断消息后的重连，小于新版固定 30 秒重试间隔。该重连断言改为等待最多 45 秒，仍要求新的 capabilities 握手，且保留拒绝畸形请求、不消耗序号、不写命令和取消标记的验证；其它操作超时不变。

### 此前云端直接部署（2026-11-04）

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

本机 Agent 与 CLI 同步部署可在 `scripts/deploy-agent.py --push --push-remote github --local --binary /absolute/path/coc-agent --apply` 增加 `--client-binary /absolute/path/coc-client`。该选项仅接受 CI 产物及已有本机 CLI：先完成 Agent 空闲等待、安装和连接验证，再从同一份已校验摘要的 CI 归档提取 CLI，核对源码身份，备份并原子替换；现有 CLI 进程继续使用原 inode，新命令使用新版。CLI 验证失败尝试恢复备份；若 Agent 已成功而 CLI 失败，命令返回错误，需按部署证据分别核实，不将两者视为原子事务。

## 2026-11-06 CW 只读历史恢复本地部署

用户明确授权跳过 GitHub Actions，使用 `scripts/deploy-cloud.py --commit HEAD --local-build --apply` 从干净提交 `a4e2b2b11548bf684bd96102bbffbcf7c1daf9e5` 构建并部署 Worker / 网页到 `https://r.xlogic.cc`，包含 `9580dcb` 的跨设备接管后只读历史恢复修复。未触发 Actions，无 Actions URL，`ciVerified=false`，不作为 CI 验证发行制品。既有原生下载保留，未更新 Agent 或发布更新通知。

Cloudflare 版本 ID：`a103c4dd-f5b8-4a82-a19d-3329129339b5`。源码摘要：`a232fb336e093df79a27e7e51ce86e678c8e67ab05f8412101b88ca8d923b9bb`；网页入口 SHA256：`bec7a9c07bf9f37868e6b3f2b0ec1b2bac0ba1c6ff08ea3660310f816b4d35bf`；Worker 构建文件 SHA256：`646c78d341437ca9e1931925e252c53bf2cc75a50cc7a6a4a778892a1a0ffeee`。

本地网页构建、类型检查及 Worker dry-run 通过。部署脚本核对线上网页、静态资源、在线手册、下载清单与校验和字节一致；健康接口 `ok=true`、版本 `0.6.7`、协议 `1`。跨设备恢复的模拟浏览器回归已通过，未进行线上真实手机/电脑长稳测试。机器证据位于 `.local/deploy-cloud/local-a4e2b2b11548bf684bd96102bbffbcf7c1daf9e5-a232fb336e09/deployment.json`，日志位于 `.local/cw-observer-deploy.log`。
Cloudflare 将代码和静态资源绑定为一个版本，因此仍产生新部署版本。此模式不编译 Worker，复用原 Worker 制品和原配置，保留线上变量、Secret、原生下载及下载说明 / 主题。发布前后从 Cloudflare 读取线上可执行模块并与原制品核对 SHA256；Wrangler 会规范化调试 source map，因此 source map 不计入执行代码不变校验。只允许 r2 `--local-build`，拒绝变量替换、Secret 删除、首次初始化、原生发布与更新通知；Web 来源和保留的 Worker 来源分别记录，`ciVerified=false`。仅适用于前后端接口兼容的网页变更。

## 不透明中继的状态迁移准备

本次 0.6.14 仅集成与验证，不执行云端、下载、Agent 更新或 tag 发布。生产操作仍须完整执行 OPAQUE_RELAY_MERGE_PLAN.md 第 7 节。

HostRelayDO 的首次访问迁移沿用 namespace/object identity；每批至多 64 键，以同一事务写入 `~opaque-v1:backup:<旧键>`、读回验证、删除旧键并推进 `~opaque-v1:cursor`。wakeUntil 保留原键并备份；完成后标记 channelVersion=1 与 complete，取消旧 alarm。旧连接全部退休，旧 lease/ticket/项目写锁不能恢复资格。权限操作 pending 时拒绝该批；不得通过手工改完成标记绕过未决副作用核对。RegistryDO 不转换身份、主机、授权、撤销、到期与失效重试键，其现有 alarm 继续负责重试。

迁移备份仅供受控恢复：发布窗口必须导出并核对旧对象状态及未决请求，禁止将备份交回旧 Worker 后直接开放写入。未访问对象首次访问也须完成迁移。只有相应对象完成且实际业务验证通过后才能登记为已验收。本次没有线上存储枚举、快照导出或生产迁移证据。
