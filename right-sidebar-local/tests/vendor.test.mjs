// pele.js は git に入れず、pnpm install（postinstall の vendor）が node_modules から写す。
// 写しが無い・古いまま mod を置き直すと、描画が古い版で動くか import で落ちるので、ここで気づけるようにする
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const dir = new URL("../", import.meta.url);
const read = async (path, hint) => {
  try { return await readFile(new URL(path, dir)); } catch (e) {
    if (e.code === "ENOENT") assert.fail(`right-sidebar-local/${path} が無い。${hint}`);
    throw e;
  }
};
const INSTALL = "right-sidebar-local で pnpm install を流す";

test("vendor: node_modules の pele が package.json で固定した版", async () => {
  const pinned = JSON.parse(await read("package.json", "")).dependencies.pele;
  const installed = JSON.parse(await read("node_modules/pele/package.json", INSTALL)).version;
  assert.equal(installed, pinned, `node_modules の pele は ${installed}、package.json は ${pinned}。${INSTALL}`);
});

for (const [copy, source] of [["pele.js", "node_modules/pele/dist/pele.js"], ["pele.LICENSE", "node_modules/pele/LICENSE"]]) {
  test(`vendor: ${copy} が node_modules の ${source} と同じ`, async () => {
    const want = await read(source, INSTALL), got = await read(copy, `${INSTALL}（または pnpm run vendor）`);
    assert.ok(got.equals(want), `${copy} が node_modules の pele と違う。pnpm run vendor で写し直す`);
  });
}
