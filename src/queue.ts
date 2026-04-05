import { logger } from './logger.js';
import makeWASocket from '@whiskeysockets/baileys';
import { getExpiredChats, getMessagesForChat, lockChatForProcessing, markChatReplied } from './db.js';
import { getLLMProvider } from './llm/factory.js';
import { ChatMessage } from './llm/types.js';
import { config } from './config.js';

/**
 * Processes queued messages whose timers have expired.
 * This is a pure function that fetches expired chats, queries the LLM, and dispatches the response.
 *
 * @param sock The Baileys socket instance
 */
export const processQueues = async (sock: ReturnType<typeof makeWASocket>): Promise<void> => {
    try {
        const expiredChats = getExpiredChats();

        if (expiredChats.length === 0) {
            return;
        }

        const llm = getLLMProvider();

        for (const chat of expiredChats) {
            logger.info(`[Queue Processor] Timer expired for ${chat.id}. Processing messages...`);

            // Lock the chat to prevent concurrent processing by the next interval tick
            lockChatForProcessing(chat.id);

            const messages = getMessagesForChat(chat.id);
            if (messages.length === 0) {
                // Somehow empty, just mark as replied to clean up state
                markChatReplied(chat.id);
                continue;
            }

            // Map DB records to ChatMessage format expected by LLMProvider
            const chatMessages: ChatMessage[] = messages.map(msg => ({
                role: 'user', // For now, all queued messages are from the remote user
                content: msg.content
            }));

            try {
                logger.info(`[Queue Processor] Requesting LLM response for ${chat.id}...`);
                const replyText = await llm.generateReply(chatMessages, config.llm.systemPrompt);

                if (replyText) {
                    logger.info(`[Queue Processor] Sending reply to ${chat.id}`);
                    await sock.sendMessage(chat.id, { text: replyText });
                }

                // Mark successful
                markChatReplied(chat.id);
            } catch (error) {
                logger.error(error as Error, `[Queue Processor] Error processing chat ${chat.id}:`);
                // In case of error, we can leave it in 'processing' or revert it.
                // Reverting it might cause an infinite error loop. We'll mark it replied/cleared
                // to avoid spamming the LLM API on failure, as per "graceful failure" constraint.
                markChatReplied(chat.id);
            }
        }
    } catch (error) {
        logger.error(error as Error, '[Queue Processor] Fatal error during queue processing loop:');
    }
};

/**
 * Starts the interval loop that checks for expired queues.
 * @param sock The Baileys socket instance
 * @returns The NodeJS timeout handle
 */
export const startQueueProcessor = (sock: ReturnType<typeof makeWASocket>): NodeJS.Timeout => {
    logger.info(`[System] Starting queue processor with a poll interval of ${config.queue.pollIntervalMs}ms`);
    return setInterval(() => {
        processQueues(sock);
    }, config.queue.pollIntervalMs);
};
