# Gemini Web-to-API REST Wrapper (Node.js)

Высокопроизводительный и легковесный API-сервер на **Node.js (Fastify + Playwright)**, который оборачивает веб-интерфейс **gemini.google.com** в REST API, совместимый со структурой OpenAI API (`/v1/chat/completions`).

Проект спроектирован для надежной работы в условиях жестких ограничений по ресурсам (**VPS с 2 ГБ ОЗУ**) благодаря архитектуре **Singleton Browser Worker** (один постоянно живущий процесс Playwright с одной вкладкой) и строгой **FIFO-очереди** запросов (concurrency: 1).

---

## 🌟 Ключевые особенности

* **Singleton Browser Worker:** Один процесс Chromium с одной вкладкой для исключения утечек памяти и накладных расходов на открытие/закрытие браузера.
* **Экстремальная оптимизация памяти:** Блокировка загрузки тяжелых ресурсов через `page.route()` (шрифты, изображения, медиа, телеметрия). Потребление ОЗУ в контейнере жестко ограничено **1.5 ГБ** (типично ~300-600 МБ).
* **Строгая FIFO-очередь (concurrency: 1):** Запросы выполняются строго по очереди.
* **Динамический выбор модели и Thinking Level:** Поддержка выбора ИИ-модели (`model`, дефолт: `gemini-4-neon` / "Neon") и уровня размышлений (`thinking_level`, дефолт: `high` / "High" с поддержкой `minimal`, `low`, `medium`, `high`, `xhigh`).
* **Защита от перегрузки (HTTP 429):** Максимальный размер очереди ожидания — **50 запросов**. При поступлении 51-го запроса сервер мгновенно возвращает `429 Too Many Requests` с телом `{"error": "Queue is full"}`.
* **Надежная детекция ответа:** Завершение генерации определяется моментом исчезновения кнопки *"Stop generating"* (*"Остановить генерацию"*) из DOM-дерева Gemini.
* **Извлечение блоков кода (`code_blocks`):** Автоматический парсинг DOM-дерева (и опционально буфера обмена через кнопку *"Copy code"*) для возврата структурированного массива `{ language, code }` без номеров строк и UI-артефактов.
* **Управление контекстом (`action` и `chat_id`):** Поддержка создания новых диалогов (`action: "new"`) и удержания/переключения контекста диалога (`action: "continue"` с `chat_id`).
* **Безопасная авторизация без логина на сервере:** Работает по предварительно экспортированному файлу сессии `auth_state.json`. При протухании сессии сервер возвращает `401 Unauthorized` и приостанавливает очередь.
* **Готовность к Docker:** Поставляется с готовыми `Dockerfile` и `docker-compose.yml`.

---

## 📋 Содержание

