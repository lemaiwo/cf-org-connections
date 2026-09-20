#!/usr/bin/env node
import { loadConfig } from '../config.js';
import { startService } from '../service.js';

/**
 * Entry point of the core service. Prints where the dashboard lives and then
 * stays up until it is stopped.
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  try {
    const service = await startService({ config });
    process.stdout.write(
      [
        `CF Session Hub listening on ${service.url}`,
        `  CF home root:        ${config.root}`,
        `  Keep-alive interval: ${Math.round(config.keepAliveIntervalMs / 1000)}s`,
        '',
      ].join('\n'),
    );

    const shutdown = (): void => {
      void service.stop().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `Port ${config.port} is already in use. Another CF Session Hub is probably running.\n`,
      );
      process.exit(2);
    }
    process.stderr.write(`Failed to start CF Session Hub: ${err.message}\n`);
    process.exit(1);
  }
}

void main();
