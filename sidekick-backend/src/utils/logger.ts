import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Log file in the project root
const LOG_FILE = path.join(__dirname, '../../sidekick-server.log');

class Logger {
    private static instance: Logger;

    private constructor() {
        // Ensure file exists or create it
        if (!fs.existsSync(LOG_FILE)) {
            fs.writeFileSync(LOG_FILE, `--- SIDEKICK SERVER LOG START: ${new Date().toISOString()} ---\n`);
        }
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    private formatMessage(level: string, message: string, ...args: any[]): string {
        const timestamp = new Date().toISOString();
        let formattedArgs = '';
        if (args.length > 0) {
            formattedArgs = ' ' + args.map(arg =>
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
        }
        return `[${timestamp}] [${level}] ${message}${formattedArgs}\n`;
    }

    private write(content: string) {
        try {
            fs.appendFileSync(LOG_FILE, content);
            // Also write to console
            process.stdout.write(content);
        } catch (err) {
            console.error('Failed to write to log file:', err);
        }
    }

    public log(message: string, ...args: any[]) {
        this.write(this.formatMessage('LOG', message, ...args));
    }

    public info(message: string, ...args: any[]) {
        this.write(this.formatMessage('INFO', message, ...args));
    }

    public error(message: string, ...args: any[]) {
        this.write(this.formatMessage('ERROR', message, ...args));
    }

    public warn(message: string, ...args: any[]) {
        this.write(this.formatMessage('WARN', message, ...args));
    }

    public debug(message: string, ...args: any[]) {
        this.write(this.formatMessage('DEBUG', message, ...args));
    }
}

export const logger = Logger.getInstance();
