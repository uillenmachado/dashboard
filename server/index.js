/**
 * Dashboard Analítico - Servidor Express
 * Ponto de entrada da aplicação
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const multer = require('multer');
const cron = require('node-cron');

const logger = require('./logger');
const { config, validateConfig } = require('./config');
const basicAuth = require('./auth');
const { rotateDebugFiles } = require('./debug-rotation');
const db = require('./db');
const routes = require('./routes');

// Fail-fast em config inválida
validateConfig();

const app = express();
const PORT = config.port;

// Inicializar banco de dados
db.initialize();

// Segurança: headers HTTP + CSP allowlist (CDNs usadas pelo dashboard)
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'", // necessário para JS inline no Dashboard Completo.html
                'https://cdn.tailwindcss.com',
                'https://cdn.jsdelivr.net',
                'https://cdnjs.cloudflare.com',
                'https://unpkg.com'
            ],
            // Permite handlers inline (onclick=) usados pelos botoes da tabela do dashboard.
            // Sem isso, o helmet aplica scriptSrcAttr 'none' por padrao e bloqueia silenciosamente os cliques.
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                'https://cdn.jsdelivr.net',
                'https://cdnjs.cloudflare.com',
                'https://fonts.googleapis.com',
                'https://unpkg.com'
            ],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

// CORS restrito à origem permitida
const allowedOrigins = config.corsOrigins.length > 0
    ? config.corsOrigins
    : [`http://localhost:${PORT}`];

app.use(cors({
    origin: (origin, callback) => {
        // Permitir requisições sem origin (ex: Postman, curl, same-origin)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else if (config.nodeEnv === 'production') {
            callback(new Error('Origem não permitida pelo CORS'));
        } else {
            callback(null, true); // Em dev, permitir todas as origens
        }
    }
}));

// Rate limiting global
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Muitas requisições. Aguarde alguns minutos.' }
});

// Rate limiting rigoroso para endpoints sensíveis (scraping/sync)
const scrapingLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 5,
    message: { success: false, error: 'Limite de sincronizações atingido. Aguarde 5 minutos.' }
});

app.use('/api', apiLimiter);
app.use('/api/nfse', scrapingLimiter);
app.use('/api/pagamentos/sync', scrapingLimiter);

// Middlewares
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Auth básica opcional (ativada quando DASHBOARD_USER/PASS definidos)
app.use(basicAuth);

// Healthcheck (sem auth pra facilitar monitoring externo)
app.get('/health', (req, res) => {
    const health = {
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: require('../package.json').version,
        database: 'unknown',
        sincronizacoes: {}
    };

    // Probe DB
    try {
        const syncs = db.listarSincronizacoes(10);
        health.database = 'ok';

        // Última sincronização bem sucedida por tipo
        const tipos = ['nfse', 'pagamentos'];
        for (const tipo of tipos) {
            const ultima = syncs.find(s => s.tipo && s.tipo.includes(tipo));
            if (ultima) {
                health.sincronizacoes[tipo] = {
                    status: ultima.status,
                    quando: ultima.finalizado_at || ultima.created_at,
                    registros_novos: ultima.registros_novos,
                    erro: ultima.erro || null
                };
            }
        }

        // Marca degraded se as 2 últimas tentativas do mesmo tipo falharam
        for (const tipo of tipos) {
            const recentes = syncs.filter(s => s.tipo && s.tipo.includes(tipo)).slice(0, 2);
            if (recentes.length >= 2 && recentes.every(s => s.status === 'erro')) {
                health.status = 'degraded';
                health.sincronizacoes[tipo].alerta = `2+ falhas consecutivas de sync ${tipo}`;
            }
        }
    } catch (err) {
        health.status = 'degraded';
        health.database = 'error';
        health.error = err.message;
    }

    res.status(health.status === 'ok' ? 200 : 503).json(health);
});

// Upload de arquivos (em memória, não salva no disco)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.includes('spreadsheet') || file.mimetype.includes('excel') ||
            file.originalname.match(/\.(xlsx|xls)$/i)) {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos Excel (.xlsx, .xls) são permitidos'));
        }
    }
});

app.use('/api/importar', upload.single('arquivo'));
app.use('/api/pagamentos/importar-xls', upload.single('arquivo'));

// Rotas da API
app.use('/api', routes);

// Servir arquivos estáticos (o dashboard HTML)
app.use(express.static(path.join(__dirname, '..')));

// Rota raiz → dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'Dashboard Completo.html'));
});

// Tratamento de erros global
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    logger.error({ err: err.message, stack: err.stack, url: req.originalUrl, method: req.method }, 'Erro no servidor');

    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ success: false, error: 'Arquivo muito grande. Limite: 10MB' });
        }
        return res.status(400).json({ success: false, error: 'Erro no upload: ' + err.message });
    }

    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
});

// Backup automático do banco (diariamente às 02:00 por padrão)
cron.schedule(config.backupCron, async () => {
    try {
        await db.backup();
        logger.info('Backup automático concluído');
    } catch (err) {
        logger.error({ err: err.message }, 'Erro no backup automático');
    }
});

// Rotação de arquivos de debug (no boot + diariamente às 03:00)
rotateDebugFiles();
cron.schedule('0 3 * * *', () => rotateDebugFiles());

// Iniciar servidor
const server = app.listen(PORT, () => {
    logger.info({
        port: PORT,
        env: config.nodeEnv,
        url: `http://localhost:${PORT}`,
        authEnabled: Boolean(config.auth.user && config.auth.pass)
    }, 'Dashboard Analítico iniciado');
});

// Graceful shutdown
async function shutdown(signal) {
    logger.info({ signal }, 'Encerrando servidor');
    try {
        const scraper = require('./scraper');
        await scraper.encerrarSessao();
    } catch { /* sessão pode não estar ativa */ }

    server.close(() => {
        db.close();
        logger.info('Servidor encerrado com sucesso');
        process.exit(0);
    });

    // Force exit após 10s
    setTimeout(() => {
        logger.warn('Forçando saída após 10s');
        process.exit(1);
    }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandledRejection');
});

module.exports = app;
