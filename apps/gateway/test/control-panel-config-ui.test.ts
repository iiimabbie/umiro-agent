import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";

const htmlUrl = new URL("../src/control-panel/index.html", import.meta.url);
const scriptUrl = new URL("../src/control-panel/app.js", import.meta.url);

test("control-panel settings use typed controls instead of one raw config textarea", async () => {
  const [html, script] = await Promise.all([readFile(htmlUrl, "utf8"), readFile(scriptUrl, "utf8")]);

  assert.match(html, /id="configForm"/);
  assert.doesNotMatch(html, /<textarea id="config"/);
  assert.doesNotThrow(() => new Script(script));
  assert.match(script, /path: 'model', type: 'model'/);
  assert.match(script, /input\.type = 'radio'/);
  assert.match(script, /path: 'embedding\.baseUrl', type: 'url'/);
  assert.match(script, /document\.createElement\('select'\)/);
});
