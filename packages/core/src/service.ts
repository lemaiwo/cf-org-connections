import { loadConfig, type HubConfig } from './config.js';
import { Hub } from './hub.js';
import { buildServer } from './server.js';
import type { FastifyInstance } from 'fastify';

export interface StartedService {
  hub: Hub;
  app: FastifyInstance;
  url: string;
  stop: () => Promise<void>;
}

export interface StartServiceOptions {
  config?: HubConfig;
  logger?: boolean;
  /** Skip the keep-alive scheduler and background re-scan (used by tests). */
  schedulers?: boolean;
}

/**
 * Starts the core service. It binds to 127.0.0.1 only: that loopback binding
 * is the security boundary of the whole hub.
 */
export async function startService(options: StartServiceOptions = {}): Promise<StartedService> {
  const config = options.config ?? (await loadConfig());
  const hub = new Hub(config);
  await hub.init();

  const app = await buildServer(hub, { logger: options.logger ?? false });
  await app.listen({ host: '127.0.0.1', port: config.port });

  if (options.schedulers !== false) {
    hub.startSchedulers();
    // Prime the snapshot so the first re-scan only reports real changes.
    await hub.snapshot();
  }

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  return {
    hub,
    app,
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      hub.stopSchedulers();
      await app.close();
    },
  };
}
