import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    WAMessage,
    fetchLatestWaWebVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { enqueueMessage, clearQueue, isMessageKnown } from './db.js';
import { logger } from './logger.js';

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

        // Architectural constraints from CLAUDE.md:
        // Filter out groups and broadcasts
        const isGroup = jid.endsWith('@g.us');
        const isBroadcast = jid === 'status@broadcast';

        if (isGroup || isBroadcast) continue;

        const isFromMe = msg.key.fromMe;

        // If the human owner replies manually, cancel any pending auto-reply queue
        // But if it's the bot echoing its own outgoing message, ignore it completely
        if (isFromMe) {
            if (msg.key.id && isMessageKnown(msg.key.id)) {
                continue; // It's our own bot message, skip it
            }

            try {
                clearQueue(jid);
            } catch (error) {
                logger.error(error as Error, `[Error] Failed to clear queue for ${jid}:`);
            }
            continue; // Stop further processing for outgoing messages
        }

        // Extract text safely from the message payload
        const textContent =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text;

        if (textContent) {
            logger.info(`[Message Received] From: ${jid} | Text: ${textContent}`);

            const messageId = msg.key.id || Date.now().toString();
            // Baileys messageTimestamp is in seconds, SQLite usually expects milliseconds in JS context
            const timestamp = typeof msg.messageTimestamp === 'number'
                ? msg.messageTimestamp * 1000
                : Date.now();

            try {
                // Enqueue the message. The DB layer handles upserting the timer logic.
                enqueueMessage(jid, messageId, textContent, timestamp);
                logger.info(`[Queue] Message enqueued for ${jid}. Waiting for timer.`);
            } catch (error) {
                logger.error(error as Error, `[Error] Failed to enqueue message for ${jid}:`);
            }
        }
    }
};

/**
 * Initializes the WhatsApp connection, sets up event listeners, and handles session state.
 * Returns the socket instance and a cleanup function.
 */
export const connectToWhatsApp = async () => {
    // Fetch latest WhatsApp Web version to prevent 405 Method Not Allowed/Version mismatch errors
    const { version, isLatest } = await fetchLatestWaWebVersion();
    logger.info(`[WhatsApp] Using WA v${version.join('.')}, isLatest: ${isLatest}`);

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

            logger.info(`[WhatsApp] Connection closed. Reason: ${statusCode}. Reconnecting: ${shouldReconnect}`);

            if (statusCode === DisconnectReason.connectionReplaced) {
                logger.info('[WhatsApp] Connection replaced by another session. Not reconnecting to avoid ping-pong conflict.');
            } else if (statusCode === DisconnectReason.loggedOut) {
                logger.info('[WhatsApp] Logged out. Please restart to scan a new QR code.');
            } else if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 2000);
            }
        } else if (connection === 'open') {
            logger.info('[WhatsApp] Connection established successfully!');
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