import { vi } from "vitest";
import type * as playwright from "playwright-core";
import type { NativeNodeEntry } from "../../../lib/v3/understudy/native/snapshot/nativeCombinedTree.js";

export interface MockPageOpts {
  url?: string;
  title?: string;
  /** Pre-canned evaluate results per frame index (0 = main frame). */
  frameEvaluateResults?: Record<number, NativeNodeEntry[]>;
}

/**
 * A minimal mock of playwright.Page sufficient for testing captureNativeCombinedTree
 * and captureNativeSnapshot without a real browser.
 *
 * Frame objects are constructed once and the same array reference is returned
 * on every call to page.frames() — no mid-iteration mutation.
 */
export function createMockPlaywrightPage(
  opts: MockPageOpts = {},
): playwright.Page {
  const pageUrl = opts.url ?? "about:blank";
  const frameResults = opts.frameEvaluateResults ?? { 0: [] };
  const frameCount = Math.max(...Object.keys(frameResults).map(Number)) + 1;

  // Build mock frames once
  const mockFrames: playwright.Frame[] = Array.from(
    { length: frameCount },
    (_, i) => createMockFrame(i, frameResults[i] ?? [], pageUrl),
  );

  const mockPage = {
    url: () => pageUrl,
    mainFrame: () => mockFrames[0]!,
    frames: () => mockFrames,
    evaluate: async <R = unknown, Arg = unknown>(
      fn: string | ((arg: Arg) => R | Promise<R>),
      arg?: Arg,
    ): Promise<R> => {
      // Delegate to main frame evaluate
      return mockFrames[0]!.evaluate(fn as Parameters<playwright.Frame["evaluate"]>[0], arg) as Promise<R>;
    },
    locator: (selector: string) =>
      createMockLocator(selector, mockFrames[0]!),
    title: async () => opts.title ?? "",
    close: async (): Promise<void> => {},
    goto: async (): Promise<null> => null,
    reload: async (): Promise<null> => null,
    goBack: async (): Promise<null> => null,
    goForward: async (): Promise<null> => null,
    waitForLoadState: async (): Promise<void> => {},
    waitForNetworkIdle: async (): Promise<void> => {},
    screenshot: async (): Promise<Buffer> => Buffer.from(""),
    addInitScript: vi.fn(async (): Promise<void> => {}),
  } as unknown as playwright.Page;

  return mockPage;
}

function createMockFrame(
  index: number,
  entries: NativeNodeEntry[],
  frameUrl: string,
): playwright.Frame {
  return {
    url: () => (index === 0 ? frameUrl : `about:blank#frame-${index}`),
    evaluate: async <R = unknown, Arg = unknown>(
      fn: string | ((arg: Arg) => R | Promise<R>),
      _arg?: Arg,
    ): Promise<R> => {
      if (typeof fn === "function") {
        // Return pre-canned entries for this frame
        return entries as unknown as R;
      }
      return entries as unknown as R;
    },
    parentFrame: (): null => null,
  } as unknown as playwright.Frame;
}

function createMockLocator(
  _selector: string,
  _frame: playwright.Frame,
): playwright.Locator {
  return {
    count: async () => 1,
    getAttribute: async (_name: string): Promise<null> => null,
    evaluate: async <R = unknown>(
      fn: (el: Element) => R,
      _arg?: unknown,
    ): Promise<R> => {
      return fn(document.createElement("div"));
    },
  } as unknown as playwright.Locator;
}
