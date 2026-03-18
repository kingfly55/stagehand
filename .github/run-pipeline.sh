#!/usr/bin/env bash
# Playwright-native implementation pipeline — fully unattended.
#
# What this does:
#   1. Runs 2-round adversarial analysis (opus, max effort, fresh context each round)
#      before each phase, incorporating insights iteratively into the plan
#   2. Runs the implementation agent with the hardened plan
#   3. Creates a git tag recovery checkpoint after each successful phase merge
#   4. Phases 2+3 run in parallel; all others are sequential
#
# Usage:
#   bash .github/run-pipeline.sh              # all 5 phases
#   bash .github/run-pipeline.sh --from 3     # resume from phase 3
#   bash .github/run-pipeline.sh --only 1     # run just phase 1
#
# Prerequisites:
#   - claude CLI installed: npm install -g @anthropic-ai/claude-code
#   - gh CLI authenticated as kingfly55
#   - On branch native-base with clean working tree
#   - Phases 1-4: no extra deps
#   - Phase 5 only: OPENAI_API_KEY in .env, camoufox server running

set -euo pipefail

REPO="kingfly55/stagehand"
CLAUDE="claude --dangerously-skip-permissions"
OPUS="$CLAUDE --model claude-opus-4-6"
LOG_DIR=".pipeline-logs"
mkdir -p "$LOG_DIR"

# ── Arg parsing ───────────────────────────────────────────────────────────────
FROM_PHASE=1
ONLY_PHASE=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --from) FROM_PHASE="$2"; shift 2 ;;
    --only) ONLY_PHASE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

should_run() {
  local phase="$1"
  [[ -n "$ONLY_PHASE" ]] && [[ "$ONLY_PHASE" != "$phase" ]] && return 1
  [[ "$phase" -lt "$FROM_PHASE" ]] && return 1
  return 0
}

# ── Helpers ───────────────────────────────────────────────────────────────────

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Wait for a PR on branch, merge it, pull native-base, create recovery tag
merge_and_tag() {
  local branch="$1"
  local tag="$2"
  log "Waiting for PR on $branch..."
  for i in $(seq 1 60); do
    PR=$(gh pr list --repo "$REPO" --head "$branch" --json number --jq '.[0].number' 2>/dev/null || true)
    if [[ -n "$PR" && "$PR" != "null" ]]; then
      log "Merging PR #$PR ($branch)..."
      gh pr merge "$PR" --repo "$REPO" --squash --delete-branch 2>/dev/null || \
      gh pr merge "$PR" --repo "$REPO" --squash
      git checkout native-base
      git pull origin native-base
      git tag "$tag"
      git push origin "$tag"
      log "Recovery checkpoint created: $tag"
      return 0
    fi
    sleep 10
  done
  log "ERROR: No PR found for $branch after 10 minutes" >&2
  return 1
}

# ── Adversarial analysis ──────────────────────────────────────────────────────
#
# Two rounds, fresh context each time (separate claude -p calls).
# Round 1 analyzes the original plan.
# Its insights are incorporated → improved plan.
# Round 2 analyzes the improved plan.
# Final synthesis → returned as additional context for the implementation agent.
#
# Uses opus at max effort (prompted, not flagged — no headless --effort flag exists).

