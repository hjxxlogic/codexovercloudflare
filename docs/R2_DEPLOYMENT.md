# r2 当前部署

## 2026-11-06：0.6.13 网页补丁（只读历史恢复）

当前 https://r2.xlogic.cc 的网页来源为 [`4b08796d25194b176dce02613aea2b528d225568`](https://github.com/hjxxlogic/codexovercloudflare/commit/4b08796d25194b176dce02613aea2b528d225568)，包含只读历史恢复修复 `fcfb6e1`，网页版本号保持 `0.6.13`。网页源码摘要 `6a4d670eb2f01b40e53fa1d302d419d78b6285c81ae662dbf338e9fc284b358a`。本次仅更新网页，使用 `scripts/deploy-cloud.py --local-build --target r2 --web-only-from <已验证的 0.6.13 deployment.json> --apply`，没有编译 Worker。

Cloudflare 代码与静态资源以同一版本部署，新 Version ID `993f12d9-0670-45b6-a4e6-d0ae013fa154`；Worker 执行代码仍来自 `d3c69e2d3f59b287fb439423660b51eca7d1fc45`，发布前后实际读取线上 `index.js`，SHA256 均为 `996509bd0fd931a352bffec62ba673d0b7545c3c65710f8507b37f93abdea5b9`。原配置复用，变量使用 `--keep-vars` 保留，Secret 不变；source map 会由 Wrangler 规范化，不计入执行代码一致性。原生下载、下载说明与下载页主题保留。

网页构建 / 类型检查、部署保护测试 5/5、健康与全部公开资源字节核对通过；历史修复此前的 Web 导航与历史单测 20/20 已通过。线上桌面 / 手机 / 管理 Web 验收无浏览器异常，临时凭据撤销通过，不创建或 attach 真实会话，不调用模型 / Shell。

以本次发布前基线核对，旧站 Worker `a103c4dd-f5b8-4a82-a19d-3329129339b5`、r2 路由 / DO namespaces / Access audience 和两个 Agent 身份保持不变；原 Agent PID `846124`、r2 测试 Agent PID `2527593` 未重启或替换。原生下载保持 `0.6.7`。本地预览 `ciVerified=false`，提交含 `[skip ci]`，完整 CI 未运行。见 [发布证据](assets/cw-observer-web/verified-preview.json) 与 [历史恢复实施记录](CW_OBSERVER_HISTORY_FIX.md)。

## 2026-11-06：0.6.13 继续对话与连接提示

当前 https://r2.xlogic.cc 已部署源码 [`d3c69e2d3f59b287fb439423660b51eca7d1fc45`](https://github.com/hjxxlogic/codexovercloudflare/commit/d3c69e2d3f59b287fb439423660b51eca7d1fc45)，Web / Worker `0.6.13`，Worker Version ID `5df20399-ff4f-404e-8fd7-508c14cbf3fe`。源码摘要 `bb684cc5db84a42c340e262f441b6dee4f5e448550b3747f14856213e5eb74b2`。按用户仅 Web UI 验证要求发布本地预览，`ciVerified=false`、提交含 `[skip ci]`，完整 Actions / 原生 / 仓库测试未运行。

历史与控制转移统一为“继续对话”，占用时确认转到当前页面、取消不转移；正常连接隐藏连接操作，短暂断线自动恢复，失败时提供“重试连接”，恢复后提示消失。启动 / 结束 / 历史 / 中断分别说明；确认转移成功后自动重连使用普通连接，不重复转移。Worker / Agent 业务代码未改。实现、验证边界和模拟截图见 [0.6.13 记录](CW_CONTINUE_0.6.13.md)。

