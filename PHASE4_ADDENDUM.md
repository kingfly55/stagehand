# Phase 4 Implementation Addendum
## Corrections and Clarifications from Adversarial Review

This document supplements the original plan. Follow every instruction here.
Where it conflicts with the original plan, **this addendum wins**.

---

### Finding 1 — `resolvePage()` / `normalizeToV3Page()` return types must widen

**Instruction:** Change both method signatures in `v3.ts`:

```typescript
// before
private async resolvePage(page?: AnyPage): Promise<Page>
private async normalizeToV3Page(input: AnyPage): Promise<Page>

// after
private async resolvePage(page?: AnyPage): Promise<IStagehandPage>
private async normalizeToV3Page(input: AnyPage): Promise<IStagehandPage>
```

All local variables that receive these return values must also be typed as
`IStagehandPage`. The CDP `Page` class already implements `IStagehandPage`
(Phase 1), so the concrete paths are unaffected.

---

### Finding 2 — `mainFrameId()` is not on `IStagehandPage`; guard every call site

**Instruction:** Do NOT add `mainFrameId()` to `IStagehandPage`. It is a
CDP-only concept with no Playwright equivalent. Instead, guard each of the six
call sites in `v3.ts` (lines 1107, 1191, 1303, 1375, 1958, 2092):

```typescript
// Pattern to apply at each site:
if (this.state.kind === "PLAYWRIGHT_NATIVE") {
  throw new StagehandInvalidArgumentError(
    "apiClient path is not supported in PLAYWRIGHT_NATIVE mode. " +
    "Remove the apiClient option or use env: 'LOCAL'/'BROWSERBASE'.",
  );
}
const frameId = (page as Page).mainFrameId();
```

This is correct: the `apiClient` path (Browserbase hosted inference) is
inherently CDP-bound and cannot support the native path. Fail fast with a
clear error rather than silently corrupting behavior.

---

### Finding 3 — `this.ctx` is null in native mode; guard the fallback path in `resolvePage()`

**Instruction:** Replace the current fallback branch in `resolvePage()`:

```typescript
// Current (will NPE in native mode):
const ctx = this.ctx;
if (!ctx) throw new StagehandNotInitializedError("resolvePage()");
return await ctx.awaitActivePage();

// Replace with:
if (this.state.kind === "PLAYWRIGHT_NATIVE") {
  // No page argument supplied: use the first page in the native context.
  return this.nativeCtx!.getActivePage();
}
const ctx = this.ctx;
if (!ctx) throw new StagehandNotInitializedError("resolvePage()");
return await ctx.awaitActivePage();
```

Add `getActivePage(): IStagehandPage` to `PlaywrightNativeContext`. Its
implementation returns the wrapped version of `this.browserContext.pages()[0]`,
throwing `StagehandNotInitializedError` if no pages exist.

Also guard the three `this.ctx!.setActivePage(...)` and
`this.ctx!.awaitActivePage()` call sites inside `agent()` (lines ~1755,
~1769, ~1918, ~1928, ~1954) with the same native-mode guard pattern.

---

### Finding 4 — Do NOT modify `actHandler.ts` for self-heal dispatch

**Instruction:** Delete §11 of the original plan entirely. The self-heal path
already calls `page.performAction()` (confirmed at `actHandler.ts:387-392`),
which routes through the `IStagehandPage` interface. `PlaywrightNativePage`
must implement `performAction()` by calling `performNativeAction()` internally.
No change to `actHandler.ts` is needed for this. The file still requires its
`Page` → `IStagehandPage` type changes from Phase 1, but no new dispatch logic.

---

### Finding 5 & 6 — `PlaywrightNativePage` instanceof check must precede duck-type checks

**Instruction:** In `normalizeToV3Page()`, add the `PlaywrightNativePage`
branch as the **first** check, before `isPlaywrightPage()`:

```typescript
private async normalizeToV3Page(input: AnyPage): Promise<IStagehandPage> {
  // 1. Already a native page — return as-is (must be first)
  if (input instanceof PlaywrightNativePage) {
    return input;
  }
  // 2. Already a CDP Page — return as-is
  if (input instanceof (await import("./understudy/page.js")).Page) {
    return input as Page;
  }
  // 3. In native mode: wrap any raw playwright.Page
  if (this.state.kind === "PLAYWRIGHT_NATIVE" && this.isPlaywrightPage(input)) {
    return this.nativeCtx!.wrapPage(input as PlaywrightPage);
  }
  // 4. CDP mode: resolve via CDPSession (existing Playwright/Patchright/Puppeteer paths)
  if (this.isPlaywrightPage(input)) {
    const frameId = await this.resolveTopFrameId(input);
    const page = this.ctx!.resolvePageByMainFrameId(frameId);
    if (!page) throw new StagehandInitError("...");
    return page;
  }
  // ... patchright, puppeteer branches unchanged ...
}
```

