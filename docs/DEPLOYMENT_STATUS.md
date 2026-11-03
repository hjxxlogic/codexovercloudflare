# 发布与部署记录

[文档索引](README.md) · [发布流程](RELEASE.md) · [本机测试报告](TEST_REPORT.md)

## 0.6.5 Agent 一周保留、客户端恢复与本机升级 · 2026-11-03

源码 `875e771c56e61908062be6f06320ef23b0455a16` 的 [tag Actions 41598718938](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41598718938) 中 regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 和发布作业全部成功，已生成 [v0.6.5 Release](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.6.5)。0.6.3 / 0.6.4 候选未发布、未部署；不复用候选标签。制品来自最终 tag CI，核对 GitHub artifact SHA256 和源码身份；剩余三个平台通过 GH Proxy 下载，校验规则未变。

UTC `08:23:54` 部署到 `https://r.xlogic.cc`，部署 ID `447c07e7-1297-4b63-aee8-6c06d65b0bbb`，Worker `95ca4246-84fb-44ec-8235-46ddc69c74cc` 接收 100% 流量。健康返回 0.6.5，全部网页资源 / 手册 / 下载元数据逐字节一致，五份新归档在线重下 SHA256 校验通过。全部绑定与上一版相同；保留 DO namespace、Secret、变量与旧下载。真实管理员、权限边界、现有 Agent、Chromium 页面及通知连接检查通过，无模型调用、PTY 创建或会话接管。

随后按用户明确要求升级本机 systemd user-service Agent。使用 `scripts/deploy-agent.py --push --local --apply` 和同一 run 的 musl 制品，安装前确认 runtime / 排队命令 / 审批均为零；保存私有配置、账本和 SQLite 完整备份（integrity check 通过），helper 保留原运行二进制。安装后实际进程版本 / commit / sourceDigest 一致，连接与 120 秒稳定性验证通过，线上只读复测通过。配置及 Access 文件摘要不变，未强制中断活动任务、未手工删库或 VACUUM。

有效策略为 `retentionSeconds=604800`、`storageMaxBytes=268435456`、80% 触发 / 60% 目标；旧 `retainedRecords=0` 保持原样，不影响新增自动清理。升级后已初始化历史保留时间；实际使用 SQLite 页约 31 MiB，其余历史配额也未达到水位，本次没有强制清空旧历史。旧数据按升级迁移后的一周期限或提前容量清理处理；SQLite 页可复用不表示文件立即缩小，整盘写满时仍可能需要先腾空间。配置和恢复限制见 [保留策略](HISTORY_RETENTION_2026-11-03.md)。

[源码、全部制品与在线归档 SHA256、云端和本机升级验证](assets/retention-release-0.6.5-2026-11-03/deployment.json)。含凭据的备份、目标路径及完整日志仅保存在忽略目录 `.local/retention-release-0.6.5/`。

## 0.6.2 Terminal 响应与完整 Actions 发布 · 2026-11-03

源码 `9b6d7230c66eac4f212d40bfde4bf819838a064c` 的 [tag Actions 41581045170](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41581045170) 中 regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 全部成功，发布作业已生成 [v0.6.2 Release](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.6.2)。首次失败候选未发布、未部署。仅使用最终 tag CI 制品，经 GitHub 摘要、包内 SHA256 和统一源码身份校验后，由仓库脚本发布。

UTC `05:23:32` 部署至 `https://r.xlogic.cc`，部署 ID `a7c4e96c-f63c-43a2-862f-556d4717d2fb`，Worker `5ad122c3-c1c4-4058-af10-a82c4275bb41` 接收 100% 流量。健康为 0.6.2，网页 / 手册 / 下载元数据字节一致；五份新归档在线重下校验通过，musl 为 12.16 MiB。全部 binding 与此前一致，保留 DO namespace、Secret 和变量，无 D1。真实身份、只读 Agent、权限边界与 Chromium 通知检查通过。

