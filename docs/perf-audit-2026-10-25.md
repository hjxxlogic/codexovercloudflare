# 性能审核报告 · 2026-10-25

## 1. 结论与范围

审核基线：`eae289c916cada30a5aef1b02f6225b9b082d4f3`，项目版本 `0.5.3`。审核阶段只新增本文，以下测量和源码位置对应修复前基线。随后已按用户要求实施修复，结果见 [性能修复记录](perf-fixes-2026-10-25.md)；未部署。

当前架构适合个人自托管场景，优先优化现有数据路径即可。最值得处理的是：**细碎事件的逐条事务与投影成本、完整历史阅读的重复渲染、IndexedDB 修剪扫描全部会话**。其次是渲染更新频率、文件操作对业务线程的占用、文件传输的逐块往返，以及 Relay 的消息重复转发和空闲维护开销。

本报告覆盖 C++ Agent/Store/进程与传输、Worker/HostRelayDO/RegistryDO、Web 历史缓存/对话/文件传输及现有测试。结论分为代码确认、本地实测、待验证推断；本地耗时不代表公网、Cloudflare 实例或手机性能。未调用模型，未访问生产服务，未实施线上压测。

### 已有优化应当保留

- `Store::project` 已将超过 12,000 UTF-8 字节的流式正文转为追加块；不能继续引用旧审核中的“大正文始终全量重写”作为现状。小正文仍有累计重建，见 F01。
- Agent 已分离 Relay 网络循环和串行业务循环，心跳不直接等待 SQLite；但业务循环仍共享存储、子进程输出处理和文件操作，见 F01/F05。
- 会话目录已有索引与 keyset 分页；历史响应有 200 条/96 KiB 预算，实时 Web 窗口有 400 条/192 KiB 预算。历史阅读模式存在另一条路径，见 F02。
- Relay 已有最长 5 秒鉴权缓存、撤销时清缓存、64 个 pending 控制请求和 40 条连接预算；“每帧必然跨 DO 鉴权”已不是准确描述。
- 网络单帧、原生待发队列、Relay 入站队列及 Web/history 未确认发送量已有边界；这些边界不等于所有客户端、业务队列和平台发送缓冲均有统一预算。

这些判断来自当前源码，并与 [稳定化记录](stabilization-2026-10-24.md) 对照；[旧审核](audit-2026-10-24.md) 仅作历史背景。

## 2. 本次验证与基准

### 2.1 环境和执行记录

| 项目          | 本次记录                                                                     |
| ------------- | ---------------------------------------------------------------------------- |
| 宿主          | Ubuntu 20.04.6，Linux x86_64，共享开发环境                                   |
| 文件系统      | 工作区与 `/tmp` 均为同一 ext4 挂载；未验证底层设备缓存/掉电语义              |
| 原生构建      | `npm run build:native`，CMake Release，完成                                  |
| 构建身份      | 重建后 `coc-agent --version` 的 commit 与审核基线一致，`dirty:false`         |
| Node / SQLite | Node `22.17.0`；宿主 SQLite `3.31.1`，原生程序动态链接系统 SQLite            |
| Web 构建      | `npm run build:web`，完成；Vite `8.3.5`                                      |
| 单元测试      | `./node_modules/.bin/vitest run`：6 个文件、47 项测试通过                    |
| 原生回归      | `npm run test:cpp`：native-core 1/1 通过，4.68 秒；环境补记见末尾            |
| 浏览器探针    | Chromium `156.0.8078.4`，独立临时 context，合成 IndexedDB 数据、本地路由拦截 |

工作区原有二进制显示旧提交 `b6f9c0d…`，因此先重建才运行原生基准。性能场景依次执行，未并行运行多个存储基准。Chromium 首次因执行沙箱禁止进程通信而启动失败，随后获准在沙箱外运行本地隔离探针；未使用个人浏览器配置。

### 2.2 Store 写入基准

