export class Spinner {
  private interval: NodeJS.Timeout | null = null;
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private index = 0;
  private active = false;

  constructor(private label: string) {}

  start() {
    if (!process.stdout.isTTY) return;
    if (this.active) return;
    this.active = true;
    process.stdout.write(`\r${this.frames[this.index]} ${this.label}`);
    this.interval = setInterval(() => {
      this.index = (this.index + 1) % this.frames.length;
      process.stdout.write(`\r${this.frames[this.index]} ${this.label}`);
    }, 80);
  }

  succeed(message?: string) {
    this.stop();
    const line = message || this.label;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r✔ ${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  fail(message?: string) {
    this.stop();
    const line = message || this.label;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r✖ ${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  private stop() {
    if (!this.active) return;
    this.active = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }
}