adversarial_analysis() {
  local phase_num="$1"
  local issue_body="$2"        # raw text of the GitHub issue
  local plan_sections="$3"     # relevant sections of PLAYWRIGHT_NATIVE_PLAN.md

  log "  [Adversarial] Round 1 — fresh context, opus, max effort..."

  ROUND1=$(${OPUS} -p "$(cat <<PROMPT
You are a senior TypeScript engineer performing adversarial analysis of a
software implementation plan. Think with maximum depth and exhaustiveness —
consider every edge case, assumption, and failure mode before responding.

## The Plan (Phase $phase_num)

### GitHub Issue
$issue_body

### Relevant Architecture Sections
$plan_sections

## Your Task
Identify everything that could go wrong, is underspecified, or will cause the
implementation to fail silently. Be specific and concrete — no generic advice.

Focus on:
1. TypeScript interface design flaws (missing methods, wrong signatures, leaky abstractions)
2. Assumptions in the plan that are likely false given the codebase structure
3. Test cases described that would pass even if the implementation is wrong
4. Edge cases the acceptance criteria do not cover
5. Integration hazards — ways this phase's output will break a later phase
6. Anything the implementation agent will misinterpret or skip

Format: numbered list, each item ≤3 sentences, concrete and actionable.
PROMPT
)" --output-format text 2>"$LOG_DIR/phase${phase_num}-adversarial-round1.log")

  log "  [Adversarial] Round 1 complete. Incorporating insights..."

  # Synthesis step: produce improved plan incorporating round 1 findings
  IMPROVED_PLAN=$(${CLAUDE} -p "$(cat <<PROMPT
You are improving a software implementation plan based on adversarial review findings.

## Original Plan
$issue_body

$plan_sections

## Adversarial Findings (Round 1)
$ROUND1

## Your Task
Produce an improved, concrete implementation plan that addresses each finding.
Do not restate the original plan verbatim — only include additions, corrections,
and clarifications. Format as a diff/addendum: for each finding, one clear
instruction the implementation agent should follow.
PROMPT
)" --output-format text 2>"$LOG_DIR/phase${phase_num}-synthesis-round1.log")

  log "  [Adversarial] Round 2 — fresh context, opus, max effort..."

  ROUND2=$(${OPUS} -p "$(cat <<PROMPT
You are a senior TypeScript engineer performing a second-pass adversarial review.
A first review was already done and improvements incorporated. Your job is to find
what the first review missed. Think exhaustively before responding.

## Original Plan (Phase $phase_num)
$issue_body

$plan_sections

## Improvements Already Incorporated (from Round 1 review)
$IMPROVED_PLAN

## Your Task
Given these improvements, what STILL could go wrong? What did Round 1 miss?
What new failure modes did the Round 1 improvements introduce?

Focus on:
1. Conflicts between the Round 1 improvements and the existing codebase constraints
2. Test coverage gaps that the Round 1 improvements did not address
3. Implicit dependencies or ordering assumptions not captured
4. Race conditions or state management issues in the native implementation
5. Anything that will only fail at Phase 5 (camoufox E2E) but originates here

Format: numbered list, each item ≤3 sentences, concrete and actionable.
PROMPT
)" --output-format text 2>"$LOG_DIR/phase${phase_num}-adversarial-round2.log")

  log "  [Adversarial] Round 2 complete. Producing final hardened plan..."

  # Final synthesis: combine both rounds into the implementation agent's brief
  FINAL_BRIEF=$(${CLAUDE} -p "$(cat <<PROMPT
You are producing a final implementation brief by combining an original plan with
two rounds of adversarial review insights.

## Original Plan
$issue_body

$plan_sections

## Round 1 Adversarial Findings
$ROUND1

## Round 1 Improvements
$IMPROVED_PLAN

## Round 2 Adversarial Findings
$ROUND2

## Your Task
Write a final, consolidated implementation brief for a coding agent.
It should be a complete, actionable set of instructions — not a summary
of the review process. Include:
- The original acceptance criteria (unchanged)
- All corrections and additions from both review rounds
- Explicit "do not" warnings for the top 3 most likely failure modes identified

Be specific about file names, method signatures, and verification commands.
PROMPT
)" --output-format text 2>"$LOG_DIR/phase${phase_num}-final-brief.log")

  echo "$FINAL_BRIEF"
}

# ── Phase runner ──────────────────────────────────────────────────────────────
# Runs adversarial analysis, then the implementation agent, using the hardened plan.

run_phase() {
  local phase_num="$1"
  local branch="$2"
  local tag="$3"
  local issue_num="$4"
  local plan_refs="$5"    # which sections of the plan to include
  local extra_steps="$6"  # any phase-specific steps beyond the standard template

  log "=== PHASE $phase_num START ==="

  # Fetch issue body for analysis
  ISSUE_BODY=$(gh issue view "$issue_num" --repo "$REPO" --json body --jq '.body')

  # Fetch relevant plan sections
  PLAN_SECTIONS=$(${CLAUDE} -p "$(cat <<PROMPT
Read PLAYWRIGHT_NATIVE_PLAN.md and extract only these sections: $plan_refs.
Output the raw section text, nothing else.
PROMPT
)" --output-format text 2>/dev/null)

  # Run adversarial analysis (2 rounds, iterative)
  log "  Running adversarial analysis..."
  HARDENED_BRIEF=$(adversarial_analysis "$phase_num" "$ISSUE_BODY" "$PLAN_SECTIONS")

  # Save the hardened brief for inspection
  echo "$HARDENED_BRIEF" > "$LOG_DIR/phase${phase_num}-hardened-brief.md"
  log "  Hardened brief saved to $LOG_DIR/phase${phase_num}-hardened-brief.md"

  # Ensure we're on native-base before creating the branch
  git checkout native-base
  git pull origin native-base

  # Run the implementation agent
  log "  Running implementation agent..."
  ${CLAUDE} -p "$(cat <<PROMPT
You are implementing Phase $phase_num of the Playwright-native Stagehand feature.

## Mandatory First Steps
1. Read CLAUDE.md in the repo root — follow ALL constraints listed there
2. Read the GitHub issue in full:
   gh issue view $issue_num --repo $REPO

## Hardened Implementation Brief
The following brief incorporates the original plan plus two rounds of adversarial
review. It supersedes the original issue where they conflict.

$HARDENED_BRIEF

## Branch Setup
git checkout native-base
git pull origin native-base
git checkout -b $branch

## Implementation
Do the work described in the hardened brief above.
Read only the specific files you need to modify — do not explore the whole codebase.

## Verification (run all, fix until they pass)
$extra_steps

## Completion
When all acceptance criteria pass:
gh pr create --repo $REPO --base native-base \\
  --title "Phase $phase_num: $(gh issue view $issue_num --repo $REPO --json title --jq '.title')" \\
  --body "Closes #$issue_num

Adversarial brief incorporated from 2-round review.
See .pipeline-logs/phase${phase_num}-hardened-brief.md"

Output the PR URL on the final line and exit.
PROMPT
)" --output-format text 2>&1 | tee "$LOG_DIR/phase${phase_num}-implementation.log"

  merge_and_tag "$branch" "$tag"
  log "=== PHASE $phase_num COMPLETE (tag: $tag) ==="
}

