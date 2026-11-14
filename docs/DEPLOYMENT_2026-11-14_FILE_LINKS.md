# CW 文件链接识别修复网页部署（2026-11-14）

按用户明确要求，仅部署网页并跳过 GitHub Actions。源提交：`4636b50e0a604b38ce2ac62ddf233c159882dd36`，已推送 GitHub，提交带 `[skip ci]`；本次没有 Actions 运行 URL，本地产物不标记为 CI 验证发布。

使用仓库 `scripts/deploy-cloud.py --local-build --web-only-from .local/deploy-cloud/local-58b8734c2d92443f5a29212ad7d2d4dab3ce03f9-7eacb1d6a878-web-only/deployment.json --apply` 部署至 `https://r.xlogic.cc`。Cloudflare 版本：`f41437b3-0e3d-4f56-924b-62fd4a435239`。

发布前后 Worker 可执行模块 SHA256 一致：`index.js` 为 `109b151b7305b0548d5e92a2a2404c0de3a6416b88cb8b2c1396fc393016d235`。Worker 保持 `0.6.20`，健康检查通过；配置、凭据、存储及原生下载保留。脚本确认线上网页入口及静态构建资源与发布产物逐字节一致。

| 入口脚本产物                    | 摘要                                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| `site/assets/index-DoY8ev6H.js` | `sha256:172e8c8f53a164394b1711bf17b3d59593b5b556f7364f5a2f2cdf8dc708b98a` |

部署首次在发布前遇到 Cloudflare OAuth HTTP 401，运行 Wrangler `whoami` 刷新现有登录后重试成功；发布后资源校验的网络中断经脚本重试恢复。本地文件链接专项 12 项测试、TypeScript、相关 ESLint、Prettier 及部署中的网页构建通过。未调用模型、未重启 Agent，未执行线上会话交互测试。

完整部署身份、产物摘要与线上验证记录在忽略路径 `.local/deploy-cloud/local-4636b50e0a604b38ce2ac62ddf233c159882dd36-c8d02a7ab4b7-web-only/deployment.json`；日志在 `.local/cw-file-links-deploy.log`。
