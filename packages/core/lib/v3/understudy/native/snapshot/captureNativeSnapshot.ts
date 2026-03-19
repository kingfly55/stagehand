import type * as playwright from "playwright-core";
import { v3Logger } from "../../../logger.js";
import type {
  A11yNode,
  HybridSnapshot,
  NativeA11yOptions,
} from "../../../types/private/snapshot.js";
import { formatTreeLine, injectSubtrees } from "../../a11y/snapshot/treeFormatUtils.js";
import {
  captureNativeCombinedTree,
  type NativeNodeEntry,
} from "./nativeCombinedTree.js";
import { captureAriaSnapshot } from "./ariaSnapshotCapture.js";

/**
 * Build a tree of A11yNode objects from a flat NativeNodeEntry[] array using
 * the parentOrdinal links. Returns the root nodes (parentOrdinal === -1).
 */
function buildTree(
  entries: NativeNodeEntry[],
  frameOrdinal: number,
): (A11yNode & { _ordinal: number })[] {
  const map = new Map<number, A11yNode & { _ordinal: number }>();
  const roots: (A11yNode & { _ordinal: number })[] = [];

  for (const e of entries) {
    const node: A11yNode & { _ordinal: number } = {
      _ordinal: e.ordinal,
      encodedId: `${frameOrdinal}-${e.ordinal}`,
      role: e.role,
      name: e.name || undefined,
      nodeId: `${frameOrdinal}-${e.ordinal}`,
      children: [],
    };
    map.set(e.ordinal, node);
    if (e.parentOrdinal === -1) {
      roots.push(node);
    } else {
      const parent = map.get(e.parentOrdinal);
      if (parent) {
        parent.children = parent.children ?? [];
        parent.children.push(node);
      }
    }
  }

  return roots;
}

/**
 * Capture a native (Playwright-public-API) hybrid snapshot for the given page.
 * This is the native equivalent of captureHybridSnapshot from the CDP path.
 *
 * Key differences from the CDP path:
 * - Uses page.evaluate() instead of CDP Accessibility.getFullAXTree
 * - Frame IDs are synthetic ordinals ("0", "1", …) — intentional, not CDP hex strings.
 *   These are documented here so future maintainers don't replace them.
 * - Does not use page.accessibility (undefined in Playwright 1.58.2+)
 */
