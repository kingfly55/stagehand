# Closing the Snapshot Quality Gap: Research & Proposals

> **Question:** Can we reach V2-level accessibility tree quality (roles, names, states, aria-hidden, iframes, shadow DOM) in our V3-native Firefox/camoufox implementation, without using CDP?
>
> **Short answer:** Yes — Playwright itself has already built a pure-JavaScript accessibility engine that handles everything V2's CDP path handled. The path to parity is adopting that engine rather than maintaining our own hand-written role table.

---

## Part 1 — Simple Summary (Read This First)

### The core problem

Our V3-native snapshot uses a hand-written DOM walker that approximates the browser's accessibility tree. V2 used CDP's `Accessibility.getFullAXTree` — the browser's actual native engine. The gap matters because the LLM uses the snapshot to choose elements. Worse data → worse element selection → more self-repair calls → higher cost and latency.

### What we found

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  The native a11y engine via CDP is Chromium-only — that's the V2 blocker.   │
│                                                                              │
│  BUT: Playwright has already reimplemented the W3C accessibility spec       │
│  entirely in JavaScript (roleUtils.ts + ariaSnapshot.ts, ~1,200 lines).    │
│  This runs inside any browser including Firefox and camoufox.               │
│                                                                              │
│  It is exposed as: page.snapshotForAI()  [Playwright current version]      │
│  And internally as: injected.generateAriaTree(element, { mode: 'ai' })     │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Gap comparison: current vs achievable

| Gap | V3-native today | Best achievable | Method |
|---|---|---|---|
| Implicit ARIA roles | ~40 elements, hand-written | Full W3C spec coverage | Method A, B, or C |
| `aria-expanded`, `aria-checked` etc. | ❌ Missing | ✅ Included | Method A, B, or C |
| `aria-hidden` exclusion | ❌ Not filtered | ✅ Filtered | Method A, B, or C |
| `<label for>` name association | ❌ Not followed | ✅ Full accname-1.1 | Method A or B |
| Closed shadow DOM | ❌ Invisible | ✅ With init script | Method D (add-on) |
| DOM settle accuracy | ⚠️ Fixed 500ms timeout | ✅ Network-idle based | Method E (separate) |
| Iframe tree correlation | ⚠️ Ordinal heuristic | ✅ Ref-based | Method A or B |
| XPath mappings | ✅ Working | ✅ Working | All methods |
| Firefox/camoufox support | ✅ Yes | ✅ Yes | All methods |

### Recommended path at a glance

```
Phase 5 (now):  Method C — augment our walker with 4 targeted fixes
                → ~50 lines of code, closes the highest-impact gaps
                → No external dependencies, same architecture

Post-Phase 5:   Method A — adopt page.snapshotForAI() ref-based approach
                → Replace DOM walker entirely with Playwright's own engine
                → True parity with V2 quality, all browsers
```

---

## Part 2 — What We Researched and How

### Research strategy

Four parallel research threads were run simultaneously:

| Thread | Question | Method |
|---|---|---|
| 1 | Playwright accessibility API status in Firefox | Web search + Playwright source read |
| 2 | In-page JS libraries (axe-core, dom-accessibility-api) | Web search + source analysis |
| 3 | Firefox RDP, camoufox, WebDriver BiDi accessibility | Web search + protocol docs |
| 4 | Playwright's internal ARIA implementation | Playwright GitHub source read |

### The discovery chain

1. `page.accessibility.snapshot()` was **cross-browser** (including Firefox) and was removed in Playwright 1.57 — but it was not using the native accessibility engine on Firefox either. It ran injected JS.

2. Its replacement `locator.ariaSnapshot()` (Playwright 1.41+) also runs injected JS and is fully cross-browser — but returns only a YAML string with no element references.

3. Internally, Playwright added `mode: 'ai'` to its ARIA snapshot engine which adds `[ref=eN]` to every interactable element. This is exposed as `page.snapshotForAI()`.

4. After a `snapshotForAI()` call, you can use `page.locator('aria-ref=eN')` to act on any element from the snapshot.

