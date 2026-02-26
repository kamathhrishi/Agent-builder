import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { promptLine, promptMultiline, promptSecret } from "./lib/io.js";
import { buildAgentSpec } from "./lib/openai.js";
import {
  AgentSpec,
  agentDir,
  buildAgent,
  listAgents,
  writeAgent
} from "./lib/agents.js";
import { launchInBackground, launchInNewTerminal } from "./lib/terminal.js";
import { Spinner } from "./lib/status.js";
import { readConfig, writeConfig } from "./lib/config.js";

process.env.NODE_NO_WARNINGS = "1";

function printBanner() {
  if (!process.stdout.isTTY) return;
  const cyan = "\u001b[36m";
  const dim = "\u001b[2m";
  const reset = "\u001b[0m";
  const lines = [
    `${cyan}╔══════════════════════════════════════════════╗${reset}`,
    `${cyan}║             AGENTBUILDER CLI                 ║${reset}`,
    `${cyan}╚══════════════════════════════════════════════╝${reset}`,
    `${dim}Type prompts to create agents. Commands: /help /list /config /exit.${reset}`
  ];
  process.stdout.write(lines.join("\n") + "\n\n");
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ensureName(name: string | undefined, fallback: string): string {
  const base = name && name.trim() ? name.trim() : fallback;
  const slug = slugify(base);
  if (!slug) throw new Error("Agent name is required.");
  return slug;
}

function escapeShellArg(arg: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

const program = new Command();
program
  .name("agentbuilder")
  .description("Natural-language agent builder (terminal-only)")
  .version("0.1.0")
  .enablePositionalOptions();

const DEFAULT_MODEL = "gpt-5-nano-2025-08-07";

program
  .command("chat")
  .argument("[name]", "agent name (kebab-case)")
  .option("-p, --prompt <text>", "agent description prompt")
  .option("--multiline", "enter a multi-line prompt", false)
  .option("-f, --force", "overwrite existing agent", false)
  .action(async (name, options) => {
    printBanner();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string) =>
      new Promise<string>((resolve) => {
        const cyan = "\u001b[36m";
        const reset = "\u001b[0m";
        process.stdout.write(`${q}\n`);
        rl.question(`${cyan}>${reset} `, (answer) => resolve(answer.trim()));
      });

    const buildOnce = async (prompt: string, nameHint: string) => {
      let spec: AgentSpec;
      const spin = new Spinner("Designing agent");
      let spinnerEnded = false;
      try {
        console.log("Calling model to design the agent...");
        spin.start();
      spec = await buildAgentSpec(prompt, nameHint, DEFAULT_MODEL, {
        onStartStream: () => {
          process.stdout.write("\nGenerating agent spec (streaming)...\n");
        },
        onFirstToken: () => {
          if (!spinnerEnded) {
            spin.succeed("Designed agent (streaming spec)");
            spinnerEnded = true;
          }
        },
        onToken: (delta) => process.stdout.write(delta)
      });
      if (!spinnerEnded) {
        spin.succeed("Designed agent");
      }
      } catch (err) {
        spin.fail("Failed to design agent");
        console.error(String(err));
        return;
      }

    spec.name = ensureName(nameHint, spec.name);
    spec.description = spec.description?.trim() || prompt.trim();
    spec.model = DEFAULT_MODEL;
    spec.dependencies = { openai: "^4.83.0" };
    console.log("\nFinal agent spec (normalized):");
    console.log(JSON.stringify(spec, null, 2));

      let dir: string;
      try {
        dir = writeAgent(spec, options.force);
      } catch (err) {
        console.error(String(err));
        return;
      }

      console.log(`Created agent '${spec.name}' at ${dir}`);
      console.log("Installing dependencies...");
      try {
        buildAgent(dir);
      } catch (err) {
        console.error(String(err));
        return;
      }

      console.log(`Agent ready. Run: ./agentbuilder run ${spec.name}`);
    };

    if (options.prompt || options.multiline) {
      const prompt =
        options.prompt ||
        (options.multiline
          ? await promptMultiline("Describe the agent you want:")
          : await promptLine("Describe the agent you want: "));
      if (!prompt) {
        console.error("No description provided.");
        process.exit(1);
      }
      const nameHint = name || (await promptLine("Agent name (kebab-case): "));
      await buildOnce(prompt, nameHint);
    }

    const printHelp = () => {
      console.log("Commands:");
      console.log("- /help: show this help");
      console.log("- /list: list agents");
      console.log("- /config: set Tavily API key");
      console.log("- /exit: quit");
      console.log("");
    };

    while (true) {
      const prompt = await ask("Describe the agent you want (or /help):");
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "exit" || prompt === "quit") break;
      if (prompt === "/help") {
        printHelp();
        continue;
      }
      if (prompt === "/list") {
        const agents = listAgents();
        if (agents.length === 0) {
          console.log("No agents found.");
        } else {
          for (const agent of agents) {
            console.log(`${agent.name} - ${agent.description}`);
          }
        }
        console.log("");
        continue;
      }
      if (prompt === "/config") {
        const key = await promptSecret("Enter Tavily API key (input hidden):");
        if (!key) {
          console.log("No key provided. Leaving config unchanged.");
        } else {
          const current = readConfig();
          current.tavily_api_key = key;
          writeConfig(current);
          console.log("Saved Tavily API key.");
        }
        console.log("");
        continue;
      }
      const nameHint = await ask("Agent name (kebab-case):");
      if (!nameHint) {
        console.error("Agent name required.");
        continue;
      }
      await buildOnce(prompt, nameHint);
    }

    rl.close();
  });

program
  .command("run")
  .argument("<name>", "agent name")
  .option("--task <text>", "run a single task and exit")
  .option("--terminal", "run in a new terminal window")
  .allowUnknownOption(true)
  .passThroughOptions()
  .action((name, options, command) => {
    const dir = agentDir(name);
    const entry = path.join(dir, "dist", "index.js");
    if (!fs.existsSync(dir)) {
      console.error(`Agent '${name}' not found.`);
      process.exit(1);
    }
    if (!fs.existsSync(entry)) {
      console.log("Agent not built. Building now...");
      try {
        buildAgent(dir);
      } catch (err) {
        console.error(String(err));
        process.exit(1);
      }
    }

    const extraArgs = [];
    if (options.task) {
      extraArgs.push("--task", options.task);
    }
    const cmd = `node ${escapeShellArg(entry)} ${extraArgs.map(escapeShellArg).join(" ")}`.trim();

    if (options.terminal) {
      const opened = launchInNewTerminal(cmd, dir);
      if (!opened) {
        console.log("Could not open a new terminal. Running in background.");
        launchInBackground(cmd, dir);
      }
      return;
    }

    const child = spawn("node", [entry, ...extraArgs], {
      cwd: dir,
      stdio: "inherit",
      env: { ...process.env, NODE_NO_WARNINGS: "1" }
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program
  .command("list")
  .action(() => {
    const agents = listAgents();
    if (agents.length === 0) {
      console.log("No agents found.");
      return;
    }
    for (const agent of agents) {
      console.log(`${agent.name} - ${agent.description}`);
    }
  });

program
  .command("config")
  .description("Configure API keys (stored locally in ~/.agentbuilder/keys.json)")
  .action(async () => {
    printBanner();
    const current = readConfig();
    const key = await promptSecret("Enter Tavily API key (input hidden):");
    if (!key) {
      console.log("No key provided. Leaving config unchanged.");
      return;
    }
    current.tavily_api_key = key;
    writeConfig(current);
    console.log("Saved Tavily API key.");
  });

program.parse();
