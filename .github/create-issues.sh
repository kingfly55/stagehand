#!/usr/bin/env bash
# Run once to create all native-mode GitHub Issues.
# Prereq: gh auth status must show kingfly55 logged in.
# Prereq: Issues must be enabled on the repo (Settings → Features → Issues).
#
# Usage: bash .github/create-issues.sh

set -e
REPO="kingfly55/stagehand"

echo "Enabling issues on repo..."
gh api --method PATCH /repos/$REPO -f has_issues=true > /dev/null

echo "Creating native-mode label..."
gh label create native-mode --repo $REPO \
  --color 7B61FF \
  --description "Playwright-native mode implementation" 2>/dev/null || true

# ── Issue 1 ───────────────────────────────────────────────────────────────────
gh issue create --repo $REPO --label native-mode \
  --title "Phase 1: Extract IStagehandPage interface and update handlers" \
  --body '## Context
Read: `PLAYWRIGHT_NATIVE_PLAN.md` §6 (IStagehandPage interface) and §7.3 (files to modify).
Read: `TESTING_GUIDE.md` §5 Phase 1 section.

This phase has **zero behavior change**. It is purely TypeScript interface extraction.
The TypeScript compiler is the complete test suite for this phase.

## Files to create
- `packages/core/lib/v3/types/private/IStagehandPage.ts` — interface spec is in §6 of plan

## Files to modify (minimal, type-sig changes only)
- `packages/core/lib/v3/understudy/page.ts` — add `implements IStagehandPage`
- `packages/core/lib/v3/handlers/actHandler.ts` — `Page` → `IStagehandPage` in param types
- `packages/core/lib/v3/handlers/extractHandler.ts` — same
- `packages/core/lib/v3/handlers/observeHandler.ts` — same
- `packages/core/lib/v3/handlers/v3AgentHandler.ts` — same

## Do NOT touch
Everything else. No `understudy/native/` files yet. No `v3.ts` changes yet.

## Acceptance criteria
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm build:esm && pnpm test:core` — same count as baseline (534 passed, 40 files)
- [ ] `git diff --name-only` lists only the 6 files above
- [ ] No files created in `understudy/native/`

## Branch: `phase/1-interface` off `native-base`'

# ── Issue 2 ───────────────────────────────────────────────────────────────────
gh issue create --repo $REPO --label native-mode \
  --title "Phase 2: Implement native snapshot capture (DOM tree + A11y tree)" \
  --body '## Context
Read: `PLAYWRIGHT_NATIVE_PLAN.md` §8 (snapshot capture design).
Read: `TESTING_GUIDE.md` §5 Phase 2 section (unit tests + smoke test).
Prereq: Phase 1 issue must be merged to `native-base` first.

## Files to create (all in `understudy/native/snapshot/`)
- `nativeDomTree.ts` — `page.evaluate()` script that walks DOM, builds xpathMap (§8.1)
- `nativeA11yTree.ts` — `page.accessibility.snapshot()` wrapper, assigns sequential IDs (§8.2)
- `captureNativeSnapshot.ts` — combines both into `HybridSnapshot` format (§8.3)

## Test files to create
- `packages/core/tests/unit/native-snapshot-dom-tree.test.ts` — uses MockPlaywrightPage
- `packages/core/tests/unit/native-snapshot-a11y-tree.test.ts` — uses MockPlaywrightPage
- `packages/core/examples/v3/native_snapshot_smoke.ts` — prints tree to stdout against real Chromium

## MockPlaywrightPage helper
Must exist before writing tests. Spec in `TESTING_GUIDE.md` §4.1.
Create at: `packages/core/tests/unit/helpers/mockPlaywrightPage.ts`

## Do NOT touch
Any existing file in `understudy/a11y/snapshot/`. The CDP snapshot path is untouched.

## Acceptance criteria
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm build:esm && pnpm test:core` — count is higher than Phase 1 baseline (new tests added)
- [ ] `pnpm example v3/native_snapshot_smoke` prints a tree with 5+ entries for example.com
- [ ] XPath map entries look like `0-1 → /html[1]/body[1]/h1[1]`, not empty/undefined

## Branch: `phase/2-snapshot` off `native-base` (or cherry-pick Phase 1 first)'

# ── Issue 3 ───────────────────────────────────────────────────────────────────
gh issue create --repo $REPO --label native-mode \
  --title "Phase 3: Implement native action dispatch (performNativeAction)" \
  --body '## Context
Read: `PLAYWRIGHT_NATIVE_PLAN.md` §9 (action dispatch design — the full dispatch table is there).
Read: `TESTING_GUIDE.md` §5 Phase 3 section (unit tests + integration tests).
Prereq: Phase 1 merged. Phase 2 is independent — can run in parallel with Phase 2.

## Files to create
- `packages/core/lib/v3/understudy/native/actions/nativeActionDispatch.ts`
- `packages/core/lib/v3/understudy/native/locator/nativeLocatorUtils.ts` — XPath prefix logic

## Test infrastructure to create first (before writing action code)
- `packages/core/vitest.native.config.mjs` — spec in `TESTING_GUIDE.md` §4.2
- `packages/core/tests/native/helpers/chromiumFixture.ts` — spec in `TESTING_GUIDE.md` §4.3
- Add `"test:native"` script to `packages/core/package.json`

