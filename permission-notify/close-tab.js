// ⌘W（herdr-app-config の keys.json の layout:my-layout で permission-notify.close-tab に割り当てる）で何をするかを決める。
// herdr-app ではタブや pane を閉じると中の terminal が終わる。peek の keep でタブにした子（hc run で起動された sub-agent。
// project-threads の thread など）も止まるので、タブの terminal が全部そういう子なら、閉じずに親の下へ戻す（terminal.park。
// pane の右クリックメニューの「Send back to <親>」と同じ）。それ以外のタブは、これまでの ⌘W と同じく tab.close で閉じる。
// herdr に依存させず、node のテストから読めるようにしてある。

// focus: focused()、panes: panes()、terminals: terminals()。返すのは順に run する [命令, 引数] の列
export function closeTabActions(focus, panes, terminals) {
  const tab = focus?.tab;
  if (!tab) return [["tab.close", {}]];
  const live = new Map(terminals.filter((t) => t.state === "live").map((t) => [t.address, t]));
  const shown = panes.filter((p) => p.tab === tab && p.terminal).map((p) => p.terminal);
  // 親が動いていない子を戻すと、どの一覧にも出ない terminal が残るので戻さない
  const isKid = (address) => {
    const t = live.get(address);
    return Boolean(t?.parent) && live.has(t.parent);
  };
  // mod の pane は数えない。子を戻した後に mod の pane だけが残ったタブは、もう一度 ⌘W を押すと閉じる。
  // 子と子でない terminal が混ざったタブは、子も含めて閉じる（park は core の返事を待って後から効くので、
  // 続けて tab.close を打つと戻す前に終わらせうる）
  if (shown.length && shown.every(isKid)) return shown.map((terminal) => ["terminal.park", { terminal }]);
  return [["tab.close", { id: tab }]];
}