export async function captureNativeSnapshot(
  page: playwright.Page,
  opts: NativeA11yOptions,
): Promise<HybridSnapshot> {
  // Phase 7: Use Playwright's built-in ARIA engine when available.
  // Note: method is _snapshotForAI (underscore) in playwright-core >= 1.52.
  if (
    typeof (page as any)._snapshotForAI === "function" &&
    opts.pierceShadow !== "including-closed"
  ) {
    return captureAriaSnapshot(page, opts);
  }

  // Fallback: Phase 6 DOM walker path follows unchanged.
  const { frames } = await captureNativeCombinedTree(page, opts);

  const combinedXpathMap: Record<string, string> = {};
  const combinedUrlMap: Record<string, string> = {};

  // Per-frame outlines for iframe stitching
  const perFrameOutlines: Array<{ frameOrdinal: number; outline: string }> = [];

  for (const { frameOrdinal, entries } of frames) {
    // Build xpath and url maps for this frame
    for (const entry of entries) {
      const encodedId = `${frameOrdinal}-${entry.ordinal}`;
      combinedXpathMap[encodedId] = entry.xpath;
      if (entry.href) {
        combinedUrlMap[encodedId] = entry.href;
      }
    }

    // Reconstruct tree hierarchy and format outline
    let entriesToFormat = entries;

    // Focus selector scoping: find the matching entry by running a second evaluate
    if (opts.focusSelector) {
      try {
        const focusXPath = await page.evaluate(
          (selector: string) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            const parts: string[] = [];
            let node: Element | null = el as Element;
            while (
              node &&
              node.nodeType === 1 &&
              node.tagName.toLowerCase() !== "html"
            ) {
              const tag = node.tagName.toLowerCase();
              let idx = 1;
              let sib = node.previousElementSibling;
              while (sib) {
                if (sib.tagName.toLowerCase() === tag) idx++;
                sib = sib.previousElementSibling;
              }
              parts.unshift(`${tag}[${idx}]`);
              node = node.parentElement;
            }
            return "/html[1]/" + parts.join("/");
          },
          opts.focusSelector,
        );

        if (focusXPath) {
          const focusEntry = entries.find((e) => e.xpath === focusXPath);
          if (focusEntry) {
            entriesToFormat = entries.filter((e) =>
              e.xpath.startsWith(focusEntry.xpath),
            );
          }
        }
      } catch (err) {
        // Log and fall through to full unscoped snapshot — never throw
        v3Logger({
          message: `focusSelector evaluate failed for "${opts.focusSelector}": ${String(err)}`,
          level: 1,
        });
      }
    }

    const roots = buildTree(entriesToFormat, frameOrdinal);
    const outline = roots.map((r) => formatTreeLine(r, 0)).join("\n");
    perFrameOutlines.push({ frameOrdinal, outline });
  }

  // Multi-frame stitching: find iframe host entries for child frames
  // Match child frame index to parent iframe entry via isIframeHost flag
  // Use the same frame snapshot order as captureNativeCombinedTree
  const idToTree = new Map<string, string>();
  const pwFrames = opts.includeIframes ? page.frames() : [page.mainFrame()];

  for (let childIdx = 1; childIdx < pwFrames.length; childIdx++) {
    const childFrame = pwFrames[childIdx]!;
    const parentFrame = childFrame.parentFrame();
    if (!parentFrame) continue;

    // Find parent frame ordinal
    const parentOrdinal = pwFrames.indexOf(parentFrame);
    if (parentOrdinal === -1) continue;

    // Find the iframe host entry in parent frame that corresponds to this child
    const parentFrameData = frames.find((f) => f.frameOrdinal === parentOrdinal);
    if (!parentFrameData) continue;

    // Find the iframe entry whose URL or position matches; use isIframeHost to narrow
    // We match by looking for an iframe entry in the parent that is the host of childFrame.
    // Since we can't correlate exactly without CDP, we use the first unmatched iframe entry.
    // A more robust approach: evaluate in the parent frame to find the iframe's xpath.
    const iframeEntries = parentFrameData.entries.filter((e) => e.isIframeHost);
    // Simple heuristic: map child frames in order to iframe entries in order
    const iframeIdx = childIdx - 1; // childIdx starts at 1; iframe entries start at 0
    const iframeEntry = iframeEntries[iframeIdx % Math.max(iframeEntries.length, 1)];

    if (iframeEntry) {
      const iframeEncodedId = `${parentOrdinal}-${iframeEntry.ordinal}`;
      const childOutline = perFrameOutlines.find(
        (o) => o.frameOrdinal === childIdx,
      )?.outline;
      if (childOutline) {
        idToTree.set(iframeEncodedId, childOutline);
      }
    }
  }

  const rootOutline = perFrameOutlines[0]?.outline ?? "";
  const combinedTree = injectSubtrees(rootOutline, idToTree);

  return {
    combinedTree,
    combinedXpathMap,
    combinedUrlMap,
    // Synthetic frame IDs ("0", "1", …) are intentional — this is the native path,
    // not CDP, so there are no hex frame IDs. Downstream consumers use these only
    // for debugging; the actual lookup is by encodedId in combinedXpathMap.
    perFrame: perFrameOutlines.map(({ frameOrdinal, outline }) => {
      const perXpath: Record<string, string> = {};
      const perUrl: Record<string, string> = {};
      const frameData = frames.find((f) => f.frameOrdinal === frameOrdinal);
      for (const entry of frameData?.entries ?? []) {
        const encodedId = `${frameOrdinal}-${entry.ordinal}`;
        perXpath[encodedId] = entry.xpath;
        if (entry.href) perUrl[encodedId] = entry.href;
      }
      return {
        frameId: String(frameOrdinal),
        outline,
        xpathMap: perXpath,
        urlMap: perUrl,
      };
    }),
  };
}
