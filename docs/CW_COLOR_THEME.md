# CW 深色主题来源与验证

2026-11-13 检查本机 Codex CLI 0.167.2，用户配置未设置 `tui.theme`，没有自定义 `.tmTheme`。该版本在深色终端中默认选择 `catppuccin-mocha`，浅色默认选择 `catppuccin-latte`。这是配置及源码确定的默认选择，不代表其他终端或运行中临时切换的主题。

来源：[Codex 0.167.2 高亮主题选择](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/tui/src/render/highlight.rs)、[Codex 表面和语义样式](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/tui/src/style.rs)、[Catppuccin Mocha TextMate 颜色映射](https://github.com/catppuccin/bat/blob/main/themes/Catppuccin%20Mocha.tmTheme)。

CW 使用 Mocha 作为完整网页主题：正文 `#cdd6f4`、辅助文字 `#a6adc8`、蓝色函数／链接 `#89b4fa`、紫色关键字 `#cba6f7`、绿色字符串／成功 `#a6e3a1`、橙色数字 `#fab387`、黄色类型／警告 `#f9e2af`、红色错误／删除 `#f38ba8`、注释 `#9399b2`。同时覆盖 Markdown 强调、角色标签、工具标题、会话状态、增删差异与选区。Terminal 显式配置 Mocha ANSI 16 色。

CLI 的默认正文、底色和 ANSI 状态色仍由终端拥有，不能把语法主题的背景直接当作每个用户的终端背景。CW 没有可读取外部终端主题的接口，因此使用 Mocha base `#1e1e2e`；输入区和已提交消息遵循 CLI 在深色底色上分别混入 12%／16% 白色的规则。网页里的角色、工具和 Markdown 强调按语义映射到 Mocha，网页与 CLI 的高亮引擎、元素类型不同，不承诺所有 token 一一相同。

验证：网页构建、TypeScript 类型检查、Prettier 和差异空白检查；Chromium 加载实际样式及 highlight.js 生成的 TypeScript 高亮，检查 11 类文字／状态／差异颜色，并检查系统深色回退和显式浅色模式。覆盖实际 `.happier-cw` 容器，避免高优先级旧样式覆盖输入区和消息表面。

本机截图、ANSI 捕获及颜色断言保存在忽略目录 `.local/cw-cli-colors/`。线上检查只读取到未授权主机的 shell，未读取或接管远程任务；完整会话内容的视觉验证使用本地展示样本。此记录描述源码修正，不表示已部署。
