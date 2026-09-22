import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Hub, HubError } from './hub.js';
import { resolveWebRoot } from './web-root.js';
import type { HubEvent } from './types.js';

/**
 * Static assets are served from a fixed allowlist rather than by joining a
 * request path onto a directory, so there is no path to traverse.
 */
const STATIC_FILES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/styles.css': 'styles.css',
  '/favicon.svg': 'favicon.svg',
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export interface BuildServerOptions {
  /** Fastify request logging. Off by default: the hub keeps quiet. */
  logger?: boolean;
}

export async function buildServer(hub: Hub, options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const webRoot = resolveWebRoot();

  // Several endpoints (verify, logout, login/start) take no body at all, and
  // clients still send `content-type: application/json`. Treat an empty body
  // as `{}` instead of rejecting the request.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const text = typeof body === 'string' ? body.trim() : '';
      if (text === '') return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch {
        const error = new HubError('Request body is not valid JSON.', 400);
        done(error, undefined);
      }
    },
  );

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof HubError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    const fastifyError = error as { statusCode?: number; message?: string };
    const statusCode =
      typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;
    return reply.status(statusCode).send({ error: fastifyError.message || 'Internal error' });
  });

  app.get('/api/health', async () => ({
    ok: true,
    root: hub.config.root,
    port: hub.config.port,
    keepAliveIntervalMs: hub.config.keepAliveIntervalMs,
  }));

  app.get('/api/entries', async () => ({ entries: await hub.listEntries() }));

  app.get('/api/entries/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { entry: await hub.requireEntry(id) };
  });

  app.post('/api/entries', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const entry = await hub.createEntry({
      name: String(body.name ?? ''),
      api: String(body.api ?? ''),
      label: body.label === undefined ? undefined : String(body.label),
      org: body.org === undefined ? undefined : String(body.org),
      space: body.space === undefined ? undefined : String(body.space),
      keepAlive: body.keepAlive === undefined ? undefined : body.keepAlive === true,
    });
    return reply.status(201).send({ entry });
  });

  app.patch('/api/entries/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    return { entry: await hub.updateEntry(id, body) };
  });

  app.post('/api/entries/:id/login/start', async (request) => {
    const { id } = request.params as { id: string };
    const result = await hub.startLogin(id);
    return {
      entry: result.entry,
      state: 'waiting_passcode',
      passcodeUrl: result.passcodeUrl,
      browserOpened: result.browserOpened,
      browserError: result.browserError,
    };
  });

  app.post('/api/entries/:id/login/complete', async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    return { entry: await hub.completeLogin(id, body.passcode) };
  });

  app.post('/api/entries/:id/verify', async (request) => {
    const { id } = request.params as { id: string };
    const result = await hub.verify(id);
    return { ok: result.ok, entry: result.entry, error: result.error ?? null };
  });

  app.post('/api/entries/:id/logout', async (request) => {
    const { id } = request.params as { id: string };
    return { entry: await hub.logout(id) };
  });

  app.get('/api/entries/:id/orgs', async (request) => {
    const { id } = request.params as { id: string };
    return { orgs: await hub.listOrgs(id) };
  });

  app.get('/api/entries/:id/spaces', async (request) => {
    const { id } = request.params as { id: string };
    const { org } = request.query as { org?: string };
    return { spaces: await hub.listSpaces(id, org ?? '') };
  });

  app.post('/api/entries/:id/target', async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const space = body.space === undefined || body.space === null ? null : String(body.space);
    return { entry: await hub.setTarget(id, { org: String(body.org ?? ''), space }) };
  });

  app.get('/api/entries/:id/handoff', async (request) => {
    const { id } = request.params as { id: string };
    return await hub.handoff(id);
  });

  app.get('/api/events', async (request, reply) => {
    await sendEventStream(hub, request, reply);
  });

  if (webRoot) {
    for (const [route, file] of Object.entries(STATIC_FILES)) {
      app.get(route, async (_request, reply) => {
        try {
          const body = await readFile(resolve(webRoot, file));
          return reply
            .header('content-type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream')
            .header('cache-control', 'no-cache')
            .send(body);
        } catch {
          return reply.status(404).send({ error: `Not found: ${file}` });
        }
      });
    }
  }

  return app;
}

/** Server-sent events: a snapshot on connect, then every status change. */
async function sendEventStream(hub: Hub, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  const write = (event: HubEvent): void => {
    raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const unsubscribe = hub.events.subscribe(write);
  const heartbeat = setInterval(() => raw.write(': keep-alive\n\n'), 25_000);
  heartbeat.unref();

  const close = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.raw.on('close', close);
  raw.on('error', close);

  write({ type: 'entries', entries: await hub.snapshot() });
}
