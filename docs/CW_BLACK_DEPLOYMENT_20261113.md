# CW 纯黑背景部署记录（2026-11-13）

按用户要求，将网页主背景和 Terminal 改为纯黑 `#000000`，侧栏、输入区、消息、卡片、边框、悬停与选区改用中性灰，保留 Mocha 彩色文字和语法高亮。用户已查看线上截图并确认效果满意。

功能源码提交：`c24a42c2966b50a270b81b102b7a1dd97265de57`，提交带 `[skip ci]`。部署到 https://r.xlogic.cc，版本保持 `0.6.20`；用户明确授权跳过 GitHub Actions，`ciVerified=false`，没有本次 Actions URL 或 CI 制品。

通过仓库 `scripts/deploy-cloud.py --local-build --commit HEAD --target production --web-only-from <上一份已验证 deployment.json> --apply` 发布。Cloudflare Version ID：`3bd50c84-e55a-4bee-80d9-255c992b6488`。

源码摘要：`906d8dd8fd231baa60af1f51a7136522301cece85bec68588294b6000ac703c8`。

主题 CSS SHA256：`c6a9a7e90e3e834eda7fac65c2535dc699e5956e03513e00fccd2442afb4ad19`。

验证：网页构建、类型检查、Prettier、差异空白检查；Chromium 确认显式深色和系统深色的主背景纯黑、八类表面颜色 RGB 通道一致，原有 11 类文字颜色与浅色检查通过。线上浏览器截图确认纯黑主背景和中性灰侧栏；服务健康、全部公开资源字节一致性及 Worker 模块保留校验通过。未运行完整 CI 或原生测试，未接管远程会话，线上浏览器仅查看未获邮箱授权的 shell。

机器本地证据：`.local/deploy-cloud/local-c24a42c2966b50a270b81b102b7a1dd97265de57-906d8dd8fd23-web-only/deployment.json`、`.local/cw-cli-colors/deploy-black.log`、`.local/cw-cli-colors/online-black.png`、`.local/cw-cli-colors/online-black.json`。本记录为部署后文档提交，不改变线上源码身份。