Web 构建、类型检查、受影响文件 ESLint / Prettier、导航浏览器专项通过。使用 `scripts/deploy-cloud.py --local-build --target r2 --commit d3c69e2d3f59b287fb439423660b51eca7d1fc45 --apply`，显式保留 r2 Access audience，健康与全部公开资源字节核对通过。线上 `scripts/verify-web-navigation.ts` 验证桌面 / 手机导航、文件 / 预览入口、信息对话框、设置 / 主题和管理页，无浏览器异常，临时凭据已撤销。控制转移与重连细节使用本地模拟浏览器覆盖；未在线创建 / attach / 恢复真实会话或调用模型 / Shell。

以本次发布前新采集基线为准，旧站 Worker `a103c4dd-f5b8-4a82-a19d-3329129339b5`、DO namespaces、路由及 r2 Access audience 保持不变；原 Agent PID `846124` 和 r2 测试 Agent PID `2527593` 的可执行文件、启动身份未变，未重启或替换程序 / 配置 / 数据库。原生下载保留 `0.6.7`。[公开发布证据](assets/cw-continue-0.6.13/verified-preview.json)，凭据与机器本地证据仅在忽略目录。

## 2026-11-06：0.6.12 独立预览与消息复制

当前 https://r2.xlogic.cc 已部署源码 [`425f450f0945b6ed1ef124d233ab5ea53000e388`](https://github.com/hjxxlogic/codexovercloudflare/commit/425f450f0945b6ed1ef124d233ab5ea53000e388)，Web / Worker `0.6.12`，Worker Version ID `7e38b51f-f775-45c0-85e4-7c05f84aa684`。源码摘要 `7dd8d58e1e8f3ebe98d7bf8d4aa2bdae0125af2ba87c2760937f3157090eefca`；用户授权的本地预览，`ciVerified=false`，提交带 `[skip ci]`，完整 Actions / 原生 / 仓库测试未运行，不作为 CI 验证制品。

正常顶栏仅保留导航与操作，连接异常浮动、恢复自动消失；文件树与内容预览拆分为独立控件，支持分别关闭 / 全屏与手机返回列表；用户和 AI 消息整条复制，AI 保留原始 Markdown，长消息按需读全，复制按钮与反馈浮动、不占正文空间。实施和模拟截图见 [0.6.12 记录](CW_UI_0.6.12.md)。Worker / Agent 业务代码未改。

Web 构建、类型检查、受影响文件 ESLint / Prettier、导航专项与高级 Markdown 浏览器回归通过。通过 `scripts/deploy-cloud.py --local-build --target r2 --commit 425f450f0945b6ed1ef124d233ab5ea53000e388 --apply` 发布；显式指定 r2 Access audience，健康检查及全部公开资源字节核对通过。线上 `scripts/verify-web-navigation.ts` 验证桌面 / 手机导航、精简顶栏、文件 / 传输、信息对话框、设置 / 主题与管理页，无浏览器异常，临时 Web 凭据清理通过；不创建 / attach 会话，不发送任务，不启动 Shell。消息复制与独立预览的细节由本地模拟浏览器覆盖。

发布前后复核旧站 Worker `0b54f874-3b3a-43f3-8855-0465bcb646f5`、路由、独立 DO namespaces 和 r2 Access audience 均保持；原 Agent PID `846124` 与 r2 测试 Agent PID `2527593` 的可执行文件、启动身份未变，未重启服务或替换程序 / 配置 / 数据。原生下载保留 `0.6.7`。源码、制品摘要、线上检查与隔离证据见 [公开记录](assets/cw-ui-0.6.12/verified-preview.json)；凭据与机器本地证据仅保留于忽略目录。

## 2026-11-06：0.6.11 紧凑导航与可见工具栏

当前 https://r2.xlogic.cc 已部署源码 [`0105572f65b1860a16345c5faee4afa1e4ad4637`](https://github.com/hjxxlogic/codexovercloudflare/commit/0105572f65b1860a16345c5faee4afa1e4ad4637)，Web / Worker `0.6.11`，Worker Version ID `6a6c08bd-2d1a-4f25-9e9a-8c2e5ad91c60`。源码摘要 `e4ee24a148e8ed24e6c81cae695acccad0ae877fc7c428503cd51e12054dd8f9`；用户授权的本地预览，`ciVerified=false`，提交带 `[skip ci]`，未运行完整 CI 或原生测试。

