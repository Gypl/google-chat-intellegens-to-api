import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { config } from '../src/config.js';
import { buildServer, DEFAULT_MODEL, DEFAULT_THINKING_LEVEL } from '../src/server.js';
import { requestDispatcher } from '../src/queue.js';
import { GeminiBrowserWorker, getModelRegex, getThinkingLevelRegex } from '../src/browser.js';
import {
  cleanCodeText,
  extractCodeBlocksFromMarkdown,
  extractResponseFromElement,
  normalizeAssistantResult,
  normalizeLanguageLabel
} from '../src/parser.js';

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
  assert.deepEqual(defaultBody.choices[0].message.code_blocks, []);
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

  await app.close();
  console.log('\n--- ALL TESTS PASSED SUCCESSFULLY ---');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
