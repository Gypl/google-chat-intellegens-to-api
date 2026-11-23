#!/usr/bin/env node

/**
 * generate_auth.js
 * 
 * Interactive local helper script to log into Google and save Playwright
 * browser storage state (cookies + localStorage) to `auth_state.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chromium } from 'playwright';

const AUTH_STATE_FILE = process.env.AUTH_STATE_PATH || path.resolve(process.cwd(), 'auth_state.json');
const GEMINI_URL = 'https://gemini.google.com/app';

function waitForUserInput(promptText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  console.log('====================================================');
  console.log('  Gemini Web-to-API: Google Authentication Helper   ');
  console.log('====================================================\n');
  console.log('This script will launch a visible Chrome/Chromium window.');
  console.log('Please log into your Google Account in that window.\n');

  console.log(`Target save location: ${AUTH_STATE_FILE}\n`);

  // Launch visible browser
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const contextOptions = {
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  // If previous state exists, attempt to load it so user might not even need full login
  if (fs.existsSync(AUTH_STATE_FILE)) {
    try {
      contextOptions.storageState = AUTH_STATE_FILE;
      console.log('Loaded existing auth_state.json for renewal/check.');
    } catch {
      // Ignore corrupted file
    }
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  console.log(`Navigating to ${GEMINI_URL}...`);
  await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('\n----------------------------------------------------');
  console.log('INSTRUCTIONS:');
  console.log('1. Log into your Google account in the opened browser.');
  console.log('2. Pass 2FA if prompted.');
  console.log('3. Wait until the Gemini chat interface loads (where you can enter prompts).');
  console.log('----------------------------------------------------\n');

  // We offer two completion paths:
  // 1. Automatic detection when prompt textarea appears
  // 2. User pressing Enter in the terminal

  const autoDetectPromise = (async () => {
    try {
      await page.waitForSelector('rich-textarea, [role="textbox"], div[contenteditable="true"]', {
        timeout: 300000 // 5 minutes max
      });
      console.log('\n[Auto-detection] Gemini prompt field detected! Session is active.');
      return true;
    } catch {
      return false;
    }
  })();

  const manualConfirmPromise = (async () => {
    await waitForUserInput('Press [ENTER] in this console once you are fully logged into Gemini: ');
    return true;
  })();

  // Wait for either auto-detection or manual confirmation
  await Promise.race([autoDetectPromise, manualConfirmPromise]);

  // Small delay to ensure all session cookies are flushed
  await page.waitForTimeout(2000);

  console.log('\nSaving storage state (cookies, origins, localStorage)...');
  await context.storageState({ path: AUTH_STATE_FILE });

  // Validate the file
  if (fs.existsSync(AUTH_STATE_FILE)) {
    const raw = fs.readFileSync(AUTH_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const cookieCount = parsed.cookies ? parsed.cookies.length : 0;
    const originCount = parsed.origins ? parsed.origins.length : 0;

    console.log(`\nSUCCESS! Authentication saved to:\n  ${AUTH_STATE_FILE}`);
    console.log(`Captured ${cookieCount} cookies and ${originCount} origin storage items.`);

    console.log('\n----------------------------------------------------');
    console.log('NEXT STEPS:');
    console.log(`1. Upload "${path.basename(AUTH_STATE_FILE)}" to your server / VPS.`);
    console.log('2. Place it in the root of the project or mount it into your Docker container.');
    console.log('3. Start or reload the Gemini Web API server.');
    console.log('----------------------------------------------------\n');
  } else {
    console.error('ERROR: Failed to write auth_state.json.');
  }

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFatal error during auth generation:', err);
  process.exit(1);
});
