#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Playwright-native implementation pipeline v2 — fully unattended.
#
# USAGE
#   bash .github/run-pipeline-v2.sh [options]
#
# OPTIONS
#   --from N          start at phase N (default: 5)
#   --to   N          stop after phase N  (default: 8)
#   --only N          run exactly one phase
#   --skip-adversarial  skip adversarial analysis (use raw issue body as brief)
#   --retry           retry a failed implementation agent once before stopping
#
# PHASES
#   5  Camoufox E2E — wire camoufox_test.ts Stage 3, fix Firefox gaps
#   6  DOM walker quality — label-for, aria-hidden, state attrs, DOM settle
#   7  Playwright ARIA engine — replace DOM walker with snapshotForAI
#   8  Closed shadow DOM — attachShadow interceptor, opt-in
#
# PREREQUISITES
#   - claude CLI:  npm install -g @anthropic-ai/claude-code
#   - gh CLI:      gh auth status must show kingfly55
#   - Clean state: on native-base with no uncommitted changes
#   - Phases 6-8:  no external deps
#   - Phase 5 only: .env with LLM key, camoufox server running
#
# RECOVERY
#   If a phase fails, re-run with --from N (N = failed phase).
#   Recovery tags: phase-5-complete … phase-8-complete
#
# EXAMPLES
#   bash .github/run-pipeline-v2.sh --from 6 --to 8   # phases 6,7,8
#   bash .github/run-pipeline-v2.sh --only 6           # only phase 6
#   bash .github/run-pipeline-v2.sh --from 5           # all remaining
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

REPO="kingfly55/stagehand"
CLAUDE="claude --dangerously-skip-permissions"
OPUS="$CLAUDE --model claude-opus-4-6"
LOG_DIR=".pipeline-logs"
mkdir -p "$LOG_DIR"

# ── Defaults ──────────────────────────────────────────────────────────────────
FROM_PHASE=5
TO_PHASE=8
ONLY_PHASE=""
SKIP_ADVERSARIAL=false
RETRY=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --from)  FROM_PHASE="$2"; shift 2 ;;
    --to)    TO_PHASE="$2"; shift 2 ;;
    --only)  ONLY_PHASE="$2"; shift 2 ;;
    --skip-adversarial) SKIP_ADVERSARIAL=true; shift ;;
    --retry) RETRY=true; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

should_run() {
  local phase="$1"
  if [[ -n "$ONLY_PHASE" ]]; then
    [[ "$ONLY_PHASE" == "$phase" ]] && return 0 || return 1
  fi
  [[ "$phase" -ge "$FROM_PHASE" && "$phase" -le "$TO_PHASE" ]]
}

# ── Logging ───────────────────────────────────────────────────────────────────

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
step() { echo ""; echo "[$(date '+%H:%M:%S')] ── $* ──"; }
ok()   { echo "[$(date '+%H:%M:%S')] ✓ $*"; }
fail() { echo "[$(date '+%H:%M:%S')] ✗ $*" >&2; }

# ── Pre-flight checks ─────────────────────────────────────────────────────────

preflight() {
  step "Pre-flight checks"

  # Git state
  local branch
  branch=$(git branch --show-current)
  if [[ "$branch" != "native-base" ]]; then
    fail "Must be on native-base (currently on '$branch')"
    exit 1
  fi
  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail "Working tree is dirty — commit or stash changes first"
    exit 1
  fi

  # Tools
  command -v claude >/dev/null || { fail "claude CLI not found"; exit 1; }
  command -v gh     >/dev/null || { fail "gh CLI not found"; exit 1; }
  command -v pnpm   >/dev/null || { fail "pnpm not found"; exit 1; }

  # gh auth
  if ! gh auth status 2>&1 | grep -q "kingfly55"; then
    fail "gh CLI not authenticated as kingfly55"
    exit 1
  fi

  ok "All pre-flight checks passed"
}

# ── Phase prerequisite tag check ──────────────────────────────────────────────
# Call before starting a phase that depends on a prior one being done.

require_tag() {
  local tag="$1"
  if ! git tag | grep -q "^${tag}$"; then
    fail "Required recovery tag '$tag' not found. Run the preceding phase first."
    exit 1
  fi
  ok "Prerequisite tag $tag confirmed"
}

# ── Environment check per phase ───────────────────────────────────────────────

