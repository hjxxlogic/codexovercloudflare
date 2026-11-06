# CW 只读历史恢复修复

2026-11-06，按用户要求移植 master `9580dcb41094776075ab89c3ad75dc76b4c03491` 的历史恢复修复，适配当前分支的“继续对话”界面。

## 问题与实现

- 原 visibility / online 恢复要求历史和控制 WebSocket 同时 OPEN。其他设备取得操作权后，原控制连接关闭；历史连接即使仍 OPEN，也可能停留在旧消息。改为调用现有独立 HTTP 快照补读，不以任一 Socket 的状态作为前提。
- 历史水位补读移除 `reliableCommands` 前提。首次以只读方式进入、控制连接未曾就绪的页面也能根据水位发现并补齐缺口。
- 历史快照缓存提交的 Promise 在后续分页前先处理缓存错误，提示后继续内存中的历史补读。保留原有持久化水位校验，未落盘内容不作成功持久化确认。

本次只修改 Web 和 Web 测试及文档。补读不调用 attach / takeover，不新建模型任务，未确认请求沿用已有恢复规则；“继续对话”的转移确认沿用现有逻辑。

## 验证

导航浏览器专项新增两个场景：首次 attach 被拒的只读页面，和原连接被另一设备以 4009 替换后的只读页面。两者都让历史连接保持 OPEN 但不返回更新，加入新消息，再触发返回页面；要求新消息通过快照显示，attach / takeover 次数均不增加。随后保留明确确认后继续、自动重连、草稿、桌面 / 手机及管理界面的原回归。

运行 Web 构建、TypeScript、受影响文件 ESLint / Prettier、导航专项，以及历史同步 / 订阅单元测试。修复前新增导航回归在“首次以只读方式打开也能补回消息”处按预期失败；应用修复后，`npm run build:web`、`npm run typecheck`、`npm run test:ui:navigation` 通过，无浏览器异常；`vitest run tests/history-sync.test.ts tests/history-subscription.test.ts` 20/20 通过。受影响文件 ESLint / Prettier 与 `git diff --check` 通过。未运行完整仓库 / 原生 / 模型任务测试；本次没有真实跨设备长稳测试或针对 IndexedDB 故障的新增浏览器注入场景。

## 状态

源码修复 `fcfb6e1` 已随网页来源 `4b08796d25194b176dce02613aea2b528d225568` 仅部署至 r2，版本号保持 `0.6.13`。Worker 执行代码沿用原制品，前后摘要核对一致；线上资源字节与 Web 验收通过，旧站 / 两个现有 Agent 隔离复核通过。见 [发布记录](R2_DEPLOYMENT.md) 和 [公开证据](assets/cw-observer-web/verified-preview.json)。
