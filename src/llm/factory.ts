import { config } from '../config.js';
import { LLMProvider } from './types.js';
import { GeminiProvider } from './gemini.js';

// Module-level singleton — prevents allocating a new HTTP client on every queue poll tick.
let _instance: LLMProvider | null = null;

/**
 * Returns the configured LLM provider, creating it on first call and reusing it thereafter.
 */
export const getLLMProvider = (): LLMProvider => {
    if (_instance) return _instance;

    const providerType = config.llm.provider.toLowerCase();

    switch (providerType) {
        case 'gemini':
            _instance = new GeminiProvider(config.llm.geminiApiKey, config.llm.modelName);
            return _instance;
        // Additional providers (e.g., openai, anthropic) can be added here easily
        default:
            throw new Error(`Unsupported LLM provider: ${providerType}`);
    }
};
