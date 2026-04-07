import { logger } from './logger.js';
import Database from 'better-sqlite3';
import { normalizeJid } from './utils/jid.js';
import { config } from './config.js';

export { normalizeJid };

export const db = new Database(config.db.path, {
    // verbose: logger.info
});

// Enable WAL mode for better concurrency and performance
db.pragma('journal_mode = WAL');

// Initialize database schema
const initDb = () => {
    db.exec(`
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL, -- 'queued', 'processing', 'replied'
            timer_expires_at INTEGER NOT NULL,
            last_msg_timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            is_from_me INTEGER NOT NULL,
            FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
        );
    `);
    // Idempotent migration: full_jid stores the original JID before normalization so queue
    // logs can show phone/format context. Check if column exists via PRAGMA before adding.
    const columns = db.prepare(`PRAGMA table_info(chats)`).all() as Array<{ name: string }>;
    if (!columns.some(col => col.name === 'full_jid')) {
        db.exec(`ALTER TABLE chats ADD COLUMN full_jid TEXT NOT NULL DEFAULT ''`);
    }
    logger.info('[DB] Schema initialised');
};
initDb();

/**
 * Types for database records
 */
export interface ChatRecord {
    id: string;
    status: 'queued' | 'processing' | 'replied';
    timer_expires_at: number;
    last_msg_timestamp: number;
    full_jid: string;
}

export interface MessageRecord {
    id: string;
    chat_id: string;
    content: string;
    timestamp: number;
    is_from_me: number;
}

/**
 * Enqueues a message and updates the chat's timer.
 * Upserts the chat record to ensure the timer resets on new incoming messages.
 * jid must be provided; it will be normalized internally for the DB key while
 * the original full JID is stored in full_jid for richer log context in the queue.
 */
export const enqueueMessage = (jid: string, messageId: string, content: string, timestamp: number): void => {
    // chatId must be normalized before database insertion to prevent divergent context
    // and manual string parsing. Baileys jidDecode is the preferred approach.
    const expiresAt = Date.now() + config.queue.delayMs;
    const chatId = normalizeJid(jid);

    const upsertChat = db.prepare(`
        INSERT INTO chats (id, status, timer_expires_at, last_msg_timestamp, full_jid)
        VALUES (?, 'queued', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = 'queued',
            timer_expires_at = excluded.timer_expires_at,
            last_msg_timestamp = excluded.last_msg_timestamp,
            full_jid = excluded.full_jid
    `);

    const insertMsg = db.prepare(`
        INSERT OR IGNORE INTO messages (id, chat_id, content, timestamp, is_from_me)
        VALUES (?, ?, ?, ?, 0)
    `);

    const transaction = db.transaction(() => {
        upsertChat.run(chatId, expiresAt, timestamp, jid);
        insertMsg.run(messageId, chatId, content, timestamp);
    });

    try {
        transaction();
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error({ err, chatId, messageId }, '[DB] enqueueMessage transaction failed');
        throw err;
    }
    logger.debug({ chatId, messageId, expiresAt }, '[DB] Message enqueued and chat timer upserted');
};

/**
 * Clears the queue for a chat (e.g., when the user replies manually).
 * jid must be provided; it will be normalized internally.
 */
export const clearQueue = (jid: string): void => {
    const chatId = normalizeJid(jid);
    const transaction = db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
        db.prepare('UPDATE chats SET status = ? WHERE id = ?').run('replied', chatId);
    });
    try {
        transaction();
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error({ err, chatId }, '[DB] clearQueue transaction failed');
        throw err;
    }
    logger.info({ chatId }, '[DB] Queue cleared — all messages deleted and chat marked replied');
};

/**
 * Retrieves all chats whose timer has expired and are waiting for an auto-reply.
 */
export const getExpiredChats = (): ChatRecord[] => {
    return db.prepare('SELECT * FROM chats WHERE status = ? AND timer_expires_at <= ?')
             .all('queued', Date.now()) as ChatRecord[];
};

/**
 * Retrieves all queued messages for a specific chat, ordered by time.
 * jid must be provided; it will be normalized internally.
 */
export const getMessagesForChat = (jid: string): MessageRecord[] => {
    const chatId = normalizeJid(jid);
    // If config is set to 0, use -1 for SQLite LIMIT to retrieve all records
    const limit = config.llm.maxContextMessages === 0 ? -1 : config.llm.maxContextMessages;

    return db.prepare(`
        SELECT * FROM (
            SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?
        ) ORDER BY timestamp ASC
    `).all(chatId, limit) as MessageRecord[];
};

/**
 * Locks a chat for processing to prevent race conditions between poll ticks.
 * Warns if the UPDATE matches 0 rows — indicates the chat row is missing.
 * jid must be provided; it will be normalized internally.
 */
export const lockChatForProcessing = (jid: string): void => {
    const chatId = normalizeJid(jid);
    const result = db.prepare('UPDATE chats SET status = ? WHERE id = ?').run('processing', chatId);
    if (result.changes === 0) {
        logger.warn({ chatId }, '[DB] lockChatForProcessing: UPDATE matched 0 rows — chat may not exist');
    } else {
        logger.debug({ chatId }, '[DB] Chat locked for processing');
    }
};

/**
 * Marks a chat as successfully replied.
 * Warns if the UPDATE matches 0 rows — indicates the chat row is missing.
 * jid must be provided; it will be normalized internally.
 */
export const markChatReplied = (jid: string): void => {
    const chatId = normalizeJid(jid);
    const result = db.prepare('UPDATE chats SET status = ? WHERE id = ?').run('replied', chatId);
    if (result.changes === 0) {
        logger.warn({ chatId }, '[DB] markChatReplied: UPDATE matched 0 rows — chat may not exist');
    } else {
        logger.debug({ chatId }, '[DB] Chat marked as replied');
    }
};

/**
 * Inserts a message sent by the bot into the database to preserve conversational context.
 * jid must be provided; it will be normalized internally.
 */
export const insertBotMessage = (jid: string, messageId: string, content: string, timestamp: number): void => {
    const chatId = normalizeJid(jid);
    db.prepare(`
        INSERT OR IGNORE INTO messages (id, chat_id, content, timestamp, is_from_me)
        VALUES (?, ?, ?, ?, 1)
    `).run(messageId, chatId, content, timestamp);
    logger.debug({ chatId, messageId }, '[DB] Bot message inserted into context');
};

/**
 * Checks if a message ID already exists in the database.
 * Useful for differentiating bot echoes from human manual replies.
 */
export const isMessageKnown = (messageId: string): boolean => {
    const row = db.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId);
    return !!row;
};

/**
 * Safely closes the database connection.
 * Should be called during graceful shutdown.
 */
export const closeDb = (): void => {
    try {
        if (db.open) {
            db.close();
            logger.info('[DB] Database connection closed successfully');
        }
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error({ err }, '[DB] Failed to close database connection');
    }
};
