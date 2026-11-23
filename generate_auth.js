#!/usr/bin/env node

/**
 * generate_auth.js
 * 
 * Интерактивный локальный скрипт для авторизации в Google Аккаунте
 * и экспорта cookies / localStorage в файл `auth_state.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chromium } from 'playwright';

const AUTH_STATE_FILE = process.env.AUTH_STATE_PATH || path.resolve(process.cwd(), 'auth_state.json');
const GEMINI_URL = 'https://gemini.google.com/app';

function askUser(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('================================================================');
  console.log('   Gemini Web-to-API: Авторизация Google (Экспорт сессии)      ');
  console.log('================================================================\n');
  console.log('Браузер Chromium сейчас откроется в отдельном окне.');
  console.log('Время авторизации НЕ ОГРАНИЧЕНО — вы можете спокойно ввести логин,');
  console.log('пароль и подтвердить вход по 2FA (SMS / приложение / ключ).\n');
  console.log(`Файл сессии будет сохранен в: ${AUTH_STATE_FILE}\n`);

  // Запуск браузера с обходом блокировок автоматизации
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });

  const contextOptions = {
    viewport: { width: 1280, height: 850 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  };

  if (fs.existsSync(AUTH_STATE_FILE)) {
    try {
      contextOptions.storageState = AUTH_STATE_FILE;
      console.log('Найден существующий auth_state.json — сессия загружена для проверки/обновления.');
    } catch {
      // Игнорируем поврежденный файл
    }
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  console.log(`Открываем ${GEMINI_URL}...`);
  try {
    await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    console.log(`(Загрузка страницы продолжается: ${err.message})`);
  }

  console.log('\n----------------------------------------------------------------');
  console.log('ИНСТРУКЦИЯ ПО ШАГАМ:');
  console.log('1. В открывшемся окне браузера войдите в свой Google-аккаунт.');
  console.log('2. Пройдите проверку безопасности (2FA, телефон, уведомление).');
  console.log('3. Дождитесь загрузки экрана чата Gemini с полем ввода.');
  console.log('4. Нажмите [ENTER] здесь в консоли, чтобы сохранить сессию.');
  console.log('----------------------------------------------------------------\n');

  let isCompleted = false;

  // Ожидание ручного нажатия клавиши Enter пользователем
  const manualPromise = (async () => {
    await askUser('>>> Когда закончите авторизацию в браузере, нажмите [ENTER] здесь: ');
    isCompleted = true;
    return 'manual';
  })();

  // Фоновый мониторинг появления интерфейса Gemini (только если URL действительно на gemini.google.com)
  const monitorPromise = (async () => {
    let geminiDetectedAt = null;

    while (!isCompleted) {
      await sleep(2000);
      if (isCompleted) break;

      try {
        const url = page.url();

        // Проверяем, что мы именно на Gemini, а не на accounts.google.com
        if (url.includes('gemini.google.com/app') && !url.includes('accounts.google.com')) {
          // Ищем специфический контейнер Gemini prompt
          const hasPrompt = await page
            .locator('rich-textarea, div[contenteditable="true"].ql-editor, rich-textarea div[contenteditable="true"]')
            .first()
            .isVisible()
            .catch(() => false);

          if (hasPrompt) {
            if (!geminiDetectedAt) {
              geminiDetectedAt = Date.now();
              console.log('\n[✓] Интерфейс Gemini успешно обнаружен!');
              console.log('    Нажмите [ENTER] для мгновенного сохранения, или подождите 15 секунд...');
            } else if (Date.now() - geminiDetectedAt >= 15000) {
              console.log('\n[✓] Автоматическое подтверждение: интерфейс активен.');
              isCompleted = true;
              return 'auto';
            }
          } else {
            geminiDetectedAt = null;
          }
        } else {
          geminiDetectedAt = null;
        }
      } catch {
        // Ошибки навигации пользователя игнорируем
      }
    }
  })();

  // Ждем либо нажатия Enter, либо автодетекции с 15-секундной задержкой после появления Gemini
  await Promise.race([manualPromise, monitorPromise]);

  console.log('\nСохранение сессии (cookies, localStorage)...');
  await sleep(1500); // Даем браузеру сбросить последние куки в storage

  await context.storageState({ path: AUTH_STATE_FILE });

  if (fs.existsSync(AUTH_STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(AUTH_STATE_FILE, 'utf8'));
      const cookieCount = data.cookies ? data.cookies.length : 0;
      const originsCount = data.origins ? data.origins.length : 0;

      // Проверка наличия ключевых кук Google
      const hasGoogleAuth = (data.cookies || []).some(
        (c) => c.domain.includes('google.com') && (c.name === 'SID' || c.name === 'HSID' || c.name === '__Secure-1PSID')
      );

      console.log('================================================================');
      console.log(`[УСПЕХ] Файл авторизации успешно создан!`);
      console.log(`Путь: ${AUTH_STATE_FILE}`);
      console.log(`Сохранено cookies: ${cookieCount}, origins: ${originsCount}`);
      if (hasGoogleAuth) {
        console.log(`Статус сессии: Авторизационные токены Google найдены (SID/HSID).`);
      } else {
        console.log(`Предупреждение: Ключевые токены Google не найдены. Убедитесь, что вход был завершен.`);
      }
      console.log('================================================================\n');
      console.log('ЧТО ДЕЛАТЬ ДАЛЬШЕ:');
      console.log(`1. Если вы запускаете сервер на VPS, скопируйте "${path.basename(AUTH_STATE_FILE)}" на сервер:`);
      console.log(`   scp ${AUTH_STATE_FILE} user@vps-ip:/path/to/gemini_web_api_wrapper/`);
      console.log('2. Запустите API-сервер:');
      console.log('   docker compose up -d');
      console.log('   (или npm start для локального запуска)');
      console.log('----------------------------------------------------------------\n');
    } catch (err) {
      console.error(`Ошибка при проверке файла auth_state.json: ${err.message}`);
    }
  } else {
    console.error(`[ОШИБКА] Не удалось создать файл ${AUTH_STATE_FILE}`);
  }

  await browser.close().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error('\nОшибка выполнения скрипта авторизации:', err);
  process.exit(1);
});
