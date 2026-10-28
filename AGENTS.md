# Repository Guidelines

## Project Structure & Module Organization

This repository provides remote Codex access through Cloudflare. Local programs use C++17; the relay and browser use TypeScript.

- `native/include/coc/`, `native/src/`: Agent, CLI, transport, subprocesses, policies, and SQLite.
- `native/tests/`: CTest and real Codex protocol/task checks.
- `apps/relay/src/`: Worker, RegistryDO, HostRelayDO, and authentication.
- `apps/web/src/`: React interface; `packages/protocol/`: Zod schemas and types.
- `tests/`: protocol and integration tests; `tests/support/`: native process harness and fault injection only.
- `scripts/`, `examples/`, `docs/`: setup, smoke checks, configuration, and documentation.

## Build, Test, and Development Commands

Use C++17, CMake ≥3.16, Boost.System ≥1.71, OpenSSL, SQLite3, and nlohmann/json ≥3.7. Local binaries need no Node.js. Cloud/web tooling requires Node.js ≥22.17; Codex `0.164.0` is the verified baseline; Agent/CLI do not pin the installed version.

- `npm ci`: install cloud/web and test dependencies.
- `npm run build:native`: compile `build/coc-agent`, `build/coc-client`, and native tests.
- `./build/coc-agent run --config .local/agent.json`, `./build/coc-client hosts`: run local programs.
- `npm run setup:local`, `npm run dev`: initialize secrets and run local relay/web.
- `npm test`: CTest and Vitest without model calls.
- `npm run typecheck`, `npm run lint`, `npm run lint:cpp`: static checks.
- `npm run build`: native/web builds and Worker dry-run; never publishes.

See `docs/DEVELOPMENT.md` for dependencies and the Ubuntu 20.04 Docker workaround.

## Coding Style & Naming Conventions

Use two-space indentation. C++ uses snake_case functions, PascalCase classes, RAII, parameter-array subprocess execution, and clang-format. TypeScript uses strict mode, ESLint, and Prettier. Keep C++ validation consistent with Zod; server policies remain authoritative.

## Testing Guidelines

Cover authentication, isolation, approvals, deduplication, process exit, and reconnects. CTest verifies native behavior; `*.test.ts` uses Vitest. `test:e2e` starts native binaries, Wrangler, simulated Codex, and Chromium. `test:codex` and `test:native` use real Codex without model calls; `test:task` and `test:native -- --task` call the model. TUI tests require the Docker image. No coverage percentage is mandated.

## CI Builds and Deployment

- Push the reviewed source to GitHub and use `.github/workflows/checks.yml` to build and test deployment artifacts. Local checks are useful for development; never deploy locally built binaries as verified release artifacts.
- Wait for the exact source commit's Actions run to finish successfully. Inspect every required job, including regression, sanitizers, Ubuntu 20.04, Debian 12, musl, and Windows x64. A triggered or still-running workflow is not a passing result; fix failures and push again.
- Deploy through checked-in scripts, extending them for uncovered targets instead of repeating ad-hoc AI-generated deployment commands. For a Linux systemd user-service Agent, use `scripts/deploy-agent.py --push`; it pushes clean HEAD, waits for CI, verifies the GitHub artifact digest and source identity, waits for idle work, backs up the running binary, installs, verifies, and attempts rollback on failure.
- Preserve credentials, configuration, databases, and running tasks. Restarting active sessions requires explicit authorization (`--allow-restart-active`); normal deployment waits for idle. Do not infer permission to publish a Worker or release from an Agent update.
- Record the commit, Actions URL/result, artifact checksums, deployment target, verification, and limitations under `docs/`; keep credentials and machine-local evidence in ignored `.local/` paths.

## Commit, PR & Documentation Requirements

Use concise imperative `feat:`, `fix:`, or `docs:` subjects. PRs describe behavior, validation, limitations, configuration changes, and screenshots for UI changes. Update `CHANGELOG.md` for user-visible changes.

Every functional change must update affected documents under `docs/` in the same change, including `docs/USER_GUIDE.md` for workflows, commands, configuration, or supported behavior. Update requirements, architecture, development instructions, and test evidence where affected. Updating `CHANGELOG.md` alone is insufficient.

## Security & Configuration

Never commit secrets, `.local/`, `.dev.vars`, or SQLite state. Preserve RPC allowlists, sandbox policies, explicit approvals, and TLS verification. Do not infer production deployment from `r.xlogic.cc`.
