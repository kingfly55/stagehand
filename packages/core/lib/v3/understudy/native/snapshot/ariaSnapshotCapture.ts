import type * as playwright from "playwright-core";
import type {
  HybridSnapshot,
  NativeA11yOptions,
  A11yNode,
} from "../../../types/private/snapshot.js";
import { v3Logger } from "../../../logger.js";
import {
  formatTreeLine,
  cleanText,
} from "../../a11y/snapshot/treeFormatUtils.js";

/**
 * Captures an accessibility snapshot using Playwright's built-in ARIA engine
 * via page._snapshotForAI() (playwright-core >= 1.52, method name has underscore prefix).
 *
 * Refs returned in the YAML are valid only until the next _snapshotForAI() call or
 * page navigation. Stagehand's snapshot->act->snapshot pattern ensures refs are always
 * fresh. Do NOT merge or reuse combinedXpathMap from a prior snapshot after re-snapshotting.
 *
 * Shadow DOM: _snapshotForAI() pierces open shadow DOM automatically via Playwright's
 * slot distribution logic. Closed shadow DOM is out of scope for Phase 7.
 */
export async function captureAriaSnapshot(
  page: playwright.Page,
  opts: NativeA11yOptions,
): Promise<HybridSnapshot> {
  let yaml: string;
  try {
    const result = await (page as any)._snapshotForAI();
    yaml = (
      typeof result === "string" ? result : (result?.full ?? "")
    ).trim();
  } catch (err) {
    v3Logger({ message: `_snapshotForAI threw: ${String(err)}`, level: 1 });
    throw err;
  }

  if (!yaml) {
    return {
      combinedTree: "",
      combinedXpathMap: {},
      combinedUrlMap: {},
      perFrame: [],
    };
  }

  // Parse YAML line by line
  interface ParsedEntry {
    indent: number;
    role: string;
    name: string;
    ref: string | null;
    ordinal: number;
    encodedId: string;
    parentOrdinal: number;
  }

  const indentStack: number[] = [];
  let ordinal = 0;
  const entries: ParsedEntry[] = [];

  for (const rawLine of yaml.split("\n")) {
    if (!rawLine.trim()) continue;
    if (!rawLine.trim().includes("-")) continue;

    const indentMatch = rawLine.match(/^(\s*)/);
    const indentLevel = Math.floor((indentMatch?.[1].length ?? 0) / 2);
    const rest = rawLine.replace(/^\s*-\s*/, "");

    const roleRaw = rest.match(/^([\w-]+)/)?.[1] ?? "generic";
    const role = roleRaw.replace(/:$/, "");

    const nameMatch = rest.match(/"((?:[^"\\]|\\.)*)"/);
    const name = nameMatch
      ? nameMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")
      : "";

    const refMatch = rest.match(/\[ref=(e\d+)\]/);
    const ref = refMatch ? refMatch[1] : null;

    while (indentStack.length > indentLevel) {
      indentStack.pop();
    }
    const parentOrdinal =
      indentLevel > 0 ? (indentStack[indentLevel - 1] ?? -1) : -1;

    const myOrdinal = ordinal++;
    entries.push({
      indent: indentLevel,
      role,
      name,
      ref,
      ordinal: myOrdinal,
      encodedId: `0-${myOrdinal}`,
      parentOrdinal,
    });
    indentStack[indentLevel] = myOrdinal;
  }

  // XPath extractor function (not new Function())
  const XPATH_FN = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
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
  };

  // Href extractor function (not new Function())
  const HREF_FN = (el: Element): string => {
    const a = el.closest("a");
    if (a) return a.href || "";
    return el.getAttribute("href") ?? "";
  };

  // Resolve xpaths for ref-bearing entries (keyed by ref string for stability)
  const refEntries = entries.filter((e) => e.ref !== null);

  const xpathByRef = new Map<string, string>();
  const hrefByRef = new Map<string, string>();

  await Promise.all(
    refEntries.map(async (entry) => {
      const loc = page.locator(`aria-ref=${entry.ref!}`);
      try {
        const xpath = await loc.evaluate(XPATH_FN);
        xpathByRef.set(entry.ref!, xpath);
        if (entry.role === "link") {
          const href = await loc.evaluate(HREF_FN).catch(() => "");
          hrefByRef.set(entry.ref!, href);
        }
      } catch {
        // Non-resolvable refs are silently skipped
      }
    }),
  );

  // Apply focusSelector AFTER xpath resolution
  let filteredEntries = entries;

  if (opts.focusSelector) {
    try {
      const focusXPath = await page
        .locator(opts.focusSelector)
        .evaluate(XPATH_FN);
      if (focusXPath) {
        const scoped = filteredEntries.filter((e) => {
          const xpath = e.ref ? (xpathByRef.get(e.ref) ?? "") : "";
          return xpath && xpath.startsWith(focusXPath);
        });
        if (scoped.length > 0) {
          filteredEntries = scoped.map((e, i) => ({
            ...e,
            ordinal: i,
            encodedId: `0-${i}`,
          }));
        }
      }
    } catch (err) {
      v3Logger({
        message: `focusSelector "${opts.focusSelector}" resolution failed: ${String(err)}`,
        level: 1,
      });
    }
  }

  // Build xpath and url maps
  const combinedXpathMap: Record<string, string> = {};
  const combinedUrlMap: Record<string, string> = {};

  for (const entry of filteredEntries) {
    if (entry.ref) {
      const xpath = xpathByRef.get(entry.ref) ?? "";
      if (xpath) combinedXpathMap[entry.encodedId] = xpath;
      const href = hrefByRef.get(entry.ref) ?? "";
      if (href) combinedUrlMap[entry.encodedId] = href;
    }
  }

  // Build tree using A11yNode objects
  const nodeMap = new Map<number, A11yNode & { _ordinal: number }>();
  const roots: (A11yNode & { _ordinal: number })[] = [];

  for (const entry of filteredEntries) {
    const node: A11yNode & { _ordinal: number } = {
      _ordinal: entry.ordinal,
      encodedId: entry.encodedId,
      role: entry.role,
      name: entry.name ? cleanText(entry.name) || undefined : undefined,
      nodeId: entry.encodedId,
      children: [],
    };
    nodeMap.set(entry.ordinal, node);
    if (entry.parentOrdinal === -1) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(entry.parentOrdinal);
      if (parent) {
        parent.children = parent.children ?? [];
        parent.children.push(node);
      }
    }
  }

  const combinedTree = roots.map((r) => formatTreeLine(r, 0)).join("\n");

  v3Logger({
    message: `aria snapshot: ${filteredEntries.length} nodes, ${Object.keys(combinedXpathMap).length} with xpaths`,
    level: 2,
  });

  const perFrame = [
    {
      frameId: "0",
      outline: combinedTree,
      xpathMap: combinedXpathMap,
      urlMap: combinedUrlMap,
    },
  ];

  return { combinedTree, combinedXpathMap, combinedUrlMap, perFrame };
}
