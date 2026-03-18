# Stagehand V2 Playwright vs V3 Native: Comparative Analysis

> **Document purpose:** Comprehensive technical comparison of Stagehand's original v2 Playwright implementation against the v3-native Playwright mode introduced in this fork. Includes analysis strategy, mechanistic comparisons, and a balanced pro/con evaluation.
>
> **Ground truth sources:**
> - V2: commit `1a37005f` (deleted Sep 22 2025) — `lib/StagehandPage.ts`, `lib/a11y/utils.ts`, `lib/handlers/actHandler.ts`, `lib/handlers/handlerUtils/actHandlerUtils.ts`
> - V3 Native: this fork's `native-base` branch — `lib/v3/understudy/native/`

---

## 1. Analysis Strategy

### Why a direct comparison is non-trivial

V2 and v3-native both use Playwright — but for categorically different purposes and at different layers. A naive "both call `locator.click()`" comparison misses the architectural differences that matter for correctness, maintainability, and browser compatibility.

The comparison was structured around five concrete questions for each system:

1. **Snapshot source** — How is the DOM+A11y data captured that gets fed to the LLM?
2. **Element addressing** — How are elements identified and referenced across the snapshot → action boundary?
3. **Action dispatch** — How does a resolved action reach the browser?
4. **Frame/shadow handling** — How are iframes and shadow DOM managed?
5. **DOM settling** — How does the system know the page is ready?

Each question was answered by reading primary source code, not documentation. V2 source was extracted from git history (`git show 1a37005f -- <path>`). V3-native was read from the current branch.

### Comparative analysis approach for V2 vs V3-native specifically

V2 was the more complex system to analyze because it was "Playwright with essential CDP augmentation." The key methodological challenge was distinguishing which capabilities came from Playwright vs which required CDP. The analysis approach:

1. **Trace every CDP call**: catalog `CDPSession.send()` calls by domain/method and annotate what they replaced vs what would have been impossible with Playwright alone.
2. **Trace the element lifecycle**: follow a single element from snapshot capture → ID assignment → LLM prompt → selector resolution → locator construction → action execution.
3. **Identify the fallback chains**: v2 has multi-level fallbacks (Playwright click → JS click; standard locator → shadow-aware locator). These represent robustness decisions that carry over directly into a pro/con evaluation.
4. **Identify the settle mechanism precisely**: DOM settlement is the most latency-critical correctness issue. Both systems must answer "when is it safe to snapshot?" and they give different answers.

---

## 2. Architecture Overview

### V2: Playwright-primary, CDP-augmented

```
User API (page.act / page.extract / page.observe)
          │
          ▼
  StagehandPage (Proxy wrapper around playwright.Page)
          │
    ┌─────┴────────────────────────────────────────────┐
    │                                                  │
    ▼                                                  ▼
  Playwright layer                               CDP layer
  (goto, evaluate, locator.*, waitFor*)          (Network.*, DOM.*, Accessibility.*)
    │                                                  │
    ▼                                                  ▼
  Browser control & action dispatch             Snapshot capture + DOM settle
```

V2 held a `rawPage: playwright.Page` internally, wrapped it in a JavaScript `Proxy` that intercepted all method calls, and maintained a CDP session (`CDPSession`) alongside it. The Playwright layer handled all actual browser control. The CDP layer handled snapshot capture, network event tracking, and frame ID management. Neither layer was optional — removing CDP would have broken snapshot capture and DOM settling; removing Playwright would have broken action dispatch and navigation.

### V3-native: Pure Playwright

```
User API (stagehand.act / stagehand.extract / stagehand.observe)
          │
          ▼
  ActHandler / ExtractHandler / ObserveHandler  (unchanged from V3-CDP)
          │
    ┌─────┴────────────────────────────────────────────┐
    │                                                  │
    ▼                                                  ▼
  PlaywrightNativePage (implements IStagehandPage)
          │
    ┌─────┴────────────────────────────────────────────┐
    │                                                  │
    ▼                                                  ▼
  nativeCombinedTree.ts                         nativeActionDispatch.ts
  page.evaluate(DOM walker IIFE)                locator.click/fill/press/...
  captureNativeSnapshot.ts                      page.waitForTimeout (stopgap)
```

