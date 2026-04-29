# whatsapp-bot-llm

A self-hosted WhatsApp "away assistant" that replies on your behalf using an LLM when you're unavailable. Built with [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys), `better-sqlite3`, and modular LLM provider support (Gemini or Ollama).

## How it works

The bot implements a **debounced queue** — it does not reply instantly. Instead:

1. An incoming personal DM is written to a persistent SQLite database and a countdown timer starts.
2. Every new message from the same contact resets the timer.
3. If the contact is on the **blocklist**, their message is silently dropped (no queueing, no LLM call).
4. If **you reply manually**, the queue and all conversation context for that chat are immediately wiped. The bot stays silent.
5. If the timer expires without a manual reply, the bot sends the full conversation history (up to a configurable limit) to the LLM and replies on your behalf.
6. The bot's reply is saved to the database so future responses have multi-turn context.

### Blocking contacts

Edit `data/blacklist.json` to block incoming messages from specific contacts. The file is hot-reloaded — changes take effect on the next message without restarting the bot.

**Format**:
```json
[
  {"identifier": "value"},
  {"identifier": "another_value"}
]
```

**Three identifier types:**

| Type | Format | Example | When to use |
|------|--------|---------|------------|
| **Full JID** | Contains `@` | `"205037578002456@lid"` or `"919876543210@s.whatsapp.net"` | Most reliable. Copy from logs. |
| **Phone number** | Digits only | `"919876543210"` | Only works with `@s.whatsapp.net` format (legacy clients). Does NOT work with `@lid` format. |
| **Display name** | Plain text | `"Dad"` | Case-insensitive. **Only works if contact has saved your number in their phone.** |

**Examples**:

```json
[
  {"identifier": "205037578002456@lid"},
  {"identifier": "919876543210@s.whatsapp.net"},
  {"identifier": "Dad"}
]
```

**To find a contact's JID**:
1. The contact sends a message.
2. Check `logs/current.log` for a line like `[Bot] Incoming message received` with `jid` field.
3. Copy the full JID and add it to `data/blacklist.json`.

**Notes**:
- Modern WhatsApp accounts use `@lid` format (device ID, not phone-based). Phone number matching doesn't work for these.
- Display name matching requires the contact to have saved your number. If `name: "N/A"` in logs, they haven't saved you yet.
- Entries with invalid/missing `identifier` field are skipped with warning logs. Always use the exact field name `"identifier"`.

## Stack

| Concern | Library |
|---|---|
| WhatsApp protocol | `@whiskeysockets/baileys` (WebSocket, no Puppeteer) |
| Database / queue | `better-sqlite3` (WAL mode, file-based) |
| LLM | Gemini (`@google/genai`) or Ollama, via `LLMProvider` adapter with automatic failover |
| Logging | `pino` + `pino-roll` (structured, daily-rotating) |
| Language | TypeScript 6, strict mode, ES Modules |

## Prerequisites

- Node.js 20+
- Docker & Docker Compose (production)
- One of: Google Gemini API key, or Ollama Cloud credentials (or local Ollama instance)

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
# ── LLM Provider ──────────────────────────────────────────────────────────────
# Gemini (preferred when key is present)
GEMINI_API_KEY=your-gemini-api-key-here
MODEL_NAME=gemini-3.1-flash-lite-preview

# Ollama (used when GEMINI_API_KEY is absent; always Ollama Cloud)
OLLAMA_API_KEY=your-ollama-api-key-here
OLLAMA_MODEL_NAME=gemma4:31b-cloud

# ── LLM Behaviour ─────────────────────────────────────────────────────────────
LLM_MAX_CONTEXT_MESSAGES=20
LLM_RETRY_DELAY_MS=100
# SYSTEM_PROMPT=

# ── Queue Timing ──────────────────────────────────────────────────────────────
QUEUE_DELAY_MS=300000
QUEUE_POLL_INTERVAL_MS=10000
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
| `./data` | `/app/data` | SQLite database + `blacklist.json` |
| `./logs` | `/app/logs` | Rotating log files |
| `./.env` | `/app/.env` (read-only) | Environment configuration |

> **Do not delete `auth_info_baileys/` manually.** This directory holds your authenticated session. Deleting it requires re-scanning a QR code.

> **The `./data` volume persists** `bot.db` (message queue) and `blacklist.json` (blocklist). Both files survive container restarts.

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
├── blacklist.ts      # Contact filtering — hot-reload file-based blocklist
└── llm/
    ├── types.ts      # LLMProvider interface and ChatMessage type
    ├── factory.ts    # Dual-provider factory with auto-selection and failover setup
    ├── failover.ts   # Retry + fallback wrapper (configurable delay, up to 3 retries)
    ├── gemini.ts     # Google Gemini adapter implementing LLMProvider
    └── ollama.ts     # Ollama Cloud / local adapter implementing LLMProvider
```

## LLM Provider selection

The system automatically detects available LLM credentials and selects a provider:

1. **Gemini is preferred** — if `GEMINI_API_KEY` is set, Gemini is used as the primary provider.
2. **Ollama is fallback** — if Gemini credentials are absent, Ollama (Cloud or local) is used.
3. **Automatic failover** — if the primary provider fails after 3 retries (with configurable `LLM_RETRY_DELAY_MS`), the system automatically switches to the alternate provider.

Both providers can be configured simultaneously for automatic failover (e.g. Gemini as primary, Ollama Cloud as backup).

## Adding a new LLM provider

1. Create `src/llm/<provider>.ts` implementing the `LLMProvider` interface from `src/llm/types.ts`.
2. Update `src/llm/factory.ts` to instantiate and manage the new provider alongside existing ones.
3. Add corresponding environment variables to `src/config.ts`.

## Troubleshooting

**QR code not appearing / auth loop**
Delete `auth_info_baileys/` and restart. A fresh QR will be generated.

**Bot not auto-replying**
Check `logs/current.log`. Verify `GEMINI_API_KEY` is set and `QUEUE_DELAY_MS` has elapsed.

**Multiple sessions conflict (disconnect code 440 / 405)**
Only one instance may run at a time. The bot detects `connectionReplaced` and halts reconnection automatically to avoid a ping-pong loop.

**Blocklist not working / still receiving replies from blocked contact**
1. Check `data/blacklist.json` format — must use `"identifier"` field name exactly.
2. Check `logs/current.log` for `[Blacklist]` messages to verify entry is valid.
3. Look for `[Blacklist] Skipping invalid entry` with the entry details to see what's wrong.
4. Common issue: wrong field name (e.g. `"MOM"` instead of `"identifier"`).
5. After fixing the JSON, the new blocklist is active on the next message (hot-reload, no restart needed).

**Logs**
Structured JSON logs rotate daily under `logs/`. The symlink `logs/current.log` always points to today's file. Use `grep -i blacklist logs/current.log` to debug blocklist issues.

## License

ISC