## Test files to create
- `packages/core/tests/unit/native-action-dispatch.test.ts` — uses MockLocator, no browser
- `packages/core/tests/native/action-dispatch-integration.test.ts` — real Chromium fixture tests

## Methods to implement and test
click, fill, type (pressSequentially), selectOption, hover, doubleClick,
scrollIntoView, press (keyboard), setInputFiles, scroll (percent-based).
Also: unknown method must throw `StagehandInvalidArgumentError`.

## Acceptance criteria
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm build:esm && pnpm test:core` — count higher than baseline (new unit tests)
- [ ] `pnpm build:esm && pnpm test:native` — all integration tests pass on Chromium
- [ ] Both CSS selectors AND `xpath=//...` selectors are tested in integration tests

## Branch: `phase/3-actions` off `native-base`'

# ── Issue 4 ───────────────────────────────────────────────────────────────────
gh issue create --repo $REPO --label native-mode \
  --title "Phase 4: Wire PlaywrightNativeContext and browserContext V3 option" \
  --body '## Context
Read: `PLAYWRIGHT_NATIVE_PLAN.md` §5 (V3Options), §10 (V3.init changes), §11 (self-repair).
Read: `TESTING_GUIDE.md` §5 Phase 4 section.
Prereq: Phases 1, 2, and 3 all merged to `native-base`.

## Files to create
- `packages/core/lib/v3/understudy/native/PlaywrightNativePage.ts` — implements IStagehandPage
- `packages/core/lib/v3/understudy/native/PlaywrightNativeContext.ts` — wraps BrowserContext, caches pages by reference

## Files to modify
- `packages/core/lib/v3/types/public/options.ts` — add `browserContext?: BrowserContext`
- `packages/core/lib/v3/v3.ts` — two changes only:
  1. In `init()`: detect `opts.browserContext`, create `PlaywrightNativeContext`, set state `PLAYWRIGHT_NATIVE`
  2. In `normalizeToV3Page()`: if native mode, call `this.nativeCtx.wrapPage(input)`
- `packages/core/lib/v3/handlers/actHandler.ts` — native dispatch branch in self-heal (§11 of plan)

## Test files to create
- `packages/core/tests/unit/native-page-routing.test.ts` — verifies normalizeToV3Page routing

## Acceptance criteria
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm build:esm && pnpm test:core` — same or higher count, no regressions
- [ ] `pnpm test:native` passes
- [ ] Observe smoke script works: init Stagehand with `browserContext`, call `observe()`, get array back
- [ ] Existing LOCAL (CDP) path still works — run `pnpm example v3/v3_example.ts`

## Branch: `phase/4-context` off `native-base`'

# ── Issue 5 ───────────────────────────────────────────────────────────────────
gh issue create --repo $REPO --label native-mode \
  --title "Phase 5: Camoufox end-to-end — wire test, fix Firefox gaps" \
  --body '## Context
Read: `TESTING_GUIDE.md` §5 Phase 5 (pre-flight checklist, gap-fixing loop, expected output).
Read: `PLAYWRIGHT_NATIVE_PLAN.md` §12 (known Firefox limitations).
Prereq: All phases 1–4 merged. camoufox server running. OPENAI_API_KEY set in .env.

## The one file to update
`packages/core/examples/v3/camoufox_test.ts`

Change Stage 3 from the current CDP stub to:
```typescript
const stagehand = new Stagehand({
  browserContext: pwPage.context(),  // the key change
  model: "openai/gpt-4.1-mini",
  verbose: 1,
});
await stagehand.init();
```

## Pre-flight (do before any code changes)
1. Start camoufox: `camoufox server` — note the ws:// URL
2. Update `WS_ENDPOINT` constant in `camoufox_test.ts`
3. Verify: `source .env && echo ${#OPENAI_API_KEY}` — must be non-zero
4. Verify playwright-core version matches camoufox Playwright version

## Run the probe
```bash
cd packages/core
source ../../.env && pnpm example v3/camoufox_test
```

## Expected final output
```
[STAGE 1] PASS — basic Playwright connection works.
[STAGE 2] FAIL — CDP bridge threw: CDP session is only available in Chromium
[STAGE 3] Stagehand init OK.
[STAGE 3] observe() returned N elements.
[STAGE 3] extract() result: "Example Domain"
[STAGE 3] PASS — full Stagehand integration works with camoufox!
```

## Gap-fixing loop
If Stage 3 fails, read the error and fix in `understudy/native/`. See TESTING_GUIDE.md §5.5.4
for a table of common failures and their locations. Re-run after each fix.

## Final acceptance criteria
- [ ] `pnpm example v3/camoufox_test` shows Stage 3 PASS
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm build:esm && pnpm test:core` — no regressions
- [ ] `pnpm test:native` passes
- [ ] CDP path verified: an existing LOCAL example runs correctly

## Branch: `phase/5-camoufox` off `native-base`'

echo ""
echo "Done. Issues created at https://github.com/$REPO/issues?q=label%3Anative-mode"
