import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../src/commands/app.rs", import.meta.url), "utf8");
const script = source.match(/const MACOS_ESCAPE_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
assert.ok(script, "the macOS webview installs an Escape handler");

function dispatch(key, { modal = false, popover = false, handled = false } = {}) {
  let listener;
  runInNewContext(script, {
    window: {
      addEventListener(type, handler, capture = false) {
        assert.equal(type, "keydown");
        assert.equal(capture, false, "run after document-level chat/overlay handlers");
        listener = handler;
      },
    },
    document: {
      querySelector(selector) {
        assert.equal(selector, "dialog:modal, [popover]:popover-open:not([popover=manual])");
        return modal || (popover && popover !== "manual") ? {} : null;
      },
    },
  });
  const event = {
    key,
    defaultPrevented: handled,
    preventDefault() { this.defaultPrevented = true; },
  };
  listener(event);
  return event.defaultPrevented;
}

test("unhandled Escape cannot invoke WebKit's native fullscreen exit", () => {
  assert.equal(dispatch("Escape"), true);
});

test("chat and overlay Escape prevention remains intact", () => {
  assert.equal(dispatch("Escape", { handled: true }), true);
});

test("native HTML modal dialogs keep their Escape cancel default", () => {
  assert.equal(dispatch("Escape", { modal: true }), false);
});

test("native HTML popovers keep their Escape dismiss default", () => {
  assert.equal(dispatch("Escape", { popover: true }), false);
});

test("manual tooltips do not enable native fullscreen exit", () => {
  assert.equal(dispatch("Escape", { popover: "manual" }), true);
});

test("other keyboard defaults remain intact", () => {
  assert.equal(dispatch("Enter"), false);
  assert.equal(dispatch("f"), false);
});
