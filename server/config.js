/**
 * Configuração centralizada com fail-fast em variáveis obrigatórias.
 * Chame validateConfig() no boot do servidor.
 */

const logger = require('./logger');

function parseList(value, fallback = []) {
    if (!value) return fallback;
    return value.split(',').map(s => s.trim()).filter(Boolean);
}

const config = {
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    corsOrigins: parseList(process.env.CORS_ORIGINS),

    // Credenciais de scraping (opcionais — só obrigatórias se for usar sync)
    nfse: {
        login: process.env.NFSE_LOGIN || '',
        senha: process.env.NFSE_SENHA || ''
    },
    finnet: {
        email: process.env.FINNET_EMAIL || '',
        senha: process.env.FINNET_SENHA || ''
    },

    // Auth básica opcional. Se ambos definidos, ativa proteção da API/dashboard.
    auth: {
        user: process.env.DASHBOARD_USER || '',
        pass: process.env.DASHBOARD_PASS || ''
    },

    // Rotação de arquivos de debug
    debugRetentionDays: parseInt(process.env.DEBUG_RETENTION_DAYS, 10) || 14,

    // Backup
    backupCron: process.env.BACKUP_CRON || '0 2 * * *',
    backupKeep: parseInt(process.env.BACKUP_KEEP, 10) || 7
};

function validateConfig() {
    const issues = [];

    if (config.port < 1 || config.port > 65535) {
        issues.push(`PORT inválida: ${config.port}`);
    }

    if (config.nodeEnv === 'production') {
        if (config.corsOrigins.length === 0) {
            issues.push('CORS_ORIGINS é obrigatório em produção');
        }
        if (!config.auth.user || !config.auth.pass) {
            logger.warn('DASHBOARD_USER/DASHBOARD_PASS não definidos — dashboard exposto sem autenticação');
        }
    }

    if (issues.length > 0) {
        logger.fatal({ issues }, 'Configuração inválida — abortando boot');
        throw new Error('Configuração inválida: ' + issues.join('; '));
    }

    // Avisos não-fatais sobre credenciais de scraping
    if (!config.nfse.login || !config.nfse.senha) {
        logger.warn('NFSE_LOGIN/NFSE_SENHA não definidos — sync NFS-e indisponível');
    }
    if (!config.finnet.email || !config.finnet.senha) {
        logger.warn('FINNET_EMAIL/FINNET_SENHA não definidos — sync Pagamentos indisponível');
    }

    logger.info({
        port: config.port,
        env: config.nodeEnv,
        cors: config.corsOrigins.length || 'default-localhost',
        authEnabled: Boolean(config.auth.user && config.auth.pass)
    }, 'Configuração carregada');
}

module.exports = { config, validateConfig };
