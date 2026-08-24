import assert from "node:assert/strict";
import { test } from "node:test";
import { renderConsoleV3, renderPanelsV3 } from "../src/console.js";

// The console is one page whose behavior lives in inline scripts. A single bad escape in
// an emitted string kills every handler in that tag silently — the page still looks fine.
// So: every inline script in both builds must parse, every panel must render, and the
// static build must never carry served-only affordances.
test("console v3: every inline script parses, in both builds", () => {
  for (const served of [true, false]) {
    const html = renderConsoleV3({ served, requestToken: served ? "tok" : undefined });
    const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    assert.ok(scripts.length >= 3, "expected the bootstrap, main, and drawer scripts");
    for (const [i, s] of scripts.entries()) {
      assert.doesNotThrow(() => new Function(s), `script ${i} in the ${served ? "served" : "static"} build does not parse`);
    }
    assert.ok(html.includes('data-tab="inbox"') && html.includes('data-tab="system"'), "the four tabs render");
  }
});

test("console v3: panels render and the static build stays inert", () => {
  const panels = renderPanelsV3({ served: false });
  for (const key of ["inbox", "accounts", "search", "system"] as const) {
    assert.equal(typeof panels[key], "string");
    assert.ok(panels[key].length > 100, `${key} panel is suspiciously empty`);
  }
  const staticHtml = renderConsoleV3({ served: false });
  assert.ok(!staticHtml.includes("data-send-slack"), "the static build must not offer Send to Slack");
  assert.ok(!staticHtml.includes('id="go-search"'), "the static build must not offer a run button");
});
