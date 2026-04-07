import { jidDecode, isPnUser, isLidUser, isJidGroup, isJidStatusBroadcast } from '@whiskeysockets/baileys';
import { logger } from '../logger.js';

export { jidDecode, isPnUser, isLidUser, isJidGroup, isJidStatusBroadcast };

/**
 * Normalizes a WhatsApp JID to its local part for consistent mapping in the database.
 * Local part: phone digits for PN JIDs; device ID for LID JIDs.
 * Logs a warning and falls back to the full JID if jidDecode returns no user part
 * (e.g. broadcast JIDs or malformed inputs) to avoid storing an empty key.
 */
export const normalizeJid = (jid: string): string => {
    const decoded = jidDecode(jid);
    if (!decoded?.user) {
        logger.warn({ jid }, '[JID] jidDecode returned no user part — using full JID as fallback');
        return jid;
    }
    return decoded.user;
};

/**
 * Extracts the local part (phone number) from a PN JID.
 * Returns null for LID JIDs — local part is a device ID, not a phone number.
 */
export const extractPhoneFromJid = (jid: string): string | null => {
    // isPnUser checks for @s.whatsapp.net format
    if (!isPnUser(jid)) return null;
    // jidDecode splits "user@server" reliably; .user is the local part (phone digits)
    const decoded = jidDecode(jid);
    return decoded?.user ?? null;
};

/**
 * Builds a consistent contact context object for structured log fields.
 * Pino omits undefined keys — so LID contacts won't have a spurious phone field,
 * and contacts without a known name won't have a name field.
 * Use as: logger.info({ ...contactLogFields(jid, pushName), ...extra }, 'message')
 */
export const contactLogFields = (jid: string, pushName?: string | null) => ({
    jid,
    // undefined is omitted by Pino — avoids 'N/A' noise for LID contacts
    phone: extractPhoneFromJid(jid) ?? undefined,
    name: pushName ?? undefined,
});
