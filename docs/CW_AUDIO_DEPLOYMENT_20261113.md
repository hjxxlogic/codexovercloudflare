# 2026-11-13 音频播放控件部署

按用户授权跳过 GitHub Actions，使用干净提交 `bf750b10111caa6fb094e67df3c74e6e6ec136e4` 的本地网页构建部署到 https://r.xlogic.cc。`localBuild=true`、`ciVerified=false`，本次没有 Actions 制品或运行 URL。

MP3 等音频文件直接显示小型播放／暂停按钮和文件名，点击后读取并播放，无需展开链接；支持结束后重播和失败重试。

通过仓库 `scripts/deploy-cloud.py --local-build --commit bf750b1 --target production --web-only-from .local/deploy-cloud/43241338652/deployment.json --apply` 发布。Cloudflare Version ID：`a9696506-56b1-4d10-aca8-7a6214937a46`。

- 网页源码摘要：`4483c285ac2f079054c740ae9db495bb4def5a635e0ab588ab3672b1c3bbe43b`。
- 首页 SHA256：`aa126667d68a73a686cadf051ac08fbf3a8e08ec4f77902a3b8b66f951d529b7`。
- 保留 Worker SHA256：`109b151b7305b0548d5e92a2a2404c0de3a6416b88cb8b2c1396fc393016d235`；发布后模块核对通过。
- 保留现有 Worker 配置、凭据和原生下载，不更新 Agent / CLI，不触发模型任务。
- 类型检查、受影响文件 ESLint / Prettier、11 项文件链接测试及网页构建通过。
- 部署脚本健康检查通过，线上首页及全部静态资源字节与准备产物一致。未在生产已登录会话或 Safari 上实测音频播放。

首次尝试在发布前遇到 OAuth 401；刷新现有 Wrangler 登录后重试完成。机器本地证据保存在忽略目录 `.local/deploy-cloud/local-bf750b10111caa6fb094e67df3c74e6e6ec136e4-4483c285ac2f-web-only/deployment.json` 和 `.local/audio-check/deploy-retry.log`。本记录为后续文档提交，不改变线上功能源码身份。
