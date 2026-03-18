# Phase 4 — Playwright-Native Context: Final Implementation Brief

**Branch:** `phase/4-context` off `native-base`
**Prerequisites:** Issues #1, #2, #3 merged to `native-base` (IStagehandPage interface, native snapshot, native action dispatch).
**Verification commands at end of document.**

---

## ⛔ DO NOT — Top 3 Failure Modes

These three mistakes will produce silent, hard-to-debug failures. Read them before touching any code.

### ⛔ DO NOT put the `PlaywrightNativePage` instanceof check after the duck-type checks

`normalizeToV3Page` currently checks `isPlaywrightPage(input)` by testing whether `.context` is a function. `PlaywrightNativePage` wraps a `playwright.Page` and may expose `.context()` — it will match this duck-type and fall through to `resolveTopFrameId()` → `page.context().newCDPSession(page)`, which throws `"CDP session is only available in Chromium"` on Firefox/camoufox. The `instanceof PlaywrightNativePage` guard **must be the very first branch** in `normalizeToV3Page`, before every duck-type check.

### ⛔ DO NOT put the native-mode early-return in `close()` after the `apiClient.end()` call

`close()` calls `await this.apiClient.end()` at line 1432, **before** any state checks. In native mode, `this.apiClient` may be set (user could have passed one), and calling `.end()` sends a session-termination request with no corresponding Browserbase session. The native-mode early-return must come immediately after the `_isClosing` guard (line 1414), before the CDP transport unhook and before `apiClient.end()`.

### ⛔ DO NOT leave `this.ctx!.setActivePage()` and `this.ctx!.awaitActivePage()` unguarded in `agent()`

`agent()` calls `this.ctx!.setActivePage(normalizedPage)` at lines **1755** and **1918**, and `this.ctx!.awaitActivePage()` at lines **1769**, **1928**, and **1954**. In native mode `this.ctx` is null. All five sites will throw a cryptic null-dereference instead of a clear error. Each site needs a native-mode guard before the `!` assertion.

---

## Files to Create

### `packages/core/lib/v3/understudy/native/PlaywrightNativePage.ts`

Implements `IStagehandPage`. Wraps a `playwright.Page`. Key requirements:

```typescript
import type { IStagehandPage } from "../../types/private/IStagehandPage.js";
import type { Page as PlaywrightPage } from "playwright-core";

export class PlaywrightNativePage implements IStagehandPage {
  constructor(
    public readonly _pwPage: PlaywrightPage,
    private readonly _opts: { logger: StagehandLogger },
  ) {}

  // evaluate() — REJECT string expressions (CDP-ism; Playwright requires functions)
  async evaluate<R = unknown, Arg = unknown>(
    fn: string | ((arg: Arg) => R | Promise<R>),
    arg?: Arg,
  ): Promise<R> {
    if (typeof fn === "string") {
      throw new StagehandInvalidArgumentError(
        "PlaywrightNativePage.evaluate() does not support string expressions. " +
        "Pass a function: page.evaluate(() => document.title)",
      );
    }
    return this._pwPage.evaluate(fn as (arg: Arg) => R, arg as Arg);
  }

  // waitForNetworkIdle() — use Playwright semantics, NOT CDP polling
  /**
   * NOTE: Playwright's 'networkidle' fires after ≥500ms with ≤2 open
   * connections. This differs from the CDP understudy's custom polling.
   * In practice both are "good enough" for LLM inference timing.
   */
  async waitForNetworkIdle(domSettleTimeoutMs?: number): Promise<void> {
    await this._pwPage.waitForLoadState("networkidle", {
      timeout: domSettleTimeoutMs,
    });
  }

  // screenshot() — silently drop `mask` (CDP-Locator-typed, unusable here)
  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const { mask: _mask, ...pwOpts } = opts ?? {};
    // mask not supported in native mode — deferred to future phase
    return this._pwPage.screenshot(pwOpts) as Promise<Buffer>;
  }

  // performAction() — delegates to performNativeAction() internally.
  // This is how self-heal dispatch works: actHandler.ts calls page.performAction(),
  // which routes here. DO NOT modify actHandler.ts for self-heal dispatch.
  async performAction(action: Action): Promise<void> {
    await performNativeAction(this._pwPage, action);
  }

  // goto() — return type is Promise<unknown> per interface; Playwright returns
  // Promise<Response | null>. Do NOT add .status() calls on the return value
  // anywhere — the Playwright Response type differs from the CDP Response wrapper.
  async goto(url: string, opts?: GotoOptions): Promise<unknown> {
    return this._pwPage.goto(url, opts);
  }

  // addInitScript() — WARNING: in an externally-owned BrowserContext, this
  // injects into ALL pages in the context, not just this one. This is a known
  // Phase 4 limitation; document it with a comment.
  async addInitScript(script: string | InitScriptSource<unknown>): Promise<void> {
    // WARNING: delegates to playwright BrowserContext-level addInitScript.
    // Script will run on all future navigations of ALL pages in this context.
    await this._pwPage.addInitScript(script as string);
  }

  // waitForSelector() — must be implemented because ActCache.utils calls it.
  // Use Playwright's locator().waitFor() as the equivalent.
  async waitForSelector(selector: string, opts?: WaitForSelectorOptions): Promise<void> {
    await this._pwPage.locator(selector).waitFor({ timeout: opts?.timeout });
  }
}
```

