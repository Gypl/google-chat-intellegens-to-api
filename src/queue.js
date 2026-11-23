import PQueue from 'p-queue';
import { config } from './config.js';
import { QueueFullError, SessionExpiredError } from './errors.js';
import { browserWorker } from './browser.js';

export class RequestDispatcher {
  constructor() {
    this.queue = new PQueue({ concurrency: 1 });
    this.maxQueueSize = config.maxQueueSize; // 50
    this.isPausedForAuth = false;
  }

  /**
   * Returns current queue diagnostics.
   */
  get stats() {
    return {
      waiting: this.queue.size,
      running: this.queue.pending,
      maxQueueSize: this.maxQueueSize,
      isPausedForAuth: this.isPausedForAuth
    };
  }

  /**
   * Enqueues a prompt request to the FIFO queue.
   * Throws QueueFullError (HTTP 429) if queue waiting count >= 50.
   */
  async enqueue({
    prompt,
    action = 'continue',
    chatId = null,
    model = config.defaultModel,
    thinkingLevel = config.defaultThinkingLevel
  }) {
    // If paused due to expired session, reject immediately with 401
    if (this.isPausedForAuth) {
      throw new SessionExpiredError();
    }

    // Strict FIFO queue limit check: if 50 waiting, instantly reject with 429
    if (this.queue.size >= this.maxQueueSize) {
      throw new QueueFullError('Queue is full');
    }

    // Schedule task in strict FIFO order
    return this.queue.add(async () => {
      try {
        const result = await browserWorker.sendMessage(prompt, action, chatId, {
          model,
          thinkingLevel
        });
        return result;
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          console.error('[RequestDispatcher] Session expired during request. Pausing and clearing queue.');
          this.isPausedForAuth = true;
          this.queue.clear();
        }
        throw err;
      }
    });
  }

  /**
   * Resumes queue once new authentication is provided.
   */
  resume() {
    this.isPausedForAuth = false;
  }
}

export const requestDispatcher = new RequestDispatcher();
