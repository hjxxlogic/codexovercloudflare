# 线上响应速度与 Terminal 优化 · 2026-11-03

## 部署前采样

测试目标 `https://r.xlogic.cc`，网页 / Worker 源码 `73847e8`，Worker `3cb29650-0724-48b0-96f7-3ee5781d1434`；沿用当时运行的 Agent。使用已有邮箱登录，从本机 headless Chromium 测量，入口 `CF-Ray` 后缀为 AMS；这不代表 DO 所在区域或用户实际网络。接口串行采样，不发模型任务。原始快照与凭据留在 ignored `.local/`，公共记录只含计时、数量和清理结果。

| 操作                     | 样本数 |   中位数 | 样本 P95 |
| ------------------------ | -----: | -------: | -------: |
| 健康接口                 |     20 |   237 ms |   502 ms |
| 登录身份                 |     20 |   394 ms |   653 ms |
| 主机列表                 |     20 |   590 ms | 1,051 ms |
| Agent probe，含查询结果  |      8 | 1,108 ms | 1,391 ms |
| 会话列表，含查询结果     |      8 | 2,245 ms | 2,893 ms |
| 指定会话快照，含查询结果 |      8 | 1,163 ms | 2,662 ms |
| 通知 WebSocket 打开      |     10 | 1,236 ms | 1,606 ms |
| 空浏览器缓存页面出现     |      3 | 2,306 ms | 2,930 ms |
| 浏览器刷新页面出现       |      6 |   548 ms |   851 ms |

页面出现指 root 首次非空，FCP 单独保存；不冒充身份 / 目录 / 会话全部就绪。三个全新浏览器 context 各首次访问一次、刷新两次，未清除 Cloudflare 边缘缓存；同一个 Chromium 进程可能复用系统 DNS。接口样本使用同源 HTTP/2 和真实 Cookie。Agent 异步读取立即查询结果，pending 后按 250 / 500 / 1,000 / 2,000 ms 退避，没有 UI 通知加速；确认回收 POST 不计入结果可用时间，单独记录。样本 P95 使用最近秩；8 次采样的 P95 即最大值，不作为稳定 SLO。

同期 Agent 日志中 probe 0 ms、list 中位数 4 ms、snapshot 中位数 1 ms；日志可能包含其它正常流量，不能与单条浏览器请求直接相减或分配精确占比。主要可见等待在网络 / Relay / 结果回收整段，未取得同请求服务器分段 trace。尝试 Wrangler Tail 遭遇本机网络不可达，未改变系统 DNS 或服务配置。

## Terminal 现场复现

独立创建临时项目和普通 Web 会话，打开隔离 Bash PTY；不接管用户既有会话、不调用模型。测试结束后终端、会话、项目及空临时目录均已清理。

- 菜单到“打开终端”可用：5,957 ms；点击打开到连接成功：3,868 ms，各 1 次。
- 8 次单字符回显：最近秩中位数 980 ms，最小 927 ms，最大 / 样本 P95 2,059 ms。
- 4 次 Enter 到 printf 标记：最近秩中位数 1,312 ms，最小 940 ms，最大 1,392 ms。
- wire 时间显示常见输入 ACK 约 716–750 ms，部分输出比 ACK 再晚约 200 ms。这里没有把后者确认为 Nagle 的精确收益，后续版本须实际复测。

## 0.6.2 改动

1. Terminal 入口 hover / focus 可提前准备；点击后模块下载与只读 info 并行，挂载复用同一次请求，作用域绑定主机 / 项目 / owner。打开隔离 Shell 仍需用户确认。
2. 输入约 16 ms 合并，使用最多 32 个未确认帧和 64 KiB base64 输入的有界窗口，不再逐批等待前一 ACK。seq 顺序分配，ACK 必须逐项有序匹配；窗口满时保留有界本地待发输入，断开 / 超时使所有未知写入失败，绝不重放。输出渲染 ACK 和背压不变。
3. 原生 WebSocket TCP 连接启用 TCP_NODELAY，覆盖直连和代理隧道、TLS 和 plain；消除应用允许 Nagle 等待的条件，实际收益与网络相关。此项需要新 Agent / CLI，网页优化可单独生效。
4. musl 发布仅对暂存副本 strip 并重新校验运行身份；构建原件不改，归档格式仍为旧更新器支持的 `.tar.gz`。旧 0.6.1 制品归档约 25.40 MiB，符号表裁剪后两程序约 15.5 / 15.8 MiB 原始大小，发布必须再次确认整包小于 25 MiB。

## 验证与发布

本次按用户要求使用 GitHub Actions 并生成新版本 0.6.2：准确提交通过全部 regression、sanitizers、Ubuntu 20.04、Debian 12、musl 和 Windows x64 后才使用对应制品发布，没有用此前本机构建代替发行。原生服务升级继续等待空闲，未授权重启活动会话。最终提交、Actions、制品 SHA256、部署与上线后复测记录如下。

[部署前脱敏样本](assets/response-speed-2026-11-03/baseline.json)。

