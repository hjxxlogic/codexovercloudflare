# r2 发布记录

当前测试站为下述 2026-11-10 部署。后续章节保留 2026-11-05 至 2026-11-06 的历史来源、摘要和验证边界，不能作为当前在线授权或主机清单。

## 2026-11-10：邮箱自助授权与独立测试站恢复

按用户明确要求“无需等待 github action，直接部署”，通过 `scripts/deploy-cloud.py --local-build --target r2 --preserved-downloads … --initialize-owner-secret-file … --apply` 发布干净源码 `a41a0a86ade831ba6c9307ebfbd1d79750dec06a`，源码摘要 `68e9628c48c6d7007900bcd356eb36c5ae44e2c62e4c2f41662c1955463e62c8`。功能提交为 `a25701279ceea8fe11b281bda9195c3904f662bd`；后继提交增加已删除测试站的本地快照恢复能力。当前 Worker / Web 为 `0.6.18`；本次没有 Actions 运行与 CI 制品，明确记录 `localBuild=true`、`ciVerified=false`。最终 Worker Version ID（初始化独立管理密钥后）为 `466ff270-0d71-4736-8d50-e784cfc5008b`。

发布前 Cloudflare 上已不存在 `codex-over-cloudflare-r2` Worker 与 `r2.xlogic.cc` 自定义域绑定，因此本轮新建独立 Worker、RegistryDO / HostRelayDO namespace 与 SETTINGS KV，并恢复原 r2 独立管理密钥。不导入生产 DO、旧 Agent 凭据或本机数据；删除前的 r2 设备授权没有恢复。Access 继续使用原 r2 audience 与团队入口；未修改生产路由或 Access 策略。原生下载从已保存、逐包 SHA256 重新核对的 `0.6.18` CI 快照恢复，来源为 [Actions 42565345127](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42565345127)，源码 `76c7056d0589ea7a4345a2ce404e3f060d83e558`；本次未重新构建或通知原生更新。

邮箱自助授权默认关闭。平台管理员在普通邮箱入口登录，进入管理员模式 → 待授权请求 → 邮箱自助授权，勾选“允许同邮箱免管理员审批”后保存到 KV。普通 Service Token 请求该设置的 GET / POST 均返回 `401`；无邮箱的原生自助批准返回 `403`。使用真实 CoC 管理凭据经既有访客管理路径读取确认 `{enabled:false, configured:true}`，验证会话已登出；没有模拟线上邮箱或替用户打开开关。匿名访问普通网页已核对为跳转 Cloudflare 邮箱登录，下载清单可匿名读取；既有边缘策略仍拦截匿名 `/guest/` 请求并跳转邮箱登录，本轮未改变该策略。正常网页邮箱登录与真实用户首次注册仍需人工验收。

部署脚本的健康检查及公开静态资源字节核对通过；独立检查确认线上 SETTINGS KV 已绑定、r2 DO 与生产 namespace 分离。生产 Worker 版本发布前后均为 `e3946585-3e47-43c2-975e-60c215a72628`，配置与绑定一致；没有安装、停止或重启本机 Agent。源码完整 lint、418 项 Vitest、本地浏览器流程、构建及 Worker dry-run 已通过；部署恢复专项现为 21 项通过。

Worker 执行文件 SHA256 为 `827d6ee38af0cc80ccc202023e09b29943843b980f84ccf7f5dbb670de0326bb`；网页入口 SHA256 为 `a8a9b6b3ede2c64cae29917d1139cb90b68c28873cacf3ad1603604344fcecfc`。完整公开摘要和原生下载校验和见[部署证据](assets/email-self-service-r2-20261110.json)。原始版本、配置、请求结果及部署日志仅存忽略目录 `.local/r2-email-self-service/` 与 `.local/deploy-cloud/local-a41a0a86ade831ba6c9307ebfbd1d79750dec06a-68e9628c48c6-r2/`；不提交入口 Token、管理密钥或会话凭据。

## 2026-11-06：真实用户数据库副本在线验证

