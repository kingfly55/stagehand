// packages/core/lib/v3/types/private/IStagehandPage.ts

import type { LoadState } from "../public/page.js";
import type { HybridSnapshot, SnapshotOptions } from "./snapshot.js";
import type {
  ScreenshotOptions,
} from "../public/screenshotTypes.js";
import type { InitScriptSource } from "./internal.js";

/**
 * The action descriptor passed to IStagehandPage.performAction().
 * Fields map 1:1 to performUnderstudyMethod parameters.
 */
export interface ResolvedAction {
  method: string;                    // SupportedUnderstudyAction value (string at call site)
  selector: string;                  // resolved xpath/css string
  args: ReadonlyArray<unknown>;      // ReadonlyArray<unknown> to match performUnderstudyMethod
  domSettleTimeoutMs?: number;
}

/**
 * Minimal contract that all page implementations must satisfy.
 * The existing Page class satisfies this structurally (verified via compile-time assertion in page.ts).
 * PlaywrightNativePage will implement this directly in a later phase.
 */
export interface IStagehandPage {
  // Identity
  url(): string;

  // Navigation — option key names match Page exactly (timeoutMs, not timeout)
  // Return type is Promise<unknown> because Page returns Promise<Response | null>,
  // which is not assignable to Promise<void> in TypeScript.
  goto(url: string, opts?: { waitUntil?: LoadState; timeoutMs?: number }): Promise<unknown>;
  reload(opts?: { waitUntil?: LoadState; timeoutMs?: number }): Promise<unknown>;
  goBack(opts?: { waitUntil?: LoadState; timeoutMs?: number }): Promise<unknown>;
  goForward(opts?: { waitUntil?: LoadState; timeoutMs?: number }): Promise<unknown>;

  // waitForLoadState — positional timeoutMs matches Page's actual signature
  waitForLoadState(state: LoadState, timeoutMs?: number): Promise<void>;

  // DOM settle
  waitForNetworkIdle(domSettleTimeoutMs?: number): Promise<void>;

  // Snapshot — new method on Page; delegates to captureHybridSnapshot free function internally
  captureSnapshot(opts?: SnapshotOptions): Promise<HybridSnapshot>;

  // Action — new method on Page; delegates to performUnderstudyMethod free function internally
  performAction(action: ResolvedAction): Promise<void>;

  // Evaluation — two-generic form matching Page exactly
  evaluate<R = unknown, Arg = unknown>(
    fn: string | ((arg: Arg) => R | Promise<R>),
    arg?: Arg,
  ): Promise<R>;

  // Screenshot — use existing ScreenshotOptions.
  // NOTE: ScreenshotOptions contains `mask?: Locator[]` (CDP-bound).
  // PlaywrightNativePage will define a NativeScreenshotOptions without mask in a later phase.
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;

  // Init scripts — generic form matching Page exactly
  addInitScript<Arg>(script: InitScriptSource<Arg>, arg?: Arg): Promise<void>;

  // Selector wait — required by ActCache.utils.waitForCachedSelector.
  // Return type is Promise<boolean | void> to be compatible with both the CDP
  // Page (returns boolean) and PlaywrightNativePage (returns void).
  waitForSelector(
    selector: string,
    opts?: {
      timeout?: number;
      state?: "attached" | "detached" | "visible" | "hidden";
    },
  ): Promise<boolean | void>;

  // Close
  close(): Promise<void>;
}