V3-native holds a `_pwPage: playwright.Page` and uses only its public API: `page.evaluate()`, `page.frames()`, `page.locator()`, `page.waitForLoadState()`, `page.waitForTimeout()`. No CDP session. No custom selector engine. No init scripts injected into the page.

---

## 3. Snapshot Capture: Line-by-Line Comparison

### V2: CDP `Accessibility.getFullAXTree`

```
lib/a11y/utils.ts:535   → CDPSession.send("Accessibility", "enable", {}, frame)
lib/a11y/utils.ts:568   → CDPSession.send("Accessibility.getFullAXTree", params, session)
lib/a11y/utils.ts:152   → CDPSession.send("DOM.getDocument", { depth: -1, pierce: true })
lib/a11y/utils.ts:1099  → page.evaluate(window.getScrollableElementXpaths)   [injected script]
```

The browser's native accessibility engine runs inside the renderer process. The CDP call returns the engine's output directly — the same data that screen readers consume. This tree already contains:

- Correct ARIA roles (including all implicit mappings, computed states, ARIA overrides)
- Accessible names resolved via the full name computation algorithm
- `aria-hidden` exclusions
- Live region roles
- `aria-expanded`, `aria-checked`, `aria-selected` state attributes
- Backend node IDs that are stable within a session

XPaths are built by a separate DOM tree walk (`DOM.getDocument` → DFS), correlating each accessibility node's `backendDOMNodeId` to its position in the DOM tree.

### V3-native: `page.evaluate()` DOM walker

```
nativeCombinedTree.ts:226  → frame.evaluate(new Function("arg", `return (${INJECTED_SCRIPT_SRC})(arg)`), ...)
```

A 180-line raw JavaScript IIFE string is injected into each frame's JavaScript context. It walks `document.documentElement.children` recursively using a `while` loop over a stack. For each element it computes:

- **Role**: Looked up in a hand-written implicit role table covering ~40 HTML elements, with function-based overrides for context-dependent elements (`<a>`, `<input>`, `<section>`, `<th>`, `<select>`, `<img>`). Falls back to `"generic"`. Does not include: `aria-expanded`, `aria-checked`, `aria-selected`, `aria-hidden`, `aria-disabled`, live regions, computed ARIA patterns.
- **Accessible name**: `aria-labelledby` → `aria-label` → `title` → `textContent` (truncated at 200 chars). Missing: `<label for>` association, button value computation, image alt via accName algorithm steps 2F/2G.
- **XPath**: Built inline during the walk using `previousElementSibling` counting. Always produces `/html[1]/...` absolute paths.

The script must be a raw string to avoid esbuild's `__name` wrapper transformations, which inject Node.js helper references that are not defined in the browser context.

### Comparison table

| Dimension | V2 (CDP AX tree) | V3-native (DOM walker) |
|---|---|---|
| **Source of roles** | Browser's native a11y engine | Hand-written implicit-role table |
| **ARIA state attributes** | ✅ aria-expanded, aria-checked, etc. | ❌ Not captured |
| **aria-hidden exclusion** | ✅ Engine enforces this | ❌ Hidden elements included |
| **Name computation** | ✅ Full accName algorithm | Partial: labelledby→label→title→textContent |
| **`<label for>` association** | ✅ Yes | ❌ Not followed |
| **Custom ARIA roles** | ✅ Via role attribute | ✅ Via `el.getAttribute('role')` |
| **Shadow DOM in snapshot** | ✅ Via `DOM.getDocument(pierce:true)` + CDP | ✅ Via walker recursion into `el.shadowRoot` |
| **Closed shadow roots** | ✅ Via injected `attachShadow` interceptor | ❌ Not accessible |
| **XPath generation** | DOM tree walk correlated by backendNodeId | Inline sibling counting during walk |
| **Frame IDs** | CDP hex frame IDs | Synthetic ordinals (0, 1, 2...) |
| **Performance** | 1 CDP roundtrip per frame (Accessibility.getFullAXTree) | 1 `evaluate()` per frame |
| **Browser support** | Chromium only | Any Playwright target |

---

## 4. Element Addressing

### V2: `EncodedId = frameOrdinal-backendNodeId`

`backendDOMNodeId` is an integer assigned by the Blink rendering engine, stable within a CDP session. It uniquely identifies a DOM node without ambiguity regardless of duplicates in XPath.