# ── Phase 1 ───────────────────────────────────────────────────────────────────
if should_run 1; then
  run_phase 1 \
    "phase/1-interface" \
    "phase-1-complete" \
    "1" \
    "§6 and §7.3" \
    "$(cat <<'VERIFY'
pnpm typecheck
pnpm build:esm && pnpm test:core
# Must show 534 passed, 40 files — same as baseline
# git diff --name-only must list only the 6 expected files
VERIFY
)"
fi

# ── Phases 2+3 (parallel) ─────────────────────────────────────────────────────
if should_run 2 || should_run 3; then
  git checkout native-base && git pull origin native-base

  # Fetch and analyze both issues upfront before parallel execution
  log "=== PHASES 2+3 START (parallel) ==="

  if should_run 2; then
    ISSUE2_BODY=$(gh issue view 2 --repo "$REPO" --json body --jq '.body')
    PLAN2=$(${CLAUDE} --dangerously-skip-permissions -p "Read PLAYWRIGHT_NATIVE_PLAN.md and extract §8 (all subsections). Output raw text only." --output-format text 2>/dev/null)
    log "  Phase 2: running adversarial analysis..."
    BRIEF2=$(adversarial_analysis 2 "$ISSUE2_BODY" "$PLAN2")
    echo "$BRIEF2" > "$LOG_DIR/phase2-hardened-brief.md"
  fi

  if should_run 3; then
    ISSUE3_BODY=$(gh issue view 3 --repo "$REPO" --json body --jq '.body')
    PLAN3=$(${CLAUDE} --dangerously-skip-permissions -p "Read PLAYWRIGHT_NATIVE_PLAN.md and extract §9. Output raw text only." --output-format text 2>/dev/null)
    log "  Phase 3: running adversarial analysis..."
    BRIEF3=$(adversarial_analysis 3 "$ISSUE3_BODY" "$PLAN3")
    echo "$BRIEF3" > "$LOG_DIR/phase3-hardened-brief.md"
  fi

  # Launch both implementation agents in parallel
  if should_run 2; then
    BRIEF2_CONTENT=$(cat "$LOG_DIR/phase2-hardened-brief.md")
    ${CLAUDE} -p "$(cat <<PROMPT
You are implementing Phase 2 of the Playwright-native Stagehand feature.

1. Read CLAUDE.md in the repo root.
2. Read issue #2: gh issue view 2 --repo $REPO

## Hardened Brief (2-round adversarial review incorporated)
$BRIEF2_CONTENT

## Branch
git checkout native-base && git pull origin native-base
git checkout -b phase/2-snapshot

## Verification
pnpm typecheck
pnpm build:esm && pnpm test:core  # count must be higher than 534
pnpm example v3/native_snapshot_smoke  # must print 5+ tree entries

## Completion
gh pr create --repo $REPO --base native-base \
  --title "Phase 2: Native snapshot capture" \
  --body "Closes #2"
Output the PR URL and exit.
PROMPT
)" --output-format text 2>&1 | tee "$LOG_DIR/phase2-implementation.log" &
    PID2=$!
  fi

  if should_run 3; then
    BRIEF3_CONTENT=$(cat "$LOG_DIR/phase3-hardened-brief.md")
    ${CLAUDE} -p "$(cat <<PROMPT
You are implementing Phase 3 of the Playwright-native Stagehand feature.

1. Read CLAUDE.md in the repo root.
2. Read issue #3: gh issue view 3 --repo $REPO

## Hardened Brief (2-round adversarial review incorporated)
$BRIEF3_CONTENT

