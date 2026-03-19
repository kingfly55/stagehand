// packages/core/lib/v3/understudy/native/PlaywrightNativePage.ts
//
// Known Phase 4 limitations:
// - addInitScript() delegates to playwright Page.addInitScript(), which in an
//   externally-owned BrowserContext injects into ALL pages in the context.
// - FlowLogger decorators are absent — PagePerformAction/PageClose events will
//   not appear in flow logs for native mode.
// - evaluate() rejects string expressions (CDP-ism); callers must pass functions.
// - addInitScript() for pierceShadow: "including-closed" installs the closed-shadow
//   interceptor context-wide (all pages in the BrowserContext), not only on the page
//   that requested it. This is a Playwright limitation. Pages that did not opt in
//   will carry the __stagehandClosedRoot global as a fingerprinting side effect.

import type { Page as PlaywrightPage } from "playwright-core";
import type { IStagehandPage, ResolvedAction } from "../../types/private/IStagehandPage.js";
import type { HybridSnapshot, SnapshotOptions } from "../../types/private/snapshot.js";
import type { ScreenshotOptions } from "../../types/public/screenshotTypes.js";
import type { LoadState } from "../../types/public/page.js";
import type { InitScriptSource } from "../../types/private/internal.js";
import type { LogLine } from "../../types/public/logs.js";
import { StagehandInvalidArgumentError } from "../../types/public/sdkErrors.js";
import { v3Logger } from "../../logger.js";
import { performNativeAction } from "./actions/nativeActionDispatch.js";
import { captureNativeSnapshot } from "./snapshot/captureNativeSnapshot.js";

const CLOSED_SHADOW_INTERCEPTOR = `
(function() {
  if (typeof window.__stagehandClosedRoot === "function" || window.__stagehandClosedRootInstalled) return;
  try {
    var _closed = new WeakMap();
    var _orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
      var root = _orig.call(this, init);
      if (init && init.mode === "closed") _closed.set(this, root);
      return root;
    };
    window.__stagehandClosedRoot = function(host) { return _closed.get(host) ?? null; };
    window.__stagehandClosedRootInstalled = true;
  } catch (e) {
    // attachShadow patch failed (frozen prototype or CSP); degrading gracefully.
    // Closed shadow roots created before a successful install will not be captured.
  }
})();
`;

export class PlaywrightNativePage implements IStagehandPage {
  private _disposed = false;
  private _closedShadowInstalled = false;

  constructor(
    public readonly _pwPage: PlaywrightPage,
    private readonly _opts: { logger: (logLine: LogLine) => void },
  ) {
    // Mark disposed on page close so in-flight performAction calls throw cleanly
    // rather than failing with an opaque Playwright "target closed" error.
    this._pwPage.once("close", () => {
      this._disposed = true;
    });
  }

  // ── Identity ────────────────────────────────────────────────────────────────

  url(): string {
    return this._pwPage.url();
  }

  // ── Navigation ──────────────────────────────────────────────────────────────

  async goto(
    url: string,
    opts?: { waitUntil?: LoadState; timeoutMs?: number },
  ): Promise<unknown> {
    return this._pwPage.goto(url, {
      waitUntil: opts?.waitUntil,
      timeout: opts?.timeoutMs,
    });
  }

  async reload(opts?: { waitUntil?: LoadState; timeoutMs?: number }): Promise<unknown> {
    return this._pwPage.reload({
      waitUntil: opts?.waitUntil,
      timeout: opts?.timeoutMs,
    });
  }

  async goBack(opts?: { waitUntil?: LoadState; timeoutMs?: number }): Promise<unknown> {
    return this._pwPage.goBack({
      waitUntil: opts?.waitUntil,
      timeout: opts?.timeoutMs,
    });
  }

  async goForward(opts?: { waitUntil?: LoadState; timeoutMs?: number }): Promise<unknown> {
    return this._pwPage.goForward({
      waitUntil: opts?.waitUntil,
      timeout: opts?.timeoutMs,
    });
  }

  // ── Load state ──────────────────────────────────────────────────────────────

  async waitForLoadState(state: LoadState, timeoutMs?: number): Promise<void> {
    await this._pwPage.waitForLoadState(state, { timeout: timeoutMs });
  }

  // ── DOM settle ──────────────────────────────────────────────────────────────

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

  // ── Selector wait ────────────────────────────────────────────────────────────

  async waitForSelector(
    selector: string,
    opts?: { timeout?: number },
  ): Promise<void> {
    await this._pwPage.locator(selector).waitFor({ timeout: opts?.timeout });
  }

  // ── Snapshot ────────────────────────────────────────────────────────────────

  async captureSnapshot(opts?: SnapshotOptions): Promise<HybridSnapshot> {
    if (opts?.pierceShadow === "including-closed" && !this._closedShadowInstalled) {
      await this._pwPage.addInitScript(CLOSED_SHADOW_INTERCEPTOR);
      this._closedShadowInstalled = true;
      // IMPORTANT: addInitScript takes effect on the next navigation only.
      // Closed shadow roots that were attached before this call are invisible
      // to the interceptor. Navigate or reload the page after enabling this
      // option to capture pre-existing roots. Do NOT auto-reload here —
      // callers control navigation timing.
      v3Logger({
        message:
          "pierceShadow=\"including-closed\": CLOSED_SHADOW_INTERCEPTOR installed. " +
          "Closed roots attached before this call are not captured. " +
          "Reload or navigate the page to capture them.",
        level: 1,
      });
    }

    return captureNativeSnapshot(this._pwPage, {
      focusSelector: opts?.focusSelector,
      experimental: opts?.experimental ?? false,
      pierceShadow: opts?.pierceShadow ?? true,
      includeIframes: opts?.includeIframes ?? true,
    });
  }

  // ── Action ──────────────────────────────────────────────────────────────────

  async performAction(action: ResolvedAction): Promise<void> {
    if (this._disposed) {
      throw new StagehandInvalidArgumentError(
        "PlaywrightNativePage: page has been closed.",
      );
    }
    await performNativeAction(this._pwPage, action);
  }

  // ── Evaluation ──────────────────────────────────────────────────────────────

  /**
   * Rejects string expressions — those are a CDP-ism. Pass a function instead:
   *   page.evaluate(() => document.title)
   */
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this._pwPage.evaluate(fn as any, arg) as Promise<R>;
  }

  // ── Screenshot ──────────────────────────────────────────────────────────────

  /**
   * The `mask` option is CDP-Locator-typed and unusable in native mode.
   * It is silently dropped. This is a known Phase 4 limitation.
   */
  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const { mask: _mask, ...pwOpts } = opts ?? {};
    return this._pwPage.screenshot(pwOpts) as Promise<Buffer>;
  }

  // ── Init scripts ─────────────────────────────────────────────────────────────

  /**
   * WARNING: delegates to playwright Page.addInitScript(). In an
   * externally-owned BrowserContext this injects into ALL pages in the
   * context, not just this one. Known Phase 4 limitation.
   */
  async addInitScript<Arg>(
    script: InitScriptSource<Arg>,
    _arg?: Arg,
  ): Promise<void> {
    await this._pwPage.addInitScript(script as string);
  }

  // ── Close ────────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this._disposed = true;
    await this._pwPage.close();
  }
}
