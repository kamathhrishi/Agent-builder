import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

export async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    const cyan = "\u001b[36m";
    const reset = "\u001b[0m";
    output.write(`${question}\n`);
    const prompt = `${cyan}>${reset} `;
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function promptSecret(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    const cyan = "\u001b[36m";
    const reset = "\u001b[0m";
    output.write(`${question}\n`);
    const prompt = `${cyan}>${reset} `;
    (rl as any).stdoutMuted = true;
    const origWrite = (rl as any)._writeToOutput.bind(rl as any);
    (rl as any)._writeToOutput = (stringToWrite: string) => {
      if ((rl as any).stdoutMuted) return;
      origWrite(stringToWrite);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function promptMultiline(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  const lines: string[] = [];
  output.write(`${question}\n`);
  output.write("Enter empty line to finish.\n");
  return new Promise((resolve) => {
    rl.on("line", (line) => {
      if (line.trim() === "") {
        rl.close();
        resolve(lines.join("\n").trim());
        return;
      }
      lines.push(line);
    });
  });
}
