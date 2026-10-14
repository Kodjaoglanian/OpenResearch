import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../src/commands/app.rs", import.meta.url), "utf8");
const script = source.match(/const MACOS_ESCAPE_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
assert.ok(script, "the macOS webview installs an Escape handler");

test("the Escape guard also reaches sandboxed preview frames", () => {
  assert.match(source, /\.with_initialization_script_for_main_only\(MACOS_ESCAPE_SCRIPT, false\)/);
  assert.match(source, /\.with_initialization_script\("window\.__ORX_MAC_TITLEBAR__ = true;"\)/);
});

function dispatch(key, { modal = false, popover = false, handled = false, modalSupported = true, popoverSupported = true, search = false, readOnly = false, disabled = false } = {}) {
  let listener;
  runInNewContext(script, {
    window: {
      addEventListener(type, handler, capture = false) {
        assert.equal(type, "keydown");
        assert.equal(capture, false, "run after document-level chat/overlay handlers");
        listener = handler;
      },
    },
    CSS: {
      supports(selector) {
        if (selector === "selector(:modal)") return modalSupported;
        assert.equal(selector, "selector(:popover-open)");
        return popoverSupported;
      },
    },
    document: {
      querySelector(selector) {
        if (selector === "dialog:modal" || selector === "dialog[open]") {
          if (selector === "dialog:modal" && !modalSupported) throw new SyntaxError("unsupported :modal");
          return modal ? {} : null;
        }
        assert.equal(selector, "[popover]:popover-open:not([popover=manual])");
        if (!popoverSupported) throw new SyntaxError("unsupported :popover-open");
        return popover && popover !== "manual" ? {} : null;
      },
    },
  });
  const event = {
    key,
    defaultPrevented: handled,
    target: {
      matches(selector) {
        assert.equal(selector, "input[type=search]:enabled:not([readonly])");
        return search && !readOnly && !disabled;
      },
    },
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

test("editable search fields keep WebKit's Escape-to-clear default", () => {
  assert.equal(dispatch("Escape", { search: true }), false);
});

test("immutable search fields cannot enable native fullscreen exit", () => {
  assert.equal(dispatch("Escape", { search: true, readOnly: true }), true);
  assert.equal(dispatch("Escape", { search: true, disabled: true }), true);
});

test("older WebKit without popover selectors still prevents idle Escape", () => {
  assert.equal(dispatch("Escape", { popoverSupported: false }), true);
});

test("older WebKit without either optional selector still prevents idle Escape", () => {
  assert.equal(dispatch("Escape", { modalSupported: false, popoverSupported: false }), true);
});

test("modal cancellation is preserved when popover selectors are unavailable", () => {
  assert.equal(dispatch("Escape", { modal: true, popoverSupported: false }), false);
});

test("WebKit with native dialogs but no :modal keeps Escape-to-cancel", () => {
  assert.equal(dispatch("Escape", { modal: true, modalSupported: false, popoverSupported: false }), false);
});
