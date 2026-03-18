# Stagehand Playwright-Native Mode: Testing Guide

**Purpose:** Everything needed to set up the test environment and verify each phase of the Playwright-native implementation. Complete this setup before writing any code.

---

## Table of Contents

1. [Environment Snapshot](#1-environment-snapshot)
2. [Pre-Development Setup](#2-pre-development-setup)
3. [Verification: Baseline Passes Before Any Changes](#3-verification-baseline-passes-before-any-changes)
4. [Test Infrastructure to Create Before Dev Starts](#4-test-infrastructure-to-create-before-dev-starts)
5. [Phase-by-Phase Testing](#5-phase-by-phase-testing)
6. [Quick Reference: All Test Commands](#6-quick-reference-all-test-commands)

---

## 1. Environment Snapshot

Recorded state of this machine at planning time. Use as reference.

| Component | Version / Location | Status |
|---|---|---|
| Node.js | v24.11.1 | ✓ installed |
| pnpm | 9.15.0 | ✓ installed |
| playwright-core | 1.58.2 | ✓ installed in repo |
| Chromium (Playwright) | chromium-1208 | ✓ cached at `~/.cache/ms-playwright/chromium-1208/` |
| Firefox (Playwright) | firefox-1454 | ✓ cached at `~/.cache/ms-playwright/firefox-1454/` |
| camoufox CLI | cloverlabs-camoufox 0.5.5 (pipx) | ✓ installed at `~/.local/bin/camoufox` |
| camoufox browser | coryking/stable/142.0.1-fork.26 | ✓ fetched at `~/.cache/camoufox/` |
| camoufox Playwright version | 1.58.0 | ✓ matches playwright-core 1.58.2 |
| OPENAI_API_KEY | not set | ✗ needed for Phase 5 |
| `.env` file | not present | ✗ needed for Phase 5 |

---

## 2. Pre-Development Setup

Complete every item in this section before writing any implementation code. Each item is marked with the phase(s) it unblocks.

---

### 2.1 Install dependencies [All Phases]

```bash
cd /home/joenathan/stagehand
pnpm install --frozen-lockfile
```

This installs `playwright-core@1.58.2` (already pinned in `packages/core/package.json` on `native-base`), `tsx`, `vitest`, and all workspace dependencies.

**Verify:**
```bash
ls packages/core/node_modules/playwright-core/package.json  # must exist
node -e "const v = require('./packages/core/node_modules/playwright-core/package.json').version; console.log('playwright-core:', v)"
# Expected: playwright-core: 1.58.2
```

---

### 2.2 Verify Chromium is accessible [Phases 2, 3, 4]

Playwright downloads its own Chromium separately from any system Chrome. The `test:core` suite does not need a browser, but the Phase 2 smoke tests and Phase 3 action tests launch a real Chromium.

```bash
# Confirm the Playwright-managed Chromium exists
ls ~/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
# Expected: file exists

# Quick functional check — launch headless, load a page, exit
node -e "
const { chromium } = require('./packages/core/node_modules/playwright-core');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  await p.goto('https://example.com');
  console.log('Chromium OK:', await p.title());
  await b.close();
})();
"
# Expected: Chromium OK: Example Domain
```

If Chromium is missing or broken:
```bash
cd packages/core && npx playwright install chromium
```

---

### 2.3 Verify camoufox is ready [Phase 5]

camoufox is installed via `pipx install cloverlabs-camoufox` and manages its own browser binary.

```bash
# Confirm CLI is on PATH
which camoufox
# Expected: /home/joenathan/.local/bin/camoufox

# Confirm active browser version
camoufox active
# Expected: official/stable/142.0.1-fork.26  (or newer)

# Confirm the browser binary exists
camoufox path
# Expected: path to the installed browser directory

# Check Playwright version bundled with camoufox
camoufox version
# Look for: Playwright  v1.58.x
# This MUST match playwright-core version in packages/core/package.json
```

**Version mismatch handling:** If `camoufox version` shows a different Playwright version than `playwright-core` in the repo, update `playwright-core` in `packages/core/package.json` to match and re-run `pnpm install`. A mismatch causes a `428 Precondition Required` WebSocket error — already encountered and documented in §2 of `PLAYWRIGHT_NATIVE_PLAN.md`.

**Start a camoufox server for testing:**
```bash
# In a separate terminal — keep this running during Phase 5 tests
camoufox server
# Outputs a ws:// URL, e.g.:
# ws://localhost:42797/9e2abceb2cbd8d8595f441890e50815f
# Copy this URL — needed in Stage 3 of camoufox_test.ts
```

The port and path are randomly generated each time. Update the `WS_ENDPOINT` constant in `packages/core/examples/v3/camoufox_test.ts` with the current URL before running Phase 5 tests.

---

### 2.4 Create the `.env` file [Phase 5]

Phase 5 requires a real LLM call. The `OPENAI_API_KEY` is the minimum required.

```bash
cp .env.example .env
```

Then edit `.env` and set at minimum:
```
OPENAI_API_KEY="sk-..."
```

Anthropic is a good fallback if OpenAI is unavailable:
```
ANTHROPIC_API_KEY="sk-ant-..."
```

The model used in `camoufox_test.ts` defaults to `openai/gpt-4.1-mini`. Change to `anthropic/claude-haiku-4-5` in the test file if using Anthropic.

**Verify the key is set:**
```bash
source .env && echo "OPENAI_API_KEY is ${#OPENAI_API_KEY} chars"
# Expected: OPENAI_API_KEY is 51 chars  (or similar non-zero)
```

> Note: Phases 1–4 do **not** require an API key. Only Phase 5 (camoufox E2E) calls an LLM.

---

### 2.5 Confirm the baseline test suite passes [All Phases]

Before any changes, record the baseline. If tests are failing before you start, you cannot tell whether a later failure is yours or pre-existing.

```bash
cd packages/core
pnpm build:esm 2>&1 | tail -3
pnpm test:core 2>&1 | tail -5
```

**Expected output:**
```
 Test Files  40 passed (40)
       Tests  534 passed (534)
   Duration  ~5s
```

Save the exact counts. If this run shows failures, investigate and resolve them before starting development.

---

### 2.6 Confirm TypeScript compiles cleanly [All Phases]

```bash
cd packages/core
pnpm typecheck 2>&1 | tail -5
# Expected: no output (clean exit, code 0)
echo "exit code: $?"
# Expected: exit code: 0
```

If there are pre-existing type errors, note them. Any new errors introduced during development are yours.

---

### 2.7 Run the existing camoufox probe [Phase 5 baseline]

With camoufox server running (§2.3), confirm Stages 1 and 2 of the existing probe work correctly. This is the baseline before adding Stage 3.

```bash
# Update WS_ENDPOINT in the file first, then:
cd packages/core
pnpm example v3/camoufox_test
```

**Expected output:**
```
[STAGE 1] PASS — basic Playwright connection works.
[STAGE 2] FAIL — CDP bridge threw: CDP session is only available in Chromium
[STAGE 2] Stagehand's current Playwright bridge is Chromium-only and will NOT work as-is.
```

Stage 2 failing is **correct and expected**. That is the problem this entire project exists to solve. Stage 3 does not run yet (it's guarded by Stage 2's result).

---

## 3. Verification: Baseline Passes Before Any Changes

Run this full checklist and record results before committing a single line of implementation code:

```bash
cd /home/joenathan/stagehand/packages/core

# 1. TypeScript compiles clean
pnpm typecheck
echo "typecheck exit: $?"           # must be 0

# 2. ESM build succeeds
pnpm build:esm
echo "build exit: $?"               # must be 0

# 3. All 534 unit tests pass
pnpm test:core
echo "test:core exit: $?"           # must be 0

# 4. camoufox probe baseline (requires camoufox server running)
pnpm example v3/camoufox_test
# Stage 1 must PASS, Stage 2 must FAIL (expected), Stage 3 must not run
```

If all four pass, you have a clean baseline. Commit the baseline state (already done on `native-base`).

---

## 4. Test Infrastructure to Create Before Dev Starts

These test helpers should be created on `native-base` before Phase 1 development begins. They are not implementation code — they are scaffolding that the phase tests depend on.

---

### 4.1 `MockPlaywrightPage` helper

The existing `MockCDPSession` lets unit tests stub CDP calls without a real browser. The native path needs an equivalent for `playwright.Page`. Create this file before writing any Phase 2 or 3 tests.

**Location:** `packages/core/tests/unit/helpers/mockPlaywrightPage.ts`

```typescript
import type { Page, Frame, BrowserContext, Accessibility } from "playwright-core";

type EvalFn = (selector: string, ...args: unknown[]) => Promise<unknown>;

export interface MockPageOpts {
  url?: string;
  title?: string;
  /** Map of selector → visible text, used by evaluate stubs */
  content?: Record<string, string>;
  /** Pre-canned accessibility snapshot */
  a11ySnapshot?: Accessibility.AccessibilitySnapshotResult;
  /** Pre-canned evaluate results keyed by a string tag you provide */
  evaluateResults?: unknown[];
}

export class MockPlaywrightPage {
  private _url: string;
  private _title: string;
  private _a11ySnapshot: Accessibility.AccessibilitySnapshotResult | null;
  private _evaluateResults: unknown[];
  private _evaluateCallCount = 0;
  public readonly calls: Array<{ method: string; args: unknown[] }> = [];

  constructor(opts: MockPageOpts = {}) {
    this._url = opts.url ?? "https://example.com";
    this._title = opts.title ?? "Example Domain";
    this._a11ySnapshot = opts.a11ySnapshot ?? null;
    this._evaluateResults = opts.evaluateResults ?? [];
  }

  url() { return this._url; }
  async title() { return this._title; }

  async goto(url: string) {
    this.calls.push({ method: "goto", args: [url] });
    this._url = url;
  }

  async evaluate(fn: unknown, ...args: unknown[]) {
    this.calls.push({ method: "evaluate", args: [fn, ...args] });
    const result = this._evaluateResults[this._evaluateCallCount] ?? null;
    this._evaluateCallCount++;
    return result;
  }

  async waitForLoadState(state?: string) {
    this.calls.push({ method: "waitForLoadState", args: [state] });
  }

  async screenshot() {
    this.calls.push({ method: "screenshot", args: [] });
    return Buffer.from([]);
  }

  frames(): Frame[] { return [this.mainFrame()]; }
  mainFrame(): Frame { return this as unknown as Frame; }
  context(): BrowserContext { return {} as BrowserContext; }

  get accessibility(): Pick<Accessibility, "snapshot"> {
    return {
      snapshot: async () => this._a11ySnapshot,
    };
  }

  locator(selector: string) {
    this.calls.push({ method: "locator", args: [selector] });
    return new MockLocator(selector, this.calls);
  }

  callsFor(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

export class MockLocator {
  constructor(
    public readonly selector: string,
    private readonly calls: Array<{ method: string; args: unknown[] }>,
  ) {}

  async click(opts?: unknown) { this.calls.push({ method: "locator.click", args: [this.selector, opts] }); }
  async fill(value: string, opts?: unknown) { this.calls.push({ method: "locator.fill", args: [this.selector, value, opts] }); }
  async selectOption(values: unknown, opts?: unknown) { this.calls.push({ method: "locator.selectOption", args: [this.selector, values, opts] }); }
  async hover(opts?: unknown) { this.calls.push({ method: "locator.hover", args: [this.selector, opts] }); }
  async dblclick(opts?: unknown) { this.calls.push({ method: "locator.dblclick", args: [this.selector, opts] }); }
  async scrollIntoViewIfNeeded(opts?: unknown) { this.calls.push({ method: "locator.scrollIntoViewIfNeeded", args: [this.selector, opts] }); }
  async setInputFiles(files: unknown, opts?: unknown) { this.calls.push({ method: "locator.setInputFiles", args: [this.selector, files, opts] }); }
  async evaluate(fn: unknown, ...args: unknown[]) { this.calls.push({ method: "locator.evaluate", args: [this.selector, fn, ...args] }); }
  async boundingBox() { return { x: 10, y: 20, width: 100, height: 30 }; }
  async isVisible() { return true; }
}
```

**Verify it compiles:**
```bash
pnpm typecheck
```

---

### 4.2 Vitest config for native browser tests

The existing `vitest.esm.config.mjs` runs `dist/esm/tests/unit/**/*.test.js` — fast, no browser, pure unit tests. Phase 3 action dispatch tests need a real Chromium instance, which is slower and should be isolated so it doesn't slow the main `test:core` suite.

**Location:** `packages/core/vitest.native.config.mjs`

```javascript
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@browserbasehq/stagehand": path.join(rootDir, "dist", "esm", "index.js"),
    },
  },
  test: {
    environment: "node",
    include: ["**/dist/esm/tests/native/**/*.test.js"],
    // Native tests launch real browsers — give them more time
    testTimeout: 30000,
    hookTimeout: 15000,
    // Run sequentially to avoid browser resource contention
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
```

Add a script to `packages/core/package.json`:
```json
"test:native": "pnpm build:esm && vitest run --config vitest.native.config.mjs"
```

Source tests go in `packages/core/tests/native/`. They compile to `dist/esm/tests/native/` via the ESM build.

**Verify the config is valid:**
```bash
cd packages/core && node -e "import('./vitest.native.config.mjs').then(() => console.log('config OK'))"
```

---

### 4.3 Simple Chromium fixture helper

Phase 3 action tests need a reusable way to spin up a real Chromium page with specific HTML content. Create this shared fixture:

**Location:** `packages/core/tests/native/helpers/chromiumFixture.ts`

```typescript
import type { Browser, BrowserContext, Page } from "playwright-core";

let browser: Browser | undefined;
let context: BrowserContext | undefined;

export async function getChromiumPage(html: string): Promise<Page> {
  const { chromium } = await import("playwright-core");
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  if (!context) {
    context = await browser.newContext();
  }
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  return page;
}

export async function closeChromiumFixture(): Promise<void> {
  await context?.close();
  await browser?.close();
  browser = undefined;
  context = undefined;
}
```

---

### 4.4 Create the `tests/native/` source directory

```bash
mkdir -p packages/core/tests/native/helpers
touch packages/core/tests/native/helpers/.gitkeep
```

This directory must exist for the build to pick up native tests. Add it to the ESM build's include paths if it doesn't pick up automatically (check `scripts/build-esm.ts` to confirm it processes `tests/` directories).

---

## 5. Phase-by-Phase Testing

---

### Phase 1 — Interface Extraction

**What's being built:** `IStagehandPage` interface, `Page` implements it, all handlers updated to use `IStagehandPage`.

**What can go wrong:** Type mismatches — a handler still references a concrete `Page` method that isn't on the interface.

**Primary verification tool: TypeScript compiler**

```bash
# Inner loop during development — run this after every change
cd packages/core && pnpm typecheck
```

Every type error is a concrete problem at a specific file and line. Fix until clean.

**Regression check after Phase 1 is complete:**
```bash
pnpm build:esm && pnpm test:core
# Must still show: 534 passed
```

**Acceptance criteria:**
- `pnpm typecheck` exits 0
- `pnpm test:core` shows 534 passed (same as baseline)
- No new files in `understudy/native/` yet — this phase is purely plumbing

**No new tests needed for Phase 1.** The TypeScript compiler is the test.

---

### Phase 2 — Native Snapshot Implementation

**What's being built:** `captureNativeSnapshot`, `nativeDomTree`, `nativeA11yTree` — all in `understudy/native/snapshot/`.

**What can go wrong:**
- `page.evaluate()` script throws inside the browser
- `page.accessibility.snapshot()` returns a different shape than expected
- Encoded IDs in the snapshot don't round-trip correctly (LLM gets an ID, lookup fails)
- Combined tree text is malformed — LLM can't parse it

#### 5.2.1 Unit tests (no browser needed)

These use `MockPlaywrightPage` to test each component in isolation.

**File:** `packages/core/tests/unit/native-snapshot-dom-tree.test.ts`

Tests to write:
- Given a mock `page.evaluate()` that returns a known DOM node list, `captureNativeDomTree()` builds the correct `xpathMap`
- Encoded IDs are of the form `ordinal-index` (e.g., `0-1`, `0-2`)
- XPath strings are valid (start with `/`, no empty segments)
- Multi-frame: given `page.frames()` returning two frames with separate evaluate results, the maps are merged without ID collisions

**File:** `packages/core/tests/unit/native-snapshot-a11y-tree.test.ts`

Tests to write:
- Given a mock `page.accessibility.snapshot()` result, `captureNativeA11yTree()` returns a tree with the correct role/name structure
- Encoded IDs assigned are sequential and unique
- `interestingOnly: false` is passed (ensure all nodes captured, not just actionable ones)

**Run:**
```bash
pnpm build:esm && pnpm test:core
# New tests appear in the count alongside the existing 534
```

#### 5.2.2 Smoke test against real Chromium (no LLM needed)

Create a script that runs the native snapshot against a real page and prints the result. This visually confirms the tree format makes sense.

**File:** `packages/core/examples/v3/native_snapshot_smoke.ts`

```typescript
import { chromium } from "playwright-core";
import { captureNativeSnapshot } from "../../lib/v3/understudy/native/snapshot/captureNativeSnapshot.js";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("https://example.com");

  const snapshot = await captureNativeSnapshot(page);

  console.log("=== Combined Tree (first 2000 chars) ===");
  console.log(snapshot.combinedTree.slice(0, 2000));
  console.log("\n=== XPath map entries ===");
  const entries = Object.entries(snapshot.combinedXpathMap);
  console.log(`Total: ${entries.length} entries`);
  entries.slice(0, 10).forEach(([id, xpath]) => console.log(`  ${id} → ${xpath}`));

  await browser.close();
})();
```

```bash
cd packages/core && pnpm example v3/native_snapshot_smoke
```

**What to look for:**
- Tree text contains recognizable elements (`h1`, `p`, `a`, role descriptions)
- XPath map has 5–30 entries for a simple page like example.com
- No entries with empty or `undefined` selectors
- IDs look like `0-1`, `0-2`, etc.

#### 5.2.3 Observe smoke test (needs LLM)

Once the smoke test looks reasonable, verify the full path to `observe()`:

```typescript
// In camoufox_test.ts or a new script
const stagehand = new Stagehand({ browserContext: context, model: "openai/gpt-4.1-mini" });
await stagehand.init();
const obs = await stagehand.observe({ page });
console.log("observe results:", obs);
// Expected: array of { description, selector } objects for example.com's link
```

**Acceptance criteria for Phase 2:**
- Unit tests added for dom tree and a11y tree components
- `pnpm test:core` count increases (new tests added)
- Smoke script prints a coherent tree
- `observe()` returns at least one result on example.com

---

### Phase 3 — Native Action Dispatch

**What's being built:** `performNativeAction` dispatch table in `understudy/native/actions/nativeActionDispatch.ts`.

**What can go wrong:**
- Frame resolution logic is wrong — action fires on main frame when it should fire in an iframe
- Selector format mismatch — snapshot produced `xpath=...` but dispatch expects CSS
- Method name mismatch between what the LLM returns and what the dispatch table handles

#### 5.3.1 Unit tests with `MockLocator`

These test the dispatch logic without any browser.

**File:** `packages/core/tests/unit/native-action-dispatch.test.ts`

Tests to write:
```typescript
// Each method: does dispatch call the right locator method with the right args?
it("click dispatches to locator.click", async () => {
  const page = new MockPlaywrightPage();
  await performNativeAction(page as any, { method: "click", selector: "#btn", args: {} });
  expect(page.callsFor("locator.click")).toHaveLength(1);
  expect(page.callsFor("locator").args[0]).toBe("#btn");
});

// Cover: click, fill, type, selectOption, hover, doubleClick,
//        scrollIntoView, press, setInputFiles, scroll
// Also: unknown method throws StagehandInvalidArgumentError
```

```bash
pnpm build:esm && pnpm test:core
```

#### 5.3.2 Integration tests against real Chromium

These verify each action actually has the intended effect in a browser.

**File:** `packages/core/tests/native/action-dispatch-integration.test.ts`

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { getChromiumPage, closeChromiumFixture } from "./helpers/chromiumFixture.js";
import { performNativeAction } from "../../lib/v3/understudy/native/actions/nativeActionDispatch.js";

afterAll(closeChromiumFixture);

describe("performNativeAction — click", () => {
  it("fires a click event", async () => {
    const page = await getChromiumPage(`
      <button id="btn">click me</button>
      <div id="result"></div>
      <script>document.getElementById("btn").onclick = () => document.getElementById("result").textContent = "clicked";</script>
    `);
    await performNativeAction(page, { method: "click", selector: "#btn", args: {} });
    expect(await page.locator("#result").textContent()).toBe("clicked");
  });
});

describe("performNativeAction — fill", () => {
  it("sets input value", async () => {
    const page = await getChromiumPage(`<input id="inp" type="text" />`);
    await performNativeAction(page, { method: "fill", selector: "#inp", args: { value: "hello" } });
    expect(await page.locator("#inp").inputValue()).toBe("hello");
  });
});

// ... repeat for: type, selectOption, hover, scroll, press, setInputFiles
```

```bash
cd packages/core && pnpm test:native
```

**Acceptance criteria for Phase 3:**
- All unit tests pass (`pnpm test:core` count increases)
- All integration tests pass on Chromium (`pnpm test:native`)
- `pnpm test:core` baseline still passes (no regressions)
- XPath selectors (e.g., `xpath=//button[@id='btn']`) are also tested — not just CSS

---

### Phase 4 — Context Integration

**What's being built:** `PlaywrightNativePage`, `PlaywrightNativeContext`, `browserContext` option in `V3Options`, updated `V3.init()` and `normalizeToV3Page`.

**What can go wrong:**
- `normalizeToV3Page` doesn't detect the native mode and falls through to the CDP branch (which calls `newCDPSession` and fails)
- `PlaywrightNativeContext.wrapPage()` called on the same Playwright page twice returns two different `PlaywrightNativePage` instances (should return the same one — cache it by reference)
- State machine in `V3.init()` enters wrong state

#### 5.4.1 Unit tests for routing

**File:** `packages/core/tests/unit/native-page-routing.test.ts`

Tests to write:
```typescript
// normalizeToV3Page routes to PlaywrightNativePage when browserContext option present
it("wraps playwright.Page when in native mode", async () => {
  const mockContext = { /* minimal BrowserContext stub */ };
  const mockPage = new MockPlaywrightPage();
  const stagehand = new Stagehand({ browserContext: mockContext, model: "openai/gpt-4.1-mini" });
  // Don't call init() — test routing logic directly on the private method
  // Use (stagehand as any).normalizeToV3Page(mockPage)
  const result = await (stagehand as any).normalizeToV3Page(mockPage);
  expect(result).toBeInstanceOf(PlaywrightNativePage);
});

// wrapPage returns same instance for same playwright.Page reference
it("caches wrapped pages by reference", async () => {
  const nativeCtx = new PlaywrightNativeContext(mockBrowserContext);
  const pw = new MockPlaywrightPage();
  const a = nativeCtx.wrapPage(pw as any);
  const b = nativeCtx.wrapPage(pw as any);
  expect(a).toBe(b);  // same reference
});
```

```bash
pnpm build:esm && pnpm test:core
```

#### 5.4.2 Observe smoke test against real Chromium (no LLM)

This is the primary integration acceptance test for Phase 4. It verifies the complete chain — from `new Stagehand({ browserContext })` through to a real observe result — without camoufox and without an LLM call.

**Note:** `observe()` without LLM means calling the snapshot path only. You can call `stagehand.observe()` with a mock LLM client (return a fixed response) or check if the snapshot itself is what you want by looking at the internal state. Alternatively, use a real API key here if you have one — this is a single cheap call.

The quickest verification — just confirm `observe()` doesn't throw and returns an array:
```typescript
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("https://example.com");

const stagehand = new Stagehand({
  browserContext: context,
  model: "openai/gpt-4.1-mini",
});
await stagehand.init();
const obs = await stagehand.observe({ page });
console.log("Phase 4 observe result:", obs);
assert(Array.isArray(obs), "observe must return array");
```

**Acceptance criteria for Phase 4:**
- `pnpm typecheck` clean
- `pnpm test:core` 534+ passed (routing unit tests added)
- `pnpm test:native` still passes
- Observe smoke script returns array without throwing
- CDP path untouched: run `pnpm example v3/v3_example.ts` or any existing LOCAL example to confirm Chromium via CDP still works

---

### Phase 5 — Camoufox End-to-End

**What's being built:** Stage 3 of `camoufox_test.ts` wired up, any Juggler-specific gaps fixed.

**Requires:** camoufox server running, `OPENAI_API_KEY` set in `.env`.

#### 5.5.1 Pre-flight checklist

Before running Phase 5 tests:

```bash
# 1. camoufox server running in a separate terminal
camoufox server
# Note the ws:// URL

# 2. Update WS_ENDPOINT in the test file
# packages/core/examples/v3/camoufox_test.ts, line 17:
# const WS_ENDPOINT = "ws://localhost:XXXXX/...";

# 3. API key available
source /home/joenathan/stagehand/.env
echo "Key length: ${#OPENAI_API_KEY}"  # must be non-zero

# 4. playwright-core version matches camoufox server
camoufox version  # note Playwright: v1.58.x
node -e "console.log(require('./packages/core/node_modules/playwright-core/package.json').version)"
# Both must be 1.58.x
```

#### 5.5.2 Update camoufox_test.ts Stage 3

The existing Stage 3 stub in `camoufox_test.ts` tries `cdpUrl: WS_ENDPOINT` (which will fail because it's a Playwright server, not a raw CDP endpoint). Replace it with:

```typescript
async function stage3(pwPage: ...) {
  const stagehand = new Stagehand({
    browserContext: pwPage.context(),  // the key change
    model: "openai/gpt-4.1-mini",
    verbose: 1,
  });
  await stagehand.init();
  // ... rest of stage 3 unchanged
}
```

#### 5.5.3 Run the full probe

```bash
cd packages/core && source ../../.env && pnpm example v3/camoufox_test
```

**Expected full output:**
```
[STAGE 1] PASS — basic Playwright connection works.
[STAGE 2] FAIL — CDP bridge threw: CDP session is only available in Chromium
[STAGE 2] (this is expected — we are bypassing the CDP bridge)

[STAGE 3] Stagehand init OK.
[STAGE 3] Running stagehand.observe() with the camoufox page …
[STAGE 3] observe() returned N elements.
[STAGE 3] Running stagehand.extract() …
[STAGE 3] extract() result: "Example Domain"
[STAGE 3] PASS — full Stagehand integration works with camoufox!
```

#### 5.5.4 Gap-fixing loop

If Stage 3 fails, the error message identifies the specific gap. Common expected issues and their locations:

| Error | Likely cause | Where to fix |
|---|---|---|
| `snapshot is null` | `page.accessibility.snapshot()` returns null in Firefox | `nativeA11yTree.ts` — add fallback to DOM-only snapshot |
| `Locator.click: Timeout` | Selector format wrong — snapshot produced XPath but dispatch not prefixing `xpath=` | `nativeLocatorUtils.ts` — ensure `xpath=` prefix on all XPath selectors |
| `page.frames() cross-origin error` | Firefox blocking cross-origin frame access | `captureNativeSnapshot.ts` — wrap per-frame evaluate in try/catch |
| `unsupported method: scroll` | Scroll method variant not in dispatch table | `nativeActionDispatch.ts` — add missing method |
| `act() returned no action` | Combined tree text is empty or malformed | `captureNativeSnapshot.ts` — debug snapshot output |

Each fix goes in `understudy/native/`, re-run `pnpm example v3/camoufox_test` after each fix. The loop is fast.

#### 5.5.5 Final regression check

After Stage 3 passes, run the full suite one more time to confirm nothing regressed:

```bash
pnpm typecheck
pnpm build:esm && pnpm test:core
pnpm test:native
# All three must pass
```

Then run an existing LOCAL (CDP/Chromium) example to confirm the CDP path is still intact:
```bash
# requires OPENAI_API_KEY
pnpm example v3/patchright.ts  # or any simple v3 example
```

---

## 6. Quick Reference: All Test Commands

```bash
# From packages/core/ unless noted

# ── Type checking (fastest, no build) ────────────────────────────────────────
pnpm typecheck                          # ~10s, no browser, no API key

# ── Build ─────────────────────────────────────────────────────────────────────
pnpm build:esm                          # ~15s, required before test:core

# ── Unit tests (no browser, no API key) ───────────────────────────────────────
pnpm test:core                          # ~30s total, 534+ tests

# ── Native browser tests (real Chromium, no API key) ──────────────────────────
pnpm test:native                        # ~60s, launches headless Chromium

# ── Snapshot smoke (real Chromium, no API key) ────────────────────────────────
pnpm example v3/native_snapshot_smoke   # prints tree to stdout

# ── camoufox probe (requires: camoufox server + OPENAI_API_KEY) ───────────────
source ../../.env && pnpm example v3/camoufox_test

# ── Full regression suite ─────────────────────────────────────────────────────
pnpm typecheck && pnpm build:esm && pnpm test:core && pnpm test:native

# ── Start camoufox server (in separate terminal) ──────────────────────────────
camoufox server
# Then copy the ws:// URL into camoufox_test.ts WS_ENDPOINT constant
```

### Inner loop by phase

| Phase | Inner loop command | What it catches |
|---|---|---|
| 1 — Interface | `pnpm typecheck` | All type mismatches |
| 2 — Snapshot | `pnpm build:esm && pnpm test:core` | Logic errors in tree building |
| 3 — Actions | `pnpm build:esm && pnpm test:native` | Wrong dispatch, bad selectors |
| 4 — Context | `pnpm typecheck && pnpm build:esm && pnpm test:core` | Wiring errors |
| 5 — Camoufox | `pnpm example v3/camoufox_test` | Firefox-specific gaps |
