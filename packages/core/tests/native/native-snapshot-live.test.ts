import { expect, test } from "vitest";
import { chromium } from "playwright-core";
import { captureNativeSnapshot } from "../../lib/v3/understudy/native/snapshot/captureNativeSnapshot.js";

test("round-trip: XPaths resolve to real elements", async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.setContent(
    `<html><body><h1>Hello</h1><a href="/x">Link</a></body></html>`,
  );

  const snapshot = await captureNativeSnapshot(page, {
    pierceShadow: true,
    includeIframes: true,
    experimental: false,
  });

  // 1. h1 XPath correct
  const h1Entry = Object.entries(snapshot.combinedXpathMap).find(
    ([, xpath]) => xpath === "/html[1]/body[1]/h1[1]",
  );
  expect(h1Entry).toBeDefined();

  // 2. XPath round-trips to exactly 1 element
  // count() materializes the locator — bare locator() is always lazy and always succeeds
  const h1Locator = page.locator(`xpath=/html[1]/body[1]/h1[1]`);
  expect(await h1Locator.count()).toBe(1);

  // 3. a href in urlMap
  const linkEntry = Object.entries(snapshot.combinedXpathMap).find(
    ([, xpath]) => xpath === "/html[1]/body[1]/a[1]",
  );
  expect(linkEntry).toBeDefined();
  expect(snapshot.combinedUrlMap[linkEntry![0]!]).toBe("/x");

  // 4. perFrame present
  expect(snapshot.perFrame).toBeDefined();
  expect(snapshot.perFrame!.length).toBeGreaterThan(0);

  await page.close();
  await context.close();
  await browser.close();
}, 30000);
