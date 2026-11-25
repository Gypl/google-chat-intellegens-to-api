import fs from 'node:fs';
import { chromium } from 'playwright';
import { config } from './config.js';
import { SessionExpiredError, BrowserWorkerError, GithubImportError } from './errors.js';
import {
  CODE_BLOCK_MARK_ATTR,
  COPY_BUTTON_SELECTORS,
  cleanCodeText,
  extractCodeBlocksFromMarkdown,
  extractResponseFromElement,
  parseGithubRepoUrl
} from './parser.js';

/**
 * Normalizes model parameter into regex matching pattern and clean name.
 */
export function getModelRegex(model) {
  const raw = (model || '').toLowerCase().trim();
  const clean = raw.replace(/^(gemini[-_]?\d*[-_]?|models\/)/i, '').trim();
  const pattern = clean ? `\\b(${clean}|${raw})\\b` : raw;
  return { regex: new RegExp(pattern, 'i'), cleanName: clean || raw };
}

/**
 * Normalizes thinking level parameter into regex matching pattern.
 */
export function getThinkingLevelRegex(level) {
  const norm = (level || '').toLowerCase().trim();
  switch (norm) {
    case 'minimal':
      return /minimal|минимальн/i;
    case 'low':
      return /\blow\b|низк/i;
    case 'medium':
      return /medium|средн/i;
    case 'high':
      return /\bhigh\b|высок/i;
    case 'xhigh':
    case 'extra-high':
    case 'extra high':
      return /xhigh|extra-high|extra high|максимальн|очень высок/i;
    default:
      return new RegExp(norm, 'i');
  }
}

