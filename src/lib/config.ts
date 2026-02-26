import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type KeyConfig = {
  tavily_api_key?: string;
};

function baseDir(): string {
  return path.join(os.homedir(), ".agentbuilder");
}

export function configPath(): string {
  return path.join(baseDir(), "keys.json");
}

export function readConfig(): KeyConfig {
  const p = configPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as KeyConfig;
  } catch {
    return {};
  }
}

export function writeConfig(next: KeyConfig): void {
  const dir = baseDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // ignore
  }
}
