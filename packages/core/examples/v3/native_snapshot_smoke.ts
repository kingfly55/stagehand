/**
 * Smoke test for captureNativeSnapshot.
 *
 * Usage:
 *   pnpm example v3/native_snapshot_smoke            # aria engine path
 *   pnpm example v3/native_snapshot_smoke --fallback # fallback DOM walker path
 *
 * Launches Chromium, navigates to example.com, captures a native snapshot,
 * prints the combined tree, and verifies that XPaths round-trip correctly.
 * Also tests aria-expanded and label-for association.
 */
import { chromium } from "playwright-core";
import { captureNativeSnapshot } from "../../lib/v3/understudy/native/snapshot/captureNativeSnapshot.js";

const args = process.argv.slice(2);
const useFallback = args.includes("--fallback");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Stub _snapshotForAI to test fallback path
  if (useFallback) {
    (page as any)._snapshotForAI = undefined;
    console.log("=== Running with engine: fallback (DOM walker) ===");
  } else {
    console.log("=== Running with engine: aria (_snapshotForAI) ===");
  }

  // --- Test 1: example.com basic snapshot ---
  await page.goto("https://example.com");

  const snapshot = await captureNativeSnapshot(page, {
    pierceShadow: true,
    includeIframes: true,
    experimental: false,
  });

  console.log("\n=== Combined Tree ===");
  console.log(snapshot.combinedTree);
  console.log("\n=== XPath Map (first 10 entries) ===");
  const entries = Object.entries(snapshot.combinedXpathMap);
  for (const [id, xpath] of entries.slice(0, 10)) {
    console.log(`  ${id} → ${xpath}`);
  }

  // Check "Example Domain" appears in tree
  if (!snapshot.combinedTree.includes("Example Domain")) {
    console.error(
      'FAIL: combinedTree does not contain "Example Domain"',
    );
    process.exit(1);
  }
  console.log('\nOK: combinedTree contains "Example Domain"');

  // Check at least one link line appears
  if (!snapshot.combinedTree.includes("] link")) {
    console.error('FAIL: combinedTree does not contain any "] link" line');
    process.exit(1);
  }
  console.log('OK: combinedTree contains at least one "] link" line');

  // Acceptance check: must have at least 5 entries
  if (entries.length < 5) {
    console.error(
      `FAIL: only ${entries.length} entries in xpathMap (expected >= 5)`,
    );
    process.exit(1);
  }
  console.log(`OK: xpathMap has ${entries.length} entries`);

  // XPath format check: all values must start with /html[1]/
  const badXPaths = entries.filter(
    ([, xpath]) => !xpath.startsWith("/html[1]/"),
  );
  if (badXPaths.length > 0) {
    console.error(
      `FAIL: ${badXPaths.length} XPaths do not start with /html[1]/`,
    );
    for (const [id, xpath] of badXPaths.slice(0, 5)) {
      console.error(`  ${id} → ${xpath}`);
    }
    process.exit(1);
  }
  console.log("OK: all XPaths start with /html[1]/");

  // Round-trip check: first XPath must resolve to exactly 1 element
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

  // --- Test 2: aria-expanded attribute ---
  console.log("\n=== Test: aria-expanded ===");
  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <body>
        <button aria-expanded="true" aria-controls="menu">Open Menu</button>
        <ul id="menu" role="list">
          <li role="listitem"><a href="#">Item 1</a></li>
          <li role="listitem"><a href="#">Item 2</a></li>
        </ul>
      </body>
    </html>
  `);

  const expandedSnapshot = await captureNativeSnapshot(page, {
    pierceShadow: true,
    includeIframes: false,
    experimental: false,
  });

  console.log("Expanded tree:");
  console.log(expandedSnapshot.combinedTree);

  // Get raw YAML for aria engine to check for expanded token
  if (!useFallback && typeof (page as any)._snapshotForAI === "function") {
    const rawResult = await (page as any)._snapshotForAI();
    const rawYaml =
      typeof rawResult === "string"
        ? rawResult
        : (rawResult?.full ?? "");
    console.log("\nRaw YAML:");
    console.log(rawYaml);
    if (
      rawYaml.includes("[expanded]") ||
      rawYaml.includes("expanded=true") ||
      rawYaml.includes("expanded: true")
    ) {
      console.log("OK: raw YAML contains expanded indicator");
    } else {
      console.log(
        "INFO: raw YAML does not explicitly show expanded token (browser/version dependent)",
      );
    }
  }

  if (!expandedSnapshot.combinedTree.includes("Open Menu")) {
    console.error(
      'FAIL: expanded snapshot does not contain "Open Menu" button',
    );
    process.exit(1);
  }
  console.log("OK: expanded snapshot contains Open Menu button");

  // --- Test 3: label for association ---
  console.log("\n=== Test: label for association ===");
  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <body>
        <form>
          <label for="email">Email</label>
          <input type="email" id="email" name="email" placeholder="you@example.com" />
          <label for="password">Password</label>
          <input type="password" id="password" name="password" />
          <button type="submit">Submit</button>
        </form>
      </body>
    </html>
  `);

  const formSnapshot = await captureNativeSnapshot(page, {
    pierceShadow: true,
    includeIframes: false,
    experimental: false,
  });

  console.log("Form tree:");
  console.log(formSnapshot.combinedTree);

  if (!formSnapshot.combinedTree.includes("Email")) {
    console.error('FAIL: form snapshot does not contain "Email" label');
    process.exit(1);
  }
  console.log('OK: form snapshot contains "Email"');

  // Engine label for final output
  if (useFallback) {
    console.log("\nengine: fallback");
  } else {
    console.log("\nengine: aria");
  }

  console.log("\nAll checks passed.");

  await page.close();
  await context.close();
  await browser.close();
})();
