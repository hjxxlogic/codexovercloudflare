# Repository Guidelines

## Project Structure & Module Organization

This repository is currently in the design stage. `docs/IDEARS.md` records the requirements and proposed architecture in Chinese. No application source, tests, or asset directories exist yet.

The proposal includes a server-side Codex manager, a client offering CLI proxy and browser modes, and a Cloudflare Workers relay using Durable Objects. When implementing these components, give each a clearly named directory and document its responsibilities. Keep design documents under `docs/`.

## Build, Test, and Development Commands

No build system, package manifest, development server, or test runner is configured. Commands such as `npm install`, `npm test`, and `npm run build` are not currently supported.

For documentation changes, inspect `docs/IDEARS.md` and preview the Markdown. When introducing executable code, add the necessary manifest and document exact installation, local development, build, and test commands alongside it.

## Coding Style & Naming Conventions

Use descriptive Markdown headings, short paragraphs, and fenced code blocks with language identifiers. Preserve the meaning and language of existing design notes when editing them.

No programming-language style or formatter has been established. When adding a component, choose consistent indentation and naming conventions, configure an appropriate formatter or linter, and document its invocation. Avoid unrelated formatting changes.

## Testing Guidelines

No testing framework or coverage threshold exists. Future implementation changes should include tests for the behavior they introduce, particularly connection handling, relay failures, and session isolation. Document the selected test location, filename convention, and commands when adding the first suite.

## Commit & Pull Request Guidelines

Git history is unavailable in this checkout, so no existing commit convention can be verified. Use concise, imperative messages, such as `docs: clarify relay architecture`.

Pull requests should explain the change, reference relevant requirements or issues, and describe validation performed. Include screenshots for browser interface changes and note configuration changes.

## Security & Configuration

Never commit Codex credentials, Cloudflare API tokens, or real session secrets. When configuration is introduced, provide examples containing placeholders and document required settings.
