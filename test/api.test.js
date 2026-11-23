import { buildServer } from '../src/server.js';
import { requestDispatcher } from '../src/queue.js';

async function runTests() {
  console.log('--- Running API Unit / Smoke Tests ---');
  const app = buildServer();
  await app.ready();

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

  await app.close();
  console.log('\n--- ALL TESTS PASSED SUCCESSFULLY ---');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
