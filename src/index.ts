import { stripTypeScriptTypes } from "node:module";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createPowerShellTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const RUN_CODE_NAME = "run_code";
const TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"] as const;
type BuiltinToolName = (typeof TOOL_NAMES)[number];
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type RunCodeParams = {
  code: string;
  description: string;
};

export interface RunCodeConfig {
  /** Maximum wall-clock duration of one program, in milliseconds. */
  maxWallMs?: number;
  /** Maximum measured worker busy time, in milliseconds. */
  maxComputeMs?: number;
  /** Maximum serialized size of logs plus the returned value, in bytes. */
  maxOutputBytes?: number;
  /** Which presentation to use. `both` keeps pi's native tools active. */
  mode?: "ptc" | "both";
}

interface RunFailure {
  kind: "exception" | "timeout" | "abort" | "worker-exit" | "output-limit";
  message: string;
}

interface RunOutcome {
  logs: string[];
  value?: JsonValue;
  error?: RunFailure;
}

interface RunCodeDetails {
  durationMs: number;
  logs: string[];
  result?: JsonValue;
  error?: RunFailure;
  tools: string[];
}

interface WorkerCall {
  type: "call";
  id: number;
  name: string;
  args: unknown;
}

interface WorkerLog {
  type: "log";
  text: string;
}

interface WorkerDone {
  type: "done";
  value?: unknown;
  error?: { kind: "exception"; message: string };
}

type WorkerMessage = WorkerCall | WorkerLog | { type: "output-limit" } | WorkerDone;

type WorkerReply =
  | { type: "reply"; id: number; ok: true; value: JsonValue }
  | { type: "reply"; id: number; ok: false; message: string };

const PARAMETERS = Type.Object({
  code: Type.String({
    description:
      "The BODY of an async TypeScript function, not a complete module or markdown code block. " +
      "Top-level await and return are supported. Call available tools with await tools.name(args). " +
      "Use console.log(...) and/or return to produce a small, curated result for the model.",
  }),
  description: Type.String({
    description:
      "A concise 5-10 word active-voice summary shown in the UI, " +
      "for example: Count TODO markers across packages.",
  }),
});

const PROMPT_MARKER = "<!-- pi-run-code -->";
const DEFAULT_MAX_WALL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_COMPUTE_MS = 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const WORKER_FILE = fileURLToPath(new URL("./worker.mjs", import.meta.url));

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readConfig(): Required<RunCodeConfig> {
  const configuredMode = process.env.PI_RUN_CODE_MODE;
  return {
    maxWallMs: positiveInteger(process.env.PI_RUN_CODE_MAX_WALL_MS, DEFAULT_MAX_WALL_MS),
    maxComputeMs: positiveInteger(process.env.PI_RUN_CODE_MAX_COMPUTE_MS, DEFAULT_MAX_COMPUTE_MS),
    maxOutputBytes: positiveInteger(process.env.PI_RUN_CODE_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES),
    mode: configuredMode === "ptc" ? "ptc" : "both",
  };
}

/** Convert a value crossing the worker boundary into detached JSON. */
function toJsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("value must be lossless JSON");
  return JSON.parse(encoded) as JsonValue;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contentValue(content: readonly unknown[]): JsonValue {
  const blocks = content.map((block) => {
    if (typeof block !== "object" || block === null) return { type: "text", text: String(block) };
    const candidate = block as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text;
    if (candidate.type === "image") {
      const source = candidate.source as Record<string, unknown> | undefined;
      return {
        type: "image",
        mediaType: typeof source?.mediaType === "string" ? source.mediaType : "unknown",
      };
    }
    return { type: "unknown", value: String(candidate.type ?? "content") };
  });
  if (blocks.length === 0) return null;
  if (blocks.length === 1) return toJsonValue(blocks[0]);
  return toJsonValue(blocks);
}

function renderValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "null";
}

