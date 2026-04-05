import { config } from '../config.js';
import { LLMProvider } from './types.js';
import { GeminiProvider } from './gemini.js';

/**
 * Factory function to retrieve the configured LLM provider.
 */
export const getLLMProvider = (): LLMProvider => {
    const providerType = config.llm.provider.toLowerCase();

    switch (providerType) {
        case 'gemini':
            return new GeminiProvider(config.llm.geminiApiKey, config.llm.modelName);
        // Additional providers (e.g., openai, anthropic) can be added here easily
        default:
            throw new Error(`Unsupported LLM provider: ${providerType}`);
    }
};
