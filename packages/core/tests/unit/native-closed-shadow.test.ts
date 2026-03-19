import { describe, it, expect, vi } from "vitest";
import { PlaywrightNativePage } from "../../lib/v3/understudy/native/PlaywrightNativePage.js";
import { captureNativeSnapshot } from "../../lib/v3/understudy/native/snapshot/captureNativeSnapshot.js";
import { createMockPlaywrightPage } from "./helpers/mockPlaywrightPage.js";
import type { NativeA11yOptions } from "../../lib/v3/types/private/snapshot.js";

function makeMockPwPage() {
  const addInitScript = vi.fn(async (): Promise<void> => {});
  const frames = [
    {
      url: () => "about:blank",
      evaluate: vi.fn(async (): Promise<unknown[]> => []),
      parentFrame: (): null => null,
    },
  ];
  const page = {
    url: () => "about:blank",
    mainFrame: () => frames[0],
    frames: () => frames,
    evaluate: vi.fn(async () => []),
    addInitScript,
    once: vi.fn(),
    close: vi.fn(async () => {}),
    locator: vi.fn(() => ({ waitFor: vi.fn() })),
    screenshot: vi.fn(async () => Buffer.from("")),
  } as any;
  return { page, addInitScript };
}

describe("pierceShadow: true (default) — no addInitScript", () => {
  it("does not call addInitScript", async () => {
    const { page, addInitScript } = makeMockPwPage();
    const nativePage = new PlaywrightNativePage(page, { logger: () => {} });
    await nativePage.captureSnapshot({ pierceShadow: true });
    expect(addInitScript).not.toHaveBeenCalled();
  });
});

describe("pierceShadow: undefined (default) — no addInitScript", () => {
  it("does not call addInitScript when option is omitted", async () => {
    const { page, addInitScript } = makeMockPwPage();
    const nativePage = new PlaywrightNativePage(page, { logger: () => {} });
    await nativePage.captureSnapshot();
    expect(addInitScript).not.toHaveBeenCalled();
  });
});

describe("pierceShadow: \"including-closed\" — lazy install", () => {
  it("calls addInitScript exactly once on first use", async () => {
    const { page, addInitScript } = makeMockPwPage();
    const nativePage = new PlaywrightNativePage(page, { logger: () => {} });
    await nativePage.captureSnapshot({ pierceShadow: "including-closed" });
    expect(addInitScript).toHaveBeenCalledTimes(1);
    const arg = (addInitScript.mock.calls[0] as unknown[])[0] as string;
    expect(arg).toContain("__stagehandClosedRoot");
    expect(arg).toContain("attachShadow");
  });

  it("does not call addInitScript a second time on subsequent snapshots", async () => {
    const { page, addInitScript } = makeMockPwPage();
    const nativePage = new PlaywrightNativePage(page, { logger: () => {} });
    await nativePage.captureSnapshot({ pierceShadow: "including-closed" });
    await nativePage.captureSnapshot({ pierceShadow: "including-closed" });
    expect(addInitScript).toHaveBeenCalledTimes(1);
  });
});

describe("captureNativeSnapshot — _snapshotForAI suppressed for including-closed", () => {
  it("does not use _snapshotForAI path when pierceShadow is including-closed", async () => {
    const mockPage = createMockPlaywrightPage({ frameEvaluateResults: { 0: [] } });
    const snapshotForAI = vi.fn(async () => "- generic");
    (mockPage as any)._snapshotForAI = snapshotForAI;

    const opts: NativeA11yOptions = {
      experimental: false,
      pierceShadow: "including-closed",
      includeIframes: false,
    };
    await captureNativeSnapshot(mockPage as any, opts);
    expect(snapshotForAI).not.toHaveBeenCalled();
  });

  it("uses _snapshotForAI path when pierceShadow is true", async () => {
    const mockPage = createMockPlaywrightPage({ frameEvaluateResults: { 0: [] } });
    const snapshotForAI = vi.fn(async () => "");
    (mockPage as any)._snapshotForAI = snapshotForAI;

    const opts: NativeA11yOptions = {
      experimental: false,
      pierceShadow: true,
      includeIframes: false,
    };
    await captureNativeSnapshot(mockPage as any, opts);
    expect(snapshotForAI).toHaveBeenCalled();
  });
});
