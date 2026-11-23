import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

export const DEFAULT_MODEL = 'gemini-4-neon';
export const DEFAULT_THINKING_LEVEL = 'high';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  logLevel: process.env.LOG_LEVEL || 'info',

  // Model & Thinking Level Defaults
  defaultModel: process.env.DEFAULT_MODEL || DEFAULT_MODEL,
  defaultThinkingLevel: process.env.DEFAULT_THINKING_LEVEL || DEFAULT_THINKING_LEVEL,

  // Authentication & Gemini Web URLs
  authStatePath: path.resolve(process.cwd(), process.env.AUTH_STATE_PATH || 'auth_state.json'),
  geminiUrl: process.env.GEMINI_URL || 'https://gemini.google.com/app',

  // Browser Execution Options
  headless: process.env.HEADLESS !== 'false',
  maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE || '50', 10),
  generationTimeoutMs: parseInt(process.env.GENERATION_TIMEOUT_MS || '180000', 10),
  waitStopButtonTimeoutMs: parseInt(process.env.WAIT_STOP_BUTTON_TIMEOUT_MS || '15000', 10),

  // Optimized Chromium flags for low-memory VPS environments (<= 2GB RAM)
  chromiumArgs: [
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-zygote',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--disable-extensions',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
    '--disable-ipc-flooding-protection',
    '--disable-renderer-backgrounding',
    '--disable-search-engine-choice-screen',
    '--memory-pressure-off'
  ]
};