This guarantees that a `PlaywrightNativePage` is never mistakenly routed into
`resolveTopFrameId()` → `newCDPSession()`.

---

### Finding 7 — Add `PLAYWRIGHT_NATIVE` to `InitState` union in `internal.ts`

**Instruction:** Add `internal.ts` to "Files to modify". Extend the union:

```typescript
// internal.ts
export type InitState =
  | { kind: "UNINITIALIZED" }
  | { kind: "LOCAL"; chrome: LaunchedChrome; ws: string; userDataDir?: string;
      createdTempProfile?: boolean; preserveUserDataDir?: boolean }
  | { kind: "BROWSERBASE"; bb: Browserbase; sessionId: string; ws: string }
  | { kind: "PLAYWRIGHT_NATIVE" };   // ADD THIS
```

Without this, `this.state = { kind: "PLAYWRIGHT_NATIVE" }` is a compile error.

---

### Finding 8 — `close()` must have a native-mode branch

**Instruction:** Add an early-return branch at the top of the substantive part
of `close()`, after the `_isClosing` guard and before the CDP teardown code:

```typescript
// After the _isClosing guard:
if (this.state.kind === "PLAYWRIGHT_NATIVE") {
  // In native mode, the BrowserContext is owned by the caller; do not close it.
  // Only reset internal Stagehand state.
  this.state = { kind: "UNINITIALIZED" };
  this.nativeCtx = null;
  this._isClosing = false;
  this.resetBrowserbaseSessionMetadata();
  try { unbindInstanceLogger(this.instanceId); } catch { /* ignore */ }
  try { await this.eventStore.destroy(); } catch { /* ignore */ }
  try { this.bus.removeAllListeners(); } catch { /* ignore */ }
  this._history = [];
  this.actHandler = null;
  return;
}
// ... existing CDP teardown continues unchanged ...
```

The caller owns the `BrowserContext` and is responsible for closing it.
If the caller wants Stagehand to close it, that can be a `closeBrowserContext`
option in a future phase — not this one.

---

### Finding 9 — Add a CDP-path non-regression acceptance criterion

**Instruction:** Add to acceptance criteria:

> - [ ] Pass a `playwright.Page` that is connected via `newCDPSession` (LOCAL
>   mode, no `browserContext` option). Confirm it resolves to the CDP `Page`
>   object and does NOT enter the `PlaywrightNativePage` path. Log the resolved
>   page constructor name in the test to make this explicit.

This prevents the ordering fix in Finding 5/6 from accidentally routing
CDP-backed Playwright pages into the native wrapper.

---

### Finding 10 — `ActCache.prepareContext()` and `tryReplay()` accept `Page`, not `IStagehandPage`

**Instruction:** Add `cache/ActCache.ts` to "Files to modify". Change the
signatures of `prepareContext(instruction, page: Page, ...)` and
`tryReplay(context, page: Page, ...)` to accept `IStagehandPage`. Then audit
the method bodies:

- If either method calls any `Page`-specific method (e.g. `page.mainFrame()`,
  frame registry lookups, direct CDP calls), wrap those call sites with
  `if (page instanceof Page)` guards and skip/no-op for native pages.
- The cache key itself must be content-based (URL + instruction hash), which
  already works without a `Page` reference. The likely issue is only
  `prepareContext`'s snapshot call — `page.captureSnapshot()` is on
  `IStagehandPage`, so that path is safe.
- If `tryReplay` calls `page.performAction()`, that is also on the interface
  and safe.

Concretely: grep `ActCache.ts` for any usage of `Page`-typed methods not
in `IStagehandPage` before writing the native implementation. Fix each one.

---

### Finding 11 — `PlaywrightNativeContext` cache must evict closed pages

**Instruction:** In `PlaywrightNativeContext`, after storing the wrapped page
in the `Map<playwright.Page, PlaywrightNativePage>`, immediately register a
close listener:

```typescript
wrapPage(pwPage: playwright.Page): PlaywrightNativePage {
  if (this._cache.has(pwPage)) return this._cache.get(pwPage)!;
  const wrapped = new PlaywrightNativePage(pwPage, this._opts);
  this._cache.set(pwPage, wrapped);
  pwPage.once("close", () => this._cache.delete(pwPage));
  return wrapped;
}
```

This prevents the `Map` from accumulating strong references to closed
`playwright.Page` objects across the lifetime of the `BrowserContext`.

---

### Finding 12 — New files must be importable by `v3.ts`; no barrel required

**Instruction:** Import `PlaywrightNativePage` and `PlaywrightNativeContext`
directly in `v3.ts` using relative paths. Do NOT route them through the
`types/private/index.ts` barrel (that barrel re-exports type-only things;
adding class constructors there risks circular imports). The import section of
`v3.ts` gains:

```typescript
import { PlaywrightNativeContext } from "./understudy/native/PlaywrightNativeContext.js";
import { PlaywrightNativePage }    from "./understudy/native/PlaywrightNativePage.js";
```

Add `PlaywrightNativePage` to the `AnyPage` union type used in
`normalizeToV3Page` if it isn't already there, so the TypeScript narrowing
in Finding 5 compiles cleanly.

---

### Finding 13 — `waitForNetworkIdle()` must use Playwright semantics, not CDP semantics

**Instruction:** In `PlaywrightNativePage.waitForNetworkIdle()`, implement
using Playwright's `page.waitForLoadState('networkidle')`:

```typescript
async waitForNetworkIdle(domSettleTimeoutMs?: number): Promise<void> {
  await this._pwPage.waitForLoadState("networkidle", {
    timeout: domSettleTimeoutMs,
  });
}
```

Add a JSDoc comment:

```
/**
 * NOTE: Playwright's 'networkidle' fires after ≥500ms with ≤2 open
 * connections. This differs from the CDP understudy's custom polling.
 * In practice both are "good enough" for LLM inference timing.
 */
```

Do not attempt to replicate the CDP implementation with `setTimeout` polling.
The semantic difference is documented and acceptable.

---

### Finding 14 — Acceptance criteria must validate observation content, not just absence of throw

**Instruction:** Replace the current smoke criterion with:

```
- [ ] Smoke: init Stagehand with `browserContext` pointing to a camoufox page
  that has loaded a real URL (e.g. example.com). Call `observe("find all links")`.
  Assert: (a) result is a non-empty array, (b) each item has `selector` and
  `description` string fields, (c) at least one selector is non-empty and
  locatable via `page.locator(selector).count()` returning > 0.
```

---

### Finding 15 — `evaluate()` must not accept raw string expressions on `PlaywrightNativePage`

**Instruction:** In `PlaywrightNativePage.evaluate()`, reject string
expressions that look like arbitrary JS (as opposed to the special `xpath=...`
/CSS strings used for selector resolution, which are not passed to `evaluate`):

```typescript
async evaluate<R = unknown, Arg = unknown>(
  fn: string | ((arg: Arg) => R | Promise<R>),
  arg?: Arg,
): Promise<R> {
  if (typeof fn === "string") {
    // IStagehandPage.evaluate() with a string was a CDP-ism.
    // Playwright requires a serializable function, not a JS expression string.
    throw new StagehandInvalidArgumentError(
      "PlaywrightNativePage.evaluate() does not support string expressions. " +
      "Pass a function: page.evaluate(() => document.title)",
    );
  }
  return this._pwPage.evaluate(fn as (arg: Arg) => R, arg as Arg);
}
```

Then audit every call site in `handlers/` and `v3.ts` that calls
`page.evaluate(someString, ...)`. Each one must be converted to a function
form before Phase 4 ships. Use Grep to find them:

```
grep -rn "\.evaluate(" packages/core/lib/v3/handlers/
```

For any string-expression `evaluate` call, the fix is:

```typescript
// before: page.evaluate("return document.title")
// after:  page.evaluate(() => document.title)
```

---

### Finding 16 — "Two changes only to `v3.ts`" is false; correct the scope statement

**Instruction:** The plan's §10 framing ("two changes only") must be replaced
with the complete list of changes required in `v3.ts`:

1. Add `nativeCtx: PlaywrightNativeContext | null = null` property declaration.
2. `init()`: detect `opts.browserContext`, construct `PlaywrightNativeContext`,
   set `this.state = { kind: "PLAYWRIGHT_NATIVE" }`, return early.
