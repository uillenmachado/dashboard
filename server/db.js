/**
 * Módulo de Banco de Dados - SQLite via better-sqlite3
 * Schema e funções de acesso para notas fiscais, clientes e sincronizações
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'notas.db');

let db;

/**
 * Inicializa o banco de dados e cria as tabelas se não existirem
 */
function initialize() {
    const fs = require('fs');
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    db = new Database(DB_PATH);

    // Habilitar WAL mode para melhor performance
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Criar tabelas
    db.exec(`
        CREATE TABLE IF NOT EXISTS clientes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cnpj TEXT UNIQUE NOT NULL,
            razao_social TEXT NOT NULL,
            cidade TEXT,
            estado TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS notas_fiscais (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            numero TEXT NOT NULL,
            cliente_id INTEGER,
            razao_social TEXT,
            cnpj TEXT,
            data_emissao TEXT NOT NULL,
            valor_nota REAL NOT NULL DEFAULT 0,
            iss REAL DEFAULT 0,
            valor_liquido REAL DEFAULT 0,
            estado TEXT,
            cidade TEXT,
            status_pagamento TEXT,
            data_pagamento TEXT,
            dias_pagamento INTEGER,
            status_conciliado TEXT DEFAULT 'Não Pago',
            recebido TEXT DEFAULT 'Em aberto',
            previsao_recebimento TEXT,
            forma_pagamento TEXT,
            observacoes TEXT,
            origem TEXT DEFAULT 'manual',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (cliente_id) REFERENCES clientes(id),
            UNIQUE(numero, cnpj)
        );

        CREATE TABLE IF NOT EXISTS sincronizacoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pendente',
            registros_encontrados INTEGER DEFAULT 0,
            registros_novos INTEGER DEFAULT 0,
            erro TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            finalizado_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_notas_numero ON notas_fiscais(numero);
        CREATE INDEX IF NOT EXISTS idx_notas_cnpj ON notas_fiscais(cnpj);
        CREATE INDEX IF NOT EXISTS idx_notas_data_emissao ON notas_fiscais(data_emissao);
        CREATE INDEX IF NOT EXISTS idx_notas_recebido ON notas_fiscais(recebido);
        CREATE INDEX IF NOT EXISTS idx_notas_status ON notas_fiscais(status_conciliado);
        CREATE INDEX IF NOT EXISTS idx_clientes_cnpj ON clientes(cnpj);

        -- Mapeamento razão social (truncada) → dados completos do cliente
        CREATE TABLE IF NOT EXISTS clientes_mapeamento (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            razao_social_curta TEXT NOT NULL UNIQUE,
            razao_social_completa TEXT NOT NULL,
            cnpj TEXT NOT NULL,
            email TEXT,
            telefone TEXT,
            endereco TEXT,
            cidade TEXT,
            estado TEXT,
            contato TEXT,
            observacoes TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_mapeamento_razao ON clientes_mapeamento(razao_social_curta);

        -- Índices compostos para queries frequentes do dashboard
        CREATE INDEX IF NOT EXISTS idx_notas_recebido_status ON notas_fiscais(recebido, status_conciliado);
        CREATE INDEX IF NOT EXISTS idx_notas_emissao_recebido ON notas_fiscais(data_emissao, recebido);
        CREATE INDEX IF NOT EXISTS idx_notas_numero_cnpj ON notas_fiscais(numero, cnpj);
    `);

    console.log('✅ Banco de dados inicializado:', DB_PATH);
    return db;
}

// ==================== NOTAS FISCAIS ====================

/**
 * Lista todas as notas fiscais com filtros opcionais
 */
function listarNotas(filtros = {}) {
    let sql = 'SELECT * FROM notas_fiscais WHERE 1=1';
    const params = {};

    if (filtros.dataInicio) {
        sql += ' AND data_emissao >= :dataInicio';
        params.dataInicio = filtros.dataInicio;
    }
    if (filtros.dataFim) {
        sql += ' AND data_emissao <= :dataFim';
        params.dataFim = filtros.dataFim;
    }
    if (filtros.estado) {
        sql += ' AND estado = :estado';
        params.estado = filtros.estado;
    }
    if (filtros.cnpj) {
        sql += ' AND cnpj = :cnpj';
        params.cnpj = filtros.cnpj;
    }
    if (filtros.recebido) {
        sql += ' AND recebido = :recebido';
        params.recebido = filtros.recebido;
    }
    if (filtros.statusConciliado) {
        sql += ' AND status_conciliado = :statusConciliado';
        params.statusConciliado = filtros.statusConciliado;
    }

    sql += ' ORDER BY data_emissao DESC';

    if (filtros.limite) {
        sql += ' LIMIT :limite';
        params.limite = filtros.limite;
    }

    return db.prepare(sql).all(params);
}