按用户要求，将真实数据库副本连接 r2。普通重新配对会生成新主机 ID，旧会话 ID 则包含原主机前缀；离线 Store 升级通过不代表新身份能读取旧历史。因此新增 owner 专属的缺失主机身份恢复：保留原 ID、签发全新 Agent Token，不导入旧 Token 或生产 DO，不覆盖既有身份。设备授权专项 43 项、typecheck / lint 通过，产品源码 `d8accd5` 通过仓库部署脚本本地构建发布，r2 Worker Version ID 为 `fcf48444-dc46-4566-b515-b37eb6a7a040`；健康与静态资源字节核对通过。仍为 `ciVerified=false` 本地预览，原生测试程序也是本地开发构建，不视为完整 CI 发行制品。

使用在线备份生成的原数据库快照，再复制到独立 dataDir，并复制原项目登记；通过 `scripts/prepare-r2-database.py` 生成 r2 专用配置。独立测试主机名为 **r2-real-database-0.6.14**，验证后保持连接，未替换或重启两既有 Agent。自动更新、终端、外部队列 / 审批与启动修复关闭，原控制端口 / token 不复制。项目工作区与 Codex home 未复制，本轮仅读取旧历史，不发送任务、创建会话或接管控制。

真实 Cloudflare 加密通道分页返回全部 **129 个原会话**（两页），与快照 ID 集合完全一致；三份原历史的事件序号及元数据匹配。Chromium 实际打开一个既有关闭会话，验证桌面历史显示、刷新恢复和手机显示，无页面异常；截图和正文仅在私有忽略目录。初次浏览器定位用旧标题，目录显示的 Codex thread 标题覆盖了该标题；改按已加载的原会话 ID 选择实际列表项后完整重跑通过，没有放宽历史显示断言。临时浏览器凭据已撤销，独立 Agent 授权保留供后续查看。

发布与连接后复核，生产 Worker 仍为 `a103c4dd-f5b8-4a82-a19d-3329129339b5`，生产 DO、路由、两既有 Agent PID / 启动身份、r2 独立 DO / Access audience 保持原样。[不含聊天内容的验证记录](assets/opaque-integration/r2-real-database.json)。此结果验证原数据库副本在 r2 的真实历史访问，不代表原生产会话进程恢复或生产部署完成。

## 2026-11-06：0.6.14 本地集成预览与用户数据库副本

用户明确授权让 Actions 后台继续运行，先发布本地构建到 r2。已通过 `scripts/deploy-cloud.py --target r2 --local-build --commit HEAD --r2-access-aud <原 r2 audience> --apply` 发布干净源码 `fd537026a97f3c2462ea4997b7e7628d1c7c8990`，源码摘要 `6f8e9d94dd1c131c9f4adec71002fa0ee0b509e7fec2b904524eaeda569ce3cc`。Worker / Web `0.6.14`，Worker Version ID `b3f5ad63-abf5-43df-860d-001b960ca863`。这是 `ciVerified=false` 的本地预览；[后台 Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42171580611) 不是该部署的来源，不视为已完成验证的发行制品。原生下载保留原版本，不发布更新通知。

健康与全部公开静态资源字节核对通过。线上真实 Cloudflare、临时本地 Agent、模拟 Codex 和 Chromium 验收通过：加密任务、原请求去重、权限拒绝、文件、历史、控制接管，桌面 / 手机及九个管理面板深浅色无异常。测试结束撤销临时 Agent 及关联客户端授权。首轮测试因 Node 网络配置预载路径相对于临时工作目录而退出，改为绝对路径后完整重跑通过；TLS 校验保持启用。

原站 Worker 版本仍为 `a103c4dd-f5b8-4a82-a19d-3329129339b5`。前后只读核对确认生产 Worker、DO、路由、r2 独立 namespaces / Access audience 和两既有 Agent 的 PID / 启动标识保持原样；未安装或重启现有 Agent。

按用户授权用 SQLite 在线备份 API 复制当前用户数据库，约 167 MiB、版本 0、47 张原表、129 个会话、17,436 条事件、42,128 条历史。另复制一份后用新版真实 Store 连续打开两次，升级到 2；逐表逐行摘要核对全部原记录、升级前备份和输入快照均保持完整。该检查离线执行，未启动 Agent / Codex、连接中继或恢复原会话进程。原数据库、配置与工作区未替换，副本与完整摘要仅存忽略的私有目录。

