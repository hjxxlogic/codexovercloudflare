# CW Catppuccin Mocha 部署记录（2026-11-13）

按用户明确要求，提交并部署完整元素配色修正，跳过 GitHub Actions。功能源码提交：`07245af65bc1234bef4f1751d7b41ebf1f3bfec5`，提交带 `[skip ci]`。没有本次 Actions URL 或 Actions 制品，`ciVerified=false`。

目标：https://r.xlogic.cc；网页版本保持 `0.6.20`。Cloudflare Version ID：`a97cc150-6ece-4dd4-b630-09c3976e2045`。

通过仓库 `scripts/deploy-cloud.py --local-build --commit HEAD --target production --web-only-from <上一份已验证 deployment.json> --apply` 发布。保留 Worker 可执行模块、配置和原生下载；部署后 Worker 模块摘要一致。

源码摘要：`a22284c73df75c713c28596ad328c0a5dd7750f6c47da7dc3232d6db4b17f263`。

主题 CSS SHA256：`05380023529f2588e1f5001a198ef56106c669d3c0d28c91c23823fc20ea67e1`。

验证通过：网页构建、TypeScript 类型检查、Prettier、差异空白检查、本地浏览器 11 类元素颜色与深浅主题检查。线上浏览器确认背景、正文、侧栏和强调色采用 Mocha；服务健康正常，逐项公开资源与部署制品字节一致。未运行完整 CI 或原生测试。浏览器线上检查未获得邮箱授权，仅观察 shell；会话内容元素的渲染使用本地展示样本验证，未接管任务。

首次部署已成功发布，但随后的 Worker 校验遇到 OAuth 401；运行 Wrangler `whoami` 后模块校验成功，复用仓库脚本的全部只读发布后检查完成验证，没有重复部署。

完整机器本地证据：`.local/deploy-cloud/local-07245af65bc1234bef4f1751d7b41ebf1f3bfec5-a22284c73df7-web-only/deployment.json`、`.local/cw-cli-colors/deploy.log`、`.local/cw-cli-colors/verify-deployment.log`；对比截图与颜色断言也位于 `.local/cw-cli-colors/`。本记录为部署后的文档提交，线上源码身份仍为上述功能提交。
