# whatsapp-bot-llm

A self-hosted WhatsApp "away assistant" that replies on your behalf using an LLM when you're unavailable. Built with [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys), `better-sqlite3`, and Google Gemini.

## How it works

The bot implements a **debounced queue** — it does not reply instantly. Instead:

1. An incoming personal DM is written to a persistent SQLite database and a countdown timer starts.
2. Every new message from the same contact resets the timer.
3. If **you reply manually**, the queue and all conversation context for that chat are immediately wiped. The bot stays silent.
4. If the timer expires without a manual reply, the bot sends the full conversation history (up to a configurable limit) to the LLM and replies on your behalf.
5. The bot's reply is saved to the database so future responses have multi-turn context.

## Stack

| Concern | Library |
|---|---|
| WhatsApp protocol | `@whiskeysockets/baileys` (WebSocket, no Puppeteer) |
| Database / queue | `better-sqlite3` (WAL mode, file-based) |
| LLM | `@google/genai` — Gemini, via an agnostic `LLMProvider` adapter |
| Logging | `pino` + `pino-roll` (structured, daily-rotating) |
| Language | TypeScript 6, strict mode, ES Modules |

## Prerequisites

- Node.js 20+
- Docker & Docker Compose (production)
- A Google Gemini API key

## Setup

**1. Clone and install**

```bash
git clone <repo-url>
cd whatsapp-bot-llm
npm install
```

**2. Configure environment**

Copy the example below into a `.env` file in the project root and fill in your values.

```env
# ── LLM ────────────────────────────────────────────────────────────────────────
GEMINI_API_KEY=your_google_gemini_api_key
LLM_PROVIDER=gemini
MODEL_NAME=gemini-2.5-flash-lite

# Max messages passed to the LLM for context. Set to 0 for unlimited.
LLM_MAX_CONTEXT_MESSAGES=20

# Override the default system prompt (optional)
# SYSTEM_PROMPT="You are an AI assistant managing my personal WhatsApp..."

# ── Queue & timing ──────────────────────────────────────────────────────────────
# Delay before auto-replying after the last message (milliseconds)
QUEUE_DELAY_MS=300000        # 5 minutes

# How often the background processor checks for expired timers (milliseconds)
QUEUE_POLL_INTERVAL_MS=10000 # 10 seconds
```

**3. Run in development**

```bash
npm run dev
```

On the first run a QR code is printed to the terminal. Scan it in WhatsApp → **Linked Devices → Link a device**.

## Deployment

The application is designed to run as a single Docker container with host networking (no exposed ports).

```bash
docker-compose up -d --build
```

**Required volume mounts** (defined in `docker-compose.yml`):

| Host path | Container path | Purpose |
|---|---|---|
| `./auth_info_baileys` | `/app/auth_info_baileys` | WhatsApp session state |
| `./data` | `/app/data` | SQLite database |
| `./logs` | `/app/logs` | Rotating log files |
| `./.env` | `/app/.env` (read-only) | Environment configuration |

> **Do not delete `auth_info_baileys/` manually.** This directory holds your authenticated session. Deleting it requires re-scanning a QR code.

## Commands

```bash
npm run dev      # Run with tsx (development, hot-reload)
npm run build    # Compile TypeScript → dist/
npm start        # Run compiled output (production)
npm run lint     # Lint source files
docker-compose up -d --build  # Build image and deploy
```

## Project structure

```
src/
├── index.ts          # Entry point — wires up bot, queue processor, and shutdown
├── bot.ts            # Baileys connection, event filtering, message enqueueing
├── queue.ts          # Background processor — LLM calls and reply dispatch
├── db.ts             # All SQLite queries as pure functional exports
├── config.ts         # Centralised config parsed from environment variables
├── logger.ts         # Pino logger with daily-rotating file transport
└── llm/
    ├── types.ts      # LLMProvider interface and ChatMessage type
    ├── factory.ts    # Provider factory — resolves LLM_PROVIDER at runtime
    └── gemini.ts     # Google Gemini adapter implementing LLMProvider
```

## Adding a new LLM provider

1. Create `src/llm/<provider>.ts` implementing the `LLMProvider` interface from `src/llm/types.ts`.
2. Add a case for it in `src/llm/factory.ts`.
3. Set `LLM_PROVIDER=<provider>` in `.env`.

## Troubleshooting

**QR code not appearing / auth loop**
Delete `auth_info_baileys/` and restart. A fresh QR will be generated.

**Bot not auto-replying**
Check `logs/current.log`. Verify `GEMINI_API_KEY` is set and `QUEUE_DELAY_MS` has elapsed.

**Multiple sessions conflict (disconnect code 440 / 405)**
Only one instance may run at a time. The bot detects `connectionReplaced` and halts reconnection automatically to avoid a ping-pong loop.

**Logs**
Structured JSON logs rotate daily under `logs/`. The symlink `logs/current.log` always points to today's file.

## License

ISC
