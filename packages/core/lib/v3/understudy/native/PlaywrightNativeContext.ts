// packages/core/lib/v3/understudy/native/PlaywrightNativeContext.ts

import type { BrowserContext, Page as PlaywrightPage } from "playwright-core";
import type { LogLine } from "../../types/public/logs.js";
import { StagehandNotInitializedError } from "../../types/public/sdkErrors.js";
import { PlaywrightNativePage } from "./PlaywrightNativePage.js";

export class PlaywrightNativeContext {
  private _cache = new Map<PlaywrightPage, PlaywrightNativePage>();

  constructor(
    private readonly _browserContext: BrowserContext,
    private readonly _opts: { logger: (logLine: LogLine) => void },
  ) {}

  /**
   * Returns the cached PlaywrightNativePage for the given playwright.Page, or
   * creates a new one. Pages are cached by reference so the same wrapper
   * instance is returned every time for the same underlying page.
   *
   * Cache entries are evicted when the playwright.Page closes to prevent
   * accumulation of stale references.
   */
  wrapPage(pwPage: PlaywrightPage): PlaywrightNativePage {
    if (this._cache.has(pwPage)) return this._cache.get(pwPage)!;
    const wrapped = new PlaywrightNativePage(pwPage, this._opts);
    this._cache.set(pwPage, wrapped);
    // Evict on close to prevent memory leak from accumulating closed-page refs
    pwPage.once("close", () => this._cache.delete(pwPage));
    return wrapped;
  }

  /**
   * Returns a PlaywrightNativePage wrapping the first open page in the context.
   * Throws if no pages are open.
   */
  getActivePage(): PlaywrightNativePage {
    const pages = this._browserContext.pages();
    if (pages.length === 0) {
      throw new StagehandNotInitializedError(
        "PlaywrightNativeContext.getActivePage(): no pages open in BrowserContext.",
      );
    }
    return this.wrapPage(pages[0]);
  }
}
