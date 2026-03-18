# Agent Orchestration: Playwright-Native Implementation Pipeline

**Goal:** Run one command, have all five phases execute automatically and sequentially, with phases 2 and 3 running in parallel, without human check-ins between steps.

---

## How It Works

Claude Code runs headlessly via `claude -p "prompt"`. Each invocation is a full agent session — reads files, writes code, runs commands, opens a PR — then exits. A shell script chains them with `&&` so each phase only starts if the previous passed all acceptance criteria.

```
claude -p "phase 1" → PR merged → claude -p "phase 2" (background)
                                   claude -p "phase 3" (background)  → both merged → claude -p "phase 4" → claude -p "phase 5"
```

The agents don't communicate with each other. Each one reads the shared ground-truth documents (`PLAYWRIGHT_NATIVE_PLAN.md`, `TESTING_GUIDE.md`) and the GitHub issue, does the work, verifies acceptance criteria, and opens a PR. The shell script handles sequencing.

---

## Three Approaches

### Approach 1 — Shell script (recommended, works today)

One script, one `bash` command. Each phase is a `claude -p` call. The verification commands are the gate — if they fail, the agent keeps iterating until they pass or gives up and exits non-zero, stopping the chain.

### Approach 2 — Single orchestrator prompt

One `claude -p` call with a prompt that tells Claude to work through all phases sequentially, spawning sub-agents via the Agent tool. More "agentic" but gives you less visibility into each phase's output.

### Approach 3 — Custom agents in `.claude/agents/`

Define each phase as a reusable agent YAML file. An orchestrator agent invokes them by name. Best for repeated runs, most setup upfront.

**Recommendation: Approach 1 for this project.** It's transparent, easy to debug, and the phases are a one-time pipeline, not something you'll run repeatedly.

---

## Approach 1: The Shell Script

### Setup

Install Claude Code globally if not already:
```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

Confirm headless mode works:
```bash
claude -p "print the word READY" --output-format text
# Expected: READY
```

### The orchestration script

Save as `.github/run-pipeline.sh`:

```bash
#!/usr/bin/env bash
# Playwright-native implementation pipeline.
# Runs all 5 phases sequentially (phases 2+3 in parallel).
# Each phase opens a PR; this script merges it before continuing.
#
# Usage: bash .github/run-pipeline.sh
# Prereqs:
#   - claude CLI installed and authenticated
#   - gh CLI authenticated (kingfly55)
#   - OPENAI_API_KEY set in .env (Phase 5 only)
#   - camoufox server running (Phase 5 only)
#   - On branch native-base, clean working tree

set -euo pipefail
REPO="kingfly55/stagehand"

# ── Helper: wait for a PR to exist, then merge it ────────────────────────────
merge_pr_for_branch() {
  local branch="$1"
  echo "  Waiting for PR on $branch..."
  for i in $(seq 1 30); do
    PR=$(gh pr list --repo "$REPO" --head "$branch" --json number --jq '.[0].number' 2>/dev/null)
    if [ -n "$PR" ] && [ "$PR" != "null" ]; then
      echo "  Merging PR #$PR ($branch)..."
      gh pr merge "$PR" --repo "$REPO" --squash --auto 2>/dev/null || \
      gh pr merge "$PR" --repo "$REPO" --squash
      git checkout native-base && git pull origin native-base
      return 0
    fi
    sleep 10
  done
  echo "ERROR: No PR found for $branch after 5 minutes" >&2
  return 1
}

# ── Phase 1 ───────────────────────────────────────────────────────────────────
echo "=== PHASE 1: Interface extraction ==="
git checkout native-base && git pull origin native-base

claude -p "$(cat <<'PROMPT'
You are working on the kingfly55/stagehand fork.

STEP 1: Read CLAUDE.md in the repo root. Follow all constraints listed there.
STEP 2: Read the full issue:
  gh issue view 1 --repo kingfly55/stagehand