1. [Архитектура проекта](#-архитектура-проекта)
2. [Пошаговая инструкция: Генерация auth_state.json](#-пошаговая-инструкция-генерация-auth_statejson)
3. [Развертывание на сервере (Docker Compose)](#-развертывание-на-сервере-docker-compose)
4. [Запуск без Docker (Node.js)](#-запуск-без-docker-nodejs)
5. [Спецификация API (Endpoints & Payloads)](#-спецификация-api-endpoints--payloads)
6. [Управление сессией и обновление при протухании](#-управление-сессией-и-обновление-при-протухании)
7. [Диагностика и Healthcheck](#-диагностика-и-healthcheck)

---

## 🏗 Архитектура проекта

```
gemini_web_api_wrapper/
├── src/
│   ├── config.js         # Конфигурация, переменные окружения, Chromium flags
│   ├── errors.js         # Специфические классы ошибок (401, 429, 500)
│   ├── browser.js        # Singleton Browser Worker (Playwright, DOM, маршрутизация)
│   ├── parser.js         # Извлечение ответа и парсинг блоков кода (DOM + Markdown)
│   ├── queue.js          # FIFO-диспетчер очереди (p-queue, лимит 50)
│   └── server.js         # Fastify REST API сервер и обработчики сигналов
├── test/
│   └── api.test.js       # Тесты API (валидация, 401, 429, healthcheck)
├── generate_auth.js      # Локальный интерактивный скрипт для авторизации в Google
├── Dockerfile            # Базовый образ mcr.microsoft.com/playwright
├── docker-compose.yml    # Ограничения по памяти (1.5GB) и монтирование томов
├── .env.example          # Пример файла конфигурации
└── package.json          # Зависимости и скрипты
```

---

## 🔑 Пошаговая инструкция: Генерация `auth_state.json`

Google блокирует автоматический вход (Cloudflare/Bot detection/2FA) на удаленных VPS. Поэтому авторизация выполняется **один раз на вашем локальном компьютере** (Windows / macOS / Linux с графическим экраном).

### Шаг 1: Склонируйте проект или скопируйте файлы на свой ПК

Убедитесь, что на вашем локальном ПК установлен **Node.js** (версии 18, 20 или 22+).

```bash
cd gemini_web_api_wrapper
npm install
```

### Шаг 2: Установите локальный браузер Chromium для Playwright

```bash
npx playwright install chromium
```

### Шаг 3: Запустите скрипт интерактивной авторизации

```bash
npm run auth
# или: node generate_auth.js
```

### Шаг 4: Выполните вход в Google

1. Откроется видимое окно браузера с сайтом `https://gemini.google.com/app`.
2. Введите ваш логин Google (email), пароль и пройдите двухфакторную аутентификацию (2FA, подтверждение на телефоне или SMS).
3. Дождитесь, пока загрузится основной интерфейс Gemini (поле ввода промпта *"Спросите Gemini"* / *"Enter a prompt here"*).
4. Скрипт **автоматически обнаружит** поле ввода либо вы можете нажать **Enter** в окне терминала для сохранения.
5. В корне проекта будет создан файл:
   ```
   auth_state.json
   ```
   *Этот файл содержит cookies и localStorage авторизованной сессии Google.*

### Шаг 5: Перенесите `auth_state.json` на VPS

Скопируйте полученный файл `auth_state.json` на ваш удаленный сервер в папку проекта:

```bash
# Пример копирования через scp:
scp auth_state.json user@your-vps-ip:/path/to/gemini_web_api_wrapper/
```

> **Важно:** Файл `auth_state.json` содержит конфиденциальные сессионные ключи. Он автоматически добавлен в `.gitignore` и не должен попадать в публичные репозитории.

---

## 🚀 Развертывание на сервере (Docker Compose)

Рекомендуемый способ запуска на VPS — **Docker Compose**.

### 1. Подготовка на сервере

Убедитесь, что в директории проекта на сервере присутствует файл `auth_state.json`:

```bash
ls -la auth_state.json
```

Создайте `.env` файл из шаблона (при необходимости скорректируйте порт или лимиты):

```bash
cp .env.example .env
```

### 2. Запуск контейнера

```bash
docker compose up -d --build
```

### 3. Проверка статуса и логов

```bash
docker compose logs -f
```

Вы увидите сообщение об успешном старте Chromium и запуске API:

```
[BrowserWorker] Launching Chromium with low-RAM flags (headless: true)...
[BrowserWorker] Navigating to https://gemini.google.com/app...
[BrowserWorker] Browser worker successfully initialized and ready.
[Server] Gemini Web-to-API wrapper is listening on http://0.0.0.0:3000
```

---

## 💻 Запуск без Docker (Node.js)

Если вы запускаете проект напрямую на хосте:

```bash
# 1. Установка зависимостей
npm install

# 2. Установка зависимостей Chromium для Linux
npx playwright install --with-deps chromium

# 3. Запуск сервера
npm start
```

---

## 📡 Спецификация API (Endpoints & Payloads)

### 1. `POST /v1/chat/completions`

Основной эндпоинт отправки промптов и получения ответа.

#### Параметры запроса (JSON):

| Поле | Тип | Обязательное | Описание |
| :--- | :--- | :--- | :--- |
| `messages` | `Array<{role: string, content: string}>` | **Да** | Массив сообщений. Извлекается последнее сообщение пользователя (`role: "user"`). |
| `action` | `string` (`"continue"` \| `"new"`) | Нет (дефолт `"continue"`) | `"new"` — открывает новый чат Gemini. `"continue"` — удерживает или продолжает диалог. |
| `chat_id` | `string` | Нет | Идентификатор диалога. Позволяет удерживать сессию или переключаться по сохраненному URL чата. |
| `model` | `string` | Нет (дефолт `"gemini-4-neon"`) | Имя или идентификатор модели (например, `"gemini-4-neon"`, `"neon"`, `"gemini-4-hydrogen"`, `"hydrogen"`). В интерфейсе отображается как `"Neon"`, `"Hydrogen"`. |
| `thinking_level` | `string` (`"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"`) | Нет (дефолт `"high"`) | Уровень размышлений ИИ-модели (Thinking level). В интерфейсе Gemini отображается как `"High"`, `"Medium"`, `"Low"` и др. |

#### Пример запроса (Новый диалог с выбором модели):

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "user", "content": "Напиши краткое объяснение квантовой запутанности в 2 предложениях." }
    ],
    "action": "new",
    "chat_id": "session_quantum_42",
    "model": "gemini-4-neon",
    "thinking_level": "high"
  }'
```

#### Пример запроса (Продолжение диалога):

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "role": "user", "content": "А теперь переведи это на французский язык." }
    ],
    "action": "continue",
    "chat_id": "session_quantum_42",
    "model": "gemini-4-neon",
    "thinking_level": "high"
  }'
```

#### Формат успешного ответа (HTTP 200 OK):

Помимо полного текстового ответа `content`, объект сообщения содержит массив `code_blocks` со всеми извлеченными блоками кода (или пустой массив `[]`, если кода в ответе нет). Если язык блока определить не удалось, используется `"unknown"`.

```json
{
  "model": "gemini-4-neon",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Квантовая запутанность — это феномен...\n\n```python\nprint('Hello world')\n```",
        "code_blocks": [
          {
            "language": "python",
            "code": "print('Hello world')"
          }
        ]
      }
    }
  ]
}
```

---

### Статус-коды и ошибки

#### 1. Очередь переполнена (HTTP 429 Too Many Requests)
Возникает, если в очереди уже находится 50 ожидающих запросов:
```json
{
  "error": "Queue is full"
}
```

#### 2. Сессия истекла (HTTP 401 Unauthorized)
Возникает, если Google запросил повторный вход или сессионные куки протухли:
```json
{
  "error": "Session expired. Manual authentication required."
}
```

#### 3. Неверный формат запроса (HTTP 400 Bad Request)
Возникает при отсутствии поля `messages` или пустом тексте сообщения:
```json
{
  "error": "Invalid request payload",
  "details": "body/messages must NOT have fewer than 1 items"
}
```

---

## 🔄 Управление сессией и обновление при протухании

Google периодически (раз в несколько недель или месяцев) обновляет токены безопасности. Если сервер вернул `401 Unauthorized`, воркер **не пытается логиниться сам** и блокирует спам в сторону Google.

### Как обновить сессию без перезапуска сервера:

1. На локальном компьютере снова выполните:
   ```bash
   npm run auth
   ```
2. Скопируйте обновленный `auth_state.json` на сервер:
   ```bash
   scp auth_state.json user@your-vps-ip:/path/to/gemini_web_api_wrapper/
   ```
3. Вызовите эндпоинт горячей перезагрузки сессии:
   ```bash
   curl -X POST http://localhost:3000/v1/auth/reload
   ```
   Сервер перечитает файл `auth_state.json`, переинициализирует контекст браузера и снимет паузу с очереди.

---

## 🩺 Диагностика и Healthcheck

### `GET /health`

Возвращает текущее состояние воркера, загрузку очереди и потребление оперативной памяти процессом Node.js:

```bash
curl http://localhost:3000/health
```

#### Пример ответа:

```json
{
  "status": "ok",
  "sessionExpired": false,
  "isInitialized": true,
  "queue": {
    "waiting": 0,
    "running": 1,
    "maxQueueSize": 50,
    "isPausedForAuth": false
  },
  "memory": {
    "rssMb": 384,
    "heapUsedMb": 58,
    "heapTotalMb": 72
  }
}
```

---

## 🧪 Запуск автоматических тестов

В проект включен набор smoke-тестов, проверяющих валидацию схемы, поведение FIFO-очереди, обработку лимитов (429) и отказ при протухшей сессии (401):

```bash
npm test
```

---

## 🛡 Безопасность и Best Practices

* Сервер предназначен для использования в изолированной сети, за reverse-proxy (Nginx, Caddy, Cloudflare Tunnel) или с добавлением Bearer-токена авторизации.
* Не запускайте браузер под пользователем `root` (в Dockerfile используется `USER pwuser`).
* Ограничивайте частоту запросов в соответствии с разумными лимитами интерфейса Gemini, чтобы избежать временных ограничений Google.
