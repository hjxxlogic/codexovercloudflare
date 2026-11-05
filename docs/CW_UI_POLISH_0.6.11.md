# CW 0.6.11 紧凑导航与浮动工具栏

2026-11-06，延续 0.6.10 的三级导航，仅修改 Web、Web 验证、版本元数据和文档。Worker / Agent 业务代码保持。

## 实施

- 主机 / 项目 / 会话未激活时，层级名称与当前选择并排占一行，长选项省略；保持上级有效性与单层展开。
- 项目刷新固定显示在新建按钮左侧，关闭新建表单也可刷新列表。新建路径预填当前项目或已有项目的父目录，未知时 `/`，供用户继续填写同级目录；支持 POSIX / Windows 路径。刷新不覆盖用户编辑，成功提交后保留该目录的父目录作为下一次默认值。沿用原权限与可靠操作。
- 设置中操作图标附带可见文字，主题 / 语言 / 密度 / 尺寸也显示图标标签；左栏底部仍只有设置入口。
- 信息改原生模态对话框，支持 Escape、原生焦点限制与关闭后恢复信息按钮；信息正文独立滚动，关闭和恢复 / 会话操作留在可见区域。对话和 Terminal 继续挂载，未新增会话业务。
- 文件树、预览、输出的标题和操作合为固定工具栏，长内容独立滚动。Markdown 文档、全屏代码 / 表格 / 图形、模型和快捷操作对话框保留可见操作。
- 会话内复制按钮默认隐藏，悬停消息 / 工具、点击可聚焦内容或键盘聚焦后显示；仍可通过键盘操作，文件面板与独立预览的复制常显。折叠工具调用的标题最多一行，长命令省略，展开后保留完整内容。

## Web 验证与边界

通过 `npm run typecheck`、受影响文件 ESLint / Prettier、`npm run build:web`、`npm run test:ui:navigation`、`npm run test:markdown`。浏览器专项增加：折叠高度与单行布局、刷新顺序 / 常显、已有项目父目录与无项目根目录默认值、复制 hover / click / focus、多行长命令折叠、长信息滚动后的关闭 / 会话操作位置、Escape 焦点恢复、设置文字和图标、长文件与全屏的恢复 / 关闭 / 下载工具可见性。既有桌面、390×844 / 320×568 / 844×390 手机导航和富文本检查继续保留。

不执行完整仓库、原生、模型任务或完整 CI。授权 / 项目变更继续使用原流程，仅检查 Web 呈现；Terminal 仅验证 UI 保留，不启动真实 Shell。r2 线上使用 `scripts/verify-web-navigation.ts`，只读既有测试主机，结束撤销临时 Web 凭证，不创建 / attach 会话或发送任务。

## 发布

按用户已授权的 r2 本地预览路径发布，`ciVerified=false`，提交带 `[skip ci]`。原生下载保持已验证 0.6.7，不替换或重启原 Agent / 测试 Agent；发布前后复核旧站、DO、路由、Access audience 及两个 Agent 身份。准确来源、摘要和线上结果记录在 [r2 发布记录](R2_DEPLOYMENT.md)。

## 截图

[紧凑左栏](assets/cw-ui-polish-0.6.11/navigation-desktop-light.png)、[项目操作](assets/cw-ui-polish-0.6.11/hierarchy-projects-new.png)、[设置图标文字](assets/cw-ui-polish-0.6.11/navigation-settings.png)、[文件工具栏](assets/cw-ui-polish-0.6.11/navigation-files.png)、[信息对话框](assets/cw-ui-polish-0.6.11/information-dialog.png)、[长信息滚动](assets/cw-ui-polish-0.6.11/information-dialog-long.png)、[手机](assets/cw-ui-polish-0.6.11/navigation-mobile-390.png)。均使用模拟数据，不包含线上凭据。
