# 活动会话显示本机验证（2026-11-08）

CW 欢迎页在“今天要一起完成什么？”上方显示活动会话，支持从卡片直接进入对应服务器和项目。左侧当前项目会话列表优先显示运行中及其他打开的会话，同一优先级按最近活动排序；标题仍优先采用 Codex 名称 / 预览。

历史首页只返回 100 条，且不保证活动记录位于首页。网页现按 ready / starting / closing 分别读取全部分页，欢迎页按邮箱归属筛选，访客使用已有 CoC 授权范围；左侧将完整活动记录与历史首页合并并保留原历史游标。合并优先保留较新的状态和删除屏障。同一线程有多个 runtime 时，运行中的会话优先，避免较新的空闲记录掩盖运行任务。

状态同时显示文字、圆点及适配明暗主题的颜色：运行中绿色、已打开蓝色、启动中 / 结束中橙黄色、已中断红色、已结束 / 历史灰色。“已打开”表示 runtime 仍在，但当前没有模型任务运行。已选会话的运行标记跟随在线状态。

## 验证

- `npm run typecheck`、`npm run lint`、`npm run build:web` 通过。
- 全部 Vitest 通过：37 个文件、408 项测试。新增覆盖活动分页、状态、重复游标、历史游标保留、迟到结束状态、删除屏障及线程合并后的优先级。
- `npm run test:ui` 通过：导航、手机抽屉、设置、主题、草稿 / 语言 / 模型、原请求及审批恢复、缓存满后保持在线、归档 / 删除；新增活动会话专项使用 100 条更新的历史记录和两页活动目录，验证欢迎页排序、手机 / 桌面颜色、直接进入主机 / 项目及左侧跨项目补齐。
- `npm run test:access:web` 通过：邮箱跨浏览器授权恢复、管理员、双语登出，以及真实 Worker 的访客路径、配对、加密连接准入与撤销。授权 fixture 已适配欢迎页预先读取全部获准主机，仍断言每台仅恢复一次凭据、选择及重访不重复恢复。
- `npm run test:billing:web` 通过：模拟空闲一天，CW 与管理员周期请求均为 0，手动刷新与撤销更新正常，无浏览器异常。

以上界面使用本地构建和隔离 Chromium fixture，未在真实 iPhone / Safari 上验证。本次只修改网页，未重新运行原生或真实模型测试；前次完整本机验证见 [归档 / 删除测试记录](LOCAL_ALL_TESTS_20261108.md)。原始日志保存在忽略目录 `.local/active-sessions-*.log`。

## 截图与部署状态

截图使用模拟主机和历史，无真实凭据或用户会话：[手机欢迎页](assets/active-sessions-20261108/active-welcome-mobile.png)、[桌面欢迎页](assets/active-sessions-20261108/active-welcome-desktop.png)、[手机左侧列表](assets/active-sessions-20261108/active-sidebar-mobile.png)、[深色列表](assets/active-sessions-20261108/active-sidebar-dark-mobile.png)。

网页已按用户明确要求跳过 GitHub Actions，仅更新 [主站](https://r.xlogic.cc)。功能源码提交 `a5e5719e333af36a24402d53f69d3e4b5487aa6c` 已推送 GitHub `master`，提交含 `[skip ci]`；Actions API 查询该提交的运行数为 0。网页为本机构建，`ciVerified=false`，源码摘要 `fa99c387de6574ba9aa35155ce1d8514b0b2f14cd6883ec5b1d65e0270f166de`。

通过仓库脚本 `python3 scripts/deploy-cloud.py --local-build --target production --commit HEAD --web-only-from .local/deploy-cloud/42437371362/deployment.json --apply` 部署，当时 HEAD 为上述功能提交。Cloudflare 将代码与静态资源绑定为同一版本，生成版本 ID `0cc84833-3b65-4e67-8ce1-5f94b5996f53`；Worker 仍复用 `91d3093217162db95168d3565cc9d92411fa2bda` 的已验证 CI 制品，执行模块发布前后 SHA256 一致：`910b488cbf0173e1dc6b41f4f9f120d3f6406edf12968b64ffa7b789f2ce7e62`。未替换变量、Secret、Access 或 DO 配置，未发送更新通知。

部署后健康检查为 `ok=true`、`version=0.6.17`；首页、全部网页静态资源、下载说明及清单均已回读并与准备目录逐字节核对。四平台下载包保留 0.6.17，包在准备阶段按既有 SHA256 重新校验，下载元数据 / 手册 / 主题与部署前完全一致。本机 Agent 服务部署前后 PID 与运行状态一致，没有安装或重启 Agent。网页及保留 Worker 的来源、入口资源摘要和验证结果见 [部署证据](assets/active-sessions-20261108/deployment.json)，完整机器证据位于忽略目录 `.local/deploy-cloud/local-a5e5719e333af36a24402d53f69d3e4b5487aa6c-fa99c387de65-web-only/`。

本机 Agent 与配套 CLI 已在此前步骤使用准确源码提交 `91d3093217162db95168d3565cc9d92411fa2bda` 的成功 CI 制品升级至 0.6.17，验证及摘要见 [发布记录](SESSION_MANAGEMENT_RELEASE_20261108.md)。
