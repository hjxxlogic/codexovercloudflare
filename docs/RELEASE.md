# 发布操作

## 0.5.12 发布要求

Worker、网页与四平台原生包配套发布，保留原凭证和 DO 数据，不增加 DO 类迁移。客户端控制接口新增 202 / operationId，旧控制客户端明确提示升级；新 Agent 要求 Relay hello 的 demand:1。先部署 Relay / 网页，再升级原生程序；旧 Agent 仍可保留原心跳作为兼容连接，不纳入无周期流量验收，新的 probe 需要升级 Agent。

下载产物全部就绪后，管理员可 POST `/api/v1/admin/releases`，内容为 `{version,commit}`。服务端核对已部署下载清单身份、协议与全部归档存在后提交幂等版本通知；Agent 再按原下载来源、完整性及空闲安装规则处理。相同版本 / 提交不重复通知，不同提交复用版本拒绝。普通发布保留 OWNER_SECRET，不轮换用户密钥，不替换远端已有服务。

`autoUpdate.intervalHours` 兼容解析但废弃；回滚会恢复旧版本的周期通讯。回滚前保留数据库与旧二进制，不删除 epoch、lease、请求身份、结果或完整历史。平台 24 小时休眠、费用与跨网络静默断链属于单独报告的验收边界。

## 0.5.11 已发布：Linux musl 全静态版

源码 `59bb0de`、标签 `v0.5.11`；[Actions 40317904673](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40317904673) 四平台、sanitizers、完整 regression 和发布门禁全部通过。Worker `7fff05b9-5611-478d-8529-050295520b66` 于 2026-10-26 UTC 11:59:04 上线，流量 100%。新增 `coc-0.5.11-linux-x86_64-musl.tar.gz`，保留 Ubuntu 20.04 / Debian 12 动态包及 Windows x64 ZIP；站点、Worker、四平台包、源码和在线手册来自同一标签。

五个归档、线上资源、实际 musl TLS 与浏览器验证通过；保留生产 vars、secrets 和 Durable Object 数据，未操作既有主机会话。发布后证据另行提交，不改写源码标签或归档；详情见 [测试记录](TEST_REPORT.md)。

> 0.5.10 已发布并部署：源码 `ccc3a28`、标签 `v0.5.10`，GitHub Actions 三平台、sanitizers 和完整浏览器回归全部通过。Worker `44ee79fc-ec0a-4f6e-98c5-5163e16a26ec` 于 2026-10-26 UTC 11:25:48 上线，流量 100%。产物身份、归档、线上资源与浏览器验证见 [测试记录](TEST_REPORT.md)。此前 0.5.9 因 CI 门禁失败未正式发布。

## 0.5.10：代理、实例名称与管理员 Tab

本轮发布包含 HTTP CONNECT / SOCKS5 代理、本地与私网绕过、TUI 转接和默认端口修复、实例显示名及管理员五个 Tab。先升级 Worker / 网页，再使用新版原生名称同步；已有凭证和数据库保持兼容，不重新授权。运行中的 Agent 修改名称或代理后需重启。

使用匹配 `v0.5.10` 标签的 GitHub Actions 三平台原生包及站点产物部署。版本、提交、源码摘要和归档校验和必须一致；实际发布身份及线上验证见测试记录。


0.5.8 已发布：源码 `caca2b8`、标签 `v0.5.8`，Worker `3925ec98-8742-4b73-bab4-dc97e71ceb16`。三个平台包、源码、网页和在线手册已同步更新；Actions 全部门禁及线上资源字节校验通过，详细证据与验收边界见 [测试记录](TEST_REPORT.md)。

## 已部署网页更新：管理表格与会话自动批准

待授权、已授权设备、唤醒配置和 API Key 使用原生表格，手机端局部横向滚动；按行保留审批、目标锁定、保存及撤销操作。CW 同时增加显式开启、仅当前会话有效的自动批准，包含命令、文件及本轮额外权限；服务器审批策略保持权威。此更新属于网页 / 在线手册更新，已完成本地与 Actions 的完整门禁。源码 `1d2f526`，Worker `ec890616-6aa8-46f7-bfa7-bfe8029727e7` 于 `2026-10-26T13:02:48.210861Z` 部署，流量 100%；保留 v0.5.11 原生下载与来源身份。线上字节、安全检查及生产 Chromium 验证通过，详情见 [测试记录](TEST_REPORT.md)。

