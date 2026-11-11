import { div, image, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { exec, readTextFile, writeTextFile, watchFolder, theme, settings, appHome, props, openOverlay, closeOverlay } from "herdr";
import { Panel, delegate, location, key, ago } from "./common.js";
import { drawDiagram, peleColors, hashText } from "./diagram.js";

// zumen-engine では直近 7 日だけで数百件書かれるので、新しいものに絞らないと探せない
const LOCAL_LIMIT = 20;
// 更新時刻の書式が BSD（macOS）と GNU（Linux）の stat / find で違う
const LOCAL_SCRIPT = [
  'dir="$1"; [ -d "$dir" ] || exit 0',
  'if stat -f %m / >/dev/null 2>&1; then find "$dir" -type f -name "$2" -exec stat -f "%m%t%N" {} +',
  'else find "$dir" -type f -name "$2" -printf "%T@\\t%p\\n"; fi',
].join("\n");

// dir は repo root からの相対パス。返す path も repo root からの相対パスで、更新の新しい順
async function localFiles(root, on, dir, pattern) {
  const r = await exec("sh", ["-c", LOCAL_SCRIPT, "local-files", `${root}/${dir}`, pattern], { on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  return r.stdout.split("\n").filter(Boolean)
    .map((line) => { const [mtime, path] = line.split("\t"); return { mtime: Number(mtime) * 1000, path: path.slice(root.length + 1) }; })
    .sort((a, b) => b.mtime - a.mtime);
}
const localDocs = (root, on) => localFiles(root, on, ".local", "*.md");

// agent が書いたグラフの定義（JSON）を置く場所。herdr-app do right-sidebar.chart-<名前> で .local/charts/<名前>.json を開く
const CHART_DIR = ".local/charts";
const localCharts = (root, on) => localFiles(root, on, CHART_DIR, "*.json");
const CHART_TYPES = new Set(["line", "bar"]);
// agent が書いた Mermaid の図（.mmd）を置く場所。herdr-app do right-sidebar.diagram-<名前> で .local/diagrams/<名前>.mmd を開く
const DIAGRAM_DIR = ".local/diagrams";
const localDiagrams = (root, on) => localFiles(root, on, DIAGRAM_DIR, "*.mmd");
// 一覧の種類ごとの置き場所と拡張子。chart-latest / diagram-latest と一覧の読み直しで使う
const LISTS = {
  chart: { dir: CHART_DIR, ext: ".json", fetch: localCharts },
  diagram: { dir: DIAGRAM_DIR, ext: ".mmd", fetch: localDiagrams },
};

// image() は ~/.config/herdr-app からの相対パスしか描けないので、描いた SVG はそこへ書き出す。
// ファイル名は中身のハッシュにし、同じパスの画像を書き換えたときに読み直されるかに頼らない
const SVG_DIR = "data/right-sidebar-local/diagrams";
// 書き出した SVG は新しいものからこの数だけ残す。表示中の図が消えないよう、使い回すときは更新時刻を進める
const SVG_KEEP = 50;
const SVG_SCRIPT = [
  'mkdir -p "$1" && cd "$1" || exit 1',
  'if [ -f "$2" ]; then touch "$2"; echo exists; fi',
  'ls -t | grep "\\.svg$" | tail -n +"$3" | while IFS= read -r f; do [ "$f" = "$2" ] || rm -f -- "$f"; done',
].join("\n");
// 返すのは image() に渡すパス
async function storeSvg(svg) {
  const dir = `${appHome()}/${SVG_DIR}`, name = `${hashText(svg)}.svg`;
  const r = await exec("sh", ["-c", SVG_SCRIPT, "store-svg", dir, name, String(SVG_KEEP)]);
  if (r.code !== 0) throw new Error(`${dir} に書き出せない: ${(r.stderr || r.stdout).trim()}`);
  if (r.stdout.trim() !== "exists") {
    try { await writeTextFile(`${dir}/${name}`, svg, null); } catch (e) {
      // 同じ図を描いている別のコピー（大きく見る dialog など）が先に書いたなら、中身は同じなのでそのまま使う
      const again = await exec("test", ["-f", `${dir}/${name}`]);
      if (again.code !== 0) throw e;
    }
  }
  return `${SVG_DIR}/${name}`;
}
// パネルの幅が 1px ずつ変わるたびに描き直さないよう、描く幅は 8px 刻みにする
const drawWidth = (width) => Math.max(160, Math.floor(width / 8) * 8);
// 枠の幅（on_size_change）が届く前に描く幅。幅を待ってから描くと、幅が届かないときに「Rendering…」のまま止まるので、まずこの幅で描き、届いたら描き直す
const PANEL_WIDTH = 320, VIEWER_WIDTH = 960;
// 大きく見る dialog の倍率の段
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

// 書き手は agent なので、描けない定義は黙って描かずに、どこが悪いかを詳細に出す
function parseChart(text, path) {
  let c;
  try { c = JSON.parse(text); } catch (e) { throw new Error(`${path} が JSON として読めない: ${e.message ?? e}`); }
  if (!CHART_TYPES.has(c?.type)) throw new Error(`${path}: type は "line" か "bar"（受け取った値: ${JSON.stringify(c?.type)}）`);
  if (!Array.isArray(c.labels) || !Array.isArray(c.values) || c.labels.length !== c.values.length) {
    throw new Error(`${path}: labels と values は同じ長さの配列にする`);
  }
  if (!c.values.every((v) => typeof v === "number" && Number.isFinite(v))) throw new Error(`${path}: values は数値だけにする`);
  if (c.type === "line" && c.values.length < 2) throw new Error(`${path}: line は 2 点以上要る`);
  if (c.type === "bar" && c.values.some((v) => v < 0)) throw new Error(`${path}: bar は負の値を描けない`);
  return { type: c.type, title: String(c.title ?? ""), unit: String(c.unit ?? ""), labels: c.labels.map(String), values: c.values };
}
function formatValue(v) {
  const a = Math.abs(v);
  const [n, suffix] = a >= 1e9 ? [v / 1e9, "B"] : a >= 1e6 ? [v / 1e6, "M"] : a >= 1e3 ? [v / 1e3, "K"] : [v, ""];
  return `${Number(n.toFixed(2))}${suffix}`;
}
// 横幅 360px に月名などを 8 つ以上並べると重なるので、両端と中央だけ出す
function axisLabels(labels) {
  return labels.length <= 7 ? labels : [labels[0], labels[Math.floor((labels.length - 1) / 2)], labels[labels.length - 1]];
}
// 検索中は件数の制限を外し、空白で区切った語をすべて含むパスに絞る
function matchDocs(docs, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? docs.filter((f) => terms.every((w) => f.path.toLowerCase().includes(w))) : docs.slice(0, LOCAL_LIMIT);
}

export default class LocalPanel extends Panel {
  get panel() { return "local"; }

  emptyData() {
    return { docs: [], docsLoaded: false, docsError: null, charts: [], chartsLoaded: false, chartsError: null,
      diagrams: [], diagramsLoaded: false, diagramsError: null };
  }

  // 大きく見るボタンは、この mod 自身を props の diagram つきで dialog に開く。そのコピーは図を 1 枚だけ描く
  init(p, cx) {
    const diagram = props()?.diagram;
    if (diagram) { this.viewer = { ...diagram, zoom: 1, width: null }; return; }
    super.init(p, cx);
  }

  // 詳細は { kind: "file" | "chart" | "diagram", id, data, error, loading }。id は repo root からの相対パス。
  // 絞り込みの語（query）は herdr のタブごとに使い分け、repo をまたいで持ち越す
  emptyView(context, previous) {
    return { context, tab: "local", details: { local: null, chart: null, diagram: null }, query: previous?.query ?? "" };
  }

  tabOf(kind) { return kind === "chart" || kind === "diagram" ? kind : "local"; }

  setup(_cx) {
    // 入力欄は全 herdr タブで共有し、herdr のタブを移るたびに移った先の view の語を入れ直す
    this.filter = InputState.new({ placeholder: "パスで絞り込む" });
    this.filter.on("change", (_e, cx) => {
      const value = this.filter.value();
      if (value === this.query) return;
      this.query = value;
      cx.notify();
    });
  }

  // herdr の mod 命令は引数を運べないので、グラフや図の名前は命令名に埋めてある（herdr-app do right-sidebar.chart-<名前>）
  command(command, cx) {
    const tab = command.match(/^tab-(local|chart|diagram)$/), named = command.match(/^(chart|diagram)-([A-Za-z0-9_-]+)$/);
    if (tab) { this.tab = tab[1]; cx.notify(); }
    else if (named?.[2] === "latest") this.openLatest(named[1], cx);
    else if (named) this.openDetail(named[1], `${LISTS[named[1]].dir}/${named[2]}${LISTS[named[1]].ext}`, cx);
    else if (command === "back") this.back(cx);
    else console.log(`right-sidebar-local: unknown command ${command}`);
  }

  // render 中に入力欄を書き換えると描画が入れ子になるので、spawn に回す
  switched(cx) {
    const view = this.view;
    cx.spawn(async () => {
      if (this.view === view && this.filter.value() !== view.query) this.filter.set_value(view.query);
    });
  }

  // 離れている間は .local を監視していないので、一覧を読み直す
  returned(cx) {
    if (this.data.root) this.load(this.data, location().on, this.context, cx);
  }

  async load(entry, on, context, cx) {
    this.loadDocs(entry, on, cx);
    this.loadList(entry, on, "chart", cx);
    this.loadList(entry, on, "diagram", cx);
    this.watchLocal(entry, on, context, cx);
  }

  async fetchDetail(d, root, on) {
    const text = await readTextFile(`${root}/${d.id}`, { on });
    if (text === null) throw new Error(`${d.id} が見つからない`);
    return { data: d.kind === "chart" ? parseChart(text, d.id) : d.kind === "diagram" ? { source: text } : { text } };
  }

  loadDocs(entry, on, cx) {
    cx.spawn(async (cx) => {
      try {
        entry.docs = await localDocs(entry.root, on); entry.docsLoaded = true; entry.docsError = null;
      } catch (e) { entry.docsError = String(e.message ?? e); }
      finally { cx.notify(); }
    });
  }

  // kind は "chart" | "diagram"。一覧は entry.charts / entry.diagrams に置く
  loadList(entry, on, kind, cx) {
    cx.spawn(async (cx) => {
      try {
        entry[`${kind}s`] = await LISTS[kind].fetch(entry.root, on); entry[`${kind}sLoaded`] = true; entry[`${kind}sError`] = null;
      } catch (e) { entry[`${kind}sError`] = String(e.message ?? e); }
      finally { cx.notify(); }
    });
  }

  // agent はグラフや図を書いた直後に chart-latest / diagram-latest を送るので、監視による一覧の更新を待たずに一覧を引き直してから開く
  openLatest(kind, cx) {
    const entry = this.data, view = this.view;
    this.tab = kind;
    cx.notify();
    if (!entry.root) { console.log(`right-sidebar-local: ${kind}-latest before the repo root is known`); return; }
    const { on } = location();
    cx.spawn(async (cx) => {
      try {
        const files = await LISTS[kind].fetch(entry.root, on);
        entry[`${kind}s`] = files; entry[`${kind}sLoaded`] = true; entry[`${kind}sError`] = null;
        // 引いている間に herdr のタブを移ったら、移った先で勝手に開かない
        if (this.view === view && files.length) this.openDetail(kind, files[0].path, cx);
      } catch (e) { entry[`${kind}sError`] = String(e.message ?? e); }
      finally { cx.notify(); }
    });
  }

  // watchFolder は手元のマシンしか見られないので、別マシンの space の .local は ↻ と herdr のタブを移ったときの読み直しだけで追う
  watchLocal(entry, on, context, cx) {
    const root = entry.root;
    if (on || this.watching === root) return;
    this.watching = root;
    cx.spawn(async (cx) => {
      try {
        while (key() === context) {
          const changed = await watchFolder(`${root}/.local`);
          if (key() !== context) break;
          if (changed.some((p) => p === `${root}/.local` || p.endsWith(".md"))) this.loadDocs(entry, on, cx);
          for (const kind of Object.keys(LISTS)) {
            if (changed.some((p) => p === `${root}/.local` || p.startsWith(`${root}/${LISTS[kind].dir}`))) this.loadList(entry, on, kind, cx);
          }
        }
      } catch (e) { console.log(`right-sidebar-local: watchFolder ${root}/.local failed: ${e.message ?? e}`); }
      finally { if (this.watching === root) this.watching = null; }
    });
  }

  // ---- 一覧 ----

  shownDocs() { return matchDocs(this.docs, this.query); }

  docRow(f, t) {
    const slash = f.path.lastIndexOf("/");
    return v_flex().id(`doc-${f.path}`).min_h(40).flex_none().px(10).py(5).mx(6).gap(2).justify_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openDetail("file", f.path, cx))
      .child(div().truncate().child(f.path.slice(slash + 1)))
      .child(h_flex().gap(6).text_size(12).text_color(t.dim)
        .child(div().child(ago(new Date(f.mtime).toISOString())))
        .child(div().min_w(0).truncate().child(f.path.slice(".local/".length, slash + 1))));
  }

  docList(t) {
    const searching = Boolean(this.query.trim()), docs = this.shownDocs();
    return v_flex()
      .child(h_flex().h(38).flex_none().px(10).gap(6).items_center()
        .child(Input.new(this.filter).flex_1().h(26).px(8).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(13).text_color(t.foreground)))
      .child(this.section(searching ? `MATCHES (${docs.length} / ${this.docs.length})` : `.LOCAL (${docs.length} / ${this.docs.length})`, this.reloadButton(t), t))
      .when(Boolean(this.docsError), (e) => e.child(div().px(14).py(4).text_size(13).text_color(t.ansi1).child(this.docsError)))
      .children(docs.map((f) => this.docRow(f, t)))
      .when(!docs.length && !this.docsError, (e) => e.child(this.empty(!this.docsLoaded ? "Loading…" : searching ? "No matching files" : "No markdown under .local", t)));
  }

  // Charts と Diagrams の一覧。kind は "chart" | "diagram"
  fileRow(kind, f, t) {
    const { dir, ext } = LISTS[kind], name = f.path.slice(dir.length + 1).slice(0, -ext.length);
    return h_flex().id(`${kind}-${f.path}`).h(36).flex_none().px(10).mx(6).gap(10).items_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openDetail(kind, f.path, cx))
      .child(div().flex_1().min_w(0).truncate().child(name))
      .child(div().text_size(12).text_color(t.dim).child(ago(new Date(f.mtime).toISOString())));
  }

  fileList(kind, title, t) {
    const files = this.data[`${kind}s`], error = this.data[`${kind}sError`], loaded = this.data[`${kind}sLoaded`];
    return v_flex()
      .child(this.section(`${title} (${files.length})`, this.reloadButton(t), t))
      .when(Boolean(error), (e) => e.child(div().px(14).py(4).text_size(13).text_color(t.ansi1).child(error)))
      .children(files.map((f) => this.fileRow(kind, f, t)))
      .when(!files.length && !error, (e) => e.child(this.empty(!loaded ? "Loading…" : `No ${kind}s under ${LISTS[kind].dir}`, t)));
  }

  // ---- 詳細 ----

  detailLabel(d) { return d.id; }

  detailBody(d, t) {
    return d.kind === "chart" ? this.chartDetail(d.data, t)
      : d.kind === "diagram" ? this.diagramDetail(d, t)
      : div().px(14).pt(10).text_size(13).child(TextView.markdown(`file-${d.id}`, d.data.text).selectable());
  }

  chartDetail(c, t) {
    const last = c.values[c.values.length - 1], unit = c.unit ? ` ${c.unit}` : "";
    return v_flex().gap(8)
      .child(h_flex().px(14).pt(10).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(c.title || this.detail.id))
        .when(Boolean(c.unit), (e) => e.child(div().text_size(12).text_color(t.dim).child(c.unit))))
      .child(c.type === "line" ? this.lineChart(c, t) : this.barChart(c, t))
      .when(c.type === "line", (e) => e.child(this.meta([
        div().child(`last ${formatValue(last)}${unit}`),
        div().child(`max ${formatValue(Math.max(...c.values))}`),
        div().child(`min ${formatValue(Math.min(...c.values))}`),
      ], t)));
  }

  // 座標は描画領域に対する % で渡せるので、パネルの幅を知らなくても描ける
  lineChart(c, t) {
    const lo = Math.min(...c.values), hi = Math.max(...c.values);
    // 平らな系列でも線が上下の端に張り付かないよう、上下に 10% の余白を取る
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.1, top = hi + pad, bottom = lo - pad;
    const pts = c.values.map((v, i) => [`${(i / (c.values.length - 1)) * 100}%`, `${((top - v) / (top - bottom)) * 100}%`]);
    const line = pts.reduce((b, [x, y], i) => (i ? b.line_to(x, y) : b.move_to(x, y)), PathBuilder.stroke(2)).build();
    const area = pts.reduce((b, [x, y]) => b.line_to(x, y), PathBuilder.fill().move_to("0%", "100%")).line_to("100%", "100%").close().build();
    const layer = (el) => el.absolute().top(0).left(0).size_full();
    return v_flex().px(14).gap(4)
      .child(div().relative().h(140).w_full().border_b(1).border_color(t.border)
        .child(layer(window.paint_path(area, Background.solid(t.accent).opacity(0.18))))
        .child(layer(window.paint_path(line, t.accent))))
      .child(h_flex().justify_between().text_size(11).text_color(t.dim)
        .children(axisLabels(c.labels).map((l) => div().child(l))));
  }

  barChart(c, t) {
    const max = Math.max(...c.values) || 1, unit = c.unit ? ` ${c.unit}` : "";
    return v_flex().px(14).gap(6)
      .children(c.values.map((v, i) => h_flex().gap(8).items_center().text_size(12)
        .child(div().w(72).flex_none().truncate().text_color(t.muted).child(c.labels[i]))
        .child(div().flex_1().h(8).rounded(4).bg(t.hover)
          .child(div().h_full().rounded(4).bg(t.accent).w(`${(v / max) * 100}%`)))
        .child(div().w(64).flex_none().text_right().child(`${formatValue(v)}${unit}`))));
  }

  // ---- 図（Mermaid） ----

  // holder（パネルの詳細か、大きく見る dialog の viewer）の図を、いまの幅・倍率・テーマで描いたものにそろえる。
  // render から呼ぶ。描き直しが要るときだけ、pele で描いて書き出す処理を始める
  syncDrawing(holder, { source, path, maxWidth, measured, scale }, cx) {
    let colors;
    try { colors = peleColors(theme()); } catch (e) { holder.drawError = String(e.message ?? e); return; }
    const want = hashText(JSON.stringify([source, maxWidth, scale, colors]));
    if (holder.want === want) return;
    holder.want = want;
    // 描けるまでの表示に、どの段で止まっているかと描く幅を出す（live でしか起きない止まり方を画面から切り分けるため）
    holder.stage = `queued · ${maxWidth}px${measured ? "" : " (default)"}`;
    cx.spawn(async (cx) => {
      // spawn に渡した関数は最初の await まで render の中で走るので、pele の描画は render を抜けてから行う
      await cx.sleep(0);
      try {
        if (holder.want === want) holder.stage = holder.stage.replace(/^\w+/, "drawing");
        const d = drawDiagram(source, { maxWidth, colors, scale, path });
        if (holder.want === want) { holder.stage = holder.stage.replace(/^\w+/, "writing"); cx.notify(); }
        const img = await storeSvg(d.svg);
        if (holder.want !== want) return;
        holder.drawn = { image: img, width: d.width, height: d.height }; holder.drawError = null;
      } catch (e) {
        // 書き直して壊れた図は、古い図を出し続けずにエラーだけを出す
        if (holder.want === want) { holder.drawn = null; holder.drawError = String(e.message ?? e); }
      } finally { cx.notify(); }
    });
  }

  // 描いた図。横に収まらない図は横にもスクロールする（縦はパネルの本文がスクロールする）
  drawing(holder, t, scrollX) {
    if (holder.drawError) {
      return div().text_size(12).text_color(t.ansi1).child(TextView.markdown(`diagram-error-${holder.want}`, "```\n" + holder.drawError + "\n```"));
    }
    if (!holder.drawn) return this.empty(`Rendering… ${holder.stage ?? ""}`, t);
    const { image: img, width, height } = holder.drawn;
    return div().id("diagram-scroll").w_full().when(scrollX, (e) => e.overflow_x_scrollbar()).child(image(img).w(width).h(height).flex_none());
  }

  diagramDetail(d, t) {
    const name = d.id.slice(DIAGRAM_DIR.length + 1).replace(/\.mmd$/, "");
    return v_flex().gap(8)
      .child(h_flex().px(14).pt(10).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(name))
        .child(this.button("expand", "expand ⤢", t, () => this.expand(d))))
      .child(div().px(14)
        .child(div().id("diagram-area").w_full()
          .on_size_change((size, cx) => {
            const w = drawWidth(size.width / settings().zoom);
            if (w !== this.diagramWidth) { this.diagramWidth = w; cx.notify(); }
          })
          .child(this.drawing(d, t, true))));
  }

  // 大きく見る: この mod 自身を dialog として開く。図の中身は props で渡すので、別マシンの .local の図も開ける
  expand(d) {
    if (!d.data) return;
    openOverlay({ mod: "right-sidebar-local", kind: "dialog", width: 0.92, height: 0.9, props: { diagram: { source: d.data.source, path: d.id } } });
  }

  viewerView(cx) {
    const v = this.viewer, t = theme();
    this.syncDrawing(v, { source: v.source, path: v.path, maxWidth: v.width ?? VIEWER_WIDTH, measured: v.width !== null, scale: v.zoom }, cx);
    const step = (dir) => (_e, cx) => {
      const i = ZOOMS.indexOf(v.zoom) + dir;
      if (i >= 0 && i < ZOOMS.length) { v.zoom = ZOOMS[i]; cx.notify(); }
    };
    return v_flex().id("diagram-viewer").size_full().bg(t.background).text_color(t.foreground).text_size(14)
      .child(h_flex().h(36).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).text_size(13)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(v.path))
        .child(this.button("zoom-out", "−", t, step(-1)))
        .child(div().w(44).text_center().text_color(t.muted).child(`${Math.round(v.zoom * 100)}%`))
        .child(this.button("zoom-in", "+", t, step(1)))
        .child(this.button("close", "close ✕", t, () => closeOverlay(props().overlay))))
      .child(div().id("viewer-body").flex_1().min_h(0).p(16).overflow_scrollbar()
        // pele には dialog の幅に収まるよう組み直させ、倍率はその後に掛ける
        .on_size_change((size, cx) => {
          const w = drawWidth(size.width / settings().zoom - 32);
          if (w !== v.width) { v.width = w; cx.notify(); }
        })
        .child(this.drawing(v, t, false)));
  }

  render(cx) {
    if (this.viewer) return this.viewerView(cx);
    this.begin(cx);
    const t = theme(), d = this.detail;
    if (d?.kind === "diagram" && d.data) {
      this.syncDrawing(d, { source: d.data.source, path: d.id, maxWidth: this.diagramWidth ?? PANEL_WIDTH, measured: this.diagramWidth !== undefined, scale: 1 }, cx);
    }
    return this.frame(t,
      this.switcher([["local", `Docs ${this.shownDocs().length}`], ["chart", `Charts ${this.charts.length}`], ["diagram", `Diagrams ${this.diagrams.length}`]], t),
      () => (this.tab === "chart" ? this.fileList("chart", "CHARTS", t) : this.tab === "diagram" ? this.fileList("diagram", "DIAGRAMS", t) : this.docList(t)));
  }
}

delegate(LocalPanel, "data", ["docs", "docsLoaded", "docsError", "charts", "chartsLoaded", "chartsError", "diagrams", "diagramsLoaded", "diagramsError"]);
delegate(LocalPanel, "view", ["tab", "query"]);