**After implementing all `IStagehandPage` methods:** add a `disposed` flag to guard against the race where a page closes mid-action:

```typescript
private _disposed = false;

async performAction(action: Action): Promise<void> {
  if (this._disposed) {
    throw new StagehandInvalidArgumentError(
      "PlaywrightNativePage: page has been closed.",
    );
  }
  await performNativeAction(this._pwPage, action);
}
```

Set `this._disposed = true` in a `close` listener registered in the constructor:
```typescript
this._pwPage.once("close", () => { this._disposed = true; });
```

---

### `packages/core/lib/v3/understudy/native/PlaywrightNativeContext.ts`

Wraps `BrowserContext`. Caches `PlaywrightNativePage` instances by `playwright.Page` reference.

```typescript
export class PlaywrightNativeContext {
  private _cache = new Map<PlaywrightPage, PlaywrightNativePage>();

  constructor(
    private readonly _browserContext: BrowserContext,
    private readonly _opts: { logger: StagehandLogger },
  ) {}

  wrapPage(pwPage: PlaywrightPage): PlaywrightNativePage {
    if (this._cache.has(pwPage)) return this._cache.get(pwPage)!;
    const wrapped = new PlaywrightNativePage(pwPage, this._opts);
    this._cache.set(pwPage, wrapped);
    // Evict on close to prevent memory leak from accumulating closed-page references
    pwPage.once("close", () => this._cache.delete(pwPage));
    return wrapped;
  }

  getActivePage(): IStagehandPage {
    const pages = this._browserContext.pages();
    if (pages.length === 0) {
      throw new StagehandNotInitializedError(
        "PlaywrightNativeContext.getActivePage(): no pages open in BrowserContext.",
      );
    }
    return this.wrapPage(pages[0]);
  }
}
```

---

### `packages/core/tests/unit/native-page-routing.test.ts`

