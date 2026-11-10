# 开发与本机测试

## 工具与目录

Agent / CLI 使用 C++17，运行无需 Node.js。构建需要 CMake ≥3.16、Python 3、Git、Boost.System ≥1.71、OpenSSL、libsodium ≥1.0.14、SQLite3 和 nlohmann/json ≥3.7。网页、Worker 和 TypeScript 测试需要 Node.js ≥22.17。Codex `0.164.0` 是已验证基线；程序不固定安装版本，其他版本需兼容使用的 app-server / TUI API。

| 目录                                 | 内容                                                          |
| ------------------------------------ | ------------------------------------------------------------- |
| `native/include/coc/`、`native/src/` | 原生 Agent、CLI、传输、进程、策略和 SQLite                    |
| `native/tests/`                      | CTest、真实 Codex 协议及任务检查                              |
| `apps/relay/src/`                    | Worker、RegistryDO、HostRelayDO 与授权                        |
| `apps/web/src/`                      | React 网页                                                    |
| `packages/channel/`                  | 浏览器端点加密（锁定 libsodium-wrappers）；原生使用 libsodium |
| `packages/protocol/`                 | Zod schema 和 TypeScript 类型                                 |
| `tests/`                             | 协议、集成和浏览器测试                                        |
| `tests/support/`                     | 原生进程 harness 与故障注入                                   |
| `scripts/`、`examples/`              | 初始化、构建部署工具、配置和 systemd 模板                     |

## 构建与运行

```bash
sudo apt-get install build-essential cmake python3 git libboost-system-dev libssl-dev libsodium-dev libsqlite3-dev nlohmann-json3-dev clang-format
npm ci
npm run build:native
npm run setup:local
npm run dev
```

`setup:local` 生成忽略目录中的开发秘密，拒绝覆盖已有配置。开发站点为 `http://127.0.0.1:8787`，本地 owner 密钥在 `.local/owner-secret`；`dev` 显式关闭 Access，不要用于推断生产 Access 策略。授权和 Agent / CLI 运行步骤见 [用户手册](USER_GUIDE.md)。

只编译原生程序可直接运行 CMake：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j 2
ctest --test-dir build --output-on-failure
```

`npm run build:web` 构建网页；`npm run build` 执行原生/网页构建、TypeScript 检查及 Worker dry-run，不发布。先完成构建再启动集成测试，不要在测试中重新链接同一目录里的运行程序。

## 平台构建

### Ubuntu 20.04 容器

workerd 需要兼容的系统库。旧宿主可用 Bookworm 测试容器，不替换宿主 glibc：

```bash
docker build -f Dockerfile.test -t coc-local-test .
docker run --rm --init -v "$PWD:/workspace" coc-local-test sh -c \
  'npm ci && cmake -S . -B .local/build-container -DCMAKE_BUILD_TYPE=Release && cmake --build .local/build-container -j 2 && npm run build:web && npx playwright install chromium && COC_AGENT_BINARY=.local/build-container/coc-agent COC_CLI_BINARY=.local/build-container/coc-client npm run test:e2e'
```

容器与宿主分开构建目录，避免混用动态库；容器默认 root，会向挂载目录写文件。不要挂入生产凭据。`COC_BROWSER_PATH` 可指定兼容浏览器。

### Linux musl

```bash
docker build -t coc-musl-build - < Dockerfile.musl
docker run --rm -v "$PWD:/workspace" coc-musl-build sh -ec '
  git config --global --add safe.directory /workspace
  cmake -S . -B build-musl -DCMAKE_BUILD_TYPE=Release -DCOC_STATIC_MUSL=ON
  cmake --build build-musl -j 2
  ctest --test-dir build-musl --output-on-failure
