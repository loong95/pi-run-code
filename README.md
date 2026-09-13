# pi-run-code

一个参考 dsh `run_code` / PTC（Programmatic Tool Calling）设计的 pi 插件。

## 功能

- 注册模型可调用的 `run_code` 工具。
- 在独立 Node worker 中执行 TypeScript 异步函数体，支持顶层 `await` 与 `return`。
- 将当前 pi 的 built-in coding tools 暴露为 `tools.read(...)`、`tools.bash(...)`、`tools.edit(...)` 等异步函数。
- 捕获 `console.log/info/warn/error/debug` 和 `process.stdout/stderr` 输出。
- 工具调用失败会以 `ToolCallError` 拒绝，并提供 `error.toolName`。
- 每次执行都有 wall-clock 超时、输出大小限制和 AbortSignal 取消。
- 在 system prompt 中生成当前工具集合的 TypeScript SDK 声明。
- 每次运行使用新的 worker，不跨调用保留程序状态，便于会话可重放。

> **安全提醒：** worker 隔离不是安全沙箱。模型代码仍然具有与 `bash` 类似的项目操作权限。不要把此插件当作不可信代码执行环境。

## 使用

开发测试：

```bash
npm install
npm run build
pi -e ./dist/index.js
```

也可以将 `dist/index.js` 放到 `~/.pi/agent/extensions/`，或在项目中放到 `.pi/extensions/`。

## 配置

通过环境变量配置：

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `PI_RUN_CODE_MODE` | `both` | `ptc` 只让模型直接调用 `run_code`；`both` 保留 pi 原生工具 |
| `PI_RUN_CODE_MAX_WALL_MS` | `600000` | 单次程序最大墙钟时间 |
| `PI_RUN_CODE_MAX_COMPUTE_MS` | `60000` | worker 的最大事件循环忙碌时间；等待工具不计入 |
| `PI_RUN_CODE_MAX_OUTPUT_BYTES` | `4194304` | 日志和返回值的最大序列化大小 |
| `PI_RUN_CODE_TOOLS` | 当前 pi 工具 | 逗号分隔的绑定白名单，例如 `read,bash,grep` |

## 示例

模型可以生成类似如下的调用：

```ts
await run_code({
  description: "Find TODO counts across TypeScript files",
  code: `
    const result = await tools.grep({
      pattern: "TODO",
      path: "src",
    });
    return result;
  `,
});
```

程序输出只应包含后续回答所需的摘要，而不是直接倾倒大文件或完整命令输出。

## 与 dsh run_code 的对应关系

```mermaid
flowchart LR
  M[模型] --> R[run_code]
  R --> W[独立 worker]
  W --> SDK[tools.* SDK binding]
  SDK --> P[pi tool definition]
  P --> O[read/bash/edit/write/...]
  O --> SDK
  SDK --> W
  W --> R
  R --> M
```

本插件通过 pi 的公开 API 创建 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`、`powershell` 绑定；当前 pi extension API 没有公开“按名称执行任意已注册扩展工具”的接口，因此第三方自定义工具不会自动出现在 `tools` SDK 中。

本插件实现的是 pi extension 能力范围内的轻量版本：使用 pi 的公开 `registerTool`、`create*Tool` 与生命周期事件；不会修改 pi agent loop，也没有 dsh 的嵌套持久化 dispatch event、scope runtime、typed output schema 或后台任务 runtime。
