# Stagehand: Playwright-Native Mode — Ground Truth Planning Document

**Status:** Planning
**Goal:** Add a Playwright-native execution path that replaces raw CDP calls with Playwright public APIs, enabling Stagehand V3 to run against any browser Playwright supports — including Firefox/camoufox via Juggler.
**Upstream repo:** `https://github.com/browserbase/stagehand`
**This fork's invariant:** Never push to `main`. Pull upstream changes. Keep Playwright-native adapter as an isolated, mergeable layer.

---

## 1. Problem Statement

Stagehand V3's `understudy/` layer is a self-contained browser driver built entirely on raw CDP (Chrome DevTools Protocol) WebSocket. It bypasses Playwright's public API and talks directly to Chrome's debugging port. This means:

- **Firefox/camoufox is impossible**: `newCDPSession()` throws `"CDP session is only available in Chromium"` — confirmed by live test (Stage 2 failure, camoufox v142 / Playwright server v1.58).
- **Patchright works** only because it is Chromium-based.
- Any future non-Chromium target (Safari via WebKit, remote Firefox debugging) is structurally blocked.

The fix is a **Playwright-native execution mode**: instead of Stagehand owning a raw CDP WebSocket, it accepts a `playwright.BrowserContext` and routes all DOM operations through Playwright's public API. Playwright's internal architecture already abstracts CDP (for Chromium) and Juggler (for Firefox), so Stagehand becomes browser-agnostic.

---

## 2. Confirmed Test Results

| Test | Result |
|---|---|
| `chromium.connect({ wsEndpoint })` to camoufox v1.58 | **PASS** — connects, navigates, title correct |
| `page.context().newCDPSession(page)` | **FAIL** — `CDP session is only available in Chromium` |
| Playwright-core v1.54 vs camoufox server v1.58 | Version mismatch — fixed by installing `playwright-core@1.58` |

The Playwright version must match exactly. The camoufox server version is the source of truth.

---

## 3. Scope

### In Scope
- New `PlaywrightNativeContext` / `PlaywrightNativePage` implementation that wraps `playwright.BrowserContext` / `playwright.Page`
- Playwright-native snapshot capture (replacing the CDP-based `captureHybridSnapshot`)
- Playwright-native action execution (replacing `performUnderstudyMethod`)
- A new `env: "PLAYWRIGHT"` option (or `browserContext` option) that routes to the native path
- All existing public APIs unchanged: `act()`, `observe()`, `extract()`, `agent()`
- Cache system unchanged (cache keys are content-based, protocol-agnostic)
- Self-repair unchanged (it re-calls the same inference + action path)

### Out of Scope (for v1 of this feature)
- Rewriting CUA agent handlers (they use screenshot + computer-use API; browser-agnostic by nature)
- Removing the CDP understudy (keep it working for Chromium/Browserbase)
- Playwright-native server mode
- Shadow DOM traversal parity (defer)
- Element highlight feature (defer — cosmetic only)

---

## 4. Architecture Overview

### Current Architecture

```
User calls: stagehand.act(instruction, { page?: AnyPage })
                │
                ▼
         V3.normalizeToV3Page(pwPage)
                │
         page.context().newCDPSession(page)   ← BREAKS ON FIREFOX
         Page.getFrameTree → frameId
                │
                ▼
         V3Context (raw CDP WebSocket)
         ├─ CdpConnection (ws.ts WebSocket)
         ├─ CdpSession (per target)
         ├─ FrameRegistry (frame topology)
         └─ Page (CDP-based page wrapper)
                │
         captureHybridSnapshot(page)          ← DOM.getDocument, Accessibility.getFullAXTree
                │
         ActHandler → LLM inference
                │
         performUnderstudyMethod              ← Input.dispatchMouseEvent, Runtime.callFunctionOn
```

### Target Architecture

```
User calls: stagehand.act(instruction, { page?: AnyPage })
                │
                ▼
         V3.resolvePage(input)
         ├─ input instanceof Page (V3 CDP page) → existing path (unchanged)
         ├─ input instanceof PlaywrightNativePage → NEW PATH
         └─ input is playwright.Page → wrap in PlaywrightNativePage → NEW PATH
                │
                ▼
         PlaywrightNativePage (implements IStagehandPage interface)
         ├─ playwright.Page (owned externally or created internally)
         ├─ captureHybridSnapshot → playwright.accessibility.snapshot() + evaluate()
         └─ performAction → locator.click() / locator.fill() / etc.
                │
         ActHandler → LLM inference (UNCHANGED)
                │
         performNativeMethod (new)            ← locator.click(), locator.fill(), etc.
```

