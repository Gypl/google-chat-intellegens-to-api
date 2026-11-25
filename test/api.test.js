import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright';
import { config, DEFAULT_API_KEY, resolveApiKey } from '../src/config.js';
import { BrowserWorkerError, GithubImportError } from '../src/errors.js';
import { buildServer, DEFAULT_MODEL, DEFAULT_THINKING_LEVEL, verifyBearerToken } from '../src/server.js';
import { requestDispatcher } from '../src/queue.js';
import { browserWorker, GeminiBrowserWorker, getModelRegex, getThinkingLevelRegex } from '../src/browser.js';
import {
  cleanCodeText,
  extractCodeBlocksFromMarkdown,
  extractResponseFromElement,
  normalizeAssistantResult,
  normalizeLanguageLabel,
  parseGithubRepoUrl
} from '../src/parser.js';

async function runTests() {
  console.log('--- Running API Unit / Smoke Tests ---');
  const app = buildServer();
  await app.ready();

  const authHeaders = {
    authorization: `Bearer ${config.apiKey}`
  };

  // Test 0: Defaults verification
  if (DEFAULT_MODEL !== 'gemini-4-neon') {
    throw new Error(`Expected DEFAULT_MODEL to be 'gemini-4-neon', got '${DEFAULT_MODEL}'`);
  }
  if (DEFAULT_THINKING_LEVEL !== 'high') {
    throw new Error(`Expected DEFAULT_THINKING_LEVEL to be 'high', got '${DEFAULT_THINKING_LEVEL}'`);
  }
  assert.equal(DEFAULT_API_KEY, 'sk-custom-secret-key');
  console.log('✓ Test 0: DEFAULT_MODEL, DEFAULT_THINKING_LEVEL, and DEFAULT_API_KEY constants verified');

  // Test 1: GET /health (authorized)
  const healthRes = await app.inject({
    method: 'GET',
    url: '/health',
    headers: authHeaders
  });
  if (healthRes.statusCode !== 200) {
    throw new Error(`Expected /health status 200, got ${healthRes.statusCode}`);
  }
  const healthBody = JSON.parse(healthRes.body);
  if (healthBody.status !== 'ok') {
    throw new Error('Health check status is not ok');
  }
  console.log('✓ Test 1: GET /health returned 200 OK');

  // Test 2: Validation of empty payload (authorized)
  const badReq = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: authHeaders,
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
    headers: authHeaders,
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
    headers: authHeaders,
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
    headers: authHeaders,
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
  assert.deepEqual(defaultBody.choices[0].message.code_blocks, []);
  console.log('✓ Test 5: Default model ("gemini-4-neon") and thinking_level ("high") successfully applied');

  // Test 6: Explicit model & thinking_level parameters
  capturedPayload = null;
  const explicitRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: authHeaders,
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
    headers: authHeaders,
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

  // Test 9: API code_blocks response formatting (structured object & markdown string fallback)
  requestDispatcher.enqueue = async () => ({
    content: "Вот примеры кода:\n\n```javascript\nconsole.log('Hello world');\n```\n\n```python\nprint('Hello world')\n```",
    code_blocks: [
      { language: 'javascript', code: "console.log('Hello world');" },
      { language: 'python', code: "print('Hello world')" }
    ]
  });

  const codeApiRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: authHeaders,
    payload: {
      messages: [{ role: 'user', content: 'Show JS and Python examples' }]
    }
  });
  assert.equal(codeApiRes.statusCode, 200);
  const codeApiBody = JSON.parse(codeApiRes.body);
  assert.equal(codeApiBody.choices[0].message.role, 'assistant');
  assert.deepEqual(codeApiBody.choices[0].message.code_blocks, [
    { language: 'javascript', code: "console.log('Hello world');" },
    { language: 'python', code: "print('Hello world')" }
  ]);

  // String fallback containing fenced markdown blocks with $$ and $&
  requestDispatcher.enqueue = async () => 'Text before\n\n```bash\necho $$ && echo $&\n```\n\n```unknown_lang\nfoo\n```';
  const mdApiRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: authHeaders,
    payload: {
      messages: [{ role: 'user', content: 'Markdown string fallback' }]
    }
  });
  assert.equal(mdApiRes.statusCode, 200);
  const mdApiBody = JSON.parse(mdApiRes.body);
  assert.deepEqual(mdApiBody.choices[0].message.code_blocks, [
    { language: 'bash', code: 'echo $$ && echo $&' },
    { language: 'unknown_lang', code: 'foo' }
  ]);
  console.log('✓ Test 9: API /v1/chat/completions includes structured code_blocks and handles empty/fallback cases');

  // Test 10: Parser unit helpers
  assert.equal(cleanCodeText('\r\n  const a = 1;\r\n  const b = 2;\r\n\r\n'), '  const a = 1;\n  const b = 2;');
  assert.equal(normalizeLanguageLabel('Python'), 'python');
  assert.equal(normalizeLanguageLabel('C++'), 'c++');
  assert.equal(normalizeLanguageLabel('Code'), null);
  assert.equal(normalizeLanguageLabel('Copy code'), null);
  assert.equal(normalizeLanguageLabel('Код'), null);
  assert.equal(normalizeLanguageLabel('Use code with caution.'), null);
  assert.deepEqual(
    extractCodeBlocksFromMarkdown('Intro\n\n```\nplain block\n```\n\n````ts\nconst backticks = "```";\n````'),
    [
      { language: 'unknown', code: 'plain block' },
      { language: 'ts', code: 'const backticks = "```";' }
    ]
  );
  assert.deepEqual(normalizeAssistantResult({ content: 'No code here', code_blocks: [] }), {
    content: 'No code here',
    code_blocks: []
  });
  console.log('✓ Test 10: Parser unit helpers (cleanCodeText, normalizeLanguageLabel, markdown fallback) verified');

  // Test 11 & 12: Real Playwright Chromium DOM & Copy-button clipboard extraction tests
  const browser = await chromium.launch({
    headless: true,
    args: config.chromiumArgs
  });

  try {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();

    // Test 11A: Gemini <code-block>, nested wrappers, language detection, line numbers, special $&/$$, thoughts filtering
    await page.setContent(`
      <model-response>
        <model-thoughts>
          <div class="markdown">
            <pre><code class="language-python">print('internal thought should be ignored')</code></pre>
          </div>
        </model-thoughts>
        <message-content>
          <div class="markdown">
            <p>Используйте <code>npm install</code> для установки.</p>
            <code-block>
              <div class="code-block">
                <div class="code-block-decoration">
                  <span>JavaScript</span>
                  <div class="buttons">
                    <button aria-label="Copy code">Copy code</button>
                  </div>
                </div>
                <pre><code class="language-javascript">console.log('Hello world');
const pattern = '$$ and $&';</code></pre>
                <div class="code-block-footer">Use code with caution.</div>
              </div>
            </code-block>
            <code-block>
              <div class="code-block">
                <div class="code-block-decoration">
                  <span>Python</span>
                  <button aria-label="Копировать код">Копировать код</button>
                </div>
                <pre><code class="code-container">print('Hello world')</code></pre>
              </div>
            </code-block>
            <div class="snippet">
              <div class="snippet-header">Код</div>
              <div class="line-numbers"><span>1</span><span>2</span></div>
              <pre class="line-numbers"><code><table class="hljs-ln"><tbody>
                <tr><td class="hljs-ln-numbers" data-line-number="1">1</td><td class="hljs-ln-code">first line</td></tr>
                <tr><td class="hljs-ln-numbers" data-line-number="2">2</td><td class="hljs-ln-code">second line</td></tr>
              </tbody></table></code><span aria-hidden="true" class="line-numbers-rows"><span></span><span></span></span></pre>
            </div>
            <p>Here is python explanation:</p>
            <pre><code class="hljs go">fmt.Println("hi")</code></pre>
            <div class="code-header">SQL</div>
            <pre><code>SELECT 1;</code></pre>
            <p>Plain pre block:</p>
            <pre><code><div class="code-line">alpha</div><div class="code-line">beta</div></code></pre>
            <pre><code data-language="c++">int main() { return 0; }</code></pre>
          </div>
        </message-content>
      </model-response>
    `);

    const worker = new GeminiBrowserWorker();
    worker.browser = browser;
    worker.context = context;
    worker.page = page;
    worker.isInitialized = true;

    const domResult = await worker.extractLatestResponse({ useClipboard: false });
    assert.deepEqual(domResult.code_blocks, [
      { language: 'javascript', code: "console.log('Hello world');\nconst pattern = '$$ and $&';" },
      { language: 'python', code: "print('Hello world')" },
      { language: 'unknown', code: 'first line\nsecond line' },
      { language: 'go', code: 'fmt.Println("hi")' },
      { language: 'sql', code: 'SELECT 1;' },
      { language: 'unknown', code: 'alpha\nbeta' },
      { language: 'c++', code: 'int main() { return 0; }' }
    ]);
    assert.ok(domResult.content.includes('`npm install`'));
    assert.ok(domResult.content.includes("const pattern = '$$ and $&';"));
    assert.ok(!domResult.content.includes('internal thought should be ignored'));
    assert.ok(!domResult.content.includes('Copy code'));
    assert.ok(!domResult.content.includes('Копировать код'));
    assert.ok(!domResult.content.includes('Use code with caution.'));

    // Test 11B: Response with only inline code and no code blocks -> code_blocks: []
    await page.setContent(`
      <model-response>
        <message-content>
          <div class="markdown">
            <p>Просто вызовите <code>console.log()</code> без блока кода.</p>
          </div>
        </message-content>
      </model-response>
    `);
    const noCodeResult = await worker.extractLatestResponse({ useClipboard: false });
    assert.equal(noCodeResult.code_blocks.length, 0);
    assert.ok(noCodeResult.content.includes('`console.log()`'));

    // Test 11C: Fallback .markdown selector & direct extractResponseFromElement execution
    await page.setContent(`
      <div class="markdown">
        <p>Fallback container</p>
        <pre><code class="language-rust">fn main() {}</code></pre>
      </div>
    `);
    const fallbackResult = await worker.extractLatestResponse({ useClipboard: false });
    assert.deepEqual(fallbackResult.code_blocks, [{ language: 'rust', code: 'fn main() {}' }]);
    const directEvalResult = await page.locator('.markdown').evaluate(extractResponseFromElement);
    assert.equal(directEvalResult.code_blocks.length, 1);
    assert.equal(directEvalResult.code_blocks[0].language, 'rust');
    console.log('✓ Test 11: Playwright DOM code extraction (languages, line numbers, inline exclusion, thoughts) verified');

    // Test 12: Copy button + Clipboard extraction, fallback, & previous clipboard restoration over localhost origin
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!doctype html>
        <html>
          <body>
            <model-response>
              <message-content>
                <div class="markdown">
                  <code-block>
                    <div class="code-block">
                      <div class="code-block-decoration">
                        <span>TypeScript</span>
                        <button id="copy-ts" aria-label="Copy code">Copy code</button>
                      </div>
                      <pre><code class="language-typescript">const renderedPreview = true;</code></pre>
                    </div>
                  </code-block>
                  <code-block>
                    <div class="code-block">
                      <div class="code-block-decoration">
                        <span>Bash</span>
                        <button id="copy-broken" aria-label="Copy code">Copy code</button>
                      </div>
                      <pre><code class="language-bash">echo "fallback dom"</code></pre>
                    </div>
                  </code-block>
                </div>
              </message-content>
            </model-response>
            <script>
              document.getElementById('copy-ts').addEventListener('click', () => {
                navigator.clipboard.writeText("const exactFromClipboard: string = 'ok';\\n");
              });
              // copy-broken intentionally does not write to clipboard -> verifies fallback to DOM
            </script>
          </body>
        </html>
      `);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => navigator.clipboard.writeText('user-previous-clipboard'));
      const clipResult = await worker.extractLatestResponse({ useClipboard: true });
      assert.deepEqual(clipResult.code_blocks, [
        { language: 'typescript', code: "const exactFromClipboard: string = 'ok';" },
        { language: 'bash', code: 'echo "fallback dom"' }
      ]);
      // Ensure temporary data-gwa-code-idx attributes were cleaned up
      const leftoverMarks = await page.locator('[data-gwa-code-idx]').count();
      assert.equal(leftoverMarks, 0);
      // Ensure previous clipboard content was restored
      const restoredClipboard = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(restoredClipboard, 'user-previous-clipboard');
      console.log('✓ Test 12: Copy-button clipboard extraction, DOM fallback & clipboard restore verified');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await browser.close().catch(() => { });
  }

  // Restore enqueue
  requestDispatcher.enqueue = originalEnqueue;

  // Test 13: OpenAPI Bearer Authentication & Production API_KEY Enforcement
  const expectedAuthError = {
    error: {
      message: 'Incorrect API key provided. You can find your API key in the environment variables.',
      type: 'invalid_request_error',
      code: 'invalid_api_key'
    }
  };

  let enqueueCalledWithoutAuth = false;
  requestDispatcher.enqueue = async () => {
    enqueueCalledWithoutAuth = true;
    return 'Should never run';
  };

  // Protected endpoints must reject missing/malformed/wrong auth headers with 401
  const unauthorizedCases = [
    { method: 'GET', url: '/health', headers: {} },
    { method: 'POST', url: '/v1/auth/reload', headers: {} },
    {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {},
      payload: { messages: [] } // invalid payload must still fail 401 before schema validation
    },
    {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: config.apiKey }, // missing Bearer prefix
      payload: { messages: [{ role: 'user', content: 'hi' }] }
    },
    {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Basic ${config.apiKey}` },
      payload: { messages: [{ role: 'user', content: 'hi' }] }
    },
    {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer   ' },
      payload: { messages: [{ role: 'user', content: 'hi' }] }
    },
    {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-wrong-key' },
      payload: { messages: [{ role: 'user', content: 'hi' }] }
    }
  ];

  for (const testCase of unauthorizedCases) {
    const res = await app.inject(testCase);
    assert.equal(res.statusCode, 401, `Expected 401 for ${testCase.method} ${testCase.url}`);
    assert.deepEqual(JSON.parse(res.body), expectedAuthError);
  }
  assert.equal(enqueueCalledWithoutAuth, false, 'Queue must never receive unauthenticated requests');

  // Case-insensitive Bearer prefix should succeed
  requestDispatcher.enqueue = async () => ({ content: 'Authorized OK', code_blocks: [] });
  for (const prefix of ['Bearer', 'bearer', 'BEARER']) {
    const okRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `${prefix} ${config.apiKey}` },
      payload: { messages: [{ role: 'user', content: 'auth check' }] }
    });
    assert.equal(okRes.statusCode, 200);
    assert.equal(JSON.parse(okRes.body).choices[0].message.content, 'Authorized OK');
  }

  // Unit tests for timing-safe verification & resolveApiKey
  assert.equal(verifyBearerToken(`Bearer ${config.apiKey}`, config.apiKey), true);
  assert.equal(verifyBearerToken(`bearer ${config.apiKey}`, config.apiKey), true);
  assert.equal(verifyBearerToken('Bearer short', 'much-longer-secret-key'), false);
  assert.equal(verifyBearerToken(`Bearer ${config.apiKey}`, ''), false);
  assert.equal(verifyBearerToken(undefined, config.apiKey), false);

  assert.equal(resolveApiKey({ NODE_ENV: 'development' }), 'sk-custom-secret-key');
  assert.equal(resolveApiKey({ NODE_ENV: 'development', API_KEY: 'sk-dev-123' }), 'sk-dev-123');
  assert.equal(resolveApiKey({ NODE_ENV: 'production', API_KEY: 'sk-prod-123' }), 'sk-prod-123');
  assert.throws(() => resolveApiKey({ NODE_ENV: 'production' }), /API_KEY/i);
  assert.throws(() => resolveApiKey({ NODE_ENV: 'production', API_KEY: '   ' }), /API_KEY/i);

  // Subprocess crash verification when NODE_ENV=production and API_KEY is empty
  const prodCrash = spawnSync(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', API_KEY: '' },
    encoding: 'utf8',
    timeout: 5000
  });
  assert.notEqual(prodCrash.status, 0, 'Production server must crash when API_KEY is missing');
  assert.match(prodCrash.stderr + prodCrash.stdout, /API_KEY/i);
  console.log('✓ Test 13: OpenAPI Bearer auth, timing-safe comparison & production API_KEY enforcement verified');

  requestDispatcher.enqueue = originalEnqueue;

  // Test 14: GitHub repository URL validation before queue
  assert.deepEqual(parseGithubRepoUrl('https://github.com/expressjs/express'), {
    url: 'https://github.com/expressjs/express',
    owner: 'expressjs',
    repo: 'express',
    slug: 'expressjs/express'
  });
  assert.deepEqual(parseGithubRepoUrl('https://github.com/vercel/next.js/'), {
    url: 'https://github.com/vercel/next.js/',
    owner: 'vercel',
    repo: 'next.js',
    slug: 'vercel/next.js'
  });
  assert.deepEqual(parseGithubRepoUrl('https://github.com/expressjs/express.git'), {
    url: 'https://github.com/expressjs/express.git',
    owner: 'expressjs',
    repo: 'express',
    slug: 'expressjs/express'
  });

  const invalidRepoUrls = [
    '',
    '   ',
    'http://github.com/expressjs/express',
    'https://gitlab.com/expressjs/express',
    'https://github.com/',
    'https://github.com/expressjs',
    'https://github.com/expressjs/',
    'https://github.com/./express',
    'https://github.com/expressjs/..',
    'https://github.com/expressjs/express?tab=readme',
    'not-a-url'
  ];

  let enqueueCalledForInvalidRepo = false;
  requestDispatcher.enqueue = async () => {
    enqueueCalledForInvalidRepo = true;
    return 'Should never run';
  };

  for (const badUrl of invalidRepoUrls) {
    assert.equal(parseGithubRepoUrl(badUrl), null, `Expected parseGithubRepoUrl to reject "${badUrl}"`);
    const badRepoRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: {
        messages: [{ role: 'user', content: 'Analyze repo' }],
        github_repo: badUrl
      }
    });
    assert.equal(badRepoRes.statusCode, 400, `Expected 400 for invalid github_repo "${badUrl}"`);
  }
  assert.equal(enqueueCalledForInvalidRepo, false, 'Invalid github_repo must be rejected before queue');

  capturedPayload = null;
  requestDispatcher.enqueue = async (params) => {
    capturedPayload = params;
    return { content: 'Repo analyzed', code_blocks: [] };
  };
  const validRepoRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: authHeaders,
    payload: {
      messages: [{ role: 'user', content: 'Проанализируй архитектуру контроллеров в этом проекте.' }],
      action: 'new',
      github_repo: 'https://github.com/expressjs/express'
    }
  });
  assert.equal(validRepoRes.statusCode, 200);
  assert.equal(capturedPayload.githubRepo, 'https://github.com/expressjs/express');
  console.log('✓ Test 14: github_repo URL validation before queue and payload forwarding verified');

  // Test 15: GithubImportError hierarchy, queue pass-through & HTTP 422 response
  const importErr = new GithubImportError('Repo private');
  assert.ok(importErr instanceof GithubImportError);
  assert.ok(importErr instanceof BrowserWorkerError);
  assert.ok(importErr instanceof Error);
  assert.equal(importErr.statusCode, 422);
  assert.equal(importErr.code, 'github_import_failed');

  requestDispatcher.enqueue = originalEnqueue;
  const originalSendMessage = browserWorker.sendMessage;
  let sendAttempt = 0;
  browserWorker.sendMessage = async (_prompt, _action, _chatId, opts) => {
    sendAttempt++;
    if (opts.githubRepo === 'https://github.com/private/secret-repo') {
      throw new GithubImportError('Private repository');
    }
    return { content: 'Queue still healthy', code_blocks: [] };
  };

  try {
    const failedImportRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: {
        messages: [{ role: 'user', content: 'Inspect repo' }],
        github_repo: 'https://github.com/private/secret-repo'
      }
    });
    assert.equal(failedImportRes.statusCode, 422);
    assert.deepEqual(JSON.parse(failedImportRes.body), {
      error: {
        message: 'Failed to attach GitHub repository. Ensure the repository is public and the URL is correct.',
        code: 'github_import_failed'
      }
    });
    assert.equal(requestDispatcher.isPausedForAuth, false, 'GithubImportError must not pause the queue');

    // Verify subsequent requests continue working normally after 422
    const followUpRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: {
        messages: [{ role: 'user', content: 'Normal follow-up' }]
      }
    });
    assert.equal(followUpRes.statusCode, 200);
    assert.equal(JSON.parse(followUpRes.body).choices[0].message.content, 'Queue still healthy');
    assert.equal(sendAttempt, 2);
  } finally {
    browserWorker.sendMessage = originalSendMessage;
  }
  console.log('✓ Test 15: GithubImportError (422) formatting and queue resilience verified');

  // Test 16: Real Playwright end-to-end GitHub repo attachment inside sendMessage (success, error, timeout, missing menu)
  const ghBrowser = await chromium.launch({ headless: true, args: config.chromiumArgs });
  const originalGhTimeout = config.githubImportTimeoutMs;
  try {
    const context = await ghBrowser.newContext();
    const page = await context.newPage();
    const worker = new GeminiBrowserWorker();
    worker.browser = ghBrowser;
    worker.context = context;
    worker.page = page;
    worker.isInitialized = true;
    worker.checkSession = async () => { };
    worker.handleAction = async () => { };

    const callOrder = [];
    const origSelect = worker.selectModelAndThinkingLevel.bind(worker);
    worker.selectModelAndThinkingLevel = async (...args) => {
      callOrder.push('selectModel');
      return origSelect(...args);
    };

    // 16A: Full happy-path UI flow: model picker -> + button -> GitHub -> modal -> chip -> prompt fill -> send -> response
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <button data-test-id="bard-mode-menu-button">Neon High</button>
          <div id="composer" class="input-area">
            <div id="chips"></div>
            <div id="spinner" class="loading-spinner" style="display:none;">Loading...</div>
            <button id="attach-btn" aria-label="Upload file">+</button>
            <rich-textarea>
              <div contenteditable="true" role="textbox"></div>
            </rich-textarea>
            <button id="send-btn" aria-label="Send message">Send</button>
          </div>
          <div id="menu" role="menu" style="display:none;">
            <div role="menuitem" id="gh-item">GitHub</div>
          </div>
          <div id="gh-modal" role="dialog" style="display:none;">
            <input id="gh-url-input" type="url" placeholder="https://github.com/owner/repo" />
            <div id="modal-err" role="alert" style="display:none;"></div>
            <button id="gh-import-btn" type="submit">Import</button>
            <button id="gh-cancel-btn" type="button">Cancel</button>
          </div>
          <div id="responses"></div>
          <button id="stop-btn" aria-label="Stop generating" style="display:none;">Stop</button>
          <script>
            window.__events = [];
            document.getElementById('attach-btn').addEventListener('click', () => {
              window.__events.push('attach_clicked');
              document.getElementById('menu').style.display = 'block';
            });
            document.getElementById('gh-item').addEventListener('click', () => {
              window.__events.push('github_clicked');
              document.getElementById('menu').style.display = 'none';
              document.getElementById('gh-modal').style.display = 'block';
            });
            document.getElementById('gh-cancel-btn').addEventListener('click', () => {
              document.getElementById('gh-modal').style.display = 'none';
            });
            document.getElementById('gh-import-btn').addEventListener('click', () => {
              const val = document.getElementById('gh-url-input').value.trim();
              window.__events.push('import_clicked:' + val);
              if (val.includes('private/repo')) {
                const err = document.getElementById('modal-err');
                err.textContent = 'Repository not found or is private';
                err.style.display = 'block';
                return;
              }
              if (val.includes('hang/repo')) {
                return; // Modal closes? Or spinner hangs without chip
              }
              document.getElementById('gh-modal').style.display = 'none';
              document.getElementById('spinner').style.display = 'block';
              setTimeout(() => {
                document.getElementById('spinner').style.display = 'none';
                const chip = document.createElement('div');
                chip.className = 'attachment-chip';
                chip.textContent = 'expressjs/express';
                document.getElementById('chips').appendChild(chip);
                window.__events.push('chip_rendered');
              }, 120);
            });
            document.getElementById('send-btn').addEventListener('click', () => {
              const promptTxt = document.querySelector('[role="textbox"]').innerText.trim();
              const hasChip = document.getElementById('chips').textContent.includes('expressjs/express');
              window.__events.push('send_clicked:' + promptTxt + ':chip=' + hasChip);
              document.getElementById('stop-btn').style.display = 'inline-block';
              setTimeout(() => {
                const mr = document.createElement('model-response');
                mr.innerHTML = '<message-content><div class="markdown"><p>Analyzed controllers.</p></div></message-content>';
                document.getElementById('responses').appendChild(mr);
                document.getElementById('stop-btn').style.display = 'none';
              }, 80);
            });
          </script>
        </body>
      </html>
    `);

    const ghAnswer = await worker.sendMessage('Проанализируй архитектуру контроллеров', 'new', null, {
      model: 'gemini-4-neon',
      thinkingLevel: 'high',
      githubRepo: 'https://github.com/expressjs/express'
    });
    assert.equal(ghAnswer.content, 'Analyzed controllers.');
    const events = await page.evaluate(() => window.__events);
    assert.equal(callOrder[0], 'selectModel');
    assert.deepEqual(events, [
      'attach_clicked',
      'github_clicked',
      'import_clicked:https://github.com/expressjs/express',
      'chip_rendered',
      'send_clicked:Проанализируй архитектуру контроллеров:chip=true'
    ]);

    // 16B: Private/non-existent repo shows error inside modal -> throws GithubImportError and dismisses modal
    await assert.rejects(
      () => worker.attachGithubRepository('https://github.com/private/repo'),
      (err) => err instanceof GithubImportError && err.statusCode === 422 && err.code === 'github_import_failed'
    );
    const modalVisibleAfterError = await page.locator('#gh-modal').isVisible();
    assert.equal(modalVisibleAfterError, false, 'Open GitHub modal must be dismissed after failure');

    // 16C: Timeout waiting for chip -> throws GithubImportError and dismisses modal
    config.githubImportTimeoutMs = 450;
    await assert.rejects(
      () => worker.attachGithubRepository('https://github.com/hang/repo'),
      (err) => err instanceof GithubImportError && err.statusCode === 422
    );
    const modalVisibleAfterTimeout = await page.locator('#gh-modal').isVisible();
    assert.equal(modalVisibleAfterTimeout, false, 'Open GitHub modal must be dismissed after timeout');

    // 16D: Missing GitHub menu item -> throws GithubImportError
    await page.setContent('<button aria-label="Upload file">+</button><div role="menu" style="display:none;"><div role="menuitem">Upload from computer</div></div>');
    await assert.rejects(
      () => worker.attachGithubRepository('https://github.com/expressjs/express'),
      (err) => err instanceof GithubImportError
    );

    console.log('✓ Test 16: Playwright GitHub attachment flow (ordering, chip wait, error/timeout/missing-menu) verified');
  } finally {
    config.githubImportTimeoutMs = originalGhTimeout;
    await ghBrowser.close().catch(() => { });
  }

  await app.close();
  console.log('\n--- ALL TESTS PASSED SUCCESSFULLY ---');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