5. The underlying engine (`roleUtils.ts` + `ariaSnapshot.ts`, ~1,200 lines in Playwright's `packages/injected/src/`) implements the full W3C ARIA role resolution and accname-1.1 algorithm in JavaScript — including `aria-hidden` exclusion, state attributes, `<label for>` associations, shadow DOM slot composition, and iframes.

6. **CDP `Accessibility.getFullAXTree` on Firefox**: Permanently WONTFIX (Firefox Bugzilla #1549419). Will never be available.

7. **Firefox native tree via RDP**: Firefox has `AccessibilityActor` with `AccessibleWalkerActor` that exposes the true native OS-level accessibility tree, but requires a separate RDP TCP connection that cannot be established against a Playwright-managed browser instance.

8. **WebDriver BiDi accessibility**: Not in spec, not implemented, aspirational only (w3c/webdriver-bidi issue #443 still open).

---

## Part 3 — Proposed Methods

### Method A — Adopt `page.snapshotForAI()` with ref-based locators

**What it is:**

Replace our DOM walker with Playwright's internal ARIA engine by calling `page.snapshotForAI()` and using `aria-ref` locators for actions.

**How it works:**

```typescript
// Snapshot step
const { full: yamlString } = await page.snapshotForAI();
// yamlString contains [ref=e1], [ref=e2] etc. on every interactable element

// Parse YAML → HybridSnapshot (new parser needed)
// For each ref, compute XPath to populate combinedXpathMap:
const xpathMap = await page.evaluate(() => {
  // Use the same ref→element map that Playwright built internally
  // page.snapshotForAI() stores refs in the injected script's state
  // accessible via aria-ref locator
});

// Action step — use aria-ref locator
await page.locator('aria-ref=e3').click();
// This locator resolves via the stored ref→Element map inside the injected script
```

In practice, XPath generation requires one additional `evaluate` per element (or a batched version). The YAML → `HybridSnapshot` conversion requires a YAML parser and a tree formatter.

**What it fixes:**

All V2 gaps: roles (full W3C), names (full accname-1.1 including `<label for>`), states (`aria-expanded`, `aria-checked`, `aria-selected`), `aria-hidden` exclusion, iframe handling (ref-based, not ordinal heuristic), shadow DOM (via Playwright's slot composition). Works on every Playwright target including camoufox.

**The catch:**

`page.snapshotForAI()` is not in Playwright's public documented API. It appears in the TypeScript types and is used by Playwright's own MCP tools, but the docs do not cover it. It could be renamed or changed in a future Playwright version without a deprecation notice.

Additionally, `aria-ref` locators are only valid for the duration of a snapshot session — refs are invalidated when the snapshot is next taken or when the page navigates. This is fine for the snapshot→act pattern (we always snapshot before each action), but requires careful lifecycle management.

**Complexity:** Medium. Requires a YAML parser (add `js-yaml` or write a simple parser), a YAML→HybridSnapshot converter, and updating `captureNativeSnapshot.ts` to call `snapshotForAI()`. Action dispatch remains unchanged.

---

### Method B — Use Playwright's injected `ariaSnapshot.ts` directly via `evaluateInUtility`

**What it is:**

Call Playwright's internal `injected.generateAriaTree(element, { mode: 'ai' })` function directly via the `evaluateInUtility` mechanism, bypassing the public API entirely.

**How it works:**

Playwright already exposes its injected script to page handlers via `this._mainContext.evaluateInUtility(...)`. The `generateAriaTree` function from `ariaSnapshot.ts` is part of the injected script bundle. Calling it returns a structured `AriaNode` tree with the `elements` Map (ref→Element).

In the same `evaluateInUtility` call, serialize the tree into our `HybridSnapshot` format and compute XPaths inline using the same sibling-counting algorithm our current walker uses.

```typescript
// In captureNativeSnapshot.ts — single evaluate call
const snapshot = await (page as any)._mainContext.evaluateInUtility(
  ([injected, rootEl]: [InjectedScript, Element]) => {
    const tree = injected.generateAriaTree(rootEl, { mode: 'ai' });
    // walk tree.root to build flat array of { ref, role, name, states, xpath }
    // return serializable plain object
  }, rootElement
);
```

This approach never crosses the Playwright private API boundary at the public method level — it uses the same mechanism Playwright uses internally for all its selector engines and snapshot functions.

**What it fixes:** Same as Method A — full coverage.

**The catch:** Deeply internal API usage. `_mainContext` is not public. The injected script bundle changes with every Playwright release. A Playwright minor version bump could change the internal API surface and break this without any public changelog notice.

**Complexity:** High. Requires understanding Playwright's internal architecture, careful typing, and a test strategy that validates the integration on each Playwright version bump.

---

### Method C — Augment the existing DOM walker (targeted high-impact fixes)

**What it is:**

Keep the DOM walker architecture but fix the four highest-impact gaps in the injected JS string inside `nativeCombinedTree.ts`. No external libraries, no Playwright private APIs.

**The four fixes, in priority order:**

**Fix 1 — `<label for>` association** (~10 lines in `getAccessibleName`):
```javascript
var id = el.getAttribute('id');
if (id) {
  var lbl = document.querySelector('label[for="' + id + '"]');
  if (lbl) { var t = lbl.textContent.trim(); if (t) return truncate(t); }
}
```
Impact: Fixes accessible names for all standard HTML form inputs. High frequency on most web pages.

**Fix 2 — `aria-hidden` subtree exclusion** (~3 lines at start of `walk`):
```javascript
if (el.getAttribute('aria-hidden') === 'true') return;
```
Impact: Removes decorative and off-screen content from the snapshot. Reduces LLM noise significantly on pages with modals, overlays, and screen-reader-hidden content.

**Fix 3 — ARIA state attributes** (~8 lines per node in `entries.push`):
```javascript
expanded: el.getAttribute('aria-expanded'),    // 'true'/'false'/null
checked: el.getAttribute('aria-checked'),      // 'true'/'false'/'mixed'/null
selected: el.getAttribute('aria-selected'),    // 'true'/'false'/null
disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
```
Impact: Expands/collapses, checked states, selected items. Critical for menus, dropdowns, accordions.

**Fix 4 — Extend implicit role table** (~15 elements missing from our current 40):
Add: `abbr`, `b`, `blockquote`, `caption`, `dd`, `dfn`, `dl`, `dt`, `em`, `i`, `kbd`, `mark`, `pre`, `q`, `s`, `samp`, `small`, `strong`, `sub`, `sup`, `u`, `var`. These are primarily text semantics that affect how content is described to the LLM.

**Total addition:** ~50 lines to the injected JS string. Zero new dependencies. Backward-compatible.

**What it fixes:** The 3 highest-impact gaps (`<label for>`, `aria-hidden`, states). Does NOT fix: `::before`/`::after` pseudo-element names, `aria-owns` reordering, closed shadow DOM, or full accname-1.1 edge cases.

**Complexity:** Low. All changes are inside the `INJECTED_SCRIPT_SRC` string in `nativeCombinedTree.ts`.

---

### Method D — Restore the `attachShadow` interceptor for closed shadow DOM

**What it is:**

Install an `Element.prototype.attachShadow` interceptor as an init script — the same technique V2 used — to capture closed shadow roots before pages can hide them.

**How it works:**

```typescript
// In PlaywrightNativeContext constructor, or in PlaywrightNativePage:
await this._pwPage.addInitScript(`
  (function() {
    const _closed = new WeakMap();
    const _orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
      const root = _orig.call(this, init);
      if (init && init.mode === 'closed') _closed.set(this, root);
      return root;
    };
    window.__stagehandClosedRoot = (host) => _closed.get(host) || null;
  })();
`);
```

Then in the DOM walker, add closed-root piercing:
```javascript
if (pierceShadow) {
  var openRoot = el.shadowRoot;
  var closedRoot = window.__stagehandClosedRoot && window.__stagehandClosedRoot(el);
  var shadowRoot = openRoot || closedRoot;
  if (shadowRoot) { /* walk shadow children */ }
}
```

**What it fixes:** Closed shadow DOM components (common in enterprise web apps, design systems like SAP, Salesforce, ServiceNow). Does not affect open shadow DOM (already handled).

**The tradeoff:** Installs code into every page, modifying `Element.prototype.attachShadow`. This is the same tradeoff V2 made — acceptable for automation contexts but should be opt-in (`pierceShadow: 'including-closed'` option).

**Complexity:** Low-medium. Add init script to `PlaywrightNativeContext`, update walker to use it.

---

### Method E — Replace `waitForTimeout` DOM settle with network-idle

**What it is:**

Replace the `page.waitForTimeout(500ms)` post-action settle with Playwright's `page.waitForLoadState('networkidle')` for navigation-triggering actions, and keep a short timeout for non-navigating actions.

**How it works:**

```typescript
// After dispatching action, detect if navigation occurred:
const urlBefore = page.url();
await dispatchAction();
const urlAfter = page.url();

if (urlAfter !== urlBefore) {
  // Navigation happened — wait for network idle
  await page.waitForLoadState('networkidle', { timeout: domSettleTimeoutMs ?? 30_000 })
    .catch(() => {}); // timeout is acceptable
} else {
  // No navigation — short fixed wait
  await page.waitForTimeout(action.domSettleTimeoutMs ?? 200).catch(() => {});
}
```

Playwright's `networkidle` waits for ≥500ms with ≤2 open network connections — semantically equivalent to V2's custom quiet-window logic, just slightly less granular (V2 also filtered WebSockets and stale iframes).

**What it fixes:** Post-navigation action reliability. Eliminates the 500ms penalty on non-navigating interactions. Removes the risk of acting on a half-loaded DOM after link clicks or form submissions.

**Complexity:** Low. Small change in `nativeActionDispatch.ts`.

---

### Method F — Firefox native accessibility via parallel RDP connection

**What it is:**

Connect a separate RDP client (Python `geckordp` or Node.js `foxdriver`) to Firefox's remote debugger port and use `AccessibilityActor.getWalker()` + recursive `AccessibleWalkerActor.children()` calls to retrieve the true native OS-level accessibility tree.

**The protocol:**
```
1. Launch Firefox with --start-debugger-server 6000 (RDP port)
2. Connect geckordp/foxdriver on port 6000 in parallel with Playwright's Juggler
3. navigate to AccessibilityActor → AccessibleWalkerActor
4. Recursively call children() to build full tree
5. Map Firefox-native roles (pushbutton→button, checkbutton→checkbox, etc.) to ARIA
```

Firefox's `AccessibilityActor` accesses the real `nsIAccessible` / `nsIAccessibleDocument` platform accessibility tree — the same data that screen readers consume on the OS level. This is the closest Firefox equivalent to Chrome's `Accessibility.getFullAXTree`.

**Why it doesn't work for camoufox:**

- camoufox is launched by Playwright. We do not control the Firefox launch flags — we cannot inject `--start-debugger-server 6000`.
- Even if the port were open, Playwright's patched Firefox binary may have the RDP server disabled in its build.
- Recursive `children()` calls over RDP for a 200-node page would require 200+ network roundtrips, making it orders of magnitude slower than a single `page.evaluate()` call.
- Firefox RDP returns platform-native property names (Firefox-internal, not ARIA) that require a separate role-mapping table.

**Verdict:** Theoretically correct, practically not viable for camoufox. Could work for a regular Firefox instance where you control launch flags, but then you already have CDP available on Chromium.

**Complexity:** Very high. Not recommended.

---

## Part 4 — Comparison Table

### Method comparison

| Method | Quality vs V2 | Complexity | Playwright stability | Firefox/camoufox | Recommended phase |
|---|---|---|---|---|---|
| **A** — `snapshotForAI()` refs | ≈ Parity | Medium | ⚠️ Internal API | ✅ Yes | Post-Phase 5 |
| **B** — Direct injected call | ≈ Parity | High | ❌ Deep internal | ✅ Yes | Avoid |
| **C** — Augment walker (4 fixes) | ~85% of V2 | Low | ✅ Stable | ✅ Yes | **Phase 5 now** |
| **D** — `attachShadow` interceptor | Closed shadow parity | Low-Med | ✅ Stable | ✅ Yes | Phase 5 (opt-in) |
| **E** — Network-idle settle | DOM settle parity | Low | ✅ Stable | ✅ Yes | **Phase 5 now** |
| **F** — Firefox RDP | True native engine | Very High | N/A | ❌ camoufox N/A | Not recommended |

### Gap coverage by method (✅ = closes gap, ⚠️ = partial, ❌ = does not close)

| Gap | Method A | Method B | Method C | Method D | Method E |
|---|---|---|---|---|---|
| Full implicit role table | ✅ | ✅ | ⚠️ (+15 more tags) | — | — |
| `aria-hidden` exclusion | ✅ | ✅ | ✅ | — | — |
| `aria-expanded/checked/selected` | ✅ | ✅ | ✅ | — | — |
| `<label for>` association | ✅ | ✅ | ✅ | — | — |
| Full accname-1.1 (edge cases) | ✅ | ✅ | ⚠️ (common cases) | — | — |
| Closed shadow DOM | ✅ | ✅ | ❌ | ✅ | — |
| Iframe correlation accuracy | ✅ | ✅ | ❌ | — | — |
| DOM settle post-navigation | — | — | — | — | ✅ |
| Fixed 500ms penalty removed | — | — | — | — | ✅ |

---

## Part 5 — The `page.snapshotForAI()` Deep Dive

This is the key finding that enables Method A, so it warrants detailed explanation.

### What it is

In recent Playwright versions, the team added an AI-optimized snapshot mode for use by Playwright's own MCP tools. The public surface:

```typescript
// page.snapshotForAI(options?)
const { full: yamlString } = await (page as any).snapshotForAI();
```

The YAML output (example):
```yaml
- banner:
  - heading "Example Domain" [level=1]
  - link "More information..." [ref=e1]
- main:
  - paragraph "This domain is for use in illustrative examples."
  - paragraph [ref=e2]:
    - text: "You may use this domain in literature"
  - button "Submit" [ref=e3] [disabled]
  - textbox "Email" [ref=e4] [active]
  - checkbox "Subscribe" [ref=e5] [checked]
  - combobox "Country" [ref=e6] [expanded]
```

Every interactable or visible element gets a `[ref=eN]` tag. After this call:

```typescript
// Act on any element by ref — no XPath needed
await page.locator('aria-ref=e4').fill('user@example.com');
await page.locator('aria-ref=e3').click();
```

### What the engine computes

The injected `roleUtils.ts` + `ariaSnapshot.ts` implements:

| Feature | Detail |
|---|---|
| Implicit roles | Full W3C HTML-AAM table — covers ~80+ elements vs our ~40 |
| Explicit `role` override | `role` attribute always wins (modulo presentational inheritance) |
| `aria-hidden` exclusion | Hidden subtrees excluded from tree |
| State attributes | `aria-expanded`, `aria-checked`, `aria-selected`, `aria-disabled`, `aria-pressed` all included |
| Accessible name | Full accname-1.1: `aria-labelledby` → `aria-label` → `<label for>` → native HTML label → subtree text |
| Shadow DOM | Open shadow roots pierced; slot distribution resolved |
| iframes | Frame refs included (format: `[ref=f1e2]`) |
| `display:none` / `visibility:hidden` | Excluded from snapshot |
| `aria-owns` reordering | Handled in tree construction |

### The ref lifecycle

Refs are stable across multiple `snapshotForAI()` calls on the same page if the role+name combination hasn't changed. When the page navigates, refs are invalidated. The `aria-ref=eN` selector engine inside Playwright's injected script resolves refs via a `Map<string, Element>` stored in the isolated utility world — it does not survive page navigation.

For the snapshot→act→snapshot pattern (which is exactly what Stagehand does), ref lifecycle is not an issue.

### API stability assessment

`page.snapshotForAI()` is used by Playwright's own MCP integration (`packages/playwright-mcp/`) and by the Playwright Trace Viewer. It is not going away, but it could be renamed or have its signature changed because it isn't in the public docs. The safe wrapper pattern:

```typescript
async function captureAriaSnapshot(page: playwright.Page): Promise<string> {
  // Try the AI snapshot API first (Playwright ~1.52+)
  if (typeof (page as any).snapshotForAI === 'function') {
    const { full } = await (page as any).snapshotForAI();
    return full;
  }
  // Fallback: standard ariaSnapshot on main locator
  return page.locator('body').ariaSnapshot();
}
```

The `locator.ariaSnapshot()` fallback returns the same YAML format but without `[ref=eN]` annotations, meaning you'd need to use `getByRole` + `getByLabel` queries to act on elements rather than refs.

---

## Part 6 — Recommended Implementation Path

### Phase 5 (immediate, low risk)

Implement Methods C and E. These are small, targeted, and self-contained.

**Method C — 4 targeted walker fixes:**

In `nativeCombinedTree.ts`, inside the `INJECTED_SCRIPT_SRC` string:

1. Add `<label for>` lookup in `getAccessibleName(el)` — before the `textContent` fallback
2. Add `aria-hidden` early-return at top of `walk(el)` — before the ordinal increment
3. Add state attributes to the `entries.push({...})` object: `expanded`, `checked`, `selected`, `disabled`
4. Extend `IMPLICIT_ROLES` with ~15 missing semantic elements

Estimated: ~50 lines of changes in one file. All inside an existing string constant.

**Method E — Network-idle settle:**

In `nativeActionDispatch.ts`, replace the `waitForTimeout` at the end of `performNativeAction` with a URL-change detection + conditional `waitForLoadState('networkidle')`.

Estimated: ~15 lines of changes in one file.

### Post-Phase 5 (after camoufox E2E confirmed working)

**Method A — Adopt `page.snapshotForAI()` with ref-based locators:**

This is a more significant refactor but closes all remaining gaps. Implementation steps:

1. Write `captureAriaSnapshot()` wrapper with `snapshotForAI()` + `ariaSnapshot()` fallback
2. Write a YAML→HybridSnapshot converter (parse Playwright's YAML format into our `combinedTree`, `combinedXpathMap`, `perFrame` fields)
3. For XPath mapping: after `snapshotForAI()`, run one `evaluate()` call over the refs to compute XPaths for `combinedXpathMap`. Alternatively, switch the selector system to use `aria-ref` strings directly rather than XPaths — this is cleaner but requires updating `nativeActionDispatch.ts` to resolve `aria-ref=eN` locators instead of `xpath=...` locators.
4. Update `PlaywrightNativePage.captureSnapshot()` to call the new path
5. Keep the DOM walker as a fallback for older Playwright versions

Estimated: 200-300 lines across 3-4 files.

**Method D — `attachShadow` interceptor (opt-in):**

Add as an optional `pierceShadow: 'including-closed'` mode in `SnapshotOptions`. The interceptor is installed in `PlaywrightNativePage` constructor when the option is set, and the walker uses `window.__stagehandClosedRoot` if available.

Estimated: ~40 lines.

---

## Part 7 — What CDP's `Accessibility.getFullAXTree` Gives That Nothing Else Does

For completeness: these are the capabilities that only the browser's native accessibility engine provides and that no JavaScript implementation can fully replicate.

| Capability | Native engine | Best JS alternative | Gap |
|---|---|---|---|
| `::before`/`::after` pseudo-element content in names | ✅ | ⚠️ `getComputedStyle(el, '::before').content` exists but is not implemented by any library | Rare in practice |
| `display: contents` role resolution | ✅ | ⚠️ Handled by Playwright's `roleUtils.ts` | Small edge case |
| Platform-native roles (StaticText, InlineTextBox) | ✅ | ❌ No JS equivalent | Not needed by LLMs |
| AT-invisible text runs (inline formatting) | ✅ | ❌ | Not needed by LLMs |
| `aria-owns` reordering | ✅ | ✅ Playwright handles | Closed |
| All ARIA-AAM implicit role mappings | ✅ | ✅ Playwright handles | Closed |
| All accname-1.1 steps | ✅ | ✅ ~96% (Playwright/dom-accessibility-api) | Very minor edge cases |

The practical gap between Playwright's JS engine and the native CDP engine is small for LLM use cases. The LLM does not need StaticText or InlineTextBox nodes. It needs: interactive element roles, accessible names for inputs and buttons, state attributes, and link text. All of these are covered by Methods A/C.

---

## Appendix — What We Ruled Out and Why

| Approach | Why ruled out |
|---|---|
| CDP `Accessibility.getFullAXTree` on Firefox | WONTFIX — Firefox Bugzilla #1549419 |
| WebDriver BiDi accessibility module | Not in spec, not implemented (w3c/webdriver-bidi #443) |
| Firefox RDP `AccessibilityActor` | Cannot connect to Playwright-managed/camoufox browser; recursive children() calls too slow |
| axe-core tree walk | Output is violation-organized, not tree-organized. Internal APIs fragile. |
| `dom-accessibility-api` alone | Name computation only, no role computation, no tree structure |
| `aria-query` alone | Static data tables only, no DOM access |
| Method B (deep injected script access) | Too fragile — private Playwright internals |
| Reimplement full accname-1.1 in INJECTED_SCRIPT_SRC | ~800 lines for full compliance; better to use Playwright's existing impl |
