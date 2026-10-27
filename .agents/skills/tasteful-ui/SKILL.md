---
name: tasteful-ui
description: Use for substantial StockHub UI redesigns, visual direction, product-specific design briefs, dashboard and workflow critiques, and before implementing broad frontend changes.
---

# Tasteful UI adapter

This project-local adapter applies the upstream taste-first process to StockHub. The unmodified upstream skill is preserved in [UPSTREAM_SKILL.md.txt](UPSTREAM_SKILL.md.txt), with its linked modes, formats, workflows, and references alongside it.

## Project use

- Read current product routes, user workflows, screenshots, existing components, and repository constraints before proposing visual changes.
- Use the `taste_first_redesign` mode when the user has not confirmed a visual direction. Present product-fit directions before writing the design brief or implementation.
- Keep Shopify Admin conventions and Polaris patterns where they help usability; don't imitate a reference product's branding or copy its interface literally.
- Treat provided screenshots as inspiration unless the user explicitly identifies one as the target design.
- Preserve existing behavior unless the accepted design contract explicitly changes it.

## Investment gates

For broad or taste-sensitive redesigns, stop at each upstream investment gate: confirm the product understanding/scope, then the taste direction, then the executable design brief and delivery scope. User authorization to improve UI does not itself select among conflicting visual directions. Continue autonomously only when the user explicitly delegates those taste decisions.

## Verification

After implementation, run relevant checks and inspect rendered desktop and mobile states when runtime is available. Label unavailable visual/runtime checks `NOT VERIFIED`; source inspection alone is not visual proof.

This skill grants no authority for Shopify Admin data changes, deployment, new permissions, or third-party branding use. Source/revision/license are in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
