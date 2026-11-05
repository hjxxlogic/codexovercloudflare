# CW 0.6.9 统一导航

2026-11-05，按确认后的讨论实施并发布到 r2。仅改 Web 组件、布局、翻译、版本元数据及 Web 验证入口，Worker 和 Agent 的业务代码未改。

## 实施结果

- 所有页面共用左栏。CW 中从上到下选择主机、项目和会话，搜索、分页、新建、历史续接在原位置完成；桌面可完全收起，手机使用可 Esc 关闭的抽屉，选中会话后自动关闭。原会话记录入口、历史弹窗和右侧全局菜单取消。
- 左下固定设置入口，默认进入外观。主题、语言、版本、模式切换、密度和尺寸偏好集中在设置页，连接授权、项目管理和退出置于连接与授权页；管理各面板在同一左栏切换。
- 右上依次为文件浏览器、Terminal、命令输出、刷新、信息。文件、命令输出和信息共用右侧工作面板；Terminal 保留底部，隐藏后保持挂载，设置页覆盖展示时也保留工作台。
- 文件树、原文件传输与内嵌预览统一为文件浏览器。“浏览 / 上传与传输”切换保留原上传恢复、覆盖确认和权限检查；隐藏面板不取消传输。传输期间禁用主机 / 项目与模式切换。没有新增文件接口或上传实现。

## Web 验证

`npm run typecheck`、受影响 Web / 测试脚本 ESLint 与 Prettier、`npm run build:web`、`npm run test:ui:navigation`、`npm run test:markdown` 通过。

导航浏览器测试复用原 UI 压力用例中的加密模拟接收端，新增独立 `--navigation` 路径，避免启动真实 Agent 或模型。覆盖桌面收起释放宽度、搜索、项目 / 多会话切换、会话草稿隔离、五按钮顺序、文件树与富文本预览、传输入口、右面板互斥、Terminal DOM 保留、设置返回无重新 attach、深浅主题、密度 / 尺寸、管理登录和左栏导航。手机覆盖 390×844、320×568、844×390，检查抽屉关闭、焦点恢复与页面无横向溢出。浏览器无未处理异常。

高级 Markdown 单独检查表格、代码、公式、Mermaid、全屏和长内容。Terminal 的本轮检查仅覆盖 UI 挂载和显示切换；没有启动真实 Shell。未执行完整仓库测试、原生测试、模型任务、完整 CI，亦未宣称这些检查通过。旧 `test:ui` 压力路径仍保留，其旧导航断言未列入本次通过范围；本轮以 `test:ui:navigation` 验收新的导航合同。

上线只运行 `scripts/verify-web-navigation.ts`：使用临时浏览器授权读取既有隔离测试主机，检查实际网页、设置、文件面板、移动抽屉和管理导航，不创建 / attach 会话，不发送任务，不启动终端；结束撤销自身临时网页凭证。

## 截图

[桌面](assets/cw-navigation-0.6.9/navigation-desktop-light.png)、[手机](assets/cw-navigation-0.6.9/navigation-mobile-390.png)、[统一文件面板](assets/cw-navigation-0.6.9/navigation-files.png)、[设置](assets/cw-navigation-0.6.9/navigation-settings.png)、[管理](assets/cw-navigation-0.6.9/navigation-admin.png)。截图使用模拟数据，不包含线上凭据。

## 发布约束

用户明确要求仅测试 Web UI，采用现有脚本的本地预览发布路径，`ciVerified=false`，不触发或等待完整 CI。源码以 `[skip ci]` 提交；原生下载保留已有验证版本，不编译、不替换、不重启原 Agent 或独立测试 Agent。旧站与 r2 DO namespace 保持隔离。准确提交、Worker Version ID、摘要与上线结果见 [r2 发布记录](R2_DEPLOYMENT.md)。