```typescript
describe("PlaywrightNativeContext", () => {
  it("caches wrapper by page reference", () => {
    const mockPage1 = makeMockPwPage();
    const mockPage2 = makeMockPwPage();
    const ctx = new PlaywrightNativeContext(mockBrowserContext, opts);
    const w1a = ctx.wrapPage(mockPage1);
    const w1b = ctx.wrapPage(mockPage1);
    const w2  = ctx.wrapPage(mockPage2);
    expect(w1a).toBe(w1b);      // same pw.Page → same wrapper
    expect(w1a).not.toBe(w2);   // different pw.Page → different wrapper
  });

  it("evicts closed page from cache", () => {
    const mockPage = makeMockPwPage();
    const ctx = new PlaywrightNativeContext(mockBrowserContext, opts);
    const first = ctx.wrapPage(mockPage);
    mockPage.emit("close");
    const second = ctx.wrapPage(mockPage);
    expect(first).not.toBe(second); // evicted; new wrapper created
  });

  it("getActivePage() wraps the first page", () => {
    const mockPage = makeMockPwPage();
    mockBrowserContext.pages.mockReturnValue([mockPage]);
    const ctx = new PlaywrightNativeContext(mockBrowserContext, opts);
    const active = ctx.getActivePage();
    expect(active).toBeInstanceOf(PlaywrightNativePage);
  });

  it("getActivePage() throws when no pages exist", () => {
    mockBrowserContext.pages.mockReturnValue([]);
    const ctx = new PlaywrightNativeContext(mockBrowserContext, opts);
    expect(() => ctx.getActivePage()).toThrow(StagehandNotInitializedError);
  });
});
```

---

## Files to Modify

### 1. `packages/core/lib/v3/types/private/internal.ts`

Extend `InitState` union. Without this, `this.state = { kind: "PLAYWRIGHT_NATIVE" }` is a compile error.

```typescript
export type InitState =
  | { kind: "UNINITIALIZED" }
  | {
      kind: "LOCAL";
      chrome: LaunchedChrome;
      ws: string;
      userDataDir?: string;
      createdTempProfile?: boolean;
      preserveUserDataDir?: boolean;
    }
  | { kind: "BROWSERBASE"; bb: Browserbase; sessionId: string; ws: string }
  | { kind: "PLAYWRIGHT_NATIVE" };   // ADD THIS
```

---

### 2. `packages/core/lib/v3/types/public/options.ts`

Add `browserContext` field. Also make `env` optional when `browserContext` is provided (see validation note in v3.ts section):

```typescript
import type { BrowserContext } from "playwright-core";

export interface V3Options {
  env: V3Env;
  /**
   * Optional: provide an externally-managed Playwright BrowserContext.
   * When set, Stagehand skips all Chrome/Browserbase launch code and wraps
   * the provided context. The caller is responsible for closing the context.
   * When browserContext is set, env is ignored for launch purposes.
   */
  browserContext?: BrowserContext;
  // ... rest unchanged
}
```

---

### 3. `packages/core/lib/v3/types/public/page.ts`

Add `PlaywrightNativePage` to the `AnyPage` union so `normalizeToV3Page`'s `instanceof` guard compiles:

```typescript
import { PlaywrightNativePage } from "../../understudy/native/PlaywrightNativePage.js";
export type AnyPage = PlaywrightPage | PuppeteerPage | PatchrightPage | Page | PlaywrightNativePage;
```

---

### 4. `packages/core/lib/v3/v3.ts`

**Seven required changes. Do not make any others.**

#### 4a. Add imports (top of file)

```typescript
import { PlaywrightNativeContext } from "./understudy/native/PlaywrightNativeContext.js";
import { PlaywrightNativePage }    from "./understudy/native/PlaywrightNativePage.js";
```

Import directly. Do NOT route through `types/private/index.ts` (barrel re-exports type-only things; adding class constructors there risks circular imports).

#### 4b. Add `nativeCtx` property to class body

```typescript
private nativeCtx: PlaywrightNativeContext | null = null;
```

#### 4c. `init()` — native-mode branch (placement matters)

The handlers (`actHandler`, `extractHandler`, `observeHandler`) are constructed at lines 660-735. The native-mode early-return must go **after** handler construction and **before** the `if (this.opts.env === "LOCAL")` branch (line 736):