/**
 * Busca nota por ID
 */
function buscarNotaPorId(id) {
    return db.prepare('SELECT * FROM notas_fiscais WHERE id = ?').get(id);
}

/**
 * Busca nota por número e CNPJ (para evitar duplicatas)
 */
function buscarNotaPorNumeroECnpj(numero, cnpj) {
    return db.prepare('SELECT * FROM notas_fiscais WHERE numero = ? AND cnpj = ?').get(numero, cnpj);
}

/**
 * Insere uma nova nota fiscal
 */
function inserirNota(nota) {
    const stmt = db.prepare(`
        INSERT INTO notas_fiscais (
            numero, cliente_id, razao_social, cnpj, data_emissao,
            valor_nota, iss, valor_liquido, estado, cidade,
            status_pagamento, data_pagamento, dias_pagamento,
            status_conciliado, recebido, previsao_recebimento,
            forma_pagamento, observacoes, origem
        ) VALUES (
            :numero, :cliente_id, :razao_social, :cnpj, :data_emissao,
            :valor_nota, :iss, :valor_liquido, :estado, :cidade,
            :status_pagamento, :data_pagamento, :dias_pagamento,
            :status_conciliado, :recebido, :previsao_recebimento,
            :forma_pagamento, :observacoes, :origem
        )
    `);

    const result = stmt.run({
        numero: nota.numero || '',
        cliente_id: nota.cliente_id || null,
        razao_social: nota.razao_social || nota.razaoSocial || '',
        cnpj: nota.cnpj || '',
        data_emissao: nota.data_emissao || nota.dataEmissao || '',
        valor_nota: nota.valor_nota || nota.valorNota || 0,
        iss: nota.iss || 0,
        valor_liquido: nota.valor_liquido || nota.valorLiquido || 0,
        estado: nota.estado || '',
        cidade: nota.cidade || '',
        status_pagamento: nota.status_pagamento || nota.statusPagamento || '',
        data_pagamento: nota.data_pagamento || nota.dataPagamento || null,
        dias_pagamento: nota.dias_pagamento || nota.diasPagamento || null,
        status_conciliado: nota.status_conciliado || nota.statusConciliado || 'Não Pago',
        recebido: nota.recebido || 'Em aberto',
        previsao_recebimento: nota.previsao_recebimento || nota.previsaoRecebimento || null,
        forma_pagamento: nota.forma_pagamento || nota.formaPagamento || null,
        observacoes: nota.observacoes || null,
        origem: nota.origem || 'manual'
    });

    return { id: result.lastInsertRowid, changes: result.changes };
}

/**
 * Insere múltiplas notas em uma transação (usado na importação Excel)
 */
function inserirNotasEmLote(notas) {
    const inserir = db.prepare(`
        INSERT OR IGNORE INTO notas_fiscais (
            numero, razao_social, cnpj, data_emissao,
            valor_nota, iss, valor_liquido, estado, cidade,
            status_pagamento, data_pagamento, dias_pagamento,
            status_conciliado, recebido, previsao_recebimento, origem
        ) VALUES (
            :numero, :razao_social, :cnpj, :data_emissao,
            :valor_nota, :iss, :valor_liquido, :estado, :cidade,
            :status_pagamento, :data_pagamento, :dias_pagamento,
            :status_conciliado, :recebido, :previsao_recebimento, :origem
        )
    `);

    const transaction = db.transaction((notas) => {
        let inseridos = 0;
        let ignorados = 0;

        for (const nota of notas) {
            const result = inserir.run({
                numero: String(nota.numero || ''),
                razao_social: nota.razao_social || nota.razaoSocial || '',
                cnpj: nota.cnpj || '',
                data_emissao: nota.data_emissao || nota.dataEmissao || '',
                valor_nota: nota.valor_nota || nota.valorNota || 0,
                iss: nota.iss || 0,
                valor_liquido: nota.valor_liquido || nota.valorLiquido || 0,
                estado: nota.estado || '',
                cidade: nota.cidade || '',
                status_pagamento: nota.status_pagamento || nota.statusPagamento || '',
                data_pagamento: nota.data_pagamento || nota.dataPagamento || null,
                dias_pagamento: nota.dias_pagamento || nota.diasPagamento || null,
                status_conciliado: nota.status_conciliado || nota.statusConciliado || 'Não Pago',
                recebido: nota.recebido || 'Em aberto',
                previsao_recebimento: nota.previsao_recebimento || nota.previsaoRecebimento || null,
                origem: nota.origem || 'importacao_excel'
            });

            if (result.changes > 0) {
                inseridos++;
            } else {
                ignorados++;
            }
        }

        return { inseridos, ignorados, total: notas.length };
    });

    return transaction(notas);
}

