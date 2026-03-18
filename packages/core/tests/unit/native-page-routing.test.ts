import { describe, it, expect, vi } from "vitest";
import type { EventEmitter } from "events";
import type { BrowserContext, Page as PlaywrightPage } from "playwright-core";
import { PlaywrightNativePage } from "../../lib/v3/understudy/native/PlaywrightNativePage.js";
import { PlaywrightNativeContext } from "../../lib/v3/understudy/native/PlaywrightNativeContext.js";
import { StagehandNotInitializedError } from "../../lib/v3/types/public/sdkErrors.js";

// ---------- helpers ----------

function makeMockPwPage(): PlaywrightPage & EventEmitter {
  const listeners: Map<string, (() => void)[]> = new Map();
  const page = {
    url: vi.fn().mockReturnValue("about:blank"),
    goto: vi.fn().mockResolvedValue(null),
    reload: vi.fn().mockResolvedValue(null),
    goBack: vi.fn().mockResolvedValue(null),
    goForward: vi.fn().mockResolvedValue(null),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("")),
    locator: vi.fn().mockReturnValue({ waitFor: vi.fn().mockResolvedValue(undefined) }),
    mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    once(event: string, cb: () => void) {
      const existing = listeners.get(event) ?? [];
      listeners.set(event, [...existing, cb]);
    },
    emit(event: string) {
      const cbs = listeners.get(event) ?? [];
      for (const cb of cbs) cb();
    },
  } as unknown as PlaywrightPage & EventEmitter;
  return page;
}

function makeMockBrowserContext(
  pages: PlaywrightPage[],
): BrowserContext {
  return {
    pages: vi.fn().mockReturnValue(pages),
  } as unknown as BrowserContext;
}

const opts = {
  logger: vi.fn(),
};

// ---------- PlaywrightNativeContext tests ----------

describe("PlaywrightNativeContext", () => {
  it("caches wrapper by page reference", () => {
    const mockPage1 = makeMockPwPage();
    const mockPage2 = makeMockPwPage();
    const ctx = new PlaywrightNativeContext(
      makeMockBrowserContext([mockPage1, mockPage2]),
      opts,
    );
    const w1a = ctx.wrapPage(mockPage1);
    const w1b = ctx.wrapPage(mockPage1);
    const w2 = ctx.wrapPage(mockPage2);
    expect(w1a).toBe(w1b);        // same pw.Page → same wrapper
    expect(w1a).not.toBe(w2);     // different pw.Page → different wrapper
  });

  it("evicts closed page from cache", () => {
    const mockPage = makeMockPwPage();
    const ctx = new PlaywrightNativeContext(
      makeMockBrowserContext([mockPage]),
      opts,
    );
    const first = ctx.wrapPage(mockPage);
    // Simulate page close
    mockPage.emit("close");
    const second = ctx.wrapPage(mockPage);
    expect(first).not.toBe(second); // evicted; new wrapper created
  });

  it("getActivePage() wraps the first page", () => {
    const mockPage = makeMockPwPage();
    const ctx = new PlaywrightNativeContext(
      makeMockBrowserContext([mockPage]),
      opts,
    );
    const active = ctx.getActivePage();
    expect(active).toBeInstanceOf(PlaywrightNativePage);
  });

  it("getActivePage() throws when no pages exist", () => {
    const ctx = new PlaywrightNativeContext(
      makeMockBrowserContext([]),
      opts,
    );
    expect(() => ctx.getActivePage()).toThrow(StagehandNotInitializedError);
  });
});

// ---------- PlaywrightNativePage tests ----------

describe("PlaywrightNativePage", () => {
  it("reports disposed after page close event", () => {
    const mockPage = makeMockPwPage();
    const wrapped = new PlaywrightNativePage(mockPage, opts);
    mockPage.emit("close");
    // performAction should throw after close
    expect(wrapped.performAction({ method: "click", selector: "#x", args: [] }))
      .rejects.toThrow("page has been closed");
  });

  it("evaluate() throws for string expressions", async () => {
    const mockPage = makeMockPwPage();
    const wrapped = new PlaywrightNativePage(mockPage, opts);
    await expect(
      wrapped.evaluate("return document.title"),
    ).rejects.toThrow("does not support string expressions");
  });

  it("evaluate() delegates to _pwPage for function expressions", async () => {
    const mockPage = makeMockPwPage();
    (mockPage.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue("test-title");
    const wrapped = new PlaywrightNativePage(mockPage, opts);
    const result = await wrapped.evaluate(() => document.title);
    expect(result).toBe("test-title");
  });

  it("url() delegates to _pwPage.url()", () => {
    const mockPage = makeMockPwPage();
    (mockPage.url as ReturnType<typeof vi.fn>).mockReturnValue("https://example.com");
    const wrapped = new PlaywrightNativePage(mockPage, opts);
    expect(wrapped.url()).toBe("https://example.com");
  });
});