折叠层级改为单行，项目刷新常显于新建左侧，新建路径推断父目录或根目录；设置操作图标附文字，信息改模态对话框，长预览 / 全屏 / 对话框保留工具栏，复制按需显示，折叠工具调用最多一行。实现及模拟截图见 [0.6.11 记录](CW_UI_POLISH_0.6.11.md)。Worker / Agent 业务代码未改。

Web 构建、类型检查、受影响代码 ESLint / Prettier、导航专项和高级 Markdown 浏览器回归通过。部署脚本确认健康版本 `0.6.11` 和主页 / 静态资源 / 下载清单字节一致，Worker bundle SHA256 `38fdfd0da58994b66d2d53c7f14ac2b0bb78851cede4944df3aa41b953108dbc`。原生下载保留已验证 `0.6.7`。

线上 Web 验收通过，覆盖单行层级、项目刷新顺序与常显、信息模态 / 长内容关闭按钮 / Escape 焦点恢复、五按钮、文件 / 传输、设置主题、手机抽屉和管理左栏；无浏览器异常。仅访问既有隔离测试主机，临时 Web 凭证已确认撤销；未创建 / attach 会话、发送任务或启动终端。

发布前后复核旧站 Worker `0b54f874-3b3a-43f3-8855-0465bcb646f5` 未变，旧站 / r2 DO namespace 独立，r2 namespace、路由、Access audience 保持。原 Agent PID `846124` 和测试 Agent PID `2527593` 的可执行文件、启动标识不变，未重启。准确来源与摘要见 [公开发布证据](assets/cw-ui-polish-0.6.11/verified-preview.json)，私有日志 / 截图保存在忽略的 `.local/r2-release-0.6.11/`。

本节及后续文档提交仅补充证据，线上功能源码为上述准确提交。

## 2026-11-05：0.6.10 三级折叠导航与图标操作

当前 https://r2.xlogic.cc 已部署源码 [`26aeb63ed8821cdffb99d16fb13265f103d37306`](https://github.com/hjxxlogic/codexovercloudflare/commit/26aeb63ed8821cdffb99d16fb13265f103d37306)，Web / Worker `0.6.10`，Worker Version ID `aa03ae33-cfc7-49b2-98a2-b97cf15b7284`。源码摘要 `5b8b1d3cf9dfc64ce22628e1b026c43dc14df85f5a5619b397d39c8d321e0d5f`；本地预览，`ciVerified=false`。按用户要求仅验证 Web UI，提交含 `[skip ci]`，没有运行 / 等待完整 Actions 或原生测试。

左栏采用主机 → 项目 → 会话互斥展开、上级有效后解锁下级；授权置于主机列表下、新建项目置于项目列表下、新建会话在会话列表上。顶部显示会话图标、邮箱用户名前缀与收起按钮，底部仅设置；各工作面板操作统一图标与悬停 / 键盘工具提示。实现、测试边界与模拟截图见 [0.6.10 实施记录](CW_NAVIGATION_0.6.10.md)。

Web 构建、类型检查、受影响文件 ESLint / Prettier、导航浏览器专项和高级 Markdown 浏览器测试通过。既有部署脚本核对健康版本 `0.6.10`、主页 / 静态资源 / 下载清单字节一致，Worker bundle SHA256 `6aeef9d8c022c614c7d10c8f98d3aa78ac38c25c6abea96c869556ceb064bd1b`；原生下载仍为 CI 已验证 `0.6.7`。Worker / Agent 业务代码未改，未构建或替换 Agent。

线上 `scripts/verify-web-navigation.ts` 通过：三级导航解锁、五按钮、文件 / 传输入口、面板互斥、设置主题、手机抽屉与管理左栏，无浏览器异常。使用既有隔离主机的临时 Web 身份，结束后已确认撤销；未创建 / attach 会话、发送任务、启动终端。访客入口不提供邮箱，线上用户名显示“用户”；邮箱前缀由本地 Web 模拟身份验证。