## Actions 发布流程

推送干净提交后由 `.github/workflows/checks.yml` 执行构建测试，包括常规回归、ASan/UBSan、Ubuntu 20.04 / Debian 12、Linux musl 全静态版和 Windows x64。推送匹配 package.json 的 `v` 版本标签后，只有全部作业通过才运行发布作业；`scripts/assemble-release.py` 核对各平台版本、提交、源码摘要、协议与归档 SHA256，组装网页和下载目录并上传 GitHub Release。下载 Release 的 `coc-VERSION-site.tar.gz` 后，用已认证的 Wrangler 将该站点与同一提交的 Worker 部署；Actions 不持有 Cloudflare 凭据，也不自动部署生产。

新增 `linux-musl` artifact，发行归档为 `coc-<版本>-linux-x86_64-musl.tar.gz`，与既有动态包并存。使用 `Dockerfile.musl` 的 Alpine 3.23 工具链及 `-DCOC_STATIC_MUSL=ON` 构建，容器内 CTest / 原生登录、Ubuntu 宿主启动及 musl 默认更新选择回归通过后上传。干净源码下执行 `python3 scripts/package-release.py --build-dir build-musl --platform musl` 打包；打包检查两个程序均为 x86_64 ELF，拒绝 PT_INTERP 动态加载器及 DT_NEEDED 共享库依赖（允许静态 PIE 的自重定位动态段），确保没有动态加载器或共享库依赖。正式组装现在要求四个平台均通过身份和 SHA256 校验，缺少 musl 产物也不能发布。新增包的实际发布以下载清单为准。

Linux 构建使用按目标隔离的编译缓存，musl 工具链额外使用 Docker 层缓存；未命中时正常编译。缓存不跳过来源生成、链接、打包校验或测试，正式发布仍以当前标签完整门禁通过为准。配置和缓存失效方式见 [开发说明](DEVELOPMENT.md)。

升级原生程序获得登录轮询恢复、外部输出补全和完整默认配置；Relay 同步升级获得批准结果重取。Windows 原生审批仍要求显式配置连接原 Codex 的同一个本机 WebSocket app-server，不能将既有独占 stdio 会话事后转移审批。

## 1. 发布内容与升级

生产网页 / API：`https://r.xlogic.cc`；下载页：`https://r.xlogic.cc/downloads/`。

当前版本 0.5.12 开发预览版，实际部署结果以 [测试记录](TEST_REPORT.md) 为准。Worker 与网页一起发布；原生包只包含 `coc-agent` / `coc-client`，不再包含 `coc`。提供 Ubuntu 20.04、Debian 12 的 Linux x86_64 动态链接包、Linux x86_64 musl 全静态包、Windows x64 静态依赖 ZIP、源码包、提交 ID 和 SHA256 校验和。

2026-10-25 网页修复：“加载更早内容”完整保留已加载消息，不再按 400 条 / 192 KiB 裁剪。此次仅更新网页及在线手册，随 Worker 一起部署；继续提供原生 0.5.2 的既有发行包、源码归档和校验清单，无需升级 Agent / CLI。

同日网页更新：连接设置移至会话记录面板顶部，向上滚动到消息区顶部附近时自动异步加载更早内容，保留阅读位置、手动加载及失败重试。仍沿用原生 0.5.2 发行包，部署时同步更新在线手册。

同日功能菜单更新：默认 CW 模式，管理员模式集中管理登录 / 退出、设备授权和 API Key；菜单底部切换按钮保持可达，切换保留 CW 会话与草稿。授权链接直接进入管理员模式，权限继续独立校验。本次仅发布网页及在线手册，原生下载保持 0.5.2，无需升级 Agent / CLI。

