import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const file = ts.createSourceFile("ChatPanel.tsx", readFileSync(new URL("../src/components/ChatPanel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function textareaCallback(editor, name) {
  let callback;
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === "textarea") {
      const attributes = node.attributes.properties;
      const target = attributes.some(attribute => ts.isJsxAttribute(attribute)
        && attribute.name.text === (editor ? "value" : "ref")
        && attribute.initializer?.expression?.getText(file) === (editor ? "editDraft" : "composerRef"));
      if (target) callback = attributes.find(attribute => attribute.name?.text === name)?.initializer.expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(callback, name);
  return callback.getText(file);
}

function composer(editor, overrides = {}) {
  const calls = [];
  const record = name => (...args) => calls.push([name, ...args]);
  const bindings = {
    composingRef: { current: false }, skillMenuOpen: false, mentionMenuOpen: false, bashActive: false,
    activeSkillIdx: 0, skillMatches: ["skill"], activeMentionIdx: 0, mentionMatches: ["file"], mentionQuery: "file",
    setSkillIdx: record("skillIndex"), pickSkill: record("skill"), setMentionIdx: record("mentionIndex"),
    pickFileMention: record("mention"), setSkillMenuDismissed: record("dismiss"),
    deleteCommandBehindCaret: record("deleteChip"), runShell: record("shell"), send: record("send"),
    submit: record("submit"), setEditDraft: record("edit"), ...overrides,
  };
  const evaluate = name => new Function(...Object.keys(bindings), `return (${textareaCallback(editor, name)})`)(...Object.values(bindings));
  const keydown = evaluate("onKeyDown");
  return {
    calls, evaluate,
    press(key = "Enter", nativeEvent = {}, modifiers = {}) {
      keydown({ key, shiftKey: false, metaKey: false, ctrlKey: false, ...modifiers,
        nativeEvent: { isComposing: false, keyCode: 13, ...nativeEvent }, preventDefault: record("preventDefault") });
    },
  };
}

for (const editor of [false, true]) {
  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    test(`${editor ? "edit/resend" : "composer"} leaves IME Enter to the input method: ${JSON.stringify(nativeEvent)}`, () => {
      const input = composer(editor);
      input.press("Enter", nativeEvent);
      assert.deepEqual(input.calls, []);
      input.press();
      assert.deepEqual(input.calls, [["preventDefault"], editor ? ["submit"] : ["send", { queue: false }]]);
    });
  }

  test(`${editor ? "edit/resend" : "composer"} preserves Shift+Enter`, () => {
    const input = composer(editor);
    input.press("Enter", {}, { shiftKey: true });
    assert.deepEqual(input.calls, []);
  });
}

test("composition ending before WebKit's confirming keydown does not submit", () => {
  const input = composer(false);
  input.evaluate("onCompositionStart")();
  input.press();
  assert.deepEqual(input.calls, []);
  input.evaluate("onCompositionEnd")();
  input.press("Enter", { keyCode: 229 });
  assert.deepEqual(input.calls, []);
  input.press();
  assert.deepEqual(input.calls, [["preventDefault"], ["send", { queue: false }]]);
});

for (const menu of ["skillMenuOpen", "mentionMenuOpen"]) {
  test(`IME keys do not activate ${menu} shortcuts`, () => {
    const input = composer(false, { [menu]: true });
    for (const key of ["Enter", "Tab", "ArrowDown", "ArrowUp", "Escape", "Backspace"]) {
      input.press(key, { isComposing: true });
      input.press(key, { keyCode: 229 });
    }
    assert.deepEqual(input.calls, []);
  });
}

for (const modifier of ["metaKey", "ctrlKey"]) {
  test(`${modifier}+Enter still queues outside composition`, () => {
    const input = composer(false);
    input.press("Enter", {}, { [modifier]: true });
    assert.deepEqual(input.calls, [["preventDefault"], ["send", { queue: true }]]);
  });
}

for (const [mode, action] of [["bashActive", "shell"], ["skillMenuOpen", "skill"], ["mentionMenuOpen", "mention"]]) {
  test(`${mode} still handles normal Enter`, () => {
    const input = composer(false, { [mode]: true });
    input.press();
    assert.deepEqual(input.calls, [["preventDefault"], action === "shell" ? [action] : [action, action === "skill" ? "skill" : "file"]]);
  });
}
