import { config } from '../config.js';
import { logger } from '../logger.js';
import { LLMProvider } from './types.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';

// Singleton instances for both providers (for failover).
// Never reassigned after initialization — ensures consistent behavior across queue polls.
let _primaryInstance: LLMProvider | null = null;
let _fallbackInstance: LLMProvider | null = null;
let _primaryType: 'gemini' | 'ollama' | null = null;
let _fallbackType: 'gemini' | 'ollama' | null = null;

/**
 * Validates provider credentials and returns available providers.
 * Why: Enables failover by knowing which providers are configured and can be initialized.
 * Catches init errors (e.g., missing module, invalid config) and logs them as warnings
 * rather than crashing, so the bot can fall back to an alternate provider if available.
 */
const getAvailableProviders = (): {
    gemini: LLMProvider | null;
    ollama: LLMProvider | null;
} => {
    const available = {
        gemini: null as LLMProvider | null,
        ollama: null as LLMProvider | null
    };

    // Try Gemini: requires apiKey; no fallback URL
    if (config.llm.gemini.apiKey) {
        try {
            available.gemini = new GeminiProvider(
                config.llm.gemini.apiKey,
                config.llm.gemini.modelName
            );
        } catch (error: unknown) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.warn({ err }, '[Factory] Gemini provider initialization failed');
        }
    }

    // Try Ollama: only if OLLAMA_API_KEY is explicitly set (configured flag)
    // baseUrl is not a reliable indicator since it has a default value
    if (config.llm.ollama.configured) {
        try {
            available.ollama = new OllamaProvider(
                config.llm.ollama.baseUrl,
                config.llm.ollama.modelName,
                config.llm.ollama.apiKey || undefined
            );
        } catch (error: unknown) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.warn({ err }, '[Factory] Ollama provider initialization failed');
        }
    }

    return available;
};

/**
 * Selects primary and fallback providers based on credential availability.
 * Prefers Gemini (more reliable, feature-complete); falls back to Ollama if Gemini unavailable.
 * Why: Credential-based preference ensures we use the most capable provider when available,
 * and gracefully degrade to Ollama if Gemini is misconfigured or down.
 * Sets module-level singletons _primaryInstance, _primaryType, _fallbackInstance, _fallbackType.
 * Throws if neither provider can be initialized.
 */
const selectProviders = (): void => {
    const available = getAvailableProviders();

    // Prefer Gemini (primary choice if credentials are valid)
    if (available.gemini) {
        _primaryInstance = available.gemini;
        _primaryType = 'gemini';
        _fallbackInstance = available.ollama;
        _fallbackType = available.ollama ? 'ollama' : null;
        logger.info(
            { primary: 'gemini', fallback: _fallbackType || 'none' },
            '[Factory] Provider selection complete'
        );
        return;
    }

    // Fall back to Ollama (if Gemini not available)
    if (available.ollama) {
        _primaryInstance = available.ollama;
        _primaryType = 'ollama';
        _fallbackInstance = null;
        _fallbackType = null;
        logger.info(
            { primary: 'ollama', fallback: 'none' },
            '[Factory] Provider selection complete'
        );
        return;
    }

    // Neither provider is available — bot cannot function
    throw new Error(
        '[Factory] No LLM provider credentials available. ' +
        'Set GEMINI_API_KEY or (OLLAMA_API_KEY and OLLAMA_BASE_URL).'
    );
};

/**
 * Returns the primary LLM provider, selecting on first call.
 * Subsequent calls return the cached singleton without reinitializing.
 * selectProviders() either sets _primaryInstance or throws, so after it returns,
 * _primaryInstance is guaranteed non-null.
 */
export const getLLMProvider = (): LLMProvider => {
    if (_primaryInstance) return _primaryInstance;
    selectProviders();
    // selectProviders() guarantees _primaryInstance is non-null or throws
    return _primaryInstance as unknown as LLMProvider;
};

/**
 * Returns the fallback provider if available, null otherwise.
 * Why: Needed for failover logic in retry wrapper (src/llm/failover.ts).
 * Ensures selectProviders has run before returning.
 */
export const getFallbackProvider = (): LLMProvider | null => {
    if (!_primaryInstance) getLLMProvider(); // Ensure selection has run
    return _fallbackInstance;
};

/**
 * Returns the primary provider type ('gemini' or 'ollama') for logging and metrics.
 * Ensures selectProviders has run before returning.
 */
export const getPrimaryProviderType = (): 'gemini' | 'ollama' => {
    if (!_primaryInstance) getLLMProvider();
    return _primaryType as 'gemini' | 'ollama';
};

/**
 * Returns the fallback provider type ('gemini', 'ollama', or null) for logging.
 * Null means no fallback is available.
 * Ensures selectProviders has run before returning.
 */
export const getFallbackProviderType = (): 'gemini' | 'ollama' | null => {
    if (!_primaryInstance) getLLMProvider();
    return _fallbackType;
};