使用现有 [stream_benchmark](../native/tests/core.cpp#L390)，每例在独立临时数据库中交错写入四个会话，采用现有 WAL 配置，不改变 `synchronous`。所谓“四会话”是单线程轮流调用 Store，不是四线程并行，更不是完整 Agent/Relay/Web 吞吐。

```bash
npm run build:native
./build/coc-agent --version
./build/coc-tests --benchmark 1 1048576 10
./build/coc-tests --benchmark 10 1048576 10
./build/coc-tests --benchmark 100 1048576 10
./build/coc-tests --benchmark 1000 4194304 10
```

输入均为 ASCII `x`；目标和实际字符数均按单会话计，events/s 按四会话总量计。

| 每次增量字符 | 单会话目标 | 单会话实际字符 | 总事件数 | 耗时 s | events/s | 采样事件 P95 ms | CPU s | 完成目标 |
| ------------ | ---------- | -------------: | -------: | -----: | -------: | --------------: | ----: | -------- |
| 1            | 1 Mi 字符  |          2,467 |    9,868 | 10.019 |      985 |           1.458 | 6.309 | 否       |
| 10           | 1 Mi 字符  |         40,190 |   16,076 | 10.002 |    1,607 |           1.053 | 4.685 | 否       |
| 100          | 1 Mi 字符  |        465,600 |   18,624 | 10.002 |    1,862 |           0.731 | 3.994 | 否       |
| 1000         | 4 Mi 字符  |      4,194,304 |   16,780 |  9.315 |    1,801 |           0.708 | 3.808 | 是       |

四例进程峰值 RSS 均为 12,288 KiB。数据库主文件分别为 1,744,896 / 3,047,424 / 7,168,000 / 40,849,408 字节；WAL 采样峰值分别为 4,157,112 / 4,169,472 / 4,165,352 / 4,169,472 字节。

解读与限制：

- 细碎增量显著放大单位正文的处理成本。1 字符场景仍停留在 12,000 字节以下的小投影路径；其他场景跨过了该阈值，不能把四组结果视为完全相同路径的线性对比。
- 不能仅凭墙钟时间认定瓶颈全部来自 `fsync`：本次 CPU/墙钟比约为 40%–63%，还包含 SQL prepare、JSON、投影重建等开销；没有执行系统调用追踪或 CPU profile 来分摊成本。
- 每例仅一次、预算 10 秒，前三例因预算结束而未完成，不能外推其完整 1 Mi 字符耗时。
- P95 是每 16 次调用采一次；按当前四会话循环，该采样只落在第一个会话，不是全会话延迟分布。总耗时/CPU 还包含末尾正文一致性检查。
- WAL 只在每 4,096 个事件及结尾采样，可能漏峰值；WAL 文件可复用，约 4 MiB 的文件大小不代表累计只写入 4 MiB。主文件大小也不是总写入量。
- 基准检查每会话末尾最多 4,096 字符的一致性，不能将其描述为逐字验证全部输出。完整重建另有 native-core 功能测试。
- [2026-10-24 旧基准](assets/stabilization-2026-10-24/stream-benchmark.json) 使用 30 秒预算且宿主负载未知，不能据此宣称本次获得确定的性能提升倍数。

### 2.3 IndexedDB 修剪探针

直接转译并加载当前 `HistoryCache`，每个 scope 写入 1,000 个事件，每条正文 128 个 ASCII 字符。随后只向 `s000` 新增一个事件，通过包装 `IDBObjectStore.openCursor` 统计修剪访问记录数。每例使用新的浏览器 context，页面请求由 Playwright 本地 fulfill。

| scope 数 | 预置总事件 | 新增后实际访问记录数 | `write()` 含修剪耗时 ms |
| -------: | ---------: | -------------------: | ----------------------: |
|        1 |      1,000 |                1,001 |                    42.9 |
|       10 |     10,000 |               10,001 |                   208.1 |
|       30 |     30,000 |               30,001 |                   617.7 |

当前 scope 的数据量基本相同，遍历量却随所有 scope 的总记录数增长，确认 F03 的复杂度问题。这里测量的是异步事务墙钟时间，**不是一次连续阻塞主线程 618 ms 的 Long Task**；每例只有一个样本，未测移动设备、真实历史正文、输入延迟或帧率。

### 2.4 构建体积与查询计划

当前生产 Web 构建输出一个 JS 主包：436.49 kB，gzip 135.06 kB；CSS 13.42 kB，gzip 3.80 kB。数值来自 Vite 构建输出，单位沿用工具；不包含用户另行下载的原生程序，也不代表首屏耗时。

在宿主 SQLite 上按源码表结构执行 `EXPLAIN QUERY PLAN`：

```text
DELETE FROM request_states WHERE key NOT IN (SELECT key FROM requests)
SCAN TABLE request_states
USING INDEX sqlite_autoindex_requests_1 FOR IN-OPERATOR
```

因此 F09 的周期性全表扫描有查询计划证据；未将这项静态计划冒充百万行数据库耗时实测。

## 3. 优化发现与优先级

P1 表示优先进入下一轮性能改进；P2 表示结合实际负载实施；P3 表示先补测量再决定。优先级按增长风险、用户体验和改动收益排序，不表示已发生生产故障。

| 编号 | 优先级 | 问题                                                       | 主要证据                      |
| ---- | ------ | ---------------------------------------------------------- | ----------------------------- |
| F01  | P1     | 每个流式事件独立事务，小正文反复聚合，业务线程共享等待     | 源码 + Store 短基准           |
| F02  | P1     | 完整历史的 DOM/正文累积放大重复渲染（保留完整窗口）        | 源码确认                      |
| F03  | P1     | IndexedDB 修剪/清理跨 scope 全扫描，写入缺少应用层合并预算 | 源码 + Chromium 探针          |
| F04  | P2     | 流式事件触发全窗口处理，输入也重渲染历史 Markdown          | 源码确认，浏览器 profile 待补 |
| F05  | P2     | 文件目录扫描、发布同步和摘要占用共享业务循环               | 源码确认，慢盘实测待补        |
| F06  | P2     | 64 KiB 文件块逐个往返，远程延迟限制吞吐                    | 源码 + 往返次数推算           |
| F07  | P2     | 双连接重复接收事件，累计投影重发，CLI 发送背压不完整       | 源码确认，端到端负载待补      |
| F08  | P2     | Relay 空闲 alarm 重复鉴权，共享 Agent 队列存在队首等待     | 源码 + 调用次数推算           |
| F09  | P2     | 永久请求记录增长，30 秒维护扫描和过期上传结果无自动回收    | 源码 + SQLite 查询计划        |

### F01 · 减少事件级固定成本，保持提交语义

位置：[Store::event/project/query](../native/src/store.cpp#L196)、[Agent::emit](../native/src/agent.cpp#L200)、[业务线程与网络线程](../native/src/agent.cpp#L53)。

每个 `emit` 同步执行 `BEGIN IMMEDIATE`、原始事件插入、投影/正文元数据更新、读回投影和 `COMMIT`，然后才发送。每条 SQL 又通过 `query()` 独立 prepare/finalize，并用 JSON 容器承载结果。小正文路径在每次追加后对已有 chunks 做 `group_concat`，再更新累计 `data.delta`。该重复聚合只在 12,000 字节阈值内发生，属于**有界但高频**开销，不是修复前的无界大正文重写。

影响：一个会话的密集输出会占用其他会话共用的业务循环。停止/审批虽绕过普通命令队列，仍无法抢占正在执行的同步 SQL；网络心跳正常不等于任务控制响应正常。现有基准已显示细粒度事件成本，但尚未测出真实停止延迟。

建议：先增加 SQL/事务/业务循环排队计时；缓存固定 SQL statement。随后评估小批量 group commit：保留原始事件、投影和 revision 的事务一致性，按时间、条数与字节三重预算提交，只在提交成功后发布结果。可从 10–20 ms 合并窗口做实验，并对停止、审批、结束事件设置及时 flush 和有界排队。不要直接关闭持久化，也不要把尚未落盘的事件提前确认为可靠。

验收：1/10/100/1000 字符和非 ASCII 增量、四会话、慢盘/锁等待；记录全部会话 append P50/P95/P99、commit 次数、写入字节、停止/审批往返、队列水位。注入提交前后退出，验证回放、幂等和事件/正文/revision 无部分提交。

### F02 · 完整历史阅读的渲染成本（保留完整窗口）

位置：[showPage](../apps/web/src/main.tsx#L749)、[requestPage](../apps/web/src/main.tsx#L759)、[正文缓存回收](../apps/web/src/main.tsx#L476)、[ConversationView](../apps/web/src/conversation.tsx#L174)。

`olderView.current` 为真时，`showPage` 返回所有已合并事件，跳过 `eventWindow()`；连续加载更早页面会一直扩充 `events`。渲染随后遍历这些事件，工具 `<details>` 折叠只改变显示，仍构建其内容。展开正文每条最多保留 131,072 个 JS 字符，但仅在事件离开窗口时释放；历史模式不淘汰事件，因此也没有总展开正文预算。

影响：后端分页响应有界，浏览器内存和 DOM 仍可随阅读页数增长；不是后台自动加载全部历史，而是用户反复翻页触发。长会话尤其容易累积 Markdown 节点、工具输出和正文缓存。

修正后的要求：用户明确要求历史阅读保留完整窗口，浏览器保存数据且不反复从服务器获取。因此不采用原建议的页面环淘汰或正文 LRU，不将完整历史本身判为缺陷。保留全部已加载消息、滚动锚点及已展开正文，以行级 memo、批量更新和折叠工具按需挂载降低重复计算；已读页/正文持久缓存、本地优先读取。仅显式“返回最新”使用原有实时窗口。

验收：连续阅读 100 页含 Markdown、diff 和工具输出的历史，记录 retained heap、DOM 数、滚动/输入延迟；往返翻页不重复、不漏记录，已读页/正文不重复下载，所有已加载记录和正文前缀仍可阅读。完整内容随阅读增长占用内存是支持行为，不以自动裁剪换取固定内存目标。不能只验证单个响应小于 96 KiB。

### F03 · 缓存维护应只访问当前 scope，并限制未完成写入

位置：[HistoryCache.prune](../apps/web/src/history.ts#L37)、[write](../apps/web/src/history.ts#L107)、[clear](../apps/web/src/history.ts#L212)、[历史消息处理](../apps/web/src/main.tsx#L898)。

`latest()` 已使用 scope key range，但 `prune()` 和 `clear()` 对 events/pages 都使用无范围游标，再逐条判断 scope。修剪每个实例至多每 5 秒触发一次，仍会在覆盖两张 store 的 readwrite 事务中访问其他会话的数据。本次 30,001 条记录探针确认了这一点。

每个历史实时事件另起一次 `cache.write([event])`，调用方不等待完成；回执在写缓存前就发送。若 IndexedDB 比消息流慢，Relay 的回执预算不能限制浏览器待处理的缓存事务。另有每次输入即写完整草稿的路径。单 scope 每张 store 的计数/4 MiB 限额，也不能约束所有 scope 的总容量；`record()` 的 draft/pending/catalog 等记录不参与同样的修剪。

建议：首先对复合 key 使用正确的 scope 范围，保留 clear 不删除 draft/pending 的语义。按 `(scope, seq)` 合并较新 revision，使用短时间窗口批量写入，明确待写条数/字节预算；checkpoint 只随可靠完成的回放写入前进。草稿可短暂防抖，提交前必须完成必要持久化。按后续完整本地历史要求，取消应用层自动修剪；用户显式清理只访问当前 scope，浏览器配额失败应提示而不能静默淘汰已读内容。

验收：复用 1/10/30 scope 探针，常规写入不触发修剪，显式清理游标访问数应随当前 scope 大小变化；增加慢 IndexedDB、高频事件、缓存失败与切换会话场景，确认无无界 pending、修订倒退和 checkpoint 越过未写入数据。

### F04 · 合并 UI 更新，隔离不变消息的 Markdown 渲染

位置：[事件更新](../apps/web/src/main.tsx#L515)、[eventWindow/mergeEvents](../apps/web/src/events.ts#L3)、[ConversationView](../apps/web/src/conversation.tsx#L65)、[输入框](../apps/web/src/main.tsx#L2236)。

每个新的 revision 触发事件窗口合并、排序及 JSON 编码计字节；渲染时再执行 `visibleEvents()` 的合并/排序和工具分组。`ConversationView` 与消息行没有 memo 边界，父组件输入状态变化也会进入对话渲染，重新运行 Markdown 处理。折叠工具也创建输出内容，F02 的历史累积会放大这一路径。

建议：先用 React Profiler 与 Long Task/输入延迟记录确认成本；以动画帧或 20–50 ms 窗口合并纯展示更新，停止/审批状态及时更新。按 seq 保存稳定对象和最新 revision，对不变消息行做 memo；复用 Markdown 配置，缓存事件大小，避免每次全量 stringify。优化必须保留事件顺序、修订替换和同步回放边界，不能把累计投影误当增量再次拼接。

验收：400 条混合消息和长历史窗口下同时持续输出与中文输入，测事件到绘制、输入延迟和 React commit；分别覆盖新增 seq、同 seq 更新及内容引用。当前仅确认执行路径，未宣称实测掉帧。

### F05 · 将慢文件工作与业务事件循环隔离

位置：[Agent files 分支](../native/src/agent.cpp#L359)、[目录分页](../native/src/files.cpp#L140)、[上传 finish](../native/src/files.cpp#L320)。

目录每页虽只返回 100 项，仍从头 `readdir` 整个目录，对游标之后的候选执行 `fstatat` 并维护 101 项有序集合。完整浏览 N 项大目录需要约 N/100 页，每页 O(N) 目录遍历，最坏累计工作接近平方增长。上传结束的文件/目录 `fsync`、最多 20 MiB 文件重读 SHA-256 也同步发生在共享业务线程。

建议：先将目录扫描、文件读取/同步/摘要放到有界工作队列，结果回到串行业务循环更新状态；不要让多个线程直接共享现有 Store 或 uploads 状态。目录可评估有容量和时效上限的快照/索引，必须定义目录变化后的游标语义。摘要可评估顺序上传时增量计算，但重复块不得重复计入，发布时仍须确认文件身份和一致性。

验收：含 10 万项的合成目录逐页读取，叠加 20 MiB 上传、慢 `fsync` 和四会话输出，记录扫描次数、控制 P95/P99。路径逐级 `openat`/`O_NOFOLLOW`、覆盖确认、原子发布和结果不明语义必须保留。

### F06 · 文件吞吐受逐块完整往返约束

位置：[上传循环](../apps/web/src/files.tsx#L158)、[下载循环](../apps/web/src/files.tsx#L210)、[块上限](../native/src/files.cpp#L14)。

上传与下载均等待当前 64 KiB 块的请求完成后才发下一块，经过浏览器、Worker、DO、Agent。20 MiB 文件需要 320 个数据块。若一次完整应用往返为 100 ms，仅逐块等待的理论下限约为 32 秒，吞吐上限约 640 KiB/s；200 ms 时约 64 秒。这是公式推算，不是公网实测，尚未计传输、鉴权、begin/finish 和磁盘成本。Base64 还使正文约膨胀为 4/3。

建议：先对 20/100/200 ms 往返做带宽测试，再考虑 2–4 块有界流水线或独立传输通道。当前上传要求严格连续 offset，不能直接改成无序 `Promise.all`；需要有序写入、重试去重、全局字节额度和控制消息公平性。也不应单纯增大帧直到突破 256 KiB 限制。下载仍整份保存在浏览器 parts/Blob 中，应维持文件上限并测峰值内存。

验收：在不同延迟/丢包条件下验证有效吞吐、暂停/取消、覆盖失败、下载 version 一致性以及聊天控制延迟；保留 SHA-256 与重复 finish 结果。

### F07 · 降低重复事件流量，补齐发送预算

位置：[双连接启动](../apps/web/src/main.tsx#L1004)、[Relay 转发](../apps/relay/src/host.ts#L532)、[send 回执预算](../apps/relay/src/host.ts#L86)、[Store 投影返回](../native/src/store.cpp#L273)。

活跃网页同时建立控制连接和 history 连接，两条连接都收到同一个实时事件。共享 `seen` 会消除重复 UI 更新，但两份下行 JSON、解析和两份 receipt 已经发生。小正文每次发送累计投影，例如 1 字节增量累计到 12,000 字节，单接收流仅正文累计发送量约为 `12000×12001/2 = 72,006,000` 字节；双连接还会再放大。超过阈值后改为引用，此公式不适用于任意长正文。

Web/history 每次 `send()` 为求未确认字节数遍历 receipt Map，成本随未确认条数增长，虽受 1,000 条上限约束。CLI 及发往 Agent 的路径没有同样的应用层回执预算；原生 8 MiB 队列不能证明 Cloudflare 端发送缓冲也被限制。不同接收连接各自有预算，没有整个主机的统一出站额度。

建议：让 history 承担唯一实时事件订阅，控制连接负责命令/审批/状态，但须定义订阅就绪和重连补齐后再切换；或合并为显式复用协议。对同 seq 累计投影采用有界发送合并。receipt 计数改为 O(1) 维护总字节，评估累计确认；CLI 原生协议不能随意注入非 Codex 帧，应在自有桥接层设计流控和慢读者隔离。

验收：统计每个逻辑事件实际下行次数、帧数和字节数；注入慢 CW、慢 CLI 和 Agent 慢读，其他会话应仍能控制。若复用/改流控，须覆盖断线、接管、回放和同 revision 去重。

### F08 · 空闲维护与共享队首等待需分别治理

位置：[鉴权缓存](../apps/relay/src/host.ts#L55)、[每连接串行队列](../apps/relay/src/host.ts#L447)、[fan-out](../apps/relay/src/host.ts#L532)、[alarm](../apps/relay/src/host.ts#L654)、[Registry 鉴权](../apps/relay/src/registry.ts#L335)。

HostRelayDO 在仍有连接时每次 alarm 结束后再安排 30 秒，逐连接直接调用 Registry `authHash`，不按 hash 去重，也不复用 `authorized()` 缓存。同一网页的两条连接会重复校验同一凭证。单主机连续在线一天理论上约 2,880 次周期 alarm；若有 9 条稳定连接，仅 alarm 就约 25,920 次鉴权调用，尚不含实际消息。计数忽略执行时间、初始 5 秒 schedule 等因素，不是 Cloudflare 账单估算。

Agent 的所有会话共用一条入站 WebSocket，Relay 为该连接串行处理消息；fan-out 内逐个 `await authorized()`。当缓存失效且 Registry 响应慢时，一个接收者的鉴权等待会延迟后续会话消息。缓存命中时开销较小，不能假设每帧都有网络调用；`storage.get(agentEpoch)` 也不能直接算作一次物理磁盘读取。

建议：先记录空闲/活跃调用数、缓存命中和队首等待；alarm 按唯一凭证去重并采用有界并发，合并同 hash 的在途验证。若改变维护频率或心跳方式，必须明确撤销最长生效时间、认证过期和重建语义。评估 fan-out 分离等待时保留单接收者事件顺序和 epoch 隔离。

验收：空闲 24 小时及持续四会话流量，记录唤醒、鉴权次数和尾延迟；模拟 Registry 变慢、撤销通知丢失与对象重建。实际休眠行为、平台计费和运行时缓冲需要部署到受控测试环境测量，本次没有据源码宣称已达到某种休眠率。

### F09 · 控制长期元数据增长和维护扫描

位置：[Store 表结构](../native/src/store.cpp#L100)、[cleanup](../native/src/store.cpp#L451)、[30 秒维护](../native/src/agent.cpp#L992)、[上传结果](../native/src/files.cpp#L220)。

`requests/request_states` 为避免延迟重试重复执行而保留身份；当前维护每 30 秒执行一次删除孤立 request_states 的查询，会扫描整个 request_states。随着长期使用，通常没有孤立行的维护也要重复读表。原始 events、chunks、history 同时保存数据，追加块降低重写成本但没有消除存储放大。

上传完成结果在 SQLite `cache` 中只按 24 小时有效期判断是否可用；`WorkspaceFiles::cleanup()` 清理的是内存 map，并不删除已过期的持久 cache 行。常规在线路径也未提供这些表的自动总体容量预算。

建议：孤立状态清理改为迁移/离线维护或有游标的小批工作，避免热路径固定扫描。过期上传结果增加类型明确的到期索引和有界回收。为正文和归档制定显式保留/导出/压缩策略及磁盘指标。请求身份不得直接按年龄删除；应先设计长期去重 tombstone 或明确幂等窗口，避免以省空间为由改变重复执行安全性。

验收：10 万/100 万请求记录和长期事件库，观察维护 P99、数据库/备份增长与在线控制延迟；清理后历史仍能读取，旧请求不会重新执行，未确认副作用记录保留。

## 4. 次级优化候选

以下列为 P3，不应抢在已确认的增长问题之前：

- **序列化与复制**：[Agent::send](../native/src/agent.cpp#L175) 先复制 Json 并 `dump()` 计大小，[Socket::send](../native/src/socket_impl.hpp#L119) 再次 `dump()`；入站也会重新序列化计队列字节。可在自有接口传递已验证的编码缓冲，减少重复工作，但需 profile 证明收益并保留字节预算。
- **非流式大内容分页**：[Store::content fallback](../native/src/store.cpp#L388) 每次从完整 history JSON 提取正文，再做字符偏移 substring；读取很长的非 chunk 正文可能反复解析/扫描。先对大 `item/completed`、历史归档和 Unicode 内容测量，再统一正文块存储。
- **历史目录进程冷启动**：[threads 控制分支](../native/src/agent.cpp#L368) 每次启动 app-server、initialize、thread/list 后关闭。可测冷启动占比，再评估只读查询进程复用或短缓存，保留项目筛选、进程上限与过期处理。
- **首包拆分**：主包静态包含聊天 Markdown、管理与文件 UI。可按入口/功能动态加载，但目前只有体积数据，没有首屏 CPU/LCP 证据，不应仅凭 436.49 kB 就宣称用户体验不合格。
- **Registry 后台扫描**：[Registry alarm](../apps/relay/src/registry.ts#L428) 在临时授权/限流记录仍存在时扫描 device/limit/auth 并逐条事务处理。个人规模和五主机限制下暂列后续；大量长期凭证时再测量分批到期索引的收益。

## 5. 建议实施顺序和验收门槛

1. **建立可信测量**：为 append/commit、业务循环排队、控制往返、Relay 队列/鉴权、UI commit 与 IndexedDB pending 补结构化指标。记录数量、大小和耗时，不记录对话正文、令牌或敏感命令。
2. **先做局部收益**：F03 取消自动修剪并按 scope 清理、F02 完整历史本地保留与按需挂载、F04 不变消息 memo，以及 receipt O(1) 字节计数。这些改动应分别复测，避免多项混合后无法归因。
3. **再改共享调度**：F01 语句缓存与小批事务、F05 有界文件执行器；每一项都必须通过持久化故障、停止/审批和多会话公平性验证。
4. **按负载调整协议/维护**：F06 流水线、F07 去重订阅/流控、F08 空闲维护和 F09 长期保留。需要协议或支持行为变化时同步更新 `docs/USER_GUIDE.md`、架构及测试证据。

建议将下列数值作为下一轮讨论和建立基线的目标，**不是现有实测达标结论或已经承诺的 SLO**：

| 维度     | 场景与建议目标                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------- |
| 控制响应 | 四会话输出 + 文件操作下，停止/审批排队与本地处理 P95 < 100 ms；端到端另记录实际网络 RTT         |
| UI       | 固定设备上输入到绘制 P95 < 100 ms；记录 >50 ms Long Task，并定位来源                            |
| 历史     | 100 页往返后已加载历史和展开正文完整保留；已读内容优先命中本地，记录 DOM/内存及输入延迟         |
| 缓存     | 相同当前 scope、其他 scope 从 1 增到 30 时，热路径无自动修剪，显式清理访问量不随其他 scope 增长 |
| 流控     | 一个慢读者不能耗尽其他会话的控制预算；所有应用层 pending 都有数量/字节边界                      |
| 持久化   | 不丢已确认事件；原始事件、正文、投影及游标一致；故障重试不重复执行                              |
| 长期负载 | 四会话至少 8 小时，观察 RSS、磁盘/WAL、维护延迟与队列趋势；不能用本次 10 秒替代                 |

性能矩阵还应包括：1/10/100/1000 字符、1/4/16 MiB 正文、中文/emoji、单次大完成事件、1/4 会话、快/慢盘、20/100/200 ms 网络往返、慢读者、30 个缓存 scope、100 页历史。分开报告冷启动、稳态、尾延迟与失败次数，不只报告平均吞吐。

## 6. 浏览器探针复现

在仓库根目录执行以下本地探针。需要已安装 Playwright Chromium 及其系统依赖；只使用合成数据和临时浏览器 context。代码加载当前生产 `HistoryCache`，不复制其修剪实现。

```bash
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import ts from 'typescript';
const source = ts.transpileModule(
  readFileSync('apps/web/src/history.ts', 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
).outputText.replace(
  'export class HistoryCache',
  'globalThis.HistoryCache = class HistoryCache',
);
const browser = await chromium.launch({ headless: true });
try {
  console.log({ browser: browser.version() });
  for (const scopes of [1, 10, 30]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('http://audit.invalid/**', (route) =>
      route.fulfill({ body: '<html></html>', contentType: 'text/html' }),
    );
    await page.goto('http://audit.invalid/');
    await page.addScriptTag({ content: source });
    console.log(await page.evaluate(async (scopes) => {
      const cache = new HistoryCache('s000');
      await cache.latest();
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('coc-history', 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('events', 'readwrite');
        for (let s = 0; s < scopes; s++) {
          const scope = 's' + String(s).padStart(3, '0');
          for (let seq = 1; seq <= 1000; seq++) {
            tx.objectStore('events').put({
              scope, seq,
              event: { seq, revision: seq, type: 'user', time: 0,
                data: { text: 'x'.repeat(128) } },
            });
          }
        }
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      let visited = 0;
      const original = IDBObjectStore.prototype.openCursor;
      IDBObjectStore.prototype.openCursor = function (...args) {
        const request = original.apply(this, args);
        request.addEventListener('success', () => {
          if (request.result) visited++;
        });
        return request;
      };
      const start = performance.now();
      await cache.write([{
        seq: 1001, revision: 1001, type: 'user', time: 0,
        data: { text: 'new' },
      }]);
      const writeAndPruneMs = performance.now() - start;
      cache.close();
      db.close();
      return { scopes, seedEvents: scopes * 1000, visited, writeAndPruneMs };
    }, scopes));
    await context.close();
  }
} finally {
  await browser.close();
}
JS
```

## 7. 验证边界与执行补记

本次没有完整重跑 E2E、模型任务、TLS、升级、备份、八小时稳定性或 Cloudflare 实例测试；这些既有测试的历史结果应查看 [TEST_REPORT](TEST_REPORT.md)，不能算作本次通过。此次构建和功能单元测试也不能代替性能验收。

原生回归执行补记：首次在沙箱内运行时，core/history/files/stabilization 检查通过，HTTP deadlines 阶段因本地 socket 操作返回 `Operation not permitted` 而失败。随后获准在沙箱外重跑 `npm run test:cpp`，native-core 1/1 通过，总耗时 4.68 秒；首次环境失败不计为代码性能回归。

文档完成时检查了 44 个仓库内链接及行号有效性，并通过 Prettier 和差异空白检查。测试与基准使用临时数据；交付变更仅为本报告。
