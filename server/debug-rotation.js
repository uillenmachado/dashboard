/**
 * Limpa arquivos antigos de data/debug/ baseado em DEBUG_RETENTION_DAYS.
 * Roda no boot e diariamente via cron.
 */

const fs = require('fs/promises');
const path = require('path');
const logger = require('./logger');
const { config } = require('./config');

const DEBUG_DIR = path.join(__dirname, '..', 'data', 'debug');

async function rotateDebugFiles() {
    try {
        const stat = await fs.stat(DEBUG_DIR).catch(() => null);
        if (!stat || !stat.isDirectory()) return { removed: 0, kept: 0 };

        const cutoff = Date.now() - (config.debugRetentionDays * 24 * 60 * 60 * 1000);
        const entries = await fs.readdir(DEBUG_DIR, { withFileTypes: true });

        let removed = 0;
        let kept = 0;

        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const fullPath = path.join(DEBUG_DIR, entry.name);
            try {
                const fileStat = await fs.stat(fullPath);
                if (fileStat.mtimeMs < cutoff) {
                    await fs.unlink(fullPath);
                    removed++;
                } else {
                    kept++;
                }
            } catch (err) {
                logger.debug({ err: err.message, file: entry.name }, 'Falha ao processar arquivo de debug');
            }
        }

        if (removed > 0) {
            logger.info({ removed, kept, retentionDays: config.debugRetentionDays }, 'Rotação de debug concluída');
        }

        return { removed, kept };
    } catch (err) {
        logger.error({ err: err.message }, 'Erro na rotação de arquivos de debug');
        return { removed: 0, kept: 0, error: err.message };
    }
}

module.exports = { rotateDebugFiles };
