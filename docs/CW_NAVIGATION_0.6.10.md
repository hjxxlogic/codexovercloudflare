# CW 0.6.10 三级导航与图标操作

2026-11-05，按本轮确认的讨论实现，仅修改 Web 界面、Web 验证、版本元数据与文档。Worker / Agent 业务代码未改。

## 实施过程

1. 左栏标题改为会话图标、邮箱 `@` 前的用户名和收起按钮；没有邮箱时显示“用户”。底部仅设置，许可证仍保留在资源与来源文档中。
2. 主机、项目、会话改为互斥折叠层级，始终展开一层，标题显示当前选择。主机有效后解锁项目，项目有效后解锁会话。选择主机进入项目，选择项目进入会话；更换上级清空下级选择，避免旧缓存自动跳过选择步骤。已有有效工作区在刷新时仍可恢复。
3. 主机列表下提供申请授权与主机刷新，展开原授权表单、邮箱身份和移除本地授权操作；取消设置中重复的连接与授权页。项目列表下新建项目复用原 `ProjectManager`、权限和可靠操作；没有管理权限时展示原拒绝说明。会话新建置于列表上方，搜索 / 历史 / 分页保留；欢迎页不再重复选择会话。
4. 统一文件、Terminal、输出、信息、预览、全屏、Markdown 工具和设置操作图标。工具提示支持悬停、键盘聚焦及 Escape，通过 `aria-label` / `aria-describedby` 关联；模态框中的提示放在模态框层内。选择条目 / 视图页签保留名称，审批与危险操作确认保留明确文字。
5. 浏览器检查发现：切换主机后仍挂载的隐藏文件面板会读取空项目。增加空作用域检查，并按主机 / 项目重置文件表单。收起右面板仍保留传输；传输期间禁止改变目标。仅折叠导航、切换设置不结束任务或销毁 Terminal。

## Web 验证

通过 `npm run build:web`、`npm run typecheck`、受影响文件 ESLint / Prettier、`npm run test:ui:navigation` 和 `npm run test:markdown`。

导航浏览器专项使用加密模拟接收端，覆盖三级互斥、上级解锁、邮箱前缀、授权与新建项目表单、权限不足提示、切换主机清空下级、项目 / 多会话切换、草稿隔离、五按钮、文件预览 / 上传入口、右面板互斥、Terminal DOM 保留、主题 / 密度 / 尺寸、管理登录和左栏。工具提示检查包括 hover、focus、关联 ID、Escape 和纯图标按钮。手机覆盖 390×844、320×568、844×390，检查抽屉、焦点恢复与横向溢出；无浏览器异常。Markdown 专项检查表格、代码、公式、Mermaid、全屏和长内容。

授权及新建项目本轮只检查 Web 表单与权限呈现，未再次执行真实授权业务和远程项目变更；Terminal 只检查显示和挂载，未启动 Shell。按用户要求未执行完整仓库、原生、模型任务或完整 CI。旧 `test:ui` 压力路径保留，本轮通过范围为新的 `test:ui:navigation`。

## 截图

[主机与授权](assets/cw-navigation-0.6.10/hierarchy-hosts-authorization.png)、[项目与新建](assets/cw-navigation-0.6.10/hierarchy-projects-new.png)、[桌面会话](assets/cw-navigation-0.6.10/navigation-desktop-light.png)、[手机](assets/cw-navigation-0.6.10/navigation-mobile-390.png)、[文件面板](assets/cw-navigation-0.6.10/navigation-files.png)、[设置](assets/cw-navigation-0.6.10/navigation-settings.png)、[管理](assets/cw-navigation-0.6.10/navigation-admin.png)。均为模拟数据，无线上凭据。

## 发布方式与边界

用户明确要求只测试 Web UI 并部署，使用 `scripts/deploy-cloud.py --local-build --target r2` 的预览路径，`ciVerified=false`；源码以 `[skip ci]` 提交，不触发完整 CI。只更新 r2 Web / Worker 包装制品，原生下载保持已验证 0.6.7，不编译、不替换、不重启任何 Agent。

上线仅运行 `scripts/verify-web-navigation.ts`，为既有隔离测试主机申请临时 Web 凭证，验证页面和读取操作；不创建 / attach 会话、不发送任务、不启动终端，结束撤销自身临时凭证。发布前后比较旧站 Worker、DO、路由、Access audience 及两 Agent 的 PID / 启动标识。准确源码、摘要、Worker Version ID 与上线结果记录到 [r2 发布记录](R2_DEPLOYMENT.md)。
