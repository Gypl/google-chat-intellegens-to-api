import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { config, DEFAULT_MODEL, DEFAULT_THINKING_LEVEL, resolveApiKey } from './config.js';
import { browserWorker } from './browser.js';
import { requestDispatcher } from './queue.js';
import { GithubImportError, QueueFullError, SessionExpiredError } from './errors.js';
import { normalizeAssistantResult, parseGithubRepoUrl } from './parser.js';

export { DEFAULT_MODEL, DEFAULT_THINKING_LEVEL };

const INVALID_API_KEY_RESPONSE = {
  error: {
    message: 'Incorrect API key provided. You can find your API key in the environment variables.',
    type: 'invalid_request_error',
    code: 'invalid_api_key'
  }
};

/**
 * Constant-time Bearer token comparison using SHA-256 digests so lengths are never leaked.
 */
export function verifyBearerToken(authHeader, expectedApiKey) {
  if (typeof authHeader !== 'string' || typeof expectedApiKey !== 'string' || !expectedApiKey) {
    return false;
  }

  const match = /^Bearer[ \t]+(.+)$/i.exec(authHeader);
  if (!match) {
    return false;
  }

  const providedToken = match[1].trim();
  if (!providedToken) {
    return false;
  }

  const providedDigest = crypto.createHash('sha256').update(providedToken, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expectedApiKey, 'utf8').digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

export function buildServer(options = {}) {
  const fastify = Fastify({
    logger: {
      level: config.logLevel
    }
  });

  // Global OpenAPI Bearer Authentication Hook (runs before validation and queue)
  fastify.addHook('onRequest', async (request, reply) => {
    const expectedApiKey = options.apiKey ?? config.apiKey;
    const authHeader = request.headers.authorization;

    if (!verifyBearerToken(authHeader, expectedApiKey)) {
      return reply.status(401).send(INVALID_API_KEY_RESPONSE);
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

    if (error instanceof GithubImportError || error.statusCode === 422) {
      request.log.warn(error);
      return reply.status(422).send({
        error: {
          message: 'Failed to attach GitHub repository. Ensure the repository is public and the URL is correct.',
          code: error.code || 'github_import_failed'
        }
      });
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
            chat_id: { type: 'string' },
            model: { type: 'string' },
            thinking_level: { type: 'string' },
            github_repo: { type: 'string' }
          }
        }
      }
    },
    async (request, reply) => {
      const {
        messages,
        action = 'continue',
        chat_id,
        model = config.defaultModel,
        thinking_level = config.defaultThinkingLevel,
        github_repo
      } = request.body;

      // Validate optional github_repo URL before entering the browser queue
      let validatedGithubRepo = null;
      if (github_repo !== undefined) {
        const parsedRepo = parseGithubRepoUrl(github_repo);
        if (!parsedRepo) {
          return reply.status(400).send({
            error: 'Invalid github_repo URL. Expected a valid public GitHub repository URL starting with https://github.com/.'
          });
        }
        validatedGithubRepo = parsedRepo.url;
      }

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

      const targetModel = (typeof model === 'string' && model.trim()) || config.defaultModel;
      const targetThinkingLevel =
        (typeof thinking_level === 'string' && thinking_level.trim()) || config.defaultThinkingLevel;

      // Schedule task via FIFO Queue Dispatcher
      const rawResult = await requestDispatcher.enqueue({
        prompt,
        action,
        chatId: chat_id,
        model: targetModel,
        thinkingLevel: targetThinkingLevel,
        githubRepo: validatedGithubRepo
      });

      const { content, code_blocks } = normalizeAssistantResult(rawResult);

      // OpenAI-compatible response format with extracted code_blocks
      return {
        model: targetModel,
        choices: [
          {
            message: {
              role: 'assistant',
              content,
              code_blocks
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
    // 0. Ensure API key is configured for current environment
    config.apiKey = resolveApiKey(process.env);

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

