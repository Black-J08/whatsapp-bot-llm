import { logger } from '../logger.js';
import { LLMProvider, ChatMessage } from './types.js';

export class OllamaProvider implements LLMProvider {
    private baseUrl: string;
    private modelName: string;
    private apiKey: string | null;

    constructor(baseUrl: string, modelName: string, apiKey?: string) {
        // baseUrl is required — validate it exists
        if (!baseUrl) {
            throw new Error('baseUrl is required for OllamaProvider');
        }
        this.baseUrl = baseUrl;
        this.modelName = modelName;
        // apiKey is optional (for local Ollama) — store null if not provided
        this.apiKey = apiKey || null;
    }

    async generateReply(messages: ChatMessage[], systemPrompt: string): Promise<string> {
        // Prepend system instruction to messages array — Ollama API expects full conversation
        const allMessages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...messages
        ];

        // Build request payload for Ollama POST /api/chat endpoint
        const payload = {
            model: this.modelName,
            messages: allMessages,
            stream: false // Non-streaming single response
        };

        try {
            // Build headers — always include Content-Type
            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };

            // Add Bearer token only if apiKey is present (Ollama Cloud auth)
            if (this.apiKey) {
                headers['Authorization'] = `Bearer ${this.apiKey}`;
            }

            // Make POST request to Ollama chat endpoint
            // Note: baseUrl already includes /api (e.g., https://ollama.com/api), so append /chat directly
            const response = await fetch(`${this.baseUrl}/chat`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            // Check for HTTP errors
            if (!response.ok) {
                throw new Error(
                    `Ollama API returned ${response.status}: ${response.statusText}`
                );
            }

            // Parse JSON response — Ollama returns { message: { content: string } }
            const data = await response.json() as { message: { content: string } };

            // Return content string or empty string if missing (defensive)
            return data.message.content || '';
        } catch (error: unknown) {
            // Re-throw with structured logging — queue.ts catches it for chat context
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error({ err }, '[OllamaProvider] Ollama API request failed');
            throw err;
        }
    }
}