Terminal 并行预读和输入窗口已上线，三次 Enter 按键到发出为 14–15 ms，旧样本曾排队 796 ms；实际单字符回显仍约 0.9–1 秒，已就绪会话打开菜单约 1.44 秒、确认打开后连接约 3.35 秒，均为小样本。新会话初始化另计，不能把混合计时当作菜单优化收益。线上独立 PTY 测试资源全部清理，无模型调用或既有会话接管。

原生 0.6.2 候选已核验，但现场 0.6.1 Agent 有一个活动 runtime，未获活动重启授权，尚未安装；因此 TCP_NODELAY 线上收益未验证。未发送自动更新通知。[响应、限制与后续测量](RESPONSE_SPEED_2026-11-03.md) · [来源、全部制品摘要和线上证据](assets/response-speed-2026-11-03/deployment.json)。

## OpenAI 多行公式修复 · 2026-11-03

按此前明确授权跳过 Actions，通过仓库部署脚本本机构建发布源码 `73847e8`，Worker `3cb29650-0724-48b0-96f7-3ee5781d1434` 已在 `https://r.xlogic.cc` 承载 100% 流量。健康、静态资源字节、真实身份与只读 Agent / 通知检查通过；原消息在生产资源中以桌面 / 手机视口逐项验证，17 个行内及 16 个块公式全部渲染，无回退或异常。现有 DO namespace、Secret 和原生下载保留；Agent 未更新或重启，无模型、PTY 或会话控制操作。[问题与验证范围](MATH_RENDERING_FIX_2026-11-03.md) · [制品 SHA256 与发布身份](assets/math-rendering-2026-11-03/deployment.json)。

## DO 唯一路径与连接授权 · 2026-11-03

按用户明确要求跳过 GitHub Actions，通过仓库脚本本地构建发布源码 `5ed8debda615387db4e573b28f8c83f30c0165da`，部署 ID `6dd828bb-3b4f-4814-89dc-ed7fe550680a`，Worker `d1c64f46-d57b-4b95-ba96-921222216475` 接收 100% 流量。证据明确标记 `localBuild: true` / `ciVerified: false`；未推送或触发 CI，不发布原生包和更新通知。

D1 / legacy 存储后端、迁移接口及工具已删除；版本详情确认无 D1 绑定和后端选择变量。与首版部署对比，既有 RegistryDO / HostRelayDO namespace 和 Secret 绑定完全一致，其余普通变量逐项匹配源码配置。当前源码手册已同步线上；原生下载包、清单及校验文件原样保留，本机 Agent 未升级或重启。

本机 462 项 Vitest、10 项 CTest、15 项部署回归、完整终端 E2E 和项目 E2E、类型、格式及构建通过。最终线上验证通过健康、4 项 API 和 3 项 WebSocket 认证边界、真实管理员身份、54 个主机目录、现有 Agent probe、86 条会话查询及 Terminal `streaming:2` 元数据；旧迁移接口返回 404。真实 Chromium 页面渲染，无未捕获异常，通知 WebSocket 返回 101 并保持超过 6 秒。线上没有模型调用、PTY 创建、接管、任务修改或凭据撤销。

首版 `d03db12` 已完成 Worker 功能发布；最终补发修订只涉及部署工具、验证脚本和手册，Worker 源码相同。线上测试脚本初次误期望所有拒绝均为 401，且遗漏 WebSocket upgrade / `delivery=2`，纠正后重测通过，不将这些脚本失败记作 Worker 功能故障。[来源、制品 SHA256、配置与验证证据](assets/do-only-2026-11-03/deployment.json)；[清理范围](DO_ONLY_STORAGE_2026-11-03.md)。私有日志和截图在 `.local/do-only-2026-11-03/`。

## Terminal 全流式传输 · 2026-11-03

