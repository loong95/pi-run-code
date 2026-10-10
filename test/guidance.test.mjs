import test from "node:test";
import assert from "node:assert/strict";
import runCodeExtension from "../dist/index.js";

function loadExtension({ mode } = {}) {
  const previous = process.env.PI_RUN_CODE_MODE;
  if (mode === undefined) delete process.env.PI_RUN_CODE_MODE;
  else process.env.PI_RUN_CODE_MODE = mode;

  const handlers = new Map();
  let tool;
  const pi = {
    registerTool(value) { tool = value; },
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    on(name, handler) { handlers.set(name, handler); },
    getActiveTools() { return ["read", "bash", "grep"]; },
    setActiveTools() {},
    getAllTools() { return []; },
    appendEntry() {},
    getFlag() {},
    events: { on() { return () => {}; } },
  };
  runCodeExtension(pi);

  return {
    tool,
    handlers,
    restore() {
      if (previous === undefined) delete process.env.PI_RUN_CODE_MODE;
      else process.env.PI_RUN_CODE_MODE = previous;
    },
  };
}

const context = {
  cwd: process.cwd(),
  hasUI: false,
  ui: { notify() {} },
  isProjectTrusted: () => true,
};

function systemPromptFor(extension) {
  const result = extension.handlers.get("before_agent_start")(
    { systemPrompt: "base prompt" },
    context,
  );
  return result.systemPrompt;
}

test("tool description reserves run_code for composing multiple tool calls", () => {
  const extension = loadExtension({ mode: "both" });
  try {
    assert.match(extension.tool.description, /Compose several coding-tool calls/);
    assert.match(extension.tool.description, /call that tool directly instead/);
    assert.ok(
      extension.tool.promptGuidelines.some((line) =>
        /only when several tool calls must be composed/.test(line),
      ),
    );
    assert.ok(
      extension.tool.promptGuidelines.some((line) =>
        /Do not use run_code to wrap a single tool call/.test(line),
      ),
    );
  } finally {
    extension.restore();
  }
});

test("both mode tells the model to skip run_code for single-tool tasks", () => {
  const extension = loadExtension({ mode: "both" });
  try {
    const prompt = systemPromptFor(extension);
    assert.match(prompt, /Call `run_code` only when one program must combine several/);
    assert.match(prompt, /call that tool directly instead of wrapping it/);
  } finally {
    extension.restore();
  }
});

test("ptc mode keeps run_code as the only direct call but asks for composition", () => {
  const extension = loadExtension({ mode: "ptc" });
  try {
    const prompt = systemPromptFor(extension);
    assert.match(prompt, /is the only tool callable directly/);
    assert.match(prompt, /Prefer one program that composes several bindings/);
    assert.doesNotMatch(prompt, /call that tool directly instead of wrapping it/);
  } finally {
    extension.restore();
  }
});
