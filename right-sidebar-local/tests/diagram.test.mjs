import { test } from "node:test";
import assert from "node:assert/strict";
import { peleColors, resolveCssVars, scaleSvg, hashText, drawDiagram } from "../diagram.js";

// herdr-app check の中で theme() が返した値（ダークテーマ）の一部
const theme = {
  background: "#17191d", foreground: "#eeeeef", muted: "#98999b", raised: "#2c2e31",
  popover: "#25272b", dim: "#696a6d", accent: "#96b2d7", border: "#ffffff18",
};
const colors = peleColors(theme);

const SOURCES = {
  flowchart: "flowchart LR\n  A[開始] --> B{判定}\n  B -->|yes| C[処理]\n  B -->|no| D[終了]\n  classDef hot fill:#f96\n  class D hot",
  sequence: "sequenceDiagram\n  participant A as アリス\n  A->>B: こんにちは\n  Note over A,B: メモ\n  loop 毎回\n    B-->>A: ok\n  end",
  gantt: "gantt\n  dateFormat YYYY-MM-DD\n  section 設計\n  調査 :a1, 2026-01-01, 3d\n  実装 :crit, after a1, 2d\n  完了 :done, 2026-01-02, 1d",
  pie: "pie title 内訳\n  \"a\": 3\n  \"b\": 5\n  \"c\": 2",
  class: "classDiagram\n  class A { +int x }\n  A <|-- B",
  state: "stateDiagram-v2\n  [*] --> S1\n  S1 --> [*]",
  er: "erDiagram\n  USER ||--o{ ORDER : places",
  mindmap: "mindmap\n  root((中心))\n    A\n    B",
};

for (const [type, source] of Object.entries(SOURCES)) {
  test(`drawDiagram: ${type} の出力に CSS 変数が残らない`, () => {
    const d = drawDiagram(source, { maxWidth: 340, colors });
    assert.equal(d.type, type);
    assert.ok(!d.svg.includes("var("), `var( が残っている: ${d.svg.match(/.{40}var\(.{40}/)?.[0]}`);
    assert.ok(!/style="[^"]*--/.test(d.svg), "変数の宣言が style に残っている");
    // pele は丸めで 1px はみ出すことがある（gantt で 341）
    assert.ok(d.width > 0 && d.width <= 341, `幅 ${d.width} が maxWidth に収まっていない`);
  });
}

test("drawDiagram: テーマの色が背景・文字・線に入る", () => {
  const { svg } = drawDiagram(SOURCES.flowchart, { maxWidth: 340, colors });
  assert.ok(svg.includes(`fill="${theme.foreground}"`), "文字の色が foreground でない");
  assert.ok(svg.includes(`stroke="${theme.muted}"`), "線の色が muted でない");
  assert.ok(svg.includes(`fill="${theme.raised}"`), "ノードの塗りが raised でない");
});

test("drawDiagram: 日本語のラベルがそのまま残る", () => {
  const { svg } = drawDiagram(SOURCES.flowchart, { maxWidth: 340, colors });
  assert.ok(svg.includes(">開始<") && svg.includes(">判定<"));
});

test("drawDiagram: scale を掛けると属性と返す大きさが倍になり、viewBox は変わらない", () => {
  const one = drawDiagram(SOURCES.sequence, { maxWidth: 340, colors });
  const two = drawDiagram(SOURCES.sequence, { maxWidth: 340, colors, scale: 2 });
  assert.equal(two.width, one.width * 2);
  assert.equal(two.height, one.height * 2);
  assert.equal(two.svg.match(/viewBox="([^"]*)"/)[1], one.svg.match(/viewBox="([^"]*)"/)[1]);
  assert.match(two.svg, new RegExp(`^<svg[^>]* width="${one.width * 2}" height="${one.height * 2}"`));
});

test("drawDiagram: 構文エラーはファイルのパスと行・列と該当箇所を出す", () => {
  assert.throws(() => drawDiagram("flowchart LR\n  A --> B\n  B --> [", { maxWidth: 340, colors, path: ".local/diagrams/x.mmd" }),
    (e) => e.message.startsWith(".local/diagrams/x.mmd:3:9: Parse error on line 3:") && e.message.includes("B --> ["));
});

test("drawDiagram: 図の種類が無ければ、先頭の行に種類を書くよう出す", () => {
  assert.throws(() => drawDiagram("hello\n  world", { maxWidth: 340, colors, path: "a.mmd" }), /a\.mmd: 図の種類が分からない/);
});

test("resolveCssVars: 変数の連鎖と既定の値を辿り、colors にない変数は pele の既定を使う", () => {
  const svg = '<svg style="color:var(--_fg);--_fg:var(--pele-fg,#111);--_x:var(--pele-series-1,#4c78a8)"><g fill="var(--_x)" stroke="var(--_fg)"/></svg>';
  assert.equal(resolveCssVars(svg, { "--pele-fg": "#eee" }), '<svg style="color:#eee"><g fill="#4c78a8" stroke="#eee"/></svg>');
});

test("resolveCssVars: 値の無い変数は黙って黒にせずエラーにする", () => {
  assert.throws(() => resolveCssVars('<svg><g fill="var(--nope)"/></svg>', {}), /--nope の値が無い/);
});

test("resolveCssVars: 自分自身を参照する変数はエラーにする", () => {
  assert.throws(() => resolveCssVars('<svg style="--_a:var(--_a)"><g fill="var(--_a)"/></svg>', {}), /自分自身を参照/);
});

test("scaleSvg: root の style の max-width と height:auto を外し、ほかの宣言は残す", () => {
  const out = scaleSvg('<svg width="10" height="20" style="max-width:100%;height:auto;color:#eee"><g/></svg>', 1.5);
  assert.equal(out, '<svg width="15" height="30" style="color:#eee"><g/></svg>');
});

test("peleColors: theme に色が欠けていればエラーにする", () => {
  assert.throws(() => peleColors({ ...theme, raised: undefined }), /raised/);
});

test("hashText: 同じ文字列は同じ値、1 文字違えば別の値で、16 桁の 16 進", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
  assert.match(hashText("図"), /^[0-9a-f]{16}$/);
});
