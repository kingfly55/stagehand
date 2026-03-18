import { describe, it, expect, afterAll } from "vitest";
import {
  getChromiumPage,
  closeChromiumFixture,
} from "./helpers/chromiumFixture.js";
import { performNativeAction } from "../../lib/v3/understudy/native/actions/nativeActionDispatch.js";
import { StagehandInvalidArgumentError } from "../../lib/v3/types/public/sdkErrors.js";

afterAll(closeChromiumFixture);

describe("performNativeAction — click (CSS selector)", () => {
  it("fires a click event and observable side effect appears", async () => {
    const page = await getChromiumPage(`
      <html><body>
        <button id="btn" onclick="document.getElementById('count').textContent++">Click</button>
        <span id="count">0</span>
      </body></html>
    `);
    await performNativeAction(page, {
      method: "click",
      selector: "#btn",
      args: [],
      domSettleTimeoutMs: 0,
    });
    expect(await page.locator("#count").textContent()).toBe("1");
  });
});

describe("performNativeAction — click (XPath selector)", () => {
  it("fires a click event using xpath selector", async () => {
    const page = await getChromiumPage(`
      <html><body>
        <button id="btn2" onclick="document.getElementById('flag').textContent='yes'">XBtn</button>
        <span id="flag">no</span>
      </body></html>
    `);
    await performNativeAction(page, {
      method: "click",
      selector: "xpath=//button[@id='btn2']",
      args: [],
      domSettleTimeoutMs: 0,
    });
    expect(await page.locator("#flag").textContent()).toBe("yes");
  });
});

describe("performNativeAction — fill", () => {
  it("sets input value", async () => {
    const page = await getChromiumPage(
      `<html><body><input id="inp" type="text" /></body></html>`,
    );
    await performNativeAction(page, {
      method: "fill",
      selector: "#inp",
      args: ["hello"],
      domSettleTimeoutMs: 0,
    });
    expect(await page.locator("#inp").inputValue()).toBe("hello");
  });
});

describe("performNativeAction — fill (XPath selector)", () => {
  it("sets input value using xpath selector", async () => {
    const page = await getChromiumPage(
      `<html><body><input id="inp2" type="text" /></body></html>`,
    );
    await performNativeAction(page, {
      method: "fill",
      selector: "xpath=//input[@id='inp2']",
      args: ["hello xpath"],
      domSettleTimeoutMs: 0,
    });
    expect(await page.locator("#inp2").inputValue()).toBe("hello xpath");
  });
});

describe("performNativeAction — type", () => {
  it("types text into input via pressSequentially", async () => {
    const page = await getChromiumPage(
      `<html><body><input id="inp3" type="text" /></body></html>`,
    );
    await performNativeAction(page, {
      method: "type",
      selector: "#inp3",
      args: ["hello"],
      domSettleTimeoutMs: 0,
    });
    expect(await page.locator("#inp3").inputValue()).toBe("hello");
  });
});

describe("performNativeAction — press", () => {
  it("fires keypress and character appears in focused input", async () => {
    const page = await getChromiumPage(
      `<html><body><input id="inp4" type="text" /></body></html>`,
    );
    // Focus the input first, then press a key
    await page.locator("#inp4").focus();
    await performNativeAction(page, {
      method: "press",
      selector: "#inp4",
      args: ["a"],
      domSettleTimeoutMs: 0,
    });
    expect(await page.locator("#inp4").inputValue()).toBe("a");
  });
});

describe("performNativeAction — selectOption", () => {
  it("selects an option by value", async () => {
    const page = await getChromiumPage(`
      <html><body>
        <select id="sel">
          <option value="a">Apple</option>
          <option value="b">Banana</option>
        </select>
      </body></html>
    `);
    await performNativeAction(page, {
      method: "selectOption",
      selector: "#sel",
      args: ["a"],
      domSettleTimeoutMs: 0,
    });
    expect(await page.locator("#sel").inputValue()).toBe("a");
  });
});

