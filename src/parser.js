/**
 * Response extraction and code block parsing utilities.
 *
 * Designed to run both inside Playwright's browser context (`extractResponseFromElement`)
 * and in Node.js (`cleanCodeText`, `extractCodeBlocksFromMarkdown`, `normalizeAssistantResult`).
 */

export const CODE_BLOCK_MARK_ATTR = 'data-gwa-code-idx';

export const GITHUB_REPO_URL_REGEX =
  /^https:\/\/github\.com\/((?!\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+)\/((?!\.{1,2}(?:\.git)?(?:\/|$))[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/**
 * Validates and parses a public GitHub repository URL (`https://github.com/<owner>/<repo>`).
 * Returns `{ url, owner, repo, slug }` or `null` if invalid.
 */
export function parseGithubRepoUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return null;
  }
  const trimmed = rawUrl.trim();
  const match = GITHUB_REPO_URL_REGEX.exec(trimmed);
  if (!match) {
    return null;
  }
  const [, owner, repo] = match;
  return {
    url: trimmed,
    owner,
    repo,
    slug: `${owner}/${repo}`
  };
}

export const COPY_BUTTON_SELECTORS = [
  'button[aria-label*="copy" i]',
  'button[aria-label*="копир" i]',
  'button[title*="copy" i]',
  'button[title*="копир" i]',
  'button[mattooltip*="copy" i]',
  'button[mattooltip*="копир" i]',
  'button[data-test-id*="copy" i]',
  'button.copy-button',
  'button:has(mat-icon[fonticon="content_copy"])',
  'button:has(mat-icon[data-mat-icon-name="content_copy"])'
];

/**
 * Normalizes line endings and trims leading/trailing blank lines while
 * preserving internal indentation on code lines.
 */
export function cleanCodeText(rawCode) {
  if (typeof rawCode !== 'string') {
    return '';
  }
  return rawCode
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/[ \t\n]+$/, '');
}

/**
 * Normalizes a candidate language string or returns null if it is not a valid language label.
 */
export function normalizeLanguageLabel(raw) {
  if (typeof raw !== 'string') {
    return null;
  }

  const normalized = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized || normalized.length > 32) {
    return null;
  }

  if (
    /[:;!?]/.test(normalized) ||
    normalized.endsWith('.') ||
    normalized.includes('\n') ||
    normalized.split(' ').length > 3
  ) {
    return null;
  }

  const ignoredLabels = new Set([
    'code',
    'код',
    'code snippet',
    'фрагмент кода',
    'snippet',
    'copy',
    'copy code',
    'copied',
    'copied!',
    'копировать',
    'копировать код',
    'скопировано',
    'use code with caution',
    'используйте код с осторожностью',
    'unknown',
    'none',
    'null',
    'undefined',
    'nohighlight',
    'hljs',
    'prism',
    'formatted',
    'code-container',
    'ng-star-inserted',
    'line-numbers',
    'notranslate',
    'overflow-x-auto',
    'code-block',
    'dark',
    'light',
    'active',
    'container'
  ]);

  if (ignoredLabels.has(normalized)) {
    return null;
  }

  if (/^(use code with caution|используйте код с осторожностью|copy code|копировать)/i.test(normalized)) {
    return null;
  }

  return normalized;
}

/**
 * Extracts fenced code blocks from raw Markdown text (fallback when HTML blocks are absent).
 */
export function extractCodeBlocksFromMarkdown(markdown) {
  if (typeof markdown !== 'string' || !markdown.includes('```')) {
    return [];
  }

  const blocks = [];
  const fenceRegex = /(?:^|\r?\n)(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)\r?\n\1(?=[ \t]*(?:\r?\n|$))/g;

  let match;
  while ((match = fenceRegex.exec(markdown)) !== null) {
    const infoString = (match[2] || '').trim();
    const firstToken = infoString.split(/\s+/)[0] || '';
    const language = normalizeLanguageLabel(firstToken) || 'unknown';
    const code = cleanCodeText(match[3] || '');
    if (code.length > 0) {
      blocks.push({ language, code });
    }
  }

  return blocks;
}

