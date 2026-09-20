import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Opens a URL in the user's default browser. This is the step Claude Code
 * cannot do, so the hub does it server-side: the user authenticates with their
 * passkey in a real browser window.
 *
 * Returns an error message when the platform has no opener or the opener could
 * not be started; the caller falls back to showing the URL.
 */
export function openInBrowser(url: string): Promise<string | null> {
  const parsed = safeUrl(url);
  if (!parsed) return Promise.resolve(`Refusing to open a non-http(s) URL.`);

  const os = platform();
  const command = os === 'darwin' ? 'open' : os === 'linux' ? 'xdg-open' : null;
  if (!command) {
    return Promise.resolve(`Opening a browser is not supported on ${os}. Open the URL manually.`);
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const child = spawn(command, [parsed.toString()], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      done(
        error.code === 'ENOENT'
          ? `No browser opener found (${command} is not installed). Open the URL manually.`
          : `Could not open a browser: ${error.message}`,
      );
    });
    child.on('spawn', () => {
      child.unref();
      // xdg-open exits immediately; success is "the opener started".
      done(null);
    });
  });
}

/** Accepts only absolute http(s) URLs. */
export function safeUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}
