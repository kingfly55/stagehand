# Agent Orchestration: Playwright-Native Implementation Pipeline

**Goal:** Run one command. All five phases execute automatically — adversarial review, implementation, verification, git checkpoint — without human check-ins.

---

## What Happens Per Phase

Each phase runs this sequence automatically:

```
1. Fetch GitHub issue + relevant plan sections
        │
        ▼
2. Adversarial Round 1 (opus, max effort, fresh context)
   "What's wrong with this plan?"
        │
        ▼
3. Synthesis: incorporate Round 1 findings → Improved Plan
        │
        ▼
4. Adversarial Round 2 (opus, max effort, fresh context)
   "What did Round 1 miss? What new risks did Round 1 introduce?"
        │
        ▼
5. Final synthesis: hardened implementation brief
   (saved to .pipeline-logs/phaseN-hardened-brief.md)
        │
        ▼
6. Implementation agent executes the hardened brief
   (reads files, writes code, runs verification commands, retries on failure)
        │
        ▼
7. Agent opens PR
        │
        ▼
8. Script merges PR, creates git tag (recovery checkpoint)
```

Context is fully reset between every adversarial step. Each is a separate `claude -p` call — no shared session, no accumulated context. The insights are passed as text, not memory.

---

## Recovery Checkpoints

After each successful phase merge, a git tag is created and pushed:

```
phase-1-complete
phase-2-complete
phase-3-complete
phase-4-complete
phase-5-complete
```

If the pipeline is interrupted (usage limits, network failure, bad output), resume from the last successful tag:

```bash
# Find last successful tag
git tag | grep phase

# Resume from phase 3 (phases 1+2 already done)
bash .github/run-pipeline.sh --from 3

# Re-run a single phase
bash .github/run-pipeline.sh --only 4
```

To roll back to a previous checkpoint:
```bash
git checkout phase-2-complete       # inspect state
git checkout native-base
git reset --hard phase-2-complete   # ⚠️ destructive — only if needed
git push origin native-base --force
```

---

## Execution Plan

```
Phase 1 → merge + tag phase-1-complete
               │
     ┌─────────┴──────────┐
  Phase 2               Phase 3          ← parallel
  (snapshot)            (actions)
     └─────────┬──────────┘
               │ merge both + tag phase-2/3-complete
               ▼
            Phase 4 → merge + tag phase-4-complete
               │
            Phase 5 → merge + tag phase-5-complete
```

---

## Running the Pipeline

### Prerequisites

```bash
# Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude --version

# Verify headless + permissions-skip works
claude --dangerously-skip-permissions -p "echo READY" --output-format text

# gh CLI authenticated
gh auth status   # must show kingfly55

# Clean state on native-base
git checkout native-base && git status   # must be clean
```

### Full run (phases 1–5)

Phase 5 requires camoufox running and an API key. Run phases 1–4 first, then 5 separately when you're ready to supervise it.

```bash
# Phases 1–4 (fully unattended, no external deps)
bash .github/run-pipeline.sh --from 1  # edit script to skip phase 5 if needed

# Phase 5 (camoufox + API key required)
camoufox server &   # in background, note the ws:// URL
# Update WS_ENDPOINT in camoufox_test.ts with that URL
source .env         # sets OPENAI_API_KEY
bash .github/run-pipeline.sh --only 5
```

### Watching progress

```bash
# Tail all logs in real time
tail -f .pipeline-logs/*.log

# Watch a specific phase
tail -f .pipeline-logs/phase2-implementation.log

# See adversarial findings for any phase
cat .pipeline-logs/phase3-hardened-brief.md
```

---

## The Adversarial Loop

### Why two rounds?

Round 1 finds obvious gaps. Round 2 finds what Round 1 missed — and crucially, any new risks introduced by Round 1's improvements. Two rounds is the minimum for genuine adversarial depth; three rounds shows rapidly diminishing returns on a well-scoped phase.

### Why fresh context each round?

A reviewer that can see the previous reviewer's notes anchors to them — it validates rather than challenges. Fresh context forces independent analysis. The insights are combined in the synthesis step, not shared during analysis.

### What the adversarial agents focus on

```
Round 1 looks for:
- TypeScript interface flaws (missing methods, wrong return types)
- False assumptions about the codebase
- Tests that pass even when the implementation is wrong
- Edge cases not covered by acceptance criteria
- Integration hazards that break a later phase

Round 2 looks for:
- What Round 1 missed
- New failure modes introduced by Round 1's improvements
- Implicit ordering dependencies not captured
- Things that only fail at Phase 5 but originate here
```

### Inspecting the analysis

All adversarial output is logged:

```
.pipeline-logs/
  phaseN-adversarial-round1.log   ← raw Round 1 findings
  phaseN-synthesis-round1.log     ← incorporated improvements
  phaseN-adversarial-round2.log   ← raw Round 2 findings
  phaseN-hardened-brief.md        ← final brief given to impl agent
  phaseN-implementation.log       ← full impl agent output
```

If an implementation produces unexpected results, start here: `cat .pipeline-logs/phaseN-hardened-brief.md` to see exactly what the agent was instructed to build.

---

## Key Flags

Every `claude` call in the script uses:

| Flag | Purpose |
|---|---|
| `--dangerously-skip-permissions` | Skip all approval prompts — required for unattended operation |
| `--model claude-opus-4-6` | Adversarial rounds only — deeper reasoning for flaw detection |
| `--output-format text` | Clean stdout for capture and logging |

Implementation agents use the default model (Sonnet) — fast enough and capable for structured coding tasks. Opus is reserved for the adversarial analysis where reasoning depth matters most.

---

## Failure Handling

### Pipeline stops mid-phase

The `set -euo pipefail` in the script stops on any non-zero exit. The last successful tag tells you where you are. Re-run with `--from N`.

### Agent opened a bad PR

```bash
# Find the PR
gh pr list --repo kingfly55/stagehand --head phase/2-snapshot

# Close it
gh pr close <number> --repo kingfly55/stagehand --delete-branch

# Re-run just that phase
bash .github/run-pipeline.sh --only 2
```

### Parallel agents (phases 2+3) conflict on merge

Shouldn't happen — they touch different files by design. If it does, the constraint in CLAUDE.md was violated. Close both PRs, check the implementation logs, identify which file was touched that shouldn't have been, and re-run phases 2 and 3.

### Phase 5 gap-fixing loop runs too long

Phase 5 iterates until `camoufox_test.ts` Stage 3 shows PASS. If the agent can't find a fix, it will eventually exhaust attempts and exit non-zero. Check `.pipeline-logs/phase5-implementation.log` for the last error. Fix it manually in `understudy/native/`, push to the `phase/5-camoufox` branch, and the PR will be there waiting for the script's merge step.

---

## Script Location

```
.github/run-pipeline.sh     ← the pipeline script
.pipeline-logs/             ← created at runtime, gitignored
```

Add to `.gitignore`:
```
.pipeline-logs/
```
