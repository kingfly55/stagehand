import { expect, test } from "vitest";
import { chromium } from "playwright-core";
import { PlaywrightNativePage } from "../../lib/v3/understudy/native/PlaywrightNativePage.js";

// Using data: URL instead of setContent because setContent uses document.open()+write()
// from a utility-world evaluate, which doesn't guarantee addScriptToEvaluateOnNewDocument
// fires before inline <script> tags. A goto() navigation via Page.navigate CDP command
// guarantees that registered init scripts run before any user scripts.
const HTML_WITH_CLOSED_SHADOW = `<html><body>
  <div id="host"></div>
  <script>
    var host = document.getElementById('host');
    var root = host.attachShadow({ mode: 'closed' });
    var span = document.createElement('span');
    span.setAttribute('role', 'status');
    span.textContent = 'closed-shadow-content';
    root.appendChild(span);
  </script>
</body></html>`;

function toDataUrl(html: string): string {
  return "data:text/html," + encodeURIComponent(html);
}

test(
  "pierceShadow: true does not capture closed shadow content",
  async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const pwPage = await context.newPage();
    const nativePage = new PlaywrightNativePage(pwPage, { logger: () => {} });

    // Install interceptor first, then navigate so it fires before the inline <script>
    await nativePage.captureSnapshot({ pierceShadow: "including-closed" });
    await pwPage.goto(toDataUrl(HTML_WITH_CLOSED_SHADOW));

    const snapshot = await nativePage.captureSnapshot({ pierceShadow: true });
    // With pierceShadow: true, walker does not call __stagehandClosedRoot
    expect(snapshot.combinedTree).not.toContain("closed-shadow-content");

    await browser.close();
  },
  30_000,
);

test(
  "pierceShadow: \"including-closed\" captures closed shadow content",
  async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const pwPage = await context.newPage();
    const nativePage = new PlaywrightNativePage(pwPage, { logger: () => {} });

    // Step 1: Register init script (installs the WeakMap interceptor via
    // Page.addScriptToEvaluateOnNewDocument so it fires before any user scripts)
    await nativePage.captureSnapshot({ pierceShadow: "including-closed" });

    // Step 2: Navigate via goto() — this is a real CDP Page.navigate call, so
    // addScriptToEvaluateOnNewDocument scripts run before inline <script> tags.
    // The interceptor patches attachShadow before the inline script runs.
    await pwPage.goto(toDataUrl(HTML_WITH_CLOSED_SHADOW));

    // Step 3: Capture snapshot — walker reads __stagehandClosedRoot
    const snapshot = await nativePage.captureSnapshot({
      pierceShadow: "including-closed",
    });

    expect(snapshot.combinedTree).toContain("closed-shadow-content");

    await browser.close();
  },
  30_000,
);