### Key Design Principle: Shared Interface

Both the CDP path and the Playwright-native path implement a common `IStagehandPage` interface. Handlers (`actHandler`, `extractHandler`, etc.) program to the interface, not the CDP implementation. This is the **single most important architectural decision**.

---

## 5. New V3Options Entry Point

```typescript
// Addition to V3Options (options.ts)
export interface V3Options {
  env: V3Env;  // "LOCAL" | "BROWSERBASE" — existing
  // NEW: provide an externally-managed Playwright browser context
  browserContext?: import('playwright-core').BrowserContext;
  // ... rest unchanged
}

// V3Env stays as-is; the new mode is detected by presence of browserContext
```

When `opts.browserContext` is present, V3.init() skips all Chrome/Browserbase launch code and wraps the provided context in `PlaywrightNativeContext`.

---

## 6. The `IStagehandPage` Interface

This is the contract all page implementations must satisfy. Define in `lib/v3/types/private/IStagehandPage.ts`:

```typescript
export interface IStagehandPage {
  // Identity
  url(): string;

  // Navigation
  goto(url: string, opts?: { waitUntil?: WaitUntil; timeout?: number }): Promise<void>;
  reload(opts?: { waitUntil?: WaitUntil; timeout?: number }): Promise<void>;
  goBack(opts?: { waitUntil?: WaitUntil; timeout?: number }): Promise<void>;
  goForward(opts?: { waitUntil?: WaitUntil; timeout?: number }): Promise<void>;
  waitForLoadState(state: WaitUntil, opts?: { timeout?: number }): Promise<void>;

  // Snapshot (the core abstraction)
  captureSnapshot(opts?: CaptureSnapshotOpts): Promise<HybridSnapshot>;

  // Action execution
  performAction(action: ResolvedAction): Promise<void>;

  // Evaluation
  evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;

  // Screenshot
  screenshot(opts?: ScreenshotOpts): Promise<Buffer>;

  // Init scripts
  addInitScript(script: string | (() => void)): Promise<void>;

  // Close
  close(): Promise<void>;
}
```

The existing `Page` class in `understudy/page.ts` gets a thin adapter layer that implements `IStagehandPage`. The new `PlaywrightNativePage` implements it directly.

---

## 7. Component Migration Map

### 7.1 Files to KEEP Unchanged (CDP path)

| File | Reason |
|---|---|
| `understudy/cdp.ts` | Entire CDP transport — stays for Chromium/Browserbase |
| `understudy/context.ts` | CDP context manager — stays |
| `understudy/page.ts` | CDP page wrapper — gains `IStagehandPage` impl |
| `understudy/frame.ts` | CDP frame — stays |
| `understudy/locator.ts` | CDP action execution — stays |
| `understudy/a11y/snapshot/domTree.ts` | CDP DOM indexing — stays |
| `understudy/a11y/snapshot/a11yTree.ts` | CDP A11y tree — stays |
| `understudy/lifecycleWatcher.ts` | CDP lifecycle — stays |
| `understudy/networkManager.ts` | CDP network — stays |
| `understudy/selectorResolver.ts` | CDP selector resolution — stays |

### 7.2 New Files to CREATE

| New File | Purpose |
|---|---|
| `understudy/native/PlaywrightNativePage.ts` | Core: implements `IStagehandPage` using `playwright.Page` |
| `understudy/native/PlaywrightNativeContext.ts` | Manages `playwright.BrowserContext`, creates `PlaywrightNativePage` instances |
| `understudy/native/snapshot/captureNativeSnapshot.ts` | Playwright-based hybrid snapshot capture |
| `understudy/native/snapshot/nativeDomTree.ts` | DOM tree extraction via `page.evaluate()` |
| `understudy/native/snapshot/nativeA11yTree.ts` | A11y tree via `page.accessibility.snapshot()` |
| `understudy/native/actions/nativeActionDispatch.ts` | All action methods via Playwright locator API |
| `understudy/native/locator/nativeLocatorUtils.ts` | XPath/CSS resolution via `page.locator()` |
| `types/private/IStagehandPage.ts` | Shared interface (see §6) |

