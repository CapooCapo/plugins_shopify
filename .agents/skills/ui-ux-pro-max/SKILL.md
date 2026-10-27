---
name: ui-ux-pro-max
description: Use for UI/UX design, redesign, review, interaction quality, accessibility, responsive behavior, and data-dense interfaces in StockHub. Combines project-aware product fit with a local searchable design-guidance dataset.
---

# StockHub UI/UX Pro Max adapter

This project-local adapter makes the upstream skill usable in Codex/OpenClaw without its Claude plugin environment. The unmodified upstream instructions are in [UPSTREAM_SKILL.md.txt](UPSTREAM_SKILL.md.txt); supporting references, scripts, and data are kept beside this file.

## Use

- Use for StockHub app surfaces, admin extensions, import/product workflows, interaction design, accessibility, and responsive QA.
- Start with product context and existing route/component behavior; don't treat search output as a substitute for product judgment.
- Run the local search tool with `python3 .agents/skills/ui-ux-pro-max/scripts/search.py ...` from the repository root. It reads the vendored CSV data; no package installation, credentials, or network access is required.
- For system-wide direction, use `--design-system`; for focused concerns use `--domain ux`, `--domain react`, or `--stack react` as appropriate. Do not use its `--persist` option unless the user explicitly asks to persist generated design-system files.
- Treat upstream advice as guidance, not permission to add dependencies, scopes, network calls, or new product behavior.

## Boundaries

- This skill does not authorize Shopify Admin access, store data changes, app deployment, new permissions, or external writes.
- Respect the existing Shopify Polaris/App Bridge stack unless the user approves a scope change.
- Do not copy reference products or brands literally. Validate accessibility, responsiveness, performance, and actual rendered behavior before claiming a UI improvement.

Upstream source and pinned revision are recorded in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
