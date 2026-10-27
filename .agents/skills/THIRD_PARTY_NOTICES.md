# Third-party project skills

Skills in this directory are vendored for project-local agent guidance. Upstream source files are preserved unmodified except renaming upstream `SKILL.md` to `UPSTREAM_SKILL.md.txt` so the local compatibility adapter is the only discoverable entry point. Adapters document StockHub-specific path and authority boundaries.

| Skill | Upstream | Pinned revision | License | Notes |
|---|---|---|---|---|
| `ui-ux-pro-max` | https://github.com/nextlevelbuilder/ui-ux-pro-max-skill | `28b3b8dee8c976df4fa3e94aed4e092ad43fcb03` | MIT | Vendored the upstream skill, its local search scripts/references, and the dataset required by the search script. Search is local-only. Excluded unrelated Claude skills, plugin manifests, CLI, gallery, and examples. |
| `tasteful-ui` | https://github.com/DonkeyKing01/tasteful-ui-skill | `159ccd47a320f3a7bd0289d07366d422211895a1` | MIT | Vendored the complete `tasteful-ui/` skill tree and references. No scripts, hooks, or external services in the skill tree. |

Both upstream repositories were public at the pinned revisions when inspected. The adapters and vendored source do not install dependencies, request credentials, or perform network operations. The Pro Max search helper reads local CSV data; its optional persistence mode writes files and is prohibited by the adapter unless specifically requested.
