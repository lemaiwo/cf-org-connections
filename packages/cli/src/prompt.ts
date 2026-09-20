import { createInterface } from 'node:readline/promises';

/**
 * Reads one line from the terminal. Used for the passcode paste; the value is
 * sent straight to the core service and never written to a file or a log.
 */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}
