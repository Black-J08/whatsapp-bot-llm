import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { logger } from './logger.js';
import { isPnUser, isLidUser, jidDecode } from './utils/jid.js';

/**
 * Represents a single blacklist entry.
 * The identifier can be:
 *  - A full JID (contains @): exact match, e.g. "9112345678@s.whatsapp.net" or "205037578002456@lid"
 *  - A phone number (digits only): matches PN JIDs only; LID JIDs have no phone, e.g. "919876543210"
 *  - A display name (anything else): case-insensitive match against pushName, e.g. "John"
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
            logger.info({ path: dataDir }, '[Blacklist] Created data directory');
        }

        // Create the blacklist file if it doesn't exist
        if (!fs.existsSync(config.blacklist.filePath)) {
            fs.writeFileSync(config.blacklist.filePath, JSON.stringify([], null, 2), 'utf-8');
            logger.info(
                { filePath: config.blacklist.filePath },
                '[Blacklist] Initialized blacklist file with empty array'
            );
        } else {
            logger.info({ filePath: config.blacklist.filePath }, '[Blacklist] Blacklist file already exists');
        }
    } catch (error) {
        logger.error(
            { err: error, filePath: config.blacklist.filePath },
            '[Blacklist] Failed to initialize blacklist file'
        );
    }
};

/**
 * Reads the blacklist file from disk. Hot-reload on every call ensures the list
 * is always in sync with manual file edits — no restart required.
 *
 * Returns an empty array if the file is missing or unreadable (logs the error).
 * Filters out invalid entries (missing or empty identifier).
 */
const loadBlacklist = (): BlacklistEntry[] => {
    try {
        // Return empty array if file doesn't exist yet
        if (!fs.existsSync(config.blacklist.filePath)) {
            logger.debug({ filePath: config.blacklist.filePath }, '[Blacklist] File does not exist');
            return [];
        }

        // Read and parse the JSON file
        const content = fs.readFileSync(config.blacklist.filePath, 'utf-8');
        const entries = JSON.parse(content) as BlacklistEntry[];

        // Validate that entries is an array
        if (!Array.isArray(entries)) {
            logger.error(
                { filePath: config.blacklist.filePath, type: typeof entries },
                '[Blacklist] File does not contain a JSON array — treating as empty'
            );
            return [];
        }

        // Filter out invalid entries (missing or empty identifier)
        const invalidEntries: unknown[] = [];
        const validEntries = entries.filter((entry, index) => {
            if (!entry || typeof entry !== 'object') {
                logger.warn(
                    { index, entry: JSON.stringify(entry), reason: 'not an object' },
                    '[Blacklist] Skipping invalid entry'
                );
                invalidEntries.push(entry);
                return false;
            }
            if (!entry.identifier || typeof entry.identifier !== 'string') {
                logger.warn(
                    { index, entry: JSON.stringify(entry), reason: 'missing or invalid identifier field' },
                    '[Blacklist] Skipping invalid entry'
                );
                invalidEntries.push(entry);
                return false;
            }
            return true;
        });

        // Log summary
        if (validEntries.length > 0 || invalidEntries.length > 0) {
            logger.info(
                { totalLoaded: entries.length, validCount: validEntries.length, invalidCount: invalidEntries.length },
                '[Blacklist] File loaded and validated'
            );
        }

        return validEntries;
    } catch (error) {
        logger.error(
            { err: error, filePath: config.blacklist.filePath },
            '[Blacklist] Failed to read or parse blacklist file'
        );
        return [];
    }
};

/**
 * Determines the type of identifier and returns the matching rule.
 * Returns true if the identifier matches the given jid, altJid, and/or pushName.
 * Safely handles invalid identifiers (never throws).
 */
const isIdentifierMatch = (
    identifier: string | undefined,
    jid: string,
    altJid: string | null | undefined,
    pushName: string | null | undefined
): boolean => {
    // Defensive check: invalid identifier
    if (!identifier || typeof identifier !== 'string') {
        return false;
    }

    // Full JID: exact match against primary JID or alternate JID
    // Checks both because of LID/PN dual addressing: if remoteJid is LID, remoteJidAlt is PN (and vice versa)
    if (identifier.includes('@')) {
        return identifier === jid || (altJid != null && identifier === altJid);
    }

    // Phone number: only match PN JIDs — LIDs have no extractable phone
    // Checks both primary and alternate JID because message might arrive either way
    if (/^\d+$/.test(identifier)) {
        // Check primary JID if it's a PN
        if (isPnUser(jid)) {
            const phoneFromJid = jidDecode(jid)?.user;
            if (phoneFromJid != null && identifier === phoneFromJid) return true;
        }
        // Check alternate JID if it's a PN (primary was LID-addressed)
        if (altJid != null && isPnUser(altJid)) {
            const phoneFromAlt = jidDecode(altJid)?.user;
            if (phoneFromAlt != null && identifier === phoneFromAlt) return true;
        }
        return false;
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
 * @param jid The sender's full WhatsApp JID, e.g. "9112345678@s.whatsapp.net" or "205037578002456@lid"
 * @param altJid The alternate JID (remoteJidAlt from WAMessageKey) for dual-format matching
 * @param pushName The sender's display name from Baileys (may be null or undefined)
 * @returns true if the sender is on the blacklist, false otherwise
 */
export const isBlacklisted = (
    jid: string,
    altJid: string | null | undefined,
    pushName: string | null | undefined
): boolean => {
    const entries = loadBlacklist();

    // Iterate entries and return true on first match
    for (const entry of entries) {
        if (isIdentifierMatch(entry.identifier, jid, altJid, pushName)) {
            // Determine which type of identifier matched for logging
            let matchType = 'name';
            if (entry.identifier.includes('@')) {
                matchType = 'jid';
            } else if (/^\d+$/.test(entry.identifier)) {
                matchType = 'phone';
            }

            logger.info(
                { jid, altJid: altJid ?? 'N/A', pushName: pushName || 'N/A', identifier: entry.identifier, matchType },
                '[Blacklist] Contact matched — blocking'
            );
            return true;
        }
    }

    logger.debug({ jid, altJid: altJid ?? 'N/A', pushName: pushName || 'N/A' }, '[Blacklist] Contact not on list');
    return false;
};
