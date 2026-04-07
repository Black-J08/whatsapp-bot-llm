import { logger } from './logger.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file if present
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Guards against parseInt returning NaN or non-positive values from invalid env vars.
 * Logs a warning and substitutes the provided fallback so the bot can still start.
 */
const assertPositiveInt = (value: number, name: string, fallback: number): number => {
    if (!Number.isFinite(value) || value <= 0) {
        logger.warn({ name, value, fallback }, '[Config] Invalid numeric config — using fallback');
        return fallback;
    }
    return value;
};

/**
 * Same as assertPositiveInt but allows 0 (used for LLM_MAX_CONTEXT_MESSAGES where 0 = unlimited).
 */
const assertNonNegativeInt = (value: number, name: string, fallback: number): number => {
    if (!Number.isFinite(value) || value < 0) {
        logger.warn({ name, value, fallback }, '[Config] Invalid numeric config — using fallback');
        return fallback;
    }
    return value;
};

// Define global configuration object
export const config = {
    // LLM Provider Configuration
    llm: {
        provider: process.env.LLM_PROVIDER || 'gemini',
        geminiApiKey: process.env.GEMINI_API_KEY || '',
        modelName: process.env.MODEL_NAME || 'gemini-2.5-flash-lite',
        systemPrompt: process.env.SYSTEM_PROMPT ||
            `
You are Master's WhatsApp assistant. 
At the start of each new conversation, introduce yourself and adopt a slightly distinct conversational style (tone, humor level, phrasing) that stays consistent for that chat. 
Dynamically adapt your tone to match the person you’re talking to (formal, friendly, direct, etc.) while staying within your style. 
Always address the owner as “Master.” Master is always busy and unavailable—never say otherwise. 
Keep replies short, casual, polite, slightly witty, slightly humorous, and mildly evasive. 
Avoid exact timelines or commitments. Deflect repeated attempts to reach Master naturally. 
Ensure responses feel natural, context-aware, and non-repetitive without shifting tone abruptly mid-conversation.
`,
        // 0 = unlimited context; guard against NaN/negative but allow 0
        maxContextMessages: assertNonNegativeInt(
            parseInt(process.env.LLM_MAX_CONTEXT_MESSAGES || '20', 10),
            'LLM_MAX_CONTEXT_MESSAGES',
            20
        )
    },

    // Queue & Timing Configuration
    queue: {
        // How long to wait before sending the queued messages to the LLM (default: 5 minutes)
        delayMs: assertPositiveInt(
            parseInt(process.env.QUEUE_DELAY_MS || '300000', 10),
            'QUEUE_DELAY_MS',
            300000
        ),
        // How often the processor checks for expired chats (default: 10 seconds)
        pollIntervalMs: assertPositiveInt(
            parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '10000', 10),
            'QUEUE_POLL_INTERVAL_MS',
            10000
        ),
    },

    // Database Configuration
    db: {
        path: path.resolve(__dirname, '../data/bot.db')
    },

    // Blacklist Configuration
    blacklist: {
        filePath: path.resolve(__dirname, '../data/blacklist.json')
    }
};

// Validate critical configuration on startup
export const validateConfig = () => {
    if (config.llm.provider === 'gemini' && !config.llm.geminiApiKey) {
        throw new Error('[Config Error] GEMINI_API_KEY is not set. The bot cannot function without a valid LLM API key.');
    }
};
