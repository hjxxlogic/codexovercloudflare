# 0.6.0 升级与切换步骤

本文件保留隔离候选演练，并说明现场原生升级步骤。源码 `4b164c6` 已通过六项必需 CI，2026-11-01 已发布云端与四平台下载包，详见 [发布记录](DEPLOYMENT_STATUS.md)。现场原生程序未安装或重启，未执行云端数据清理；以下任务核对、原生备份和逐台升级仍须执行。

## 候选与证明

在已提交的干净源码和用户 `.local` 依赖环境下运行：

```bash
source /home/ubuntu/.local/env/coc-build.sh
python3 scripts/prepare-local-candidate.py --output .local/acceptance/candidate-060
```

输出目录须尚不存在。脚本执行完整本地构建和 Worker dry-run，核对真实 Agent / CLI `--version` 与清单，按本机平台标签打包，重新计算源码归档内每个文件 / 符号链接的 sourceDigest；为全部网页、Worker、原生归档及源码包保存 SHA256 清单和同一来源身份。过程中源码变化会拒绝候选。该结果仅供本地审查，不能替代后续正式发行的平台验证。

真实旧更新器独立验证：

```bash
npm run test:update:legacy -- \
  --old-agent /path/to/authentic-old/coc-agent \
  --old-client /path/to/authentic-old/coc-client \
  --output .local/acceptance/legacy-update-060 --e2e
```

原文件只读；每个用例复制后再更新。验证网络失败、缺平台、SHA256、候选身份、发行协议和安装失败保留旧程序，以及成功下载 / 安装后的真实新程序启动。完整 E2E 直接使用安装后的两程序，经过本地 Worker 完成 delivery:2 业务，不能只凭 `--version` 宣告升级成功。旧更新器选择器采用 ubuntu20.04 命名的回环夹具；此名称仅使旧选择器能在当前主机取得测试候选，不声明 Ubuntu 20.04 兼容性。实际本机候选使用 `local-<本机系统>` 标签。

本轮选择 Agent 手动升级：等待任务结束、停服务、`coc-agent update`、再启动并核实运行实例。CLI 退出旧 TUI 后运行 `coc-client update`。不为旧 hello 加业务兼容；Agent 跨旧新业务准入的自动升级通路未验收，不作为切换依赖。

## 现场原生切换检查点

1. 审核候选身份、摘要、权限 / 故障 / 资源测试与真实旧更新器证据。停止新任务准入，等待旧任务结束，逐一核对结果不明和未决审批；不能自动重发。
2. 保存原生程序和 `--version`、配置 / 凭据、项目目录、配置管理回执、Agent 权威数据库及新旧客户端待办。Codex home、工作区和云端权限状态另行备份，不认为 Agent 历史包含项目文件。
3. 用 SQLite 在线备份 API 保存 Agent 数据库，不能只复制活动 `.db` 文件忽略 WAL。以下变量均由操作人明确填写，备份目录应私有且尚不存在：

   ```bash
   umask 077
   mkdir -m 0700 -- "$coc_backup_dir"
   python3 scripts/state-backup.py backup \
     --data-dir "$coc_state_dir" --file "$coc_backup_dir/agent.db"
   install -m 0600 -- "$coc_agent_config" "$coc_backup_dir/agent.json"
   install -m 0700 -- "$coc_agent_binary" "$coc_backup_dir/coc-agent"
   ```

   另将 projects.json、相应 `.remote` 回执 / 私有配置备份、CLI 配置及其待办复制到同一受保护检查点。不能删除整个 dataDir 或凭据。备份工具同时支持旧历史库和不含 requests 表的新版数据库，保留全部 transport2 表和原实例；拒绝覆盖既有备份。
4. 先准备完整下载清单和摘要及可达的手动 update 通路，再切换业务 Worker / 网页；保留授权、撤销、租约 / epoch / ticket 等权限状态。云端旧业务 / 进度字段已从读写与归档中隔离，不需要在本轮清空线上数据库。
5. 逐台等待空闲并停旧 Agent，再执行已验证的手动 update 和启动。核对管理页面实际运行版本、当前连接 capabilities、Agent 实例和一项明确新意图；磁盘 `--version` 仅证明文件身份。客户端加载新版资源 / 新传输作用域，不把旧 outbox 或旧游标导入新流。

## 失败与回退边界

下载、校验、身份或安装前失败保留旧程序和配置，停止切换并核查原请求；不因超时重新派发副作用。安装成功前保留 `.previous`；不能把备份文件的存在当作新程序已成功运行。

新版已写状态后，禁止自动启动旧程序读取新版数据库。先停止新版并保留其当前状态与未知结果，核对实际工作区副作用；优先修复并继续新版。确需完整回退时，须明确选择同一时间点的旧程序、配置和数据库检查点，审核备份之后的副作用和待办后再恢复，不能把历史快照中的任务当作新意图重放。

数据库恢复只在 Agent 停止时使用现有脚本，它取得同一 Agent 实例锁并验证完整性：

```bash
python3 scripts/state-backup.py restore \
  --data-dir "$coc_state_dir" --file "$coc_backup_dir/agent.db"
```

脚本只恢复选定快照，不启动任何版本，不自动清理待办或工作区。本轮已对真实旧 Agent 升级后生成的隔离数据库完成备份 / 恢复：43 张表（含 27 张 transport2 表）逐行一致，原实例与历史保留，快照及全新恢复文件均为 0600；配置和项目目录另作私有副本核对。证据 `.local/acceptance/state-rehearsal-060/evidence.json`。生产回退需要明确指令；已执行的云端部署范围见发布记录，不能据此认定现场原生升级完成。
