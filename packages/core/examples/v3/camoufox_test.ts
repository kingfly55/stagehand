/**
 * Camoufox compatibility probe for Stagehand V3
 *
 * Run: pnpm example v3/camoufox_test
 *
 * Tests three things in order:
 *   1. Playwright server connection (ws connect, not CDP)
 *   2. CDP bridge availability (newCDPSession — required by Stagehand's page bridge)
 *   3. Stagehand integration (only runs if CDP bridge works)
 *
 * Required env vars (set in .env at repo root or export in shell):
 *   CAMOUFOX_WS   — WebSocket URL printed by camoufox on startup
 *                   e.g. ws://localhost:42797/9e2abceb2cbd8d8595f441890e50815f
 *
 * Optional env vars:
 *   OPENROUTER_API_KEY — OpenRouter key (preferred)
 *   OPENAI_API_KEY     — OpenAI key (fallback)
 *   STAGEHAND_MODEL    — OpenRouter model ID (default: google/gemini-2.5-pro)
 *
 * Example .env:
 *   CAMOUFOX_WS=ws://localhost:42797/<token>
 *   OPENROUTER_API_KEY=sk-or-...
 */

import { chromium } from "playwright-core";
import { Stagehand } from "../../lib/v3/index.js";
import { z } from "zod";

const WS_ENDPOINT = process.env["CAMOUFOX_WS"] ?? "";
if (!WS_ENDPOINT) {
  console.error(
    "ERROR: CAMOUFOX_WS not set.\n" +
    "Start camoufox and copy the WebSocket URL it prints, then:\n" +
    "  export CAMOUFOX_WS=ws://localhost:<port>/<token>\n" +
    "or add it to .env at the repo root.",
  );
  process.exit(1);
}

const OPENROUTER_KEY = process.env["OPENROUTER_API_KEY"] ?? "";
const OPENAI_KEY    = process.env["OPENAI_API_KEY"] ?? "";
const MODEL_NAME    = process.env["STAGEHAND_MODEL"] ?? "google/gemini-2.5-pro";

const TEST_URL = "https://example.com";

function log(stage: string, msg: string) {
  console.log(`[${stage}] ${msg}`);
}

// ── Stage 1: Basic Playwright connection ──────────────────────────────────────
async function stage1() {
  log("STAGE 1", `Connecting to Playwright server at ${WS_ENDPOINT} …`);

  // Use connect() (Playwright protocol), NOT connectOverCDP() — camoufox speaks Juggler.
  const browser = await chromium.connect({ wsEndpoint: WS_ENDPOINT });
  log("STAGE 1", `Connected. Browser version: ${browser.version()}`);

  const contexts = browser.contexts();
  const ctx = contexts.length > 0 ? contexts[0] : await browser.newContext();

  const pages = ctx.pages();
  const page = pages.length > 0 ? pages[0] : await ctx.newPage();

  await page.goto(TEST_URL);
  const title = await page.title();
  log("STAGE 1", `Navigated to ${TEST_URL} — title: "${title}"`);
  log("STAGE 1", "PASS — basic Playwright connection works.\n");

  return { browser, ctx, page };
}

// ── Stage 2: CDP bridge probe ─────────────────────────────────────────────────
// Stagehand's Playwright bridge calls:
//   const cdp = await page.context().newCDPSession(page);
//   const { frameTree } = await cdp.send("Page.getFrameTree");
// This only works on Chromium. On Firefox/Juggler it throws.
async function stage2(page: Awaited<ReturnType<typeof stage1>>["page"]) {
  log("STAGE 2", "Testing CDP bridge (newCDPSession) …");
  try {
    const cdp = await page.context().newCDPSession(page);
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const frameId = frameTree.frame.id;
    log("STAGE 2", `PASS — CDP bridge works! mainFrameId: ${frameId}`);
    log("STAGE 2", "Stagehand's Playwright page bridge should work.\n");
    return frameId;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("STAGE 2", `FAIL — CDP bridge threw: ${msg}`);
    log(
      "STAGE 2",
      "Stagehand's current Playwright bridge is Chromium-only and will NOT work as-is.\n",
    );
    log(
      "STAGE 2",
      "To proceed, Stagehand would need a Juggler-native resolveTopFrameId path,\n" +
        "         OR camoufox must expose a raw CDP endpoint you can pass via cdpUrl.\n",
    );
    return null;
  }
}