同日 CW 授权流程更新：申请填写设备名称和留言，无需服务器标识；管理员查看留言并明确选择服务器后批准。Worker / RegistryDO 与网页需同步部署，旧网页发起的待处理申请也需管理员选择服务器，已发放凭证继续有效。在线手册同步更新，原生下载继续提供既有 0.5.2 归档，无需升级 Agent / CLI。

从 0.3.x / 0.4.x 升级保留现有授权和配置；双向历史通道需要同时更新 Agent、CC、Worker 与网页。Agent 不再按历史总量或时间自动清理正文；升级前已删除的数据不能恢复。CW / CC 缓存位于各自设备，不是云端副本。从 0.2.x 升级属于不兼容的认证升级。旧 Agent / 客户端凭证和旧管理员 Cookie 不再接受，所有者密钥保留。原生程序需要更新，A 自行重新申请网页批准的登录，CC / CW 对目标 A 分别申请。systemd 改用 `coc-agent run --config ...`。迁移步骤见 [用户手册](USER_GUIDE.md)。项目配置与 SQLite 格式保留，不自动迁移宽权限令牌。

0.5.3 将同样流程扩展到 CC：配对登录新增 `--message` 且不再要求 `--host`，管理员必须选择服务器；API Key 固定绑定不变。需同步发布 Worker / RegistryDO、网页、在线手册和两个平台的新原生包。已有 CC 凭证、Agent 配置和数据库保持兼容；旧 CC 发起的配对申请也需管理员重新选择服务器，不能再由旧申请的 hostId 决定绑定。

0.5.3 发布源码为 `b6f9c0d`，标签 `v0.5.3`；Worker 版本 `6f8083b8-cfc0-4423-b3e6-bd04003cb99f` 于 2026-10-25 UTC 00:53:48 发布至自定义域名，流量 100%。两个平台包与源码归档均绑定该干净提交；实际下载 CC 的线上留言 / 审批 / 隔离 / 撤销验证通过，证据见 [测试记录](TEST_REPORT.md)。

0.5.4 已于 2026-10-25 UTC 01:38:34 发布，源码 `ba0f254`、标签 `v0.5.4`，Worker 版本 `db1fb52b-5758-4a5b-b01f-c147b2331e0a`，流量 100%。网页、Worker、在线手册、Ubuntu 20.04 / Debian 12 原生包与源码归档同步更新；线上资源校验、实际下载程序、临时授权、确定性流式历史及多块文件传输验证通过，详见 [测试记录](TEST_REPORT.md)。

0.5.5 已于 2026-10-25 UTC 02:18:34 发布，源码 `8da4085`、标签 `v0.5.5`，Worker 版本 `58969fbd-0d20-4bb8-adf7-e52aa68dc53b`，流量 100%。两平台原生包、网页、Worker、源码及在线手册同步更新。线上实际下载程序的启动 / 运行审批提示、CC / CW 批准与拒绝、目标与角色隔离、Cookie 刷新及撤销验证通过；临时设备已清理，详见 [测试记录](TEST_REPORT.md)。

0.5.6 已于 2026-10-25 UTC 02:41:49 发布，源码 `672e5f4`、标签 `v0.5.6`，Worker 版本 `cf6537ae-7597-485b-ad9f-6ff5ce39032a`，流量 100%。Worker、网页、在线手册和 Ubuntu 20.04 / Debian 12 原生包同步更新；线上资源与三个归档的校验和一致；实际下载程序的管理员配置、离线 GET / 限流、CW 自动唤醒、CC 等待上线及目录恢复验证通过，临时授权已清理。唤醒功能及验证边界见 [测试记录](TEST_REPORT.md)。

2026-10-25 CW 聊天路径下载更新：仅发布网页及在线手册，随 Worker 一起部署。对话中的项目内文件路径可单击下载，复用现有 CW 文件接口、20 MiB 上限与版本校验；沿用 0.5.6 原生下载、源码归档及校验清单，Agent / CLI 无需升级。部署源码提交及线上验证结果记录于测试记录。