check_phase_env() {
  local phase="$1"
  case "$phase" in
    5)
      # Need LLM key + camoufox WS URL
      if [[ -f .env ]]; then source .env 2>/dev/null || true; fi
      local llm_key="${OPENROUTER_API_KEY:-${OPENAI_API_KEY:-}}"
      if [[ -z "$llm_key" ]]; then
        fail "Phase 5 requires an LLM API key."
        fail "Set OPENROUTER_API_KEY or OPENAI_API_KEY in .env (repo root)."
        exit 1
      fi
      if [[ -z "${CAMOUFOX_WS:-}" ]]; then
        fail "Phase 5 requires CAMOUFOX_WS in .env (repo root)."
        fail "Start camoufox, copy the WebSocket URL it prints, then add:"
        fail "  CAMOUFOX_WS=ws://localhost:<port>/<token>"
        exit 1
      fi
      log "  Camoufox WS: $CAMOUFOX_WS"
      log "  LLM key:     ${llm_key:0:8}…"
      ;;
    6|7|8)
      # No external deps needed
      ;;
  esac
}

# ── Adversarial analysis ──────────────────────────────────────────────────────

adversarial_analysis() {
  local phase_num="$1"
  local issue_body="$2"
  local plan_sections="$3"

  if [[ "$SKIP_ADVERSARIAL" == "true" ]]; then
    log "  [Adversarial] SKIPPED (--skip-adversarial flag set)"
    echo "$issue_body"$'\n'"$plan_sections"
    return
  fi

  step "Phase $phase_num adversarial analysis"
  log "  Round 1 — opus, fresh context, max reasoning..."
  ROUND1=$(${OPUS} -p "$(cat <<PROMPT
You are a senior TypeScript engineer performing adversarial analysis of a
software implementation plan. Think with maximum depth and exhaustiveness —
consider every edge case, assumption, and failure mode before responding.

## The Plan (Phase $phase_num)

### GitHub Issue
$issue_body

### Relevant Design Context
$plan_sections

## Your Task
Identify everything that could go wrong, is underspecified, or will cause the
implementation to fail or produce incorrect output. Be specific and concrete.

Focus on:
1. TypeScript type errors or interface mismatches that will surface at compile time
2. Assumptions about the codebase structure that may be wrong
3. Acceptance criteria that would pass even if the implementation is wrong
4. Edge cases not covered (empty pages, frames that fail to evaluate, null nodes)
5. Integration hazards — ways this phase breaks a subsequent phase
6. Anything the implementation agent will misinterpret or skip

Format: numbered list, each item ≤3 sentences, concrete and actionable.
PROMPT
)" --output-format text 2>"$LOG_DIR/phase${phase_num}-adversarial-round1.log")

  log "  Round 1 complete. Synthesizing improvements..."
  IMPROVED=$(${CLAUDE} -p "$(cat <<PROMPT
You are improving a software implementation plan based on adversarial review findings.

## Original Plan
$issue_body

$plan_sections

## Adversarial Findings (Round 1)
$ROUND1

## Task
Produce an improved implementation plan that addresses each finding.
Format as a concrete addendum: for each finding, one clear instruction the
implementation agent should follow. Keep it concise — no restating of the original.
PROMPT
)" --output-format text 2>"$LOG_DIR/phase${phase_num}-synthesis-round1.log")

  log "  Round 2 — opus, fresh context, reviews improved plan..."
  ROUND2=$(${OPUS} -p "$(cat <<PROMPT
You are a senior TypeScript engineer performing second-pass adversarial review.
A first review was already done and improvements incorporated. Find what it missed.

## Original Plan (Phase $phase_num)
$issue_body

$plan_sections

## Round 1 Improvements Already Incorporated
$IMPROVED

## Task
Given these improvements, what STILL could go wrong? What did Round 1 miss?
What new failure modes did the Round 1 improvements introduce?

Focus on:
1. Conflicts between Round 1 improvements and existing codebase constraints
2. Test coverage gaps Round 1 did not address
3. Implicit ordering or state dependencies not captured
4. Things that only fail at integration time but originate here
5. Acceptance criteria that are still not deterministic (agent could game them)

Format: numbered list, each item ≤3 sentences, concrete and actionable.
PROMPT
)" --output-format text 2>"$LOG_DIR/phase${phase_num}-adversarial-round2.log")

  log "  Round 2 complete. Producing hardened brief..."
  FINAL=$(${CLAUDE} -p "$(cat <<PROMPT
Produce a final implementation brief combining the original plan with two rounds
of adversarial review. This brief will be the ONLY instruction the coding agent
sees — it must be complete and self-contained.

## Original Plan
$issue_body

$plan_sections

## Round 1 Findings
$ROUND1

## Round 1 Improvements
$IMPROVED

## Round 2 Findings
$ROUND2

## Output format
1. Files to create/modify (names only, no prose)
2. Implementation instructions (specific, step-by-step)
3. Acceptance criteria (copy from original issue — do NOT modify these)
4. Do-not warnings: the top 3 most likely failure modes identified by both rounds,
   each as a clear "DO NOT" instruction.
PROMPT
)" --output-format text 2>"$LOG_DIR/phase${phase_num}-final-brief.log")

  echo "$FINAL"
}

