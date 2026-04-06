import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Represents a single blacklist entry.
 * The identifier can be:
 *  - A phone number (digits only, e.g. "9112345678")
 *  - A display name (no @ or pure digits, e.g. "John")
 *  - A full JID (contains @, e.g. "9112345678@s.whatsapp.net")
 */
export interface BlacklistEntry {
    identifier: string;
}

/**
 * Initializes the blacklist file on first run.
 * Creates an empty JSON array if the file doesn't exist.
 * Should be called during bot startup.
 */
export const initializeBlacklist = (): void => {
    try {
        // Ensure the data directory exists
        const dataDir = path.dirname(config.blacklist.filePath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
            logger.debug('[Blacklist] Created data directory');
        }

        // Create the blacklist file if it doesn't exist
        if (!fs.existsSync(config.blacklist.filePath)) {
            fs.writeFileSync(config.blacklist.filePath, JSON.stringify([], null, 2), 'utf-8');
            logger.info('[Blacklist] Initialized blacklist file with empty array');
        }
    } catch (error) {
        logger.error({ err: error }, '[Blacklist] Failed to initialize blacklist file');
    }
};

/**
 * Reads the blacklist file from disk. Hot-reload on every call ensures the list
 * is always in sync with manual file edits — no restart required.
 *
 * Returns an empty array if the file is missing or unreadable (logs the error).
 */
const loadBlacklist = (): BlacklistEntry[] => {
    try {
        // Return empty array if file doesn't exist yet
        if (!fs.existsSync(config.blacklist.filePath)) {
            return [];
        }

        // Read and parse the JSON file
        const content = fs.readFileSync(config.blacklist.filePath, 'utf-8');
        const entries = JSON.parse(content) as BlacklistEntry[];

        // Validate that entries is an array
        if (!Array.isArray(entries)) {
            logger.warn('[Blacklist] File does not contain a JSON array — treating as empty');
            return [];
        }

        return entries;
    } catch (error) {
        logger.error({ err: error }, '[Blacklist] Failed to read or parse blacklist file');
        return [];
    }
};

/**
 * Determines the type of identifier and returns the matching rule.
 * Returns true if the identifier matches the given jid and/or pushName.
 */
const isIdentifierMatch = (
    identifier: string,
    jid: string,
    pushName: string | null | undefined
): boolean => {
    // Full JID: contains @, match exactly against jid
    if (identifier.includes('@')) {
        return identifier === jid;
    }

    // Phone number: all digits, match against the numeric part of jid
    if (/^\d+$/.test(identifier)) {
        const phoneFromJid = jid.split('@')[0];
        return identifier === phoneFromJid;
    }

    // Display name: case-insensitive match against pushName
    return identifier.toLowerCase() === pushName?.toLowerCase();
};

/**
 * Checks if a JID and optional display name are on the blacklist.
 *
 * Reads the blacklist file on every call (hot-reload) to pick up manual edits
 * without requiring a bot restart. Safely returns false if the file is unreadable,
 * never throwing so the message handler is not disrupted.
 *
 * @param jid The sender's full WhatsApp JID, e.g. "9112345678@s.whatsapp.net"
 * @param pushName The sender's display name from Baileys (may be null or undefined)
 * @returns true if the sender is on the blacklist, false otherwise
 */
export const isBlacklisted = (
    jid: string,
    pushName: string | null | undefined
): boolean => {
    const entries = loadBlacklist();

    // Iterate entries and return true on first match
    for (const entry of entries) {
        if (isIdentifierMatch(entry.identifier, jid, pushName)) {
            return true;
        }
    }

    return false;
};