/**
 * Atualiza uma nota fiscal existente
 */
function atualizarNota(id, campos) {
    const camposPermitidos = [
        'numero', 'razao_social', 'cnpj', 'data_emissao',
        'valor_nota', 'iss', 'valor_liquido', 'estado', 'cidade',
        'status_pagamento', 'data_pagamento', 'dias_pagamento',
        'status_conciliado', 'recebido', 'previsao_recebimento',
        'forma_pagamento', 'observacoes'
    ];

    const updates = [];
    const params = { id };

    for (const [key, value] of Object.entries(campos)) {
        if (camposPermitidos.includes(key)) {
            updates.push(`${key} = :${key}`);
            params[key] = value;
        }
    }

    if (updates.length === 0) return { changes: 0 };

    updates.push("updated_at = datetime('now')");

    const sql = `UPDATE notas_fiscais SET ${updates.join(', ')} WHERE id = :id`;
    return db.prepare(sql).run(params);
}

/**
 * Marca nota como paga
 */
function marcarComoPaga(id, dadosPagamento) {
    return atualizarNota(id, {
        recebido: 'Recebido',
        data_pagamento: dadosPagamento.data_pagamento || new Date().toISOString().split('T')[0],
        forma_pagamento: dadosPagamento.forma_pagamento || 'PIX',
        status_conciliado: dadosPagamento.status_conciliado || 'Pago no Prazo',
        dias_pagamento: dadosPagamento.dias_pagamento || null
    });
}

/**
 * Deleta uma nota fiscal
 */
function deletarNota(id) {
    return db.prepare('DELETE FROM notas_fiscais WHERE id = ?').run(id);
}

/**
 * Obtém estatísticas gerais para o dashboard
 */
function obterEstatisticas() {
    // Consolidar em uma query para evitar N+1
    const stats = db.prepare(`
        SELECT 
            COUNT(*) as totalNotas,
            COALESCE(SUM(valor_nota), 0) as totalBruto,
            COALESCE(SUM(valor_liquido), 0) as totalLiquido,
            COALESCE(SUM(iss), 0) as totalISS,
            COALESCE(SUM(CASE WHEN recebido = 'Recebido' THEN valor_liquido ELSE 0 END), 0) as totalRecebido,
            COALESCE(SUM(CASE WHEN recebido = 'Em aberto' THEN valor_liquido ELSE 0 END), 0) as totalEmAberto,
            SUM(CASE WHEN recebido = 'Recebido' THEN 1 ELSE 0 END) as notasRecebidas,
            SUM(CASE WHEN recebido = 'Em aberto' THEN 1 ELSE 0 END) as notasEmAberto
        FROM notas_fiscais
    `).get();

    stats.estados = db.prepare("SELECT DISTINCT estado FROM notas_fiscais WHERE estado IS NOT NULL AND estado != '' ORDER BY estado").all().map(r => r.estado);
    stats.cnpjs = db.prepare("SELECT DISTINCT cnpj, razao_social FROM notas_fiscais WHERE cnpj IS NOT NULL AND cnpj != '' ORDER BY razao_social").all();

    return stats;
}

// ==================== CLIENTES ====================

function listarClientes() {
    return db.prepare('SELECT * FROM clientes ORDER BY razao_social').all();
}

function buscarClientePorCnpj(cnpj) {
    return db.prepare('SELECT * FROM clientes WHERE cnpj = ?').get(cnpj);
}

function inserirOuAtualizarCliente(cliente) {
    const stmt = db.prepare(`
        INSERT INTO clientes (cnpj, razao_social, cidade, estado)
        VALUES (:cnpj, :razao_social, :cidade, :estado)
        ON CONFLICT(cnpj) DO UPDATE SET
            razao_social = :razao_social,
            cidade = COALESCE(:cidade, cidade),
            estado = COALESCE(:estado, estado),
            updated_at = datetime('now')
    `);

    return stmt.run({
        cnpj: cliente.cnpj,
        razao_social: cliente.razao_social || cliente.razaoSocial || '',
        cidade: cliente.cidade || null,
        estado: cliente.estado || null
    });
}

// ==================== MAPEAMENTO CLIENTES ====================

function listarMapeamentoClientes() {
    return db.prepare('SELECT * FROM clientes_mapeamento ORDER BY razao_social_curta').all();
}