STEP 3: Read PLAYWRIGHT_NATIVE_PLAN.md §6 and §7.3 only (not the whole file).
STEP 4: Create branch phase/1-interface off native-base and do the work.
STEP 5: Verify acceptance criteria:
  - pnpm typecheck must exit 0
  - pnpm build:esm && pnpm test:core must show 534 passed
  - git diff --name-only must list only the 6 expected files
STEP 6: If all pass, open a PR to native-base:
  gh pr create --repo kingfly55/stagehand --base native-base \
    --title "Phase 1: IStagehandPage interface" \
    --body "Closes #1"
STEP 7: Output the PR URL and exit.
PROMPT
)" --output-format text

merge_pr_for_branch "phase/1-interface"
echo "=== PHASE 1 COMPLETE ==="

# ── Phases 2 + 3 in parallel (worktrees) ─────────────────────────────────────
echo "=== PHASES 2+3: Snapshot + Actions (parallel) ==="
git checkout native-base && git pull origin native-base

# Phase 2 in background
claude -p "$(cat <<'PROMPT'
You are working on the kingfly55/stagehand fork.

STEP 1: Read CLAUDE.md in the repo root. Follow all constraints listed there.
STEP 2: Read the full issue:
  gh issue view 2 --repo kingfly55/stagehand
STEP 3: Read PLAYWRIGHT_NATIVE_PLAN.md §8 only (all three subsections).
         Read TESTING_GUIDE.md §4.1 and §5 Phase 2 section only.
STEP 4: Create branch phase/2-snapshot off native-base and do the work.
STEP 5: Verify acceptance criteria listed in the issue.
STEP 6: Open a PR:
  gh pr create --repo kingfly55/stagehand --base native-base \
    --title "Phase 2: Native snapshot capture" \
    --body "Closes #2"
STEP 7: Output the PR URL and exit.
PROMPT
)" --output-format text &
PID2=$!

# Phase 3 in background
claude -p "$(cat <<'PROMPT'
You are working on the kingfly55/stagehand fork.

STEP 1: Read CLAUDE.md in the repo root. Follow all constraints listed there.
STEP 2: Read the full issue:
  gh issue view 3 --repo kingfly55/stagehand
STEP 3: Read PLAYWRIGHT_NATIVE_PLAN.md §9 only (the full dispatch table).
         Read TESTING_GUIDE.md §4.2, §4.3, and §5 Phase 3 section only.
STEP 4: Create branch phase/3-actions off native-base and do the work.
STEP 5: Verify acceptance criteria listed in the issue.
STEP 6: Open a PR:
  gh pr create --repo kingfly55/stagehand --base native-base \
    --title "Phase 3: Native action dispatch" \
    --body "Closes #3"
STEP 7: Output the PR URL and exit.
PROMPT
)" --output-format text &
PID3=$!

# Wait for both
wait $PID2 || { echo "ERROR: Phase 2 agent failed" >&2; exit 1; }
wait $PID3 || { echo "ERROR: Phase 3 agent failed" >&2; exit 1; }

merge_pr_for_branch "phase/2-snapshot"
merge_pr_for_branch "phase/3-actions"
echo "=== PHASES 2+3 COMPLETE ==="

# ── Phase 4 ───────────────────────────────────────────────────────────────────
echo "=== PHASE 4: Context integration ==="
git checkout native-base && git pull origin native-base

claude -p "$(cat <<'PROMPT'
You are working on the kingfly55/stagehand fork.

STEP 1: Read CLAUDE.md in the repo root. Follow all constraints listed there.
STEP 2: Read the full issue:
  gh issue view 4 --repo kingfly55/stagehand
STEP 3: Read PLAYWRIGHT_NATIVE_PLAN.md §5, §10, §11 only.
         Read TESTING_GUIDE.md §5 Phase 4 section only.
STEP 4: Read the files already created in packages/core/lib/v3/understudy/native/
         to understand the interfaces you are wiring together.
