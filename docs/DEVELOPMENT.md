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

`npm test` 是 CTest 加 Vitest，不调用模型。其它测试入口、依赖与覆盖见 [测试说明](TEST_REPORT.md)。需要真实模型的 `test:task` 和 `test:native -- --task` 应单独运行。

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
