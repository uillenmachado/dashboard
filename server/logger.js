/**
 * Logger estruturado (pino) — substitui console.log com emoji.
 * Em desenvolvimento usa pino-pretty; em produção emite JSON line-delimited.
 */

const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

const logger = pino({
    level,
    base: { app: 'dashboard-nfse' },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: isProd ? undefined : {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname,app'
        }
    }
});

module.exports = logger;
