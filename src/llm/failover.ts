import { logger } from '../logger.js';
import { LLMProvider, ChatMessage } from './types.js';
import {
    getLLMProvider,
    getFallbackProvider,
    getPrimaryProviderType,
    getFallbackProviderType
} from './factory.js';
import { config } from '../config.js';

/**
 * Wraps LLM provider calls with retry and failover logic.
 * - Retries primary provider up to 3 times on failure with exponential backoff
 * - Falls back to alternate provider if available and primary exhausted
 * - Logs all attempts and transitions for observability
 *
 * Why: Separates resilience concerns (retries, failover) from provider implementations.
 * Each provider only knows how to call its API; this wrapper handles durability.
 * Keeps queue.ts clean — it only calls generateReply() on this wrapper, unaware of retries.
 * This is stateless per-request; fresh instance per queue cycle is acceptable overhead.
 */
export class FailoverLLMProvider implements LLMProvider {
    private primaryProvider: LLMProvider;
    private fallbackProvider: LLMProvider | null;
    private primaryType: string;
    private fallbackType: string | null;

    constructor() {
        this.primaryProvider = getLLMProvider();
        this.fallbackProvider = getFallbackProvider();
        this.primaryType = getPrimaryProviderType();
        this.fallbackType = getFallbackProviderType();
    }

    async generateReply(messages: ChatMessage[], systemPrompt: string): Promise<string> {
        const maxRetries = 3;
        let lastError: Error | null = null;

        // Attempt primary provider with up to maxRetries retries
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                logger.info(
                    { provider: this.primaryType, attempt, maxRetries },
                    '[Failover] Attempting primary provider'
                );
                const reply = await this.primaryProvider.generateReply(messages, systemPrompt);
                logger.info(
                    { provider: this.primaryType, attempt },
                    '[Failover] Primary provider succeeded'
                );
                return reply;
            } catch (error: unknown) {
                // Convert caught error to Error type for consistent handling
                lastError = error instanceof Error ? error : new Error(String(error));
                logger.warn(
                    { err: lastError, provider: this.primaryType, attempt, maxRetries },
                    '[Failover] Primary provider attempt failed'
                );
                // Exponential backoff: retryDelayMs * attempt before retrying
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, config.llm.retryDelayMs * attempt));
                }
            }
        }

        // Primary provider exhausted; attempt fallback if available
        if (this.fallbackProvider && this.fallbackType) {
            logger.info(
                { from: this.primaryType, to: this.fallbackType },
                '[Failover] Primary provider exhausted — switching to fallback'
            );
            try {
                const reply = await this.fallbackProvider.generateReply(messages, systemPrompt);
                logger.info(
                    { provider: this.fallbackType },
                    '[Failover] Fallback provider succeeded'
                );
                return reply;
            } catch (fallbackError: unknown) {
                // Convert caught error to Error type
                const fbErr = fallbackError instanceof Error
                    ? fallbackError
                    : new Error(String(fallbackError));
                logger.error(
                    { err: fbErr, provider: this.fallbackType },
                    '[Failover] Fallback provider also failed'
                );
                // Propagate fallback error; don't swallow
                throw fbErr;
            }
        }

        // No fallback available; propagate the last error from primary attempts
        logger.error(
            { err: lastError, provider: this.primaryType, hadFallback: false },
            '[Failover] Primary provider failed and no fallback available'
        );
        throw lastError || new Error('[Failover] Unknown error in primary provider');
    }
}
