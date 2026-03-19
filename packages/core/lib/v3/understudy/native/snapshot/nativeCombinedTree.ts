import type * as playwright from "playwright-core";
import { v3Logger } from "../../../logger.js";
import type { NativeA11yOptions } from "../../../types/private/snapshot.js";

/**
 * Shape of each entry returned by the injected page.evaluate() script.
 * Every field is a JSON primitive — no DOM references, no circular objects.
 */
export type NativeNodeEntry = {
  ordinal: number;       // incrementing int, unique within this frame call, reset to 0 per frame
  depth: number;         // tree depth for hierarchy reconstruction (root = 0)
  parentOrdinal: number; // ordinal of parent element; -1 for root
  xpath: string;         // absolute XPath e.g. /html[1]/body[1]/h1[1]
  tag: string;           // lowercase tag name
  role: string;          // effective ARIA role
  name: string;          // accessible name
  isScrollable: boolean; // element is scrollable
  isShadowHost: boolean; // element has a shadowRoot
  isIframeHost: boolean; // tag === 'iframe'
  href?: string;         // only when tag === 'a' or tag === 'area'
  // Phase 6: ARIA state attributes
  expanded?: string | null;   // aria-expanded: "true"/"false"/null
  checked?: string | null;    // aria-checked: "true"/"false"/"mixed"/null
  selected?: string | null;   // aria-selected: "true"/"false"/null
  disabled?: boolean;         // true when aria-disabled="true" OR [disabled] attr present
};

/**
 * The injected script is a raw JS string to avoid esbuild/tsx transformations
 * (e.g. __name wrappers) that reference helpers absent from the browser context.
 *
 * It receives `{ pierceShadow }` as its argument and returns a plain array of
 * plain objects — JSON-serializable only.
 *
 * CRITICAL: Never return DOM node references, NodeList, HTMLElement, or circular
 * structures — that causes page.evaluate() to throw "object could not be cloned".
 */
const INJECTED_SCRIPT_SRC = `
(function({ pierceShadow }) {
  function buildXPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
      var tag = node.tagName.toLowerCase();
      var idx = 1;
      var sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName.toLowerCase() === tag) idx++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(tag + '[' + idx + ']');
      node = node.parentElement;
    }
    return '/html[1]/' + parts.join('/');
  }

  var IMPLICIT_ROLES = {
    a: function(el) { return el.getAttribute('href') ? 'link' : 'generic'; },
    area: 'link', article: 'article', aside: 'complementary',
    button: 'button', caption: 'caption', code: 'code',
    datalist: 'listbox', details: 'group', dialog: 'dialog',
    fieldset: 'group', figure: 'figure', footer: 'contentinfo',
    form: 'form', h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading',
    header: 'banner', hr: 'separator',
    img: function(el) { return el.getAttribute('alt') !== null ? 'img' : 'presentation'; },
    input: function(el) {
      var type = el.type || 'text';
      var map = {
        checkbox: 'checkbox', radio: 'radio', range: 'slider',
        button: 'button', submit: 'button', reset: 'button',
        search: 'searchbox', text: 'textbox', email: 'textbox',
        tel: 'textbox', url: 'textbox', number: 'spinbutton',
        password: 'textbox'
      };
      return map[type] || 'textbox';
    },
    li: 'listitem', link: 'link', main: 'main', math: 'math',
    menu: 'list', meter: 'meter', nav: 'navigation', ol: 'list',
    option: 'option', output: 'status', p: 'paragraph',
    progress: 'progressbar',
    section: function(el) {
      return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? 'region' : 'generic';
    },
    select: function(el) { return el.multiple || el.size > 1 ? 'listbox' : 'combobox'; },
    summary: 'button', table: 'table', tbody: 'rowgroup',
    td: 'cell', textarea: 'textbox', tfoot: 'rowgroup',
    th: function(el) { return el.scope === 'row' ? 'rowheader' : 'columnheader'; },
    thead: 'rowgroup', time: 'time', tr: 'row', ul: 'list'
  };

  function getRole(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    var tag = el.tagName.toLowerCase();
    var implicit = IMPLICIT_ROLES[tag];
    if (!implicit) return 'generic';
    return typeof implicit === 'function' ? implicit(el) : implicit;
  }

  function truncate(text) {
    return Array.from(text).slice(0, 200).join('');
  }

  // Returns text content while skipping aria-hidden subtrees (per accname-1.1 spec).
  function getVisibleText(node) {
    var text = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      if (child.nodeType === 3) {
        text += child.nodeValue;
      } else if (child.nodeType === 1 && child.getAttribute('aria-hidden') !== 'true') {
        text += getVisibleText(child);
      }
    }
    return text;
  }

  function getAccessibleName(el) {
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var text = labelledBy.split(' ')
        .map(function(id) {
          var node = document.getElementById(id);
          return node ? getVisibleText(node).trim() : '';
        })
        .join(' ').trim();
      if (text) return truncate(text);
    }
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) { ariaLabel = ariaLabel.trim(); if (ariaLabel) return truncate(ariaLabel); }
    var title = el.getAttribute('title');
    if (title) { title = title.trim(); if (title) return truncate(title); }
    var id = el.getAttribute('id');
    if (id) {
      var lbl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lbl) { var lt = getVisibleText(lbl).trim(); if (lt) return truncate(lt); }
    }
    var tc = getVisibleText(el).trim();
    if (tc) return truncate(tc);
    return '';
  }

  function isScrollable(el) {
    var style = window.getComputedStyle(el);
    var overflow = style.overflow + style.overflowX + style.overflowY;
    if (/hidden|clip/.test(overflow)) return false;
    return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
  }

  var entries = [];
  var ordinal = 0;

  function walk(el, depth, parentOrdinal) {
    if (!el || el.nodeType !== 1) return;
    if (el.getAttribute("aria-hidden") === "true") return;
    var myOrdinal = ordinal++;
    var tag = el.tagName.toLowerCase();
    var role = getRole(el);
    var name = getAccessibleName(el);
    var xpath = buildXPath(el);
    var href = (tag === 'a' || tag === 'area') ? (el.getAttribute('href') || undefined) : undefined;

    entries.push({
      ordinal: myOrdinal,
      depth: depth,
      parentOrdinal: parentOrdinal,
      xpath: xpath,
      tag: tag,
      role: role,
      name: name,
      isScrollable: isScrollable(el),
      isShadowHost: !!el.shadowRoot || (
        pierceShadow === "including-closed" &&
        typeof window.__stagehandClosedRoot === "function" &&
        !!window.__stagehandClosedRoot(el)
      ),
      isIframeHost: tag === 'iframe',
      href: href,
      expanded: el.getAttribute("aria-expanded"),
      checked: el.getAttribute("aria-checked"),
      selected: el.getAttribute("aria-selected"),
      disabled: el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled"),
    });

    for (var i = 0; i < el.children.length; i++) {
      walk(el.children[i], depth + 1, myOrdinal);
    }

    if (pierceShadow && el.shadowRoot) {
      var shadowChildren = el.shadowRoot.children;
      for (var j = 0; j < shadowChildren.length; j++) {
        var child = shadowChildren[j];
        if (child.tagName && child.tagName.toLowerCase() === 'slot') {
          var assigned = child.assignedElements({ flatten: true });
          if (assigned.length > 0) {
            for (var k = 0; k < assigned.length; k++) walk(assigned[k], depth + 1, myOrdinal);
          } else {
            for (var m = 0; m < child.children.length; m++) walk(child.children[m], depth + 1, myOrdinal);
          }
        } else {
          walk(child, depth + 1, myOrdinal);
        }
      }
    }

    // KNOWN LIMITATIONS for closed shadow roots:
    // 1. Light-DOM children of this host were already walked via el.children above.
    //    If the closed shadow slots those children, they will appear twice in the
    //    snapshot (once from light DOM, once from slot resolution). Deferred fix.
    // 2. buildXPath() walks parentElement, which is null inside a shadow root.
    //    XPaths for elements inside a closed shadow root will truncate at the
    //    host boundary, producing non-unique paths. Deferred fix.
    if (pierceShadow === "including-closed" && !el.shadowRoot) {
      var closedRoot = typeof window.__stagehandClosedRoot === "function"
        ? window.__stagehandClosedRoot(el)
        : null;
      if (closedRoot) {
        var csChildren = closedRoot.children;
        for (var ci2 = 0; ci2 < csChildren.length; ci2++) {
          var csChild = csChildren[ci2];
          if (csChild.tagName && csChild.tagName.toLowerCase() === 'slot') {
            var csAssigned = csChild.assignedElements({ flatten: true });
            if (csAssigned.length > 0) {
              for (var ca = 0; ca < csAssigned.length; ca++) walk(csAssigned[ca], depth + 1, myOrdinal);
            } else {
              for (var cd = 0; cd < csChild.children.length; cd++) walk(csChild.children[cd], depth + 1, myOrdinal);
            }
          } else {
            walk(csChild, depth + 1, myOrdinal);
          }
        }
      }
    }
  }

  // Walk children of documentElement (head, body) so every entry has an XPath
  // that starts with /html[1]/ — walking documentElement itself would produce
  // the malformed xpath /html[1]/ (trailing slash) for the root element.
  var docChildren = document.documentElement.children;
  for (var ci = 0; ci < docChildren.length; ci++) {
    walk(docChildren[ci], 0, -1);
  }
  return entries;
})
`;