# ── Verification pass ─────────────────────────────────────────────────────────
# A separate agent whose ONLY job is to run acceptance criteria and report
# deterministic PASS/FAIL. Opens the PR only if it reports PASS.

verification_pass() {
  local phase_num="$1"
  local issue_num="$2"
  local branch="$3"
  local extra_cmds="$4"

  step "Phase $phase_num verification pass"
  log "  Running independent verification agent..."

  local result
  result=$(${CLAUDE} -p "$(cat <<PROMPT
You are a strict verification agent. Your ONLY job is to run the acceptance
criteria for Phase $phase_num and report a clear verdict. Do NOT fix code.
Do NOT open PRs. Do NOT create branches.

## Setup
git fetch origin
git checkout $branch
cd packages/core

## Acceptance criteria to verify (run each command, report exit code and output)
$extra_cmds

## After running all commands above, output EXACTLY one of these two lines:
VERIFICATION_PASS
VERIFICATION_FAIL: <brief reason>

If any command exits non-zero, output VERIFICATION_FAIL.
Output nothing else after the verdict line.
PROMPT
)" --output-format text 2>"$LOG_DIR/phase${phase_num}-verification.log")

  if echo "$result" | grep -q "^VERIFICATION_PASS$"; then
    ok "Verification PASSED for phase $phase_num"
    return 0
  else
    local reason
    reason=$(echo "$result" | grep "^VERIFICATION_FAIL:" | head -1)
    fail "Verification FAILED: $reason"
    fail "See $LOG_DIR/phase${phase_num}-verification.log for details"
    return 1
  fi
}

# ── PR open + merge + tag ─────────────────────────────────────────────────────

