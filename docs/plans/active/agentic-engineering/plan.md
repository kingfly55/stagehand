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
- Protected paths: `packages/core/lib/v3/understudy/` (except `page.ts`), `packages/core/lib/v3/handlers/` (type refs only)
- No direct commits to `main` — work on `native-base` or feature branches

## Key Verification Commands

```bash
pnpm typecheck          # Must pass for every milestone
pnpm build:esm          # Must pass for build-affecting milestones
pnpm test:core          # Must pass for code-affecting milestones
```

---

## Milestones

### Milestone 1 — Upstream Sync Infrastructure
- **File**: 1.md
- **Status**: incomplete
- **Summary**: Configure upstream remote, create DIVERGENCE.md, build sync script, add CI upstream-behind check

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
| 5 | Milestone 5 — Execution Plans | Milestone 2 |
| 6 | Milestone 6 — Quality Grading | Milestones 1, 2, 5 |
| 7 | Milestone 7 — Agent Review Loop | Milestones 3, 4, 6 |
