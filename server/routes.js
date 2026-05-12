/**
 * Rotas da API - Notas Fiscais
 * CRUD completo + filtros + estatísticas
 */

const express = require('express');
const router = express.Router();
const db = require('./db');
const scraper = require('./scraper');
const { parseExcelDate } = require('./utils');

// ==================== NOTAS FISCAIS ====================

/**
 * GET /api/notas - Lista todas as notas com filtros opcionais
 * Query params: dataInicio, dataFim, estado, cnpj, recebido, statusConciliado, limite
 */
router.get('/notas', (req, res) => {
    try {
        const filtros = {
            dataInicio: req.query.dataInicio || null,
            dataFim: req.query.dataFim || null,
            estado: req.query.estado || null,
            cnpj: req.query.cnpj || null,
            recebido: req.query.recebido || null,
            statusConciliado: req.query.statusConciliado || null,
            limite: req.query.limite ? Math.min(parseInt(req.query.limite, 10) || 1000, 1000) : null
        };

        const notas = db.listarNotas(filtros);

        // Transformar para o formato esperado pelo frontend
        const notasFormatadas = notas.map(transformarParaFrontend);

        res.json({
            success: true,
            total: notasFormatadas.length,
            data: notasFormatadas
        });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao listar notas');
        res.status(500).json({ success: false, error: 'Erro ao listar notas' });
    }
});

/**
 * GET /api/notas/estatisticas - Estatísticas gerais
 */
router.get('/notas/estatisticas', (req, res) => {
    try {
        const stats = db.obterEstatisticas();
        res.json({ success: true, data: stats });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao obter estatísticas');
        res.status(500).json({ success: false, error: 'Erro ao obter estatísticas' });
    }
});

/**
 * GET /api/notas/:id - Busca nota por ID
 */
router.get('/notas/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const nota = db.buscarNotaPorId(id);
        if (!nota) {
            return res.status(404).json({ success: false, error: 'Nota não encontrada' });
        }

        res.json({ success: true, data: transformarParaFrontend(nota) });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao buscar nota');
        res.status(500).json({ success: false, error: 'Erro ao buscar nota' });
    }
});

/**
 * POST /api/notas - Cria uma nova nota fiscal
 */
router.post('/notas', (req, res) => {
    try {
        const nota = req.body;

        if (!nota.numero || !nota.data_emissao) {
            return res.status(400).json({
                success: false,
                error: 'Campos obrigatórios: numero, data_emissao'
            });
        }

        // Verificar duplicata
        const existente = db.buscarNotaPorNumeroECnpj(String(nota.numero), nota.cnpj || '');
        if (existente) {
            return res.status(409).json({
                success: false,
                error: 'Nota fiscal já cadastrada com este número e CNPJ'
            });
        }

        // Inserir/atualizar cliente automaticamente
        if (nota.cnpj) {
            db.inserirOuAtualizarCliente({
                cnpj: nota.cnpj,
                razao_social: nota.razao_social || '',
                cidade: nota.cidade || null,
                estado: nota.estado || null
            });
        }

        const result = db.inserirNota(nota);
        const novaNota = db.buscarNotaPorId(result.id);

        res.status(201).json({
            success: true,
            data: transformarParaFrontend(novaNota)
        });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao criar nota');
        res.status(500).json({ success: false, error: 'Erro ao criar nota' });
    }
});

/**
 * PUT /api/notas/:id - Atualiza uma nota fiscal
 */
router.put('/notas/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const nota = db.buscarNotaPorId(id);
        if (!nota) {
            return res.status(404).json({ success: false, error: 'Nota não encontrada' });
        }

        const result = db.atualizarNota(id, req.body);
        const notaAtualizada = db.buscarNotaPorId(id);

        res.json({
            success: true,
            data: transformarParaFrontend(notaAtualizada)
        });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao atualizar nota');
        res.status(500).json({ success: false, error: 'Erro ao atualizar nota' });
    }
});

/**
 * PUT /api/notas/:id/pagar - Marca nota como paga
 */
