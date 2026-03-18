import { describe, expect, it } from "vitest";
import { captureNativeCombinedTree } from "../../lib/v3/understudy/native/snapshot/nativeCombinedTree.js";
import { captureNativeSnapshot } from "../../lib/v3/understudy/native/snapshot/captureNativeSnapshot.js";
import { createMockPlaywrightPage } from "./helpers/mockPlaywrightPage.js";
import type { NativeNodeEntry } from "../../lib/v3/understudy/native/snapshot/nativeCombinedTree.js";
import type { NativeA11yOptions } from "../../lib/v3/types/private/snapshot.js";

const baseOpts: NativeA11yOptions = {
  experimental: false,
  pierceShadow: true,
  includeIframes: true,
};

/** Build a minimal NativeNodeEntry for tests */
function makeEntry(
  overrides: Partial<NativeNodeEntry> & { ordinal: number },
): NativeNodeEntry {
  return {
    depth: 0,
    parentOrdinal: -1,
    xpath: `/html[1]/body[1]/div[${overrides.ordinal + 1}]`,
    tag: "div",
    role: "generic",
    name: "",
    isScrollable: false,
    isShadowHost: false,
    isIframeHost: false,
    ...overrides,
  };
}

// ── Test 1: Single frame, three elements ──────────────────────────────────────

describe("captureNativeCombinedTree — single frame", () => {
  it("produces encodedIds in format '0-N' for each entry", async () => {
    const entries: NativeNodeEntry[] = [
      makeEntry({ ordinal: 0, xpath: "/html[1]/body[1]", tag: "body", role: "generic", depth: 1, parentOrdinal: -1 }),
      makeEntry({ ordinal: 1, xpath: "/html[1]/body[1]/h1[1]", tag: "h1", role: "heading", depth: 2, parentOrdinal: 0 }),
      makeEntry({ ordinal: 2, xpath: "/html[1]/body[1]/p[1]", tag: "p", role: "paragraph", depth: 2, parentOrdinal: 0 }),
    ];
    const page = createMockPlaywrightPage({ frameEvaluateResults: { 0: entries } });
    const result = await captureNativeCombinedTree(page, baseOpts);

    expect(result.frames).toHaveLength(1);
    const frame = result.frames[0]!;
    expect(frame.frameOrdinal).toBe(0);
    expect(frame.entries[0]!.ordinal).toBe(0);
    expect(frame.entries[1]!.ordinal).toBe(1);
    expect(frame.entries[2]!.ordinal).toBe(2);
  });
});

// ── Test 2: Two frames ────────────────────────────────────────────────────────

describe("captureNativeSnapshot — two frames", () => {
  it("assigns encodedIds starting with '1-' for frame 1 entries", async () => {
    const frame0Entries: NativeNodeEntry[] = [
      makeEntry({ ordinal: 0, xpath: "/html[1]/body[1]", tag: "body" }),
    ];
    const frame1Entries: NativeNodeEntry[] = [
      makeEntry({ ordinal: 0, xpath: "/html[1]/body[1]/p[1]", tag: "p", role: "paragraph" }),
    ];
    const page = createMockPlaywrightPage({
      frameEvaluateResults: { 0: frame0Entries, 1: frame1Entries },
    });
    const snapshot = await captureNativeSnapshot(page, baseOpts);

    const frame1Keys = Object.keys(snapshot.combinedXpathMap).filter((k) =>
      k.startsWith("1-"),
    );
    expect(frame1Keys.length).toBeGreaterThan(0);
    expect(frame1Keys[0]).toMatch(/^1-\d+$/);
  });
});

// ── Test 3: Frame that throws during evaluate ─────────────────────────────────

describe("captureNativeCombinedTree — frame evaluate failure", () => {
  it("returns empty entries for the failing frame and does not affect others", async () => {
    const frame0Entries: NativeNodeEntry[] = [
      makeEntry({ ordinal: 0, xpath: "/html[1]/body[1]", tag: "body" }),
    ];

    // Build a page where frame 1 throws on evaluate
    const mockPage = createMockPlaywrightPage({
      frameEvaluateResults: { 0: frame0Entries, 1: [] },
    });

    // Override frame 1's evaluate to throw
    const frames = mockPage.frames();
    const originalFrame1 = frames[1]!;
    const throwingFrame = {
      ...originalFrame1,
      url: () => "https://fail.example.com",
      evaluate: async () => {
        throw new Error("evaluate failed");
      },
    };
    // Replace frame in the array (frames() returns a mutable array in mock)
    (frames as unknown[])[1] = throwingFrame;

    const result = await captureNativeCombinedTree(mockPage, baseOpts);
    expect(result.frames[0]!.entries).toHaveLength(1);
    expect(result.frames[1]!.entries).toHaveLength(0);
  });
});

// ── Test 4: Element with href in combinedUrlMap ───────────────────────────────

describe("captureNativeSnapshot — href entries", () => {
  it("includes href entries in combinedUrlMap", async () => {
    const entries: NativeNodeEntry[] = [
      makeEntry({
        ordinal: 0,
        xpath: "/html[1]/body[1]/a[1]",
        tag: "a",
        role: "link",
        name: "Click me",
        href: "/path/to/page",
      }),
    ];
    const page = createMockPlaywrightPage({ frameEvaluateResults: { 0: entries } });
    const snapshot = await captureNativeSnapshot(page, { ...baseOpts, includeIframes: false });

    expect(snapshot.combinedUrlMap["0-0"]).toBe("/path/to/page");
  });
});

// ── Test 5: pierceShadow false ────────────────────────────────────────────────

