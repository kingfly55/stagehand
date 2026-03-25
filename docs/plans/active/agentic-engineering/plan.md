# Agentic Engineering — Master Plan

**Context:** This is a fork of `browserbase/stagehand`. This plan establishes agent-first engineering practices inspired by OpenAI's harness engineering approach, adapted for a fork that must track and merge upstream changes while maintaining intentional divergences.

**Upstream repo:** https://github.com/browserbase/stagehand
**Fork repo:** https://github.com/kingfly55/stagehand

---

## Problem Statement

The fork currently lacks:
- Upstream sync infrastructure (no `upstream` remote, no divergence tracking)
- Structured agent guidance (`claude.md` is a monolithic file)
- Mechanical enforcement of hard constraints (protected paths, branch policies)
- Automated merge tooling for tracking a fast-moving upstream
- Organized planning documents (scattered at repo root)
- Quality and entropy management (no drift detection)
- Agent-to-agent review capabilities (human review bottleneck)

## Architecture Decisions

- **Progressive disclosure:** `claude.md` becomes a short map; detailed docs live in `docs/`
- **Mechanical enforcement over prose:** Every hard constraint gets a pre-commit hook or CI check
- **DIVERGENCE.md as source of truth:** All merge conflict resolution is driven by a living divergence catalog
- **Skills as automation:** Claude Code skills wrap scripts for merge, review, and cleanup workflows
- **Plans as first-class artifacts:** All planning docs live in `docs/plans/{active,completed}/` with indexes

## Constraints

- Must not break existing `pnpm typecheck`, `pnpm build:esm`, or `pnpm test:core`
- Must preserve all information during `claude.md` restructure
- Protected paths (recursive, includes subdirectories):
  - `packages/core/lib/v3/understudy/**` (except `page.ts` and `native/**`) — includes `a11y/` etc. The `native/` subdirectory is fork-only implementation code and MUST be allowed.
  - `packages/core/lib/v3/handlers/**` (type refs only) — includes `handlerUtils/`
- No direct commits to `main` — work on `native-base` or feature branches
- All shell scripts must include `set -euo pipefail` and work on Ubuntu (bash 5+), **except**:
  - `scripts/pr-review.sh` — must use `set -uo pipefail` (no `-e`) because it intentionally runs commands that may fail and reports their results
  - `scripts/doc-gardening.sh` — must use `set -uo pipefail` (no `-e`) because it runs multiple checks that may find issues without aborting
- `gh` CLI is required for PR-related scripts (Milestone 7); document this dependency
- The `python3` `yaml` module (PyYAML) may not be installed; YAML validation should fall back to a simpler check
- `git merge-tree --write-tree` requires git ≥ 2.38. Scripts using it must check the git version and fail with a clear message if too old.
- `bc` may not be installed on minimal Ubuntu systems; use `sort -V` or bash string comparison for version checks instead.
- Merge commits from `scripts/upstream-merge.sh` will touch protected upstream files. The script MUST use `git commit --no-verify` for merge commits to bypass the pre-commit hook, and document this in the commit message.

## Prerequisite Notes

- The `.claude/` directory does not yet exist; Milestone 4 (first to create a skill) must `mkdir -p .claude/skills/` before writing skill files.
- The `scripts/` directory does not yet exist; Milestone 1 (first to create a script) must `mkdir -p scripts/` before writing scripts.
- The `docs/` directory partially exists (only `docs/plans/active/agentic-engineering/` from this plan); earlier milestones must create subdirectories as needed.
- **`pnpm typecheck` does NOT exist as a root-level script** in `package.json`. Each workspace package has its own `typecheck` script. Milestone 1 must add `"typecheck": "turbo run typecheck"` to root `package.json` scripts AND add a `"typecheck"` task to `turbo.json` with `{ "outputs": [], "cache": false }` (similar to the existing `format` task — NOT `lint`, which has `dependsOn: ["^build"]` and `inputs` that are wrong for typecheck) so that `pnpm typecheck` works from the repo root. Verify this works before any milestone declares success.
- husky is not currently a dependency; Milestone 3 must install it with `pnpm add -Dw` (workspace root flag required for pnpm workspaces).
- **The root `package.json` has `"prepare": "node packages/core/scripts/prepare.js"`.** Milestone 3 must chain husky into this existing script (e.g., `"prepare": "node packages/core/scripts/prepare.js && husky"`) rather than replacing it, or husky's install hook will break the existing prepare logic.
- `test:native` is referenced in `claude.md` but does NOT exist in root `package.json`. It exists only in `packages/core/package.json` as a workspace-level script. Reference it as `pnpm --filter @browserbasehq/stagehand run test:native` in extracted docs, or note it's workspace-only.
- A `.pipeline-venv/` directory exists at repo root (Python virtual environment). Scripts that glob for `.md` files (e.g., doc gardening in Milestone 6) must exclude this directory to avoid false positives.

## Key Verification Commands

```bash
pnpm typecheck          # Must pass for every milestone (added to root in Milestone 1)
pnpm build:esm          # Must pass for build-affecting milestones
pnpm test:core          # Must pass for code-affecting milestones
```

**Important:** `pnpm typecheck` must be set up as a root script before it can be used. See Prerequisite Notes above. Until Milestone 1 adds it, use `pnpm -r run typecheck` as a workaround.

---

## Milestones

### Milestone 1 — Upstream Sync Infrastructure
- **File**: 1.md
- **Status**: incomplete
- **Summary**: Add root `typecheck` script/turbo task, configure upstream remote, create DIVERGENCE.md, build sync script, add CI upstream-behind check

### Milestone 2 — Agent Map (claude.md Restructure)
- **File**: 2.md
- **Status**: incomplete
- **Summary**: Restructure claude.md into a <120-line map with pointers; create docs/ directory tree for agent knowledge

### Milestone 3 — Golden Principles & Mechanical Enforcement
- **File**: 3.md
- **Status**: incomplete
- **Summary**: Implement pre-commit hooks enforcing protected paths, branch policy, and typecheck; create GOLDEN_PRINCIPLES.md

### Milestone 4 — Upstream Merge Agent Skill
- **File**: 4.md
- **Status**: incomplete
- **Summary**: Build automated merge script and Claude Code skill using DIVERGENCE.md for conflict resolution; populate MERGE_POLICY.md

### Milestone 5 — Execution Plans as First-Class Artifacts
- **File**: 5.md
- **Status**: incomplete
- **Summary**: Move scattered planning docs to docs/plans/completed/, create indexes and plan template

### Milestone 6 — Quality Grading & Entropy Management
- **File**: 6.md
- **Status**: incomplete
- **Summary**: Create quality score tracking, doc gardening script, and cleanup sweep skill for drift detection

### Milestone 7 — Agent Review Loop
- **File**: 7.md
- **Status**: incomplete
- **Summary**: Build automated PR review skill with divergence impact checking, golden principle enforcement, and auto-labeling

---

## Implementation Order

| Priority | Milestone | Dependencies |
|----------|-----------|-------------|
| 1 | Milestone 1 — Upstream Sync Infrastructure | None |
| 2 | Milestone 2 — Agent Map | Milestone 1 |
| 3 | Milestone 3 — Golden Principles | Milestone 2 |
| 4 | Milestone 4 — Upstream Merge Skill | Milestones 1, 2, 3 |
| 5 | Milestone 5 — Execution Plans | Milestones 2, 3 |
| 6 | Milestone 6 — Quality Grading | Milestones 1, 2, 5 |
| 7 | Milestone 7 — Agent Review Loop | Milestones 3, 4, 5, 6 |
