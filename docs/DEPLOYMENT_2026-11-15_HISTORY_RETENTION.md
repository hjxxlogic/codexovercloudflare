# CW 最新历史优先网页部署（2026-11-15）

按用户明确要求，提交后仅部署网页，跳过 GitHub Actions。网页源提交为 `22379c516f2da2a9310001ca27be327b3f01d1a5`，已推送 GitHub，提交包含 `[skip ci]`。本次没有 Actions 运行 URL，不将本地产物标记为 CI 验证发布。

通过 `scripts/deploy-cloud.py --local-build --web-only-from .local/deploy-cloud/local-4636b50e0a604b38ce2ac62ddf233c159882dd36-c8d02a7ab4b7-web-only/deployment.json --apply` 部署到 `https://r.xlogic.cc`。Cloudflare 版本为 `cb39b17a-265e-4291-90ad-6859d578addc`。

发布前后 Worker 可执行模块完全一致：`index.js` SHA256 为 `109b151b7305b0548d5e92a2a2404c0de3a6416b88cb8b2c1396fc393016d235`；Worker 保持原有 `0.6.20`。健康检查通过，线上入口和静态构建资源与产物逐字节一致。配置、凭据、存储及原生下载保留；没有更新 Agent 或重启活动任务。

| 网页入口脚本                    | 摘要                                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| `site/assets/index-DqHWsnEU.js` | `sha256:dfc58a142073d9a2e62f9d58bb08517a1ef9a30786b1eed5e1f7d819978d7d9b` |

验证包括全量 Vitest 42 文件 / 491 项、真实 IndexedDB 缓存回归、手机配额异常 UI 回归、TypeScript、相关 ESLint、Prettier 和网页构建。覆盖字节 / 条数满额轮换、跨会话淘汰、旧事件新修订、回填不挤掉新事件、账本一致性及恢复信息保护。没有执行线上模型任务。浏览器实际存储配额故障、单条超限或受保护状态占满预算仍可能阻止写入，此时继续在线读取，绝不虚报持久化；本次自动轮换针对普通历史逻辑容量。

完整本机证据在忽略路径 `.local/deploy-cloud/local-22379c516f2da2a9310001ca27be327b3f01d1a5-135e5b0d5cdb-web-only/deployment.json`，日志在 `.local/cw-history-deploy.log`；相关本地构建与 UI 回归日志为 `.local/cw-history-build.log` 和 `.local/cw-history-quota-ui.log`。