function buscarMapeamentoPorRazao(razaoCurta) {
    return db.prepare('SELECT * FROM clientes_mapeamento WHERE razao_social_curta = ?').get(razaoCurta);
}

function salvarMapeamentoCliente(dados) {
    const stmt = db.prepare(`
        INSERT INTO clientes_mapeamento (razao_social_curta, razao_social_completa, cnpj, email, telefone, endereco, cidade, estado, contato, observacoes)
        VALUES (:razao_social_curta, :razao_social_completa, :cnpj, :email, :telefone, :endereco, :cidade, :estado, :contato, :observacoes)
        ON CONFLICT(razao_social_curta) DO UPDATE SET
            razao_social_completa = :razao_social_completa,
            cnpj = :cnpj,
            email = COALESCE(:email, email),
            telefone = COALESCE(:telefone, telefone),
            endereco = COALESCE(:endereco, endereco),
            cidade = COALESCE(:cidade, cidade),
            estado = COALESCE(:estado, estado),
            contato = COALESCE(:contato, contato),
            observacoes = COALESCE(:observacoes, observacoes),
            updated_at = datetime('now')
    `);

    return stmt.run({
        razao_social_curta: dados.razao_social_curta,
        razao_social_completa: dados.razao_social_completa,
        cnpj: dados.cnpj,
        email: dados.email || null,
        telefone: dados.telefone || null,
        endereco: dados.endereco || null,
        cidade: dados.cidade || null,
        estado: dados.estado || null,
        contato: dados.contato || null,
        observacoes: dados.observacoes || null
    });
}

function deletarMapeamentoCliente(id) {
    return db.prepare('DELETE FROM clientes_mapeamento WHERE id = ?').run(id);
}

// ==================== SINCRONIZAÇÕES ====================

function registrarSincronizacao(tipo) {
    const result = db.prepare(
        "INSERT INTO sincronizacoes (tipo, status) VALUES (?, 'em_andamento')"
    ).run(tipo);
    return result.lastInsertRowid;
}

function finalizarSincronizacao(id, dados) {
    return db.prepare(`
        UPDATE sincronizacoes SET
            status = :status,
            registros_encontrados = :encontrados,
            registros_novos = :novos,
            erro = :erro,
            finalizado_at = datetime('now')
        WHERE id = :id
    `).run({
        id,
        status: dados.erro ? 'erro' : 'concluido',
        encontrados: dados.encontrados || 0,
        novos: dados.novos || 0,
        erro: dados.erro || null
    });
}

function listarSincronizacoes(limite = 20) {
    return db.prepare('SELECT * FROM sincronizacoes ORDER BY created_at DESC LIMIT ?').all(limite);
}

// ==================== ANALYTICS AVANÇADO ====================

/**
 * Faturamento mensal agrupado (bruto, líquido, ISS, quantidade)
 */
function faturamentoMensal() {
    return db.prepare(`
        SELECT 
            strftime('%Y-%m', data_emissao) as mes,
            COUNT(*) as quantidade,
            COALESCE(SUM(valor_nota), 0) as bruto,
            COALESCE(SUM(valor_liquido), 0) as liquido,
            COALESCE(SUM(iss), 0) as iss
        FROM notas_fiscais
        WHERE data_emissao IS NOT NULL AND data_emissao != ''
        GROUP BY strftime('%Y-%m', data_emissao)
        ORDER BY mes
    `).all();
}

/**
 * Top clientes por faturamento
 */
function topClientes(limite = 10) {
    return db.prepare(`
        SELECT 
            COALESCE(NULLIF(cnpj, ''), razao_social) as cnpj,
            razao_social,
            COUNT(*) as total_notas,
            COALESCE(SUM(valor_liquido), 0) as total_liquido,
            COALESCE(SUM(valor_nota), 0) as total_bruto,
            MIN(data_emissao) as primeira_nota,
            MAX(data_emissao) as ultima_nota
        FROM notas_fiscais
        WHERE razao_social IS NOT NULL AND razao_social != ''
        GROUP BY COALESCE(NULLIF(cnpj, ''), LOWER(TRIM(razao_social)))
        ORDER BY total_liquido DESC
        LIMIT ?
    `).all(limite);
}

/**
 * Resumo por status conciliado
 */
function resumoPorStatus() {
    return db.prepare(`
        SELECT 
            status_conciliado as status,
            recebido,
            COUNT(*) as quantidade,
            COALESCE(SUM(valor_liquido), 0) as total_liquido,
            COALESCE(SUM(valor_nota), 0) as total_bruto
        FROM notas_fiscais
        GROUP BY status_conciliado, recebido
        ORDER BY total_liquido DESC
    `).all();
}

