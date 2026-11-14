# CW Mermaid 网页部署（2026-11-14）

按用户明确要求，仅部署网页并跳过 GitHub Actions。源提交：`58b8734c2d92443f5a29212ad7d2d4dab3ce03f9`；已推送 GitHub，提交包含 `[skip ci]`。本次没有 Actions 验证或运行 URL，本地产物不标记为 CI 验证发布。

使用 `scripts/deploy-cloud.py --local-build --web-only-from .local/deploy-cloud/local-edc7beeab9db6573dedb2e0e31757a1919764f07-3461ff2dd46a-web-only/deployment.json --apply` 发布到 `https://r.xlogic.cc`。Cloudflare 版本：`f36b8da3-130f-45af-bd82-3f12d7593a62`。

脚本确认发布前后 Worker 可执行模块完全一致，`index.js` SHA256 为 `109b151b7305b0548d5e92a2a2404c0de3a6416b88cb8b2c1396fc393016d235`；Worker 仍为原有 `0.6.20`，健康检查通过，变量、凭据、存储及原生下载保留。网页入口与构建资源逐字节核对通过；另补查真实 `/diagram` 入口、图表脚本和引擎，与本地产物一致。

| 资源                          | SHA256                                                           |
| ----------------------------- | ---------------------------------------------------------------- |
| diagram.js                    | a6b0ff8610aa49ef3a6116dd6a9e046eb270733296c787651beda0d45ad4ffad |
| diagram.html（线上 /diagram） | 35b973a86f2d3727bb00b9b9071634ad94c093516e899bfca934b3e4c39df44e |
| diagram-engine.js             | a8a6a6f805b074a8261a2825c86f99c8054acb3b35f50bb7e24a4f9f2c3c3b9f |

本地网页构建、TypeScript、相关 ESLint、Prettier 和 Markdown 浏览器回归通过。未调用模型，未重启 Agent；未测量生产网络下首次加载延迟。机器本地部署日志、完整文件摘要及校验记录位于忽略目录 `.local/deploy-cloud/local-58b8734c2d92443f5a29212ad7d2d4dab3ce03f9-7eacb1d6a878-web-only/`、`.local/cw-mermaid-deploy.log` 和 `.local/cw-mermaid-online-assets.json`。