本次网页发布源码 `3856260`，Worker 版本 `60d4a34d-5b75-46ce-93b9-a343d99090a8` 于 2026-10-25 UTC 03:30:33 部署至 `r.xlogic.cc`，流量 100%。网页与在线手册已更新，两个平台原生包和 0.5.6 源码包的 SHA256 保持一致；实际线上下载验证及验证边界见 [测试记录](TEST_REPORT.md)。

2026-10-25 CW 刷新恢复会话更新：仅发布网页和在线手册，随 Worker 一起部署。浏览器按授权身份保存上次项目、会话元数据，并在验证已授权主机后自动恢复；沿用已有 IndexedDB 存储，不迁移服务端数据，Agent / CLI 及原生下载保持 0.5.6。部署身份及线上刷新、草稿和离线缓存验收见测试记录。

本次会话恢复网页发布源码 `9bf7f4b`，Worker 版本 `fe350e29-82eb-49f3-82f2-1cea3090b10b` 于 2026-10-25 UTC 03:46:28 发布至 `r.xlogic.cc`，流量 100%。网页、在线 UTF-8 手册及原生归档校验通过；实际会话恢复和验证边界见 [测试记录](TEST_REPORT.md)。

## 2. 验证与打包

2026-10-25 中文 / English 网页更新：本次仅部署网页和在线手册，新增菜单底部语言选择、刷新保留及即时切换，并修复消息已在顶部时继续上滚加载历史。现有 0.5.7 原生包、源码归档、下载清单和校验和保持不变，无需升级 Agent / CLI。发布源码提交、Worker 版本及线上验收另记入测试记录，不重写 `v0.5.7` 标签。

该网页更新源码为 `c74a06c`，Worker 版本 `3c3ad45a-6c5d-4fe2-9485-1ab550bcc1eb` 于 2026-10-25 UTC 14:39:48 部署，流量 100%。真实线上浏览器的双语切换、刷新、标签页同步与管理员登录入口检查通过，完整验证边界见测试记录。

完成原生构建、CTest、Vitest、TLS、真实 Wrangler / Chromium 集成、类型与格式检查，以及 Worker dry-run，并提交源码。集成测试须包含角色与目标 A 隔离、多授权、单次领取、长期凭证及撤销已有连接。

```bash
npm run build:native
npm run build:web
python3 scripts/package-release.py --build-dir build --platform ubuntu20.04
docker run --rm --init -v "$PWD:/workspace" coc-local-test sh -c \
  'cmake -S . -B .local/build-container -DCMAKE_BUILD_TYPE=Release && cmake --build .local/build-container -j 2'
python3 scripts/package-release.py --build-dir .local/build-container --platform debian12
```

不要在宿主与容器之间共用 CMake 构建目录。用 `ldd` 检查目标二进制依赖；用户需对应 OpenSSL、Boost.System、SQLite3、libstdc++ 和 CA 证书。源码包来自当前 HEAD，不包含秘密、状态或构建缓存。

发布文件位于忽略的 `dist/web/downloads/`。`build:web` 会保留既有下载目录；发布新版本时仍须重新生成两个平台包和源码包，核对下载清单及校验和。 `apps/web/public/_headers` 保证在线 Markdown 返回 `text/plain; charset=utf-8`。

## 3. 生产配置与部署

`wrangler.jsonc` 绑定账号和自定义域名，关闭 workers.dev / preview。发布前通过 Wrangler whoami 确认账号，保留已有生产 OWNER_SECRET。

首次配置时使用独立随机所有者密钥，至少 32 字符；`.local/production/owner-secret` 与 `.local/production/secrets.json` 权限均为 0600，不提交。不要打印或在命令参数中传秘密。普通代码部署保留云端 secrets：

```bash
node node_modules/wrangler/bin/wrangler.js deploy \
  --tag v0.5.7 --message 'Release 0.5.7 external Codex session history and queue'
```

只有初始化或明确轮换密钥时才追加 `--secrets-file .local/production/secrets.json`。

## 4. 发布后验证与记录

验证健康检查、首页、未登录业务请求返回 401、跨域管理登录返回 403；在线手册需核对 UTF-8 响应头、浏览器实际字符集及文档字节。下载两个发行包与源码包，校验 SHA256、包内容只有两个运行程序，并在匹配系统执行 help。

