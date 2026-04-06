import { logger } from './logger.js';
import Database from 'better-sqlite3';
import { config } from './config.js';

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
 */
export const enqueueMessage = (chatId: string, messageId: string, content: string, timestamp: number): void => {
    const expiresAt = Date.now() + config.queue.delayMs;

    const upsertChat = db.prepare(`
        INSERT INTO chats (id, status, timer_expires_at, last_msg_timestamp)
        VALUES (?, 'queued', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = 'queued',
            timer_expires_at = ?,
            last_msg_timestamp = ?
    `);

    const insertMsg = db.prepare(`
        INSERT OR IGNORE INTO messages (id, chat_id, content, timestamp, is_from_me)
        VALUES (?, ?, ?, ?, 0)
    `);

    const transaction = db.transaction(() => {
        upsertChat.run(chatId, expiresAt, timestamp, expiresAt, timestamp);
        insertMsg.run(messageId, chatId, content, timestamp);
    });

    transaction();
};

/**
 * Clears the queue for a chat (e.g., when the user replies manually).
 */
export const clearQueue = (chatId: string): void => {
    const transaction = db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
        db.prepare('UPDATE chats SET status = ? WHERE id = ?').run('replied', chatId);
    });
    transaction();
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
 */
export const getMessagesForChat = (chatId: string): MessageRecord[] => {
    // If config is set to 0, use -1 for SQLite LIMIT to retrieve all records
    const limit = config.llm.maxContextMessages === 0 ? -1 : config.llm.maxContextMessages;

    return db.prepare(`
        SELECT * FROM (
            SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?
        ) ORDER BY timestamp ASC
    `).all(chatId, limit) as MessageRecord[];
};

/**
 * Locks a chat for processing to prevent race conditions.
 */
export const lockChatForProcessing = (chatId: string): void => {
    db.prepare('UPDATE chats SET status = ? WHERE id = ?').run('processing', chatId);
};

/**
 * Marks a chat as successfully replied.
 * We no longer delete messages here so we can preserve conversation context.
 */
export const markChatReplied = (chatId: string): void => {
    db.prepare('UPDATE chats SET status = ? WHERE id = ?').run('replied', chatId);
};

/**
 * Inserts a message sent by the bot into the database to preserve conversational context.
 */
export const insertBotMessage = (chatId: string, messageId: string, content: string, timestamp: number): void => {
    db.prepare(`
        INSERT OR IGNORE INTO messages (id, chat_id, content, timestamp, is_from_me)
        VALUES (?, ?, ?, ?, 1)
    `).run(messageId, chatId, content, timestamp);
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
            logger.info('Database connection closed successfully.');
        }
    } catch (error) {
        logger.error(error, "Failed to close database connection:");
    }
};
