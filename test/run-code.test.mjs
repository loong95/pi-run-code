import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import runCodeExtension from "../dist/index.js";

function loadExtension({ active = ["read", "bash", "edit", "write", "grep", "find", "ls"] } = {}) {
  const handlers = new Map();
  let tool;
  let activeTools = [...active];
  const pi = {
    registerTool(value) { tool = value; },
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    on(name, handler) { handlers.set(name, handler); },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(value) { activeTools = [...value]; },
    getAllTools() { return []; },
    appendEntry() {},
    getFlag() {},
    events: { on() { return () => {}; } },
  };
  runCodeExtension(pi);
  return { tool, handlers, getActiveTools: () => activeTools };
}

const context = (cwd) => ({
  cwd,
  mode: "print",
  hasUI: false,
  ui: {},
  sessionManager: {},
  modelRegistry: {},
  model: undefined,
  scopedModels: [],
  isIdle: () => false,
  isProjectTrusted: () => true,
  signal: undefined,
  abort() {},
  hasPendingMessages: () => false,
  shutdown() {},
  getContextUsage() {},
  compact() {},
  getSystemPrompt() { return ""; },
});

test("runs a TypeScript body and captures logs and return value", async () => {
  const extension = loadExtension();
  const result = await extension.tool.execute("test", {
    description: "calculate a value",
    code: `interface Answer { value: number }\nconst answer: Answer = { value: 40 };\nconsole.log("working");\nreturn { ...answer, value: answer.value + 2 };`,
  }, undefined, undefined, context(process.cwd()));

  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /working/);
  assert.match(result.content[0].text, /42/);
  assert.deepEqual(result.details.result, { value: 42 });
  await extension.handlers.get("session_shutdown")?.({}, context(process.cwd()));
});

test("bridges a built-in read tool into tools.read", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-run-code-"));
  await writeFile(join(cwd, "note.txt"), "hello from a binding\n", "utf8");
  const extension = loadExtension();
  const result = await extension.tool.execute("test", {
    description: "read a note",
    code: `const content = await tools.read({ path: "note.txt" });\nreturn content;`,
  }, undefined, undefined, context(cwd));

  assert.equal(result.details.result, "hello from a binding\n");
  await extension.handlers.get("session_shutdown")?.({}, context(cwd));
});

test("ptc mode keeps the native tool list hidden while retaining bindings", async () => {
  const previous = process.env.PI_RUN_CODE_MODE;
  process.env.PI_RUN_CODE_MODE = "ptc";
  try {
    const extension = loadExtension();
    await extension.handlers.get("session_start")?.({}, context(process.cwd()));
    assert.deepEqual(extension.getActiveTools(), ["run_code"]);
    const result = await extension.tool.execute("test", {
      description: "return a constant",
      code: "return 7;",
    }, undefined, undefined, context(process.cwd()));
    assert.equal(result.details.result, 7);
    await extension.handlers.get("session_shutdown")?.({}, context(process.cwd()));
  } finally {
    if (previous === undefined) delete process.env.PI_RUN_CODE_MODE;
    else process.env.PI_RUN_CODE_MODE = previous;
  }
});

test("reports a timeout for a program that never settles", async () => {
  const previous = process.env.PI_RUN_CODE_MAX_WALL_MS;
  process.env.PI_RUN_CODE_MAX_WALL_MS = "50";
  try {
    const extension = loadExtension();
    await assert.rejects(
      extension.tool.execute("test", {
        description: "test timeout",
        code: "await new Promise(() => {});",
      }, undefined, undefined, context(process.cwd())),
      /run_code failed \(timeout\)/,
    );
    await extension.handlers.get("session_shutdown")?.({}, context(process.cwd()));
  } finally {
    if (previous === undefined) delete process.env.PI_RUN_CODE_MAX_WALL_MS;
    else process.env.PI_RUN_CODE_MAX_WALL_MS = previous;
  }
});
