# Agentic Engineering Requirements — Stagehand Fork

**Context:** This is a fork of `browserbase/stagehand`. These requirements establish agent-first engineering practices inspired by OpenAI's harness engineering approach, adapted for a fork that must track and merge upstream changes while maintaining intentional divergences.

---

## Requirement 1: Upstream Sync Infrastructure (CRITICAL)

### Problem
- No `upstream` remote configured (only `origin` exists)
- `claude.md` references `git pull upstream main` but the remote doesn't exist
- No automated divergence tracking — the 3 fork-only commits (`#18`, `#19`, `#20`) are known today but won't be as the repo grows
- No agent-friendly merge conflict resolution process

### Deliverables
1. Add `upstream` remote pointing to `browserbase/stagehand`
2. Create `docs/fork/DIVERGENCE.md` — a living document cataloging every intentional divergence (files added, files modified, why) so agents can distinguish "our changes" from "upstream changes" during merges
3. Create a merge-from-upstream script/skill that: fetches upstream, identifies conflicts, and provides agents with context about which side of each conflict to prefer
4. Add a CI check or hook that warns when upstream is >N commits ahead

### Acceptance Criteria
- `git remote -v` shows both `origin` and `upstream`
- `DIVERGENCE.md` lists every file modified or added by the fork, with rationale
- A documented process exists for agents to merge upstream changes
- Typecheck and core tests pass after any upstream merge

---

## Requirement 2: Agent Map (claude.md Restructure) (HIGH)

### Problem
Current `claude.md` mixes fork context, API docs, and agent constraints into one file. This is the "one big AGENTS.md" anti-pattern — context is a scarce resource, too much guidance becomes non-guidance, and monolithic files rot.

### Deliverables
1. Restructure `claude.md` into a short ~100-line map with pointers
   - Fork context and hard constraints remain in `claude.md`
   - API usage docs move to `docs/api-usage.md` or point to `packages/docs/`
   - Verification commands move to `docs/dev/VERIFICATION.md`
2. Create a `docs/` top-level directory (distinct from `packages/docs/`) for agent-consumable knowledge:
   ```
   docs/
   ├── fork/
   │   ├── DIVERGENCE.md
   │   ├── MERGE_POLICY.md
   │   └── ARCHITECTURE_DELTA.md
   ├── dev/
   │   ├── VERIFICATION.md
   │   └── GOLDEN_PRINCIPLES.md
   └── plans/
       ├── active/
       └── completed/
   ```

### Acceptance Criteria
- `claude.md` is under 120 lines and contains only a map + hard constraints
- Each pointer in `claude.md` resolves to a real file
- An agent reading only `claude.md` can find any detailed doc within one hop
- No information is lost in the restructure

---

## Requirement 3: Golden Principles & Mechanical Enforcement (HIGH)

### Problem
Hard constraints in `claude.md` (never modify `understudy/`, never commit to `main`) are only prose — not mechanically enforced. Agents can violate them silently.

### Deliverables
1. Pre-commit hooks or CI checks that enforce:
   - No direct commits to `main`
   - No modifications to protected paths (`packages/core/lib/v3/understudy/` except `page.ts`)
   - `pnpm typecheck` passes before push
2. `docs/dev/GOLDEN_PRINCIPLES.md` encoding fork-specific invariants with machine-enforceable counterparts where possible
3. Custom lint error messages that inject remediation instructions into agent context (per harness engineering article)

### Acceptance Criteria
- A commit touching a protected file is rejected by pre-commit hook with a clear error message
- A push to `main` is rejected with a clear error message
- `pnpm typecheck` failure blocks commits
- Golden principles doc exists and is referenced from `claude.md`

---

## Requirement 4: Upstream Merge Agent Skill (MEDIUM-HIGH)

### Problem
Upstream stagehand is actively developed (~1800+ PRs). The fork must merge frequently. Manual merges don't scale, and agents need context to resolve conflicts intelligently.

### Deliverables
1. A Claude Code skill (or script) that:
   - Fetches upstream `main`
   - Attempts rebase/merge onto fork's `main`
   - On conflict, reads `DIVERGENCE.md` to understand intent
   - Resolves conflicts intelligently: prefers upstream for files not in `DIVERGENCE.md`, prefers fork for intentionally diverged files
   - Runs `pnpm typecheck && pnpm build:esm && pnpm test:core` to verify
   - Opens a PR with a summary of what changed upstream
