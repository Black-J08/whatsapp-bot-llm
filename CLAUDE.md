## Project overview

WhatsApp auto-reply bot using `@whiskeysockets/baileys` and a modular `LLMProvider` abstraction. Currently backed by Google Gemini (`gemini-2.5-flash-lite`). Designed to run indefinitely as a single Docker container on localhost with no exposed ports.

## Architecture

### Request flow

```
Baileys WS event
  → handleIncomingMessages (bot.ts)
      → filter: skip groups (@g.us), broadcasts (status@broadcast)
      → isFromMe? → isMessageKnown()
          → known  → skip (bot echo, logged at debug)
          → unknown → clearQueue() — manual reply, session reset
      → extract text (conversation | extendedTextMessage.text)
      → no text? → skip (non-text message, logged at debug)
      → enqueueMessage() — upserts chat timer, inserts message row
          ↓
Queue processor (queue.ts) — polls every QUEUE_POLL_INTERVAL_MS
  → getExpiredChats()
  → lockChatForProcessing()
  → getMessagesForChat() — last N messages, role-mapped (user/assistant)
  → llm.generateReply(messages, systemPrompt)
  → sock.sendMessage()
  → insertBotMessage() — saves bot reply for future context
  → markChatReplied()
```

### Conversational context

- Bot replies are persisted in the `messages` table (`is_from_me = 1`) and included as `role: 'assistant'` in subsequent LLM calls.
- A manual reply from the owner (`isFromMe: true`, not a known bot echo) calls `clearQueue()`, which deletes all messages for that chat, resetting the conversation session.
- Context window size is controlled by `LLM_MAX_CONTEXT_MESSAGES` (0 = unlimited).

### Database schema

```sql
chats (
  id TEXT PRIMARY KEY,          -- WhatsApp JID
  status TEXT NOT NULL,         -- 'queued' | 'processing' | 'replied'
  timer_expires_at INTEGER,     -- Unix ms — when to fire the auto-reply
  last_msg_timestamp INTEGER
)

messages (
  id TEXT PRIMARY KEY,          -- Baileys message key ID
  chat_id TEXT,                 -- FK → chats.id (CASCADE DELETE)
  content TEXT,
  timestamp INTEGER,            -- Unix ms
  is_from_me INTEGER            -- 0 = incoming user, 1 = bot auto-reply
)
```

## Commands

```bash
npm run dev                   # Run via tsx (development)
npm run build                 # Compile TypeScript → dist/
npm start                     # Run compiled output
npm run lint                  # Lint source files
docker-compose up -d --build  # Build and deploy
```

## Deployment requirements

- **Docker only.** The app must run containerised. Do not run bare `npm start` in production.
- **Volume mounts are mandatory** — data will not survive container restarts without them:
  - `./auth_info_baileys:/app/auth_info_baileys` — WhatsApp session state
  - `./data:/app/data` — SQLite database
  - `./logs:/app/logs` — rotating log files
- **No exposed ports.** `docker-compose.yml` uses `network_mode: "host"`. Do not change this.
- **Never modify `auth_info_baileys/` manually.** It is managed exclusively by Baileys.

## Technical constraints

- **No `console.log` / `console.error`.** All output must go through the `pino` logger in `src/logger.ts`.
- **Structured log fields only — no string interpolation.** Use `logger.info({ key: value }, 'message')` not `logger.info(`text ${value}`)`. Dynamic values belong in the fields object, never in the message string.
- **Log levels:** `info` for significant state changes (message received, reply sent, session reset), `warn` for unexpected but non-fatal conditions (empty LLM reply, missing message ID), `debug` for high-frequency internal transitions (DB mutations, echo skips, filter hits), `error` for caught failures with `{ err: error }` as the first field.
- **No `any` types.** All Baileys events, LLM interfaces, and DB schemas must be strictly typed.
- **No in-memory state for queues.** All pending timers and messages live in SQLite. In-memory Maps are forbidden.
- **LLM abstraction is mandatory.** The queue processor must only interact with the `LLMProvider` interface — never a concrete SDK directly.
- **Errors during LLM generation must not crash the bot** and must not send error text to the WhatsApp user. Catch, log with `logger.error()`, and mark the chat as replied to prevent retry loops.
- **Outgoing message filtering.** Baileys echoes the bot's own sent messages back as `fromMe: true` events. Guard against this with `isMessageKnown()` before calling `clearQueue()`.
- **Pure functional DB layer.** All queries in `db.ts` are exported as pure functions. No module-level mutable state.
- **Reconnection must be explicit.** Handle `DisconnectReason.loggedOut` and `DisconnectReason.connectionReplaced` as terminal — do not reconnect. All other disconnects should retry with a delay.

## Environment variables

All config is read from `.env` via `src/config.ts`. See `README.md` for the full reference.

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | — | Required. Google Gemini API key. |
| `LLM_PROVIDER` | `gemini` | LLM backend to use. |
| `MODEL_NAME` | `gemini-2.5-flash-lite` | Model identifier passed to the provider. |
| `LLM_MAX_CONTEXT_MESSAGES` | `20` | Messages passed as context. `0` = unlimited. |
| `SYSTEM_PROMPT` | (hardcoded default) | Instructions given to the LLM. |
| `QUEUE_DELAY_MS` | `300000` | Debounce delay before auto-reply fires (ms). |
| `QUEUE_POLL_INTERVAL_MS` | `10000` | Queue processor poll interval (ms). |