3. `normalizeToV3Page()`: widen return type; add `PlaywrightNativePage`
   instanceof check first; add native-mode branch for raw `playwright.Page`.
4. `resolvePage()`: widen return type; add native-mode fallback (Finding 3).
5. `close()`: add native-mode early-return branch (Finding 8).
6. All `mainFrameId()` call sites: add native-mode guard (Finding 2).
7. All `this.ctx!.setActivePage / awaitActivePage` in `agent()`: add
   native-mode guard (Finding 3 extension).

No other changes are needed in `v3.ts`. Do not touch unrelated code.

---

### Finding 17 — `screenshot()` must silently drop `mask` in native mode

**Instruction:** In `PlaywrightNativePage.screenshot()`, accept
`ScreenshotOptions` but ignore the `mask` field:

```typescript
async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
  const { mask: _mask, ...pwOpts } = opts ?? {};
  // mask is CDP-Locator-typed and cannot be used on a Playwright page.
  // It is silently dropped. A future phase can add NativeLocator support.
  return this._pwPage.screenshot(pwOpts) as Promise<Buffer>;
}
```

Add a one-line `// mask not supported in native mode` comment so it is findable
in a future search.

---

### Finding 18 — Add multi-page acceptance criteria and test

**Instruction:** Add to acceptance criteria:

```
- [ ] Multi-page: after init with browserContext, open a second page via
  `browserContext.newPage()`. Call `stagehand.act("...", { page: secondPage })`.
  Assert that `nativeCtx.wrapPage(secondPage)` returns a different object from
  `nativeCtx.wrapPage(firstPage)`, and that calling `wrapPage(firstPage)` twice
  returns the same cached instance.
```

Add to `native-page-routing.test.ts`:

```typescript
it("caches wrapper by page reference", () => {
  const mockPage1 = makeMockPwPage();
  const mockPage2 = makeMockPwPage();
  const ctx = new PlaywrightNativeContext(mockBrowserContext, opts);
  const w1a = ctx.wrapPage(mockPage1);
  const w1b = ctx.wrapPage(mockPage1);
  const w2  = ctx.wrapPage(mockPage2);
  expect(w1a).toBe(w1b);       // same reference
  expect(w1a).not.toBe(w2);    // different pages → different wrappers
});

it("evicts closed page from cache", () => {
  const mockPage = makeMockPwPage();
  const ctx = new PlaywrightNativeContext(mockBrowserContext, opts);
  ctx.wrapPage(mockPage);
  mockPage.emit("close");      // trigger eviction
  const rewrapped = ctx.wrapPage(mockPage);
  // New wrapper is a fresh instance (old one was evicted)
  expect(rewrapped).not.toBe(ctx["_cache"].get(mockPage));  // cache was cleared then re-set
});
```

---

## Summary: Additional Files to Modify (beyond original plan)

| File | Reason |
|---|---|
| `types/private/internal.ts` | Add `PLAYWRIGHT_NATIVE` to `InitState` union |
| `cache/ActCache.ts` | Widen `Page` → `IStagehandPage` in method signatures |

## Corrected "Files to modify" list (complete)

- `types/public/options.ts` — add `browserContext?: BrowserContext`
- `types/private/internal.ts` — extend `InitState` union *(new)*
- `v3.ts` — seven changes enumerated in Finding 16 correction
- `cache/ActCache.ts` — widen page type *(new)*
- `handlers/actHandler.ts` — `Page` → `IStagehandPage` types only; no dispatch logic

## Acceptance Criteria (revised complete list)

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm build:esm && pnpm test:core` — no regressions on CDP path
- [ ] `pnpm test:native` passes (includes multi-page and cache eviction tests)
- [ ] Smoke: `observe("find all links")` on camoufox returns non-empty array
      with locatable selectors (Finding 14)
- [ ] Multi-page: second tab wraps to distinct `PlaywrightNativePage` (Finding 18)
- [ ] Non-regression: CDP-backed `playwright.Page` passed to `act()` in LOCAL
      mode resolves to CDP `Page`, not `PlaywrightNativePage` (Finding 9)
- [ ] CDP example: `pnpm example v3/v3_example.ts` runs without errors
- [ ] `stagehand.close()` in native mode does not close the `BrowserContext`
      (caller can still call `page.title()` after)