首个候选 `e363d9c` 的 Actions 41579765503 在 Ubuntu 回归机 bubblewrap loopback 配置失败，报 `Operation not permitted`。在该候选尚无 Release、尚未部署时，将本次新建 tag 更正为修订源码；新增仅限 GitHub-hosted 一次性运行机的命名空间准备和真实隔离 smoke，重新执行全部作业。失败候选不作为发布依据。终端预读绑定 OperationClient 的 owner 作用域，不因最初控制握手从无到有而重发 info。

## 正式发布与上线结果

最终源码 `9b6d7230c66eac4f212d40bfde4bf819838a064c` 的 [tag Actions 41581045170](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/41581045170) 六项必需作业全部成功，包含真实隔离 PTY 和 Chromium Terminal E2E；`publish-release` 成功生成 [v0.6.2](https://github.com/hjxxlogic/codexovercloudflare/releases/tag/v0.6.2)。同一源码的分支运行 41581045460 也全部成功。本次只使用 tag 运行的制品，GitHub artifact 摘要、包内 SHA256、提交和 sourceDigest 全部匹配；没有使用本机构建或跳过失败项。

通过 `scripts/deploy-cloud.py --commit 9b6d7230c66eac4f212d40bfde4bf819838a064c --run-id 41581045170 --publish-downloads --apply` 于 UTC `2026-11-03T05:23:32.854002Z` 部署。部署 ID `a7c4e96c-f63c-43a2-862f-556d4717d2fb`，Worker `5ad122c3-c1c4-4058-af10-a82c4275bb41` 接收 100% 流量。健康返回 0.6.2，网页 / 手册 / 下载清单逐字节匹配 CI；Ubuntu 20.04、Debian 12、musl、Windows x64 和源码共五份归档在线重新下载后 SHA256 全部匹配。musl 实际归档为 12,749,037 字节（12.16 MiB），四个平台均符合 25 MiB 限制。

与发布前 Worker 逐项比较，所有 binding 完全一致，包括两个 DO namespace、Secret 和普通变量；没有 D1 binding 或后端选择变量。真实已有邮箱身份、管理员、Agent probe、会话只读查询、streaming:2 元数据、旧迁移入口 404 及 API / WebSocket 入口权限检查通过；通知连接返回 101、保持超过 6 秒，无浏览器未捕获异常。未发模型任务或接管既有用户会话。

## 上线后 Terminal 复测

以下三次测试均使用现场仍在运行的 **0.6.1 Agent**；新原生 TCP_NODELAY 尚未安装，不能将结果归功于该改动。每次使用独立临时项目 / 会话，并确认终端、会话、项目和空目录全部清理。

| 指标                             | 旧网页，立即打开新会话菜单 |  0.6.2 网页，同样流程 |
| -------------------------------- | -------------------------: | --------------------: |
| 菜单到打开按钮可用，1 次         |                   6,460 ms |              6,447 ms |
| 打开到流连接成功，1 次           |                   3,830 ms |              3,832 ms |
| 单字符回显最近秩中位数，6 次     |                     926 ms |              1,001 ms |
| Enter 到 printf 输出中位数，3 次 |                   1,118 ms |                956 ms |
| 三次 Enter 从按键到发出          |          12 / 796 / 192 ms | 15.3 / 14.2 / 14.2 ms |
| 无 PTY 的流式 ping，4 次         |                 705–713 ms |            731–888 ms |

前端等待前一 ACK 的排队已消除；单字符仍需约一秒回显，启动链路也未出现明确下降。网络波动和小样本不支持把 Enter 输出中位数差异当作稳定收益。

另一次测试先等新会话收到完整初始 sync，再点击菜单：会话创建到就绪 9,092 ms，菜单到打开按钮可用 **1,440 ms**，打开到连接 **3,354 ms**。终端 JS 下载 1,097 ms，与 info 读取并行。该次 6 个单字符中位数 911 ms、最大 2,088 ms；流式 ping 为 703–1,290 ms。前两列菜单计时包含新会话控制初始化，不能直接宣称从 6.4 秒优化到 1.4 秒；后者只说明已就绪会话的单次实际等待。

## 现场原生升级与后续测量

`scripts/deploy-agent.py` 已准备并核验同一 tag 运行的 0.6.2 musl 候选，二进制 SHA256 为 `c1cdbf83632d4656ed1812b785a7929f9c65387735689f5cccae3e33a4add1a8`。现场仍有一个活动 runtime，按 `AGENTS.md` 的明确授权规则保持原进程，没有安装或重启。候选准备不等于现场升级；TCP_NODELAY 的线上收益待空闲安装或取得活动重启授权后复测。

尚未实施的下一步是取得同请求分段 trace，区分浏览器入口、HostRelayDO、Agent 的等待；再评估在用户确认打开时并行建立未绑定 WebSocket、待可靠 open 结果后绑定的方案，保留控制校验、超时及清理。当前数据不支持承诺实时远端回显，也不以本机网络代表用户浏览器的网络。

[完整 CI、制品 SHA256、部署与脱敏复测证据](assets/response-speed-2026-11-03/deployment.json)。凭据、原始会话、截图和机器本地日志仅保存在 ignored `.local/response-speed-2026-11-03/`。
