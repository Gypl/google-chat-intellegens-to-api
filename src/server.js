import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { config } from './config.js';
import { browserWorker } from './browser.js';
import { requestDispatcher } from './queue.js';
import { QueueFullError, SessionExpiredError } from './errors.js';

export function buildServer() {
  const fastify = Fastify({
    logger: {
      level: config.logLevel
    }
  });

  // Custom Error Handler
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof QueueFullError || error.statusCode === 429) {
      return reply.status(429).send({ error: 'Queue is full' });
    }

    if (error instanceof SessionExpiredError || error.statusCode === 401) {
      return reply.status(401).send({ error: 'Session expired. Manual authentication required.' });
    }

    if (error.validation) {
      return reply.status(400).send({
        error: 'Invalid request payload',
        details: error.message
      });
    }

    request.log.error(error);
    return reply.status(error.statusCode || 500).send({
      error: error.message || 'Internal server error'
    });
  });

  /**
   * Health check & diagnostics endpoint
   */
  fastify.get('/health', async () => {
    const mem = process.memoryUsage();
    return {
      status: 'ok',
      sessionExpired: browserWorker.sessionExpired,
      isInitialized: browserWorker.isInitialized,
      queue: requestDispatcher.stats,
      memory: {
        rssMb: Math.round(mem.rss / (1024 * 1024)),
        heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
        heapTotalMb: Math.round(mem.heapTotal / (1024 * 1024))
      }
    };
  });

  /**
   * Endpoint to reload authentication state without restarting server
   */
  fastify.post('/v1/auth/reload', async (request, reply) => {
    try {
      await browserWorker.reloadAuth();
      requestDispatcher.resume();
      return {
        status: 'ok',
        message: 'Authentication state reloaded successfully',
        sessionExpired: browserWorker.sessionExpired
      };
    } catch (err) {
      return reply.status(500).send({
        error: `Failed to reload auth: ${err.message}`
      });
    }
  });

  /**
   * OpenAI-compatible Chat Completions endpoint
   * POST /v1/chat/completions
   */
  fastify.post(
    '/v1/chat/completions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['messages'],
          properties: {
            messages: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['role', 'content'],
                properties: {
                  role: { type: 'string' },
                  content: { type: 'string' }
                }
              }
            },
            action: {
              type: 'string',
              enum: ['new', 'continue']
            },
            chat_id: { type: 'string' }
          }
        }
      }
    },
    async (request, reply) => {
      const { messages, action = 'continue', chat_id } = request.body;

      // Extract the latest user message
      const userMessages = messages.filter((m) => m.role === 'user');
      if (userMessages.length === 0) {
        return reply.status(400).send({
          error: 'No message with role "user" found in messages array.'
        });
      }

      const lastUserMessage = userMessages[userMessages.length - 1];
      const prompt = (lastUserMessage.content || '').trim();

      if (!prompt) {
        return reply.status(400).send({
          error: 'User message content cannot be empty.'
        });
      }

      // Schedule task via FIFO Queue Dispatcher
      const assistantContent = await requestDispatcher.enqueue({
        prompt,
        action,
        chatId: chat_id
      });

      // OpenAI-compatible response format
      return {
        choices: [
          {
            message: {
              role: 'assistant',
              content: assistantContent
            }
          }
        ]
      };
    }
  );

  return fastify;
}

export const server = buildServer();

/**
 * Start Server & Browser Worker
 */
export async function start() {
  try {
    // 1. Initialize browser worker
    console.info('[Server] Starting Gemini Browser Worker...');
    await browserWorker.init().catch((err) => {
      console.warn(`[Server] Initial browser launch notice: ${err.message}`);
    });

    // 2. Start Fastify listening
    await server.listen({
      port: config.port,
      host: config.host
    });

    console.info(`[Server] Gemini Web-to-API wrapper is listening on http://${config.host}:${config.port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */
export async function shutdown(signal) {
  console.info(`[Server] Received ${signal}. Gracefully shutting down...`);
  try {
    await server.close();
    await browserWorker.close();
    console.info('[Server] Shutdown complete.');
    process.exit(0);
  } catch (err) {
    console.error('[Server] Error during shutdown:', err);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  start();
}