生产授权冒烟只使用明确标记的临时设备和独立凭证文件：申请临时 A，在真实管理网页核对并批准，验证下载的 A 登录；再为该 A 授权 CC / CW，验证各自作用域及管理员接口拒绝。测试后只撤销本次创建的临时授权，不能操作用户真实设备。测试不调用模型；不宣称覆盖生产 Codex 会话与长期负载。

记录实际 Worker 版本、发布源码提交和验证边界到 `docs/TEST_REPORT.md`。创建 `v0.5.7` 标签指向发布源码提交；有远程仓库时推送提交和标签。发布后的证据文档可另行提交，不改写已发布的源码提交。

DO 休眠唤醒、跨网络会话、部署断线和长期压力另行验收。

## 稳定化发布门禁补充

打包脚本关闭 Python 字节码缓存生成，避免自身导入使干净源码变脏；同时拒绝包含未跟踪文件的脏源码，并运行 Agent/CLI `--version` 核对提交、版本、协议和 sourceDigest。必须在目标发行版或兼容容器内验证二进制，不能把无法执行的跨平台产物当作已验证。下载清单含源码摘要；这绑定本地构建输入，不代替签名或第三方可验证构建证明。

`build:web` 保留 downloads；发布候选仍必须检查所需平台包和 SHA256SUMS 全部存在。新增 CI 不执行部署。发布前完成 [实施记录](stabilization-2026-10-24.md) 中尚未执行的长稳、DO 重建/升级、预发布安全头、备份/回滚与客户端版本组合检查。未关闭的门禁写入发行说明，继续使用开发预览版定位。

管理员所有者密钥轮换会使旧管理会话失效；通知管理员重新登录。项目规范化根目录不能重复或重叠。升级前使用在线备份工具保存权威数据库并保存旧二进制；旧版不认识新分块表，回滚读取必须先核对内容兼容性，不能直接回退并宣称新消息仍完整。

### 0.5.1 升级说明

本次为稳定化开发预览发布，保留尚未完成的验收事项：八小时压力、真实平台休眠/升级/回滚、磁盘耗尽/掉电、Firefox/WebKit、手机键盘和屏幕阅读器。sanitizer 首次异常无可用堆栈，重建后通过，原因尚未定位；短时基准未完成目标负载，不能作为吞吐承诺。

Worker、网页及下载的 Agent/CC 必须配套升级。旧 Agent 未完成 protocol 1 构建/能力协商时，新中继返回 AGENT_NEGOTIATING 而不创建进程。既有项目重复或父子根目录需先合并配置。普通部署保留已有 OWNER_SECRET 和 DO 数据，不清空注册或撤销用户设备；本次不会代替用户升级已有服务器服务。

### 0.5.2 原生自动更新发布要求

两个平台包都必须重新生成，清单 version/commit/sourceDigest/protocol 必须与实际程序一致；SHA256SUMS 保持标准双空格文件名格式。更新器只接受比当前版本新的稳定三段版本及相同协议，不从旧版本自动引导到 0.5.2。发布前运行 `test:update`，干净构建另运行 `tests/native-update.py --automatic` 验证实际安装和 Agent 重启；发布后核对线上三个归档与手册。安装目录需运行用户可写，systemd 模板已改为 `/home/coc/.local/bin`。显式 `update` 可越过自动开关；普通自动失败不影响原业务结果。

### 0.5.4 性能与完整本地历史

同步发布 Worker、网页、在线手册、Ubuntu 20.04 / Debian 12 Agent/CLI 及源码包。完整历史窗口和已展开正文不截断，浏览器长期缓存已读页/正文并优先从本地读取。Agent 批量事务和文件执行器、新版网页的四块传输、Relay 去重订阅与鉴权优化需配套升级。上传窗口为可选能力，旧 Agent 继续串行上传；原授权、配置、SQLite 与 IndexedDB 数据兼容，无需重新登录。