```typescript
// After handler construction (~line 735), before env branching:
if (this.opts.browserContext) {
  // Validate: reject ambiguous BROWSERBASE + browserContext combination
  if (this.opts.env === "BROWSERBASE") {
    throw new StagehandInvalidArgumentError(
      "Cannot use browserContext with env: 'BROWSERBASE'. " +
      "Remove browserContext or switch to env: 'LOCAL'.",
    );
  }
  this.nativeCtx = new PlaywrightNativeContext(this.opts.browserContext, {
    logger: this.logger,
  });
  this.state = { kind: "PLAYWRIGHT_NATIVE" };
  return;
}
// ... existing LOCAL / BROWSERBASE paths unchanged at line 736+ ...
```

#### 4d. `resolvePage()` — widen return type + native fallback (placement matters)

The native-mode fallback must come **before** the `this.ctx` null check (it will always be null in native mode):

```typescript
// before
private async resolvePage(page?: AnyPage): Promise<Page>

// after
private async resolvePage(page?: AnyPage): Promise<IStagehandPage> {
  if (page) {
    return await this.normalizeToV3Page(page);
  }
  // Native mode: this.ctx is null; use nativeCtx instead
  if (this.state.kind === "PLAYWRIGHT_NATIVE") {
    return this.nativeCtx!.getActivePage();
  }
  const ctx = this.ctx;
  if (!ctx) {
    throw new StagehandNotInitializedError("resolvePage()");
  }
  return await ctx.awaitActivePage();
}
```

#### 4e. `normalizeToV3Page()` — widen return type + correct branch ordering

```typescript
// before
private async normalizeToV3Page(input: AnyPage): Promise<Page>

// after — PlaywrightNativePage check MUST be first
private async normalizeToV3Page(input: AnyPage): Promise<IStagehandPage> {
  // 1. Already a PlaywrightNativePage — return as-is (MUST be first; it duck-types as PlaywrightPage)
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
  // 4. CDP mode: existing Playwright/Patchright/Puppeteer paths (unchanged)
  if (this.isPlaywrightPage(input)) {
    const frameId = await this.resolveTopFrameId(input);
    const page = this.ctx!.resolvePageByMainFrameId(frameId);
    if (!page) throw new StagehandInitError("Failed to resolve V3 Page from Playwright page.");
    return page;
  }
  if (this.isPatchrightPage(input)) {
    const frameId = await this.resolveTopFrameId(input);
    const page = this.ctx!.resolvePageByMainFrameId(frameId);
    if (!page) throw new StagehandInitError("Failed to resolve V3 Page from Patchright page.");
    return page;
  }
  if (this.isPuppeteerPage(input)) {
    const frameId = await this.resolveTopFrameId(input);
    const page = this.ctx!.resolvePageByMainFrameId(frameId);
    if (!page) throw new StagehandInitError("Failed to resolve V3 Page from Puppeteer page.");
    return page;
  }
  throw new StagehandInvalidArgumentError("Unsupported page object.");
}
```

**IMPORTANT:** Consider replacing the `await import("./understudy/page.js")` dynamic import with a top-level static import to avoid a microtask tick on every `act()`/`observe()`/`extract()` call. Use the existing `import { Page } from "./understudy/page.js"` that is already at the top of the file (line 82).

#### 4f. `close()` — native-mode early-return (MUST come before `apiClient.end()`)

Insert immediately after the `_isClosing` guard (after line 1415), before the CDP transport unhook at line 1424:

```typescript
// After line 1415 (_isClosing = true):
if (this.state.kind === "PLAYWRIGHT_NATIVE") {
  // BrowserContext is owned by the caller; do not close it.
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
  this.extractHandler = null;
  this.observeHandler = null;
  V3._instances.delete(this);
  return;
}
// ... existing CDP transport unhook at line 1424 continues unchanged ...
```

#### 4g. `agent()` — guard all five `this.ctx!` call sites

Lines **1755**, **1769**, **1918**, **1928**, and **1954** must each be guarded. Apply this pattern at each site:

