# 发布操作

## 1. 发布内容与升级

生产网页 / API：`https://r.xlogic.cc`；下载页：`https://r.xlogic.cc/downloads/`。

当前版本 0.5.6 开发预览版，实际部署结果以 [测试记录](TEST_REPORT.md) 为准。Worker 与网页一起发布；原生包只包含 `coc-agent` / `coc-client`，不再包含 `coc`。提供 Ubuntu 20.04、Debian 12 的 Linux x86_64 动态链接包、源码包、提交 ID 和 SHA256 校验和。

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
