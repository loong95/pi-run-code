import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("pi-run-code: worker started without a parent port");

const pending = new Map();
let nextCallId = 1;
let outputLimitSent = false;
const logs = [];
const maxOutputBytes = workerData.maxOutputBytes;
let outputBytes = 2; // JSON encoding of []

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function emitLog(value) {
  if (outputLimitSent) return;
  const text = String(value);
  const separator = logs.length ? 1 : 0;
  const cost = bytes(text) + separator;
  if (outputBytes + cost > maxOutputBytes) {
    outputLimitSent = true;
    parentPort.postMessage({ type: "output-limit" });
    return;
  }
  outputBytes += cost;
  logs.push(text);
  parentPort.postMessage({ type: "log", text });
}

function inspect(value, depth = 0, seen = new Set()) {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (depth > 4) return "[Object]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.slice(0, 100).map((item) => inspect(item, depth + 1, seen)).join(", ")}]`;
  }
  return `{ ${Object.keys(value).slice(0, 100).map((key) => `${key}: ${inspect(value[key], depth + 1, seen)}`).join(", ")} }`;
}

const consoleShim = Object.create(null);
for (const level of ["log", "info", "warn", "error", "debug"]) {
  consoleShim[level] = (...args) => emitLog(args.map((arg) => inspect(arg)).join(" "));
}

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  return Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).every((key) => isJsonValue(value[key], seen));
}

function makeErrorClass(name, memberName) {
  return class ToolCallError extends Error {
    constructor(toolName, message) {
      super(message);
      this.name = name;
      this[memberName] = toolName;
    }
  };
}

function makeNamespace(namespace, errorClass) {
  const target = Object.create(null);
  for (const name of namespace.names) {
    Object.defineProperty(target, name, {
      enumerable: true,
      value: (args) => new Promise((resolve, reject) => {
        const id = nextCallId++;
        pending.set(id, { resolve, reject, name });
        try {
          parentPort.postMessage({ type: "call", id, name, args });
        } catch (error) {
          pending.delete(id);
          reject(new errorClass(name, `could not send arguments: ${String(error)}`));
        }
      }),
    });
  }
  return target;
}

parentPort.on("message", (message) => {
  if (!message || message.type !== "reply" || typeof message.id !== "number") return;
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  if (message.ok) call.resolve(message.value);
  else call.reject(new ToolCallErrorClass(call.name, message.message));
});

// Capture explicit process writes as well as console output. The host starts
// this worker with an empty environment; this is containment, not a security boundary.
for (const stream of [process.stdout, process.stderr]) {
  stream.write = (chunk, ...rest) => {
    emitLog(typeof chunk === "string" ? chunk : String(chunk));
    const callback = rest.find((item) => typeof item === "function");
    if (callback) queueMicrotask(() => callback(null));
    return true;
  };
}

const errorDescriptor = workerData.errorClass;
const ToolCallErrorClass = makeErrorClass(errorDescriptor.name, errorDescriptor.memberNameProperty);
const tools = makeNamespace(workerData.namespace, ToolCallErrorClass);

let result;
try {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("tools", "ToolCallError", "console", `'use strict';\n${workerData.code}`);
  const value = await fn(tools, ToolCallErrorClass, consoleShim);
  if (value !== undefined) {
    if (!isJsonValue(value)) {
      result = { error: { kind: "exception", message: "program completion must be lossless JSON" } };
    } else {
      // Structured clone is deliberately used only after the program has settled.
      // The host validates the value again before returning it to pi.
      result = { value };
    }
  } else {
    result = {};
  }
} catch (error) {
  result = {
    error: {
      kind: "exception",
      message: error instanceof Error ? (error.stack || error.message) : String(error),
    },
  };
}

if (!outputLimitSent) parentPort.postMessage({ type: "done", ...result });
