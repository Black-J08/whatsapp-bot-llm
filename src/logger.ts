import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logDir = path.resolve(__dirname, '../logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const transport = pino.transport({
    targets: [
        {
            target: 'pino-roll',
            level: 'info',
            options: {
                file: path.join(logDir, 'bot-log'),
                frequency: 'daily',
                extension: '.log',
                mkdir: true,
                symlink: true
            }
        },
        {
            target: 'pino-pretty',
            level: 'info',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname'
            }
        }
    ]
});

export const logger = pino(transport);