按明确授权跳过 Actions，源码 `de93dc7` 已本地构建并部署网页、Relay 与本机 Agent。Worker `9938aa32-193b-4f8f-9753-58a2889239f3`；Agent 安装及 Relay 发布后的重新握手均通过 30 秒连接核验。健康、73 项资源字节、真实邮箱身份下 streaming:1 元数据和 WebSocket 控制权拒绝通过。原 D1、Secret、Agent 配置及数据库、原生公开下载保留，无更新通知。

486 项 Vitest、10 项 CTest、实际 PTY 与普通 Worker / D1 完整 E2E 已本地通过；本次没有生产 Shell 或按键延迟实测，不将本地回显样本作为线上承诺。首次中断恢复及重连原因见 [部署记录](CW_DEPLOYMENT_2026-11-03.md#terminal-全流式部署)，[来源、摘要与验证证据](assets/cw-terminal-stream-2026-11-03/deployment.json)。刷新 CW 加载新版。

## CW Markdown 阅读简化与图表操作 · 2026-11-03

按用户要求跳过 Actions，本地构建源码 `91577f1` 已部署至 https://r.xlogic.cc，Worker `88cdbff7-49ee-488f-874d-4dcc14cf06d6`。公式 / 图表自动渲染，元素全屏入口只在确有显示限制时出现，对话移除逐条文档工具栏；Mermaid 全屏提供缩放、平移、适应窗口和 100%。480 项 Vitest、类型、lint、整页 UI、Markdown 专项与生产资源 / CSP 浏览器验证通过，健康和 73 项资源字节一致。

本轮仅改网页，D1、Secret、配置和原生下载保留，本机 Agent 未重启。验证使用合成只读文件，无真实项目 Shell 或模型调用；未重跑原生及跨平台回归。[部署记录与截图](CW_DEPLOYMENT_2026-11-03.md) · [源码、摘要及验证证据](assets/cw-markdown-2026-11-03/deployment.json)。

## CW 刷新、主题与全屏增强 · 2026-11-03

按用户明确要求跳过 Actions，本地构建源码 `aa5df2c` 已部署到 https://r.xlogic.cc，Worker `d21edceb-8060-4361-a16f-6d79f1b613a3`。窗格 / Markdown 元素独立与嵌套全屏、Mermaid 主题跟随、OpenAI 公式语法及刷新减少探测 / 健康通道重连均已上线；健康、73 项资源字节、生产 CSP 下的公式 / 图表 / 全屏浏览器检查通过。现场 Agent 未修改、未重启，D1 / Secret / 原生下载保持原样。

479 项单元测试、类型、lint、整页 UI、Markdown 专项通过；原生 PTY 与 3 / 5 浏览器 E2E 结果和后续增量验证范围在 [部署记录](CW_DEPLOYMENT_2026-11-03.md) 中分别说明。线上按钮三次 3.836–4.857 秒，样本不代表稳定 SLO，进一步减少 HTTP 往返的方案见 [刷新分析](CW_REFRESH_PERFORMANCE_2026-11-03.md)。[产物与部署证据](assets/cw-refresh-2026-11-03/deployment.json)。

## CW 工作台、本机 Agent 与 Terminal · 2026-11-03

按用户明确要求跳过 Actions，使用本机构建部署网页 / Relay `8e2ae8a`（Worker `f283c218-9d27-4601-8f75-902966955de9`）及本机 Agent `ce22d38`。本机 Agent 已空闲升级、重启并通过 120 秒连接验证；随后按要求启用 Terminal 并再次空闲重启，30 秒验证通过。最终网页包含菜单收纳、可拖动文件树 / 预览 / 输出 / 终端，健康和公共资源字节核验通过。原 D1、Secret、凭据及数据库保留，公开原生包不变，无更新通知。

手动 Wrangler 部署造成的 STATE_MIGRATED 已恢复原 D1 绑定，并将绑定 / 模式 / Cron 固定到根配置，避免重现。477 项单元测试、整页 UI、实际 PTY 和完整 Chromium / Worker / Agent E2E 通过；本次不是 CI 制品发行。详细源码、摘要、保全及验证边界见 [本次部署记录](CW_DEPLOYMENT_2026-11-03.md) 与 [脱敏证据](assets/cw-workbench-2026-11-03/deployment.json)。刷新网页加载新版本，无需清理历史缓存。

## CW 缓存及重连续修本地部署 · 2026-11-02

按用户明确要求“直接部署本地代码，无需 github action”，通过 `scripts/deploy-cloud.py --local-build --state-db-id UUID --apply` 发布干净源码 `33a0d5e18a0cc95128670ab382c0e48a05c8450e`，未等待或使用该提交的 Actions 制品。本地构建、类型检查及 Worker dry-run 成功；此前 466 项 Vitest、完整 UI / 普通 Worker E2E、3 / 5 浏览器压力与双标签页 IndexedDB 专项通过，不将这些描述为完整 CI 验证。

Worker version `c852f4f1-9d78-43ee-9613-9a4146e78797` 已部署至 https://r.xlogic.cc，健康检查通过，首页、JS / CSS、在线手册、下载清单与校验和均与本次暂存产物逐字节一致。现有原生下载包先核对 SHA-256 后原样保留，未发布新原生包或更新通知。沿用 D1、生产变量、Secret 和 Cron，D1 无待执行迁移；本机 Agent 未升级、未重启。用户刷新所有 CW 标签页后使用新缓存逻辑，无需清空站点数据。未在本次部署中执行线上真实模型业务验收，用户实际浏览器缓存恢复及长期稳定性仍待观察。[部署及产物摘要](assets/cw-functional-2026-11-02/cache-recovery-local-deployment.json)。

## CW 回归与三平台发布 · 2026-11-02（musl 暂缓）

应用源码 df4caeacd2fd6d1878d7707ff73cda9f37d72c02 的 [Actions 41458682983](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41458682983) 六项必需作业全部成功，含普通 Worker / D1 的完整原生与 Chromium E2E、3 / 5 浏览器压力、UI 与缓存回归。使用同一运行的 CI 制品发布网页、Worker、Ubuntu 20.04、Debian 12 和 Windows x64 下载及源码归档；未使用本地编译二进制。

首次完整发布因 musl 0.6.1 归档 25.40 MiB 超过单个静态资源 25 MiB 被拒绝，Worker 尚未切换。用户明确要求先跳过此包；部署 helper f9c7864 新增显式暂缓选项，14 项专项测试通过，重新校验其余平台 CI 摘要并保留已验证 musl 0.6.0。下载页与清单 deferredPlatforms 明确标注，不发送自动更新通知。该 helper 提交与应用制品的源提交分别记录，未将 helper 的本地检查冒充完整 CI。

Worker version 84f23993-3ef8-4605-bd92-e3991d4000dc 已发布至 https://r.xlogic.cc，健康返回 0.6.1；网页、手册与清单字节一致，新三平台包、源码及保留的旧 musl 包重新下载后 SHA-256 全部匹配。沿用原 D1、配置和 Secret，无待执行迁移。本机 Agent 仍为 PID 3393555、active，未升级或重启。[制品与线上摘要证据](assets/cw-functional-2026-11-02/actions-deployment.json)；[完整测试和限制](CW_FUNCTIONAL_TEST_2026-11-02.md)。

bzip2 本地重压缩评估为 23.77 MiB，解压后的 tar 内容与 CI gzip 包一致，未发布；现有更新器仍只支持 .tar.gz，需适配后才能用于升级。[测量数据](assets/cw-functional-2026-11-02/musl-bzip2-measurement.json)。

截至本文件最后一次记录（2026-11-01），Worker / 网站及四平台原生下载均为 0.6.0；现场 Agent / CLI 仍需手动升级。以下是带日期的发布证据，不是运行实例的实时版本探测。

## 0.6.1 分阶段发布 · 2026-11-02（配套发行进行中）

按用户明确要求，先发布源码 `66e5fdb` 的 Worker / 网页，再等待修复后的完整 CI 发布配套原生包。[Actions 41417410092](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41417410092) 的 regression、sanitizers、三套 Linux 成功，Windows 历史来源测试夹具失败，不能描述为六项全绿。使用部署脚本严格 cloud-only 例外，禁止新原生下载及更新通知；原生下载仍为已验证 0.6.0。

首阶段 Worker 版本 `abec596d-269b-4658-a44e-9663176bfc41` 已接收 100% 流量，健康返回 0.6.1，首页、JS/CSS、手册及下载清单逐字节核验通过。既有归档 SHA256 重新核验后保留；沿用原 D1、变量、Secret 和 Cron，无待执行迁移。私有 D1 备份完整性通过，不包含活动 DO。真实无界面邮箱身份和管理员只读接口在发布后均验证 200。[首阶段制品、CI、部署和认证证据](assets/release-0.6.1-2026-11-02/stage-one.json)。

用户随后明确要求启动本机新版：当前用户 systemd Agent 已使用该提交的 musl CI 制品升级到 0.6.1，核验 GitHub artifact、包及二进制摘要，使用既有部署 helper 备份、替换并观察 120 秒，网站确认在线。此为明确授权的 Linux 本机测试，不代表四平台发行全部通过；其他用户 Agent 未操作。原程序、配置和 SQLite 私有备份保留。因本机代理超时，使用 runtime systemd drop-in 直连，不修改配置中的代理。旧历史约 270.2 MiB、最大会话约 67.1 MiB 超出默认配额；确认无活动任务后将本机 JSON maxBytes/maxSessionBytes 调整为 512/128 MiB 并重启，retainedRecords 未启用，未删除历史或重放请求。临时连接覆盖重启机器后失效，正式代理修复另行处理。

Windows 的规范路径和 node.exe 两处测试夹具已修复，缓存键改为按工具链及运行刷新；当前以 `9a4f889` 的新 CI 作为完整发行门禁。首阶段和本机测试不替代它，后续完成后追加最终证据。

## 0.6.0 协议简化发布 · 2026-11-01

源码 `4b164c62fe93581903d5ead53d367c4675a74360` 在 27 组本地发布回归全部通过后推送。[Actions 41314704820](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41314704820) 的 regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64 六项必需作业全部成功；分支 publish-release 正常跳过。此前两次失败运行没有用于发布。

通过 `scripts/deploy-cloud.py --publish-downloads --state-db-id UUID --apply` 核对六份 CI 制品的 GitHub SHA256 和一致源码身份，于 UTC 2026-11-01T14:39:49.248954Z 发布至 `https://r.xlogic.cc`。部署 ID `31237871-11ca-47b6-9943-5b6bb5ab8bc1`，Worker `24ddbf85-1264-4489-b0c0-fed5590f0ce5` 接收 100% 流量。健康返回 0.6.0，网页资源逐字节匹配，五份新归档和五份保留的 0.5.20 归档均重新下载核对 SHA256；九项无 CoC 凭据的认证边界检查通过。

业务使用唯一 delivery:2，发行 / 构建 protocol 保持 1。原生端需先等待任务结束、核对未知结果并备份，再手动升级；本次没有安装或重启现场 Agent / CLI，也没有发送自动更新通知，不能将下载包发布视为现场切换完成。旧业务明确拒绝，原始请求身份和新旧存储的恢复边界见 [切换步骤](TRANSPORT_CUTOVER.md)。

保留原 D1 UUID、变量、Secret、Cron 和授权状态，无待执行 D1 迁移。发布前私有 D1 导出通过 SQLite 完整性检查，但不包含活动 DO 状态；不构成完整生产回退检查点。线上未使用真实管理员浏览器身份或模型任务进行业务验收，认证后业务由最终 CI 隔离环境覆盖；长期稳定性仍待观察。下载手册保持 CI 制品原始字节，其中发布前状态由本页证据补充，不重新打包修改。

[完整发布证据、制品摘要与线上核验](assets/release-0.6.0-2026-11-01/deployment.json)。私有备份及日志保存在忽略目录 `.local/release-060/`，制品与部署记录在 `.local/deploy-cloud/41314704820/`。

## D1 查询与写入优化 · 2026-10-31

源码 `79caa1e59ea651f5339957032ee73d3ab592467b` 的 [Actions 41199314010](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41199314010) 六项必需 CI 全部成功，包含完整普通 / D1 原生与 Chromium 回归。通过 `scripts/deploy-cloud.py` 校验 SHA256 和源码身份后部署 Worker / 网站 0.5.21，Worker `1c0f47e5-aa74-4216-a8d5-be2dc21b1d88`。线上 7 项资源和 15 项认证边界核验通过；保留原 D1 UUID、后端模式、Cron 与原生 0.5.20 下载，未重启 Agent。优化减少事务重复读取和相同值重写，无 schema migration。整体日成本收益仍需同等流量的完整发布后窗口观察。[分析报告](d1-usage-2026-10-31.md)；[发布证据和制品摘要](assets/d1-usage-2026-10-31/deployment.json)。

## 远程配置、重启与 Agent 连接配置 · 2026-10-31

最终源码 `78418e6eccbe69bbb36dc05ffc7077092660f93c` 的 [Actions 41166072609](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41166072609) 六项必需作业全部成功：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64。包含真实 3 分钟重连、超过 30 秒仍可管理的客户端连接、配置 / 备份 / 重启去重、代理隔离、普通及 D1 后端和 Chromium 回归。仅此最终提交的制品用于发布。

通过 `scripts/deploy-cloud.py --publish-downloads --apply` 核对六份 CI 制品摘要与源码身份，于 UTC 04:21:44 发布至 `https://r.xlogic.cc`。部署 ID `d5e1124b-4582-4717-b0b8-7eb00d7f6ca2`，Worker `9c1014aa-fd41-4b07-b2d4-1368d85d5a04` 接收 100% 流量。健康接口返回 0.5.20，七项资源字节一致，十四项认证边界核验通过；五份新下载归档和五份保留的 0.5.18 归档均在线重新核对 SHA256。

“Agent 运行版本”使用独立 Tab，“Agent 更新”和“远程配置与重启”位于“杂项”。平台管理员可完整读取 / 替换在线原生端的启动配置文件，并显式确认重启。coc-client 退出后不可管理；重启关闭 TUI 并重新执行原启动命令。配置原文仅经 Worker 内存转发，本地私有备份与回执支持冲突和重复请求保护。Agent 快速重试耗尽后每 3 分钟继续重连，Codex 默认隔离 Agent 代理，可用 `codexUseProxy` 开启。

原生端须升级到 0.5.20 才能使用新功能；本次发布下载包，没有直接安装、发送更新通知或强制重启现场 Agent。保留现有 D1 UUID、变量、Secret、Cron 和授权数据，没有待执行迁移。发布前最新私有 D1 导出通过 SQLite 完整性检查，不包含活动 DO 状态。

线上未使用真实管理员邮箱会话或模型任务修改生产配置，认证后的功能由最终 CI 模拟身份与真实 Worker / 原生进程验证。当前生产 `/guest/*` 无入口凭据请求被 Cloudflare Access 重定向；带共享入口凭据时已验证 Worker 游客身份和权限，本次没有调整 Access 策略。Windows 原生 CTest 已通过，真实 TUI 重启流程在 Linux 夹具验证。[完整发布证据](assets/admin-tabs-2026-10-31/deployment.json)、[操作说明](REMOTE_CONFIGURATION.md)、[桌面 / 手机截图](assets/admin-tabs-2026-10-31/)。私有日志和备份位于忽略目录 `.local/admin-tabs-release/`，制品位于 `.local/deploy-cloud/41166072609/`。

## 运行版本展示与连续过程输出折叠 · 2026-10-31

最终源码 `cf755f0fedea06fb47b209fac23be0cb4c7bd6c3` 的 [Actions 41155282936](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41155282936) 六项必需作业全部成功：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64。包含普通 / D1 后端完整原生与 Chromium 回归，以及版本展示、连续过程输出分组、权限、缓存和恢复检查。版本展示提交 `ec6af90` 后补充了过程输出折叠，最终以 `cf755f0` 重新通过的完整 CI 发布。

通过 `scripts/deploy-cloud.py` 校验 CI Worker / web 制品摘要与源码身份，于 UTC 01:43:07 发布至 `https://r.xlogic.cc`。部署 ID `5773c7b8-e9b0-4528-9a58-e2c010f48801`，Worker `61056a3f-0ed0-48d4-ba22-7b6533f33cb7` 接收 100% 流量。线上健康返回 0.5.19，七项网页 / 手册 / 下载元数据逐字节一致，八项认证边界检查通过。

管理页面新增当前 Agent 运行版本表，区分在线、离线、未上报与未知状态；菜单底部显示当前网页构建版本。CW 连续的非对用户过程输出统一折叠为工具组，代码差异、计划及其它执行详情可逐项展开，保留增删高亮与按需读取；用户正文和面向用户的告警 / 状态保留为分界。

原生下载继续使用 `493912b` 的 0.5.18，五个归档在保留时重新核对 SHA256，发布后的下载清单和校验清单与发布前字节一致。没有发布新原生包、发送更新通知或重启 Agent。保留原 D1 UUID、STATE_BACKEND、Cron、Access 变量、Secret 和授权数据，没有待执行迁移；发布前私有 D1 导出通过 SQLite 完整性检查，不包含活动 DO 状态。

线上未使用真实管理员邮箱会话或模型任务验收；认证后的页面行为由最终提交的 CI 模拟身份验证。GitHub 官方元数据通过 Windows 网络出口读取，TLS 校验保持开启。[完整 CI、摘要、部署与线上验收证据](assets/version-display-2026-10-31/deployment.json)。[桌面 / 手机版本与折叠截图](assets/version-display-2026-10-31/)。私有备份和日志位于忽略目录 `.local/version-release/`，部署制品位于 `.local/deploy-cloud/41155282936/`。

## A / C 可靠会话传输与 CW 恢复 · 2026-10-31

源码 `493912b324361a751567c08f360f977cb0d34b60` 的 [Actions 41149659054](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41149659054) 六项必需作业全部成功：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64。完整普通 / D1 后端原生与 Chromium 回归通过，包括 CW 两个会话 WebSocket 同时停滞 OPEN 时经 HTTP 恢复命令、回复和完成状态，以及同一 CC TUI 网络重连、输出和结果丢失恢复。首次 `874e3b1` 运行因不同 clang-format 版本换行失败，修正后重新运行整套 CI，未部署失败运行制品。

使用 `scripts/deploy-cloud.py --publish-downloads --apply` 核对六份 CI 制品摘要和源码身份，于 UTC 00:42:15 发布至 `https://r.xlogic.cc`。部署 ID `96e52163-a6c5-4779-a558-90ca4138b922`，Worker `707c5aff-7734-468b-a468-61c14b0d432a` 接收 100% 流量。Relay、CW、四平台 Agent / CC 下载与源码归档均为 0.5.18，旧下载归档保留；未创建 GitHub Release 标签。

线上健康版本为 0.5.18，七项网页 / 手册 / 下载元数据与 CI 制品字节一致；重新下载五个归档后 SHA256 全部匹配。八项认证边界检查通过，新增 snapshot / delivery / progress 入口在无 CoC 凭据时均返回 401。压缩资源响应逐字节核验；额外的未压缩 HTML 探测含已有 Cloudflare analytics 注入，未将其视作构建资源变化。GitHub 匿名 API 限流后通过 Windows 网络出口完成官方元数据读取，TLS 校验保持开启。

保留原 D1 UUID、STATE_BACKEND、Cron、Access 变量、Secret 和授权数据；没有待执行迁移。发布前 D1 私有导出通过 SQLite 完整性检查，摘要记录在发布证据中，备份不包含活动 DO 状态。没有重启本机或远程活动 Agent，也没有重发任务。

**原生安装状态尚未确认。** 新通道须 Agent / CC 升级到 0.5.18；仅更新 Worker / CW 不会赋予旧 Agent 可靠协议保证。发布工具的通知请求先返回 403；通过支持的 guest 管理入口及部署 User-Agent 重试后返回 401，现有私有管理员凭据未获接受，因此自动更新通知未发出。可使用当前有效管理员登录在管理页通知更新，或从下载页安装；自动更新仍等待空闲。没有为完成通知而修改认证策略或凭据。

未使用真实用户邮箱会话或线上模型任务验收，不宣称已确认所有用户链路或所有 Agent 升级。协议范围、崩溃后结果不明边界与兼容行为见 [可靠传输说明](RELIABLE_TRANSPORT.md)。[完整 CI、摘要、部署与线上验收证据](assets/reliable-transport-2026-10-31/deployment.json)。私有备份在 `.local/reliable-release/private/`，制品和部署日志在 `.local/deploy-cloud/41149659054/` 及 `.local/reliable-env/`。

## 网页临时 HTML 错误识别 · 2026-10-30

源码 `94ddf5a50faae3a52fe0ca0e524321b07e93484d` 的 [Actions 41032404490](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41032404490) 六项必需检查全部成功：regression、sanitizers、Ubuntu 20.04、Debian 12、musl、Windows x64。通过 `scripts/deploy-cloud.py` 验证 Worker / web 制品 SHA256 和源码身份后，于 UTC 09:34:40 部署至 `https://r.xlogic.cc`；部署 ID `24cf366d-1df4-4168-8b1f-90859c98d251`，Worker `92a15b81-e5e9-4989-a5b3-3c77c380b162` 接收 100% 流量。

网页将 HTML 格式的 HTTP 429 / 5xx 保留为临时服务错误，避免误报邮箱登录失效并清空界面登录状态。线上健康检查、首页 / JS / CSS / 在线手册 / 下载清单 / 校验清单六项字节核验以及五项认证边界检查通过。服务入口 Token 不具备邮箱身份，邮箱接口按预期返回 JSON 403 `ACCESS_USER_REQUIRED`；无 CoC 凭证的普通与访客管理入口继续返回 401。

保留 0.5.17 四平台原生包及源码归档，复核已有归档 SHA256 后复用；没有发布新原生包或重启 Agent。保留 D1 UUID、STATE_BACKEND、Cron、Access 变量、Secret 和授权数据；没有待执行迁移。发布前 D1 私有备份通过 SQLite 完整性检查，不包含活动 DO 状态。未取得真实用户邮箱浏览器会话，原始间歇性故障尚未复现；本次确认修复错误分类缺陷，不宣称已解决其上游根因。

[CI、制品摘要、部署身份与线上核验记录](assets/access-html-errors-2026-10-30/deployment.json)。私有备份及本机诊断位于忽略目录 `.local/access-error-release/`，部署日志位于 `.local/deploy-cloud/41032404490/`。

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

公钥获取修复源码 `e717628` 的 [Actions 40805956178](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40805956178) 六项必需作业全部成功。用户手工更新 Worker 后恢复网页入口；随后恢复经过 CI 摘要核验的网页产物，修正旧 `dist/web` 覆盖自动管理员登录界面的问题，并保留已验证的 0.5.14 下载包。用户于 2026-10-29 确认管理员权限已恢复；此项为真实浏览器的用户确认，后续手工发布的 Worker 版本 ID 未另行采集。详见[修复与验收记录](history/TEST_REPORT_2026-11-01.md)和[网页恢复证据](assets/access-jwks-2026-10-29/frontend-restore.json)。
