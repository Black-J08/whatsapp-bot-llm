## Project Context & Architecture
WhatsApp auto-reply bot using `@whiskeysockets/baileys` and an agnostic LLM Provider abstraction (currently using Google Gemini `gemini-2.5-flash-lite`).

### Core Architectural Flow
1. **Connection & Auth:** Baileys WebSocket connects and stores session state locally in `auth_info_baileys/`. **Never modify this directory manually.**
2. **Event Queue & Delay Mechanism (The "Away" Logic):** 
   - Messages from personal DMs (`@s.whatsapp.net`) are written to the database `messages` table.
   - The chat is upserted into the `chats` table with a future `timer_expires_at` timestamp.
   - If the bot detects an outgoing message (`fromMe: true`) in that chat, the queue for that chat is immediately wiped.
3. **Queue Processor:** A background interval polls `chats` for expired timers.
4. **LLM Processing:** Expired chats are locked (`status='processing'`), queued messages are fetched and passed to the modular `LLMProvider` interface (via `llm/factory.ts`).
5. **Delivery:** The LLM response is sent back via Baileys. The chat is marked as `replied` and messages are cleaned up. No typing indicators are used.

### Deployment & Infrastructure Requirements
- **Docker Only Deployment:** The application must be containerized. It requires strict volume mounts for persistent data to prevent data loss:
  - Mount `./auth_info_baileys:/app/auth_info_baileys` (For WhatsApp session state).
  - Mount `./data:/app/data` (For the file-based database).
  - Mount `./logs:/app/logs` (For rotating application logs).
- **Localhost Networking Only:** The application must NOT expose ports to the outside network. `docker-compose.yml` uses `network_mode: "host"`.
- **File-Based Database:** State (queues, caching, and chat tracking) MUST be stored in `better-sqlite3` in the `/app/data` volume. In-memory Maps are strictly forbidden for long-running delays.
- **Resumability & Graceful Shutdown:** The entire system must be fully resumable. On `SIGINT`/`SIGTERM`, the app gracefully stops the queue processor, closes the Baileys socket, and flushes the database connection.

### Commands
- **Run dev:** `npm run dev` (Runs via `tsx`)
- **Build:** `npm run build` (Compiles TypeScript to `dist/`)
- **Run prod:** `npm start` (Runs compiled code)
- **Deploy:** `docker-compose up -d --build`
- **Lint:** `npm run lint`

### Technical Constraints & Rules
- **Pure Functions & Immutability:** DB queries are wrapped in pure functional exports. The event listener does not mutate global state.
- **Strict Typing:** All Baileys events, LLM interfaces, and DB schemas must be strictly typed. No `any`.
- **LLM Abstraction:** The system MUST use an adapter pattern (`LLMProvider`). Do not tightly couple the queue processor to a specific LLM API.
- **Centralized Structured Logging:** `console.log` and `console.error` are strictly forbidden. The system MUST use the centralized `pino` rotating logger (`src/logger.ts`) for all standard outputs and errors. Logs are rotated daily into `/logs/bot-log.log`.
- **Event Filtering:** Aggressively filter out group messages (`@g.us`), broadcasts (`status@broadcast`), and outgoing messages (`fromMe: true`) at the very top of the event listener to prevent infinite loops.
- **Error Handling:** Network disconnects from WhatsApp are normal. Reconnect logic must be explicit. Errors during LLM generation must be caught, logged using `logger.error()`, and silently ignored (do not crash the bot, do not send error text to the WhatsApp user).
