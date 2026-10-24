# Repository Guidelines

## Project Structure & Module Organization

This is a working TypeScript prototype for remote Codex access through Cloudflare. One root `package.json` manages all dependencies; components are not independently published packages.

- `apps/relay/src/`: Worker, authentication, device registration, and Durable Objects.
- `apps/agent/src/`: Codex processes, project policies, SQLite journal, and outbound WebSocket.
- `apps/cli/src/`: login, enrollment, and native TUI launcher.
- `apps/web/src/`: React interface; `packages/protocol/src/`: shared schemas and types.
- `tests/`: Vitest tests, integration runner, and deterministic Codex fixture.
- `scripts/` and `examples/`: setup, smoke checks, configuration, and systemd template.
- `docs/`: requirements, architecture, user guide, and test evidence. Design documents describe targets; consult README for implemented limits.

## Build, Test, and Development Commands

Use Node.js ≥22.17, preferably 24, and Codex `0.164.0`.

- `npm ci`: install locked dependencies.
- `npm run setup:local`: generate ignored development secrets without overwriting configuration.
- `npm run dev`: build the webpage and serve Wrangler at `127.0.0.1:8787`.
- `npm run agent -- .local/agent.json`: start an enrolled Agent.
- `npm run coc -- hosts`: use the CLI; its default relay is `https://r.xlogic.cc`.
- `npm run typecheck`, `npm run lint`, `npm test`: static checks and unit tests.
- `npm run build`: build assets and dry-run Worker deployment; does not publish.
- `npm run format`: format configured source and documentation paths.

Ubuntu 20.04 requires the Docker workerd workaround in `docs/DEVELOPMENT.md`.

## Coding Style & Naming Conventions

Use strict TypeScript, ES modules, two-space indentation, single quotes, and trailing commas. Follow ESLint and Prettier. Keep protocol validation in `packages/protocol`; enforce execution policies in Agent code. Preserve existing Chinese documentation.

## Testing Guidelines

Name Vitest tests `*.test.ts`. `npm run test:e2e` uses real Wrangler and Chromium with simulated Codex; build web assets and install Playwright Chromium first. Cover authentication, approval routing, deduplication, isolation, and reconnect failures.

`test:codex` and default `test:native` use real Codex without model requests. `test:task` and `test:native -- --relay --task` call the configured model; the latter requires the `coc-local-test` Docker image. Distinguish simulated, local-runtime, and production evidence. No coverage percentage is mandated.

## Commit & Pull Request Guidelines

History uses imperative `docs:` and `feat:` subjects. Explain behavior, validation, limitations, and relevant issues in PRs; include screenshots for UI changes. Update `CHANGELOG.md` for user-visible changes.

## Documentation Updates

Every functional change must include corresponding updates to affected documents under `docs/` in the same change. Update `docs/USER_GUIDE.md` whenever user workflows, commands, configuration, or supported behavior change. Also update development instructions, requirements, architecture, and test records where affected. Keep documented behavior and limitations consistent with the implementation; updating `CHANGELOG.md` alone does not satisfy this requirement.

## Security & Configuration

Never commit credentials, `.dev.vars`, `.local/`, SQLite state, or real tokens. Keep examples as placeholders. Preserve server-controlled sandbox policies, RPC allowlists, and explicit approvals. Do not infer production deployment from the configured domain.