open_pr_and_merge() {
  local branch="$1"
  local tag="$2"
  local issue_num="$3"
  local phase_num="$4"
  local test_summary="$5"

  step "Phase $phase_num — open PR and merge"

  # Open the PR
  local issue_title
  issue_title=$(gh issue view "$issue_num" --repo "$REPO" --json title --jq '.title')

  local pr_url
  pr_url=$(gh pr create --repo "$REPO" --base native-base \
    --head "$branch" \
    --title "Phase $phase_num: $issue_title" \
    --body "$(cat <<BODY
Closes #$issue_num

## Verification
All acceptance criteria verified by dedicated verification agent.

## Test results
$test_summary

## Adversarial review
Two-round opus adversarial analysis incorporated. Hardened brief at:
\`.pipeline-logs/phase${phase_num}-hardened-brief.md\`
BODY
)" 2>/dev/null)

  log "  PR opened: $pr_url"

  # Wait for PR and merge
  local pr_num
  pr_num=$(gh pr list --repo "$REPO" --head "$branch" --json number --jq '.[0].number' 2>/dev/null)
  for i in $(seq 1 30); do
    if [[ -n "$pr_num" && "$pr_num" != "null" ]]; then break; fi
    sleep 5
    pr_num=$(gh pr list --repo "$REPO" --head "$branch" --json number --jq '.[0].number' 2>/dev/null || true)
  done

  if [[ -z "$pr_num" || "$pr_num" == "null" ]]; then
    fail "Could not find PR for $branch"
    return 1
  fi

  gh pr merge "$pr_num" --repo "$REPO" --squash --delete-branch 2>/dev/null || \
  gh pr merge "$pr_num" --repo "$REPO" --squash

  # Pull merged changes and tag
  git checkout native-base
  git pull origin native-base
  git tag "$tag"
  git push origin "$tag"

  # Close the issue
  gh issue close "$issue_num" --repo "$REPO" \
    --comment "Completed in PR #${pr_num}. Recovery tag: ${tag}." 2>/dev/null || true

  ok "Recovery checkpoint: $tag"
}

# ── Implementation agent ──────────────────────────────────────────────────────

run_implementation() {
  local phase_num="$1"
  local branch="$2"
  local issue_num="$3"
  local hardened_brief="$4"
  local verify_cmds="$5"

  step "Phase $phase_num implementation"
  git checkout native-base
  git pull origin native-base

  local impl_prompt
  impl_prompt="$(cat <<PROMPT
You are implementing Phase $phase_num of the Playwright-native Stagehand feature.

## Mandatory first steps (in order)
1. Read CLAUDE.md in the repo root — follow ALL constraints listed there
2. Read the GitHub issue: gh issue view $issue_num --repo $REPO
3. Create and switch to the implementation branch:
   git checkout native-base && git pull origin native-base
   git checkout -b $branch

## Hardened implementation brief
The following incorporates the original plan plus 2 rounds of adversarial review.
Where it conflicts with the original issue, THIS BRIEF takes precedence.

$hardened_brief

## Implementation rules
- Read files before editing them
- Run pnpm typecheck after every significant change to catch errors early
- Only modify files listed in the brief — no bonus refactoring
- When a test fails, fix the code (not the test) unless the test is clearly wrong

## Verification commands to run before declaring done
$verify_cmds

## Completion — only do this when ALL verification commands pass
Push the branch and report results:
  git push origin $branch
  echo "IMPL_COMPLETE branch=$branch"
PROMPT
)"

  local result
  if result=$(${CLAUDE} -p "$impl_prompt" --output-format text 2>&1 | tee "$LOG_DIR/phase${phase_num}-implementation.log"); then
    if echo "$result" | grep -q "IMPL_COMPLETE"; then
      ok "Implementation complete for phase $phase_num"
      return 0
    fi
  fi

  # If we reach here, agent did not output IMPL_COMPLETE — treat as failure
  return 1
}

# ── Full phase runner ─────────────────────────────────────────────────────────

run_phase() {
  local phase_num="$1"
  local branch="$2"
  local tag="$3"
  local issue_num="$4"
  local plan_sections="$5"
  local verify_cmds="$6"

  step "═══ PHASE $phase_num START ═══"
  check_phase_env "$phase_num"

  # Fetch issue body for analysis context
  local issue_body
  issue_body=$(gh issue view "$issue_num" --repo "$REPO" --json body --jq '.body')

  # Adversarial analysis
  local hardened_brief
  hardened_brief=$(adversarial_analysis "$phase_num" "$issue_body" "$plan_sections")
  echo "$hardened_brief" > "$LOG_DIR/phase${phase_num}-hardened-brief.md"
  log "  Hardened brief saved: $LOG_DIR/phase${phase_num}-hardened-brief.md"

  # Implementation (with optional retry)
  local impl_ok=false
  if run_implementation "$phase_num" "$branch" "$issue_num" "$hardened_brief" "$verify_cmds"; then
    impl_ok=true
  elif [[ "$RETRY" == "true" ]]; then
    log "  Implementation failed. Retrying once (--retry flag set)..."
    # Clean up the branch and try again
    git checkout native-base
    git push origin --delete "$branch" 2>/dev/null || true
    if run_implementation "$phase_num" "$branch" "$issue_num" "$hardened_brief" "$verify_cmds"; then
      impl_ok=true
    fi
  fi

  if [[ "$impl_ok" != "true" ]]; then
    fail "Phase $phase_num implementation failed. Check $LOG_DIR/phase${phase_num}-implementation.log"
    fail "To resume: bash .github/run-pipeline-v2.sh --from $phase_num --to $TO_PHASE"
    exit 1
  fi

  # Independent verification pass
  if ! verification_pass "$phase_num" "$issue_num" "$branch" "$verify_cmds"; then
    fail "Phase $phase_num failed verification. Branch '$branch' preserved for inspection."
    fail "Fix the issue manually, push to $branch, then re-run: --from $phase_num --only $phase_num"
    exit 1
  fi

  # Extract test summary from implementation log
  local test_summary
  test_summary=$(grep -E "passed|failed|Tests" "$LOG_DIR/phase${phase_num}-implementation.log" | tail -5 || echo "See implementation log")

  # Open PR and create recovery tag
  open_pr_and_merge "$branch" "$tag" "$issue_num" "$phase_num" "$test_summary"

  log "═══ PHASE $phase_num COMPLETE (tag: $tag) ═══"
}

# ═════════════════════════════════════════════════════════════════════════════
# PHASE DEFINITIONS
# Each phase specifies: branch, tag, issue#, plan context, verify commands
# ═════════════════════════════════════════════════════════════════════════════

preflight

# ── Phase 5 ───────────────────────────────────────────────────────────────────
if should_run 5; then
  if [[ -f .env ]]; then source .env 2>/dev/null || true; fi

  PHASE5_VERIFY=$(cat <<'VERIFY'
cd /home/joenathan/stagehand/packages/core
pnpm typecheck
pnpm build:esm && pnpm test:core
pnpm build:esm && pnpm test:native
# Phase 5 specific: camoufox probe (Stage 3 must say PASS)
# Source .env and run in same shell invocation so CAMOUFOX_WS is available.
cd /home/joenathan/stagehand/packages/core
bash -c 'set -a; source /home/joenathan/stagehand/.env 2>/dev/null || true; set +a; pnpm example v3/camoufox_test' 2>&1 | tee /tmp/camoufox_result.txt
if grep -q "STAGE 3.*PASS\|Stage 3.*PASS" /tmp/camoufox_result.txt; then
  echo "CAMOUFOX_STAGE3_PASS"
else
  echo "CAMOUFOX_STAGE3_FAIL"
  cat /tmp/camoufox_result.txt
  exit 1
fi
VERIFY
)

  PHASE5_PLAN=$(cat <<'PLAN'
This phase connects the camoufox_test.ts Stage 3 to the native Playwright mode
built in phases 1-4. The native path (browserContext option) now exists in V3.
Stage 3 must call Stagehand with browserContext instead of the CDP stub.
If Stage 3 fails, consult TESTING_GUIDE.md §5.5.4 gap-fixing table.
Key files: packages/core/examples/v3/camoufox_test.ts (primary),
understudy/native/ (gap fixes only if Stage 3 errors require them).
LLM API key configuration: see OPENROUTER usage below.
PLAN
)

  run_phase 5 \
    "phase/5-camoufox" \
    "phase-5-complete" \
    "5" \
    "$PHASE5_PLAN" \
    "$PHASE5_VERIFY"
fi

# ── Phase 6 ───────────────────────────────────────────────────────────────────
if should_run 6; then
  require_tag "phase-4-complete"

  PHASE6_VERIFY=$(cat <<'VERIFY'
# All commands use absolute paths — each is self-contained for the verification agent.
CORE=/home/joenathan/stagehand/packages/core
bash -c "cd $CORE && pnpm typecheck"
bash -c "cd $CORE && pnpm build:esm && pnpm test:core"
bash -c "cd $CORE && pnpm build:esm && pnpm test:native"
# Verify aria-hidden exclusion (must rebuild first, then run node from packages/core)
bash -c "cd $CORE && pnpm build:esm && node -e \"
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  await p.setContent('<div aria-hidden=\\\"true\\\"><button>Hidden</button></div><button>Visible</button>');
  const { captureNativeSnapshot } = await import('./dist/esm/lib/v3/understudy/native/snapshot/captureNativeSnapshot.js');
  const snap = await captureNativeSnapshot(p, { pierceShadow: true, includeIframes: true, experimental: false });
  const tree = snap.combinedTree;
  if (tree.includes('Hidden')) { console.error('FAIL: aria-hidden content present'); process.exit(1); }
  if (!tree.includes('Visible')) { console.error('FAIL: visible button missing'); process.exit(1); }
  console.log('aria-hidden check: PASS');
  await b.close();
})();
\""
VERIFY
)

  PHASE6_PLAN="See SNAPSHOT_UPGRADE_RESEARCH.md Part 3 Methods C and E for full design rationale.
Fixes: label-for association, aria-hidden exclusion, state attributes, DOM settle, click fallback.
All changes inside two files only: nativeCombinedTree.ts and nativeActionDispatch.ts."

  run_phase 6 \
    "phase/6-walker-quality" \
    "phase-6-complete" \
    "10" \
    "$PHASE6_PLAN" \
    "$PHASE6_VERIFY"
fi

# ── Phase 7 ───────────────────────────────────────────────────────────────────
if should_run 7; then
  require_tag "phase-6-complete"

  PHASE7_VERIFY=$(cat <<'VERIFY'
CORE=/home/joenathan/stagehand/packages/core
bash -c "cd $CORE && pnpm typecheck"
bash -c "cd $CORE && pnpm build:esm && pnpm test:core"
bash -c "cd $CORE && pnpm build:esm && pnpm test:native"
# Smoke test: snapshot must have ≥5 recognizable entries
bash -c "cd $CORE && pnpm build:esm && pnpm example v3/native_snapshot_smoke 2>&1 | tee /tmp/smoke7.txt; ENTRY_COUNT=\$(grep -c 'role\|heading\|link\|button\|text' /tmp/smoke7.txt || echo 0); if [ \"\$ENTRY_COUNT\" -lt 5 ]; then echo 'FAIL: smoke test produced fewer than 5 entries'; cat /tmp/smoke7.txt; exit 1; fi; echo \"Smoke test entry count: \$ENTRY_COUNT — PASS\"; grep -E 'snapshotForAI|ariaSnapshot|fallback' /tmp/smoke7.txt || true"
# label-for regression check from phase 6
bash -c "cd $CORE && node -e \"
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  await p.setContent('<label for=\\\"e\\\">Email</label><input id=\\\"e\\\" type=\\\"email\\\">');
  const { captureNativeSnapshot } = await import('./dist/esm/lib/v3/understudy/native/snapshot/captureNativeSnapshot.js');
  const snap = await captureNativeSnapshot(p, { pierceShadow: true, includeIframes: true, experimental: false });
  if (!snap.combinedTree.includes('Email')) { console.error('FAIL: label-for regression'); process.exit(1); }
  console.log('label-for regression check: PASS');
  await b.close();
})();
\""
VERIFY
)

  PHASE7_PLAN="See SNAPSHOT_UPGRADE_RESEARCH.md Part 3 Method A and Part 5 for full design.
Primary: replace DOM walker with Playwright snapshotForAI() engine.
Key: ariaSnapshotCapture.ts new file, captureNativeSnapshot.ts updated,
nativeCombinedTree.ts kept as fallback. aria-ref locators in nativeLocatorUtils.ts.
XPath mapping: Promise.all over locator.evaluate(buildXPath) for each ref."

  run_phase 7 \
    "phase/7-aria-engine" \
    "phase-7-complete" \
    "11" \
    "$PHASE7_PLAN" \
    "$PHASE7_VERIFY"
fi

# ── Phase 8 ───────────────────────────────────────────────────────────────────
if should_run 8; then
  require_tag "phase-7-complete"

  PHASE8_VERIFY=$(cat <<'VERIFY'
CORE=/home/joenathan/stagehand/packages/core
bash -c "cd $CORE && pnpm typecheck"
bash -c "cd $CORE && pnpm build:esm && pnpm test:core"
bash -c "cd $CORE && pnpm build:esm && pnpm test:native"
# pierceShadow 'including-closed' must appear in compiled snapshot types
bash -c "grep -r 'including-closed' $CORE/dist/esm/lib/v3/types/private/snapshot.js && echo 'pierceShadow type check: PASS' || { echo 'FAIL: including-closed not in compiled output'; exit 1; }"
# closed shadow unit test must exist in test:core suite output
bash -c "cd $CORE && pnpm build:esm && pnpm test:core --reporter=verbose 2>&1 | grep -E 'closed.shadow|attachShadow' && echo 'closed shadow test: PASS' || { echo 'FAIL: no closed shadow unit test found'; exit 1; }"
VERIFY
)

  PHASE8_PLAN="See SNAPSHOT_UPGRADE_RESEARCH.md Part 3 Method D.
Add pierceShadow: 'including-closed' option. Install CLOSED_SHADOW_INTERCEPTOR
as init script only when that option is set. Walker reads window.__stagehandClosedRoot.
Default behaviour (pierceShadow: true) must be byte-for-byte unchanged."

  run_phase 8 \
    "phase/8-closed-shadow" \
    "phase-8-complete" \
    "12" \
    "$PHASE8_PLAN" \
    "$PHASE8_VERIFY"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
log "═══════════════════════════════════════════════════════"
log "ALL PHASES COMPLETE"
log "Recovery tags: phase-5-complete through phase-8-complete"
log "Logs in: $LOG_DIR/"
log "═══════════════════════════════════════════════════════"
gh issue list --repo "$REPO" --label native-mode --state all