/**
 * Recebimentos mensais (valor recebido vs em aberto por mês)
 */
function recebimentosMensais() {
    return db.prepare(`
        SELECT 
            strftime('%Y-%m', data_emissao) as mes,
            SUM(CASE WHEN recebido = 'Recebido' THEN valor_liquido ELSE 0 END) as recebido,
            SUM(CASE WHEN recebido = 'Em aberto' THEN valor_liquido ELSE 0 END) as em_aberto,
            SUM(CASE WHEN recebido = 'Recebido' THEN 1 ELSE 0 END) as qtd_recebido,
            SUM(CASE WHEN recebido = 'Em aberto' THEN 1 ELSE 0 END) as qtd_aberto
        FROM notas_fiscais
        WHERE data_emissao IS NOT NULL AND data_emissao != ''
        GROUP BY strftime('%Y-%m', data_emissao)
        ORDER BY mes
    `).all();
}

/**
 * DSO mensal (dias médios para receber por mês de emissão)
 */
function dsoMensal() {
    return db.prepare(`
        SELECT 
            strftime('%Y-%m', data_emissao) as mes,
            AVG(COALESCE(
                CASE WHEN dias_pagamento > 0 THEN dias_pagamento ELSE NULL END,
                CASE WHEN data_pagamento IS NOT NULL AND data_pagamento != '' 
                     THEN CAST(julianday(data_pagamento) - julianday(data_emissao) AS INTEGER)
                     ELSE NULL END
            )) as dso_medio,
            MIN(COALESCE(
                CASE WHEN dias_pagamento > 0 THEN dias_pagamento ELSE NULL END,
                CASE WHEN data_pagamento IS NOT NULL AND data_pagamento != '' 
                     THEN CAST(julianday(data_pagamento) - julianday(data_emissao) AS INTEGER)
                     ELSE NULL END
            )) as dso_min,
            MAX(COALESCE(
                CASE WHEN dias_pagamento > 0 THEN dias_pagamento ELSE NULL END,
                CASE WHEN data_pagamento IS NOT NULL AND data_pagamento != '' 
                     THEN CAST(julianday(data_pagamento) - julianday(data_emissao) AS INTEGER)
                     ELSE NULL END
            )) as dso_max,
            COUNT(*) as quantidade
        FROM notas_fiscais
        WHERE recebido = 'Recebido'
        GROUP BY strftime('%Y-%m', data_emissao)
        ORDER BY mes
    `).all();
}

/**
 * Faturamento por estado
 */
function faturamentoPorEstado() {
    return db.prepare(`
        SELECT 
            estado,
            COUNT(*) as quantidade,
            COALESCE(SUM(valor_liquido), 0) as total_liquido,
            COALESCE(SUM(valor_nota), 0) as total_bruto
        FROM notas_fiscais
        WHERE estado IS NOT NULL AND estado != ''
        GROUP BY estado
        ORDER BY total_liquido DESC
    `).all();
}

// ==================== UTILITÁRIOS ====================

function getDb() {
    return db;
}

/**
 * Cria backup do banco de dados com timestamp
 */
async function backup() {
    const fs = require('fs');
    const backupDir = path.join(path.dirname(DB_PATH), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupDir, `notas_${timestamp}.db`);

    await db.backup(backupPath);
    console.log(`💾 Backup salvo: ${backupPath}`);

    // Manter apenas os últimos 7 backups
    const backups = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('notas_') && f.endsWith('.db'))
        .sort()
        .reverse();
    backups.slice(7).forEach(f => {
        fs.unlinkSync(path.join(backupDir, f));
        console.log(`🗑️ Backup antigo removido: ${f}`);
    });
}

function close() {
    if (db) db.close();
}

module.exports = {
    initialize,
    getDb,
    close,
    backup,
    // Notas
    listarNotas,
    buscarNotaPorId,
    buscarNotaPorNumeroECnpj,
    inserirNota,
    inserirNotasEmLote,
    atualizarNota,
    marcarComoPaga,
    deletarNota,
    obterEstatisticas,
    // Analytics
    faturamentoMensal,
    topClientes,
    resumoPorStatus,
    recebimentosMensais,
    dsoMensal,
    faturamentoPorEstado,
    // Clientes
    listarClientes,
    buscarClientePorCnpj,
    inserirOuAtualizarCliente,
    // Mapeamento Clientes
    listarMapeamentoClientes,
    buscarMapeamentoPorRazao,
    salvarMapeamentoCliente,
    deletarMapeamentoCliente,
    // Sincronizações
    registrarSincronizacao,
    finalizarSincronizacao,
    listarSincronizacoes
};
