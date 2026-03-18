import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as playwright from "playwright-core";

// We need to mock resolveNativeLocator before importing performNativeAction
vi.mock(
  "../../lib/v3/understudy/native/locator/nativeLocatorUtils.js",
  () => ({
    resolveNativeLocator: vi.fn(),
  }),
);

const { performNativeAction } = await import(
  "../../lib/v3/understudy/native/actions/nativeActionDispatch.js"
);
const { resolveNativeLocator } = await import(
  "../../lib/v3/understudy/native/locator/nativeLocatorUtils.js"
);
const { StagehandInvalidArgumentError } = await import(
  "../../lib/v3/types/public/sdkErrors.js"
);

function makeMockLocator(): Partial<playwright.Locator> &
  Record<string, ReturnType<typeof vi.fn>> {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    pressSequentially: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    dblclick: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    dragTo: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockPage() {
  return {
    mouse: {
      wheel: vi.fn().mockResolvedValue(undefined),
    },
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn(),
  } as unknown as playwright.Page;
}

describe("performNativeAction — unit", () => {
  let mockLocator: ReturnType<typeof makeMockLocator>;
  let mockPage: playwright.Page;

  beforeEach(() => {
    mockLocator = makeMockLocator();
    mockPage = makeMockPage();
    vi.mocked(resolveNativeLocator).mockReturnValue(
      mockLocator as unknown as playwright.Locator,
    );
  });

  it("click dispatches to locator.click", async () => {
    await performNativeAction(mockPage, {
      method: "click",
      selector: "#btn",
      args: [],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.click).toHaveBeenCalledOnce();
  });

  it("fill does two-step clear then fill", async () => {
    await performNativeAction(mockPage, {
      method: "fill",
      selector: "#inp",
      args: ["hello world"],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.fill).toHaveBeenCalledTimes(2);
    expect(mockLocator.fill).toHaveBeenNthCalledWith(1, "");
    expect(mockLocator.fill).toHaveBeenNthCalledWith(2, "hello world");
  });

  it("type dispatches to pressSequentially", async () => {
    await performNativeAction(mockPage, {
      method: "type",
      selector: "#inp",
      args: ["hello world"],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.pressSequentially).toHaveBeenCalledWith("hello world");
  });

  it("press dispatches to locator.press with key", async () => {
    await performNativeAction(mockPage, {
      method: "press",
      selector: "#inp",
      args: ["Enter"],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.press).toHaveBeenCalledWith("Enter");
  });

  it("hover dispatches to locator.hover with no args", async () => {
    await performNativeAction(mockPage, {
      method: "hover",
      selector: "#btn",
      args: [],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.hover).toHaveBeenCalledOnce();
    expect(mockLocator.hover).toHaveBeenCalledWith();
  });

  it("doubleClick dispatches to locator.dblclick", async () => {
    await performNativeAction(mockPage, {
      method: "doubleClick",
      selector: "#btn",
      args: [],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.dblclick).toHaveBeenCalledOnce();
  });

  it("selectOption dispatches with option text", async () => {
    await performNativeAction(mockPage, {
      method: "selectOption",
      selector: "#sel",
      args: ["Option A"],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.selectOption).toHaveBeenCalledWith("Option A");
  });

  it("selectOptionFromDropdown is an alias for selectOption", async () => {
    await performNativeAction(mockPage, {
      method: "selectOptionFromDropdown",
      selector: "#sel",
      args: ["Option B"],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.selectOption).toHaveBeenCalledWith("Option B");
  });

  it("scrollIntoView dispatches to scrollIntoViewIfNeeded", async () => {
    await performNativeAction(mockPage, {
      method: "scrollIntoView",
      selector: "#el",
      args: [],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.scrollIntoViewIfNeeded).toHaveBeenCalledOnce();
  });

  it("scroll dispatches to locator.evaluate", async () => {
    await performNativeAction(mockPage, {
      method: "scroll",
      selector: "#el",
      args: ["50"],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.evaluate).toHaveBeenCalledOnce();
  });

  it("scrollTo is an alias for scroll", async () => {
    await performNativeAction(mockPage, {
      method: "scrollTo",
      selector: "#el",
      args: ["25"],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.evaluate).toHaveBeenCalledOnce();
  });

  it("mouse.wheel dispatches to page.mouse.wheel", async () => {
    await performNativeAction(mockPage, {
      method: "mouse.wheel",
      selector: "#el",
      args: ["200"],
      domSettleTimeoutMs: 0,
    });
    expect((mockPage.mouse.wheel as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(0, 200);
  });

  it("nextChunk dispatches to locator.evaluate", async () => {
    await performNativeAction(mockPage, {
      method: "nextChunk",
      selector: "body",
      args: [],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.evaluate).toHaveBeenCalledOnce();
  });

  it("prevChunk dispatches to locator.evaluate", async () => {
    await performNativeAction(mockPage, {
      method: "prevChunk",
      selector: "body",
      args: [],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.evaluate).toHaveBeenCalledOnce();
  });

  it("dragAndDrop dispatches to locator.dragTo", async () => {
    await performNativeAction(mockPage, {
      method: "dragAndDrop",
      selector: "#source",
      args: ["#target"],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.dragTo).toHaveBeenCalledOnce();
  });

  it("scrollByPixelOffset dispatches to locator.evaluate", async () => {
    await performNativeAction(mockPage, {
      method: "scrollByPixelOffset",
      selector: "#el",
      args: ["10", "20"],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.evaluate).toHaveBeenCalledOnce();
  });

  it("unknown method throws StagehandInvalidArgumentError", async () => {
    await expect(
      performNativeAction(mockPage, {
        method: "nonexistent",
        selector: "#x",
        args: [],
        domSettleTimeoutMs: 0,
      }),
    ).rejects.toThrow(StagehandInvalidArgumentError);
  });

  it("null args are normalized to empty string", async () => {
    await performNativeAction(mockPage, {
      method: "fill",
      selector: "#inp",
      args: [null],
      domSettleTimeoutMs: 0,
    });
    expect(mockLocator.fill).toHaveBeenNthCalledWith(2, "");
  });
});
