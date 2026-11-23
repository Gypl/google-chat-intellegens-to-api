import fs from 'node:fs';
import { chromium } from 'playwright';
import { config } from './config.js';
import { SessionExpiredError, BrowserWorkerError } from './errors.js';

export class GeminiBrowserWorker {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isInitialized = false;
    this.sessionExpired = false;
    this.currentChatId = null;
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
    await this.dismissModals();
  }

  /**
   * Closes any overlay popups, onboardings, banners or dialogs (e.g. "Let Gemini personalize using memory").
   */
  async dismissModals() {
    try {
      const modalButtonSelectors = [
        '.cdk-overlay-container button:has-text("Got it")',
        '.cdk-overlay-container button:has-text("Not now")',
        '.cdk-overlay-container button:has-text("Понятно")',
        '.cdk-overlay-container button:has-text("Не сейчас")',
        '.cdk-overlay-container button:has-text("Dismiss")',
        '.cdk-overlay-container button:has-text("Close")',
        '.cdk-overlay-container button:has-text("Закрыть")',
        'button[aria-label="Close" i]',
        'button[aria-label="Закрыть" i]',
        'button:has-text("Accept all")',
        'button:has-text("Принять все")',
        'button:has-text("I agree")',
        'button:has-text("Согласен")'
      ];

      for (const selector of modalButtonSelectors) {
        const btn = this.page.locator(selector).first();
        if (await btn.isVisible().catch(() => false)) {
          console.info(`[BrowserWorker] Dismissing modal overlay button: ${selector}`);
          await btn.click({ force: true }).catch(() => {});
          await this.page.waitForTimeout(300);
          break;
        }
      }

      // Send Escape key as a fallback to dismiss any active dialogs/popovers
      await this.page.keyboard.press('Escape').catch(() => {});
    } catch {
      // Non-critical, ignore dismissal errors
    }
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
      await this.context.close().catch(() => {});
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
          await btn.click().catch(() => {});
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
   * Sends prompt and waits for full completion.
   */
  async sendMessage(prompt, action = 'continue', chatId = null) {
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

    // Dismiss any modal overlays (like "Let Gemini personalize using memory")
    await this.dismissModals();

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

    // Dismiss any remaining overlays before clicking
    await this.dismissModals();

    // Focus input with force: true and direct focus to avoid pointer-intercept timeouts
    await inputElement.click({ force: true }).catch(() => {});
    await inputElement.focus().catch(() => {});

    try {
      await inputElement.fill(prompt);
    } catch {
      await inputElement.focus().catch(() => {});
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
          await btn.click({ force: true }).catch(() => {});
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
   * Extracts text or markdown from the latest assistant message.
   */
  async extractLatestResponse() {
    const responseSelectors = [
      'model-response',
      '.model-response-text',
      '.response-container',
      'message-content'
    ];

    const responseLocators = this.page.locator(responseSelectors.join(', '));
    const count = await responseLocators.count();

    if (count === 0) {
      // Fallback: search general markdown containers
      const mdLocators = this.page.locator('.markdown, div[id^="model-response"]');
      const mdCount = await mdLocators.count();
      if (mdCount > 0) {
        return (await mdLocators.last().innerText()).trim();
      }
      throw new BrowserWorkerError('No response elements found in Gemini DOM');
    }

    const latest = responseLocators.last();

    // Extract inside evaluate to strip non-content UI buttons (thumbs up/down, share, copy)
    const content = await latest.evaluate((node) => {
      // Look for the main message content or markdown element
      const contentEl =
        node.querySelector('.message-content') ||
        node.querySelector('.markdown') ||
        node.querySelector('.model-response-text') ||
        node;

      // Clone node to safely remove UI buttons without mutating live DOM
      const clone = contentEl.cloneNode(true);

      // Remove action buttons, toolbars, icon buttons
      const ignoreSelectors = [
        'button',
        '.response-actions',
        '.action-button',
        'mat-icon',
        '[role="toolbar"]',
        '.copy-button'
      ];
      for (const sel of ignoreSelectors) {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      }

      return clone.innerText || clone.textContent || '';
    });

    return (content || '').trim();
  }

  /**
   * Closes browser resources.
   */
  async close() {
    console.info('[BrowserWorker] Closing browser worker...');
    try {
      if (this.context) {
        await this.context.close().catch(() => {});
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
      }
    } finally {
      this.isInitialized = false;
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}

// Export singleton instance
export const browserWorker = new GeminiBrowserWorker();
