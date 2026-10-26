# 发布交接：代理、实例显示名与管理 Tab

更新时间：2026-10-26。本轮按用户要求保存进度，下次从本文继续。

## 已提交与线上状态

- 功能源码提交：`9002f525401ae11f901357ba095d877f145bcc93`（`feat: add native proxies, instance names and admin tabs`），已推送 `origin/master`，标签 `v0.5.9` 指向该提交。
- 0.5.9 仅为失败的发布候选；没有生成正式 Release、没有部署 Worker 或新下载包。线上仍为 **0.5.8**，发布前读到的 `/api/v1/healthz` 为 `{"ok":true,"version":"0.5.8","protocol":1}`。
- 本文所在后续提交保存 UTF-8 测试/CI 日志修复；没有移动 `v0.5.9`。恢复后先检查此后续提交的 master CI，再处理剩余失败；全部通过后计划使用 **0.5.10**，不要覆盖已有标签。
- 保留既有生产 secrets、Durable Object 数据、用户设备与会话；本轮没有操作用户提供的生产会话。

## 已通过的验证

- 本机完整构建、Worker dry-run、CTest、9 个 Vitest 文件 / 86 项、TypeScript、ESLint / Prettier、C++ 格式检查。
- HTTP CONNECT / SOCKS5 有无认证、HTTP / WebSocket、代理拒绝与超时、私网和本机绕过、TUI 本机票据鉴权及双向转发。
- 六组 HTTPS / WSS 验证：loopback 绕过代理、公网测试地址经本地 CONNECT，以及可信证书、不可信 CA、错误主机名。
- 管理员五个 Tab、键盘切换、唤醒功能与手机布局的独立浏览器测试。截图在 `docs/assets/proxy-names-tabs-2026-10-26/`。
- 新增 UTF-8 修复后，本机以下两项通过：

```bash
python3 tests/native-login.py \
  LoginRecovery.test_generated_defaults_and_custom_configuration \
  LoginRecovery.test_instance_settings_before_login
```

另用 `PYTHONIOENCODING=ascii` 验证 CI 包装器仍正确输出中文、保留子进程退出码并生成错误注释。

## 失败的 GitHub Actions

[0.5.9 发布检查 40300123744](https://github.com/hjxxlogic/codexovercloudflare/actions/runs/40300123744)：

| 作业                              | 结果                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| Ubuntu 20.04 原生构建、测试、打包 | 通过                                                                                  |
| Debian 12 原生构建、测试、打包    | 通过                                                                                  |
| ASan / UBSan                      | 通过                                                                                  |
| Windows x64                       | 编译与 CTest 通过；`Verify native Windows login recovery and generated defaults` 失败 |
| regression                        | 在 `npm run test:e2e && npm run test:ui` 失败                                         |
| publish-release                   | 被门禁跳过                                                                            |

Windows 公共注释只有退出码；未认证下载 job logs 返回 403，不能声称已取得完整 Windows 错误堆栈。代码检查发现新增中文测试使用系统默认编码读配置和捕获输出，本次已改为显式 UTF-8；`scripts/ci-command.py` 同时把 stdout/stderr 固定为 UTF-8，避免 Windows 错误日志自身编码失败。**仍需 Windows CI 验证修复结果。**

## 本地完整 E2E 的具体失败点

本次已在 Debian 开发容器运行真实 Wrangler、原生程序、模拟 Codex 和 Chromium，不调用模型。

已通过 CLI/TUI、外部队列与审批、历史、API Key、管理员 Tab 下的配对授权、双主机网页 Cookie 等检查。随后发生：

```text
Error: Timeout: chat ready
    at wait (tests/e2e.ts:77)
    at idle (tests/e2e.ts:184)
    at tests/e2e.ts:1842
```

对应场景：`otherPage` 切换到 `other.hostId`，项目已变为 `other-project`，通过菜单“新建对话”后，`idle(otherPage)` 等待 `.composer` 且无运行状态超时。应先调查新会话、WebSocket 附着、页面状态和慢响应；尚未确认这是产品缺陷还是测试时序，不应仅放宽超时即宣称修复。由于前一命令失败，容器内后续 `test:ui` 未执行；也不能确认 GitHub regression 与本地失败完全相同。

## 保留的本机环境与证据

以下均被 `.gitignore` 排除，没有提交凭证或运行状态：

- `.local/release-0.5.9/e2e-full.log`：完整容器日志，包含早期缺少 CA 的失败和补齐依赖后上述完整 E2E。
- `.local/release-0.5.9/actions-jobs.json`、`windows-annotations.json`、`regression-check.json`：失败 CI 的公开元数据。
- `.local/release-0.5.9/e2e-evidence/`：浏览器证据；`browser-deps.log`：容器依赖安装记录。
- `.local/release-0.5.9/previous-downloads.json`：发布前 0.5.8 下载清单。
- `.local/release-0.5.9/prepare-site.py`、`verify-online.py`：尚未执行的发布验证脚本，硬编码旧候选版本/提交，恢复发布前必须改为最终版本与提交。
- Docker 容器 `coc-release-check-059` 已停止并保留。已安装 Chromium 依赖，并补入公开 CA bundle。浏览器位于宿主 `/tmp/coc-playwright`，挂载到容器 `/ms-playwright`。

同一工作机可直接恢复：

```bash
docker start -a coc-release-check-059
```

容器启动命令会检查浏览器依赖后依次执行 `npm run test:e2e && npm run test:ui`；仓库挂载在 `/work`，改动立即可见，证据写入上述 `.local/`。容器还把宿主 OpenSSL 1.1 的两个公开运行库挂入 `/opt/coc-libs`，用于运行 Ubuntu 20.04 构建的本机二进制。测试前应重新构建与当前源码匹配的本机二进制。若换工作机或 `/tmp` 已清理，需按 `docs/DEVELOPMENT.md` 重建环境。

## 下次执行顺序

1. 拉取 master，读本文，查看最新 master CI，确认 Windows UTF-8 修复结果。
2. 继续排查完整 E2E 的跨主机新会话就绪超时；通过后运行 `test:ui`，更新测试证据。
3. 将 package.json、package-lock.json、CMake、Worker health、README、手册及发布说明同步到 0.5.10；提交并推送干净源码和匹配标签。
4. 等待 GitHub Actions 三平台、sanitizers、regression 全通过并生成 Release。不在本地代替 Windows 打包，不改写旧标签。
5. 下载对应 Release 的 site 包，核对 GitHub asset digest、下载清单、归档 SHA256、commit/sourceDigest；使用同一提交的 Worker 部署。保留生产 secrets。
6. 验证线上 health、未授权 401、网页 JS/CSS、UTF-8 手册、三个平台包与源码包逐字节一致；把真实部署版本和证据提交到仓库。

GitHub SSH 22 端口本轮无响应，443 可用，且继续验证既有 github.com 主机密钥：

```bash
git -c core.sshCommand='ssh -o ConnectTimeout=12 -o BatchMode=yes -o HostKeyAlias=github.com -p 443 -o Hostname=ssh.github.com' push origin master
```

Wrangler `whoami` 已核对账号与 `wrangler.jsonc` 一致，既有 OAuth 可用；沙箱中认证刷新会失败，需在允许网络及 Wrangler 配置目录写入的环境执行。`/tmp/gh_2.103.2_linux_amd64/bin/gh` 存在，但没有 GitHub API 登录；公开 Actions / Release 元数据可用 `curl` 获取。