用户确认 Agent 可以重新登录，只要求数据库能够迁移，因此取消 DO / 旧凭据导入；r2 使用独立授权。不在生产启用原始存储导出接口。

[公开验证记录](assets/opaque-integration/r2-local-preview.json) · [线上桌面](assets/opaque-integration/r2-online-desktop.png) · [线上手机](assets/opaque-integration/r2-online-mobile.png)。邮箱 / OTP、生产迁移和外网长稳仍未验证。

## 2026-11-06：0.6.13 网页补丁（只读历史恢复）

该次发布后，https://r2.xlogic.cc 的网页来源为 [`4b08796d25194b176dce02613aea2b528d225568`](https://github.com/hjxxlogic/codexovercloudflare/commit/4b08796d25194b176dce02613aea2b528d225568)，包含只读历史恢复修复 `fcfb6e1`，网页版本号保持 `0.6.13`。网页源码摘要 `6a4d670eb2f01b40e53fa1d302d419d78b6285c81ae662dbf338e9fc284b358a`。本次仅更新网页，使用 `scripts/deploy-cloud.py --local-build --target r2 --web-only-from <已验证的 0.6.13 deployment.json> --apply`，没有编译 Worker。

Cloudflare 代码与静态资源以同一版本部署，新 Version ID `993f12d9-0670-45b6-a4e6-d0ae013fa154`；Worker 执行代码仍来自 `d3c69e2d3f59b287fb439423660b51eca7d1fc45`，发布前后实际读取线上 `index.js`，SHA256 均为 `996509bd0fd931a352bffec62ba673d0b7545c3c65710f8507b37f93abdea5b9`。原配置复用，变量使用 `--keep-vars` 保留，Secret 不变；source map 会由 Wrangler 规范化，不计入执行代码一致性。原生下载、下载说明与下载页主题保留。

网页构建 / 类型检查、部署保护测试 5/5、健康与全部公开资源字节核对通过；历史修复此前的 Web 导航与历史单测 20/20 已通过。线上桌面 / 手机 / 管理 Web 验收无浏览器异常，临时凭据撤销通过，不创建或 attach 真实会话，不调用模型 / Shell。

