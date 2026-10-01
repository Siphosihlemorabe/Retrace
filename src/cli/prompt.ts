/**
 * Line-at-a-time terminal prompts.
 *
 * Reads lines from its own queue rather than `rl.question`, so the same flow
 * works with piped input (scripted runs, tests) and ends cleanly at EOF
 * instead of throwing.
 */
import { createInterface } from 'node:readline';

export interface Prompter {
  /** A line of input, or null at end of input. */
  line(question: string): Promise<string | null>;
  /** Free text; Enter keeps `prefill` (or gives null when there is none). */
  text(label: string, prefill?: string | null): Promise<string | null>;
  /** One of `keys`, re-asking on anything else. Null at end of input. */
  choose(question: string, keys: readonly string[]): Promise<string | null>;
  close(): void;
}

export function createPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, terminal: process.stdin.isTTY === true });
  const queued: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let closed = false;

  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next !== undefined) next(line);
    else queued.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const resolve of waiting.splice(0)) resolve(null);
  });

  const line = (question: string) => {
    process.stdout.write(question);
    const ready = queued.shift();
    if (ready !== undefined) {
      if (process.stdin.isTTY !== true) process.stdout.write(`${ready}\n`);
      return Promise.resolve<string | null>(ready);
    }
    if (closed) return Promise.resolve<string | null>(null);
    return new Promise<string | null>((resolve) =>
      waiting.push((l) => {
        if (l !== null && process.stdin.isTTY !== true) process.stdout.write(`${l}\n`);
        resolve(l);
      }),
    );
  };

  return {
    line,
    async text(label, prefill = null) {
      const hint = prefill === null ? '' : ` [${prefill}]`;
      const answer = await line(`  ${label.padEnd(10)}${hint} > `);
      if (answer === null) return prefill;
      const trimmed = answer.trim();
      return trimmed === '' ? prefill : trimmed;
    },
    async choose(question, keys) {
      for (;;) {
        const answer = await line(question);
        if (answer === null) return null;
        const key = answer.trim().toLowerCase();
        if (keys.includes(key)) return key;
        process.stdout.write(`  Please answer one of: ${keys.join(', ')}\n`);
      }
    },
    close: () => rl.close(),
  };
}
