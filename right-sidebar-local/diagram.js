// Mermaid（.mmd）を pele で SVG にし、Herdr の image() で描ける形に直す。
// herdr / gpui-kit に依存しない純粋な関数だけを置き、node のテスト（tests/diagram.test.mjs）から読めるようにする
import { render, PeleError } from "./pele.js";

// pele の色の変数に当てる theme() の色の名前。ここに無い変数（series-1..8 や critical など）は pele の既定の色を使う。
// pele の既定は明るい背景向けなので、背景・文字・枠に当たるものだけをテーマに合わせ、ダークテーマでも読めるようにする
const THEME_COLORS = {
  "--pele-bg": "background",
  "--pele-fg": "foreground",
  "--pele-muted": "muted",
  "--pele-line": "muted",
  "--pele-surface": "raised",
  "--pele-surface-alt": "popover",
  "--pele-border": "dim",
  "--pele-accent": "accent",
};

// theme() の色から、pele の変数に当てる具体色の表を作る
export function peleColors(theme) {
  const colors = {};
  for (const [name, color] of Object.entries(THEME_COLORS)) {
    if (!theme[color]) throw new Error(`theme() に ${color} の色が無い`);
    colors[name] = theme[color];
  }
  return colors;
}

// text の i 文字目（"(" の直後）から、対応する ")" の位置を返す
function closingParen(text, i) {
  for (let depth = 1; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  throw new Error(`var( の括弧が閉じていない: ${text.slice(0, 80)}`);
}

// "--name, fallback" を最初の括弧の外のカンマで分ける
function splitVar(inner) {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "(") depth++;
    else if (inner[i] === ")") depth--;
    else if (inner[i] === "," && depth === 0) return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
  }
  return [inner.trim(), null];
}

// Herdr の SVG の描画（resvg）は CSS 変数を解釈せず、var(...) の色は黒で塗られて文字は消える。
// pele は色を root の style の宣言（--_bg:var(--pele-bg,#fff) など）と var(--_bg) の参照で書くので、
// 参照をすべて具体的な値に置き換え、変数の宣言は style から外す。
// colors は { "--pele-bg": "#17191d", ... }。colors に無い --pele-* は pele が書いた既定の値を使う
export function resolveCssVars(svg, colors) {
  // 変数の宣言は style 属性の中だけにある（pele は <style> 要素を出さない）
  const declared = new Map();
  for (const [, style] of svg.matchAll(/\sstyle="([^"]*)"/g)) {
    for (const decl of style.split(";")) {
      const m = decl.match(/^\s*(--[A-Za-z0-9_-]+)\s*:(.*)$/s);
      if (m) declared.set(m[1], m[2].trim());
    }
  }
  const resolving = new Set();
  const lookup = (name) => {
    if (Object.hasOwn(colors, name)) return colors[name];
    if (!declared.has(name)) return null;
    if (resolving.has(name)) throw new Error(`CSS 変数 ${name} が自分自身を参照している`);
    resolving.add(name);
    try { return substitute(declared.get(name)); } finally { resolving.delete(name); }
  };
  const substitute = (text) => {
    let out = "", from = 0;
    for (let at = text.indexOf("var(", from); at !== -1; at = text.indexOf("var(", from)) {
      const end = closingParen(text, at + 4);
      const [name, fallback] = splitVar(text.slice(at + 4, end));
      const value = lookup(name) ?? (fallback === null ? null : substitute(fallback));
      if (value === null) throw new Error(`CSS 変数 ${name} の値が無い`);
      out += text.slice(from, at) + value;
      from = end + 1;
    }
    return out + text.slice(from);
  };
  const withoutDecls = svg.replace(/(\sstyle=")([^"]*)(")/g, (_m, open, style, close) =>
    open + style.split(";").filter((d) => !/^\s*--/.test(d)).join(";") + close);
  return substitute(withoutDecls);
}

// root の <svg> の width / height を倍率に合わせて書き換える。viewBox はそのままなので、ベクタのまま大きく描ける。
// pele が root の style に書く max-width:100%;height:auto はブラウザ向けで、属性の大きさを上書きされないよう外す
export function scaleSvg(svg, scale) {
  const head = svg.match(/^<svg\b[^>]*>/);
  if (!head) throw new Error("SVG の先頭が <svg> でない");
  const sized = head[0]
    .replace(/(\sstyle=")([^"]*)/, (_m, open, style) => open + style.split(";").filter((d) => !/^\s*(max-width|height)\s*:/.test(d)).join(";"))
    .replace(/\swidth="([\d.]+)"/, (_m, w) => ` width="${round(Number(w) * scale)}"`)
    .replace(/\sheight="([\d.]+)"/, (_m, h) => ` height="${round(Number(h) * scale)}"`);
  return sized + svg.slice(head[0].length);
}
const round = (n) => Math.round(n * 100) / 100;

// 書き出す SVG のファイル名に使う。中身が変われば名前も変わるので、画像の読み直しに頼らずに済む（FNV-1a を 2 つの種で回した 64 bit）
export function hashText(text) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

// 書き手は agent なので、描けない図は黙って空にせず、どの行のどこが悪いかを出す
export function diagramError(e, path) {
  if (!(e instanceof PeleError)) return `${path}: ${e?.message ?? e}`;
  if (e.code === "unsupported-diagram") return `${path}: 図の種類が分からない（先頭の行に flowchart / sequenceDiagram などを書く）`;
  // pele の syntax の message は "Parse error on line N:" と該当箇所を含むので、そのまま出す
  return e.line ? `${path}:${e.line}:${e.column}: ${e.message}` : `${path}: ${e.message}`;
}

// .mmd の中身を、Herdr で描ける SVG にする。maxWidth は描く場所の幅（px）で、pele はそれに収まるよう向きや折り返しを組み直す。
// scale は組み直した後の拡大率。返す width / height は scale を掛けた後の大きさ
export function drawDiagram(source, { maxWidth, colors, scale = 1, path = "diagram" }) {
  let r;
  try { r = render(source, { maxWidth }); } catch (e) { throw new Error(diagramError(e, path)); }
  const svg = scaleSvg(resolveCssVars(r.svg, colors), scale);
  return { svg, width: round(r.width * scale), height: round(r.height * scale), type: r.type };
}