describe("performNativeAction — hover", () => {
  it("hovering triggers :hover CSS state", async () => {
    const page = await getChromiumPage(`
      <html><head>
        <style>
          #hov { background: blue; }
          #hov:hover { background: red; }
        </style>
      </head><body>
        <div id="hov">Hover me</div>
        <div id="result">not-hovered</div>
        <script>
          document.getElementById('hov').addEventListener('mouseover', function() {
            document.getElementById('result').textContent = 'hovered';
          });
        </script>
      </body></html>
    `);
    await performNativeAction(page, {
      method: "hover",
      selector: "#hov",
      args: [],
      domSettleTimeoutMs: 0,
    });
    expect(await page.locator("#result").textContent()).toBe("hovered");
  });
});

describe("performNativeAction — doubleClick", () => {
  it("fires dblclick event", async () => {
    const page = await getChromiumPage(`
      <html><body>
        <div id="dbl">dbl</div>
        <span id="dbl-result">no</span>
        <script>
          document.getElementById('dbl').addEventListener('dblclick', function() {
            document.getElementById('dbl-result').textContent = 'yes';
          });
        </script>
      </body></html>
    `);
    await performNativeAction(page, {
      method: "doubleClick",
      selector: "#dbl",
      args: [],
      domSettleTimeoutMs: 0,
    });
    expect(await page.locator("#dbl-result").textContent()).toBe("yes");
  });
});

describe("performNativeAction — scroll", () => {
  it("changes scrollTop after scroll action", async () => {
    const page = await getChromiumPage(`
      <html><body>
        <div id="scrollable" style="height:200px;overflow-y:scroll;">
          <div style="height:2000px;">tall content</div>
        </div>
      </body></html>
    `);
    await performNativeAction(page, {
      method: "scroll",
      selector: "#scrollable",
      args: ["50"],
      domSettleTimeoutMs: 0,
    });
    const scrollTop = await page.evaluate(
      () => document.getElementById("scrollable")!.scrollTop,
    );
    expect(scrollTop).toBeGreaterThan(0);
  });
});

describe("performNativeAction — scrollTo alias", () => {
  it("scrollTo is an alias for scroll", async () => {
    const page = await getChromiumPage(`
      <html><body>
        <div id="scrollable2" style="height:200px;overflow-y:scroll;">
          <div style="height:2000px;">tall content</div>
        </div>
      </body></html>
    `);
    await performNativeAction(page, {
      method: "scrollTo",
      selector: "#scrollable2",
      args: ["25"],
      domSettleTimeoutMs: 0,
    });
    const scrollTop = await page.evaluate(
      () => document.getElementById("scrollable2")!.scrollTop,
    );
    expect(scrollTop).toBeGreaterThan(0);
  });
});

describe("performNativeAction — nextChunk / prevChunk", () => {
  it("nextChunk scrolls body down", async () => {
    const page = await getChromiumPage(`
      <html><body style="height:5000px;margin:0;">
        <div style="height:5000px;">tall page</div>
      </body></html>
    `);
    await performNativeAction(page, {
      method: "nextChunk",
      selector: "body",
      args: [],
      domSettleTimeoutMs: 0,
    });
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThan(0);
  });

  it("prevChunk scrolls body back up", async () => {
    const page = await getChromiumPage(`
      <html><body style="height:5000px;margin:0;">
        <div style="height:5000px;">tall page</div>
      </body></html>
    `);
    // Scroll down first
    await page.evaluate(() => window.scrollTo(0, 500));
    await performNativeAction(page, {
      method: "prevChunk",
      selector: "body",
      args: [],
      domSettleTimeoutMs: 0,
    });
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeLessThan(500);
  });
});

describe("performNativeAction — unknown method", () => {
  it("throws StagehandInvalidArgumentError for unknown methods", async () => {
    const page = await getChromiumPage(
      `<html><body><div id="x"></div></body></html>`,
    );
    await expect(
      performNativeAction(page, {
        method: "nonexistent",
        selector: "#x",
        args: [],
        domSettleTimeoutMs: 0,
      }),
    ).rejects.toThrow(StagehandInvalidArgumentError);
  });
});
