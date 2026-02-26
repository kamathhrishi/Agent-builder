import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

export type AgentSpec = {
  name: string;
  description: string;
  system_prompt: string;
  model?: string;
  dependencies?: Record<string, string>;
};

export type AgentMeta = {
  name: string;
  description: string;
  createdAt: string;
  model?: string;
};

export function baseDir(): string {
  return path.join(os.homedir(), ".agentbuilder");
}

export function agentsDir(): string {
  return path.join(baseDir(), "agents");
}

export function binDir(): string {
  return path.join(baseDir(), "bin");
}

export function agentDir(name: string): string {
  return path.join(agentsDir(), name);
}

export function ensureDirs(): void {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.mkdirSync(binDir(), { recursive: true });
}

export function listAgents(): AgentMeta[] {
  if (!fs.existsSync(agentsDir())) return [];
  const entries = fs.readdirSync(agentsDir(), { withFileTypes: true });
  const metas: AgentMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(agentsDir(), entry.name, "agent.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as AgentMeta;
      metas.push(meta);
    } catch {
      // ignore corrupted metadata
    }
  }
  return metas.sort((a, b) => a.name.localeCompare(b.name));
}

export function writeAgent(spec: AgentSpec, force = false): string {
  ensureDirs();
  const dir = agentDir(spec.name);
  if (fs.existsSync(dir)) {
    if (!force) {
      throw new Error(`Agent '${spec.name}' already exists. Use --force to overwrite.`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });

  const pkg = {
    name: `@agentbuilder/${spec.name}`,
    version: "0.1.0",
    private: true,
    type: "module",
    bin: {
      [spec.name]: "dist/index.js"
    },
    scripts: {
      build: "tsc -p tsconfig.json",
      start: "node dist/index.js"
    },
    dependencies: {
      openai: spec.dependencies?.openai || "^4.83.0",
      ...(spec.dependencies || {})
    },
    devDependencies: {
      typescript: "^5.7.3"
    }
  };

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      outDir: "dist",
      rootDir: "src",
      strict: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      skipLibCheck: true
    },
    include: ["src"]
  };

  const code = renderAgentCode(spec);

  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  fs.writeFileSync(path.join(dir, "src", "index.ts"), code);

  const meta: AgentMeta = {
    name: spec.name,
    description: spec.description,
    createdAt: new Date().toISOString(),
    model: spec.model
  };
  fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify(meta, null, 2));

  writeShim(spec.name, dir);
  return dir;
}

function writeShim(name: string, dir: string): void {
  const shimPath = path.join(binDir(), name);
  const script = `#!/usr/bin/env bash\nnode "${dir}/dist/index.js" "$@"\n`;
  fs.writeFileSync(shimPath, script, { mode: 0o755 });
}

export function buildAgent(dir: string): void {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const install = spawnSync(npmCmd, ["install"], { cwd: dir, stdio: "inherit" });
  if (install.status !== 0) {
    throw new Error("npm install failed");
  }
  process.stdout.write("Building agent...\\n");
  const build = spawnSync(npmCmd, ["run", "build"], { cwd: dir, stdio: "inherit" });
  if (build.status !== 0) {
    throw new Error("npm run build failed");
  }
}

