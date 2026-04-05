import { logger } from './logger.js';
import { connectToWhatsApp } from './bot.js';
import { closeDb } from './db.js';
import { startQueueProcessor } from './queue.js';
import { validateConfig } from './config.js';

const init = async () => {
    logger.info('[System] Initializing WhatsApp Auto-Reply Bot...');

    try {
        // Validate environment variables early
        validateConfig();

        const { sock, closeSocket } = await connectToWhatsApp();

        // Start the background worker that processes expired queues
        const processorInterval = startQueueProcessor(sock);

        /**
         * Orchestrates graceful shutdown of resources
         */
        const shutdown = () => {
            logger.info('\n[System] Graceful shutdown initiated...');

            clearInterval(processorInterval);

            // Clean up WhatsApp connection
            closeSocket();

            // Flush and close the database connection
            closeDb();

            logger.info('[System] Shutdown complete. Exiting.');
            process.exit(0);
        };

        // Bind graceful shutdown to system termination signals
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

    } catch (error) {
        logger.error(error as Error, '[System] Fatal error during initialization:');
        closeDb();
        process.exit(1);
    }
};

// Start the application
init();