STEP 5: Create branch phase/4-context off native-base and do the work.
STEP 6: Verify acceptance criteria listed in the issue.
STEP 7: Open a PR:
  gh pr create --repo kingfly55/stagehand --base native-base \
    --title "Phase 4: PlaywrightNativeContext wiring" \
    --body "Closes #4"
STEP 8: Output the PR URL and exit.
PROMPT
)" --output-format text

merge_pr_for_branch "phase/4-context"
echo "=== PHASE 4 COMPLETE ==="

# ── Phase 5 ───────────────────────────────────────────────────────────────────
echo "=== PHASE 5: Camoufox E2E ==="
echo "NOTE: Requires camoufox server running and OPENAI_API_KEY in .env"
git checkout native-base && git pull origin native-base
source .env 2>/dev/null || true

claude -p "$(cat <<'PROMPT'
You are working on the kingfly55/stagehand fork.

STEP 1: Read CLAUDE.md in the repo root. Follow all constraints listed there.
STEP 2: Read the full issue:
  gh issue view 5 --repo kingfly55/stagehand
STEP 3: Read TESTING_GUIDE.md §5 Phase 5 section only (pre-flight checklist,
         gap-fixing loop table, expected output).
         Read PLAYWRIGHT_NATIVE_PLAN.md §12 only (known Firefox limitations).
STEP 4: Run the camoufox probe to see current state:
  cd packages/core && pnpm example v3/camoufox_test
STEP 5: Create branch phase/5-camoufox off native-base.
         Update camoufox_test.ts Stage 3 to use browserContext option (see issue).
STEP 6: Run the probe again. Fix any gaps in understudy/native/ per the
         gap-fixing loop table. Repeat until Stage 3 PASS.
STEP 7: Run full regression check (all acceptance criteria in issue).
STEP 8: Open a PR:
  gh pr create --repo kingfly55/stagehand --base native-base \
    --title "Phase 5: Camoufox E2E working" \
    --body "Closes #5"
STEP 9: Output the PR URL and exit.
PROMPT
)" --output-format text

merge_pr_for_branch "phase/5-camoufox"
echo ""
echo "=== ALL PHASES COMPLETE ==="
echo "All 5 issues closed. native-base is ready."
gh issue list --repo kingfly55/stagehand --label native-mode --state all
```

### Run it

```bash
chmod +x .github/run-pipeline.sh
bash .github/run-pipeline.sh
```

Leave it running. Come back when it finishes or fails.

---

## Approach 2: Single Orchestrator Prompt

If you want Claude itself (not bash) to handle the sequencing, you can run one prompt and let Claude's Agent tool spawn sub-agents for each phase. This requires less script infrastructure but gives you less control over failure handling.

```bash
claude -p "$(cat <<'PROMPT'
You are orchestrating the Playwright-native implementation pipeline for kingfly55/stagehand.

Read CLAUDE.md first. Then execute these phases in order:

PHASE 1 (required first):
  Spawn an agent to work on issue #1 (gh issue view 1 --repo kingfly55/stagehand).
  The agent must open a PR and confirm pnpm typecheck exits 0 and 534 tests pass.
  Wait for the PR, merge it, pull native-base. Only then proceed.

PHASES 2 and 3 (parallel, after phase 1):
  Spawn two agents simultaneously using isolation:worktree:
  - Agent A: issue #2 (snapshot implementation)
  - Agent B: issue #3 (action dispatch)
  Both must open PRs and pass acceptance criteria.
  Wait for both, merge both, pull native-base.

PHASE 4 (after 2 and 3):
  Spawn an agent for issue #4 (context wiring).
  Must open a PR and pass all acceptance criteria.
  Merge and pull.

PHASE 5 (last):
  Spawn an agent for issue #5 (camoufox E2E).
  Requires camoufox server running and OPENAI_API_KEY in environment.
  Agent iterates on gap-fixing loop until Stage 3 PASS.
  Merge final PR.