'
```

`COC_STATIC_MUSL` 只用于 Linux musl 工具链，不与 sanitizers 混用。静态程序仍读取系统 CA，支持 `SSL_CERT_FILE`，自动更新默认选择 musl 包。

### Windows x64

使用 MSVC、CMake 和 vcpkg，具体构建参数与依赖见根目录 `CMakeLists.txt`、`vcpkg.json` 和 `.github/workflows/checks.yml`。与 CI 使用相同工具链构建并运行 CTest；ZIP 打包由 `scripts/package-release.py` 完成。Windows 文件路径、私有 ACL、TLS ROOT 与手动更新规则见用户手册。

## 检查与测试

```bash
npm run typecheck
npm run lint
npm run lint:cpp
npm test
npx playwright install chromium
npm run test:e2e
```

`npm run test:threads` 在构建后运行会话归档/删除的 CTest、真实 Agent 加密端点与手机 UI 回归；`npm run test:cache` 另验证删除缓存与旧标签页写入隔离。`npm run test:threads:codex` 需安装支持对应接口的 Codex（已验证 0.166.0），创建独立临时 CODEX_HOME，核对真实 JSONL 归档/恢复/删除，不调用模型、不读取用户会话。空的新 Codex 会话不会出现在普通目录，该测试只向自己的临时 rollout 加入合成用户消息，并覆盖不同模型提供商的目录记录。

`npm test` 是 CTest 加 Vitest，不调用模型。其它测试入口、依赖与覆盖见 [测试说明](TEST_REPORT.md)。需要真实模型的 `test:task` 和 `test:native -- --task` 应单独运行。

经授权读取真实用户数据库时，先用 `scripts/state-backup.py backup` 保存私有一致性快照，再运行 `tests/user-database-upgrade.py --snapshot <快照> --output <不存在的私有目录>`。原生辅助程序 `coc-database-upgrade` 只打开 Store；不启动 Agent、Codex 或连接生产中继。脚本核对全部原有表的行数与逐行摘要、升级备份和重复打开，输入快照始终保持原样。不要将用户数据库作为仓库 fixture 提交。

Terminal 专项需要 Linux、Bash、bubblewrap、prlimit 及可用 namespace。缺少工具或非 Linux 可跳过相应原生测试；工具存在但隔离启动失败应修复测试环境，不能绕过隔离。

## 协议与配置维护

C++ 和 TypeScript 均使用两空格缩进。C++ 使用 snake_case 函数、PascalCase 类、RAII、参数数组启动进程及 clang-format；TypeScript 使用 strict、ESLint 和 Prettier。

修改 schema 后运行 `npm run protocol:generate`，用 `npm run protocol:check` 验证生成文件同步。Agent JSON 的校验需同步 `native/src/common.cpp` 与 `packages/protocol/src/index.ts`，保持默认值、范围和未知字段处理一致。

云端只支持原生 DO；测试和部署使用相同后端。修改持久状态需要事务校验、冲突回滚及故障注入，不通过清库消除未知请求。凭据、配置、项目文件和运行任务必须保留。

无邮箱网页授权保留显式认领；无邮箱会话由用户连接后绑定当前邮箱，不自动分配归属。配置、协议和存储只接受当前格式；不执行旧格式导入、补列、时间回填或身份降级。SQLite 新库标记 `user_version=2`，已有完整的版本 `0` / `1` 库保留原记录并单向升级到 `2`；缺列或未知版本的库返回 `UNSUPPORTED_STORAGE_VERSION`；项目目录和浏览器记账同样拒绝不支持的格式。RegistryDO 到期索引补齐尚未完成时返回 `UPGRADE_REQUIRED`。测试应验证明确错误及拒绝前后数据不变，不用删除既有状态让升级通过。

## CI、缓存与发布

`.github/workflows/checks.yml` 覆盖 regression、sanitizers、Ubuntu 20.04、Debian 12、musl 和 Windows x64。Linux 使用按目标隔离的 ccache，musl 另有工具链镜像缓存，Windows 使用 vcpkg ABI 缓存。缓存不跳过来源生成、链接、制品校验或测试。

本地可配置 `-DCMAKE_CXX_COMPILER_LAUNCHER=ccache`，用 `ccache --show-stats` 检查命中。正式部署必须使用准确源码提交的全部必要 CI 成功后的制品，见 [发布操作](RELEASE.md)。

## 不透明中继回归

`npm run test:opaque` 使用真实 Worker、原生 Agent、浏览器密码实现与 Chromium，验证权限绑定、加密业务调用、控制竞争、去重及目录不可见性。CTest 的 `native-endpoint` 验证 Agent 控制权与退休屏障；`native-secure-channel` 和 `secure-channel.test.ts` 验证原生/浏览器互操作和负向密文。

`coc-agent-component` 仅在 BUILD_TESTING 中编译，用于 delivery/runtime/terminal 的内部业务引擎故障测试。它在编译时暴露内部消息入口，不安装、不打包，发布 Agent 不含该入口或运行时开关。完整端点接入由 `test:opaque`、`test:e2e`、projects/operations/configuration/history 集成另行覆盖。UI 合成测试在模拟 Agent 解密后的边界注入故障；不能通过浏览器 HTTP 拦截看到加密请求。

启动修复回归可运行 `ctest --test-dir build -R native-startup-repair --output-on-failure`（POSIX）。该测试用临时 PATH 中的假 Codex 验证 Client 配置故障、提示词不含配置内容、禁用开关、help 不触发，以及 Agent 跨 30 秒重试只诊断一次；不调用模型。其他故障注入测试若不应触发真实诊断，应设置 `COC_NO_STARTUP_REPAIR=1`。

`native-client-startup-repair` 使用假 Codex 和回环 HTTP/WebSocket Relay，验证 attach/connect 的版本校验、连接拒绝、缓存初始化故障、TUI 初始化前失败及 initialized 后故障的诊断边界，不调用模型。该测试需允许本机 socket；`ctest --test-dir build -R startup-repair --output-on-failure` 可运行两项修复回归。

普通 CW 排队回归：构建原生程序后运行 `npm run test:queue`。测试使用隔离 Agent、模拟 Codex 与回环 HTTP/WebSocket，无模型调用，覆盖可靠入队去重、取消、优先执行、等待真实轮次结束、停止失败、跨控制端管理，以及 Agent 重启后保留排队与未知执行状态。`npm run test:opaque` 覆盖真实加密通道、忙碌输入区、刷新恢复和手机队列截图。`test:ui` 联合当前导航与请求恢复、语言 / 草稿、模型和审批行为回归；`test:ui:navigation` 仅验证导航，`--behavior` 可单独复现行为，其中通过真实 IndexedDB 完成回调屏障验证草稿恢复期间输入禁用、控制握手等待及恢复后原文完整。旧布局仅供 `--legacy-layout` 历史复现。CI regression 包含原生队列及加密浏览器检查；需要本机 socket 与浏览器执行权限。

旧库升级演练使用 `python3 tests/legacy-upgrade.py --legacy-source <独立旧源码目录> --agent build/coc-agent`。CI 固定旧源码为 `666d1af`，编译其原 Store 创建 SQLite 0/1，再验证备份、写入失败后的重试、旧程序拒绝版本 2、新 Agent 沿用配置和项目连续启动两次。POSIX 文件大小限制仅施加于隔离子进程，不耗尽宿主磁盘。该演练不安装 Agent，也不连接线上目标；正式安装仍需同一准确提交的成功 CI 制品。自动更新演练、默认 E2E 入口与公共原生 Agent 测试 harness 固定 `COC_NO_STARTUP_REPAIR=1`，避免测试启动失败触发修复模型；专门的启动修复测试使用自己的隔离模拟程序。

活动会话专项：`npm run build:web && npx tsx tests/ui-stability.ts --active-sessions` 使用 100 条较新的历史记录及分页活动目录，验证欢迎页优先显示、直接进入对应主机 / 项目、左侧活动记录补齐、项目切换、状态颜色与手机布局；也纳入默认 `test:ui`。单元测试 `tests/web-active-sessions.test.ts` 覆盖全部活动状态分页、游标异常、历史游标保留及迟到状态 / 删除屏障合并；`tests/session-history.test.tsx` 覆盖排序与文字状态。

### 统一导航专项验证

`npm run build:web && npm run test:ui:navigation` 使用本地模拟接收端检查新版左栏、设置、工作面板、文件预览和管理界面，无原生 Agent 或模型调用。`npm run test:markdown` 检查富文本。r2 上线可运行 `node node_modules/tsx/dist/cli.mjs scripts/verify-web-navigation.ts --access-config <0600 文件> --owner-secret-file <0600 文件> --host <现有隔离测试主机> --output .local/<目录>`；仅检查 Web，不创建会话或启动 Terminal，临时网页授权在结束时撤销。不要将它解释为完整发布门禁通过。

自动更新完整演练：干净构建后运行 `python3 tests/native-update.py --automatic --busy`，覆盖空闲安装、关闭状态库后重启及活动会话结束前不替换程序。可设置 `COC_LEGACY_FIXTURE=<旧源码>/build/coc-legacy-upgrade`，以准确旧版创建的数据库和项目登记验证自动更新保留原配置与账本；CI 固定运行此组合。测试下载服务与全部安装目录均位于临时环境。

浏览器流程定位可用 `npm run test:e2e -- --skip-tui` 跳过两段原生 TUI 专项，仅用于加快重现；其余初始化和浏览器检查照常执行。最终本机与 CI 门禁仍必须使用不带该参数的完整 E2E，并设置 `COC_TEST_TERMINAL=1` 验证真实 PTY。

部署回归还包括 `python3 tests/deploy-agent-recovery.py`（SQLite 升级后禁止单独回退旧二进制、停止恢复拒绝活动会话）及 `python3 tests/deploy-downloads.py`（已完成 CI 下载与当前原生构建输入的一致性）。两者已加入 regression 作业。

`npm run test:billing` 并行运行三个独立的原生空闲、读取和重试场景；每组使用独立端口、临时状态及进程，保留生产 30 秒重连 / 90 秒 Pong 时限和全部断言。等待全部场景完成后，任何一组失败均返回非零状态，并输出每组耗时。单独排查仍可使用 `npx tsx tests/native-demand.ts`、`npx tsx tests/native-refresh.ts` 或 `npm run test:retry`。

## 邮箱自助授权设置

`wrangler.jsonc` 声明 `SETTINGS` KV 绑定，不硬编码 namespace ID；Wrangler 部署按 Worker 创建或复用绑定，本地开发使用本地 KV。`scripts/deploy-cloud.py --target r2` 保持 r2 Worker 独立，并拒绝绑定固定生产 SETTINGS namespace 的配置。KV 仅保存开关；DO 授权与 Agent SQLite 不变。部署不会自动开启功能；需先配置测试域的 Access 邮箱入口与原生 Service Auth，再由已登录的平台管理员在网页开启。入口允许哪些邮箱由 Access 策略决定。

测试入口：`vitest run tests/cloudflare-access.test.ts tests/device-auth.test.ts` 覆盖真实签名身份、管理员开关、持久化、配对、跨邮箱拒绝、撤销与批准邮箱；`tsx tests/browser-access.ts` 覆盖管理设置、首次配置引导与配对完成后的刷新，截图保存在忽略的 `.local/browser-access/`。`python3 tests/cloud-deploy.py` 检查 r2 不共享生产 KV。
