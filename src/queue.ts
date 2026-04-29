import { logger } from './logger.js';
import makeWASocket from '@whiskeysockets/baileys';
import { getExpiredChats, getMessagesForChat, lockChatForProcessing, markChatReplied, insertBotMessage } from './db.js';
import { FailoverLLMProvider } from './llm/failover.js';
import { ChatMessage } from './llm/types.js';
import { config } from './config.js';
import { contactLogFields } from './utils/jid.js';

/**
 * Processes queued messages whose timers have expired.
 * Fetches expired chats, builds conversational context, queries the LLM, and dispatches the response.
 */
export const processQueues = async (sock: ReturnType<typeof makeWASocket>): Promise<void> => {
    try {
        const expiredChats = getExpiredChats();

        if (expiredChats.length === 0) {
            return;
        }

        logger.info({ count: expiredChats.length }, '[Queue] Processing expired chats');

        const llm = new FailoverLLMProvider();

        for (const chat of expiredChats) {
            // Outer try/catch covers lockChatForProcessing and the no-messages branch.
            // The inner try/catch handles LLM failures. If any step throws unexpectedly,
            // the outer catch attempts to mark the chat replied to prevent it from being
            // stuck in 'processing' state across poll ticks.
            try {
                // Lock first to prevent the next poll tick from picking up the same chat.
                // chat.id is already normalized from the DB; DB functions handle normalization internally.
                lockChatForProcessing(chat.id);

                // Build contact context for all log lines in this loop iteration.
                // Falls back to chat.id (normalized) when full_jid is empty (pre-migration rows).
                const logCtx = contactLogFields(chat.full_jid || chat.id);

                logger.info({ ...logCtx }, '[Queue] Timer expired — locked for processing');

                const messages = getMessagesForChat(chat.id);
                if (messages.length === 0) {
                    // Chat has no messages (e.g. cleared mid-flight) — clean up state
                    logger.warn({ ...logCtx }, '[Queue] No messages found for expired chat — marking replied');
                    markChatReplied(chat.id);
                    continue;
                }

                // Map DB records to the role-tagged ChatMessage format expected by LLMProvider
                const chatMessages: ChatMessage[] = messages.map(msg => ({
                    role: msg.is_from_me ? 'assistant' : 'user',
                    content: msg.content
                }));

                logger.info({ ...logCtx, contextMessages: chatMessages.length }, '[Queue] Sending context to LLM');

                try {
                    const replyText = await llm.generateReply(chatMessages, config.llm.systemPrompt);

                    if (!replyText) {
                        logger.warn({ ...logCtx }, '[Queue] LLM returned empty reply — skipping send');
                        markChatReplied(chat.id);
                        continue;
                    }

                    logger.info({ ...logCtx, replyLength: replyText.length }, '[Queue] LLM reply received — sending');
                    // Use full_jid (with domain @lid/@s.whatsapp.net) for sendMessage; Baileys jidDecode requires it
                    const recipientJid = chat.full_jid || chat.id;
                    const sentMsg = await sock.sendMessage(recipientJid, { text: replyText });

                    if (sentMsg?.key?.id) {
                        const timestamp = typeof sentMsg.messageTimestamp === 'number'
                            ? sentMsg.messageTimestamp * 1000
                            : Date.now();
                        insertBotMessage(chat.id, sentMsg.key.id, replyText, timestamp);
                        logger.info({ ...logCtx, messageId: sentMsg.key.id }, '[Queue] Bot reply saved to context');
                    } else {
                        logger.warn({ ...logCtx }, '[Queue] Sent message has no key ID — bot reply not saved to context');
                    }

                    markChatReplied(chat.id);
                    logger.info({ ...logCtx }, '[Queue] Chat marked as replied');
                } catch (error: unknown) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    logger.error({ err, ...logCtx }, '[Queue] Error during LLM processing — marking replied to prevent retry loop');
                    // Mark replied rather than leaving in 'processing' to avoid an infinite retry loop on
                    // persistent LLM failures, as required by the graceful failure constraint.
                    markChatReplied(chat.id);
                }
            } catch (error: unknown) {
                // Catches failures in lockChatForProcessing, getMessagesForChat, or markChatReplied
                // (the no-messages branch). Attempts recovery to avoid a permanently stuck chat.
                const err = error instanceof Error ? error : new Error(String(error));
                logger.error({ err, chatId: chat.id }, '[Queue] Unhandled error in per-chat processing — attempting recovery');
                try {
                    markChatReplied(chat.id);
                } catch (recErr: unknown) {
                    const e = recErr instanceof Error ? recErr : new Error(String(recErr));
                    logger.error({ err: e, chatId: chat.id }, '[Queue] Recovery failed — chat may be stuck in processing state');
                }
            }
        }
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error({ err }, '[Queue] Fatal error in queue processing loop');
    }
};

/**
 * Starts the interval loop that checks for expired queues.
 */
export const startQueueProcessor = (sock: ReturnType<typeof makeWASocket>): NodeJS.Timeout => {
    logger.info({ pollIntervalMs: config.queue.pollIntervalMs }, '[Queue] Queue processor started');
    return setInterval(() => {
        processQueues(sock);
    }, config.queue.pollIntervalMs);
};
