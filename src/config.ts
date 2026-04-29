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
        systemPrompt: process.env.SYSTEM_PROMPT ||
            'You are Master\'s WhatsApp assistant. ' +
            'At the start of each new conversation, introduce yourself. ' +
            'Dynamically adapt your tone to match the person you\'re talking to (formal, friendly, direct, etc.) ' +
            'Always address the owner as "Master." Master is always busy and unavailable—never say otherwise. ' +
            'Keep replies short, casual, polite, slightly witty, slightly humorous, and mildly evasive. ' +
            'Avoid exact timelines or commitments. Deflect repeated attempts to reach Master naturally. ' +
            'Ensure responses feel natural, context-aware, and non-repetitive without shifting tone abruptly mid-conversation.',
        // 0 = unlimited context; guard against NaN/negative but allow 0
        maxContextMessages: assertNonNegativeInt(
            parseInt(process.env.LLM_MAX_CONTEXT_MESSAGES || '20', 10),
            'LLM_MAX_CONTEXT_MESSAGES',
            20
        ),
        // Base retry delay (ms) multiplied by attempt number for exponential backoff
        retryDelayMs: assertPositiveInt(
            parseInt(process.env.LLM_RETRY_DELAY_MS || '100', 10),
            'LLM_RETRY_DELAY_MS',
            100
        ),
        // Gemini configuration
        gemini: {
            apiKey: process.env.GEMINI_API_KEY || '',
            modelName: process.env.MODEL_NAME || 'gemini-3.1-flash-lite-preview',
        },
        // Ollama configuration
        ollama: {
            // True only when OLLAMA_API_KEY is explicitly set
            // Cloud always requires an API key; no key = not configured
            configured: !!process.env.OLLAMA_API_KEY,
            apiKey: process.env.OLLAMA_API_KEY || '',
            baseUrl: process.env.OLLAMA_BASE_URL || 'https://ollama.com/api',
            modelName: process.env.OLLAMA_MODEL_NAME || 'gemma4:31b-cloud',
        },
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
    const hasGemini = config.llm.gemini.apiKey;
    const hasOllama = config.llm.ollama.configured;

    if (!hasGemini && !hasOllama) {
        throw new Error(
            '[Config Error] No LLM provider credentials available. ' +
            'Set GEMINI_API_KEY or OLLAMA_API_KEY.'
        );
    }
};
