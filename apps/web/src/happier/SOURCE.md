# Happier UI extraction

Source: https://github.com/happier-dev/happier/tree/d515b5547a1a3aa03e3141ddb6a45f4a72ae1025

Copyright (c) 2026 Happy Coder Contributors. MIT; the complete notice ships in
`apps/web/public/happier-LICENSE.txt` and is available from the sidebar.

| Upstream file under `apps/ui/sources/`                          | DOM adaptation                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| `components/navigation/shell/SidebarView.tsx`                   | Persistent desktop navigation / mobile drawer                  |
| `components/sessions/shell/SessionsList.tsx`, `SessionItem.tsx` | Session list, inset selected row, project / status hierarchy   |
| `components/sessions/shell/SessionView.tsx`                     | Session heading and constrained transcript / composer surfaces |
| `components/sessions/agentInput/AgentInput.tsx`                 | Rounded bordered input card with separate controls             |
| `theme/tokens/surfaceAndTextColors.ts`                          | Extracted light/dark surface and text palette in CSS           |

This is a React DOM adaptation of the above presentation. It uses CoC's existing
SessionHistory and handlers. React Native, Expo, Happier synchronization, routes,
agent protocol and branding are not imported. CoC approvals, reliable delivery,
Markdown, file and Terminal components continue to render their existing state.

The same palette now lives in `public/happier-theme.css` for the entire site,
including authentication, administration, previews, diagrams and downloads.
`site.css` adapts CoC-specific settings and tables to the same surfaces, sidebar,
spacing and controls; those administration functions are CoC's existing UI.
Theme changes share the existing appearance preference and do not reconnect
sessions or recreate the terminal engine.

The second layout pass was checked against the running official Web (0.2.19),
with two real sessions and tool / approval events; see
`docs/HAPPIER_WEB_COMPARISON_2026-11-05.md`. Inter is vendored from the same
pinned upstream website asset; its SIL Open Font License is kept beside the font
in `assets/Inter-LICENSE.txt` and shipped as `public/Inter-LICENSE.txt`. The bundled font is used by the SPA without a CDN.
Outline icons are local SVG paths and add no runtime dependency.