// ── Stage 3: Stagehand integration (only runs if stage 2 passes) ──────────────
// Stagehand must also have its own V3Context connected to the same browser.
// The trick: launch Stagehand with env:"LOCAL" + cdpUrl = the raw CDP WebSocket URL.
// If camoufox only exposes a Playwright server endpoint (not a raw CDP URL) this
// init step will fail — which is useful information in itself.
async function stage3(pwPage: Awaited<ReturnType<typeof stage1>>["page"]) {
  log(
    "STAGE 3",
    "Initialising Stagehand with env:LOCAL + cdpUrl = WS_ENDPOINT …",
  );

  // ModelConfiguration: string (model name only) OR { modelName, ...ClientOptions }
  // Use the object form so we can inject baseURL for OpenRouter.
  const hasKey = OPENROUTER_KEY || OPENAI_KEY;
  if (!hasKey) {
    log("STAGE 3", "SKIP — no LLM API key set (OPENROUTER_API_KEY or OPENAI_API_KEY).");
    return;
  }

  const model = OPENROUTER_KEY
    ? { modelName: MODEL_NAME as `${string}/${string}`, baseURL: "https://openrouter.ai/api/v1", apiKey: OPENROUTER_KEY }
    : { modelName: MODEL_NAME as `${string}/${string}`, apiKey: OPENAI_KEY };

  log("STAGE 3", `Using model: ${MODEL_NAME}`);

  // NOTE: WS_ENDPOINT here is the Playwright server URL. Stagehand's V3Context
  // expects a raw CDP WebSocket URL. If camoufox exposes one separately, substitute
  // it here. This will tell us whether the raw CDP endpoint is also accessible.
  // Phase 5 will rewrite this init to use browserContext: pwPage.context() instead.
  const stagehand = new Stagehand({
    env: "LOCAL",
    verbose: 1,
    model,
    localBrowserLaunchOptions: {
      cdpUrl: WS_ENDPOINT, // will fail if not a raw CDP endpoint
    },
  });

  try {
    await stagehand.init();
    log("STAGE 3", "Stagehand init OK.");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(
      "STAGE 3",
      `Stagehand init FAILED (expected if WS_ENDPOINT is Playwright-server-only): ${msg}`,
    );
    log(
      "STAGE 3",
      "If camoufox exposes a separate CDP port (--remote-debugging-port), use that URL instead.\n",
    );
    return;
  }

  // If init worked, try passing the Playwright page to Stagehand.
  log("STAGE 3", "Running stagehand.observe() with the camoufox page …");
  try {
    const observations = await stagehand.observe({ page: pwPage });
    log("STAGE 3", `observe() returned ${observations.length} elements.`);
    console.log(observations.slice(0, 3));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("STAGE 3", `observe() FAILED: ${msg}`);
  }

  // Quick extract test.
  log("STAGE 3", "Running stagehand.extract() …");
  try {
    const result = await stagehand.extract(
      "extract the page heading",
      z.string(),
      { page: pwPage },
    );
    log("STAGE 3", `extract() result: "${result}"`);
    log("STAGE 3", "PASS — full Stagehand integration works with camoufox!\n");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("STAGE 3", `extract() FAILED: ${msg}\n`);
  }

  await stagehand.close();
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  let browser: Awaited<ReturnType<typeof stage1>>["browser"] | undefined;
  try {
    const { browser: b, page } = await stage1();
    browser = b;
    const frameId = await stage2(page);
    if (frameId !== null) {
      await stage3(page);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Fatal error:", msg);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