function schemaToType(schema: unknown, depth = 0): string {
  if (depth > 8 || typeof schema !== "object" || schema === null) return "JsonValue";
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node.anyOf)) return node.anyOf.map((item) => schemaToType(item, depth + 1)).join(" | ");
  if (Array.isArray(node.oneOf)) return node.oneOf.map((item) => schemaToType(item, depth + 1)).join(" | ");
  if (Array.isArray(node.enum)) return node.enum.map((item) => JSON.stringify(item)).join(" | ");
  if (node.type === "string") return "string";
  if (node.type === "number" || node.type === "integer") return "number";
  if (node.type === "boolean") return "boolean";
  if (node.type === "null") return "null";
  if (node.type === "array") return `Array<${schemaToType(node.items, depth + 1)}>`;
  if (node.type === "object" || node.properties) {
    const properties = node.properties as Record<string, unknown> | undefined;
    if (!properties || Object.keys(properties).length === 0) return "Record<string, JsonValue>";
    const required = new Set(Array.isArray(node.required) ? node.required.filter((key): key is string => typeof key === "string") : []);
    const fields = Object.entries(properties).map(([name, value]) => {
      const safeName = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
      return `${safeName}${required.has(name) ? "" : "?"}: ${schemaToType(value, depth + 1)}`;
    });
    return `{ ${fields.join("; ")} }`;
  }
  return "JsonValue";
}