```typescript
// At line 1755 (setActivePage after normalizeToV3Page):
if (this.state.kind !== "PLAYWRIGHT_NATIVE") {
  this.ctx!.setActivePage(normalizedPage);
}

// At line 1769 (awaitActivePage for cache context):
const startPage: IStagehandPage = this.state.kind === "PLAYWRIGHT_NATIVE"
  ? this.nativeCtx!.getActivePage()
  : await this.ctx!.awaitActivePage();

// Apply same pattern at lines 1918, 1928, 1954
```

#### 4h. `mainFrameId()` call sites — guard all six

Lines **1107, 1191, 1303, 1375, 1958, 2092** all call `page.mainFrameId()` on the resolved page. `mainFrameId()` is CDP-only and does not exist on `IStagehandPage`. Apply this guard at each site:

```typescript
if (this.state.kind === "PLAYWRIGHT_NATIVE") {
  throw new StagehandInvalidArgumentError(
    "apiClient path is not supported in PLAYWRIGHT_NATIVE mode. " +
    "Remove the apiClient option or use env: 'LOCAL'/'BROWSERBASE'.",
  );
}
const frameId = (page as Page).mainFrameId();
```

---

### 5. `packages/core/lib/v3/cache/ActCache.ts`

Widen `page` parameter types in `prepareContext` and `tryReplay` from `Page` to `IStagehandPage`. Then audit method bodies:

- If any method calls `Page`-specific methods not on `IStagehandPage` (e.g. `page.mainFrame()`, frame registry, direct CDP calls), wrap with `if (page instanceof Page)` guards.
- `page.captureSnapshot()` is on `IStagehandPage` — safe.
- `page.performAction()` is on `IStagehandPage` — safe.

---

### 6. `packages/core/lib/v3/cache/utils.ts`

`safeGetPageUrl` at line 2 takes `page: Page` (concrete import). Change to `IStagehandPage`:

```typescript
// before
import { Page } from "../understudy/page.js";
export function safeGetPageUrl(page: Page): string { ... }

// after
import type { IStagehandPage } from "../types/private/IStagehandPage.js";
export function safeGetPageUrl(page: IStagehandPage): string { ... }
```

`page.url()` is already on `IStagehandPage`, so the body requires no change.

`waitForCachedSelector` (line 33) calls `page.waitForSelector()`. This is not on `IStagehandPage` in the current interface. Two options:
1. Add `waitForSelector(selector: string, opts?: { timeout?: number }): Promise<void>` to `IStagehandPage`, then implement it in both `Page` (CDP) and `PlaywrightNativePage`.
2. Widen to `IStagehandPage` and cast inside `waitForCachedSelector` for the CDP path.

**Recommended:** option 1 — add `waitForSelector` to `IStagehandPage`. The native implementation uses `this._pwPage.locator(selector).waitFor()`.

---

### 7. `packages/core/lib/v3/handlers/actHandler.ts`

**Type changes only.** Change all `Page`-typed parameters and local variables to `IStagehandPage`. Do NOT add any native dispatch logic — self-heal already calls `page.performAction()` (confirmed at lines 387-392), which routes to `PlaywrightNativePage.performAction()` via the interface. §11 of the original plan is deleted.

---

## Pre-Ship Audit: `evaluate(string)` Call Sites

Before merging, grep for string-expression evaluate calls in handlers:

```bash
grep -rn "\.evaluate(" packages/core/lib/v3/handlers/
grep -rn "\.evaluate(" packages/core/lib/v3/v3.ts
```

Any call of the form `page.evaluate("some string expression", ...)` must be converted to a function:

```typescript
// before
page.evaluate("return document.title")
// after
page.evaluate(() => document.title)
```

These will throw at runtime on `PlaywrightNativePage` (by design — the native evaluate guard makes the failure explicit and fast rather than silent).

---

## Known Limitations (document in code comments, do not fix in Phase 4)

