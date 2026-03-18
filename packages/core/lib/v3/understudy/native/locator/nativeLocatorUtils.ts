import * as playwright from "playwright-core";

/**
 * Resolves a selector to a Playwright Locator, handling `>>` hop notation for
 * iframe traversal (mirroring resolveLocatorWithHops in deepLocator.ts).
 *
 * Known limitations:
 * - Does not handle deep XPath iframe steps (e.g. `/html/body/iframe[1]/html/body/div`).
 *   Native mode requires `>>` hop notation in selectors for iframe traversal.
 * - `>>` within CSS attribute selectors (e.g. `[data-id="a>>b"]`) will split
 *   incorrectly — this is a pre-existing limitation shared with the CDP path.
 */
export function resolveNativeLocator(
  page: playwright.Page,
  selector: string,
): playwright.Locator {
  const parts = selector
    .split(">>")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 1) {
    return page.locator(parts[0]!);
  }
  let fl = page.frameLocator(parts[0]!);
  for (let i = 1; i < parts.length - 1; i++) {
    fl = fl.frameLocator(parts[i]!);
  }
  return fl.locator(parts[parts.length - 1]!);
}

/**
 * Normalizes root-level XPath selectors that would otherwise produce empty
 * matches. Mirrors normalizeRootXPath from actHandlerUtils.ts verbatim.
 *
 * Note: does NOT modify `//` or `xpath=//` — those are valid XPath roots.
 */
export function normalizeRootSelector(selector: string): string {
  if (/^xpath=\/$/i.test(selector)) return "xpath=/html";
  if (selector === "/") return "/html";
  return selector;
}
