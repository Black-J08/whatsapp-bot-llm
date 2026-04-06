import { logger } from './logger.js';
import makeWASocket from '@whiskeysockets/baileys';
import { getExpiredChats, getMessagesForChat, lockChatForProcessing, markChatReplied, insertBotMessage } from './db.js';
import { getLLMProvider } from './llm/factory.js';
import { ChatMessage } from './llm/types.js';
import { config } from './config.js';

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

        const llm = getLLMProvider();

        for (const chat of expiredChats) {
            // Lock first to prevent the next poll tick from picking up the same chat
            lockChatForProcessing(chat.id);
            logger.info({ chatId: chat.id }, '[Queue] Timer expired — locked for processing');

            const messages = getMessagesForChat(chat.id);
            if (messages.length === 0) {
                // Chat has no messages (e.g. cleared mid-flight) — clean up state
                logger.warn({ chatId: chat.id }, '[Queue] No messages found for expired chat — marking replied');
                markChatReplied(chat.id);
                continue;
            }

            // Map DB records to the role-tagged ChatMessage format expected by LLMProvider
            const chatMessages: ChatMessage[] = messages.map(msg => ({
                role: msg.is_from_me ? 'assistant' : 'user',
                content: msg.content
            }));

            logger.info({ chatId: chat.id, contextMessages: chatMessages.length }, '[Queue] Sending context to LLM');

            try {
                const replyText = await llm.generateReply(chatMessages, config.llm.systemPrompt);

                if (!replyText) {
                    logger.warn({ chatId: chat.id }, '[Queue] LLM returned empty reply — skipping send');
                    markChatReplied(chat.id);
                    continue;
                }

                logger.info({ chatId: chat.id, replyLength: replyText.length }, '[Queue] LLM reply received — sending');
                const sentMsg = await sock.sendMessage(chat.id, { text: replyText });

                if (sentMsg?.key?.id) {
                    const timestamp = typeof sentMsg.messageTimestamp === 'number'
                        ? sentMsg.messageTimestamp * 1000
                        : Date.now();
                    insertBotMessage(chat.id, sentMsg.key.id, replyText, timestamp);
                    logger.info({ chatId: chat.id, messageId: sentMsg.key.id }, '[Queue] Bot reply saved to context');
                } else {
                    logger.warn({ chatId: chat.id }, '[Queue] Sent message has no key ID — bot reply not saved to context');
                }

                markChatReplied(chat.id);
                logger.info({ chatId: chat.id }, '[Queue] Chat marked as replied');
            } catch (error) {
                logger.error({ err: error, chatId: chat.id }, '[Queue] Error during LLM processing — marking replied to prevent retry loop');
                // Mark replied rather than leaving in 'processing' to avoid an infinite retry loop on
                // persistent LLM failures, as required by the graceful failure constraint.
                markChatReplied(chat.id);
            }
        }
    } catch (error) {
        logger.error({ err: error }, '[Queue] Fatal error in queue processing loop');
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
