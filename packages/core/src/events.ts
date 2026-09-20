import { EventEmitter } from 'node:events';
import type { HubEvent } from './types.js';

/**
 * Fan-out of status changes to every connected dashboard and CLI. Payloads are
 * plain entries, which by construction carry no tokens.
 */
export class EventBus {
  readonly #emitter = new EventEmitter();

  constructor() {
    // Dashboards, CLIs and tests can all listen at once.
    this.#emitter.setMaxListeners(0);
  }

  publish(event: HubEvent): void {
    this.#emitter.emit('event', event);
  }

  /** Subscribes a listener; returns the unsubscribe function. */
  subscribe(listener: (event: HubEvent) => void): () => void {
    this.#emitter.on('event', listener);
    return () => this.#emitter.off('event', listener);
  }
}
