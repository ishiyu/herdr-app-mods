import { test } from "node:test";
import assert from "node:assert/strict";
import { closeTabActions } from "../close-tab.js";

// focused() / panes() / terminals() の、判定に使うところだけ
const focus = (tab) => ({ space: "sp1", tab, pane: null, terminal: null });
const pane = (tab, terminal, more = {}) => ({ pane: `p-${terminal ?? "mod"}`, tab, terminal, ...more });
const term = (address, parent = null, state = "live") => ({ address, parent, state });

// coordinator（t5b）と、その子の thread（t19c）と見張り（t8q）。t1 は親の無い agent
const terminals = [term("t5b"), term("t19c", "t5b"), term("t8q", "t5b"), term("t1")];

test("closeTabActions: タブの terminal が親の動いている子だけなら、閉じずに park する", () => {
  assert.deepEqual(closeTabActions(focus("tb1"), [pane("tb1", "t19c")], terminals), [["terminal.park", { terminal: "t19c" }]]);
});

test("closeTabActions: 子が 2 つ並んだタブは、2 つとも park する", () => {
  assert.deepEqual(closeTabActions(focus("tb1"), [pane("tb1", "t19c"), pane("tb1", "t8q")], terminals), [
    ["terminal.park", { terminal: "t19c" }],
    ["terminal.park", { terminal: "t8q" }],
  ]);
});

test("closeTabActions: 子でない terminal のタブは、これまでの ⌘W と同じくそのタブを閉じる", () => {
  assert.deepEqual(closeTabActions(focus("tb2"), [pane("tb2", "t1")], terminals), [["tab.close", { id: "tb2" }]]);
});

test("closeTabActions: 子と子でない terminal が混ざったタブは、子も含めて閉じる", () => {
  assert.deepEqual(closeTabActions(focus("tb1"), [pane("tb1", "t19c"), pane("tb1", "t1")], terminals), [["tab.close", { id: "tb1" }]]);
});

test("closeTabActions: 親が終わっている子は戻すと見えなくなるので、閉じる", () => {
  const ts = [term("t5b", null, "finished"), term("t19c", "t5b")];
  assert.deepEqual(closeTabActions(focus("tb1"), [pane("tb1", "t19c")], ts), [["tab.close", { id: "tb1" }]]);
});

test("closeTabActions: 親が terminals() に無い子も、閉じる", () => {
  assert.deepEqual(closeTabActions(focus("tb1"), [pane("tb1", "t19c")], [term("t19c", "t5b")]), [["tab.close", { id: "tb1" }]]);
});

test("closeTabActions: mod の pane は数えず、子と mod の pane のタブは子だけを park する", () => {
  assert.deepEqual(closeTabActions(focus("tb1"), [pane("tb1", "t19c"), pane("tb1", null, { mod: "files" })], terminals), [
    ["terminal.park", { terminal: "t19c" }],
  ]);
});

test("closeTabActions: mod の pane だけのタブは閉じる", () => {
  assert.deepEqual(closeTabActions(focus("tb3"), [pane("tb3", null, { mod: "files" })], terminals), [["tab.close", { id: "tb3" }]]);
});

test("closeTabActions: ほかのタブの pane は見ない", () => {
  const ps = [pane("tb1", "t19c"), pane("tb2", "t1")];
  assert.deepEqual(closeTabActions(focus("tb1"), ps, terminals), [["terminal.park", { terminal: "t19c" }]]);
  assert.deepEqual(closeTabActions(focus("tb2"), ps, terminals), [["tab.close", { id: "tb2" }]]);
});

test("closeTabActions: focused() が無い（window の無いとき）は、引数なしの tab.close にする", () => {
  assert.deepEqual(closeTabActions(null, [pane("tb1", "t19c")], terminals), [["tab.close", {}]]);
});
