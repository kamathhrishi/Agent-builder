import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const content = fs.readFileSync("/proc/version", "utf-8");
    return content.toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function which(cmd: string): boolean {
  const res = spawnSync("which", [cmd], { stdio: "ignore" });
  return res.status === 0;
}

export function launchInNewTerminal(command: string, cwd?: string): boolean {
  const platform = process.platform;

  if (platform === "darwin") {
    const osa = `tell application "Terminal" to do script "${command.replace(/"/g, '\\"')}"`;
    const proc = spawn("osascript", ["-e", osa], { cwd, stdio: "ignore", detached: true });
    proc.unref();
    return true;
  }

  if (platform === "win32") {
    const proc = spawn("cmd.exe", ["/c", "start", "", command], {
      cwd,
      stdio: "ignore",
      detached: true
    });
    proc.unref();
    return true;
  }

  if (isWsl()) {
    const proc = spawn("cmd.exe", ["/c", "start", "", "wsl.exe", "--", "bash", "-lc", command], {
      cwd,
      stdio: "ignore",
      detached: true
    });
    proc.unref();
    return true;
  }

  const linuxTerminals = [
    { cmd: "x-terminal-emulator", args: ["-e"] },
    { cmd: "gnome-terminal", args: ["--", "bash", "-lc"] },
    { cmd: "konsole", args: ["-e"] },
    { cmd: "xterm", args: ["-e"] }
  ];

  for (const t of linuxTerminals) {
    if (!which(t.cmd)) continue;
    const args = t.args.length === 1 ? [t.args[0], command] : [...t.args, command];
    const proc = spawn(t.cmd, args, { cwd, stdio: "ignore", detached: true });
    proc.unref();
    return true;
  }

  return false;
}

export function launchInBackground(command: string, cwd?: string): void {
  const proc = spawn(command, { cwd, stdio: "ignore", shell: true, detached: true });
  proc.unref();
}
