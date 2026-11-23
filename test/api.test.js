import { buildServer, DEFAULT_MODEL, DEFAULT_THINKING_LEVEL } from '../src/server.js';
import { requestDispatcher } from '../src/queue.js';
import { getModelRegex, getThinkingLevelRegex } from '../src/browser.js';

async function runTests() {
  console.log('--- Running API Unit / Smoke Tests ---');
  const app = buildServer();
  await app.ready();

  // Test 0: Defaults verification
  if (DEFAULT_MODEL !== 'gemini-4-neon') {
    throw new Error(`Expected DEFAULT_MODEL to be 'gemini-4-neon', got '${DEFAULT_MODEL}'`);
  }
  if (DEFAULT_THINKING_LEVEL !== 'high') {
    throw new Error(`Expected DEFAULT_THINKING_LEVEL to be 'high', got '${DEFAULT_THINKING_LEVEL}'`);
  }
  console.log('✓ Test 0: DEFAULT_MODEL and DEFAULT_THINKING_LEVEL constants verified');

  // Test 1: GET /health
  const healthRes = await app.inject({ method: 'GET', url: '/health' });
  if (healthRes.statusCode !== 200) {
    throw new Error(`Expected /health status 200, got ${healthRes.statusCode}`);
  }
  const healthBody = JSON.parse(healthRes.body);
  if (healthBody.status !== 'ok') {
    throw new Error('Health check status is not ok');
  }
  console.log('✓ Test 1: GET /health returned 200 OK');

  // Test 2: Validation of empty payload
  const badReq = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { messages: [] }
  });
  if (badReq.statusCode !== 400) {
    throw new Error(`Expected 400 for empty messages, got ${badReq.statusCode}`);
  }
  console.log('✓ Test 2: Empty messages returned 400 Bad Request');

  // Test 3: Session expired (401)
  requestDispatcher.isPausedForAuth = true;
  const authRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: {
      messages: [{ role: 'user', content: 'test message' }]
    }
  });
  if (authRes.statusCode !== 401) {
    throw new Error(`Expected 401 for expired session, got ${authRes.statusCode}`);
  }
  const authBody = JSON.parse(authRes.body);
  if (authBody.error !== 'Session expired. Manual authentication required.') {
    throw new Error(`Unexpected error message: ${authBody.error}`);
  }
  console.log('✓ Test 3: Expired session returned 401 Unauthorized with correct message');
  requestDispatcher.resume();

  // Test 4: Queue full (429)
  const originalLimit = requestDispatcher.maxQueueSize;
  requestDispatcher.maxQueueSize = 0; // force queue full
  const qFullRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: {
      messages: [{ role: 'user', content: 'test queue full' }]
    }
  });
  if (qFullRes.statusCode !== 429) {
    throw new Error(`Expected 429 for queue full, got ${qFullRes.statusCode}`);
  }
  const qFullBody = JSON.parse(qFullRes.body);
  if (qFullBody.error !== 'Queue is full') {
    throw new Error(`Unexpected error message: ${qFullBody.error}`);
  }
  console.log('✓ Test 4: Full queue returned 429 Too Many Requests with {"error": "Queue is full"}');
  requestDispatcher.maxQueueSize = originalLimit;

  // Test 5: Default model & thinking_level parameters forwarded to enqueue
  const originalEnqueue = requestDispatcher.enqueue;
  let capturedPayload = null;
  requestDispatcher.enqueue = async (params) => {
    capturedPayload = params;
    return 'Mock assistant response';
  };

  const defaultParamsRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: {
      messages: [{ role: 'user', content: 'Hello Gemini' }]
    }
  });

  if (defaultParamsRes.statusCode !== 200) {
    throw new Error(`Expected 200, got ${defaultParamsRes.statusCode}: ${defaultParamsRes.body}`);
  }
  if (!capturedPayload) {
    throw new Error('requestDispatcher.enqueue was not called');
  }
  if (capturedPayload.model !== 'gemini-4-neon') {
    throw new Error(`Expected default model 'gemini-4-neon', got '${capturedPayload.model}'`);
  }
  if (capturedPayload.thinkingLevel !== 'high') {
    throw new Error(`Expected default thinkingLevel 'high', got '${capturedPayload.thinkingLevel}'`);
  }
  const defaultBody = JSON.parse(defaultParamsRes.body);
  if (defaultBody.model !== 'gemini-4-neon') {
    throw new Error(`Expected response model 'gemini-4-neon', got '${defaultBody.model}'`);
  }
  if (!defaultBody.choices || defaultBody.choices[0]?.message?.content !== 'Mock assistant response') {
    throw new Error(`Unexpected choices in response: ${JSON.stringify(defaultBody)}`);
  }
  console.log('✓ Test 5: Default model ("gemini-4-neon") and thinking_level ("high") successfully applied');

  // Test 6: Explicit model & thinking_level parameters
  capturedPayload = null;
  const explicitRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: {
      messages: [{ role: 'user', content: 'Текст запроса...' }],
      action: 'new',
      chat_id: 'dialog_1',
      model: 'gemini-4-neon',
      thinking_level: 'high'
    }
  });

  if (explicitRes.statusCode !== 200) {
    throw new Error(`Expected 200, got ${explicitRes.statusCode}: ${explicitRes.body}`);
  }
  if (capturedPayload.action !== 'new') {
    throw new Error(`Expected action 'new', got '${capturedPayload.action}'`);
  }
  if (capturedPayload.chatId !== 'dialog_1') {
    throw new Error(`Expected chatId 'dialog_1', got '${capturedPayload.chatId}'`);
  }
  if (capturedPayload.model !== 'gemini-4-neon') {
    throw new Error(`Expected model 'gemini-4-neon', got '${capturedPayload.model}'`);
  }
  if (capturedPayload.thinkingLevel !== 'high') {
    throw new Error(`Expected thinkingLevel 'high', got '${capturedPayload.thinkingLevel}'`);
  }
  console.log('✓ Test 6: Explicit model, thinking_level, action, and chat_id handled correctly');

  // Test 7: Custom model and thinking_level (e.g., hydrogen + minimal / low / medium / xhigh)
  capturedPayload = null;
  const customRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: {
      messages: [{ role: 'user', content: 'Solve fast' }],
      model: 'gemini-4-hydrogen',
      thinking_level: 'minimal'
    }
  });

  if (customRes.statusCode !== 200) {
    throw new Error(`Expected 200, got ${customRes.statusCode}: ${customRes.body}`);
  }
  if (capturedPayload.model !== 'gemini-4-hydrogen') {
    throw new Error(`Expected model 'gemini-4-hydrogen', got '${capturedPayload.model}'`);
  }
  if (capturedPayload.thinkingLevel !== 'minimal') {
    throw new Error(`Expected thinkingLevel 'minimal', got '${capturedPayload.thinkingLevel}'`);
  }
  console.log('✓ Test 7: Custom model ("gemini-4-hydrogen") and thinking_level ("minimal") passed correctly');

  // Test 8: Unit test for model and thinking level regex helpers
  const neonMatch = getModelRegex('gemini-4-neon');
  if (!neonMatch.regex.test('Deeper analysis 4 Neon') || !neonMatch.regex.test('Neon High') || !neonMatch.regex.test('gemini-4-neon')) {
    throw new Error('getModelRegex failed to match Neon');
  }

  const hydrogenMatch = getModelRegex('gemini-4-hydrogen');
  if (!hydrogenMatch.regex.test('Everyday help 4 Hydrogen') || !hydrogenMatch.regex.test('Hydrogen Low')) {
    throw new Error('getModelRegex failed to match Hydrogen');
  }

  const thinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  for (const level of thinkingLevels) {
    const reg = getThinkingLevelRegex(level);
    if (!reg.test(level) || !reg.test(`Level: ${level} thorough`)) {
      throw new Error(`getThinkingLevelRegex failed for level: ${level}`);
    }
  }
  // Localized strings
  if (!getThinkingLevelRegex('high').test('Высокий уровень') || !getThinkingLevelRegex('low').test('Низкий уровень')) {
    throw new Error('getThinkingLevelRegex failed for localized strings');
  }
  console.log('✓ Test 8: Model and thinking level regex matching helpers verified for all levels and locales');

  // Restore enqueue
  requestDispatcher.enqueue = originalEnqueue;

  await app.close();
  console.log('\n--- ALL TESTS PASSED SUCCESSFULLY ---');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
