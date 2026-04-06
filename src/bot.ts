import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    WAMessage,
    fetchLatestWaWebVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { enqueueMessage, clearQueue, isMessageKnown } from './db.js';
import { isBlacklisted, initializeBlacklist } from './blacklist.js';
import { logger } from './logger.js';
import { config } from './config.js';

// Define a strict Pino logger instance for Baileys to avoid verbose console spam
const baileysLogger = logger.child({});
baileysLogger.level = 'silent';

/**
 * Handles incoming messages, applying filters and inserting them into the database queue.
 *
 * @param sock The Baileys socket instance
 * @param messages Array of incoming WAMessages
 */
const handleIncomingMessages = async (sock: ReturnType<typeof makeWASocket>, messages: WAMessage[]): Promise<void> => {
    for (const msg of messages) {
        // Skip empty messages
        if (!msg.message) continue;

        const jid = msg.key.remoteJid;
        if (!jid) continue;

        // Filter out groups and broadcasts — bot is personal DMs only
        const isGroup = jid.endsWith('@g.us');
        const isBroadcast = jid === 'status@broadcast';

        if (isGroup || isBroadcast) {
            logger.debug({ jid, reason: isGroup ? 'group' : 'broadcast' }, '[Bot] Skipping non-DM message');
            continue;
        }

        const isFromMe = msg.key.fromMe;

        // Outgoing message — either a bot echo or a manual reply from the owner
        if (isFromMe) {
            if (msg.key.id && isMessageKnown(msg.key.id)) {
                // Bot echo: Baileys re-emits our own sent message — ignore silently
                logger.debug({ jid, messageId: msg.key.id }, '[Bot] Skipping bot echo');
                continue;
            }

            // Manual reply from owner: wipe the queue and reset session context
            logger.info({ jid }, '[Bot] Manual reply detected — clearing queue and resetting session context');
            try {
                clearQueue(jid);
            } catch (error) {
                logger.error({ err: error, jid }, '[Bot] Failed to clear queue on manual reply');
            }
            continue;
        }

        // Drop messages from blacklisted contacts before any processing
        if (isBlacklisted(jid, msg.pushName)) {
            logger.debug({ jid }, '[Bot] Message from blacklisted contact — skipped');
            continue;
        }

        // Extract text safely from the message payload
        const textContent =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text;

        if (!textContent) {
            // Non-text message (image, sticker, audio, etc.) — skip silently
            logger.debug({ jid, messageType: Object.keys(msg.message)[0] }, '[Bot] Skipping non-text message');
            continue;
        }

        logger.info({ jid, messageId: msg.key.id, content: textContent }, '[Bot] Incoming message received');

        const messageId = msg.key.id || Date.now().toString();
        // Baileys messageTimestamp is in seconds; convert to ms for SQLite consistency
        const timestamp = typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp * 1000
            : Date.now();

        try {
            enqueueMessage(jid, messageId, textContent, timestamp);
            logger.info({ jid, messageId, expiresInMs: config.queue.delayMs }, '[Bot] Message enqueued — timer started');
        } catch (error) {
            logger.error({ err: error, jid, messageId }, '[Bot] Failed to enqueue message');
        }
    }
};

/**
 * Initializes the WhatsApp connection, sets up event listeners, and handles session state.
 * Returns the socket instance and a cleanup function.
 */
export const connectToWhatsApp = async () => {
    // Initialize blacklist file on startup (creates if missing)
    initializeBlacklist();

    // Fetch latest WhatsApp Web version to prevent 405 Method Not Allowed/Version mismatch errors
    const { version, isLatest } = await fetchLatestWaWebVersion();
    logger.info({ version: version.join('.'), isLatest }, '[WhatsApp] Resolved WA web version');

    // Session state directory as per CLAUDE.md Docker volume requirements
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

    const sock = makeWASocket({
        version,
        auth: state,
        logger: logger as any,
        printQRInTerminal: false, // We'll handle QR manually to ensure it prints properly
        generateHighQualityLinkPreview: true,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            logger.info('\n[WhatsApp] Scan the QR code below to authenticate:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const error = lastDisconnect?.error as Boom | undefined;
            const statusCode = error?.output?.statusCode;

            // Reconnect if not explicitly logged out AND not replaced by another session
            const shouldReconnect =
                statusCode !== DisconnectReason.loggedOut &&
                statusCode !== DisconnectReason.connectionReplaced;

            logger.info({ statusCode, shouldReconnect }, '[WhatsApp] Connection closed');

            if (statusCode === DisconnectReason.connectionReplaced) {
                logger.warn('[WhatsApp] Connection replaced by another session — halting to avoid ping-pong conflict');
            } else if (statusCode === DisconnectReason.loggedOut) {
                logger.warn('[WhatsApp] Logged out — restart to scan a new QR code');
            } else if (shouldReconnect) {
                logger.info({ retryDelayMs: 2000 }, '[WhatsApp] Scheduling reconnect');
                setTimeout(connectToWhatsApp, 2000);
            }
        } else if (connection === 'open') {
            logger.info('[WhatsApp] Connection established successfully');
        }
    });

    // Save credentials whenever they are updated
    sock.ev.on('creds.update', saveCreds);

    // Listen to new incoming messages
    sock.ev.on('messages.upsert', async (event) => {
        // Only process new messages, skip history syncs ('append')
        if (event.type === 'notify') {
            await handleIncomingMessages(sock, event.messages);
        }
    });

    /**
     * Graceful termination function for the socket
     */
    const closeSocket = (): void => {
        logger.info('[WhatsApp] Closing socket connection...');
        sock.ws.close();
    };

    return { sock, closeSocket };
};