## Branch
git checkout native-base && git pull origin native-base
git checkout -b phase/3-actions

## Verification
pnpm typecheck
pnpm build:esm && pnpm test:core  # count must be higher than 534
pnpm build:esm && pnpm test:native  # all Chromium integration tests pass

## Completion
gh pr create --repo $REPO --base native-base \
  --title "Phase 3: Native action dispatch" \
  --body "Closes #3"
Output the PR URL and exit.
PROMPT
)" --output-format text 2>&1 | tee "$LOG_DIR/phase3-implementation.log" &
    PID3=$!
  fi

  # Wait for both, fail fast on error
  PARALLEL_FAILED=0
  [[ -n "${PID2:-}" ]] && { wait "$PID2" || { log "ERROR: Phase 2 agent failed"; PARALLEL_FAILED=1; }; }
  [[ -n "${PID3:-}" ]] && { wait "$PID3" || { log "ERROR: Phase 3 agent failed"; PARALLEL_FAILED=1; }; }
  [[ "$PARALLEL_FAILED" == "1" ]] && exit 1

  should_run 2 && merge_and_tag "phase/2-snapshot" "phase-2-complete"
  should_run 3 && merge_and_tag "phase/3-actions"  "phase-3-complete"
  log "=== PHASES 2+3 COMPLETE ==="
fi

# ── Phase 4 ───────────────────────────────────────────────────────────────────
if should_run 4; then
  run_phase 4 \
    "phase/4-context" \
    "phase-4-complete" \
    "4" \
    "§5, §10, §11" \
    "$(cat <<'VERIFY'
pnpm typecheck
pnpm build:esm && pnpm test:core   # no regressions
pnpm build:esm && pnpm test:native # passes
# Also verify CDP path still works:
# pnpm example v3/v3_example.ts (or any LOCAL example)
VERIFY
)"
fi

# ── Phase 5 ───────────────────────────────────────────────────────────────────
if should_run 5; then
  log "=== PHASE 5 START ==="
  log "  Requires: camoufox server running, OPENAI_API_KEY in .env"
  source .env 2>/dev/null || true

  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    log "ERROR: OPENAI_API_KEY not set. Source .env before running phase 5." >&2
    exit 1
  fi

  ISSUE5_BODY=$(gh issue view 5 --repo "$REPO" --json body --jq '.body')
  PLAN5=$(${CLAUDE} --dangerously-skip-permissions -p "Read PLAYWRIGHT_NATIVE_PLAN.md and extract §12. Output raw text only." --output-format text 2>/dev/null)

  log "  Running adversarial analysis for phase 5..."
  BRIEF5=$(adversarial_analysis 5 "$ISSUE5_BODY" "$PLAN5")
  echo "$BRIEF5" > "$LOG_DIR/phase5-hardened-brief.md"
  BRIEF5_CONTENT=$(cat "$LOG_DIR/phase5-hardened-brief.md")

  ${CLAUDE} -p "$(cat <<PROMPT
You are implementing Phase 5 of the Playwright-native Stagehand feature.

1. Read CLAUDE.md in the repo root.
2. Read issue #5: gh issue view 5 --repo $REPO
3. Read TESTING_GUIDE.md §5 Phase 5 section — pay close attention to the
   gap-fixing loop table and the expected output.

## Hardened Brief (2-round adversarial review incorporated)
$BRIEF5_CONTENT

## Branch
git checkout native-base && git pull origin native-base
git checkout -b phase/5-camoufox

## Core task
Update packages/core/examples/v3/camoufox_test.ts Stage 3 to use browserContext.
Run: cd packages/core && source ../../.env && pnpm example v3/camoufox_test

If Stage 3 fails, fix the specific error in understudy/native/ per the gap-fixing
table in TESTING_GUIDE.md §5.5.4. Re-run after each fix. Repeat until PASS.

## Final verification
pnpm typecheck
pnpm build:esm && pnpm test:core
pnpm build:esm && pnpm test:native
source ../../.env && pnpm example v3/camoufox_test  # Stage 3 must show PASS

## Completion
gh pr create --repo $REPO --base native-base \
  --title "Phase 5: Camoufox E2E working" \
  --body "Closes #5"
Output the PR URL and exit.
PROMPT
)" --output-format text 2>&1 | tee "$LOG_DIR/phase5-implementation.log"

  merge_and_tag "phase/5-camoufox" "phase-5-complete"
  log "=== PHASE 5 COMPLETE ==="
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
log "========================================="
log "ALL PHASES COMPLETE"
log "Recovery tags: phase-1-complete through phase-5-complete"
log "Logs in: $LOG_DIR/"
log "========================================="
gh issue list --repo "$REPO" --label native-mode --state all
