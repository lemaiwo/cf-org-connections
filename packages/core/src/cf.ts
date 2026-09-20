import { spawn } from 'node:child_process';

export interface CfResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunCfOptions {
  /** CF_HOME the command runs against. */
  cfHome: string;
  /** Milliseconds before the command is killed. Defaults to 30s. */
  timeoutMs?: number;
  /**
   * Secrets to strip from captured output before it can reach a log, an API
   * response or the UI. Passcodes are passed here.
   */
  redact?: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Patterns that must never survive into an error message or a log line. */
const TOKEN_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Bare JWTs, with or without the `bearer ` prefix the cf CLI stores.
  {
    pattern: /(?:bearer\s+)?ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gi,
    replacement: '[redacted]',
  },
  // Token fields as they appear in a dumped cf config.json.
  { pattern: /("(?:AccessToken|RefreshToken)"\s*:\s*")[^"]*"/g, replacement: '$1[redacted]"' },
  // A passcode or password echoed back as part of a command line.
  { pattern: /(--sso-passcode[=\s]+)\S+/g, replacement: '$1[redacted]' },
  { pattern: /(--password[=\s]+|\s-p[=\s]+)\S+/g, replacement: '$1[redacted]' },
];

/**
 * Removes tokens, passcodes and any caller-supplied secrets from a string.
 * Everything that leaves this module goes through here first.
 */
export function redactSecrets(text: string, extra: string[] = []): string {
  let out = text;
  for (const secret of extra) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join('[redacted]');
    }
  }
  for (const { pattern, replacement } of TOKEN_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Runs the cf CLI against one CF home directory. The hub never reimplements cf
 * authentication; it only shells out with the right `CF_HOME`.
 */
export function runCf(args: string[], options: RunCfOptions): Promise<CfResult> {
  const { cfHome, timeoutMs = DEFAULT_TIMEOUT_MS, redact = [] } = options;
  return new Promise((resolvePromise) => {
    const child = spawn('cf', args, {
      env: {
        ...process.env,
        CF_HOME: cfHome,
        CF_COLOR: 'false',
        // The cf CLI prompts on stdin for missing values; the hub never wants that.
        CF_DIAL_TIMEOUT: process.env.CF_DIAL_TIMEOUT ?? '10',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const finish = (code: number | null, extraStderr = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout: redactSecrets(stdout, redact),
        stderr: redactSecrets(stderr + extraStderr, redact),
        timedOut,
      });
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      const message =
        error.code === 'ENOENT'
          ? 'The cf CLI was not found on PATH. Install cf CLI v8 or newer.'
          : error.message;
      finish(null, message);
    });
    child.on('close', (code) => finish(code));
  });
}

/** True when the cf CLI is installed and answers `cf version`. */
export async function cfCliAvailable(cfHome: string): Promise<boolean> {
  const result = await runCf(['version'], { cfHome, timeoutMs: 10_000 });
  return result.code === 0;
}

/**
 * Turns a cf result into a single-line, redacted error message.
 */
export function cfErrorMessage(result: CfResult, fallback: string): string {
  if (result.timedOut) return 'The cf command timed out.';
  const text = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^FAILED$/i.test(line));
  const meaningful = text.filter((line) => !/^OK$/i.test(line));
  return meaningful.length > 0 ? meaningful.slice(-3).join(' ') : fallback;
}