- **`addInitScript` scope:** Delegates to `playwright.Page.addInitScript()` which, in an externally-owned `BrowserContext`, may inject into all pages. Phase 5 will address context-level vs page-level script injection.
- **`nativeCombinedTree.ts` uses `new Function()`:** Blocked by strict CSP pages (`Content-Security-Policy: script-src 'self'`). The CDP path bypasses CSP via `Runtime.evaluate`. Phase 5 camoufox E2E tests may hit this on CSP-strict targets. Do not fix in Phase 4.
- **Snapshot ID format:** CDP path uses hex frame IDs; native path uses ordinal strings (`"0"`, `"1"`). Act cache entries created in CDP mode and replayed in native mode will silently mismatch selectors. Cache keys are URL+instruction-based, so cache misses (not corruption) are the expected outcome. Do not fix in Phase 4.
- **FlowLogger decorators absent:** `PlaywrightNativePage` won't have `@FlowLogger.wrapWithLogging` decorators, so `PagePerformAction` and `PageClose` events will be missing from flow logs in native mode. Acceptable for Phase 4.
- **`env` field still required:** Users must pass `env: "LOCAL"` alongside `browserContext`. This is semantically awkward but harmless — the native-mode check in `init()` fires before any env-based launch code. A future phase can make `env` optional.

---

## Acceptance Criteria

All criteria below must pass before merging.

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm build:esm && pnpm test:core` — no regressions on CDP path
- [ ] `pnpm test:native` passes (includes cache-by-reference, cache eviction, and getActivePage tests)
- [ ] **Smoke:** init Stagehand with `browserContext` pointing to a camoufox page loaded at a real URL (e.g. `https://example.com`). Call `observe("find all links")`. Assert:
  - (a) result is a non-empty array
  - (b) each item has `selector` and `description` string fields
  - (c) at least one selector is non-empty and locatable: `page.locator(selector).count()` returns > 0
- [ ] **Multi-page:** after init with `browserContext`, open a second page via `browserContext.newPage()`. Call `stagehand.act("...", { page: secondPage })`. Assert `nativeCtx.wrapPage(secondPage)` returns a different object from `nativeCtx.wrapPage(firstPage)`, and calling `wrapPage(firstPage)` twice returns the same cached instance.
- [ ] **Non-regression — CDP routing:** pass a `playwright.Page` connected via `newCDPSession` in LOCAL mode (no `browserContext` option). Confirm it resolves to the CDP `Page` class, not `PlaywrightNativePage`. Log `page.constructor.name` in the test to make this explicit.
- [ ] **CDP example:** `pnpm example v3/v3_example.ts` runs without errors.
- [ ] **close() non-ownership:** call `stagehand.close()` in native mode. Confirm the `BrowserContext` is still usable afterward — `await browserContext.pages()[0].title()` must not throw.
- [ ] **extract() in native mode:** call `stagehand.extract({ instruction: "get page title", schema: z.object({ title: z.string() }) })` on a native-mode page. Assert the result has a non-empty `title` field.
- [ ] **apiClient guard:** in native mode, if `apiClient` option is set and `act()` is called, confirm it throws `StagehandInvalidArgumentError` with a message mentioning `"PLAYWRIGHT_NATIVE"` rather than a null-dereference on `mainFrameId()`.
- [ ] **browserContext + BROWSERBASE guard:** `new V3({ env: "BROWSERBASE", browserContext: ctx })` followed by `init()` must throw `StagehandInvalidArgumentError` before attempting any Browserbase API call.

---

## Verification Commands

```bash
# Typecheck
pnpm typecheck

# Build + core tests (CDP regression gate)
pnpm build:esm && pnpm test:core

# Native-mode unit tests
pnpm test:native

# CDP smoke example
pnpm example v3/v3_example.ts

# Find evaluate(string) call sites that need to be converted
grep -rn '\.evaluate(' packages/core/lib/v3/handlers/
grep -rn '\.evaluate(' packages/core/lib/v3/v3.ts

# Confirm no remaining Page-typed params in cache utilities
grep -n 'page: Page' packages/core/lib/v3/cache/utils.ts
grep -n 'page: Page' packages/core/lib/v3/cache/ActCache.ts
```
