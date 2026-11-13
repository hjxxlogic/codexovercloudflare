# CW 深色配色部署记录（2026-11-13）

按用户要求跳过 GitHub Actions，将提交 `94b7e5611c916459783b0edd3c9bf886ea78baa1` 的本地网页构建部署到 https://r.xlogic.cc。`ciVerified=false`，没有本次 Actions 运行 URL 或 CI 制品。

使用仓库 `scripts/deploy-cloud.py --local-build --commit HEAD --target production --web-only-from <上一份已验证 deployment.json> --apply`。保留线上 Worker 模块、配置、原生下载与现有会话；部署后 Worker 模块摘要校验通过。

Cloudflare Version ID：`d1c79722-63d2-448f-a93e-09392e8a43a8`。

源码摘要：`be7dabb184c954e7c5e60e97608ac95a32d58a3ad8751844288accdb87d5f9ec`。

主题 CSS SHA256：`f4c6109f274e95ba2558a85c73f9dd42cf3b86062e52d104630c93e2cf0f8406`。

网页构建、TypeScript 类型检查、格式检查与浏览器深色／系统／浅色主题检查通过。线上健康检查正常，发布脚本逐项校验公开资源与部署制品字节一致。未运行完整 CI 或原生测试。

机器本地证据：`.local/deploy-cloud/local-94b7e5611c916459783b0edd3c9bf886ea78baa1-be7dabb184c9-web-only/deployment.json`；执行日志：`.local/cw-dark-deploy.log`。本记录为部署后的文档提交，不改变线上功能源码身份。