export class GeminiBrowserWorker {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isInitialized = false;
    this.sessionExpired = false;
    this.currentChatId = null;
    this.currentModel = null;
    this.currentThinkingLevel = null;
    this.chatUrls = new Map(); // chatId -> gemini conversation url
  }

  /**
   * Initializes the singleton browser worker.
   */
  async init() {
    if (this.isInitialized) {
      return;
    }

    // 1. Verify existence of auth_state.json
    if (!fs.existsSync(config.authStatePath)) {
      this.sessionExpired = true;
      console.warn(
        `[BrowserWorker] Warning: Auth state file not found at "${config.authStatePath}". ` +
        `Requests will fail with 401 until valid auth_state.json is provided.`
      );
    }

    console.info(`[BrowserWorker] Launching Chromium with low-RAM flags (headless: ${config.headless})...`);

    // 2. Launch Chromium with memory optimizations
    this.browser = await chromium.launch({
      headless: config.headless,
      args: config.chromiumArgs
    });

    // 3. Create browser context with loaded storageState if available
    const contextOptions = {
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    if (fs.existsSync(config.authStatePath)) {
      try {
        contextOptions.storageState = config.authStatePath;
      } catch (err) {
        console.error(`[BrowserWorker] Failed to parse auth_state.json: ${err.message}`);
        this.sessionExpired = true;
      }
    }

    this.context = await this.browser.newContext(contextOptions);
    await this.context.grantPermissions(['clipboard-read', 'clipboard-write']).catch((err) => {
      console.warn(`[BrowserWorker] Could not grant clipboard permissions: ${err.message}`);
    });

    // 4. Create single persistent page
    this.page = await this.context.newPage();

    // 5. Memory optimization: block heavy resources (images, fonts, media, telemetry)
    await this.page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      const url = route.request().url();

      if (['image', 'media', 'font'].includes(resourceType)) {
        return route.abort();
      }

      if (
        url.includes('google-analytics.com') ||
        url.includes('googletagmanager.com') ||
        url.includes('play.google.com/log')
      ) {
        return route.abort();
      }

      return route.continue();
    });

    // Handle unexpected page crashes
    this.page.on('crash', async () => {
      console.error('[BrowserWorker] Page crashed! Re-initializing page...');
      try {
        this.page = await this.context.newPage();
        await this.navigateToGemini();
      } catch (err) {
        console.error('[BrowserWorker] Recovery failed:', err.message);
      }
    });

    // 6. Navigate to Gemini web app
    await this.navigateToGemini();

    this.isInitialized = true;
    console.info('[BrowserWorker] Browser worker successfully initialized and ready.');
  }

  /**
   * Navigates to Gemini and verifies session.
   */
  async navigateToGemini() {
    console.info(`[BrowserWorker] Navigating to ${config.geminiUrl}...`);
    try {
      await this.page.goto(config.geminiUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });
    } catch (err) {
      console.warn(`[BrowserWorker] Navigation initial notice: ${err.message}`);
    }

    await this.checkSession();
  }

  /**
   * Checks if user session is expired or unauthenticated.
   */
  async checkSession() {
    const currentUrl = this.page.url();

    // Check if redirected to Google sign-in
    if (
      currentUrl.includes('accounts.google.com') ||
      currentUrl.includes('ServiceLogin') ||
      currentUrl.includes('signin')
    ) {
      this.sessionExpired = true;
      console.error(`[BrowserWorker] Session expired: redirected to ${currentUrl}`);
      throw new SessionExpiredError();
    }

    // Check for sign-in buttons on page
    const signInButton = this.page.locator(
      'a[href*="accounts.google.com"], button:has-text("Sign in"), button:has-text("Войти")'
    );
    if (await signInButton.isVisible().catch(() => false)) {
      this.sessionExpired = true;
      console.error('[BrowserWorker] Session expired: Sign in button detected.');
      throw new SessionExpiredError();
    }

    this.sessionExpired = false;
  }

  /**
   * Reloads authentication state from disk.
   */
  async reloadAuth() {
    console.info('[BrowserWorker] Reloading auth state from disk...');
    if (this.context) {
      await this.context.close().catch(() => { });
    }
    this.isInitialized = false;
    await this.init();
  }

  /**
   * Handles action: "new" or "continue".
   */
  async handleAction(action = 'continue', chatId = null) {
    await this.checkSession();

    if (action === 'new') {
      console.info(`[BrowserWorker] Action "new": Starting new dialog (chatId: ${chatId || 'none'})...`);

      // Attempt to click "New chat" button in UI
      const newChatSelectors = [
        'button[aria-label*="New chat" i]',
        'button[aria-label*="Новый чат" i]',
        'a[href="/app"]',
        '[data-test-id="new-chat-button"]',
        'button:has-text("New chat")',
        'button:has-text("Новый чат")'
      ];

      let clicked = false;
      for (const selector of newChatSelectors) {
        const btn = this.page.locator(selector).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click().catch(() => { });
          clicked = true;
          break;
        }
      }

      // If button not found or we are on another sub-path, navigate to base URL
      if (!clicked || this.page.url() !== config.geminiUrl) {
        await this.page.goto(config.geminiUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      this.currentChatId = chatId || null;
      if (chatId) {
        this.chatUrls.delete(chatId);
      }
      return;
    }

    // action === 'continue'
    if (chatId) {
      if (this.currentChatId === chatId) {
        // Already on this dialog
        return;
      }

      // If we have a saved direct URL for this chatId, navigate to it
      const savedUrl = this.chatUrls.get(chatId);
      if (savedUrl && savedUrl !== this.page.url()) {
        console.info(`[BrowserWorker] Switching to existing conversation for chatId "${chatId}" via URL: ${savedUrl}`);
        await this.page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        this.currentChatId = chatId;
        return;
      }

      // Otherwise retain current page and associate chatId
      this.currentChatId = chatId;
    }
  }

  /**
   * Dismisses any blocking promo, survey, or location modals if present.
   */
  async dismissModals() {
    const dismissSelectors = [
      'mat-dialog-container button:has-text("Dismiss")',
      'mat-dialog-container button:has-text("Close")',
      'mat-dialog-container button:has-text("Got it")',
      'mat-dialog-container button:has-text("Понятно")',
      'mat-dialog-container button:has-text("Закрыть")',
      '[role="dialog"] button:has-text("Dismiss")',
      '[role="dialog"] button:has-text("Close")',
      '[role="dialog"] button:has-text("Got it")',
      '[role="dialog"] button:has-text("Понятно")',
      '[role="dialog"] button:has-text("Закрыть")'
    ];
    const dismissBtn = this.page.locator(dismissSelectors.join(', ')).first();
    if (await dismissBtn.isVisible().catch(() => false)) {
      console.info('[BrowserWorker] Dismissing promo/location modal dialog...');
      await dismissBtn.click().catch(() => { });
      await this.page.waitForTimeout(300);
    }
  }

  /**
   * Dynamically checks and selects the requested AI model and thinking level.
   *
   * 1. Finds the model selector button (inside/near input area or header).
   * 2. Inspects currently active model & thinking level; skips UI clicks if already selected.
   * 3. If switching is required:
   *    - Opens the mode picker dropdown menu.
   *    - Clicks the requested model option (e.g. Neon / gemini-4-neon).
   *    - Opens thinking level submenu/options and selects requested level (minimal/low/medium/high/xhigh).
   *    - Closes menu and waits 500ms for Gemini frontend to apply settings.
   */
  async selectModelAndThinkingLevel(
    model = config.defaultModel,
    thinkingLevel = config.defaultThinkingLevel
  ) {
    await this.dismissModals();

    const modelButtonSelectors = [
      '[data-test-id="bard-mode-menu-button"]',
      'button.input-area-switch',
      'button[aria-label*="mode picker" i]',
      'button[aria-label*="model" i]',
      'button[aria-label*="модел" i]',
      'button[aria-label*="режим" i]',
      'button:has-text("Neon")',
      'button:has-text("Hydrogen")',
      'button:has-text("Carbon")',
      'button:has-text("Flash")',
      'button:has-text("Pro")'
    ];

    const btn = this.page.locator(modelButtonSelectors.join(', ')).first();
    const isAttached = await btn.waitFor({ state: 'attached', timeout: 10000 }).then(() => true).catch(() => false);
    if (!isAttached || !(await btn.isVisible().catch(() => false))) {
      console.warn('[BrowserWorker] Model selector button not found/visible. Proceeding with default model.');
      return;
    }

    const currentText = ((await btn.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').toLowerCase();
    const currentAria = ((await btn.getAttribute('aria-label').catch(() => '')) || '').toLowerCase();

    const { regex: modelRegex, cleanName: cleanModel } = getModelRegex(model);
    const thinkingRegex = getThinkingLevelRegex(thinkingLevel);

    const isModelActive = modelRegex.test(currentText) || modelRegex.test(currentAria);
    const isThinkingActive = thinkingRegex.test(currentText) || thinkingRegex.test(currentAria);

    if (isModelActive && isThinkingActive) {
      this.currentModel = model;
      this.currentThinkingLevel = thinkingLevel;
      console.info(`[BrowserWorker] Model "${model}" and thinking level "${thinkingLevel}" are already active.`);
      return;
    }

    console.info(`[BrowserWorker] Switching model to "${model}" (level: "${thinkingLevel}")...`);

    const ensureMenuOpen = async () => {
      const isExpanded = await btn.getAttribute('aria-expanded').catch(() => null);
      if (isExpanded !== 'true') {
        console.info('[BrowserWorker] Opening model selector menu...');
        await btn.click({ force: true }).catch(() => { });
        await this.page.waitForTimeout(400);
      }
    };

    await ensureMenuOpen();

    const menuItemSelectors = '[role="menuitemradio"], [role="menuitem"], [role="option"], gem-menu-item';

    // Step 2: Base model selection
    if (!isModelActive) {
      console.info(`[BrowserWorker] Selecting base model matching "${cleanModel}"...`);
      const modelOption = this.page.locator(menuItemSelectors).filter({ hasText: modelRegex }).first();
      if (await modelOption.count() > 0) {
        const isChecked = await modelOption.getAttribute('aria-checked').catch(() => null);
        if (isChecked !== 'true') {
          await modelOption.click().catch(() => { });
          await this.page.waitForTimeout(500);
        }
      } else {
        console.warn(`[BrowserWorker] Model option matching "${cleanModel}" not found in menu.`);
      }
    }

    // Step 3: Thinking level selection
    // Note: selecting model closes the menu in Gemini, check if thinking level is still needed
    const afterModelText = ((await btn.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').toLowerCase();
    const afterModelAria = ((await btn.getAttribute('aria-label').catch(() => '')) || '').toLowerCase();
    const isThinkingStillActive = thinkingRegex.test(afterModelText) || thinkingRegex.test(afterModelAria);

    if (!isThinkingStillActive) {
      await ensureMenuOpen();

      // Find "Thinking level" (or "Уровень размышлений") expandable menu item
      const thinkingHeader = this.page
        .locator('[role="menuitem"], gem-menu-item')
        .filter({ hasText: /thinking level|уровень размышлений/i })
        .first();

      if (await thinkingHeader.isVisible().catch(() => false)) {
        await thinkingHeader.hover().catch(() => { });
        await this.page.waitForTimeout(250);

        const testVisible = await this.page
          .locator(menuItemSelectors)
          .filter({ hasText: thinkingRegex })
          .first()
          .isVisible()
          .catch(() => false);

        if (!testVisible) {
          await thinkingHeader.click().catch(() => { });
          await this.page.waitForTimeout(250);
        }
      }

      const thinkingOption = this.page.locator(menuItemSelectors).filter({ hasText: thinkingRegex }).first();
      if (await thinkingOption.isVisible().catch(() => false)) {
        const isChecked = await thinkingOption.getAttribute('aria-checked').catch(() => null);
        if (isChecked !== 'true') {
          console.info(`[BrowserWorker] Selecting thinking level "${thinkingLevel}"...`);
          await thinkingOption.click().catch(() => { });
          await this.page.waitForTimeout(400);
        }
      } else {
        console.warn(`[BrowserWorker] Thinking level option matching "${thinkingLevel}" not visible in menu.`);
      }
    }

    // Close menu if still expanded
    const stillExpanded = await btn.getAttribute('aria-expanded').catch(() => null);
    if (stillExpanded === 'true') {
      await this.page.keyboard.press('Escape').catch(() => { });
      await this.page.waitForTimeout(200);
    }

    // Step 4: Wait for application
    await this.page.waitForTimeout(500);

    this.currentModel = model;
    this.currentThinkingLevel = thinkingLevel;
    console.info(`[BrowserWorker] Model "${model}" and thinking level "${thinkingLevel}" applied successfully.`);
  }

  /**
   * Returns the first visible locator among candidates within timeoutMs, or null.
   */
  async waitForFirstVisible(candidates, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      for (const candidate of candidates) {
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
      await this.page.waitForTimeout(100);
    }
    return null;
  }

  /**
   * Best-effort cleanup of open GitHub import dialogs/menus after an error so
   * subsequent queued requests are not blocked.
   */
  async dismissGithubDialog() {
    if (!this.page) return;
    try {
      const closeButtons = [
        '[role="dialog"] button[aria-label*="close" i]',
        '[role="dialog"] button:has-text("Cancel")',
        '[role="dialog"] button:has-text("Close")',
        '[role="dialog"] button:has-text("Отмена")',
        '[role="dialog"] button:has-text("Закрыть")',
        'mat-dialog-container button:has-text("Cancel")',
        'mat-dialog-container button:has-text("Close")',
        'mat-dialog-container button:has-text("Отмена")',
        'mat-dialog-container button:has-text("Закрыть")'
      ];
      const closeBtn = this.page.locator(closeButtons.join(', ')).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click({ timeout: 500 }).catch(() => { });
      }
      await this.page.keyboard.press('Escape').catch(() => { });
      await this.page.waitForTimeout(150);
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Attaches a public GitHub repository to the current Gemini prompt via the UI attachment menu.
   * Throws GithubImportError if the UI flow fails, times out, or displays an error.
   */
  async attachGithubRepository(githubRepo) {
    const parsed = parseGithubRepoUrl(githubRepo);
    if (!parsed) {
      throw new GithubImportError(`Invalid GitHub repository URL: ${githubRepo}`);
    }

    const { url: repoUrl, slug: repoSlug, repo: repoName } = parsed;
    const timeoutMs = config.githubImportTimeoutMs;
    console.info(`[BrowserWorker] Attaching GitHub repository "${repoSlug}" (${repoUrl})...`);

    try {
      // 1. Open the attachment (+) menu near the prompt input
      const attachmentBtn = await this.waitForFirstVisible(
        [
          this.page.locator('[data-test-id="upload-file-button"]').first(),
          this.page.locator('button[aria-label*="Upload file" i]').first(),
          this.page.locator('button[aria-label*="Add file" i]').first(),
          this.page.locator('button[aria-label*="Open upload" i]').first(),
          this.page.locator('button[aria-label*="Attach" i]').first(),
          this.page.locator('button[aria-label*="Загрузить" i]').first(),
          this.page.locator('button[aria-label*="Добавить файл" i]').first(),
          this.page.locator('button[aria-label*="Прикрепить" i]').first(),
          this.page.locator('uploader button, .input-area button:has(mat-icon[fonticon="add"])').first(),
          this.page
            .getByRole('button', { name: /upload|attachment|attach|add file|add|добавить|загрузить|прикрепить/i })
            .first()
        ],
        Math.min(timeoutMs, 5000)
      );

      if (!attachmentBtn) {
        throw new GithubImportError('Attachment (+) button not found in Gemini UI');
      }
      await attachmentBtn.click();

      // 2. Select "GitHub" / "Add repository" from the opened menu
      const githubOption = await this.waitForFirstVisible(
        [
          this.page
            .locator('[role="menuitem"], [role="option"], mat-list-item, .mat-mdc-menu-item')
            .filter({ hasText: /github|add repository|import code|репозитор/i })
            .first(),
          this.page.getByRole('menuitem', { name: /github|add repository|import code|репозитор/i }).first(),
          this.page.getByText(/github/i, { exact: false }).first(),
          this.page.getByText(/add repository/i, { exact: false }).first()
        ],
        Math.min(timeoutMs, 4000)
      );

      if (!githubOption) {
        throw new GithubImportError('GitHub integration option not found in attachment menu');
      }
      await githubOption.click();

      // 3. Wait for import dialog and URL input field
      const dialogLocator = this.page.locator('[role="dialog"], mat-dialog-container, dialog').last();
      const repoInput = await this.waitForFirstVisible(
        [
          this.page.locator('[role="dialog"] input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])').first(),
          this.page.locator('mat-dialog-container input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])').first(),
          this.page.locator('dialog input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])').first(),
          this.page
            .locator(
              'input[placeholder*="github" i], input[aria-label*="github" i], input[placeholder*="repository" i], input[aria-label*="repository" i], input[placeholder*="url" i], input[aria-label*="url" i]'
            )
            .first()
        ],
        Math.min(timeoutMs, 5000)
      );

      if (!repoInput) {
        throw new GithubImportError('GitHub repository URL input dialog did not appear');
      }

      const hadDialog = await dialogLocator.isVisible().catch(() => false);
      await repoInput.fill(repoUrl);
      await this.page.waitForTimeout(100);

      // 4. Submit import dialog via Add/Import button or Enter
      const confirmScope = hadDialog ? dialogLocator : this.page;
      const confirmBtn = await this.waitForFirstVisible(
        [
          confirmScope.locator('button[type="submit"]').first(),
          confirmScope
            .locator('button')
            .filter({
              hasText: /^(import|add|connect|attach|confirm|submit|импорт|импортировать|добавить|подключить|прикрепить)$/i
            })
            .first(),
          confirmScope
            .locator('button')
            .filter({ hasText: /import|add repository|добавить|импортировать/i })
            .first()
        ],
        600
      );

      if (confirmBtn) {
        const btnDeadline = Date.now() + 800;
        let disabled = await confirmBtn.isDisabled().catch(() => false);
        while (disabled && Date.now() < btnDeadline) {
          await this.page.waitForTimeout(100);
          disabled = await confirmBtn.isDisabled().catch(() => false);
        }
        if (!disabled) {
          await confirmBtn.click();
        } else {
          await repoInput.press('Enter');
        }
      } else {
        await repoInput.press('Enter');
      }

      // 5. Critical wait: dialog closed, no spinner, no error, and chip rendered in input area
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        const state = await this.page.evaluate(
          ({ slug, repo, expectDialogClose }) => {
            const isVisible = (el) => {
              if (!el || el.nodeType !== 1) return false;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                return false;
              }
              return el.getClientRects().length > 0;
            };

            const errorRe =
              /(private|not found|invalid|unable to|failed|cannot|could not|doesn't exist|does not exist|access denied|permission|не найден|приватн|ошибка|не удалось|недоступ)/i;

            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], mat-dialog-container, dialog')).filter(
              isVisible
            );
            const dialogOpen = dialogs.length > 0;

            for (const dlg of dialogs) {
              const errEl = Array.from(
                dlg.querySelectorAll('[role="alert"], .error, .error-message, mat-error, .mat-mdc-form-field-error')
              ).find((e) => isVisible(e) && (e.innerText || e.textContent || '').trim().length > 0);
              if (errEl) {
                return { status: 'error', reason: (errEl.innerText || errEl.textContent).trim() };
              }
              const dlgText = (dlg.innerText || '').trim();
              if (dlgText && errorRe.test(dlgText)) {
                return { status: 'error', reason: dlgText };
              }
            }

            const toasts = Array.from(
              document.querySelectorAll('[role="alert"], mat-snack-bar-container, .snackbar, .error-toast')
            ).filter((e) => isVisible(e) && !e.closest('[role="dialog"], mat-dialog-container, dialog'));
            for (const toast of toasts) {
              const toastText = (toast.innerText || toast.textContent || '').trim();
              if (toastText && errorRe.test(toastText)) {
                return { status: 'error', reason: toastText };
              }
            }

            if (expectDialogClose && dialogOpen) {
              return { status: 'waiting_dialog' };
            }

            const spinners = Array.from(
              document.querySelectorAll(
                'mat-spinner, mat-progress-spinner, [role="progressbar"], .loading-spinner, .spinner'
              )
            ).filter((s) => isVisible(s) && !s.closest('model-response'));
            if (spinners.length > 0) {
              return { status: 'waiting_spinner' };
            }

            const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const slugRe = new RegExp(escapeRe(slug), 'i');
            const repoRe = new RegExp(`\\b${escapeRe(repo)}\\b`, 'i');

            const isChipContextExcluded = (el) =>
              Boolean(
                el === document.body ||
                el === document.documentElement ||
                el.closest(
                  '[role="dialog"], mat-dialog-container, dialog, model-response, message-content, nav, aside, header, bard-sidenav, [role="navigation"], script, style'
                )
              );

            // Priority 1: explicit chip / attachment / preview elements
            const chipEls = Array.from(
              document.querySelectorAll(
                'mat-chip, mat-chip-row, uploader-file-preview, [class*="chip" i], [class*="attachment" i], [class*="file-preview" i], [data-test-id*="file" i], [data-test-id*="chip" i], [data-test-id*="repo" i], [data-test-id*="github" i]'
              )
            ).filter((el) => isVisible(el) && !isChipContextExcluded(el));

            for (const chip of chipEls) {
              const txt = (chip.innerText || chip.textContent || '').trim();
              if (slugRe.test(txt) || repoRe.test(txt)) {
                return { status: 'attached' };
              }
            }

            // Priority 2: any visible non-dialog, non-response element displaying owner/repo slug
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            let node;
            while ((node = walker.nextNode())) {
              if (
                node.tagName === 'INPUT' ||
                node.tagName === 'TEXTAREA' ||
                !isVisible(node) ||
                isChipContextExcluded(node)
              ) {
                continue;
              }
              const txt = (node.innerText || '').trim();
              if (txt && txt.length < 200 && slugRe.test(txt)) {
                return { status: 'attached' };
              }
            }

            return { status: 'waiting_chip' };
          },
          { slug: repoSlug, repo: repoName, expectDialogClose: hadDialog }
        );

        if (state.status === 'attached') {
          console.info(`[BrowserWorker] GitHub repository "${repoSlug}" attached successfully.`);
          return;
        }
        if (state.status === 'error') {
          throw new GithubImportError(`GitHub import UI reported an error: ${state.reason}`);
        }

        await this.page.waitForTimeout(150);
      }

      throw new GithubImportError(`Timed out waiting ${timeoutMs}ms for GitHub repository chip "${repoSlug}"`);
    } catch (err) {
      await this.dismissGithubDialog();
      if (err instanceof GithubImportError) {
        throw err;
      }
      throw new GithubImportError(`Failed to attach GitHub repository "${repoSlug}": ${err.message}`);
    }
  }

  /**
   * Sends prompt and waits for full completion.
   */
  async sendMessage(prompt, action = 'continue', chatId = null, options = {}) {
    let targetModel = config.defaultModel;
    let targetThinkingLevel = config.defaultThinkingLevel;
    let targetGithubRepo = null;

    if (typeof options === 'object' && options !== null) {
      if (options.model) targetModel = options.model;
      if (options.thinkingLevel) targetThinkingLevel = options.thinkingLevel;
      if (options.githubRepo) targetGithubRepo = options.githubRepo;
    } else if (typeof options === 'string') {
      targetModel = options;
      if (arguments[4]) targetThinkingLevel = arguments[4];
    }
    if (this.sessionExpired) {
      // Re-check in case user updated auth_state.json
      if (fs.existsSync(config.authStatePath)) {
        await this.reloadAuth();
      }
      if (this.sessionExpired) {
        throw new SessionExpiredError();
      }
    }

    if (!this.isInitialized) {
      await this.init();
    }

    await this.handleAction(action, chatId);

    // Verify and apply requested model and thinking level before attaching files or entering prompt
    await this.selectModelAndThinkingLevel(targetModel, targetThinkingLevel);

    // Attach optional GitHub repository strictly after model selection and before prompt input
    if (targetGithubRepo) {
      await this.attachGithubRepository(targetGithubRepo);
    }

    // Locate the prompt input area
    const inputSelectors = [
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      '[role="textbox"]',
      'rich-textarea',
      'textarea'
    ];

    let inputElement = null;
    for (const selector of inputSelectors) {
      const loc = this.page.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) {
        inputElement = loc;
        break;
      }
    }

    if (!inputElement) {
      // Dismiss modals in case a popup is delaying input visibility
      await this.dismissModals();
      // Give a brief wait in case page is still hydrating
      const fallback = this.page.locator('rich-textarea, [role="textbox"], div[contenteditable="true"]').first();
      await fallback.waitFor({ state: 'visible', timeout: 15000 }).catch(async () => {
        await this.checkSession();
        throw new BrowserWorkerError('Prompt input field not found on Gemini page');
      });
      inputElement = fallback;
    }

    // Focus input and safely insert text without triggering Enter on newlines
    await inputElement.click();
    try {
      await inputElement.fill(prompt);
    } catch {
      await inputElement.focus();
      await this.page.keyboard.press('ControlOrMeta+A');
      await this.page.keyboard.press('Backspace');
      await this.page.keyboard.insertText(prompt);
    }

    // Small delay before submission to ensure DOM updates
    await this.page.waitForTimeout(200);

    // Locate Send button
    const sendButtonSelectors = [
      'button[aria-label*="Send message" i]',
      'button[aria-label*="Send prompt" i]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Отправить" i]',
      'button.send-button',
      '[data-test-id="send-button"]',
      'button:has(mat-icon[fonticon="send"])'
    ];

    let sent = false;
    for (const sel of sendButtonSelectors) {
      const btn = this.page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        // Check if button is enabled
        const isDisabled = await btn.isDisabled().catch(() => false);
        if (!isDisabled) {
          await btn.click().catch(() => { });
          sent = true;
          break;
        }
      }
    }

    if (!sent) {
      // Fallback: press Enter to submit
      await this.page.keyboard.press('Enter');
    }

    console.info('[BrowserWorker] Prompt submitted. Waiting for generation to start and finish...');

    // Locate "Stop generating" indicator button
    const stopButtonSelectors = [
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Stop response" i]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Остановить генерацию" i]',
      'button[aria-label*="Остановить" i]',
      'button:has-text("Stop")',
      'button:has-text("Остановить")',
      '[data-test-id="stop-button"]',
      'button:has(mat-icon[fonticon="stop"])'
    ];
    const stopButton = this.page.locator(stopButtonSelectors.join(', ')).first();

    // 1. Wait for "Stop generating" button to appear
    let stopButtonAppeared = false;
    try {
      await stopButton.waitFor({
        state: 'visible',
        timeout: config.waitStopButtonTimeoutMs
      });
      stopButtonAppeared = true;
      console.info('[BrowserWorker] Generation in progress ("Stop generating" button detected)...');
    } catch {
      console.warn('[BrowserWorker] "Stop generating" button did not appear within timeout. Checking response state...');
      await this.checkSession();
    }

    // 2. Strict condition: completion is determined by disappearance of "Stop generating" button
    if (stopButtonAppeared) {
      try {
        await stopButton.waitFor({
          state: 'detached',
          timeout: config.generationTimeoutMs
        });
      } catch {
        // Also check hidden state if detached didn't trigger
        await stopButton.waitFor({
          state: 'hidden',
          timeout: 10000
        });
      }
      console.info('[BrowserWorker] Generation completed ("Stop generating" button disappeared).');
    }

    // Brief stabilization pause for final markdown rendering
    await this.page.waitForTimeout(600);

    // 3. Extract the last assistant response
    const answer = await this.extractLatestResponse();

    // Save direct URL for this conversation if available
    const currentUrl = this.page.url();
    if (chatId && currentUrl.includes('/app/')) {
      this.chatUrls.set(chatId, currentUrl);
    }

    return answer;
  }

  /**
   * Attempts to extract raw code from a code block by clicking its Copy button
   * and reading the clipboard (falling back gracefully if unavailable).
   */
  async readCodeViaCopyButton(blockLocator) {
    if (!this.page) {
      return null;
    }

    let copyBtn = blockLocator.locator(COPY_BUTTON_SELECTORS.join(', ')).first();
    let isVisible = await copyBtn.isVisible().catch(() => false);

    if (!isVisible) {
      // Some UIs reveal the copy button only on hover
      await blockLocator.hover({ timeout: 500 }).catch(() => { });
      isVisible = await copyBtn.isVisible().catch(() => false);
    }

    if (!isVisible) {
      const textBtn = blockLocator
        .locator('button')
        .filter({ hasText: /^(copy|copy code|копировать|копировать код)$/i })
        .first();
      if (await textBtn.isVisible().catch(() => false)) {
        copyBtn = textBtn;
        isVisible = true;
      }
    }

    if (!isVisible) {
      return null;
    }

    const sentinel = `__GEMINI_API_CLIPBOARD_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    let previousClipboard = null;
    let sentinelWritten = false;

    try {
      const prep = await this.page.evaluate(async (marker) => {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
          return { ok: false, prev: null };
        }
        let prev = null;
        try {
          prev = await navigator.clipboard.readText();
        } catch {
          prev = null;
        }
        try {
          await navigator.clipboard.writeText(marker);
          return { ok: true, prev };
        } catch {
          return { ok: false, prev };
        }
      }, sentinel);

      if (!prep.ok) {
        return null;
      }

      previousClipboard = prep.prev;
      sentinelWritten = true;

      await copyBtn.click({ timeout: 1000 });

      for (let attempt = 0; attempt < 8; attempt++) {
        await this.page.waitForTimeout(50);
        const copied = await this.page.evaluate(() => navigator.clipboard.readText().catch(() => null));
        if (typeof copied === 'string' && copied !== sentinel) {
          const cleaned = cleanCodeText(copied);
          return cleaned.length > 0 ? cleaned : null;
        }
      }

      return null;
    } catch {
      return null;
    } finally {
      if (sentinelWritten && previousClipboard !== null) {
        await this.page
          .evaluate((prev) => navigator.clipboard.writeText(prev).catch(() => { }), previousClipboard)
          .catch(() => { });
      }
    }
  }

  /**
   * Extracts text/markdown and structured code blocks from the latest assistant message.
   */
  async extractLatestResponse({ useClipboard = true } = {}) {
    const selectorGroups = [
      'model-response',
      'message-content, .model-response-text, .response-container',
      '.markdown, div[id^="model-response"]'
    ];

    let latest = null;
    for (const selector of selectorGroups) {
      const locators = this.page.locator(selector);
      if ((await locators.count()) > 0) {
        latest = locators.last();
        break;
      }
    }

    if (!latest) {
      throw new BrowserWorkerError('No response elements found in Gemini DOM');
    }

    const extracted = await latest.evaluate(extractResponseFromElement, { markBlocks: useClipboard });
    const rawBlocks = Array.isArray(extracted?.code_blocks) ? extracted.code_blocks : [];

    if (useClipboard && rawBlocks.some((b) => b.hasCopyButton)) {
      try {
        for (const block of rawBlocks) {
          if (!block.hasCopyButton) continue;
          const blockLocator = latest.locator(`[${CODE_BLOCK_MARK_ATTR}="${block.blockIndex}"]`).first();
          if ((await blockLocator.count()) === 0) continue;
          const copiedCode = await this.readCodeViaCopyButton(blockLocator);
          if (copiedCode) {
            block.code = copiedCode;
          }
        }
      } finally {
        await latest
          .evaluate(
            (root, attr) => {
              root.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
            },
            CODE_BLOCK_MARK_ATTR
          )
          .catch(() => { });
      }
    }

    let codeBlocks = rawBlocks.map(({ language, code }) => ({
      language: language || 'unknown',
      code
    }));

    const content = (extracted?.content || '').trim();
    if (codeBlocks.length === 0 && content) {
      codeBlocks = extractCodeBlocksFromMarkdown(content);
    }

    return {
      content,
      code_blocks: codeBlocks
    };
  }

  /**
   * Closes browser resources.
   */
  async close() {
    console.info('[BrowserWorker] Closing browser worker...');
    try {
      if (this.context) {
        await this.context.close().catch(() => { });
      }
      if (this.browser) {
        await this.browser.close().catch(() => { });
      }
    } finally {
      this.isInitialized = false;
      this.browser = null;
      this.context = null;
      this.page = null;
      this.currentModel = null;
      this.currentThinkingLevel = null;
      this.currentChatId = null;
    }
  }
}

// Export singleton instance
export const browserWorker = new GeminiBrowserWorker();