describe("captureNativeCombinedTree — pierceShadow=false", () => {
  it("does not fail and returns entries without shadow children", async () => {
    const entries: NativeNodeEntry[] = [
      makeEntry({ ordinal: 0, xpath: "/html[1]/body[1]/div[1]", tag: "div", isShadowHost: true }),
    ];
    const page = createMockPlaywrightPage({ frameEvaluateResults: { 0: entries } });
    const result = await captureNativeCombinedTree(page, {
      ...baseOpts,
      pierceShadow: false,
    });
    // Shadow children are not walked by injected script when pierceShadow=false;
    // the mock returns exactly the entries we gave, so no shadow children appear
    expect(result.frames[0]!.entries).toHaveLength(1);
    expect(result.frames[0]!.entries[0]!.isShadowHost).toBe(true);
  });
});

// ── Test 6: includeIframes false ──────────────────────────────────────────────

describe("captureNativeCombinedTree — includeIframes=false", () => {
  it("captures only frame 0", async () => {
    const frame0Entries: NativeNodeEntry[] = [
      makeEntry({ ordinal: 0, xpath: "/html[1]/body[1]", tag: "body" }),
    ];
    const frame1Entries: NativeNodeEntry[] = [
      makeEntry({ ordinal: 0, xpath: "/html[1]/body[1]/p[1]", tag: "p" }),
    ];
    const page = createMockPlaywrightPage({
      frameEvaluateResults: { 0: frame0Entries, 1: frame1Entries },
    });
    const result = await captureNativeCombinedTree(page, {
      ...baseOpts,
      includeIframes: false,
    });
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]!.frameOrdinal).toBe(0);
  });
});

// ── Test 7: formatTreeLine output format ──────────────────────────────────────

describe("captureNativeSnapshot — tree outline format", () => {
  it("first line matches [0-0] role: format", async () => {
    const entries: NativeNodeEntry[] = [
      makeEntry({ ordinal: 0, xpath: "/html[1]/body[1]", tag: "body", role: "generic", name: "root" }),
    ];
    const page = createMockPlaywrightPage({ frameEvaluateResults: { 0: entries } });
    const snapshot = await captureNativeSnapshot(page, { ...baseOpts, includeIframes: false });

    const firstLine = snapshot.combinedTree.split("\n")[0]!;
    // Should match [0-0] role: name pattern
    expect(firstLine).toMatch(/^\[0-0\] \w+/);
  });
});

// ── Test 8: parentOrdinal tree reconstruction ─────────────────────────────────

describe("captureNativeSnapshot — tree reconstruction", () => {
  it("parent node has correct number of children", async () => {
    const entries: NativeNodeEntry[] = [
      makeEntry({ ordinal: 0, xpath: "/html[1]/body[1]", tag: "body", parentOrdinal: -1, depth: 0 }),
      makeEntry({ ordinal: 1, xpath: "/html[1]/body[1]/h1[1]", tag: "h1", role: "heading", parentOrdinal: 0, depth: 1 }),
      makeEntry({ ordinal: 2, xpath: "/html[1]/body[1]/p[1]", tag: "p", role: "paragraph", parentOrdinal: 0, depth: 1 }),
    ];
    const page = createMockPlaywrightPage({ frameEvaluateResults: { 0: entries } });
    const snapshot = await captureNativeSnapshot(page, { ...baseOpts, includeIframes: false });

    // The combined tree should have 3 lines (parent + 2 children indented)
    const lines = snapshot.combinedTree.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(3);
    // Children are indented
    expect(lines[1]).toMatch(/^\s+\[0-1\]/);
    expect(lines[2]).toMatch(/^\s+\[0-2\]/);
  });
});

// ── Test 9: combinedXpathMap has no gaps ──────────────────────────────────────

describe("captureNativeSnapshot — combinedXpathMap completeness", () => {
  it("every encodedId in the tree outline also exists in combinedXpathMap", async () => {
    const entries: NativeNodeEntry[] = [
      makeEntry({ ordinal: 0, xpath: "/html[1]/body[1]", tag: "body", parentOrdinal: -1 }),
      makeEntry({ ordinal: 1, xpath: "/html[1]/body[1]/h1[1]", tag: "h1", parentOrdinal: 0 }),
      makeEntry({ ordinal: 2, xpath: "/html[1]/body[1]/a[1]", tag: "a", role: "link", parentOrdinal: 0, href: "/x" }),
    ];
    const page = createMockPlaywrightPage({ frameEvaluateResults: { 0: entries } });
    const snapshot = await captureNativeSnapshot(page, { ...baseOpts, includeIframes: false });

    // Extract all [id] references from the tree outline
    const treeIds = [...snapshot.combinedTree.matchAll(/\[(\d+-\d+)\]/g)].map(
      (m) => m[1]!,
    );
    for (const id of treeIds) {
      expect(snapshot.combinedXpathMap).toHaveProperty(id);
    }
  });
});

// ── Test 10: perFrame is populated ───────────────────────────────────────────

describe("captureNativeSnapshot — perFrame", () => {
  it("perFrame is present and has the correct number of entries", async () => {
    const frame0Entries: NativeNodeEntry[] = [
      makeEntry({ ordinal: 0, xpath: "/html[1]/body[1]", tag: "body" }),
    ];
    const frame1Entries: NativeNodeEntry[] = [
      makeEntry({ ordinal: 0, xpath: "/html[1]/body[1]/p[1]", tag: "p" }),
    ];
    const page = createMockPlaywrightPage({
      frameEvaluateResults: { 0: frame0Entries, 1: frame1Entries },
    });
    const snapshot = await captureNativeSnapshot(page, baseOpts);

    expect(snapshot.perFrame).toBeDefined();
    expect(snapshot.perFrame!.length).toBe(2);
    expect(snapshot.perFrame![0]!.frameId).toBe("0");
    expect(snapshot.perFrame![1]!.frameId).toBe("1");
  });
});
