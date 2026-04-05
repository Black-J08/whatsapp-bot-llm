import { logger } from '../logger.js';
import { GoogleGenAI } from '@google/genai';
import { LLMProvider, ChatMessage } from './types.js';

export class GeminiProvider implements LLMProvider {
    private ai: GoogleGenAI;
    private modelName: string;

    constructor(apiKey: string, modelName: string) {
        if (!apiKey) {
            throw new Error('GEMINI_API_KEY is required for GeminiProvider');
        }
        this.ai = new GoogleGenAI({ apiKey });
        this.modelName = modelName;
    }

    async generateReply(messages: ChatMessage[], systemPrompt: string): Promise<string> {
        // Format the conversation history for Gemini
        // For simple implementations with flash-lite, formatting as a clear transcript is highly effective.
        const transcript = messages
            .map(m => `${m.role.toUpperCase()}: ${m.content}`)
            .join('\n');

        const promptContext = `Respond to the final message based on the following conversation context:\n\n${transcript}`;

        try {
            const response = await this.ai.models.generateContent({
                model: this.modelName,
                contents: promptContext,
                config: {
                    systemInstruction: systemPrompt
                }
            });

            return response.text || '';
        } catch (error) {
            logger.error(error as Error, '[GeminiProvider] Error generating response:');
            throw new Error('Failed to generate response from Gemini');
        }
    }
}