/**
 * Walk every in-scope frame and capture a flat NativeNodeEntry[] from each
 * using a single page.evaluate() call per frame.
 *
 * Important: page.frames() is called exactly ONCE and the result is snapshotted
 * before the loop to prevent frameOrdinal corruption if frames are added/removed
 * mid-iteration.
 */
export async function captureNativeCombinedTree(
  page: playwright.Page,
  opts: NativeA11yOptions,
): Promise<{
  frames: Array<{
    frameOrdinal: number;
    frameUrl: string;
    entries: NativeNodeEntry[];
  }>;
}> {
  // Snapshot frame list once — do not call page.frames() inside the loop
  const framesInScope = opts.includeIframes ? page.frames() : [page.mainFrame()];

  if (!opts.pierceShadow) {
    v3Logger({
      message:
        "pierceShadow=false: shadow DOM content excluded from native snapshot",
      level: 2,
    });
  }

  const results: Array<{
    frameOrdinal: number;
    frameUrl: string;
    entries: NativeNodeEntry[];
  }> = [];

  for (let i = 0; i < framesInScope.length; i++) {
    const frame = framesInScope[i]!;
    try {
      // Pass the script as a string to avoid esbuild __name serialization issues.
      // The string is a self-contained IIFE factory that accepts { pierceShadow }.
      const entries = await frame.evaluate(
        new Function(
          "arg",
          `return (${INJECTED_SCRIPT_SRC})(arg)`,
        ) as (arg: { pierceShadow: boolean | "including-closed" }) => NativeNodeEntry[],
        { pierceShadow: opts.pierceShadow },
      );
      results.push({ frameOrdinal: i, frameUrl: frame.url(), entries });
    } catch (err) {
      v3Logger({
        message: `frame ${i} (${frame.url()}) evaluate failed: ${String(err)}`,
        level: 1,
      });
      results.push({ frameOrdinal: i, frameUrl: frame.url(), entries: [] });
    }
  }

  return { frames: results };
}