### 7.3 Files to MODIFY (minimal, interface plumbing only)

| File | Change |
|---|---|
| `v3.ts` | Detect `opts.browserContext`, route to `PlaywrightNativeContext`; adjust `normalizeToV3Page` |
| `types/public/options.ts` | Add `browserContext?: BrowserContext` to `V3Options` |
| `handlers/actHandler.ts` | Accept `IStagehandPage` instead of `Page` |
| `handlers/extractHandler.ts` | Same |
| `handlers/observeHandler.ts` | Same |
| `handlers/v3AgentHandler.ts` | Same |
| `understudy/page.ts` | Implement `IStagehandPage` |

---

## 8. Snapshot Capture: Playwright-Native Implementation

The snapshot is the most complex part. Here is the designed approach.

### 8.1 DOM Tree

**Current (CDP):** `DOM.getDocument(depth: -1, pierce: true)` → tree of nodes with `backendNodeId` → walk to build XPath map.

**Playwright-native:** Inject a JS traversal script via `page.evaluate()` that walks the live DOM and builds the same data structure. The script mirrors what `domTree.ts` does but runs in-page.

```typescript
// nativeDomTree.ts
export async function captureNativeDomTree(
  page: playwright.Page,
  frame: playwright.Frame = page.mainFrame(),
): Promise<DomTreeResult> {
  return await frame.evaluate(() => {
    // Injected script: walks document, assigns ordinal IDs, builds XPath map
    // Returns: { xpathMap: Record<string, string>, tagMap: Record<string, string>, ... }
    function buildXPath(el: Element): string { /* ... */ }
    function walk(el: Element, ordinal: { n: number }): NodeEntry[] { /* ... */ }
    return walk(document.documentElement, { n: 0 });
  });
}
```

