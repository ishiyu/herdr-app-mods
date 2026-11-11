import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, theme, run, nextCommand, setShared } from "herdr";

// layout の stack（重ねて 1 枚だけ見せる欄）の id。子の id は right-sidebar-<パネル> で、同名の mod を載せる
const STACK = "right-sidebar";
const PANELS = [["github", "Issues/PRs"], ["ci", "CI"], ["local", ".local"]];
// パネルへ命令を渡す共有状態のキー。各パネルの common.js の REQUEST と同じ値にする
const REQUEST = "right-sidebar.request";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// 命令の行き先のパネルと、そのパネルへ渡す命令。表に出すだけなら渡す命令は null
function route(command, active) {
  if (/^open-\d+$/.test(command) || /^tab-(issue|pr)$/.test(command)) return ["github", command];
  if (/^run-\d+$/.test(command)) return ["ci", command];
  if (command === "tab-ci") return ["ci", null];
  if (/^tab-(local|chart|diagram)$/.test(command) || /^(chart|diagram)-[A-Za-z0-9_-]+$/.test(command)) return ["local", command];
  if (command === "back" && active) return [active, command];
  return null;
}

// 上のタブバーに置く、右サイドバーのパネルを切り替えるボタン。
// mod 宛ての命令は表に出ている mod にしか届かないので、右サイドバー宛ての命令（right-sidebar.<命令>）もここで受け、
// 行き先のパネルを表に出してから共有状態で渡す
export default class RightSidebarTabs extends View {
  init(_props, cx) {
    this.sent = 0;
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        const to = route(command, this.active());
        if (to) this.show(to[0], to[1]);
        else console.log(`right-sidebar: unknown command ${command}`);
        cx.notify();
      }
    });
  }

  // 表に出ているパネル。サイドバーを閉じているときは null
  active() {
    const stack = find(layout(), STACK);
    return stack && !stack.hidden ? stack.active?.slice(STACK.length + 1) ?? null : null;
  }

  show(panel, command = null) {
    run("layout.select", { stack: STACK, child: `${STACK}-${panel}` });
    run("layout.show", { id: STACK });
    // 同じ命令を続けて送っても別の依頼と分かるよう、通し番号を付ける
    if (command) setShared(REQUEST, { to: panel, command, id: `${Date.now()}-${++this.sent}` });
  }

  render() {
    const t = theme(), active = this.active();
    return h_flex().size_full().pr(10).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .children(PANELS.map(([id, label]) => {
        const on = active === id;
        return h_flex().id(`panel-${id}`).h(26).px(8).flex_none().items_center().rounded(6)
          .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover))
          // この欄はウィンドウを掴んで動かせる場所にあるので、ボタンの上では掴ませない
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => { if (on) run("layout.hide", { id: STACK }); else this.show(id); })
          .child(div().child(label));
      }));
  }
}