已有 Agent/CLI 沿用自动更新配置；发布不直接改动远程主机服务。上传完成记录新增部分表达式索引，首次打开较大缓存库可能花费更多时间。升级前按用户手册备份权威数据库；去重身份和完整历史不自动删除。继续保留八小时长稳、真实平台休眠/升级、慢盘控制延迟及原生 CLI 平台发送缓冲的验收边界，详情见 [性能修复记录](perf-fixes-2026-10-25.md)。

### 0.5.5：Agent 批准指定目标的 CC / CW

需要发布 Worker、网页和新版原生程序。已有 Agent / CC / CW 凭证及 API Key 无需重新授权，也不迁移数据库。旧客户端的未指定申请继续由管理员选择；旧 `hostId` 输入仍忽略。新 CC `login --host` 与新 CW 目标输入发送 `requestedHostId`，旧 Relay 未返回目标时直接报兼容错误，因此先更新中继，再使用客户端新功能。使用 `requests / approve / reject` 及启动 / 运行审批提示的 Agent 需升级；其他 Agent 服务可继续运行旧版。Agent 立即后台检查，并每 30 秒检查新申请，去重提示且不自动批准；审批接口暂不可用不会阻止服务运行。实际部署身份和线上验收结果见测试记录。

### 0.5.6：离线 Agent 唤醒

同步发布 Worker、网页、在线手册、Ubuntu 20.04 / Debian 12 的 Agent / CC 和源码包。主机记录新增可选唤醒配置及按主机持久化的一分钟限流，无需迁移授权或 SQLite 数据。管理员可在服务器离线时配置、覆盖、禁用或恢复 Agent URL；旧 Agent 省略字段不清除云端配置。需要先更新 Worker，再使用新网页或原生唤醒功能。既有服务沿用自动更新配置，发布不直接替换用户服务。

中继访问 HTTPS 唤醒 URL，不携带客户端凭证、不跟随重定向；网络服务接受请求不等于服务器实际开机。发布后仅使用临时测试主机验证配置接口、角色隔离、离线唤醒 / 限流、客户端等待和上线刷新，不唤醒已有用户主机。真实硬件休眠 / 开机和长期负载继续属于验收边界。

### Windows x64 包

新增 `coc-<version>-windows-x64.zip`，在 Windows x64 上使用 `x64-windows-static` 构建并执行 `ctest -C Release` 后，以 `--platform windows-x64` 打包。打包拒绝脏源码、来源不匹配及错误目标；清单与 SHA256SUMS 同时识别 `.zip` / `.tar.gz`。Windows ZIP 包含两个 `.exe`、示例配置、手册及静态依赖的许可证通知，无 systemd 单元。默认从 `build-windows/vcpkg_installed/x64-windows-static/share/*/copyright` 收集许可证，使用其他安装目录时传 `--dependency-dir`。第三方库和 MSVC CRT 静态链接；不得将依赖未收齐的动态构建标为官方 ZIP。

合并各平台下载时须核对 version/commit/sourceDigest/protocol 相同，并重新生成最终清单与 SHA256；CI artifact 不等于线上发布。Windows 当前不自动更新或重启升级，也不注册 Windows Service，用户停止 Agent 后校验并整包替换。现有 Linux 自动更新不会选择 Windows ZIP。


## 0.5.7：外部会话

配套发布 Worker、网页、三个平台原生包和源码。配置 externalSessions.allowQueue 默认关闭；新表 external_items 自动创建，不修改原 Codex 数据或授权。先更新 Agent / Worker 才能使用观察和队列。原客户端必须支持 Codex 0.164.0 队列 API，执行与审批由其负责。Windows 包只使用 GitHub Actions 已验证的产物，不在本地构建或执行。


### 0.5.7 无人值守审批补充

同步发布新增共享服务审批接入。allowApprovals 默认关闭；需原 session 所属 app-server 可通过私有 Unix socket 或本机 WebSocket 访问。Windows 使用本机 WebSocket。禁止将只读历史进程冒充原审批通道；无法接入的独立 stdio 会话明确提示限制。发布验证分别覆盖真实 Codex 协议和生产 Relay 上的临时 fixture，不调用真实模型或接管用户已有会话。