以本次发布前基线核对，旧站 Worker `a103c4dd-f5b8-4a82-a19d-3329129339b5`、r2 路由 / DO namespaces / Access audience 和两个 Agent 身份保持不变；原 Agent PID `846124`、r2 测试 Agent PID `2527593` 未重启或替换。原生下载保持 `0.6.7`。本地预览 `ciVerified=false`，提交含 `[skip ci]`，完整 CI 未运行。见 [发布证据](https://github.com/hjxxlogic/codexovercloudflare/blob/f2de6f8ccea342575ce99b8c852f893f938285c3/docs/assets/cw-observer-web/verified-preview.json) 与 [历史恢复实施记录](https://github.com/hjxxlogic/codexovercloudflare/blob/f2de6f8ccea342575ce99b8c852f893f938285c3/docs/CW_OBSERVER_HISTORY_FIX.md)。

## 2026-11-06：0.6.13 继续对话与连接提示

该次发布后，https://r2.xlogic.cc 已部署源码 [`d3c69e2d3f59b287fb439423660b51eca7d1fc45`](https://github.com/hjxxlogic/codexovercloudflare/commit/d3c69e2d3f59b287fb439423660b51eca7d1fc45)，Web / Worker `0.6.13`，Worker Version ID `5df20399-ff4f-404e-8fd7-508c14cbf3fe`。源码摘要 `bb684cc5db84a42c340e262f441b6dee4f5e448550b3747f14856213e5eb74b2`。按用户仅 Web UI 验证要求发布本地预览，`ciVerified=false`、提交含 `[skip ci]`，完整 Actions / 原生 / 仓库测试未运行。

历史与控制转移统一为“继续对话”，占用时确认转到当前页面、取消不转移；正常连接隐藏连接操作，短暂断线自动恢复，失败时提供“重试连接”，恢复后提示消失。启动 / 结束 / 历史 / 中断分别说明；确认转移成功后自动重连使用普通连接，不重复转移。Worker / Agent 业务代码未改。实现、验证边界和模拟截图见 [0.6.13 记录](https://github.com/hjxxlogic/codexovercloudflare/blob/f2de6f8ccea342575ce99b8c852f893f938285c3/docs/CW_CONTINUE_0.6.13.md)。

Web 构建、类型检查、受影响文件 ESLint / Prettier、导航浏览器专项通过。使用 `scripts/deploy-cloud.py --local-build --target r2 --commit d3c69e2d3f59b287fb439423660b51eca7d1fc45 --apply`，显式保留 r2 Access audience，健康与全部公开资源字节核对通过。线上 `scripts/verify-web-navigation.ts` 验证桌面 / 手机导航、文件 / 预览入口、信息对话框、设置 / 主题和管理页，无浏览器异常，临时凭据已撤销。控制转移与重连细节使用本地模拟浏览器覆盖；未在线创建 / attach / 恢复真实会话或调用模型 / Shell。

以本次发布前新采集基线为准，旧站 Worker `a103c4dd-f5b8-4a82-a19d-3329129339b5`、DO namespaces、路由及 r2 Access audience 保持不变；原 Agent PID `846124` 和 r2 测试 Agent PID `2527593` 的可执行文件、启动身份未变，未重启或替换程序 / 配置 / 数据库。原生下载保留 `0.6.7`。[公开发布证据](https://github.com/hjxxlogic/codexovercloudflare/blob/f2de6f8ccea342575ce99b8c852f893f938285c3/docs/assets/cw-continue-0.6.13/verified-preview.json)，凭据与机器本地证据仅在忽略目录。

## 2026-11-06：0.6.12 独立预览与消息复制

该次发布后，https://r2.xlogic.cc 已部署源码 [`425f450f0945b6ed1ef124d233ab5ea53000e388`](https://github.com/hjxxlogic/codexovercloudflare/commit/425f450f0945b6ed1ef124d233ab5ea53000e388)，Web / Worker `0.6.12`，Worker Version ID `7e38b51f-f775-45c0-85e4-7c05f84aa684`。源码摘要 `7dd8d58e1e8f3ebe98d7bf8d4aa2bdae0125af2ba87c2760937f3157090eefca`；用户授权的本地预览，`ciVerified=false`，提交带 `[skip ci]`，完整 Actions / 原生 / 仓库测试未运行，不作为 CI 验证制品。

正常顶栏仅保留导航与操作，连接异常浮动、恢复自动消失；文件树与内容预览拆分为独立控件，支持分别关闭 / 全屏与手机返回列表；用户和 AI 消息整条复制，AI 保留原始 Markdown，长消息按需读全，复制按钮与反馈浮动、不占正文空间。实施和模拟截图见 [0.6.12 记录](https://github.com/hjxxlogic/codexovercloudflare/blob/f2de6f8ccea342575ce99b8c852f893f938285c3/docs/CW_UI_0.6.12.md)。Worker / Agent 业务代码未改。

Web 构建、类型检查、受影响文件 ESLint / Prettier、导航专项与高级 Markdown 浏览器回归通过。通过 `scripts/deploy-cloud.py --local-build --target r2 --commit 425f450f0945b6ed1ef124d233ab5ea53000e388 --apply` 发布；显式指定 r2 Access audience，健康检查及全部公开资源字节核对通过。线上 `scripts/verify-web-navigation.ts` 验证桌面 / 手机导航、精简顶栏、文件 / 传输、信息对话框、设置 / 主题与管理页，无浏览器异常，临时 Web 凭据清理通过；不创建 / attach 会话，不发送任务，不启动 Shell。消息复制与独立预览的细节由本地模拟浏览器覆盖。

发布前后复核旧站 Worker `0b54f874-3b3a-43f3-8855-0465bcb646f5`、路由、独立 DO namespaces 和 r2 Access audience 均保持；原 Agent PID `846124` 与 r2 测试 Agent PID `2527593` 的可执行文件、启动身份未变，未重启服务或替换程序 / 配置 / 数据。原生下载保留 `0.6.7`。源码、制品摘要、线上检查与隔离证据见 [公开记录](https://github.com/hjxxlogic/codexovercloudflare/blob/f2de6f8ccea342575ce99b8c852f893f938285c3/docs/assets/cw-ui-0.6.12/verified-preview.json)；凭据与机器本地证据仅保留于忽略目录。

## 2026-11-06：0.6.11 紧凑导航与可见工具栏

该次发布后，https://r2.xlogic.cc 已部署源码 [`0105572f65b1860a16345c5faee4afa1e4ad4637`](https://github.com/hjxxlogic/codexovercloudflare/commit/0105572f65b1860a16345c5faee4afa1e4ad4637)，Web / Worker `0.6.11`，Worker Version ID `6a6c08bd-2d1a-4f25-9e9a-8c2e5ad91c60`。源码摘要 `e4ee24a148e8ed24e6c81cae695acccad0ae877fc7c428503cd51e12054dd8f9`；用户授权的本地预览，`ciVerified=false`，提交带 `[skip ci]`，未运行完整 CI 或原生测试。

折叠层级改为单行，项目刷新常显于新建左侧，新建路径推断父目录或根目录；设置操作图标附文字，信息改模态对话框，长预览 / 全屏 / 对话框保留工具栏，复制按需显示，折叠工具调用最多一行。实现及模拟截图见 [0.6.11 记录](https://github.com/hjxxlogic/codexovercloudflare/blob/f2de6f8ccea342575ce99b8c852f893f938285c3/docs/CW_UI_POLISH_0.6.11.md)。Worker / Agent 业务代码未改。

Web 构建、类型检查、受影响代码 ESLint / Prettier、导航专项和高级 Markdown 浏览器回归通过。部署脚本确认健康版本 `0.6.11` 和主页 / 静态资源 / 下载清单字节一致，Worker bundle SHA256 `38fdfd0da58994b66d2d53c7f14ac2b0bb78851cede4944df3aa41b953108dbc`。原生下载保留已验证 `0.6.7`。

线上 Web 验收通过，覆盖单行层级、项目刷新顺序与常显、信息模态 / 长内容关闭按钮 / Escape 焦点恢复、五按钮、文件 / 传输、设置主题、手机抽屉和管理左栏；无浏览器异常。仅访问既有隔离测试主机，临时 Web 凭证已确认撤销；未创建 / attach 会话、发送任务或启动终端。

发布前后复核旧站 Worker `0b54f874-3b3a-43f3-8855-0465bcb646f5` 未变，旧站 / r2 DO namespace 独立，r2 namespace、路由、Access audience 保持。原 Agent PID `846124` 和测试 Agent PID `2527593` 的可执行文件、启动标识不变，未重启。准确来源与摘要见 [公开发布证据](https://github.com/hjxxlogic/codexovercloudflare/blob/f2de6f8ccea342575ce99b8c852f893f938285c3/docs/assets/cw-ui-polish-0.6.11/verified-preview.json)，私有日志 / 截图保存在忽略的 `.local/r2-release-0.6.11/`。

本节及后续文档提交仅补充证据，线上功能源码为上述准确提交。

## 2026-11-05：0.6.10 三级折叠导航与图标操作

该次发布后，https://r2.xlogic.cc 已部署源码 [`26aeb63ed8821cdffb99d16fb13265f103d37306`](https://github.com/hjxxlogic/codexovercloudflare/commit/26aeb63ed8821cdffb99d16fb13265f103d37306)，Web / Worker `0.6.10`，Worker Version ID `aa03ae33-cfc7-49b2-98a2-b97cf15b7284`。源码摘要 `5b8b1d3cf9dfc64ce22628e1b026c43dc14df85f5a5619b397d39c8d321e0d5f`；本地预览，`ciVerified=false`。按用户要求仅验证 Web UI，提交含 `[skip ci]`，没有运行 / 等待完整 Actions 或原生测试。

左栏采用主机 → 项目 → 会话互斥展开、上级有效后解锁下级；授权置于主机列表下、新建项目置于项目列表下、新建会话在会话列表上。顶部显示会话图标、邮箱用户名前缀与收起按钮，底部仅设置；各工作面板操作统一图标与悬停 / 键盘工具提示。实现、测试边界与模拟截图见 [0.6.10 实施记录](https://github.com/hjxxlogic/codexovercloudflare/blob/f2de6f8ccea342575ce99b8c852f893f938285c3/docs/CW_NAVIGATION_0.6.10.md)。

Web 构建、类型检查、受影响文件 ESLint / Prettier、导航浏览器专项和高级 Markdown 浏览器测试通过。既有部署脚本核对健康版本 `0.6.10`、主页 / 静态资源 / 下载清单字节一致，Worker bundle SHA256 `6aeef9d8c022c614c7d10c8f98d3aa78ac38c25c6abea96c869556ceb064bd1b`；原生下载仍为 CI 已验证 `0.6.7`。Worker / Agent 业务代码未改，未构建或替换 Agent。

线上 `scripts/verify-web-navigation.ts` 通过：三级导航解锁、五按钮、文件 / 传输入口、面板互斥、设置主题、手机抽屉与管理左栏，无浏览器异常。使用既有隔离主机的临时 Web 身份，结束后已确认撤销；未创建 / attach 会话、发送任务、启动终端。访客入口不提供邮箱，线上用户名显示“用户”；邮箱前缀由本地 Web 模拟身份验证。

发布前后只读复核：旧站 Worker `0b54f874-3b3a-43f3-8855-0465bcb646f5` 未变；旧站与 r2 DO namespace 独立，r2 namespace、路由、Access audience 保持；原 Agent PID `846124`、独立测试 Agent PID `2527593` 的可执行文件及启动标识不变，未重启。完整可公开身份 / 摘要 / 验证见 [发布证据](https://github.com/hjxxlogic/codexovercloudflare/blob/f2de6f8ccea342575ce99b8c852f893f938285c3/docs/assets/cw-navigation-0.6.10/verified-preview.json)。凭据、原始日志与线上截图仅保存在忽略的 `.local/r2-release-0.6.10/`。

本节及后续文档提交仅补充发布证据，线上功能源码保持上述准确提交。

## 2026-11-05：0.6.9 统一左栏与工作区面板

该次发布后，r2 已部署源码 [`4b458083aa80379cc9fa87ebe4c1ec101f291510`](https://github.com/hjxxlogic/codexovercloudflare/commit/4b458083aa80379cc9fa87ebe4c1ec101f291510)，Web / Worker `0.6.9`，Worker Version ID `87d08b89-701c-4284-ac16-02e143a56be0`。源码摘要 `b5d55ee872eaeb4b21be54f17fb4b91e8a4aa2ed4af21bdcf1832d3b075a7dfe`；本地构建预览，`ciVerified=false`。用户本轮明确要求只测 Web UI，因此提交使用 `[skip ci]`，未运行 / 等待完整 Actions，也未执行原生或完整集成测试。

可收起左栏统一主机、项目和会话；左下设置收纳外观及授权 / 管理入口，原会话记录弹窗和右侧菜单取消。右上五按钮、统一文件浏览 / 预览 / 传输及右侧输出 / 信息面板已上线。实现过程、Web 验证和截图见 [0.6.9 实施记录](https://github.com/hjxxlogic/codexovercloudflare/blob/f2de6f8ccea342575ce99b8c852f893f938285c3/docs/CW_NAVIGATION_0.6.9.md)。

Web 构建、类型检查、受影响文件 ESLint / Prettier、导航浏览器专项和高级 Markdown 浏览器测试通过。部署经 `scripts/deploy-cloud.py --local-build --target r2` 完成，健康版本 `0.6.9`，主页 / 静态资源 / 下载清单与准备目录逐字节一致；原生下载保持 CI 已验证 `0.6.7`。Worker bundle SHA256 `483a7ed41a12c8a713db93ffc9868588cc4cf9fad008ff5e19e9bfcf3957b857`。

上线另用 `scripts/verify-web-navigation.ts` 通过实际 r2 页面验证：桌面左栏、五按钮、文件 / 传输入口、面板互斥、设置主题、手机抽屉和管理左栏，无浏览器异常。仅为临时 Web 身份授权既有隔离测试主机，结束后已撤销该凭证；未创建 / attach 会话、发送任务或启动终端。线上截图和凭据留在忽略的 `.local/r2-release-0.6.9/`。

发布前后复核：旧站 Worker `0b54f874-3b3a-43f3-8855-0465bcb646f5` 未变，旧站和 r2 的 DO namespace 仍独立，r2 存储 / Access audience / 路由保持。原 Agent PID `846124` 与独立测试 Agent `2527593` 的可执行文件、启动标识均未变，未重启。可公开的精确身份、摘要与验证结果见 [发布证据](https://github.com/hjxxlogic/codexovercloudflare/blob/f2de6f8ccea342575ce99b8c852f893f938285c3/docs/assets/cw-navigation-0.6.9/verified-preview.json)。

## 2026-11-05：官方 Web 实测后的第二轮预览

该次发布后，r2 已更新为源码 `6cb27bc88fe6372cf1b2ee20bea303fb180479dd`、Web / Worker `0.6.8`，Worker Version ID 为 `99f6777d-3406-4087-b343-2cd60284213c`。这仍是用户授权的本地预览，`ciVerified=false`；[准确提交 Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42036227735) 记录时仍在运行，不能视为完整通过。原生下载保留已验证 `0.6.7`，没有替换或重启已有 Agent。

本轮实际注册官方 Happier 测试账户，完成两个真实会话、工具与文件审批、长输出和桌面 / 手机富文本对照，再改写页面结构与富文本工具栏；[实测文档](HAPPIER_WEB_COMPARISON_2026-11-05.md) 包含官方截图及同段 Markdown 的 CoC 对照。

最终源码的 Web 构建、类型检查、Lint、完整 UI 与富文本回归通过；布局提交 `74a9135` 的完整 E2E 46 项含真实 PTY 通过，随后富文本补充由 UI / Markdown 回归覆盖，完整 CI 仍需等待最终提交。部署脚本核对健康状态及主页、资源、下载清单字节；字体许可证额外逐字节核对通过。最终 r2 线上隔离测试通过，覆盖加密任务、历史恢复、控制权、文件和九个管理面板的深浅色 / 桌面 / 手机。测试使用独立临时 Agent 与模拟 Codex，结束后清理；首次 Node 双栈拨号超时，最终仅对测试进程采用 IPv4 优先并关闭自动族选择，未修改系统或线上网络配置。

复核确认旧站 Worker / DO、原 Agent PID / 启动时间、r2 存储和 Access 设置未变；用户独立测试 Agent `r2-Happier-0.6.8-test` 的 PID 保持且仍运行。官方 Happier 的隔离 daemon 和测试执行进程已停止，账户与安装保留私有目录；停止后官方 Web 仍能阅读已有会话。[公开验证与摘要](assets/r2-deployment-0.6.8-2026-11-05/happier-web-verified-preview.json)。

## 2026-11-05：0.6.8 本地预览与独立测试 Agent

用户授权在 CI 等待期间先将本地 Worker / 网页部署到 r2。首轮预览的产品源码为 `75b5673c7e61d5a8cc59e3281cb6d42f15edbeff`，Worker Version ID 为 `7c38dc19-6746-4782-a3b7-7800820cb707`，健康检查版本 `0.6.8`；此阶段明确标记 `ciVerified=false`，下载包仍为已验证的 `0.6.7`。该 [Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42018456559) 最终因手机阅读面积断言失败；第二轮已在保留原断言的前提下修复重复标题和空间占用。

79 个网页及下载目录资源逐字节核对通过。真实 Cloudflare / 原生 Agent / Chromium 的线上隔离测试通过，包括加密会话、历史恢复、权限、九个管理面板和桌面 / 手机深浅色。下载目录核验使用规范地址 `/downloads/`，避免静态服务对 `index.html` 的 307 跳转。

另按用户要求启动并保留独立主机 **`r2-Happier-0.6.8-test`**，项目 **`Happier UI 测试`**，使用本地 `0.6.8` 开发构建、独立配置 / 数据库 / 项目和真实本机 Codex。自动更新关闭，完整 CI 验证尚未完成。用户可在 r2 选择此主机和项目进行交互测试；本记录不包含凭据和本机私有配置。

启动后复核：原 Agent PID 与启动时间不变；旧站 Worker 版本保持发布前的 `0b54f874-3b3a-43f3-8855-0465bcb646f5`；r2 namespace / Access audience 保留，路由与 DO 存储隔离。[本阶段公开证据](assets/r2-deployment-0.6.8-2026-11-05/local-preview-verification.json)；原始日志和测试 Agent 状态位于忽略的 `.local/r2-release-0.6.8/`。

## 2026-11-04：0.6.7 已验证部署记录

2026-11-04 将不透明中继架构部署到 **https://r2.xlogic.cc**。Worker 保留权限管理，Agent / Client 承担加密业务、控制权和可靠传输。旧站及既有本机 Agent 不属于本次升级范围。

## 来源与制品

- 部署源码：`a61423f4f1cbd82b018dbcf3f29c1ac2acb43859`，版本 `0.6.7`。
- [该提交的完整 Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41764690561) 成功：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必需作业全部通过。分支运行的 release 发布作业按条件跳过。
- 使用 `scripts/deploy-cloud.py --target r2` 部署经过摘要和来源校验的 CI Worker / 网页制品，同时发布四个平台安装包与源码包；没有部署本机构建的发行制品。
- Worker：`codex-over-cloudflare-r2`；最终 Version ID：`c43346e0-d76c-404a-b93a-b759cc16055c`。
- [公开验证记录](assets/r2-deployment-2026-11-04/verification.json) 包含源码摘要、全部 artifact SHA256、在线安装包摘要、静态资源核对和隔离断言。凭据、配置、原始日志仅保存在忽略的 `.local/r2-deployment/` 与 `.local/deploy-cloud/`。

本记录和后续测试脚本修正属于部署后的证据整理；线上产品源码仍为上述已通过 CI 的准确提交。

## 线上验证

健康检查成功，网页静态资源与 CI 制品逐字节一致；从 r2 下载四个平台安装包和源码包，SHA256 全部匹配。

本机 CTest 13/13、Vitest 35 文件 / 379 项、启用 Terminal 的完整 E2E 46 项通过；平台 CI 结果与本机结果分别记录。

使用 CI musl Agent、独立临时配置 / SQLite / 项目、真实 Cloudflare 和 Chromium 运行隔离测试，覆盖：

- 加密项目、配置读取及权限拒绝；原请求重复创建不重复执行。
- 控制握手、模型列表、提示词及流式完成；文件字节和历史读取。
- 控制接管、相同 claim 的稳定重试 ticket。
- 中继可见密文不包含测试提示词或会话 ID；Worker 目录不含业务 build / operationInstance。
- 浏览器选择主机与项目、创建会话、发送任务、刷新后恢复历史且回复不重复；桌面及手机视口无页面异常。

[桌面截图](assets/r2-deployment-2026-11-04/desktop.png) · [手机截图](assets/r2-deployment-2026-11-04/mobile.png)。复现入口见 [发布操作](RELEASE.md#独立-r2-测试站)。测试结束停止临时 Agent 并撤销其关联授权；未安装常驻 r2 Agent。

## 隔离与验证边界

r2 使用独立域名、Worker、两个 Durable Object namespace 和 owner secret。发布前后核对，旧站 Worker 版本保持 `0c4458c6-4b89-466e-ba86-fc84c58966c1`，既有 Agent 的 PID、启动时间及 active 状态保持一致；未替换其二进制、配置或数据库，未调用服务重启。此核对以实际 r2 发布前为基准，不将其他操作此前造成的变化归因于本次发布。

Access 入口已启用。测试使用 Service Auth 准入及 CoC 访客授权，包含 HTTP 与 WebSocket；未执行邮箱 / OTP 登录。原生连接须配置允许 r2 origin 的独立 Access 文件，见 [用户手册](USER_GUIDE.md#独立-r2-测试站)。

业务测试使用模拟 Codex，没有调用真实模型。此次未演练生产数据库迁移 / 回退，也未完成跨网络长时间稳定性测试；本机真实 Codex 协议与 TUI 初始化结果见 [测试验收](OPAQUE_RELAY_TEST_PLAN.md)。测试通过不代表旧站或既有 Agent 已升级到新架构。
