import type { Browser, BrowserContext, Page } from "playwright-core";

let browser: Browser | undefined;
let context: BrowserContext | undefined;

export async function getChromiumPage(html: string): Promise<Page> {
  const { chromium } = await import("playwright-core");
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  if (!context) {
    context = await browser.newContext();
  }
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  return page;
}

export async function closeChromiumFixture(): Promise<void> {
  await context?.close();
  await browser?.close();
  browser = undefined;
  context = undefined;
}
