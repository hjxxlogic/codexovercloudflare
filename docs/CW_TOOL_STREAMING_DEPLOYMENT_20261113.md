# 2026-11-13 CW 工具格式化与流式详情发布

用户明确要求提交、跳过 GitHub Actions 并直接部署。功能提交 `85b9d974084204157f346d8cac9b4f46168fd20b` 已推送 GitHub `master`，提交带 `[skip ci]`；按准确提交查询 Actions API，运行数为 0，没有本次 Actions URL 或 CI 制品。部署使用干净提交的本地网页构建，`localBuild=true`、`ciVerified=false`。

## 行为与本机验证

命令、文件、MCP／动态工具、网页搜索、子代理、图片、计划、推理、函数输出、审查等活动按类型展示，未知工具保留字段详情。工具展开后自动续读，文件 diff 和 MCP 文本在分页尚未完成时立即显示；内联命令／计划／推理和 MCP 进度随事件更新。收起暂停、重新展开继续，revision 从起点替换并保留文件展开状态，读取完成后停止请求；失败、拒绝和中断显示对应状态。

本机 41 个 Vitest 文件 / 485 项、TypeScript、完整 ESLint / Prettier、网页构建、`npm run test:tools:web` 和完整 `npm run test:ui` 均通过。场景及截图路径见 [测试说明](TEST_REPORT.md)。未修改原生程序，本次未重复原生构建和测试。

## 发布来源与在线验证

- 目标：[主站 CW](https://r.xlogic.cc)，网页版本保持 `0.6.20`。
- Cloudflare 版本：`eab5d345-31ba-4d89-af2c-24f5f1ad90aa`。
- 网页源码摘要：`f195a07b892d7ff469637b8684e0cf8d999b4ff8ce2a7c4bf3577d86f653b0d3`。
- 使用仓库 `scripts/deploy-cloud.py` 的网页专用模式，复用 `.local/deploy-cloud/43241338652/deployment.json` 中已验证的 Worker 制品；Worker 代码仍来自 `bfb6283dbca999d1914c050df6b089613161db23` 和 [Actions 43241338652](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/43241338652)。该历史 Actions 成功不代表本次网页通过 CI。
- 发布前后在线 Worker 模块 SHA256 与保留制品相同，`verifiedAfterDeploy=true`。
- 健康接口回读 `ok=true`、`version=0.6.20`、`demand=1`、`protocol=1`；首页、全部静态资源、下载说明、主题、手册、清单与校验和逐字节匹配准备产物，`publicAssetBytesMatch=true`。
- 保留现有 Worker 执行代码、变量、Secret、Access、SETTINGS KV、DO 和原生下载；未更新或重启 Agent / CLI，未触发自动更新通知或生产模型任务。

| 制品                        | SHA256                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| `index.html`                | `918586a2bc72ac688cfe1824a4893a895c588b79ebaa7ca3d7cc19993738faf2` |
| `assets/index-3OAOMIxT.js`  | `fde9ac1df6bcdfd806cce651afc835f3f6ede3a598c5f07ce88e926d68a4151d` |
| `assets/index-DhTBfNED.css` | `4b5424d6b3036630a9199e795733aa673af3b6012eb116b6b4447792adeea316` |
| 保留 Worker `index.js`      | `109b151b7305b0548d5e92a2a2404c0de3a6416b88cb8b2c1396fc393016d235` |

执行命令：

```bash
python3 scripts/deploy-cloud.py --local-build --commit 85b9d974084204157f346d8cac9b4f46168fd20b --target production --web-only-from .local/deploy-cloud/43241338652/deployment.json --apply
```

首次执行在发布前在线核对 Worker 时因过期 OAuth 返回 401，未改动线上资源；`wrangler whoami` 刷新现有登录后，同一命令成功发布并完成全部核验。

## 证据与限制

本机证据在忽略目录 `.local/deploy-cloud/local-85b9d974084204157f346d8cac9b4f46168fd20b-f195a07b892d-web-only/deployment.json` 及同目录 `wrangler.log`；执行日志 `.local/tool-presentation/deploy-20261113.log`、`.local/tool-presentation/deploy-20261113-retry.log`。

浏览器交互检查使用模拟后端，发布后完成线上资源和健康检查，未在生产已登录会话、真实手机或 Safari 上执行交互测试。本记录为后续文档提交，不改变已发布网页的功能源码身份。