function sourceDescription(name: string, definition: ToolDefinition): string {
  const description = definition.description.replace(/\s+/g, " ").replace(/\*\//g, "* /").trim();
  return `  /** ${description} */\n  ${name}: (args: ${schemaToType(definition.parameters)}) => Promise<JsonValue>;`;
}

function buildSdkPrompt(definitions: Record<string, ToolDefinition>, names: string[], mode: "ptc" | "both"): string {
  const entries = names
    .filter((name) => definitions[name])
    .sort()
    .map((name) => sourceDescription(name, definitions[name]!));
  if (entries.length === 0) return "";
  const directRule = mode === "ptc"
    ? `In this session, \`${RUN_CODE_NAME}\` is the only tool callable directly. The bindings below are program-only; call them from inside \`${RUN_CODE_NAME}\`.`
    : `You may call the bindings below from inside \`${RUN_CODE_NAME}\` to compose several operations into one step.`;
  return [
    PROMPT_MARKER,
    "## Program tool API",
    directRule,
    "`run_code` executes the BODY of an async TypeScript function in a fresh worker. Write statements directly; top-level `await` and `return` work. Each call starts with new program state.",
    "Call each binding with one JSON-compatible argument: `await tools.name(args)`. Follow the declarations below for exact names and argument shapes.",
    "Use `console.log(...)` and/or `return` to curate the small result sent back to the model. Prefer filtering, mapping, counting, and aggregating inside one run rather than returning large raw files or command output.",
    "Binding failures reject with `ToolCallError`; catch them when partial results or recovery are useful, and inspect `error.toolName` and `error.message`.",
    "```typescript",
    "type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };",
    "declare class ToolCallError extends Error { readonly toolName: string; }",
    "declare const tools: {",
    ...entries,
    "};",
    "```",
    "Example: `return await tools.read({ path: \"src/index.ts\" });`",
    "Example with composition: `const matches = await tools.grep({ pattern: \"TODO\", path: \"src\" }); return matches;`",
    "Example with recovery: `try { return await tools.read({ path: \"missing.txt\" }); } catch (error) { const failure = error as ToolCallError; return { tool: failure.toolName, message: failure.message }; }`",
    PROMPT_MARKER,
  ].join("\n");
}

class RunCodeRuntime {
  private readonly live = new Set<Worker>();

  constructor(private readonly config: Required<RunCodeConfig>) {}

  async dispose(): Promise<void> {
    await Promise.all([...this.live].map((worker) => worker.terminate()));
    this.live.clear();
  }

  async run(
    code: string,
    definitions: Record<string, ToolDefinition>,
    names: string[],
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onLog: (logs: string[]) => void,
  ): Promise<RunOutcome> {
    let strippedCode: string;
    try {
      const wrapped = `async function __pi_run_code__() {\n${code}\n}`;
      const stripped = stripTypeScriptTypes(wrapped);
      strippedCode = stripped.slice("async function __pi_run_code__() {\n".length, -2);
    } catch (error) {
      return { logs: [], error: { kind: "exception", message: messageOf(error) } };
    }
    if (signal?.aborted) return { logs: [], error: { kind: "abort", message: String(signal.reason) } };

    const controller = new AbortController();
    const abortOuter = () => controller.abort(signal?.reason ?? "aborted");
    signal?.addEventListener("abort", abortOuter, { once: true });
    const worker = new Worker(WORKER_FILE, {
      workerData: {
        code: strippedCode,
        namespace: { names },
        errorClass: { name: "ToolCallError", memberNameProperty: "toolName" },
        maxOutputBytes: this.config.maxOutputBytes,
      },
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    this.live.add(worker);

    return new Promise<RunOutcome>((resolve) => {
      const logs: string[] = [];
      const hostCalls = new Set<Promise<void>>();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let computeTimer: ReturnType<typeof setInterval> | undefined;

      const finish = (outcome: RunOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (computeTimer) clearInterval(computeTimer);
        signal?.removeEventListener("abort", abortOuter);
        controller.abort("run_code settled");
        void (async () => {
          await Promise.allSettled([...hostCalls]);
          await worker.terminate();
          this.live.delete(worker);
          resolve({ ...outcome, logs: [...logs] });
        })();
      };

      const reply = (message: WorkerReply): void => {
        if (!settled) {
          try {
            worker.postMessage(message);
          } catch {
            // The worker may have been terminated concurrently. The run's
            // terminal outcome remains authoritative.
          }
        }
      };

      const invoke = async (call: WorkerCall): Promise<void> => {
        const definition = definitions[call.name];
        if (!definition) {
          reply({ type: "reply", id: call.id, ok: false, message: `unknown tool ${JSON.stringify(call.name)}` });
          return;
        }
        try {
          const args = definition.prepareArguments ? definition.prepareArguments(call.args) : call.args;
          const result = await definition.execute(`${RUN_CODE_NAME}:${call.id}`, args, controller.signal, undefined, ctx);
          const value = contentValue(result.content);
          reply({ type: "reply", id: call.id, ok: true, value: toJsonValue(value) });
        } catch (error) {
          reply({ type: "reply", id: call.id, ok: false, message: messageOf(error) });
        }
      };

      worker.on("message", (message: WorkerMessage) => {
        if (settled || !message || typeof message !== "object") return;
        if (message.type === "log") {
          logs.push(message.text);
          onLog([...logs]);
          return;
        }
        if (message.type === "output-limit") {
          finish({ logs, error: { kind: "output-limit", message: `output exceeded ${this.config.maxOutputBytes} bytes` } });
          return;
        }
        if (message.type === "call") {
          const task = invoke(message).finally(() => hostCalls.delete(task));
          hostCalls.add(task);
          return;
        }
        if (message.type === "done") {
          if (message.error) {
            finish({ logs, error: { kind: "exception", message: message.error.message } });
            return;
          }
          try {
            const value = message.value === undefined ? undefined : toJsonValue(message.value);
            if (value !== undefined) {
              const bytes = Buffer.byteLength(JSON.stringify({ logs, value }), "utf8");
              if (bytes > this.config.maxOutputBytes) {
                finish({ logs, error: { kind: "output-limit", message: `output exceeded ${this.config.maxOutputBytes} bytes` } });
              } else {
                finish({ logs, value });
              }
            } else {
              finish({ logs });
            }
          } catch (error) {
            finish({ logs, error: { kind: "exception", message: `invalid program result: ${messageOf(error)}` } });
          }
        }
      });
      worker.on("error", (error) => finish({ logs, error: { kind: "worker-exit", message: messageOf(error) } }));
      worker.on("exit", (code) => {
        if (!settled && code !== 0) finish({ logs, error: { kind: "worker-exit", message: `worker exited with code ${code}` } });
      });
      controller.signal.addEventListener("abort", () => {
        if (!settled) finish({ logs, error: { kind: "abort", message: String(controller.signal.reason) } });
      }, { once: true });
      computeTimer = setInterval(() => {
        if (worker.performance.eventLoopUtilization().active > this.config.maxComputeMs) {
          finish({ logs, error: { kind: "timeout", message: `compute limit reached (${this.config.maxComputeMs}ms busy)` } });
        }
      }, 25);
      timer = setTimeout(() => finish({ logs, error: { kind: "timeout", message: `wall-clock limit reached (${this.config.maxWallMs}ms)` } }), this.config.maxWallMs);
    });
  }
}

function makeVisibleTools(pi: ExtensionAPI, cwd: string, allowed: readonly string[] | undefined): { definitions: Record<string, ToolDefinition>; names: string[] } {
  const definitions: Record<string, ToolDefinition> = {
    read: createReadTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
    powershell: createPowerShellTool(cwd),
  };
  const active = new Set(pi.getActiveTools());
  const configured = process.env.PI_RUN_CODE_TOOLS?.split(",").map((name) => name.trim()).filter(Boolean);
  const candidates = configured?.length ? configured : TOOL_NAMES;
  const names = candidates.filter((name) => definitions[name] && (allowed ? allowed.includes(name) : active.has(name)));
  return { definitions, names };
}

export default function runCodeExtension(pi: ExtensionAPI): void {
  const config = readConfig();
  const runtime = new RunCodeRuntime(config);
  let ptcTools: string[] | undefined;

  pi.registerTool({
    name: RUN_CODE_NAME,
    label: "Run Code",
    description:
      "Execute TypeScript against pi's available coding tools. Pass `code` as the BODY of an async function; " +
      "top-level `await` and `return` work. Call tools as `await tools.name(args)` using the generated declarations. " +
      "Use local computation to filter, map, count, or aggregate tool results, then print or return only the small curated result needed by the model. " +
      "Each call starts in a fresh worker.",
    promptSnippet: "Compose multiple coding-tool calls in one TypeScript program and return a curated result",
    promptGuidelines: [
      "Use run_code when several independent tool calls can be composed into one step or when the result needs local filtering, mapping, or aggregation.",
      "Only print or return the small result that the model needs; do not dump entire files or large command output.",
    ],
    parameters: PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!params.description.trim()) throw new Error("run_code description must not be empty");
      const visible = makeVisibleTools(pi, ctx.cwd, config.mode === "ptc" ? ptcTools : undefined);
      const started = Date.now();
      const outcome = await runtime.run(params.code, visible.definitions, visible.names, ctx, signal, (logs) => {
        onUpdate?.({
          content: [{ type: "text", text: logs.join("\n") }],
          details: { durationMs: Date.now() - started, logs, tools: visible.names },
        });
      });
      const details: RunCodeDetails = {
        durationMs: Date.now() - started,
        logs: outcome.logs,
        ...(outcome.value !== undefined ? { result: outcome.value } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        tools: visible.names,
      };
      if (outcome.error) {
        const captured = outcome.logs.length ? `\nCaptured output:\n${outcome.logs.join("\n")}` : "";
        throw new Error(`run_code failed (${outcome.error.kind}): ${outcome.error.message}${captured}`);
      }
      const parts = outcome.logs.length ? [outcome.logs.join("\n")] : [];
      if (outcome.value !== undefined) parts.push(renderValue(outcome.value));
      return {
        content: [{ type: "text", text: parts.length ? parts.join("\n") : "(run_code completed with no output)" }],
        details,
      };
    },
    renderCall(args, theme, _context) {
      return new Text(`${theme.fg("toolTitle", theme.bold("run_code "))}${theme.fg("accent", args.description)}\n${theme.fg("muted", args.code)}`, 0, 0);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const visible = makeVisibleTools(pi, ctx.cwd, undefined);
    ptcTools = visible.names;
    if (config.mode === "ptc") pi.setActiveTools([RUN_CODE_NAME]);
    if (ctx.hasUI) ctx.ui.notify(`run_code loaded (${config.mode}; ${ptcTools.length} tool bindings)`, "info");
  });

  pi.on("before_agent_start", (event, ctx) => {
    const visible = makeVisibleTools(pi, ctx.cwd, config.mode === "ptc" ? ptcTools : undefined);
    const sdk = buildSdkPrompt(visible.definitions, visible.names, config.mode);
    if (!sdk) return;
    const withoutPrevious = event.systemPrompt.replace(new RegExp(`\\n?${PROMPT_MARKER}[\\s\\S]*?${PROMPT_MARKER}\\n?`, "g"), "\n");
    return { systemPrompt: `${withoutPrevious.trimEnd()}\n\n${sdk}` };
  });

  pi.on("session_shutdown", async () => {
    await runtime.dispose();
  });
}
