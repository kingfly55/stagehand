/**
 * Smoke test for captureNativeSnapshot.
 *
 * Usage: pnpm example v3/native_snapshot_smoke
 *
 * Launches Chromium, navigates to example.com, captures a native snapshot,
 * prints the combined tree, and verifies that XPaths round-trip correctly.
 */
import { chromium } from "playwright-core";
import { captureNativeSnapshot } from "../../lib/v3/understudy/native/snapshot/captureNativeSnapshot.js";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://example.com");

  const snapshot = await captureNativeSnapshot(page, {
    pierceShadow: true,
    includeIframes: true,
    experimental: false,
  });

  console.log("=== Combined Tree ===");
  console.log(snapshot.combinedTree);
  console.log("\n=== XPath Map (first 10 entries) ===");
  const entries = Object.entries(snapshot.combinedXpathMap);
  for (const [id, xpath] of entries.slice(0, 10)) {
    console.log(`  ${id} → ${xpath}`);
  }

  // Acceptance check: must have at least 5 entries
  if (entries.length < 5) {
    console.error(`FAIL: only ${entries.length} entries in xpathMap (expected >= 5)`);
    process.exit(1);
  }

  // XPath format check: all values must start with /html[1]/
  const badXPaths = entries.filter(([, xpath]) => !xpath.startsWith("/html[1]/"));
  if (badXPaths.length > 0) {
    console.error(`FAIL: ${badXPaths.length} XPaths do not start with /html[1]/:`);
    for (const [id, xpath] of badXPaths.slice(0, 5)) {
      console.error(`  ${id} → ${xpath}`);
    }
    process.exit(1);
  }

  // Round-trip check: first XPath must resolve to exactly 1 element
  // count() materializes the locator — bare locator() is always lazy and always succeeds
  const [firstId, firstXPath] = entries[0]!;
  const count = await page.locator(`xpath=${firstXPath}`).count();
  if (count !== 1) {
    console.error(
      `ROUND-TRIP FAIL: ${firstXPath} matched ${count} elements (expected 1)`,
    );
    process.exit(1);
  }
  console.log(`\nRound-trip OK: ${firstId} → ${firstXPath} → 1 element`);

  // perFrame check
  if (!snapshot.perFrame || snapshot.perFrame.length === 0) {
    console.error("FAIL: perFrame is absent or empty");
    process.exit(1);
  }
  console.log(`perFrame OK: ${snapshot.perFrame.length} frame(s) captured`);

  console.log("\nAll checks passed.");

  await page.close();
  await context.close();
  await browser.close();
})();
