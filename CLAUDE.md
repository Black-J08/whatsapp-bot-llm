## Project overview

WhatsApp auto-reply bot using `@whiskeysockets/baileys` and a modular `LLMProvider` abstraction. Supports Gemini (primary, when available) and Ollama (fallback, auto-selected from env credentials). Includes resilient retry + failover logic. Designed to run indefinitely as a single Docker container on localhost with no exposed ports.

## Architecture

### Request flow

```
Baileys WS event
  → handleIncomingMessages (bot.ts)
      → filter: skip groups (@g.us), broadcasts (status@broadcast)
      → isFromMe? → isMessageKnown()
          → known  → skip (bot echo, logged at debug)
          → unknown → clearQueue() — manual reply, session reset
      → isBlacklisted()? → skip (logged at info with match type)
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

### WhatsApp JID formats

Baileys v7 supports two JID formats. You can message any contact using either:

- **LID (`@lid`)**: `205037578002456@lid` — WhatsApp's new Local Identifier. Preferred and
  more reliable. All new Signal sessions default to LID.
- **PN (`@s.whatsapp.net`)**: `919876543210@s.whatsapp.net` — Legacy phone number format.
  Less reliable; avoid for new code.

**Detecting format** — use Baileys utilities, never manual string ops:
- `isPnUser(jid)` — true for `@s.whatsapp.net` (replaces removed `isJidUser`)
- `isLidUser(jid)` — true for `@lid`
- `isJidGroup(jid)` — true for `@g.us`
- `isJidStatusBroadcast(jid)` — true for `status@broadcast`
- `jidDecode(jid)?.user` — extracts local part (phone digits for PN; device ID for LID)

**`WAMessageKey` v7 additions:**
- `remoteJidAlt` — alternate JID for DMs (if `remoteJid` is LID, this is the PN, and
  vice versa). Use to enable phone-based matching when primary JID is LID-addressed.
- `participantAlt` — alternate participant JID for groups/broadcasts.
- `addressingMode` — `"pn"` or `"lid"` indicating which format was used.

**`Contact` v7 interface:**
- `id` — preferred identifier (may be LID or PN)
- `phoneNumber?` — present when `id` is a LID
- `lid?` — present when `id` is a PN
- No longer has a `jid` field.

**`pushName`** — `msg.pushName` is the contact's display name **only if they have saved
your number in their phone**. If null/undefined, the contact hasn't saved you.

### Blacklist feature

**Purpose**: Silently drop incoming messages from specified contacts before any processing (queueing, LLM calls).

**Implementation** (`src/blacklist.ts`):
- Hot-reload: reads `data/blacklist.json` on every message (no restart required for edits)
- Three identifier types:
  - **Full JID** (contains `@`): exact match against primary or alternate JID, e.g. `"205037578002456@lid"` or `"919876543210@s.whatsapp.net"`
  - **Phone number** (all digits): matches only PN-format JIDs (`@s.whatsapp.net`). Also checks `remoteJidAlt` so LID-addressed messages from a known PN are still caught, e.g. `"919876543210"`
  - **Display name** (string): case-insensitive match against `msg.pushName`, e.g. `"Dad"`
- Validates entries: filters out missing/invalid `identifier` field with warning logs
- Never throws: returns false (not blacklisted) on file read errors

**Data format** (`data/blacklist.json`):
```json
[
  {"identifier": "205037578002456@lid"},
  {"identifier": "919876543210"},
  {"identifier": "Dad"}
]
```

**Logging**:
- **Blacklist initialization**: path and file creation status at `info` level
- **File loading**: summary with total/valid/invalid counts at `info` level, invalid entries at `warn` level with index/reason
- **Contact matched**: blocked contact logged at `info` with jid, pushName, identifier, and match type
- **Contact not blocked**: logged at `debug` level for low-noise troubleshooting

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
- **Use Baileys JID utilities.** Never use manual string operations on JIDs. Use `isPnUser`, `isLidUser`, `isJidGroup`, `isJidStatusBroadcast`, and `jidDecode` from Baileys. Note: `isJidUser` was removed in v7 — use `isPnUser` instead.
- **`remoteJidAlt` for dual-format matching.** When checking identity against a user input (e.g. blacklist), check both `msg.key.remoteJid` and `msg.key.remoteJidAlt` to handle both LID-addressed and PN-addressed messages from the same contact.
- **Blacklist filtering happens early.** The `isBlacklisted()` check in `handleIncomingMessages` (after group/broadcast filter, before text extraction and queueing) ensures no blacklisted contact's messages are processed, queued, or sent to LLM.
- **No file-based caching for blacklist.** The list is read from disk on every incoming message (hot-reload). Module-level variables are forbidden to ensure manual edits to `data/blacklist.json` take effect immediately without restart.

## Environment variables

All config is read from `.env` via `src/config.ts`. See `README.md` for the full reference.

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | — | Gemini API key. Preferred provider when set. |
| `MODEL_NAME` | `gemini-3.1-flash-lite-preview` | Model identifier for Gemini. |
| `OLLAMA_API_KEY` | — | Ollama Cloud API key. Required to use Ollama as a provider. |
| `OLLAMA_BASE_URL` | `https://ollama.com/api` | Ollama Cloud API base URL. |
| `OLLAMA_MODEL_NAME` | `gemma4:31b-cloud` | Model identifier for Ollama. |
| `LLM_MAX_CONTEXT_MESSAGES` | `20` | Messages passed as context. `0` = unlimited. |
| `LLM_RETRY_DELAY_MS` | `100` | Base retry delay (ms); multiplied by attempt number for exponential backoff. |
| `SYSTEM_PROMPT` | (hardcoded default) | Instructions given to the LLM. |
| `QUEUE_DELAY_MS` | `300000` | Debounce delay before auto-reply fires (ms). |
| `QUEUE_POLL_INTERVAL_MS` | `10000` | Queue processor poll interval (ms). |
