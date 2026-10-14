import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { fitSidebarRows, sidebarRowHeight } from "../src/sidebarLayout.ts";

const source = readFileSync(new URL("../src/components/ChatPanel.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("ChatPanel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const sessionRow = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "SessionRow");

test("session menus escape transformed sidebar rows and their scroll clipping", () => {
  const row = sessionRow.getText(file);
  assert.match(row, /createPortal\([\s\S]*document\.body/);
  assert.match(row, /ref=\{ref\} className="[^"]*fixed z-70/);
  assert.match(row, /usePopover\(triggerRef, rowRef\)/);
  assert.match(row, /ref=\{rowRef\}/);
});

test("portaled menus keep their owner row inside the outside-click boundary", () => {
  const picker = ts.createSourceFile("ModelPicker.tsx", readFileSync(new URL("../src/components/ModelPicker.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hook = picker.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "usePopover");
  const effect = hook.body.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(picker) === "useEffect").expression.arguments[0];
  const js = ts.transpileModule(`return ${effect.getText(picker)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const listeners = new Map();
  const menu = new EventTarget(), trigger = new EventTarget(), title = new EventTarget();
  let closed = 0, focused = 0;
  const cleanup = new Function("open", "ref", "triggerRef", "boundaryRef", "document", "Node", "setOpen", js)(
    true,
    { current: { contains: target => target === menu } },
    { current: { contains: target => target === trigger, focus: () => focused++ } },
    { current: { contains: target => target === title } },
    { addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) },
    EventTarget,
    value => { assert.equal(value, false); closed++; },
  )();
  for (const target of [menu, trigger, title]) listeners.get("mousedown")({ target });
  assert.equal(closed, 0);
  listeners.get("mousedown")({ target: new EventTarget() });
  assert.equal(closed, 1);
  listeners.get("keydown")({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(closed, 2);
  assert.equal(focused, 1);
  cleanup();
  assert.equal(listeners.size, 0);
});

test("session menus stay in the viewport and dismiss when their anchor moves", () => {
  const effect = sessionRow.body.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(file) === "useLayoutEffect").expression.arguments[0];
  const js = ts.transpileModule(`return ${effect.getText(file)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [direction, anchor, expected] of [
    ["ltr", { left: 250, right: 266, bottom: 80 }, { left: "126px", top: "84px" }],
    ["ltr", { left: 10, right: 26, bottom: 390 }, { left: "8px", top: "272px" }],
    ["rtl", { left: 470, right: 486, bottom: 80 }, { left: "352px", top: "84px" }],
  ]) {
    const listeners = new Map();
    const style = {};
    let dismissed = 0;
    let focused = 0, restored = 0;
    class Element extends EventTarget { contains() { return false; } }
    const inside = new Element();
    const sidebar = new Element();
    const trigger = { getBoundingClientRect: () => anchor, focus: () => restored++ };
    sidebar.contains = target => target === trigger;
    const cleanup = new Function("open", "ref", "triggerRef", "getComputedStyle", "window", "Node", "setOpen", "document", js)(
      true,
      { current: { getBoundingClientRect: () => ({ width: 140, height: 120 }), style, contains: target => target === inside,
        querySelector: () => ({ focus: options => { assert.equal(options.preventScroll, true); focused++; } }) } },
      { current: trigger },
      () => ({ direction }),
      { innerWidth: 500, innerHeight: 400,
        addEventListener: (name, handler) => listeners.set(name, handler),
        removeEventListener: (name, handler) => { assert.equal(listeners.get(name), handler); listeners.delete(name); } },
      Element,
      value => { assert.equal(value, false); dismissed++; },
      { activeElement: inside },
    )();
    assert.deepEqual(style, expected);
    assert.equal(focused, 1);
    listeners.get("scroll")({ type: "scroll", target: inside });
    listeners.get("scroll")({ type: "scroll", target: new Element() });
    assert.equal(dismissed, 0);
    listeners.get("scroll")({ type: "scroll", target: sidebar });
    listeners.get("resize")({ type: "resize" });
    assert.equal(dismissed, 2);
    cleanup();
    assert.equal(listeners.size, 0);
    assert.equal(restored, 1);
  }
});

test("sidebar fits complete rows and keeps an older selected chat visible", () => {
  const first = { id: "first" };
  const second = { id: "second" };
  const rows = [
    { kind: "project", project: first },
    { kind: "chat", project: first, session: { id: "one" } },
    { kind: "chat", project: first, session: { id: "two" } },
    { kind: "project", project: second },
    { kind: "chat", project: second, session: { id: "selected" } },
  ];
  assert.deepEqual(fitSidebarRows(rows, 140, null), rows.slice(0, 3));
  const selected = fitSidebarRows(rows, 140, "selected");
  assert.ok(selected.includes(rows[4]));
  assert.ok(selected.reduce((height, row) => height + sidebarRowHeight(row), 0) <= 140);
});

test("sidebar keeps a trailing collapsed project header", () => {
  const first = { id: "first" };
  const second = { id: "second" };
  const rows = [
    { kind: "project", project: first, collapsed: false, busy: false },
    { kind: "chat", project: first, session: { id: "one" } },
    { kind: "project", project: second, collapsed: true, busy: false },
  ];
  assert.deepEqual(fitSidebarRows(rows, 106, null), rows);
  assert.deepEqual(fitSidebarRows([...rows.slice(0, 2), { ...rows[2], collapsed: false }], 106, null), rows.slice(0, 2));
});