/**
 * Normalizes any dispatcher/worker result into `{ content, code_blocks }`.
 */
export function normalizeAssistantResult(result) {
  if (typeof result === 'string') {
    return {
      content: result,
      code_blocks: extractCodeBlocksFromMarkdown(result)
    };
  }

  if (result && typeof result === 'object') {
    const content = typeof result.content === 'string' ? result.content : String(result.content ?? '');
    let codeBlocks;

    if (Array.isArray(result.code_blocks)) {
      codeBlocks = result.code_blocks
        .filter((b) => b && typeof b.code === 'string' && b.code.length > 0)
        .map((b) => ({
          language: normalizeLanguageLabel(b.language) || 'unknown',
          code: b.code
        }));
    } else {
      codeBlocks = extractCodeBlocksFromMarkdown(content);
    }

    return { content, code_blocks: codeBlocks };
  }

  return { content: '', code_blocks: [] };
}

/**
 * Self-contained DOM extractor executed inside `locator.evaluate(...)`.
 * IMPORTANT: Do not reference outer module imports/closures inside this function,
 * because Playwright serializes and runs it inside the browser page context.
 */
export function extractResponseFromElement(rootNode, options = {}) {
  const markBlocks = Boolean(options && options.markBlocks);
  const BLOCK_MARK_ATTR = 'data-gwa-code-idx';

  const IGNORED_LABELS = new Set([
    'code',
    'код',
    'code snippet',
    'фрагмент кода',
    'snippet',
    'copy',
    'copy code',
    'copied',
    'copied!',
    'копировать',
    'копировать код',
    'скопировано',
    'use code with caution',
    'используйте код с осторожностью',
    'unknown',
    'none',
    'null',
    'undefined',
    'nohighlight',
    'hljs',
    'prism',
    'formatted',
    'code-container',
    'ng-star-inserted',
    'line-numbers',
    'notranslate',
    'overflow-x-auto',
    'code-block',
    'dark',
    'light',
    'active',
    'container'
  ]);

  const cleanText = (raw) => {
    if (typeof raw !== 'string') return '';
    return raw
      .replace(/\u00A0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/^(?:[ \t]*\n)+/, '')
      .replace(/[ \t\n]+$/, '');
  };

  const normalizeLang = (raw) => {
    if (typeof raw !== 'string') return null;
    const s = raw.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!s || s.length > 32) return null;
    if (/[:;!?]/.test(s) || s.endsWith('.') || s.includes('\n') || s.split(' ').length > 3) {
      return null;
    }
    if (IGNORED_LABELS.has(s)) return null;
    if (/^(use code with caution|используйте код с осторожностью|copy code|копировать)/i.test(s)) {
      return null;
    }
    return s;
  };

  const isInsideThoughts = (el) =>
    Boolean(el && el.closest && el.closest('model-thoughts, .thoughts-container, [data-test-id="model-thoughts"]'));

  const pickMainContentElement = (node) => {
    if (!node) return null;

    if (
      node.matches &&
      node.matches('message-content, .message-content, .model-response-text, .markdown') &&
      !isInsideThoughts(node)
    ) {
      if (node.matches('message-content, .message-content')) {
        const md = node.querySelector('.markdown');
        if (md && !isInsideThoughts(md)) return md;
      }
      return node;
    }

    const candidates = [
      ...node.querySelectorAll('message-content, .message-content, .model-response-text, .markdown')
    ].filter((el) => !isInsideThoughts(el));

    // Prefer message-content / .message-content, otherwise .model-response-text, otherwise last .markdown
    const preferred =
      candidates.find((el) => el.matches('message-content, .message-content')) ||
      candidates.find((el) => el.matches('.model-response-text')) ||
      candidates[candidates.length - 1];

    return preferred || node;
  };

  const contentEl = pickMainContentElement(rootNode);
  if (!contentEl) {
    return { content: '', code_blocks: [] };
  }

  const CODE_BLOCK_SELECTOR = 'code-block, .code-block, .snippet, [data-test-id="code-block"], pre';

  const findTopLevelContainers = (root) => {
    const allCandidates = Array.from(root.querySelectorAll(CODE_BLOCK_SELECTOR)).filter(
      (el) => !isInsideThoughts(el)
    );
    const candidateSet = new Set(allCandidates);

    const containers = [];
    for (const el of allCandidates) {
      let parent = el.parentElement;
      let hasCandidateAncestor = false;
      while (parent && parent !== root.parentElement) {
        if (candidateSet.has(parent)) {
          hasCandidateAncestor = true;
          break;
        }
        parent = parent.parentElement;
      }

      if (!hasCandidateAncestor) {
        // Edge case: if a wrapper (.snippet / .code-block) holds multiple independent <pre> tags,
        // unwrap to those <pre> tags instead of merging separate code blocks into one.
        if (el.tagName !== 'PRE') {
          const innerPres = Array.from(el.querySelectorAll('pre')).filter(
            (pre) => !pre.parentElement?.closest('pre')
          );
          if (innerPres.length > 1) {
            containers.push(...innerPres);
            continue;
          }
        }
        containers.push(el);
      }
    }
    return containers;
  };

  // Find candidate containers in DOM order, avoiding thoughts and nested duplicate wrappers
  const topLevelContainers = findTopLevelContainers(contentEl);

  const LINE_NUMBER_AND_CHROME_SELECTORS = [
    'button',
    'mat-icon',
    '[role="toolbar"]',
    '.copy-button',
    '.buttons',
    '.response-actions',
    '.action-button',
    '.code-block-decoration',
    '.code-block-header',
    '.code-header',
    '.snippet-header',
    '[data-test-id="code-block-header"]',
    '.code-block-footer',
    '.line-numbers-rows',
    '.hljs-ln-numbers',
    '.line-number',
    '.lineno',
    '.linenumber',
    '.ln-num',
    '.gutter',
    '.cm-gutters',
    '.CodeMirror-linenumbers',
    '.CodeMirror-gutter',
    '.ace_gutter',
    '.monaco-editor .margin',
    '[class*="line-number"]',
    '[class*="lineno"]',
    '[data-testid*="line-number" i]'
  ];

  const stripNonCodeNodes = (cloneRoot) => {
    for (const sel of LINE_NUMBER_AND_CHROME_SELECTORS) {
      cloneRoot.querySelectorAll(sel).forEach((el) => {
        if (el === cloneRoot) return;
        // Never remove a wrapper that contains actual code or pre elements
        if (el.tagName === 'PRE' || el.tagName === 'CODE' || el.querySelector('pre, code')) {
          return;
        }
        el.remove();
      });
    }
  };

  const LINE_BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE']);
  const TABLE_STRUCTURAL_TAGS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR']);

  const isLineBlockElement = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (LINE_BLOCK_TAGS.has(el.tagName)) return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    return /\b(line|code-line|cm-line|view-line|hljs-ln-line)\b/.test(cls);
  };

  const extractCodeFromNode = (node) => {
    if (!node) return '';
    if (node.nodeType === 3) {
      return node.nodeValue || '';
    }
    if (node.nodeType !== 1) {
      return '';
    }
    if (node.tagName === 'BR') {
      return '\n';
    }

    const children = Array.from(node.childNodes);
    const hasLineBlockChild = children.some((c) => isLineBlockElement(c));
    const isTableContainer = TABLE_STRUCTURAL_TAGS.has(node.tagName);

    if (!hasLineBlockChild && !isTableContainer) {
      let out = '';
      for (const child of children) {
        out += extractCodeFromNode(child);
      }
      return out;
    }

    // Parent has line-block children (e.g. <div class="line">...</div> or <tr>...</tr>)
    const segments = [];
    let currentInline = '';

    const flushInline = () => {
      if (currentInline !== '') {
        segments.push(currentInline);
        currentInline = '';
      }
    };

    for (let idx = 0; idx < children.length; idx++) {
      const child = children[idx];
      if (child.nodeType === 3) {
        const txt = child.nodeValue || '';
        // Ignore formatting whitespace between structural table rows/cells or between line blocks
        if (isTableContainer && /^\s*$/.test(txt)) {
          continue;
        }
        if (/^[ \t]*\r?\n[ \t]*$/.test(txt)) {
          const prev = children[idx - 1];
          const next = children[idx + 1];
          if (isLineBlockElement(prev) || isLineBlockElement(next)) {
            continue;
          }
        }
        currentInline += txt;
      } else if (child.nodeType === 1) {
        if (isLineBlockElement(child)) {
          flushInline();
          let lineText = extractCodeFromNode(child);
          // A single <br> inside an otherwise empty line div represents an empty line
          if (lineText === '\n' && child.children.length === 1 && child.children[0].tagName === 'BR') {
            lineText = '';
          }
          segments.push(lineText);
        } else if (child.tagName === 'BR') {
          flushInline();
          segments.push('');
        } else {
          currentInline += extractCodeFromNode(child);
        }
      }
    }
    flushInline();

    return segments.join('\n');
  };

  const detectLanguage = (blockEl, preEl, codeEl) => {
    const attrEls = [codeEl, preEl, blockEl].filter(Boolean);

    // 1. Explicit data attributes
    for (const el of attrEls) {
      for (const attr of ['data-language', 'data-lang', 'data-code-lang', 'data-code-language']) {
        const val = el.getAttribute && el.getAttribute(attr);
        const lang = normalizeLang(val);
        if (lang) return lang;
      }
    }

    // 2. CSS classes: language-* or lang-*
    for (const el of attrEls) {
      const cls = typeof el.className === 'string' ? el.className : '';
      for (const token of cls.split(/\s+/)) {
        const match = /^(?:language|lang)-(.+)$/i.exec(token);
        if (match) {
          const lang = normalizeLang(match[1]);
          if (lang) return lang;
        }
      }
    }

    // 3. Header element inside container (above <pre>/<code>)
    if (blockEl && blockEl !== preEl && blockEl !== codeEl) {
      const headerSelectors = [
        '.code-block-decoration',
        '.code-block-header',
        '.code-header',
        '.snippet-header',
        '[data-test-id="code-block-header"]',
        '[data-test-id="language-name"]',
        '.language-label',
        '.code-lang',
        '.lang-label',
        'figcaption'
      ];

      let headerCandidates = Array.from(blockEl.querySelectorAll(headerSelectors.join(', ')));
      if (headerCandidates.length === 0) {
        // Fallback: non-button element children placed before pre/code inside the block
        for (const child of Array.from(blockEl.children)) {
          if (child === preEl || child === codeEl || child.contains(preEl) || child.contains(codeEl)) {
            break;
          }
          if (child.tagName !== 'BUTTON') {
            headerCandidates.push(child);
          }
        }
      }

      for (const headerEl of headerCandidates) {
        const headerClone = headerEl.cloneNode(true);
        headerClone
          .querySelectorAll('button, .buttons, mat-icon, .copy-button, [role="button"], [class*="tooltip" i]')
          .forEach((n) => n.remove());

        const labelNodes = Array.from(headerClone.querySelectorAll('span, div, p, label, strong'));
        for (const lbl of labelNodes) {
          const lang = normalizeLang(lbl.textContent || '');
          if (lang) return lang;
        }

        const headerLang = normalizeLang(headerClone.textContent || '');
        if (headerLang) return headerLang;
      }
    }

    // 4. Preceding sibling header right before blockEl (only when explicitly styled as a code header)
    const prevEl = blockEl && blockEl.previousElementSibling;
    if (prevEl) {
      const prevClass = typeof prevEl.className === 'string' ? prevEl.className : '';
      const isCodeHeaderSibling =
        prevEl.tagName === 'FIGCAPTION' ||
        /code[-_]?(?:block[-_]?)?header|lang|snippet[-_]?header|code[-_]?title/i.test(prevClass) ||
        prevEl.hasAttribute('data-language');

      if (isCodeHeaderSibling) {
        const prevClone = prevEl.cloneNode(true);
        prevClone.querySelectorAll('button, mat-icon').forEach((n) => n.remove());
        const lang = normalizeLang(prevClone.textContent || '');
        if (lang) return lang;
      }
    }

    // 5. Highlight.js bare class fallback (e.g. class="hljs python")
    for (const el of [codeEl, preEl].filter(Boolean)) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const tokens = cls.split(/\s+/).filter(Boolean);
      if (tokens.includes('hljs') || tokens.includes('prism')) {
        for (const token of tokens) {
          if (token.startsWith('hljs-') || token.startsWith('language-') || token.startsWith('lang-')) {
            continue;
          }
          const lang = normalizeLang(token);
          if (lang) return lang;
        }
      }
    }

    return 'unknown';
  };

  const hasCopyButtonInBlock = (blockEl) => {
    if (!blockEl) return false;
    const copySel = [
      'button[aria-label*="copy" i]',
      'button[aria-label*="копир" i]',
      'button[title*="copy" i]',
      'button[title*="копир" i]',
      'button[mattooltip*="copy" i]',
      'button[mattooltip*="копир" i]',
      'button[data-test-id*="copy" i]',
      'button.copy-button'
    ].join(', ');

    if (blockEl.querySelector(copySel)) {
      return true;
    }

    for (const btn of Array.from(blockEl.querySelectorAll('button'))) {
      if (btn.querySelector('mat-icon[fonticon="content_copy"], mat-icon[data-mat-icon-name="content_copy"]')) {
        return true;
      }
      const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^(copy|copy code|копировать|копировать код)$/i.test(txt)) {
        return true;
      }
    }
    return false;
  };

  const extractedBlocks = [];
  const blockDataByElement = new Map();

  for (let i = 0; i < topLevelContainers.length; i++) {
    const blockEl = topLevelContainers[i];
    const preEl = blockEl.tagName === 'PRE' ? blockEl : blockEl.querySelector('pre');
    const codeEl =
      (preEl && preEl.querySelector('code')) ||
      (blockEl.tagName === 'CODE' ? blockEl : blockEl.querySelector('code'));

    const targetCodeEl = codeEl || preEl || blockEl;
    const codeClone = targetCodeEl.cloneNode(true);
    stripNonCodeNodes(codeClone);

    const code = cleanText(extractCodeFromNode(codeClone));
    if (!code) {
      continue;
    }

    const language = detectLanguage(blockEl, preEl, codeEl);
    const blockIndex = extractedBlocks.length;
    const hasCopyButton = hasCopyButtonInBlock(blockEl);

    if (markBlocks) {
      blockEl.setAttribute(BLOCK_MARK_ATTR, String(blockIndex));
    }

    const blockRecord = { language, code, hasCopyButton, blockIndex };
    extractedBlocks.push(blockRecord);
    blockDataByElement.set(blockEl, blockRecord);
  }

  // Extract clean content (preserving prose + fenced code blocks, without UI chrome)
  const formatFencedBlock = (language, code) => {
    let maxRun = 2;
    const matches = code.match(/`+/g);
    if (matches) {
      for (const m of matches) {
        if (m.length > maxRun) maxRun = m.length;
      }
    }
    const fence = '`'.repeat(maxRun + 1);
    const langTag = language && language !== 'unknown' ? language : '';
    return `${fence}${langTag}\n${code}\n${fence}`;
  };

  // Map marked/top-level containers in contentEl to cloned elements via index matching
  const contentClone = contentEl.cloneNode(true);
  const clonedTopLevel = findTopLevelContainers(contentClone);

  const clonedBlockMap = new Map();
  for (let i = 0; i < topLevelContainers.length; i++) {
    const liveEl = topLevelContainers[i];
    const clonedEl = clonedTopLevel[i];
    if (clonedEl && blockDataByElement.has(liveEl)) {
      clonedBlockMap.set(clonedEl, blockDataByElement.get(liveEl));
    }
  }

  const contentIgnoreSelectors = [
    'button',
    '.response-actions',
    '.action-button',
    'mat-icon',
    '[role="toolbar"]',
    '.copy-button',
    'model-thoughts',
    '.thoughts-container',
    '[data-test-id="model-thoughts"]'
  ];
  for (const sel of contentIgnoreSelectors) {
    contentClone.querySelectorAll(sel).forEach((el) => el.remove());
  }

  const PROSE_BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
    'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'TABLE', 'TR', 'HR'
  ]);

  const placeholderPrefix = `__GWA_CODE_BLOCK_${Date.now()}_`;
  const fencedReplacements = [];

  const serializeContentNode = (node) => {
    if (!node) return '';
    if (node.nodeType === 3) {
      return (node.nodeValue || '').replace(/\u00A0/g, ' ');
    }
    if (node.nodeType !== 1) {
      return '';
    }

    if (clonedBlockMap.has(node)) {
      const { language, code } = clonedBlockMap.get(node);
      const token = `${placeholderPrefix}${fencedReplacements.length}__`;
      fencedReplacements.push({ token, markdown: formatFencedBlock(language, code) });
      return `\n\n${token}\n\n`;
    }

    if (node.tagName === 'BR') {
      return '\n';
    }

    if (node.tagName === 'CODE' && !node.closest('pre')) {
      const inlineTxt = (node.textContent || '').trim();
      return inlineTxt ? `\`${inlineTxt}\`` : '';
    }

    if (node.tagName === 'TR') {
      const cells = Array.from(node.children);
      if (cells.length > 0 && cells.every((c) => c.tagName === 'TD' || c.tagName === 'TH')) {
        const cellTexts = cells
          .map((c) => serializeContentNode(c).replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        return cellTexts.length > 0 ? `${cellTexts.join(' | ')}\n` : '';
      }
    }

    let inner = '';
    for (const child of Array.from(node.childNodes)) {
      inner += serializeContentNode(child);
    }

    if (node.tagName === 'LI') {
      const trimmed = inner.trim();
      return trimmed ? `- ${trimmed}\n` : '';
    }

    if (node.tagName === 'TR') {
      const trimmed = inner.trim();
      return trimmed ? `${trimmed}\n` : '';
    }

    if (/^H[1-6]$/.test(node.tagName)) {
      const level = parseInt(node.tagName[1], 10);
      const trimmed = inner.trim();
      return trimmed ? `\n\n${'#'.repeat(level)} ${trimmed}\n\n` : '';
    }

    if (node.tagName === 'P' || node.tagName === 'BLOCKQUOTE') {
      const trimmed = inner.trim();
      return trimmed ? `\n\n${trimmed}\n\n` : '';
    }

    if (PROSE_BLOCK_TAGS.has(node.tagName)) {
      return `\n${inner}\n`;
    }

    return inner;
  };

  // Normalize prose whitespace first, then restore code blocks untouched
  let content = serializeContentNode(contentClone)
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  for (const { token, markdown } of fencedReplacements) {
    content = content.replace(token, () => markdown);
  }

  return {
    content,
    code_blocks: extractedBlocks
  };
}