```typescript
// lib/StagehandPage.ts:153
public encodeWithFrameId(fid: string | undefined, backendId: number): EncodedId {
  return `${this.ordinalForFrameId(fid)}-${backendId}` as EncodedId;
}
// Example: "0-42", "1-137"
```

The LLM sees `[0-42]` in the simplified tree and can output it directly. At resolve-time, `xpathMap["0-42"]` returns the element's XPath, and that XPath is fed to Playwright's `page.locator("xpath=...")`.

**Properties of backendNodeId addressing:**
- Stable across DOM mutations within the session (the node ID doesn't change if siblings are added/removed)
- Unambiguous (no two nodes share a backendNodeId)
- Not meaningful across page navigations

### V3-native: `encodedId = frameOrdinal-ordinal`

`ordinal` is a sequential integer assigned by the DOM walker during its DFS. It is only meaningful within a single snapshot invocation.

```typescript
// captureNativeSnapshot.ts:27
encodedId: `${frameOrdinal}-${e.ordinal}`,
```

Example: `"0-42"`. If the DOM changes between snapshot and action, ordinal 42 may refer to a different element. The XPath (`combinedXpathMap["0-42"]`) anchors the reference at the structural path level.

**Properties of ordinal addressing:**
- Simple to generate, no CDP required
- Not stable across DOM mutations (ordinal is walk-order-dependent)
- Relies entirely on XPath correctness for post-snapshot identity
- Works identically for any browser engine

---

## 5. Action Dispatch

### V2 dispatch chain

```
LLM output: { method: "click", selector: "xpath=...", args: [] }
    │
    ▼
methodHandlerMap["click"] = clickElement()
    │
    ▼
  1. deepLocator(page, xpath) → playwright.Locator   [or deepLocatorWithShadow in experimental mode]
    │
    ▼
  2. locator.click({ timeout: 3500 })   [Playwright public API]
    │
    ▼  (if fails)
  3. locator.evaluate(el => (el as HTMLElement).click())   [JS fallback]
    │
    ▼  (if still fails)
  4. throw StagehandClickError(xpath, message)
    │
    ▼  (if either 2 or 3 succeeds)
  5. handlePossiblePageNavigation() → _waitForSettledDom()
```

**V2 method dispatch table** (`actHandlerUtils.ts:214-229`):

| LLM method name | Handler function | Primary mechanism |
|---|---|---|
| `click` | `clickElement` | `locator.click()` → `el.click()` JS fallback |
| `fill`, `type` | `fillOrType` | `locator.fill("", force)` → `locator.fill(value, force)` |
| `press` | `pressKey` | `locator.page().keyboard.press(key)` (not element-targeted) |
| `scroll`, `scrollTo`, `mouse.wheel` | `scrollElementToPercentage` | `locator.evaluate(el.scrollTop = ...)` |
| `scrollIntoView` | `scrollElementIntoView` | `locator.evaluate(el.scrollIntoView())` |
| `nextChunk`, `prevChunk` | `scrollToNextChunk/Prev` | `locator.evaluate(scrollBy)` with rAF waits |
| `selectOptionFromDropdown` | `selectOption` | `locator.selectOption(text, {timeout: 5000})` |
| `hover`, `doubleClick`, `dragAndDrop` | `fallbackLocatorMethod` | Dynamic `locator[method]()` call |

The fallback path (`fallbackLocatorMethod`) is significant: any method name the LLM produces that isn't in the explicit dispatch table is checked against the Playwright Locator prototype. If `locator[method]` is a function, it's invoked directly. This makes v2 forward-compatible with any Playwright Locator method without code changes.

### V3-native dispatch

```
LLM output: { method: "click", selector: "xpath=...", args: [] }
    │
    ▼
resolveNativeLocator(page, selector) → playwright.Locator
    │
    ▼
switch(action.method) { case "click": locator.click() }
    │
    ▼  (if fails)
throw StagehandClickError (no JS fallback)
    │
    ▼  (if succeeds)
page.waitForTimeout(action.domSettleTimeoutMs ?? 500)
```

**V3-native method dispatch table** (`nativeActionDispatch.ts`):

| LLM method name | Mechanism | Notes vs V2 |
|---|---|---|
| `click` | `locator.click()` | No JS fallback, no timeout override at call site |
| `fill` | `locator.fill("")` → `locator.fill(value)` | Two-step mirrors V2 |
| `type` | `locator.pressSequentially(value)` | V2 used `locator.fill(force)` for type |
| `press` | `locator.press(key)` | Element-targeted; V2 used `keyboard.press()` (global) |
| `scroll`, `scrollTo` | `locator.evaluate(el.scrollTop=...)` | Identical to V2 |
| `scrollIntoView` | `locator.scrollIntoViewIfNeeded()` | V2 used `evaluate(el.scrollIntoView())` |
| `hover` | `locator.hover()` | V2 used `fallbackLocatorMethod` |
| `doubleClick` | `locator.dblclick()` | V2 used `fallbackLocatorMethod` |
| `nextChunk`, `prevChunk` | `locator.evaluate(scrollBy)` | Same as V2 |
| `selectOption`, `selectOptionFromDropdown` | `locator.selectOption()` | Same as V2 |
| `dragAndDrop` | `locator.dragTo(targetLocator)` | V2 used `fallbackLocatorMethod`; cross-frame not supported |
| `mouse.wheel` | `page.mouse.wheel(0, dy)` | Same as V2 |
| `scrollByPixelOffset` | `locator.evaluate(el.scrollBy)` | V2 used evaluate too |
| Any other | `throw StagehandInvalidArgumentError` | V2 tried `fallbackLocatorMethod` first |

**Critical difference**: V3-native throws immediately on an unknown method; V2 attempted the Playwright Locator method dynamically before throwing. V3-native is more predictable but less flexible.

**`press` key difference**: V2 used `locator.page().keyboard.press(key)` — a *global* keyboard event not tied to element focus. V3-native uses `locator.press(key)` — the event is dispatched to the specific element. This is semantically more correct for focused inputs.

---

## 6. Cross-Frame and Shadow DOM

### V2 iframe handling

**XPath-based frame descent** (`actHandlerUtils.ts:181-208`):

```typescript
const IFRAME_STEP_RE = /^iframe(\[[^\]]+])?$/i;
// When an xpath step matches, descend via frameLocator():
locator = page.frameLocator("xpath=/" + buffer.join("/"));
```

Snapshot-side: per-frame CDP sessions fetch separate AX trees, then per-frame trees are stitched together using `backendDOMNodeId` as the join key (`a11y/utils.ts:1056-1072`). For OOPIFs (out-of-process iframes), a separate CDP session is created via `context.newCDPSession(frame)`.

**Shadow DOM (v2):**

V2 maintains a closed-shadow-root backdoor. An `Element.prototype.attachShadow` interceptor captures all shadow roots (including closed ones) in a `WeakMap` before the page can hide them:

```javascript
// dom/process.ts — injected into every page
const closed = new WeakMap();
const orig = Element.prototype.attachShadow;
Element.prototype.attachShadow = function(init) {
  const root = orig.call(this, init);
  if (init.mode === 'closed') closed.set(this, root);
  return root;
};
window.__stagehand__.getClosedRoot = (host) => closed.get(host);
```

The experimental `deepLocatorWithShadow` function uses this backdoor to pierce closed shadow roots when building locators. Standard `deepLocator` only handles open shadows via Playwright's `>>` selector.

### V3-native iframe handling

`resolveNativeLocator` handles the `>>` iframe-hop syntax and `xpath=` prefix:

```typescript
// nativeLocatorUtils.ts
if (sel.includes(">>")) {
  // Descend into iframes via chained frameLocator calls
}
```

Snapshot-side: `page.frames()` is snapped once, then `frame.evaluate(walker)` runs per frame. Frame stitching uses a heuristic (child frames mapped by ordinal index to `isIframeHost` entries in the parent frame's walker output). This is less precise than CDP's `backendNodeId`-based join — if there are multiple iframes in a parent, matching relies on iteration order.

**Shadow DOM (v3-native):**

The DOM walker recurses into `el.shadowRoot` (open shadows only):

```javascript
if (pierceShadow && el.shadowRoot) {
  var shadowChildren = el.shadowRoot.children;
  // ... walk slot-assigned elements
}
```

Closed shadow roots are inaccessible without the `attachShadow` interceptor that v2 installs. V3-native does not inject any init scripts, so closed shadows are invisible to the snapshot.

---

## 7. DOM Settlement

### V2: CDP network event tracking

`_waitForSettledDom()` (`StagehandPage.ts:588-719`) is a sophisticated CDP-based network monitor:

1. Enables `Network`, `Page`, and `Target.setAutoAttach` CDP domains.
2. Maintains an `inflight: Set<string>` of in-flight request IDs via `Network.requestWillBeSent` / `Network.loadingFinished` events.
3. Runs a 500ms stall sweep: any `Document` request open for >2s is force-removed (prevents analytics/ad iframes from blocking forever).
4. When `inflight.size === 0`, starts a 500ms quiet-window timer.
5. If no new request arrives in 500ms, resolves — DOM is considered settled.
6. Hard timeout (default 30s): logs warning and resolves anyway.

**Filtering**: WebSocket and Server-Sent-Events connections are excluded from the inflight count (they're long-lived by design).

This mechanism is called:
- After every `page.goto()`
- After every action method via `handlePossiblePageNavigation()`
- Before every `observe()` and `extract()` snapshot

### V3-native: `page.waitForTimeout(500ms)`

```typescript
// nativeActionDispatch.ts:242
await page.waitForTimeout(action.domSettleTimeoutMs ?? 500).catch(() => {});
```

This is an explicit Phase 5 TODO in the source. It is called after every action dispatch. It does not:
- Track network requests
- Detect navigations
- Handle stalled iframes
- Distinguish between a settled page and a page actively loading

For navigation-triggering actions (clicking a link, submitting a form), 500ms may be insufficient. For pages with heavy async content, it may fire before content loads. For simple interactions with no navigation, it's an unnecessary 500ms penalty.

The `PlaywrightNativePage.waitForNetworkIdle()` method uses `page.waitForLoadState("networkidle")`, which is semantically closer to v2's approach — but this is not called automatically after actions, only when handlers explicitly invoke it before snapshots.

---

## 8. The Injected Script: V2's Key Capability

V2 installs a guard-checked init script into every page it manages:

```typescript
// StagehandPage.ts:164
const guardedScript = `if (!window.__stagehandInjected) {
  window.__stagehandInjected = true;
  ${scriptContent}
}`;
await this.rawPage.addInitScript({ content: guardedScript });
await this.rawPage.evaluate(guardedScript);
```

`scriptContent` provides:
- `window.__stagehand__.getClosedRoot(host)` — closed shadow DOM access
- `window.__stagehand__.queryClosed(host, selector)` — shadow-aware querySelector
- `window.__stagehand__.xpathClosed(host, xpath)` — shadow-aware XPath evaluation
- `window.getScrollableElementXpaths()` — used during snapshot to annotate scrollable elements
- `window.getNodeFromXpath(xpath)` — used by actHandlerUtils to validate selectors
- `waitForElementScrollEnd()` — used by scroll actions to wait for scroll animation completion

V3-native injects nothing. The DOM walker is passed as a raw JS string to `frame.evaluate()` on demand (not installed as an init script). This means:
- No persistent state in the page's JS context
- No memory leak risk from accumulated weak-map entries
- Closed shadow roots are inaccessible
- No scroll-end detection (the walker captures a point-in-time snapshot)

---

## 9. Pro/Con Analysis: V3-Native vs V2

### V3-Native Advantages

**1. Browser universality — the core motivation**

V2's CDP usage makes it Chromium-only. Specifically: `context.newCDPSession()` throws on Firefox/WebKit ("CDP session is only available in Chromium"). Every v2 feature that touches CDP — snapshot, DOM settling, frame management — fails on non-Chromium targets. V3-native works on any browser Playwright supports: Firefox (including camoufox), WebKit, and any Playwright server endpoint.

**2. Architectural cleanliness**

V2 maintained two parallel communication channels to the same browser: a Playwright channel and a CDP WebSocket. These could and did diverge (e.g., CDP frame IDs out of sync after navigation, requiring the `Page.frameNavigated` listener to update the `frameIdMap`). V3-native has one communication path. There is no state to synchronize.

**3. No page pollution**

V2 installs an `attachShadow` interceptor and `window.__stagehand__` namespace into every page. This can affect:
- Pages that feature-detect `attachShadow` behavior
- Pages that inspect `Element.prototype.attachShadow` for security auditing
- Any page that happens to define `window.__stagehand__`

V3-native injects nothing. The DOM walker runs in an isolated evaluate call and leaves no trace in the page's JS environment.

**4. Zero CDP session overhead**

V2 creates a CDP session per page and per OOPIF iframe. Each session involves a WebSocket handshake and protocol negotiation. V3-native creates none. On pages with many cross-origin iframes, the session creation overhead in v2 is measurable.

**5. Simpler maintenance surface**

V3-native's 7 new files totaling ~850 lines of production code implement all four phases (interface, snapshot, actions, context). V2's equivalent surface was ~3,300 lines across `StagehandPage.ts`, `a11y/utils.ts`, `actHandlerUtils.ts`, and `actHandler.ts`, with tight coupling between DOM tree walk, CDP sessions, XPath generation, and locator resolution.

**6. No init script lifecycle issues**

V2 had to guard against re-injection (`window.__stagehandInjected` check), handle the case where `addInitScript` hadn't fired yet (calling `evaluate` directly), and manage script invalidation after navigation. V3-native evaluates the walker on demand — there is no persistent state to manage.

---

### V3-Native Disadvantages

**1. Weaker accessibility tree quality**

This is the most significant functional gap. V2 receives the browser's native accessibility engine output via `Accessibility.getFullAXTree`. The engine runs in the renderer process with access to the full CSS computed style, ARIA state machine, and label association algorithm. V3-native's hand-written implicit role table:

- Covers ~40 HTML elements; the ARIA specification defines implicit roles for over 80 semantic elements
- Does not compute `aria-expanded`, `aria-checked`, `aria-selected`, `aria-disabled` states
- Does not exclude `aria-hidden="true"` subtrees from the snapshot
- Does not implement the full Accessible Name and Description Computation (ANDC) algorithm — specifically missing `<label for>` associations, button value computation (step 2F), and embedded control values (step 2E)
- Does not handle live regions (`aria-live`, `aria-atomic`)

In practice, the quality gap is most visible on:
- Form pages with `<label for>` associations (inputs will have empty names)
- Widgets using `aria-expanded` to signal open/closed state (LLM sees only the base role)
- Pages with `aria-hidden` decorative sections (LLM snapshot includes noise)

**2. No closed shadow DOM access**

V2's `attachShadow` interceptor captures every shadow root including closed ones. V3-native's walker can only recurse into `el.shadowRoot` — which is `null` for closed roots. Web components that use closed shadow mode (common in enterprise design systems) will be invisible to the v3-native snapshot.

**3. Fragile DOM settling**

`waitForTimeout(500ms)` is the weakest possible settle mechanism. It breaks in both directions:
- **Too slow**: On non-navigating interactions (clicking a toggle, hovering a tooltip), 500ms is wasted latency. V2's quiet-window approach resolves in under 100ms for interactions that don't trigger network activity.
- **Too fast**: For link clicks, form submissions, or JavaScript-triggered navigations, 500ms may elapse before the new page's DOM is ready. V2 tracks network requests and waits until they quiesce.

Until Phase 5 replaces this with a proper settle implementation (equivalent to `waitForDomNetworkQuiet`), v3-native will have both latency and correctness issues on navigation-triggering actions.

**4. No click fallback**

V2's click handler attempts `locator.click()` first, then falls back to `element.click()` via JavaScript evaluation. `element.click()` bypasses Playwright's actionability checks (visibility, scrollIntoView) and fires the click event directly on the DOM node. This is useful for elements that fail Playwright's actionability checks (partially obscured, inside scroll containers, non-standard interactive elements).

V3-native throws `StagehandClickError` if `locator.click()` fails. On pages where Playwright's synthetic click is flaky, this is a behavioral regression.

**5. Heuristic iframe stitching**

V2 uses `backendDOMNodeId` to precisely join child frame trees to their parent iframe element. V3-native uses an ordinal-based heuristic: the Nth child frame is assumed to correspond to the Nth `isIframeHost` entry in the parent frame's walker output. If a page has multiple iframes and they load in non-sequential order, the stitching may correlate the wrong subtree to the wrong iframe placeholder in the combined tree.

**6. Unknown method throws immediately**

V2's `fallbackLocatorMethod` checks `locator[method]` before throwing, allowing any Playwright Locator method to be invoked by the LLM without being listed in the dispatch table. V3-native throws `StagehandInvalidArgumentError` for any method not in the switch statement. If the LLM generates a method name not in the table, v3-native fails where v2 might have succeeded.

**7. No FlowLogger integration (Phase 4 known gap)**

V3-native action dispatch does not emit FlowLogger events (`PagePerformAction`, `PageClose`). This means observability tooling that relies on flow logs will show gaps in the native execution path. V2 had no FlowLogger (it predated it), so this isn't a regression against v2, but it is a regression against the CDP-v3 path.

---

## 10. Compatibility Matrix

| Feature | V2 | V3-CDP | V3-Native |
|---|---|---|---|
| Chromium (local) | ✅ | ✅ | ✅ |
| Firefox / camoufox | ❌ | ❌ | ✅ |
| WebKit | ❌ | ❌ | ✅ |
| Browserbase | ✅ | ✅ | ❌ (by design) |
| External BrowserContext | ✅ | ❌ | ✅ |
| Native A11y tree | ✅ | ✅ | ⚠️ (approximated) |
| Closed shadow DOM | ✅ | ✅ | ❌ |
| aria-hidden/state attributes | ✅ | ✅ | ❌ |
| Network-based DOM settle | ✅ | ✅ | ❌ (Phase 5 TODO) |
| Click JS fallback | ✅ | ✅ | ❌ |
| FlowLogger events | N/A | ✅ | ❌ (Phase 4 gap) |
| iframe correlation accuracy | ✅ (backendNodeId) | ✅ (backendNodeId) | ⚠️ (ordinal heuristic) |
| Page JS pollution | ✅ (injected) | ✅ (injected) | ✅ (none) |

---

## 11. Paths to Close the Gaps

The three gaps that matter most for functional correctness in Phase 5:

**Gap 1: DOM settling** — Replace `waitForTimeout(500ms)` with a Playwright-API equivalent of `waitForDomNetworkQuiet`. The closest Playwright equivalent is:

```typescript
await page.waitForLoadState("networkidle");   // Playwright's built-in: ≥500ms with ≤2 connections
```

This is not identical to v2's custom implementation (which filters WebSockets and stalled iframes) but is substantially better than a fixed timeout. `PlaywrightNativePage.waitForNetworkIdle()` already implements this — it just needs to be called by `performNativeAction` for navigation-triggering actions. A post-action heuristic (check if URL changed after action, if so call `networkidle`) would cover most cases.

**Gap 2: Accessible name quality** — The `<label for>` association gap is the highest-impact single fix. It affects every standard HTML form. Fix in `nativeCombinedTree.ts`:

```javascript
// In getAccessibleName(el):
var id = el.getAttribute('id');
if (id) {
  var label = document.querySelector('label[for="' + id + '"]');
  if (label) return truncate(label.textContent.trim());
}
```

**Gap 3: `aria-hidden` exclusion** — Add a check in the walker's `walk()` function:

```javascript
if (el.getAttribute('aria-hidden') === 'true') return;
```

This alone would clean up a significant amount of noise in the LLM's snapshot on pages that use `aria-hidden` for decorative or off-screen elements.

Closed shadow DOM access requires the `attachShadow` interceptor, which means injecting an init script — a conscious decision about page pollution. This should be an opt-in option rather than a default.

---

## 12. Summary Verdict

V2's Playwright implementation was architecturally "Playwright-primary, CDP-augmented." It used Playwright for all action dispatch and navigation, but relied on CDP for the two most technically demanding pieces: snapshot capture (native accessibility engine) and DOM settling (network event tracking). Its shadow DOM handling was particularly sophisticated, using an `attachShadow` interceptor to access closed roots that are normally inaccessible.

V3-native is genuinely zero-CDP, making it the first implementation that works on Firefox and any Playwright-server target. It achieves this by accepting lower fidelity in snapshot quality (hand-written role table vs. native engine) and weaker DOM settling (fixed timeout vs. network event tracking). These are the correct engineering trade-offs for the goal — camoufox compatibility — but they are trade-offs, not free improvements.

The accessibility quality gap is the most important to address in Phase 5 and beyond. An LLM that sees incomplete or noisy accessibility data will produce worse selectors, leading to higher self-repair rates and lower first-attempt success. The `<label for>` fix and `aria-hidden` exclusion are the highest-leverage single changes to close that gap.

For pages that consist primarily of standard HTML (buttons, inputs, links, headings, paragraphs), v3-native's snapshot quality is adequate. For pages with heavy ARIA widget patterns, custom form label associations, or closed shadow components, it will underperform V2's CDP-native snapshot in first-attempt action success rate.
