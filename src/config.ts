import { logger } from './logger.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file if present
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define global configuration object
export const config = {
    // LLM Provider Configuration
    llm: {
        provider: process.env.LLM_PROVIDER || 'gemini',
        geminiApiKey: process.env.GEMINI_API_KEY || '',
        modelName: process.env.MODEL_NAME || 'gemini-2.5-flash-lite',
        systemPrompt: process.env.SYSTEM_PROMPT ||
            `You are an AI assistant managing my personal WhatsApp while I am away.
Reply naturally, concisely, and helpfully based on the context of the queued messages.
Do not use placeholders, just answer directly. Maintain a polite and professional tone.`
    },

    // Queue & Timing Configuration
    queue: {
        // How long to wait before sending the queued messages to the LLM (default: 5 minutes)
        delayMs: parseInt(process.env.QUEUE_DELAY_MS || '300000', 10),
        // How often the processor checks for expired chats (default: 10 seconds)
        pollIntervalMs: parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '10000', 10),
    },

    // Database Configuration
    db: {
        path: path.resolve(__dirname, '../data/bot.db')
    }
};

// Validate critical configuration on startup
export const validateConfig = () => {
    if (config.llm.provider === 'gemini' && !config.llm.geminiApiKey) {
        logger.warn('[Config Warning] GEMINI_API_KEY is not set. The bot will not be able to auto-reply using Gemini.');
    }
};