2. Documentation of the merge strategy in `docs/fork/MERGE_POLICY.md`

### Acceptance Criteria
- An agent can invoke the skill and produce a merge PR without human intervention for non-conflicting merges
- Conflicting merges produce a PR with clear conflict annotations and rationale for each resolution
- All verification commands pass post-merge
- `DIVERGENCE.md` is updated if the merge introduces new fork-specific changes

---

## Requirement 5: Execution Plans as First-Class Artifacts (MEDIUM)

### Problem
Planning documents (`PLAYWRIGHT_NATIVE_PLAN.md`, `PHASE4_*`, `V2_vs_V3_NATIVE_COMPARISON.md`, `SNAPSHOT_UPGRADE_RESEARCH.md`, `AGENT_ORCHESTRATION.md`) are scattered at the repo root, mixing completed work with active plans. No progressive disclosure structure.

### Deliverables
1. Move completed plans to `docs/plans/completed/`:
   - `PLAYWRIGHT_NATIVE_PLAN.md`
   - `PHASE4_FINAL_BRIEF.md`
   - `PHASE4_ADDENDUM.md`
   - `V2_vs_V3_NATIVE_COMPARISON.md`
   - `SNAPSHOT_UPGRADE_RESEARCH.md`
   - `AGENT_ORCHESTRATION.md`
   - `DOCS_UPDATE_PLAN.md`
2. Create `docs/plans/active/` for current work
3. Create a plan template (`docs/plans/TEMPLATE.md`) that agents follow for new work
4. Add index files so agents can discover plans without scanning directories

### Acceptance Criteria
- No planning documents remain at repo root (except `README.md`, `CHANGELOG.md`, `claude.md`, `TESTING_GUIDE.md`)
- `docs/plans/active/` and `docs/plans/completed/` exist with index files
- Plan template exists and covers: problem statement, scope, approach, verification, acceptance criteria
- `claude.md` points to the plans directory

---

## Requirement 6: Quality Grading & Entropy Management (MEDIUM)

### Problem
Agent-generated code drifts over time. Without periodic sweeps, stale docs, orphaned code, and divergence drift accumulate silently.

### Deliverables
1. A `docs/QUALITY_SCORE.md` tracking:
   - Known tech debt items with severity
   - Documentation freshness (last verified date per doc)
   - Fork divergence health (how far behind upstream)
2. A recurring "doc gardening" check (script or scheduled task) that:
   - Verifies `DIVERGENCE.md` matches actual file differences from upstream
   - Flags stale docs (not updated in >30 days)
   - Checks that all pointers in `claude.md` resolve to real files
3. A "cleanup sweep" skill that agents can run to identify and fix entropy

### Acceptance Criteria
- Quality score doc exists with initial baseline
- Doc gardening script runs and produces actionable output
- Stale or broken doc pointers are flagged automatically
- `DIVERGENCE.md` accuracy can be verified mechanically

---

## Requirement 7: Agent Review Loop (LOWER)

### Problem
As complexity grows, human review becomes the bottleneck. Agent-to-agent review can catch common issues automatically.

### Deliverables
1. A PR review skill that checks:
   - Does this PR touch upstream files? If so, does `DIVERGENCE.md` explain why?
   - Does typecheck pass?
   - Are tests green?
   - Are any golden principles violated?
   - Is the PR description adequate for future agents to understand the change?
2. Integration with the existing `AGENT_ORCHESTRATION.md` adversarial review pipeline
3. Auto-labeling of PRs: `upstream-safe` (no divergence impact), `divergence-update` (modifies fork-specific files), `needs-human-review` (touches protected paths or policy)

### Acceptance Criteria
- Agent can review a PR and produce structured feedback
- PRs are auto-labeled based on their divergence impact
- Golden principle violations are flagged before merge
- Review results are posted as PR comments

---

## Implementation Order

| Priority | Requirement | Dependency |
|---|---|---|
| 1 | Upstream Sync Infrastructure | None |
| 2 | Agent Map (claude.md restructure) | Req 1 (needs `docs/fork/` structure) |
| 3 | Golden Principles & Enforcement | Req 2 (needs `docs/dev/` structure) |
| 4 | Upstream Merge Agent Skill | Req 1, 2, 3 |
| 5 | Execution Plans Organization | Req 2 (needs `docs/plans/` structure) |
| 6 | Quality Grading & Entropy Mgmt | Req 1, 2, 5 |
| 7 | Agent Review Loop | Req 3, 4, 6 |