export function renderAgentCode(spec: AgentSpec): string {
  const model = spec.model || "gpt-5";
  const system = JSON.stringify(
    `${spec.system_prompt}\\n\\nYou are a ReAct-style agent. Use tools when helpful.\\n\\nResponse format (always include both):\\n<<<INTERNAL>>>\\n...\\n<<<END_INTERNAL>>>\\n<<<FINAL>>>\\n...\\n<<<END_FINAL>>>\\nThe INTERNAL section contains hidden reasoning or tool chatter. The FINAL section is the user-facing response.`
  );
  return `import OpenAI from "openai";
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.NODE_NO_WARNINGS = "1";

const INTERNAL_START = "<<<INTERNAL>>>";
const INTERNAL_END = "<<<END_INTERNAL>>>";
const FINAL_START = "<<<FINAL>>>";
const FINAL_END = "<<<END_FINAL>>>";
const CYAN = "\u001b[36m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    stdin.setEncoding("utf-8");
    stdin.on("data", (chunk) => (data += chunk));
    stdin.on("end", () => resolve(data.trim()));
  });
}

type ToolResult = { ok: boolean; output: string };

function enableInternalToggle(onToggle: () => void): () => void {
  if (!stdin.isTTY) return () => {};
  const handler = (buf: Buffer) => {
    if (buf.length === 1 && buf[0] === 0x0f) {
      onToggle();
    }
  };
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", handler);
  return () => {
    stdin.off("data", handler);
    stdin.setRawMode(false);
  };
}

function baseDir(): string {
  return path.join(os.homedir(), ".agentbuilder");
}

function readKeys(): { tavily_api_key?: string } {
  const p = path.join(baseDir(), "keys.json");
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function resolveSafePath(p: string): string {
  const cwd = process.cwd();
  const full = path.resolve(cwd, p);
  if (!full.startsWith(cwd)) {
    throw new Error("Path escapes working directory.");
  }
  return full;
}

async function tool_web_search(args: { query: string; max_results?: number }): Promise<ToolResult> {
  const key = process.env.TAVILY_API_KEY || readKeys().tavily_api_key;
  if (!key) return { ok: false, output: "Missing TAVILY_API_KEY. Run: agentbuilder config" };
  const payload = { query: args.query, max_results: args.max_results ?? 5 }; 
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, ...payload })
  });
  const json = await res.json();
  return { ok: res.ok, output: JSON.stringify(json, null, 2) };
}

async function tool_fetch_url(args: { url: string }): Promise<ToolResult> {
  if (!/^https?:\\/\\//.test(args.url)) {
    return { ok: false, output: "Only http(s) URLs are allowed." };
  }
  const res = await fetch(args.url);
  const text = await res.text();
  return { ok: res.ok, output: text.slice(0, 20000) };
}

async function tool_list_files(args: { path?: string }): Promise<ToolResult> {
  const target = resolveSafePath(args.path || ".");
  const entries = fs.readdirSync(target, { withFileTypes: true });
  const items = entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name));
  return { ok: true, output: items.join("\\n") };
}

async function tool_read_file(args: { path: string }): Promise<ToolResult> {
  const target = resolveSafePath(args.path);
  const data = fs.readFileSync(target, "utf-8");
  return { ok: true, output: data.slice(0, 20000) };
}

async function tool_write_file(args: { path: string; content: string }): Promise<ToolResult> {
  const target = resolveSafePath(args.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, args.content, "utf-8");
  return { ok: true, output: "Wrote file." };
}

const tools = [
  {
    type: "function",
    name: "web_search",
    description: "Search the web using Tavily. Returns JSON results.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer" }
      },
      required: ["query"]
    }
  },
  {
    type: "function",
    name: "fetch_url",
    description: "Fetch a URL via HTTP GET.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"]
    }
  },
  {
    type: "function",
    name: "list_files",
    description: "List files in a directory relative to the current working directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } }
    }
  },
  {
    type: "function",
    name: "read_file",
    description: "Read a file relative to the current working directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  {
    type: "function",
    name: "write_file",
    description: "Write a file relative to the current working directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    }
  }
];

async function execTool(name: string, args: any): Promise<ToolResult> {
  switch (name) {
    case "web_search":
      return tool_web_search(args);
    case "fetch_url":
      return tool_fetch_url(args);
    case "list_files":
      return tool_list_files(args);
    case "read_file":
      return tool_read_file(args);
    case "write_file":
      return tool_write_file(args);
    default:
      return { ok: false, output: "Unknown tool." };
  }
}

function printAgentBanner() {
  if (!stdout.isTTY) return;
  stdout.write(
    CYAN + "┌──────────────────────────────────────────────┐" + RESET + "\\n" +
      CYAN + "│                 AGENT SESSION               │" + RESET + "\\n" +
      CYAN + "└──────────────────────────────────────────────┘" + RESET + "\\n" +
      DIM + "Type a message. Commands: /tools /help /exit. Toggle internal with Ctrl+O." + RESET + "\\n\\n"
  );
}

function printTools() {
  stdout.write(
    CYAN + "Available tools" + RESET + "\\n" +
      "- web_search: Search the web (Tavily)\\n" +
      "- fetch_url: Fetch a URL via HTTP GET\\n" +
      "- list_files: List files in current directory\\n" +
      "- read_file: Read a file relative to cwd\\n" +
      "- write_file: Write a file relative to cwd\\n\\n"
  );
}

function printHelp() {
  stdout.write(
    CYAN + "Commands" + RESET + "\\n" +
      "- /tools: list available tools\\n" +
      "- /help: show this help\\n" +
      "- /exit: quit the session\\n\\n"
  );
}

function createParser(showInternalRef: { value: boolean }) {
  let state: "neutral" | "internal" | "final" = "neutral";
  let buffer = "";
  let finalText = "";

  const emitFinal = (text: string) => {
    finalText += text;
    stdout.write(text);
  };

  const emitInternal = (text: string) => {
    if (showInternalRef.value) {
      stdout.write(text);
    }
  };

  const minPos = (a: number, b: number) => {
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  };

  const processBuffer = () => {
    while (buffer.length > 0) {
      if (state === "internal") {
        const idx = buffer.indexOf(INTERNAL_END);
        if (idx === -1) {
          emitInternal(buffer);
          buffer = "";
          return;
        }
        emitInternal(buffer.slice(0, idx));
        buffer = buffer.slice(idx + INTERNAL_END.length);
        state = "neutral";
        continue;
      }

      if (state === "final") {
        const idx = buffer.indexOf(FINAL_END);
        if (idx === -1) {
          emitFinal(buffer);
          buffer = "";
          return;
        }
        emitFinal(buffer.slice(0, idx));
        buffer = buffer.slice(idx + FINAL_END.length);
        state = "neutral";
        continue;
      }

      const nextInternal = buffer.indexOf(INTERNAL_START);
      const nextFinal = buffer.indexOf(FINAL_START);
      const next = minPos(nextInternal, nextFinal);
      if (next === -1) {
        emitFinal(buffer);
        buffer = "";
        return;
      }
      if (next > 0) {
        emitFinal(buffer.slice(0, next));
        buffer = buffer.slice(next);
        continue;
      }
      if (next === 0) {
        if (buffer.startsWith(INTERNAL_START)) {
          buffer = buffer.slice(INTERNAL_START.length);
          state = "internal";
          continue;
        }
        if (buffer.startsWith(FINAL_START)) {
          buffer = buffer.slice(FINAL_START.length);
          state = "final";
          continue;
        }
      }
      emitFinal(buffer[0]);
      buffer = buffer.slice(1);
    }
  };

  return {
    push: (delta: string) => {
      buffer += delta;
      processBuffer();
    },
    finish: () => {
      if (buffer.length > 0) {
        if (state === "internal") {
          emitInternal(buffer);
        } else {
          emitFinal(buffer);
        }
        buffer = "";
      }
      return finalText.trim();
    }
  };
}

function messageItem(role: string, text: string) {
  return { role, content: [{ type: "input_text", text }] };
}

async function streamResponse(
  client: OpenAI,
  model: string,
  inputItems: any[],
  showInternalRef: { value: boolean }
): Promise<string> {
  const parser = createParser(showInternalRef);
  const toggleOff = enableInternalToggle(() => {
    showInternalRef.value = !showInternalRef.value;
    stdout.write(showInternalRef.value ? "\\n[internal on]\\n" : "\\n[internal off]\\n");
  });

  try {
    const stream: any = await client.responses.create({
      model,
      input: inputItems,
      stream: true
    } as any);

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        parser.push(event.delta || "");
      }
    }
  } finally {
    toggleOff();
  }

  return parser.finish();
}

async function runOnce(client: OpenAI, task: string) {
  const showInternalRef = { value: false };
  const inputItems: any[] = [messageItem("system", ${system}), messageItem("user", task)];
  let steps = 0;
  while (steps < 3) {
    const response: any = await client.responses.create({
      model: "${model}",
      input: inputItems,
      tools,
      tool_choice: "auto"
    } as any);
    const toolCalls = (response.output || []).filter((o: any) => o.type === "function_call");
    if (!toolCalls.length) {
      break;
    }
    for (const call of toolCalls) {
      let args: any = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        args = {};
      }
      const result = await execTool(call.name, args);
      inputItems.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result)
      });
    }
    steps += 1;
  }
  const finalText = await streamResponse(client, "${model}", inputItems, showInternalRef);
  if (!finalText) stdout.write("\\n");
}

async function runRepl(client: OpenAI) {
  const showInternalRef = { value: false };
  const inputItems: any[] = [messageItem("system", ${system})];
  const rl = readline.createInterface({ input: stdin, output: stdout });
  printAgentBanner();
  const prompt = () =>
    new Promise<string>((resolve) =>
      rl.question(CYAN + ">" + RESET + " ", resolve)
    );

  while (true) {
    const line = (await prompt()).trim();
    if (!line) continue;
    if (line === "exit" || line === "quit" || line === "/exit") break;
    if (line === "/tools") {
      printTools();
      continue;
    }
    if (line === "/help") {
      printHelp();
      continue;
    }
    inputItems.push(messageItem("user", line));
    if (stdout.isTTY) stdout.write(DIM + "Thinking..." + RESET + "\\n");
    let steps = 0;
    while (steps < 3) {
    const response: any = await client.responses.create({
      model: "${model}",
      input: inputItems,
      tools,
      tool_choice: "auto"
    } as any);
      const toolCalls = (response.output || []).filter((o: any) => o.type === "function_call");
      if (!toolCalls.length) {
        break;
      }
      for (const call of toolCalls) {
        let args: any = {};
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await execTool(call.name, args);
        inputItems.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result)
        });
      }
      steps += 1;
    }
    const finalText = await streamResponse(client, "${model}", inputItems, showInternalRef);
    inputItems.push({ role: "assistant", content: [{ type: "output_text", text: finalText || "" }] });
    stdout.write("\\n");
  }

  rl.close();
}

async function main() {
  const args = process.argv.slice(2);
  const taskArgIndex = args.findIndex((arg) => arg === "--task");
  let task = "";
  if (taskArgIndex >= 0 && args[taskArgIndex + 1]) {
    task = args[taskArgIndex + 1];
  } else if (args.length > 0) {
    task = args.join(" ");
  } else if (!stdin.isTTY) {
    task = await readStdin();
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is required.");
    process.exit(1);
  }

  const client = new OpenAI({ apiKey });
  if (task) {
    await runOnce(client, task);
    return;
  }
  await runRepl(client);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
`;
}