发布前后只读复核：旧站 Worker `0b54f874-3b3a-43f3-8855-0465bcb646f5` 未变；旧站与 r2 DO namespace 独立，r2 namespace、路由、Access audience 保持；原 Agent PID `846124`、独立测试 Agent PID `2527593` 的可执行文件及启动标识不变，未重启。完整可公开身份 / 摘要 / 验证见 [发布证据](assets/cw-navigation-0.6.10/verified-preview.json)。凭据、原始日志与线上截图仅保存在忽略的 `.local/r2-release-0.6.10/`。

本节及后续文档提交仅补充发布证据，线上功能源码保持上述准确提交。

## 2026-11-05：0.6.9 统一左栏与工作区面板

当前 r2 已部署源码 [`4b458083aa80379cc9fa87ebe4c1ec101f291510`](https://github.com/hjxxlogic/codexovercloudflare/commit/4b458083aa80379cc9fa87ebe4c1ec101f291510)，Web / Worker `0.6.9`，Worker Version ID `87d08b89-701c-4284-ac16-02e143a56be0`。源码摘要 `b5d55ee872eaeb4b21be54f17fb4b91e8a4aa2ed4af21bdcf1832d3b075a7dfe`；本地构建预览，`ciVerified=false`。用户本轮明确要求只测 Web UI，因此提交使用 `[skip ci]`，未运行 / 等待完整 Actions，也未执行原生或完整集成测试。

可收起左栏统一主机、项目和会话；左下设置收纳外观及授权 / 管理入口，原会话记录弹窗和右侧菜单取消。右上五按钮、统一文件浏览 / 预览 / 传输及右侧输出 / 信息面板已上线。实现过程、Web 验证和截图见 [0.6.9 实施记录](CW_NAVIGATION_0.6.9.md)。

Web 构建、类型检查、受影响文件 ESLint / Prettier、导航浏览器专项和高级 Markdown 浏览器测试通过。部署经 `scripts/deploy-cloud.py --local-build --target r2` 完成，健康版本 `0.6.9`，主页 / 静态资源 / 下载清单与准备目录逐字节一致；原生下载保持 CI 已验证 `0.6.7`。Worker bundle SHA256 `483a7ed41a12c8a713db93ffc9868588cc4cf9fad008ff5e19e9bfcf3957b857`。

上线另用 `scripts/verify-web-navigation.ts` 通过实际 r2 页面验证：桌面左栏、五按钮、文件 / 传输入口、面板互斥、设置主题、手机抽屉和管理左栏，无浏览器异常。仅为临时 Web 身份授权既有隔离测试主机，结束后已撤销该凭证；未创建 / attach 会话、发送任务或启动终端。线上截图和凭据留在忽略的 `.local/r2-release-0.6.9/`。

发布前后复核：旧站 Worker `0b54f874-3b3a-43f3-8855-0465bcb646f5` 未变，旧站和 r2 的 DO namespace 仍独立，r2 存储 / Access audience / 路由保持。原 Agent PID `846124` 与独立测试 Agent `2527593` 的可执行文件、启动标识均未变，未重启。可公开的精确身份、摘要与验证结果见 [发布证据](assets/cw-navigation-0.6.9/verified-preview.json)。

## 2026-11-05：官方 Web 实测后的第二轮预览

当前 r2 已更新为源码 `6cb27bc88fe6372cf1b2ee20bea303fb180479dd`、Web / Worker `0.6.8`，Worker Version ID 为 `99f6777d-3406-4087-b343-2cd60284213c`。这仍是用户授权的本地预览，`ciVerified=false`；[准确提交 Actions](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/42036227735) 记录时仍在运行，不能视为完整通过。原生下载保留已验证 `0.6.7`，没有替换或重启已有 Agent。

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