router.put('/notas/:id/pagar', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const nota = db.buscarNotaPorId(id);
        if (!nota) {
            return res.status(404).json({ success: false, error: 'Nota não encontrada' });
        }

        // Calcular dias para pagamento
        let diasPagamento = null;
        const dataPgto = req.body.data_pagamento || new Date().toISOString().split('T')[0];

        // Validar que a data de pagamento não é futura
        const dataPgtoObj = new Date(dataPgto);
        if (isNaN(dataPgtoObj.getTime())) {
            return res.status(400).json({ success: false, error: 'Data de pagamento inválida' });
        }
        const amanha = new Date();
        amanha.setDate(amanha.getDate() + 1);
        amanha.setHours(0, 0, 0, 0);
        if (dataPgtoObj >= amanha) {
            return res.status(400).json({ success: false, error: 'Data de pagamento não pode ser futura' });
        }

        if (nota.data_emissao) {
            const emissao = new Date(nota.data_emissao);
            const pagamento = new Date(dataPgto);
            diasPagamento = Math.floor((pagamento - emissao) / (1000 * 60 * 60 * 24));
        }

        // Determinar status conciliado
        let statusConciliado = 'Pago';
        if (nota.previsao_recebimento) {
            const previsao = new Date(nota.previsao_recebimento);
            const pagamento = new Date(dataPgto);
            if (pagamento > previsao) {
                statusConciliado = 'Pago com Atraso';
            } else if (pagamento < previsao) {
                statusConciliado = 'Pago Antecipado';
            }
        }

        db.marcarComoPaga(id, {
            data_pagamento: dataPgto,
            forma_pagamento: req.body.forma_pagamento || 'PIX',
            status_conciliado: req.body.status_conciliado || statusConciliado,
            dias_pagamento: diasPagamento
        });

        // Salvar observação se fornecida
        if (req.body.observacoes) {
            const obsAtual = nota.observacoes ? nota.observacoes + ' | ' : '';
            db.atualizarNota(id, { observacoes: obsAtual + req.body.observacoes });
        }

        const notaAtualizada = db.buscarNotaPorId(id);
        res.json({
            success: true,
            data: transformarParaFrontend(notaAtualizada)
        });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao marcar como paga');
        res.status(500).json({ success: false, error: 'Erro ao marcar como paga' });
    }
});

/**
 * DELETE /api/notas/:id - Remove uma nota fiscal
 */
router.delete('/notas/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            return res.status(400).json({ success: false, error: 'ID inválido' });
        }

        const nota = db.buscarNotaPorId(id);
        if (!nota) {
            return res.status(404).json({ success: false, error: 'Nota não encontrada' });
        }

        db.deletarNota(id);
        res.json({ success: true, message: 'Nota removida com sucesso' });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao deletar nota');
        res.status(500).json({ success: false, error: 'Erro ao deletar nota' });
    }
});

// ==================== CLIENTES ====================

/**
 * GET /api/clientes - Lista todos os clientes
 */
router.get('/clientes', (req, res) => {
    try {
        const clientes = db.listarClientes();
        res.json({ success: true, data: clientes });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao listar clientes');
        res.status(500).json({ success: false, error: 'Erro ao listar clientes' });
    }
});

// ==================== MAPEAMENTO DE CLIENTES ====================

/**
 * GET /api/clientes/mapeamento - Lista todos os mapeamentos razão social → dados completos
 */
router.get('/clientes/mapeamento', (req, res) => {
    try {
        const mapeamentos = db.listarMapeamentoClientes();
        res.json({ success: true, data: mapeamentos });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao listar mapeamentos');
        res.status(500).json({ success: false, error: 'Erro ao listar mapeamentos' });
    }
});

/**
 * POST /api/clientes/mapeamento - Criar/atualizar mapeamento
 */
