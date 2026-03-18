// TODO(phase-5): Replace page.waitForTimeout DOM settle with waitForDomNetworkQuiet equivalent
// TODO(phase-5): Add FlowLogger.runWithLogging wrapping for observability parity with CDP path
// TODO(phase-5): Implement coordinate-based cross-frame dragAndDrop via page.mouse API
// TODO(phase-5): Implement deep XPath iframe step detection in resolveNativeLocator

import * as playwright from "playwright-core";
import type { ResolvedAction } from "../../../types/private/IStagehandPage.js";
import {
  UnderstudyCommandException,
  StagehandClickError,
  StagehandInvalidArgumentError,
} from "../../../types/public/sdkErrors.js";
import { resolveNativeLocator } from "../locator/nativeLocatorUtils.js";

export async function performNativeAction(
  page: playwright.Page,
  action: ResolvedAction,
): Promise<void> {
  // Mirror performUnderstudyMethod's arg normalization at actHandlerUtils.ts:77
  const args = action.args.map((a) => (a == null ? "" : String(a)));

  const locator = resolveNativeLocator(page, action.selector);

  switch (action.method) {
    case "click": {
      try {
        await locator.click();
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        // Match CDP arg order: (selector, message) — actHandlerUtils.ts:325
        throw new StagehandClickError(action.selector, msg);
      }
      break;
    }

    case "fill": {
      try {
        // Two-step to match CDP path's event sequence (actHandlerUtils.ts:239-243)
        await locator.fill("");
        await locator.fill(args[0] ?? "");
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    case "type": {
      try {
        // pressSequentially is the public API replacement for deprecated locator.type()
        // No delay option — matches CDP path which passes no delay
        await locator.pressSequentially(args[0] ?? "");
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    case "press": {
      try {
        // Use locator.press() NOT page.keyboard.press() — must target the specific element
        await locator.press(args[0] ?? "");
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    case "scrollTo":
    case "scroll": {
      try {
        const pct = parseFloat(args[0] ?? "0") / 100;
        await locator.evaluate(
          (el: Element, p: number) => {
            el.scrollTop = el.scrollHeight * p;
          },
          pct,
        );
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    case "scrollIntoView": {
      try {
        await locator.scrollIntoViewIfNeeded();
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    case "hover": {
      try {
        // No args — CDP hover handler takes zero args (actHandlerUtils.ts:498)
        await locator.hover();
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    case "doubleClick": {
      try {
        // Use dblclick() — produces correct dblclick DOM event
        // Note: click({ clickCount: 2 }) produces a different event sequence
        await locator.dblclick();
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    case "nextChunk": {
      try {
        await locator.evaluate((el: Element) => {
          const tag = el.tagName.toLowerCase();
          if (tag === "html" || tag === "body") {
            window.scrollBy({ top: window.innerHeight, behavior: "instant" });
          } else {
            el.scrollBy({
              top: el.getBoundingClientRect().height,
              behavior: "instant",
            });
          }
        });
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    case "prevChunk": {
      try {
        await locator.evaluate((el: Element) => {
          const tag = el.tagName.toLowerCase();
          if (tag === "html" || tag === "body") {
            window.scrollBy({ top: -window.innerHeight, behavior: "instant" });
          } else {
            el.scrollBy({
              top: -el.getBoundingClientRect().height,
              behavior: "instant",
            });
          }
        });
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    case "selectOptionFromDropdown":
    case "selectOption": {
      try {
        // args[0] is option text/value string — mirrors actHandlerUtils.ts:149
        await locator.selectOption(args[0] ?? "");
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    case "dragAndDrop": {
      try {
        const targetSelector = (args[0] ?? "").trim();
        if (!targetSelector) {
          throw new StagehandInvalidArgumentError(
            "dragAndDrop requires a target selector",
          );
        }
        const targetLocator = resolveNativeLocator(page, targetSelector);
        await locator.dragTo(targetLocator);
        // Known gap: cross-frame drag-and-drop is not supported in Phase 3.
        // The CDP path uses coordinate-based dragging to handle this case.
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        if (e instanceof StagehandInvalidArgumentError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    case "mouse.wheel": {
      try {
        await page.mouse.wheel(0, Number(args[0]) || 0);
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    case "scrollByPixelOffset": {
      try {
        // Scrolls the element's own content — differs from CDP which dispatches
        // a wheel event at the viewport centroid. Documented behavioral difference.
        await locator.evaluate(
          (el: Element, [dx, dy]: [number, number]) => el.scrollBy(dx, dy),
          [Number(args[0]) || 0, Number(args[1]) || 0] as [number, number],
        );
      } catch (e) {
        if (e instanceof playwright.errors.TimeoutError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new UnderstudyCommandException(msg, e);
      }
      break;
    }

    default: {
      throw new StagehandInvalidArgumentError(
        `Unsupported action method in native mode: ${action.method}`,
      );
    }
  }

  // Phase 3 stopgap: simple timeout-based settle.
  // Phase 5 will replace with waitForDomNetworkQuiet equivalent.
  // page.waitForLoadState("domcontentloaded") is useless post-navigation — don't use it.
  await page
    .waitForTimeout(action.domSettleTimeoutMs ?? 500)
    .catch(() => {});
}