At the end, run: gh issue list --repo kingfly55/stagehand --label native-mode --state all
All 5 issues should show as closed.
PROMPT
)" --output-format stream-json
```

---

## Approach 3: Reusable Custom Agents

For running the pipeline multiple times (e.g. after a rebase), define each phase as a persistent custom agent. Claude Code loads `.claude/agents/*.md` automatically.

Create `.claude/agents/phase-runner.md`:

```markdown
---
name: phase-runner
description: Runs a single phase of the Playwright-native implementation. Use when asked to implement a phase.
tools: Read, Write, Edit, Bash, Glob, Grep, Agent
model: opus
isolation: worktree
---

You implement one phase of the Playwright-native Stagehand feature.

Always start by:
1. Reading CLAUDE.md for constraints and verification commands
2. Reading the specified GitHub issue with: gh issue view N --repo kingfly55/stagehand
3. Reading only the sections of PLAYWRIGHT_NATIVE_PLAN.md and TESTING_GUIDE.md
   referenced in the issue

Run all acceptance criteria commands before opening a PR. Do not open a PR unless
all pass. If a command fails, fix the issue and re-run — do not give up after one failure.
```

Then invoke phases with:

```bash
claude -p "Use the phase-runner agent to implement phase 1 (issue #1),
           then phase 2 and 3 in parallel, then phase 4, then phase 5.
           Merge each PR before starting the next phase."
```

---

## Failure Handling

### If an agent opens a bad PR (wrong files, failing tests)

```bash
# Find and close the PR
gh pr list --repo kingfly55/stagehand --head phase/1-interface
gh pr close <number> --repo kingfly55/stagehand --delete-branch

# Re-run just that phase by extracting the relevant section of the script
```

### If the parallel step (2+3) has a merge conflict

Conflicts between phases 2 and 3 should be impossible — they touch entirely different files. If it happens, it means one agent modified a file it shouldn't have (violating the constraints in CLAUDE.md). Close that PR, investigate, re-run the phase.

### Stopping the pipeline mid-run

`Ctrl+C` kills the bash script. Any background `claude` processes (`&`) continue running. Kill them:

```bash
pkill -f "claude -p"
```

PRs already opened will remain open. Merge or close manually as appropriate.

---

## Key Flags Reference

```bash
# Run headlessly, get plain text back
claude -p "your prompt" --output-format text

# Run headlessly, get structured JSON (includes session_id, cost, etc.)
claude -p "your prompt" --output-format json

# Stream JSON tokens in real-time (good for long-running phases)
claude -p "your prompt" --output-format stream-json

# Resume a previous session (pass results forward without re-reading everything)
claude -p "continue" --resume <session-id>

# Restrict what tools the agent can use
claude -p "your prompt" --allowedTools "Read,Write,Edit,Bash,Glob,Grep"
```

---

## What Each Agent Actually Does

Each phase agent follows this loop autonomously:

```
Read CLAUDE.md (constraints + verification commands)
    ↓
Read GitHub issue (exact files, acceptance criteria)
    ↓
Read referenced plan sections (not the whole doc)
    ↓
git checkout -b phase/N-name origin/native-base
    ↓
Implement (write files, modify files per issue spec)
    ↓
pnpm typecheck → if fails, fix and retry
pnpm build:esm && pnpm test:core → if fails, fix and retry
[phase-specific commands] → if fails, fix and retry
    ↓
All pass → gh pr create
    ↓
Exit 0
```

If any verification command keeps failing after reasonable attempts, the agent exits non-zero. The shell script's `set -e` stops the pipeline. You investigate the PR or the agent output, fix the issue, and re-run from that phase.

---

## Recommended First Run

Run phases 1–4 first without phase 5, since phase 5 requires an active camoufox server:

```bash
# Edit run-pipeline.sh: comment out the Phase 5 block
bash .github/run-pipeline.sh

# Then, with camoufox running and OPENAI_API_KEY set:
source .env
claude -p "$(cat .github/phase5-prompt.txt)" --output-format stream-json
```

This way phases 1–4 can run completely unattended, and you supervise phase 5 (which has the interactive gap-fixing loop and external dependency on camoufox).
