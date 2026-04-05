export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface LLMProvider {
    /**
     * Generates a reply based on the queued messages and a system prompt.
     * @param messages Array of messages representing the context
     * @param systemPrompt The instructions for the LLM
     * @returns A promise resolving to the text response
     */
    generateReply(messages: ChatMessage[], systemPrompt: string): Promise<string>;
}