router.post('/clientes/mapeamento', (req, res) => {
    try {
        const { razao_social_curta, razao_social_completa, cnpj, email, telefone, endereco, cidade, estado, contato, observacoes } = req.body;
        if (!razao_social_curta || !cnpj) {
            return res.status(400).json({ success: false, error: 'Razão social e CNPJ são obrigatórios' });
        }
        db.salvarMapeamentoCliente({
            razao_social_curta, razao_social_completa: razao_social_completa || razao_social_curta,
            cnpj, email, telefone, endereco, cidade, estado, contato, observacoes
        });
        res.json({ success: true });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao salvar mapeamento');
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/clientes/mapeamento/:id - Deletar mapeamento
 */
router.delete('/clientes/mapeamento/:id', (req, res) => {
    try {
        db.deletarMapeamentoCliente(req.params.id);
        res.json({ success: true });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao deletar mapeamento');
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== IMPORTAÇÃO EXCEL ====================

/**
 * POST /api/importar - Importa dados de uma planilha Excel
 * Recebe arquivo via multipart/form-data
 */
router.post('/importar', (req, res) => {
    // O middleware multer é configurado no index.js
    // req.file contém o arquivo enviado

    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
    }

    try {
        const XLSX = require('xlsx');
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });

        // Tentar encontrar aba "Notas Fiscais"
        let sheetName = 'Notas Fiscais';
        if (!workbook.Sheets[sheetName]) {
            sheetName = workbook.SheetNames[0];
        }

        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet);

        if (jsonData.length === 0) {
            return res.status(400).json({ success: false, error: 'Planilha vazia' });
        }

        // Mapeamento de colunas do Excel para o banco
        const columnMapping = {
            'Número': 'numero',
            'Razão Social': 'razao_social',
            'Data de Emissão': 'data_emissao',
            'Valor da Nota': 'valor_nota',
            'ISS': 'iss',
            'Valor Líquido': 'valor_liquido',
            'ESTADO': 'estado',
            'CIDADE': 'cidade',
            'CNPJ': 'cnpj',
            'STATUS DE PAGAMENTO': 'status_pagamento',
            'Data de Pagamento': 'data_pagamento',
            'Dias para Pagamento': 'dias_pagamento',
            'Status Conciliado': 'status_conciliado',
            'Recebido': 'recebido',
            'Previsão de Recebimento': 'previsao_recebimento'
        };

        // Processar cada linha
        const notasProcessadas = jsonData.map(row => {
            const nota = {};

            Object.entries(columnMapping).forEach(([excelCol, dbCol]) => {
                nota[dbCol] = row[excelCol];
            });

            // Converter datas do Excel (serial number → string ISO)
            nota.data_emissao = parseExcelDate(nota.data_emissao);
            nota.data_pagamento = parseExcelDate(nota.data_pagamento);
            nota.previsao_recebimento = parseExcelDate(nota.previsao_recebimento);

            // Converter valores numéricos
            nota.valor_nota = parseFloat(nota.valor_nota) || 0;
            nota.iss = parseFloat(nota.iss) || 0;
            nota.valor_liquido = parseFloat(nota.valor_liquido) || 0;
            nota.dias_pagamento = parseInt(nota.dias_pagamento) || null;

            // Limpar CNPJ
            if (nota.cnpj) {
                nota.cnpj = String(nota.cnpj).replace(/[^\d]/g, '');
                if (nota.cnpj.length === 14) {
                    nota.cnpj = nota.cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
                }
            }

            nota.numero = String(nota.numero || '');
            nota.origem = 'importacao_excel';

            return nota;
        });

        // Sincronizar clientes
        const syncId = db.registrarSincronizacao('importacao_excel');

        // Inserir/atualizar clientes encontrados
        const cnpjsProcessados = new Set();
        notasProcessadas.forEach(nota => {
            if (nota.cnpj && !cnpjsProcessados.has(nota.cnpj)) {
                db.inserirOuAtualizarCliente({
                    cnpj: nota.cnpj,
                    razao_social: nota.razao_social || '',
                    cidade: nota.cidade || null,
                    estado: nota.estado || null
                });
                cnpjsProcessados.add(nota.cnpj);
            }
        });

        // Inserir notas em lote
        const resultado = db.inserirNotasEmLote(notasProcessadas);

        db.finalizarSincronizacao(syncId, {
            encontrados: resultado.total,
            novos: resultado.inseridos
        });

        res.json({
            success: true,
            data: {
                total: resultado.total,
                inseridos: resultado.inseridos,
                ignorados: resultado.ignorados,
                clientes: cnpjsProcessados.size
            }
        });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro na importação');
        res.status(500).json({ success: false, error: 'Erro ao processar planilha: ' + error.message });
    }
});

// ==================== SINCRONIZAÇÕES ====================

/**
 * GET /api/sincronizacoes - Lista histórico de sincronizações
 */
router.get('/sincronizacoes', (req, res) => {
    try {
        const limite = parseInt(req.query.limite, 10) || 20;
        const syncs = db.listarSincronizacoes(limite);
        res.json({ success: true, data: syncs });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao listar sincronizações');
        res.status(500).json({ success: false, error: 'Erro ao listar sincronizações' });
    }
});

// ==================== ANALYTICS AVANÇADO ====================

/**
 * GET /api/analytics - Dados analíticos consolidados para o dashboard
 */
router.get('/analytics', (req, res) => {
    try {
        const analytics = {
            faturamentoMensal: db.faturamentoMensal(),
            topClientes: db.topClientes(10),
            resumoPorStatus: db.resumoPorStatus(),
            recebimentosMensais: db.recebimentosMensais(),
            dsoMensal: db.dsoMensal(),
            faturamentoPorEstado: db.faturamentoPorEstado(),
            estatisticas: db.obterEstatisticas()
        };
        res.json({ success: true, data: analytics });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao obter analytics');
        res.status(500).json({ success: false, error: 'Erro ao obter analytics' });
    }
});

// ==================== HELPERS ====================

/**
 * Transforma registro do banco para o formato esperado pelo frontend
 */
function transformarParaFrontend(nota) {
    return {
        id: nota.id,
        numero: nota.numero,
        razaoSocial: nota.razao_social,
        cnpj: nota.cnpj,
        dataEmissao: nota.data_emissao,
        valorNota: nota.valor_nota,
        iss: nota.iss,
        valorLiquido: nota.valor_liquido,
        estado: nota.estado,
        cidade: nota.cidade,
        statusPagamento: nota.status_pagamento,
        dataPagamento: nota.data_pagamento,
        diasPagamento: nota.dias_pagamento,
        statusConciliado: nota.status_conciliado,
        recebido: nota.recebido,
        previsaoRecebimento: nota.previsao_recebimento,
        formaPagamento: nota.forma_pagamento,
        observacoes: nota.observacoes,
        origem: nota.origem
    };
}

// parseExcelDate importado de ./utils

// ==================== ANALYTICS AVANÇADOS ====================

/**
 * GET /api/analytics/resumo - Resumo executivo completo
 */
router.get('/analytics/resumo', (req, res) => {
    try {
        const database = db.getDb();

        // Faturamento geral
        const geral = database.prepare(`
            SELECT 
                COUNT(*) as totalNotas,
                COALESCE(SUM(valor_nota), 0) as totalBruto,
                COALESCE(SUM(valor_liquido), 0) as totalLiquido,
                COALESCE(SUM(iss), 0) as totalISS,
                COALESCE(AVG(valor_nota), 0) as ticketMedioBruto,
                COALESCE(AVG(valor_liquido), 0) as ticketMedioLiquido
            FROM notas_fiscais
            WHERE status_conciliado != 'Cancelada' AND status_pagamento != 'Serviço Contratado'
        `).get();

        // Recebimentos
        const recebimentos = database.prepare(`
            SELECT 
                COALESCE(SUM(CASE WHEN recebido = 'Recebido' THEN valor_liquido ELSE 0 END), 0) as totalRecebido,
                COALESCE(SUM(CASE WHEN recebido = 'Em aberto' THEN valor_liquido ELSE 0 END), 0) as totalEmAberto,
                COUNT(CASE WHEN recebido = 'Recebido' THEN 1 END) as notasRecebidas,
                COUNT(CASE WHEN recebido = 'Em aberto' THEN 1 END) as notasEmAberto,
                COALESCE(AVG(CASE WHEN recebido = 'Recebido' AND dias_pagamento > 0 THEN dias_pagamento END), 0) as dsoMedio
            FROM notas_fiscais
            WHERE status_conciliado != 'Cancelada' AND status_pagamento != 'Serviço Contratado'
        `).get();

        // Por status conciliado
        const porStatus = database.prepare(`
            SELECT status_conciliado, COUNT(*) as quantidade, 
                   COALESCE(SUM(valor_liquido), 0) as valor
            FROM notas_fiscais
            GROUP BY status_conciliado
            ORDER BY valor DESC
        `).all();

        // Faturamento mensal (últimos 12 meses)
        const mensal = database.prepare(`
            SELECT 
                strftime('%Y-%m', data_emissao) as mes,
                COUNT(*) as notas,
                COALESCE(SUM(valor_nota), 0) as bruto,
                COALESCE(SUM(valor_liquido), 0) as liquido,
                COALESCE(SUM(iss), 0) as iss,
                COALESCE(SUM(CASE WHEN recebido = 'Recebido' THEN valor_liquido ELSE 0 END), 0) as recebido,
                COALESCE(SUM(CASE WHEN recebido = 'Em aberto' THEN valor_liquido ELSE 0 END), 0) as emAberto
            FROM notas_fiscais
            WHERE status_conciliado != 'Cancelada' AND status_pagamento != 'Serviço Contratado'
                AND data_emissao >= date('now', '-12 months')
            GROUP BY mes
            ORDER BY mes ASC
        `).all();

        // Top clientes
        const topClientes = database.prepare(`
            SELECT 
                razao_social, cnpj,
                COUNT(*) as notas,
                COALESCE(SUM(valor_liquido), 0) as valorTotal,
                COALESCE(SUM(CASE WHEN recebido = 'Em aberto' THEN valor_liquido ELSE 0 END), 0) as emAberto
            FROM notas_fiscais
            WHERE status_conciliado != 'Cancelada' AND status_pagamento != 'Serviço Contratado'
            GROUP BY cnpj
            ORDER BY valorTotal DESC
            LIMIT 10
        `).all();

        // Aging buckets
        const aging = database.prepare(`
            SELECT 
                CASE 
                    WHEN julianday('now') - julianday(data_emissao) <= 30 THEN '0-30'
                    WHEN julianday('now') - julianday(data_emissao) <= 60 THEN '31-60'
                    WHEN julianday('now') - julianday(data_emissao) <= 90 THEN '61-90'
                    ELSE '90+'
                END as bucket,
                COUNT(*) as quantidade,
                COALESCE(SUM(valor_liquido), 0) as valor
            FROM notas_fiscais
            WHERE recebido = 'Em aberto' 
                AND status_conciliado != 'Cancelada' 
                AND status_pagamento != 'Serviço Contratado'
            GROUP BY bucket
            ORDER BY 
                CASE bucket
                    WHEN '0-30' THEN 1
                    WHEN '31-60' THEN 2
                    WHEN '61-90' THEN 3
                    ELSE 4
                END
        `).all();

        // Por estado
        const porEstado = database.prepare(`
            SELECT 
                estado, COUNT(*) as notas,
                COALESCE(SUM(valor_liquido), 0) as valorTotal
            FROM notas_fiscais
            WHERE estado IS NOT NULL AND estado != '' 
                AND status_conciliado != 'Cancelada' 
                AND status_pagamento != 'Serviço Contratado'
            GROUP BY estado
            ORDER BY valorTotal DESC
        `).all();

        // Notas canceladas
        const canceladas = database.prepare(`
            SELECT COUNT(*) as quantidade, COALESCE(SUM(valor_nota), 0) as valor
            FROM notas_fiscais WHERE status_conciliado = 'Cancelada'
        `).get();

        // Serviços contratados
        const contratados = database.prepare(`
            SELECT COUNT(*) as quantidade, COALESCE(SUM(valor_nota), 0) as valor
            FROM notas_fiscais WHERE status_pagamento = 'Serviço Contratado'
        `).get();

        res.json({
            success: true,
            data: {
                geral,
                recebimentos,
                porStatus,
                mensal,
                topClientes,
                aging,
                porEstado,
                canceladas,
                contratados
            }
        });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao gerar analytics');
        res.status(500).json({ success: false, error: 'Erro ao gerar analytics' });
    }
});

// ==================== SCRAPING NFS-e ====================

/**
 * POST /api/nfse/iniciar - Inicia sessão de scraping e retorna imagem do CAPTCHA
 * Body: { login, senha } (opcionais, usa .env se não fornecido)
 */
router.post('/nfse/iniciar', async (req, res) => {
    try {
        const login = req.body.login || process.env.NFSE_LOGIN;
        const senha = req.body.senha || process.env.NFSE_SENHA;

        if (!login || !senha) {
            return res.status(400).json({
                success: false,
                erro: 'Credenciais do portal NFS-e não configuradas. Informe login e senha ou configure no arquivo .env'
            });
        }

        const resultado = await scraper.iniciarSessao(login, senha);

        res.json({
            success: true,
            captchaImage: resultado.captchaImage,
            captchaEncontrado: resultado.captchaEncontrado,
            syncId: resultado.syncId
        });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao iniciar scraping');
        res.status(500).json({ success: false, erro: 'Erro ao acessar portal: ' + error.message });
    }
});

/**
 * POST /api/nfse/captcha - Envia resolução do CAPTCHA e completa extração
 * Body: { captcha }
 */
router.post('/nfse/captcha', async (req, res) => {
    try {
        const textoCaptcha = req.body.textoCaptcha;

        if (!textoCaptcha) {
            return res.status(400).json({ success: false, erro: 'Digite o texto do CAPTCHA' });
        }

        const resultado = await scraper.resolverCaptchaELogar(textoCaptcha);

        if (!resultado.success) {
            // CAPTCHA errado — retornar nova imagem para retry
            return res.status(400).json({
                success: false,
                erro: resultado.error || 'CAPTCHA incorreto',
                captchaImage: resultado.captchaImage || null
            });
        }

        res.json({
            success: true,
            totalExtraidas: resultado.notasEncontradas,
            novasNotas: resultado.notasNovas,
            duplicadas: resultado.notasDuplicadas,
            atualizadasCnpj: resultado.notasAtualizadasCnpj || 0,
            syncId: resultado.syncId
        });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro ao resolver CAPTCHA');
        res.status(500).json({ success: false, erro: error.message });
    }
});

/**
 * GET /api/nfse/status - Retorna status da sessão de scraping
 */
router.get('/nfse/status', (req, res) => {
    const status = scraper.obterStatusSessao();
    res.json({ success: true, data: status });
});

/**
 * POST /api/nfse/cancelar - Cancela sessão de scraping em andamento
 */
router.post('/nfse/cancelar', async (req, res) => {
    try {
        await scraper.encerrarSessao();
        res.json({ success: true, message: 'Sessão cancelada' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/nfse/sync-auto - Sincronização 100% automática (OCR resolve CAPTCHA)
 * Body: { login, senha } (opcionais, usa .env se não fornecido)
 */
router.post('/nfse/sync-auto', async (req, res) => {
    try {
        const login = req.body.login || process.env.NFSE_LOGIN;
        const senha = req.body.senha || process.env.NFSE_SENHA;

        if (!login || !senha) {
            return res.status(400).json({
                success: false,
                erro: 'Credenciais do portal NFS-e não configuradas.'
            });
        }

        logger.info('🤖 Iniciando sincronização automática (OCR)...');

        const resultado = await scraper.sincronizarAutomatico(login, senha, (etapa, msg) => {
            logger.info(`  [auto] ${etapa}: ${msg}`);
        });

        if (!resultado.success) {
            return res.status(422).json({
                success: false,
                erro: resultado.error,
                tentativas: resultado.tentativas,
                captchaImage: resultado.captchaImage || null
            });
        }

        res.json({
            success: true,
            tentativas: resultado.tentativas,
            textoOCR: resultado.textoOCR,
            totalExtraidas: resultado.notasEncontradas,
            novasNotas: resultado.notasNovas,
            duplicadas: resultado.notasDuplicadas,
            atualizadasCnpj: resultado.notasAtualizadasCnpj || 0,
            syncId: resultado.syncId
        });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro na sincronização automática');
        res.status(500).json({ success: false, erro: error.message });
    }
});

// ==================== SYNC PAGAMENTOS (Painel Fornecedor Finnet/Cimed) ====================

const scraperPagamentos = require('./scraper-pagamentos');
const logger = require('./logger');

/**
 * POST /api/pagamentos/sync - Sincroniza pagamentos do Painel Fornecedor Finnet
 * Body: { email, senha } (opcionais — usa .env como fallback)
 */
router.post('/pagamentos/sync', async (req, res) => {
    try {
        const email = req.body.email || process.env.FINNET_EMAIL;
        const senha = req.body.senha || process.env.FINNET_SENHA;

        if (!email || !senha) {
            return res.status(400).json({
                success: false,
                error: 'Credenciais do Painel Fornecedor não configuradas. Informe email e senha.'
            });
        }

        logger.info('🏦 Iniciando sincronização de pagamentos Finnet/Cimed...');
        const resultado = await scraperPagamentos.sincronizarPagamentos(email, senha);

        res.json({
            success: true,
            data: resultado
        });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro na sincronização de pagamentos');
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/pagamentos/importar-xls - Importa pagamentos a partir de XLS do Painel Fornecedor
 * Body: multipart/form-data com campo 'arquivo' (XLS/XLSX)
 */
router.post('/pagamentos/importar-xls', (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
        }

        logger.info(`📥 Importando pagamentos XLS: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);
        const resultado = scraperPagamentos.importarPagamentosXLS(req.file.buffer);

        res.json({ success: true, data: resultado });
    } catch (error) {
        logger.error({ err: error.message }, 'Erro na importação de pagamentos XLS');
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== CONFIGURAÇÃO ====================

/**
 * GET /api/config/credentials - Retorna quais credenciais estão configuradas no .env
 * Não expõe senhas, apenas indica presença (true/false) e retorna emails/logins
 */
router.get('/config/credentials', (req, res) => {
    res.json({
        finnet: {
            email: process.env.FINNET_EMAIL || '',
            hasSenha: !!process.env.FINNET_SENHA
        },
        nfse: {
            login: process.env.NFSE_LOGIN || '',
            hasSenha: !!process.env.NFSE_SENHA
        }
    });
});

module.exports = router;