The injected script uses `document.createTreeWalker` and builds the same encoded-ID → XPath mapping. Since `backendNodeId` is not available, the ordinal is purely positional (stable within a single snapshot, which is all that's needed — action replay uses XPath not ordinal).

**Frame handling:** Iterate `page.frames()` to capture each frame's DOM separately. For cross-origin frames, `frame.evaluate()` works if Playwright has access (same-origin restriction still applies, but camoufox in automation mode typically grants access).

### 8.2 Accessibility Tree

**Current (CDP):** `Accessibility.getFullAXTree(frameId)` → flat list of AX nodes with `backendDOMNodeId`.

**Playwright-native:** `page.accessibility.snapshot({ interestingOnly: false })` returns the same logical tree. The key difference is that Playwright's AX snapshot is a tree (not flat) and doesn't include DOM node IDs.

**Workaround for encoding:** After getting the Playwright A11y tree, correlate nodes with the DOM tree via element attributes (id, data-testid, aria-label, text content). For the encoded-ID used by the LLM, use the positional index from the tree walk — the LLM only needs to reference an ID back to the same snapshot, not across snapshots.

```typescript
// nativeA11yTree.ts
export async function captureNativeA11yTree(
  page: playwright.Page,
): Promise<A11yTreeResult> {
  const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
  // Walk tree, assign sequential IDs, build encodedId → cssSelector map
  // For each node: use name + role + text to generate a stable CSS selector
  return processA11ySnapshot(snapshot);
}
```

The LLM doesn't care whether the selector is XPath or CSS — it just returns the encoded ID, which we look up in `combinedXpathMap` (which for native mode stores CSS selectors).

### 8.3 Combined Snapshot

Both trees are merged the same way as in the CDP path. The output format (`HybridSnapshot`) is identical — the LLM interface is unchanged.

---

## 9. Action Execution: Playwright-Native Implementation

**Current (CDP):** `performUnderstudyMethod(page, frame, method, selector, args)` → dispatches to a locator that issues raw CDP `Input.*` and `Runtime.callFunctionOn` calls.

**Playwright-native:** A direct dispatch table using Playwright locator API.

```typescript
// nativeActionDispatch.ts

export async function performNativeAction(
  page: playwright.Page,
  action: ResolvedAction,
): Promise<void> {
  const { method, selector, args, frameSelector } = action;

  // Resolve the frame (if nested)
  let frame: playwright.Frame = page.mainFrame();
  if (frameSelector) {
    frame = page.frame({ url: frameSelector })
           ?? page.frames().find(f => f.url().includes(frameSelector))
           ?? page.mainFrame();
  }

  // Resolve locator — selector is CSS or xpath=... from snapshot
  const locator = frame.locator(selector);

  switch (method) {
    case "click":
      await locator.click({ timeout: args.timeout });
      break;
    case "fill":
      await locator.fill(args.value, { timeout: args.timeout });
      break;
    case "type":
      await locator.pressSequentially(args.text, { delay: args.delay });
      break;
    case "selectOption":
      await locator.selectOption(args.values, { timeout: args.timeout });
      break;
    case "hover":
      await locator.hover({ timeout: args.timeout });
      break;
    case "doubleClick":
      await locator.dblclick({ timeout: args.timeout });
      break;
    case "scrollIntoView":
      await locator.scrollIntoViewIfNeeded({ timeout: args.timeout });
      break;
    case "press":
      await page.keyboard.press(args.key);
      break;
    case "setInputFiles":
      await locator.setInputFiles(args.files, { timeout: args.timeout });
      break;
    // Scroll variants: use page.evaluate or locator.evaluate
    case "scroll":
      await locator.evaluate((el, pct) => {
        el.scrollTop = (el.scrollHeight * pct) / 100;
      }, args.percent);
      break;
    default:
      throw new Error(`Unsupported action method in native mode: ${method}`);
  }
}
```

---

## 10. V3.init() Changes

```typescript
// v3.ts — init() method additions (after existing state transitions)

if (this.opts.browserContext) {
  // Playwright-native mode: accept external BrowserContext
  this.nativeCtx = new PlaywrightNativeContext(this.opts.browserContext, {
    logger: this.logger,
  });
  this.state = { kind: "PLAYWRIGHT_NATIVE" };
  return;
}

// ... existing LOCAL / BROWSERBASE paths unchanged
```

`normalizeToV3Page` gains a new branch:

```typescript
// If we're in PLAYWRIGHT_NATIVE mode, wrap playwright.Page in PlaywrightNativePage
if (this.state.kind === "PLAYWRIGHT_NATIVE") {
  if (isPlaywrightPage(input)) {
    return this.nativeCtx!.wrapPage(input as playwright.Page);
  }
}
```

No `newCDPSession` call. No frame ID lookup. The `PlaywrightNativePage` directly holds the `playwright.Page` reference.

---

## 11. Self-Repair in Native Mode

Self-repair (`actHandler.ts`) re-runs inference and calls `performUnderstudyMethod` with a new selector. In native mode, it calls `performNativeAction` instead. The self-repair logic itself is unchanged — only the dispatch target changes.

```typescript
// actHandler.ts — self-heal dispatch
if (this.nativeMode) {
  await performNativeAction(page.pwPage, fallbackAction);
} else {
  await performUnderstudyMethod(page, frame, method, newSelector, resolvedArgs, timeout);
}
```

The `nativeMode` flag is set when the page is a `PlaywrightNativePage`.

---

## 12. What Firefox/Juggler Cannot Do (Known Limitations)

These limitations should be documented in user-facing docs and throw informative errors rather than silently failing.

| Feature | Status | Workaround |
|---|---|---|
| Element highlight (debug) | Not supported in Playwright/Firefox | No-op in native mode; log a warning |
| Shadow DOM full traversal | Playwright has no public pierce API | `locator.evaluate()` for specific queries |
| `DOM.getNodeForLocation` (pixel hit test) | No Playwright API | `document.elementFromPoint(x,y)` via evaluate |
| Frame-scoped A11y tree | `page.accessibility.snapshot()` is page-wide | Build per-frame by iterating `page.frames()` and calling evaluate per frame |
| Emulation beyond viewport | `Emulation.setDeviceMetricsOverride` partial | `context.setViewportSize()` covers most cases |

---

## 13. Testing Plan

### Unit Tests (new)
- `PlaywrightNativePage.captureSnapshot()` returns valid `HybridSnapshot` with camoufox
- `performNativeAction()` executes click/fill/select correctly on Firefox
- `normalizeToV3Page` routes `playwright.Page` to `PlaywrightNativePage` when in native mode

### Integration Test (camoufox)
Add to `packages/core/examples/v3/camoufox_test.ts` (already exists as Stage 3):
```typescript
const stagehand = new Stagehand({
  env: "LOCAL",
  browserContext: camoufoxContext,   // external BrowserContext
  model: "openai/gpt-4.1-mini",
});
await stagehand.init();
const result = await stagehand.extract("extract heading", z.string(), { page: camoufoxPage });
console.log(result);
```

### Regression Tests
The existing `test:core` suite should pass unchanged for `env: "LOCAL"` and `env: "BROWSERBASE"` — the CDP path is untouched.

---

## 14. Rollout Strategy

### Phase 1 — Interface extraction (no behavior change)
1. Define `IStagehandPage` interface
2. Have `Page` (CDP) implement it
3. Update all handlers to accept `IStagehandPage` instead of `Page`
4. All tests pass — zero behavior change

### Phase 2 — Snapshot native implementation
1. Implement `captureNativeSnapshot` (DOM tree + A11y tree via Playwright evaluate)
2. Unit-test snapshot output against expected `HybridSnapshot` format
3. Verify LLM inference works with native snapshot (observe() returns correct results)

### Phase 3 — Action native implementation
1. Implement `performNativeAction` dispatch table
2. Test each method: click, fill, type, select, hover, scroll, press
3. Integrate into actHandler self-heal path

### Phase 4 — Context integration
1. Implement `PlaywrightNativePage` and `PlaywrightNativeContext`
2. Add `browserContext` option to `V3Options`
3. Update `V3.init()` and `normalizeToV3Page`

### Phase 5 — Camoufox end-to-end
1. Update `camoufox_test.ts` Stage 3 to use `browserContext` option
2. Run full act/extract/observe against camoufox
3. Fix any Juggler-specific gaps found

---

## 15. Fork Strategy: Staying in Sync with Upstream

### Setup

```bash
# After forking on GitHub:
git remote add upstream https://github.com/browserbase/stagehand.git
git remote set-url --push upstream DISABLED   # Never accidentally push to upstream
git fetch upstream
```

### Branch Structure

```
main          ← upstream tracking branch (never modified, never pushed to upstream)
native-base   ← our fork's stable base (rebased onto upstream main periodically)
native-dev    ← active development branch for Playwright-native feature
```

`main` mirrors upstream exactly. `native-base` is our stable fork that only contains the native adapter. Never add commits to `main`.

### Merge Strategy: Keep Adapter in an Isolated Layer

The critical discipline: **all fork-specific code lives only in these locations**:
- `packages/core/lib/v3/understudy/native/` — new files only (no upstream files in this dir)
- `packages/core/lib/v3/types/private/IStagehandPage.ts` — new file
- Modifications to existing files kept as **minimal as possible** (interface plumbing only)

The more you touch existing files, the more merge conflicts you get. The goal is that most of the diff is additive (new files) rather than modifications.

### Receiving Upstream Updates

```bash
# Workflow: pull upstream into main, rebase native-base on top
git checkout main
git pull upstream main          # Fast-forward only; if it doesn't FF, investigate

git checkout native-base
git rebase main                 # Rebase our changes onto latest upstream
# Fix any conflicts (should be minimal if adapter layer is clean)

git checkout native-dev
git rebase native-base          # Keep dev branch current
```

Run after every upstream pull:
```bash
pnpm install --frozen-lockfile  # Lockfile may have changed
pnpm --filter @browserbasehq/stagehand run test:core  # Verify CDP path unchanged
```

### Conflict-Prone Files (Watch Carefully)

These files are both upstream-active and require our modifications. Keep our changes minimal and well-commented so diffs are easy to understand and rebase:

| File | Our changes | Why it's risky |
|---|---|---|
| `v3.ts` | `browserContext` option branch in `init()`, one new branch in `normalizeToV3Page` | Large active file, upstream frequently changes it |
| `types/public/options.ts` | `browserContext` field addition | Options evolve with new upstream features |
| `handlers/actHandler.ts` | Native dispatch branch in self-heal | Handler logic changes with upstream improvements |

### Tagging Convention

```
v3.1.0-native.1    ← upstream version + native revision
v3.1.0-native.2
v3.2.0-native.1    ← after rebasing onto upstream v3.2.0
```

### What to Do When Upstream Changes Break the Adapter

If upstream significantly refactors a file the adapter depends on (e.g., renames `performUnderstudyMethod`, changes `HybridSnapshot` shape):

1. Create a `native-compat` branch from the last working `native-base`
2. Update the adapter to match new upstream interfaces
3. Add a regression test for the broken scenario
4. Merge into `native-base`

### GitHub Actions (CI)

Add a separate CI job that runs the camoufox integration test on every push to `native-base`. This ensures upstream rebases that silently break camoufox compatibility are caught immediately.

```yaml
# .github/workflows/camoufox.yml
jobs:
  camoufox-compat:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start camoufox
        run: npx camoufox@latest serve --headless &  # or docker-based
      - name: Run camoufox probe
        run: cd packages/core && pnpm example v3/camoufox_test
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

---

## 16. File Tree: End State

```
packages/core/lib/v3/
├── understudy/
│   ├── cdp.ts                          [UNCHANGED — CDP transport]
│   ├── context.ts                      [UNCHANGED — CDP context]
│   ├── page.ts                         [MODIFIED — implements IStagehandPage]
│   ├── frame.ts                        [UNCHANGED]
│   ├── locator.ts                      [UNCHANGED]
│   ├── a11y/snapshot/
│   │   ├── capture.ts                  [UNCHANGED]
│   │   ├── domTree.ts                  [UNCHANGED]
│   │   └── a11yTree.ts                 [UNCHANGED]
│   └── native/                         [ALL NEW]
│       ├── PlaywrightNativeContext.ts
│       ├── PlaywrightNativePage.ts
│       ├── snapshot/
│       │   ├── captureNativeSnapshot.ts
│       │   ├── nativeDomTree.ts
│       │   └── nativeA11yTree.ts
│       ├── actions/
│       │   └── nativeActionDispatch.ts
│       └── locator/
│           └── nativeLocatorUtils.ts
├── types/
│   ├── private/
│   │   ├── IStagehandPage.ts           [NEW — shared interface]
│   │   └── ... (existing unchanged)
│   └── public/
│       └── options.ts                  [MODIFIED — +browserContext field]
├── handlers/
│   ├── actHandler.ts                   [MODIFIED — IStagehandPage, native dispatch]
│   ├── extractHandler.ts               [MODIFIED — IStagehandPage]
│   ├── observeHandler.ts               [MODIFIED — IStagehandPage]
│   └── v3AgentHandler.ts               [MODIFIED — IStagehandPage]
└── v3.ts                               [MODIFIED — browserContext init path]
```

---

## 17. Open Questions / Decision Points

These must be resolved before or during Phase 1:

1. **XPath vs CSS in native mode**: The LLM currently receives XPath selectors in the snapshot and returns XPath in actions. In native mode, should the snapshot use CSS selectors instead (simpler, Playwright-native), or should we convert XPath to `xpath=...` Playwright locator syntax? **Recommendation: Use `xpath=...` prefix syntax — Playwright supports it, LLM output unchanged.**

2. **Frame handling in native snapshot**: `page.frames()` returns all frames including cross-origin OOPIFs. Each `frame.evaluate()` call is separate. Should we build one combined snapshot (like CDP) or per-frame? **Recommendation: Per-frame, then merge — same as CDP path for consistency.**

3. **`browserContext` vs `page` as init option**: Should the option be a full `BrowserContext` (user creates context externally) or just a `Page` (simpler for users)? **Recommendation: Accept both via union type; if `Page` is passed, extract its context.**

4. **Playwright version pinning in native mode**: The camoufox server version must match `playwright-core` client version exactly. Should Stagehand validate this at init? **Recommendation: Yes — check `browser.version()` and warn if Playwright client version doesn't match, since mismatches cause cryptic 428 errors.**

5. **What happens if `performNativeAction` encounters an unsupported method?** Throw `StagehandInvalidArgumentError` with a clear message listing supported methods in native mode.

---

## 18. Key Dependencies

| Package | Used For | Native Mode Impact |
|---|---|---|
| `devtools-protocol` | CDP TypeScript types | Not needed in native path |
| `playwright-core` | Already optional dep | Must be required when `browserContext` option used |
| `ws` | Raw WebSocket transport | Not needed in native path |
| `chrome-launcher` | Local Chrome launch | Not needed in native path |

In native mode, `playwright-core` goes from optional to required. Add a runtime check in `PlaywrightNativeContext` constructor that throws a friendly error if it's missing.

---

## Appendix A: CDP Call Inventory (Complete)

All CDP domains and methods called in the current understudy, for reference when building Playwright equivalents:

| Domain | Methods | File |
|---|---|---|
| `Page` | `enable`, `navigate`, `reload`, `getFrameTree`, `getNavigationHistory`, `navigateToHistoryEntry`, `addScriptToEvaluateOnNewDocument`, `setLifecycleEventsEnabled`, `captureScreenshot`, `createIsolatedWorld` | `page.ts`, `frame.ts` |
| `DOM` | `enable`, `getDocument`, `describeNode`, `querySelector`, `getBoxModel`, `scrollIntoViewIfNeeded`, `setFileInputFiles`, `getFrameOwner`, `getNodeForLocation` | `locator.ts`, `domTree.ts`, `frame.ts` |
| `Runtime` | `enable`, `evaluate`, `callFunctionOn`, `releaseObject`, `runIfWaitingForDebugger`, `executionContextCreated` (event) | `locator.ts`, `selectorResolver.ts`, `executionContextRegistry.ts` |
| `Input` | `dispatchMouseEvent`, `dispatchKeyEvent`, `insertText` | `locator.ts` |
| `Accessibility` | `enable`, `getFullAXTree` | `a11yTree.ts` |
| `Network` | `enable`, `setExtraHTTPHeaders`, `requestWillBeSent` (event), `responseReceived` (event), `loadingFinished` (event) | `networkManager.ts` |
| `Storage` | `setCookies`, `clearCookies`, `getCookies` | `cookies.ts` |
| `Overlay` | `enable`, `highlightNode`, `hideHighlight` | `locator.ts` (highlight feature) |
| `Emulation` | `setDeviceMetricsOverride`, `setVisibleSize`, `setDefaultBackgroundColorOverride` | `page.ts` |
| `Target` | `setAutoAttach`, `setDiscoverTargets`, `attachToTarget`, `detachFromTarget`, `getTargets`, `closeTarget`, `activateTarget`, `attachedToTarget` (event), `detachedFromTarget` (event) | `context.ts` |
| `Browser` | `setDownloadBehavior` | `page.ts` |

---

## Appendix B: Quick Reference — Playwright API Equivalents

| CDP Call | Playwright API |
|---|---|
| `Page.navigate(url)` | `page.goto(url, { waitUntil })` |
| `Page.reload()` | `page.reload()` |
| `Page.captureScreenshot` | `page.screenshot(options)` |
| `Page.addScriptToEvaluateOnNewDocument` | `page.addInitScript(fn)` |
| `DOM.scrollIntoViewIfNeeded(objectId)` | `locator.scrollIntoViewIfNeeded()` |
| `DOM.getBoxModel(objectId)` | `locator.boundingBox()` |
| `DOM.setFileInputFiles(objectId, files)` | `locator.setInputFiles(files)` |
| `Input.dispatchMouseEvent(click)` | `locator.click(opts)` |
| `Input.dispatchMouseEvent(hover)` | `locator.hover(opts)` |
| `Input.insertText(value)` | `locator.fill(value)` |
| `Input.dispatchKeyEvent` | `page.keyboard.press(key)` |
| `Runtime.evaluate(expression)` | `page.evaluate(fn, args)` |
| `Runtime.callFunctionOn(selectOptions)` | `locator.selectOption(values)` |
| `Accessibility.getFullAXTree()` | `page.accessibility.snapshot()` |
| `Network.setExtraHTTPHeaders` | `context.setExtraHTTPHeaders(headers)` |
| `Storage.setCookies` | `context.addCookies(cookies)` |
| `Storage.clearCookies` | `context.clearCookies()` |
| `Page.getFrameTree` | `page.frames()`, `frame.childFrames()` |
| `Target.setAutoAttach` | Handled internally by Playwright |
| `Browser.setDownloadBehavior` | `context.route()` + download event |
