/**
 * Scraper - Painel Fornecedor Finnet (Cimed)
 * URL: https://painelfornecedor.com.br/Cimed
 * 
 * Duas estratégias para obter dados de pagamento:
 * 1. Scraping automático via Playwright + Stealth (anti-detecção WAF)
 * 2. Importação manual do XLS exportado pelo portal (botão "Relatório XLS")
 * 
 * Cruza pelo número do documento (NF) para atualizar status de pagamento no banco.
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const logger = require('./logger');

// Ativar plugin stealth no Playwright — mascara navigator.webdriver e outros sinais
chromium.use(StealthPlugin());

const PORTAL_URL = 'https://painelfornecedor.com.br/Cimed';
const PORTAL_VISAO = 'https://painelfornecedor.com.br/Cimed?ctr=visaoFavorecido&mt=index';
const DEBUG_DIR = path.join(__dirname, '..', 'data', 'debug');

function ensureDebugDir() {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

/**
 * Importa dados de pagamento a partir de um buffer XLS exportado pelo portal Finnet.
 * O usuário baixa o "Relatório XLS" do portal e faz upload no dashboard.
 * 
 * @param {Buffer} buffer - Buffer do arquivo XLS/XLSX
 * @returns {Object} Resultado com totais
 */
function importarPagamentosXLS(buffer) {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });

    let allPagamentos = [];

    // Iterar TODAS as sheets — o relatório Finnet espalha dados em múltiplas sheets
    // (Sheet1 = cabeçalho, Sheet2 = empresa, Sheet3 = forma pgto, Sheet4 = dados, etc.)
    for (const sheetName of workbook.SheetNames) {
        const ws = workbook.Sheets[sheetName];
        const rawData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

        if (rawData.length < 2) continue;

        // Detectar se é sheet de dados: primeira linha deve ter "Documento" (possivelmente com HTML entities)
        const headerRow = rawData[0];
        const headerStr = headerRow.map(h => String(h)).join(' ');
        if (!headerStr.includes('Documento')) continue;

        // Mapear índices das colunas pelo header
        const colMap = {};
        headerRow.forEach((h, i) => {
            const t = String(h).replace(/&[^;]+;/g, '').toLowerCase().trim();
            if (t.includes('favorecido')) colMap.favorecido = i;
            else if (t === 'documento') colMap.documento = i;
            else if (t === 'pagamento') colMap.pagamento = i;
            else if (t === 'vencimento') colMap.vencimento = i;
            else if (t === 'valor') colMap.valor = i;
            else if (t.includes('situa')) colMap.situacao = i;
            else if (t.includes('lan') || t.includes('tipo')) colMap.lancamento = i;
            else if (t.includes('banco') || t.includes('banc')) colMap.numeroBancario = i;
        });

        if (colMap.documento === undefined) continue;

        const numCols = headerRow.length; // 12 ou 14
        logger.info(`📑 Sheet "${sheetName}": ${rawData.length - 1} linhas, ${numCols} colunas`);

        // Extrair linhas de dados (a partir da linha 1)
        for (let i = 1; i < rawData.length; i++) {
            const row = rawData[i];
            if (!row || row.length < 4) continue;

            let docRaw = String(row[colMap.documento] || '').trim();

            // Limpar prefixo "N°:" / "Nº:" do documento
            docRaw = docRaw.replace(/^N[°º&][^:]*:\s*/i, '').trim();
            // Remover entidades HTML residuais
            docRaw = docRaw.replace(/&[^;]+;/g, '').trim();

            // Pular linhas sem documento numérico, linhas de total, e linhas vazias
            if (!docRaw || !/^\d+$/.test(docRaw)) continue;

            // Pegar valor — pode estar em coluna diferente dependendo do formato (12 vs 14 colunas)
            const valorRaw = row[colMap.valor];
            const pagamentoRaw = row[colMap.pagamento];
            const vencimentoRaw = colMap.vencimento !== undefined ? row[colMap.vencimento] : '';
            const situacaoRaw = colMap.situacao !== undefined ? String(row[colMap.situacao] || '') : '';
            const favorecidoRaw = colMap.favorecido !== undefined ? String(row[colMap.favorecido] || '') : '';

            // Pular sub-linhas de detalhe (em sheets de 14 colunas, linhas pares são detalhes com favorecido vazio)
            if (numCols >= 14 && !favorecidoRaw.trim() && !situacaoRaw.trim()) continue;

            allPagamentos.push({
                pagador: '',
                favorecido: favorecidoRaw,
                lancamento: colMap.lancamento !== undefined ? String(row[colMap.lancamento] || '') : 'TED',
                documento: docRaw,
                numeroBancario: colMap.numeroBancario !== undefined ? String(row[colMap.numeroBancario] || '') : '',
                vencimento: parseXLSDate(vencimentoRaw),
                pagamento: parseXLSDate(pagamentoRaw),
                valor: parseXLSValor(valorRaw),
                situacao: situacaoRaw.replace(/&[^;]+;/g, '').trim()
            });
        }
    }

    if (allPagamentos.length === 0) {
        throw new Error('Nenhum pagamento encontrado no XLS. Verifique se é um "Relatório de Compromissos" exportado do portal Finnet.');
    }

    // Remover duplicatas (mesmo documento pode aparecer em sheets diferentes)
    const seen = new Set();
    allPagamentos = allPagamentos.filter(p => {
        const key = `${p.documento}_${p.valor}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    logger.info(`📦 ${allPagamentos.length} pagamentos únicos extraídos do XLS`);

    const syncId = db.registrarSincronizacao('importacao_pagamentos_xls');
    const resultado = atualizarPagamentosNoBanco(allPagamentos);

    db.finalizarSincronizacao(syncId, {
        encontrados: allPagamentos.length,
        novos: resultado.atualizados
    });

    return {
        success: true,
        totalExtraidos: allPagamentos.length,
        atualizados: resultado.atualizados,
        jaRecebidos: resultado.jaRecebidos,
        naoEncontrados: resultado.naoEncontrados,
        detalhes: resultado.detalhes
    };
}

/**
 * Converte data de XLS (pode ser serial number, string BR ou string ISO)
 */
function parseXLSDate(val) {
    if (!val) return '';
    if (typeof val === 'number') {
        // Excel date serial
        const date = new Date((val - 25569) * 86400000);
        const d = String(date.getDate()).padStart(2, '0');
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const y = date.getFullYear();
        return `${d}/${m}/${y}`;
    }
    return String(val);
}

/**
 * Converte valor de XLS (pode ser número ou string BR)
 */
function parseXLSValor(val) {
    if (!val) return '';
    if (typeof val === 'number') return `R$ ${val.toFixed(2).replace('.', ',')}`;
    return String(val);
}

/**
 * Delay aleatório para simular comportamento humano
 */
function humanDelay(min = 800, max = 2500) {
    return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

/**
 * Digita texto letra por letra com velocidade humana
 */
async function humanType(page, selector, text) {
    const el = await page.$(selector);
    if (!el) return false;
    await el.click();
    await humanDelay(300, 600);
    for (const char of text) {
        await page.keyboard.type(char, { delay: 50 + Math.random() * 120 });
    }
    return true;
}

/**
 * Sincroniza pagamentos via scraping direto do portal.
 * Usa playwright-extra + stealth plugin para contornar WAF.
 * headless: false obrigatório (modo headed evita detecção).
 */
async function sincronizarPagamentos(email, senha) {
    const syncId = db.registrarSincronizacao('painel_fornecedor_cimed');
    let browser = null;

    try {
        logger.info('🏦 Abrindo Painel Fornecedor Finnet/Cimed (modo stealth)...');

        browser = await chromium.launch({
            headless: false,   // WAFs detectam headless — usar headed
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-infobars',
                '--window-size=1400,900',
                '--disable-dev-shm-usage',
                '--lang=pt-BR'
            ]
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 },
            locale: 'pt-BR',
            timezoneId: 'America/Sao_Paulo',
            // Headers extras para parecer navegador real
            extraHTTPHeaders: {
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"'
            }
        });

        // Init scripts adicionais — reforçar camuflagem além do stealth plugin
        await context.addInitScript(() => {
            // Garantir que webdriver está falso
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            // Chrome runtime
            window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){} };
            // Plugins realistas
            Object.defineProperty(navigator, 'plugins', {
                get: () => {
                    const arr = [
                        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                        { name: 'Native Client', filename: 'internal-nacl-plugin' }
                    ];
                    arr.length = 3;
                    return arr;
                }
            });
            // Permissions
            const originalQuery = window.navigator.permissions?.query;
            if (originalQuery) {
                window.navigator.permissions.query = (params) => 
                    params.name === 'notifications' 
                        ? Promise.resolve({ state: Notification.permission }) 
                        : originalQuery(params);
            }
        });

        const page = await context.newPage();
        page.setDefaultTimeout(45000);

        // ── STEP 1: Acessar portal com delay humano ──
        logger.info('🔑 Acessando portal...');
        await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await humanDelay(2000, 4000);  // Espera humana após carregar

        // Mover mouse aleatoriamente para simular presença humana
        await page.mouse.move(400 + Math.random() * 200, 300 + Math.random() * 100);
        await humanDelay(500, 1000);

        // Verificar se WAF bloqueou
        const bodyText = await page.evaluate(() => document.body.innerText);
        if (bodyText.includes('bloqueada') || bodyText.includes('blocked')) {
            ensureDebugDir();
            await page.screenshot({ path: path.join(DEBUG_DIR, 'finnet-blocked.png'), fullPage: true });
            throw new Error('Portal bloqueou o acesso (WAF). Use a importação do XLS: baixe o "Relatório XLS" no portal e importe pelo dashboard.');
        }

        // ── STEP 2: Login com digitação humana ──
        logger.info('🔑 Fazendo login...');
        await humanDelay(1000, 2000);

        // Localizar campos de login — o portal Finnet/Cimed usa campos simples (text + password)
        // Labels: "Usuário" e "Senha", botão "Acessar"
        const emailField = await page.$('input[type="text"], input[type="email"], input[name="email"], input[name="login"], input[name="usuario"], input[id*="email"], input[id*="login"], input[id*="user"], input[id*="usuario"]');
        const senhaField = await page.$('input[type="password"]');

        if (!emailField || !senhaField) {
            ensureDebugDir();
            await page.screenshot({ path: path.join(DEBUG_DIR, 'finnet-login-page.png'), fullPage: true });
            throw new Error('Campos de login não encontrados. O portal pode ter mudado ou bloqueado. Use a importação do XLS.');
        }

        // Digitar email humanamente
        await emailField.click();
        await humanDelay(300, 700);
        await page.keyboard.type(email, { delay: 60 + Math.random() * 80 });
        await humanDelay(500, 1200);

        // Tab para senha como humano faria
        await page.keyboard.press('Tab');
        await humanDelay(300, 600);
        await page.keyboard.type(senha, { delay: 70 + Math.random() * 90 });
        await humanDelay(800, 1500);

        // Clicar no botão de login
        const btnLogin = await page.$('button[type="submit"], input[type="submit"], button:has-text("Entrar"), button:has-text("Login"), button:has-text("Acessar")');
        if (btnLogin) {
            await btnLogin.click();
        } else {
            await page.keyboard.press('Enter');
        }

        // Esperar navegação pós-login
        await page.waitForLoadState('networkidle', { timeout: 30000 });
        await humanDelay(2000, 4000);

        ensureDebugDir();
        await page.screenshot({ path: path.join(DEBUG_DIR, 'finnet-pos-login.png'), fullPage: true });
        logger.info(`📍 URL pós-login: ${page.url()}`);

        // ── STEP 3: Navegar para visão de pagamentos ──
        logger.info('📊 Navegando para visão de pagamentos...');
        await humanDelay(1000, 2000);
        await page.goto(PORTAL_VISAO, { waitUntil: 'networkidle', timeout: 30000 });
        await humanDelay(2000, 4000);

        // Verificar bloqueio novamente
        const bodyText2 = await page.evaluate(() => document.body.innerText);
        if (bodyText2.includes('bloqueada') || bodyText2.includes('blocked')) {
            await page.screenshot({ path: path.join(DEBUG_DIR, 'finnet-blocked-after-login.png'), fullPage: true });
            throw new Error('Portal bloqueou o acesso após login (WAF). Use a importação do XLS.');
        }

        await page.screenshot({ path: path.join(DEBUG_DIR, 'finnet-pagamentos.png'), fullPage: true });

        // ── STEP 4: Ajustar filtros de data para capturar o máximo de dados ──
        // O portal filtra por padrão os últimos 3 meses. Vamos expandir para capturar tudo.
        logger.info('📅 Ajustando filtros de data para período máximo...');

        // Calcular datas: início = hoje - 365 dias, fim = hoje
        const hoje = new Date();
        const dataFim = `${String(hoje.getDate()).padStart(2,'0')}/${String(hoje.getMonth()+1).padStart(2,'0')}/${hoje.getFullYear()}`;
        const inicio = new Date(hoje);
        inicio.setDate(inicio.getDate() - 365);
        const dataInicio = `${String(inicio.getDate()).padStart(2,'0')}/${String(inicio.getMonth()+1).padStart(2,'0')}/${inicio.getFullYear()}`;

        // 4a) Expandir filtros se estiverem colapsados
        // Procurar botão/link de toggle dos filtros
        const toggleFiltros = await page.$('a:has-text("Filtros"), a:has-text("filtros"), button:has-text("Filtros"), .toggle-filtros, [data-toggle="collapse"], a[href*="filtro"], a[onclick*="filtro"], .panel-heading a, .card-header a, a:has-text("Filtrar"), a:has-text("Exibir filtros")');
        if (toggleFiltros) {
            const isVisible = await toggleFiltros.isVisible();
            if (isVisible) {
                logger.debug('📅 Expandindo seção de filtros...');
                await toggleFiltros.click();
                await humanDelay(1000, 2000);
            }
        }

        // 4b) Dump de TODOS os inputs para entender a estrutura do formulário
        const allInputsDump = await page.evaluate(() => {
            const inputs = [];
            document.querySelectorAll('input').forEach(inp => {
                const rect = inp.getBoundingClientRect();
                const td = inp.closest('td');
                let labelText = '';
                if (td) {
                    const prevTd = td.previousElementSibling;
                    if (prevTd) labelText = prevTd.textContent.trim();
                }
                inputs.push({
                    id: inp.id,
                    name: inp.name,
                    type: inp.type,
                    value: inp.value,
                    visible: rect.width > 0 && rect.height > 0,
                    label: labelText,
                    placeholder: inp.placeholder
                });
            });
            return inputs;
        });
        logger.debug(`📅 Total de inputs na página: ${allInputsDump.length}`);
        // Logar inputs visíveis com data ou nomes sugestivos
        const inputsRelevantes = allInputsDump.filter(i => 
            i.visible && i.type === 'text' && (
                /^\d{2}\/\d{2}\/\d{4}$/.test(i.value) || 
                /data|date|pag/i.test(i.name || '') ||
                /data|date|pag/i.test(i.id || '')
            )
        );
        logger.debug(`📅 Inputs relevantes (visíveis, tipo text, com data/nome sugestivo): ${JSON.stringify(inputsRelevantes)}`);

        // 4c) Encontrar os campos de data de pagamento entre os inputs VISÍVEIS
        // Estratégia: buscar inputs type="text" visíveis que contêm datas DD/MM/YYYY
        const dateVisibleInputs = allInputsDump.filter(i => 
            i.visible && i.type === 'text' && /^\d{2}\/\d{2}\/\d{4}$/.test(i.value)
        );
        logger.debug(`📅 Inputs visíveis com datas: ${JSON.stringify(dateVisibleInputs)}`);

        let filtrosAplicados = false;
        let inputIniSelector = null;
        let inputFimSelector = null;

        // Estratégia 1: Identificar pelos nomes (convenção do portal: data_pag_ini, data_pag_fim)
        for (const inp of dateVisibleInputs) {
            const identifier = (inp.id + ' ' + inp.name + ' ' + inp.label).toLowerCase();
            if (identifier.includes('pag') && (identifier.includes('ini') || identifier.includes('inicial'))) {
                inputIniSelector = inp.id ? `#${inp.id}` : `input[name="${inp.name}"]`;
            }
            if (identifier.includes('pag') && (identifier.includes('fim') || identifier.includes('final'))) {
                inputFimSelector = inp.id ? `#${inp.id}` : `input[name="${inp.name}"]`;
            }
        }

        // Estratégia 2: Se não achou por nome, usar label do TD anterior
        if (!inputIniSelector || !inputFimSelector) {
            for (const inp of dateVisibleInputs) {
                if (inp.label.includes('Pagamento Inicial') && !inputIniSelector) {
                    inputIniSelector = inp.id ? `#${inp.id}` : `input[name="${inp.name}"]`;
                }
                if (inp.label.includes('Pagamento Final') && !inputFimSelector) {
                    inputFimSelector = inp.id ? `#${inp.id}` : `input[name="${inp.name}"]`;
                }
            }
        }

        // Estratégia 3: Se há exatamente 4 inputs de data visíveis, são:
        // [Data Pag Inicial, Data Pag Final, Data Venc Inicial, Data Venc Final]
        if (!inputIniSelector && !inputFimSelector && dateVisibleInputs.length >= 2) {
            const first = dateVisibleInputs[0];
            const second = dateVisibleInputs[1];
            inputIniSelector = first.id ? `#${first.id}` : `input[name="${first.name}"]`;
            inputFimSelector = second.id ? `#${second.id}` : `input[name="${second.name}"]`;
            logger.debug('📅 Usando fallback posicional: primeiros 2 inputs de data visíveis');
        }

        logger.debug(`📅 Seletores finais: ini=${inputIniSelector}, fim=${inputFimSelector}`);

        if (inputIniSelector && inputFimSelector) {
            const inputIni = await page.$(inputIniSelector);
            const inputFim = await page.$(inputFimSelector);

            if (inputIni && inputFim) {
                // Verificar que são visíveis antes de clicar
                const iniVisible = await inputIni.isVisible();
                const fimVisible = await inputFim.isVisible();
                logger.debug(`📅 Visibilidade: ini=${iniVisible}, fim=${fimVisible}`);

                if (iniVisible && fimVisible) {
                    // Forçar valor via DOM + evaluate (datepickers ignoram keyboard.type)
                    await page.evaluate(({ iniSel, fimSel, dtIni, dtFim }) => {
                        function setDateInput(selector, value) {
                            const el = document.querySelector(selector);
                            if (!el) return;
                            // Setar via nativeInputValueSetter para contornar React/jQuery
                            const nativeSetter = Object.getOwnPropertyDescriptor(
                                window.HTMLInputElement.prototype, 'value'
                            ).set;
                            nativeSetter.call(el, value);
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            // Disparar eventos extras que datepickers jQuery escutam
                            el.dispatchEvent(new Event('blur', { bubbles: true }));
                            if (typeof jQuery !== 'undefined') {
                                try { jQuery(el).trigger('change'); } catch(e) {}
                            }
                        }
                        setDateInput(iniSel, dtIni);
                        setDateInput(fimSel, dtFim);
                    }, { iniSel: inputIniSelector, fimSel: inputFimSelector, dtIni: dataInicio, dtFim: dataFim });

                    await humanDelay(500, 1000);

                    // Verificar se os valores foram realmente aplicados
                    const valIni = await inputIni.inputValue();
                    const valFim = await inputFim.inputValue();
                    logger.debug(`📅 Valores após preenchimento: ini=${valIni}, fim=${valFim}`);

                    if (valIni !== dataInicio || valFim !== dataFim) {
                        // Fallback: triple-click + type como último recurso
                        logger.debug('📅 Valores não bateram, tentando via keyboard...');
                        await inputIni.click({ clickCount: 3 });
                        await humanDelay(200, 400);
                        await page.keyboard.press('Backspace');
                        await humanDelay(100, 200);
                        await inputIni.fill(dataInicio);
                        await humanDelay(400, 800);
                        await page.click('body', { position: { x: 10, y: 10 } });
                        await humanDelay(500, 800);

                        await inputFim.click({ clickCount: 3 });
                        await humanDelay(200, 400);
                        await page.keyboard.press('Backspace');
                        await humanDelay(100, 200);
                        await inputFim.fill(dataFim);
                        await humanDelay(500, 1000);
                        await page.click('body', { position: { x: 10, y: 10 } });
                        await humanDelay(300, 500);

                        const valIni2 = await inputIni.inputValue();
                        const valFim2 = await inputFim.inputValue();
                        logger.debug(`📅 Valores após fallback keyboard: ini=${valIni2}, fim=${valFim2}`);
                    }

                    logger.info(`📅 Filtro preenchido: ${dataInicio} a ${dataFim}`);
                    filtrosAplicados = true;
                }
            }
        }

        if (filtrosAplicados) {
            // Clicar em Pesquisar
            const btnPesquisar = await page.$('input[value="Pesquisar"], button:has-text("Pesquisar")');
            if (btnPesquisar) {
                await btnPesquisar.click();
                await page.waitForLoadState('networkidle', { timeout: 30000 });
                await humanDelay(2000, 4000);

                // Verificar total de registros após pesquisa
                const totalInfo = await page.evaluate(() => {
                    const inputs = document.querySelectorAll('input[type="text"]');
                    for (const inp of inputs) {
                        const name = (inp.name || '').toLowerCase();
                        if (name.includes('tot_pagamentos') || name.includes('total')) {
                            if (/^\d+$/.test(inp.value)) return inp.value;
                        }
                    }
                    return null;
                });
                logger.info(`🔍 Pesquisa executada com filtros expandidos (total registros: ${totalInfo || 'desconhecido'})`);
            }
            await page.screenshot({ path: path.join(DEBUG_DIR, 'finnet-filtros-expandidos.png'), fullPage: true });
        } else {
            logger.info('⚠️ Campos de data não encontrados — usando filtro padrão do portal');
        }

        // ── STEP 5: Aumentar registros por página para pegar TODOS ──
        try {
            // Procurar qualquer select ou input que controle registros por página
            const paginacaoAlterada = await page.evaluate(() => {
                // Tentar selects com opções numéricas (10, 25, 50, 100...)
                const selects = document.querySelectorAll('select');
                for (const sel of selects) {
                    const opts = Array.from(sel.options).map(o => o.value);
                    if (opts.some(v => /^\d+$/.test(v) && parseInt(v) >= 10)) {
                        // Selecionar a opção com maior valor
                        const maxOpt = opts.filter(v => /^\d+$/.test(v)).sort((a,b) => parseInt(b) - parseInt(a))[0];
                        if (maxOpt) { sel.value = maxOpt; sel.dispatchEvent(new Event('change', {bubbles:true})); return `select=${maxOpt}`; }
                    }
                }
                // Tentar input de "registros por página" / "current_page" / paginação
                const inputs = document.querySelectorAll('input[type="text"]');
                for (const inp of inputs) {
                    const name = (inp.name || '').toLowerCase();
                    const id = (inp.id || '').toLowerCase();
                    // Pular inputs de data e totais
                    if (/date|data|pag_pago|pag_agendado|tot_pago|tot_agendado|val_pag/i.test(name)) continue;
                    if (/^\d+$/.test(inp.value) && parseInt(inp.value) <= 100 && parseInt(inp.value) >= 1) {
                        if (name.includes('pag_pagamentos') || id.includes('page')) {
                            // Input de "registros por página" - NÃO alterar current_page
                            if (id === 'current_page' || name === 'current_page') continue;
                            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                            nativeSetter.call(inp, '500');
                            inp.dispatchEvent(new Event('input', {bubbles:true}));
                            inp.dispatchEvent(new Event('change', {bubbles:true}));
                            return `input[${name||id}]=500`;
                        }
                    }
                }
                return null;
            });

            if (paginacaoAlterada) {
                logger.info(`📄 Paginação alterada: ${paginacaoAlterada}`);
                // Clicar em Pesquisar novamente para aplicar nova paginação
                const btnPesquisar2 = await page.$('input[value="Pesquisar"], button:has-text("Pesquisar")');
                if (btnPesquisar2) {
                    await btnPesquisar2.click();
                    await page.waitForLoadState('networkidle', { timeout: 30000 });
                    await humanDelay(2000, 4000);
                }
            } else {
                logger.info('📄 Nenhum controle de paginação encontrado');
            }
        } catch (e) {
            logger.info(`⚠️ Não foi possível alterar registros por página: ${e.message}`);
        }

        // ── STEP 6: Extrair dados da tabela (com suporte a múltiplas páginas) ──
        logger.info('📋 Extraindo dados de pagamentos...');

        let allDadosPagamento = [];
        let paginaAtual = 1;
        const MAX_PAGINAS = 20; // Segurança: máximo de páginas

        while (paginaAtual <= MAX_PAGINAS) {
        const pagamentos = await page.evaluate(() => {
            const allRows = [];
            const tables = document.querySelectorAll('table');
            let tablesProcessed = 0;

            // Iterar TODAS as tabelas de pagamento (portal pode ter múltiplas empresas)
            for (const table of tables) {
                const headers = table.querySelectorAll('th');
                const headerTexts = Array.from(headers).map(h => h.textContent.trim());
                if (!headerTexts.some(h => h.includes('Documento')) || 
                    !headerTexts.some(h => h.includes('Pagamento') || h.includes('Valor'))) {
                    continue;
                }

                tablesProcessed++;

            // Mapear índices das colunas pelo texto exato do header
            const headerMap = {};

            headerTexts.forEach((txt, i) => {
                const t = txt.toLowerCase();
                // Usar match mais preciso para evitar conflitos (ex: "pagador" vs "pagamento")
                if (t === 'pagador' || t.startsWith('pagador')) headerMap.pagador = i;
                else if (t === 'favorecido' || t.startsWith('favorecido')) headerMap.favorecido = i;
                else if (t.includes('lançamento') || t.includes('lancamento')) headerMap.lancamento = i;
                else if (t === 'documento' || t.startsWith('documento')) headerMap.documento = i;
                else if (t.includes('número bancário') || t.includes('numero bancario') || t.includes('nº bancário')) headerMap.numeroBancario = i;
                else if (t === 'vencimento' || t.startsWith('vencimento')) headerMap.vencimento = i;
                else if (t === 'pagamento' || t.startsWith('pagamento')) headerMap.pagamento = i;
                else if (t === 'valor' || t.startsWith('valor')) headerMap.valor = i;
                else if (t.includes('situação') || t.includes('situacao') || t === 'situação') headerMap.situacao = i;
            });

            // Extrair linhas de dados
            // IMPORTANTE: A coluna "Ações" no TH é 1 coluna (colspan), 
            // mas no TD são 4 cells (checkbox + 3 ícones).
            // Logo os TDs com 13 cells têm offset +2 em relação aos headers com 11 THs.
            const allTrs = table.querySelectorAll('tbody tr');
            const cellCounts = {};
            for (const tr of allTrs) {
                const cells = tr.querySelectorAll('td');
                const count = cells.length;
                cellCounts[count] = (cellCounts[count] || 0) + 1;
            }

            // Calcular offset: TDs de dados vs THs
            const thCount = headerTexts.length; // 11
            const dataTdCount = Object.entries(cellCounts)
                .filter(([c]) => parseInt(c) >= thCount)
                .sort((a, b) => b[1] - a[1])[0]?.[0];
            const tdOffset = dataTdCount ? parseInt(dataTdCount) - thCount : 0;

            for (const tr of allTrs) {
                const cells = tr.querySelectorAll('td');
                // Só processar linhas de dados completas (13 cells)
                if (!dataTdCount || cells.length !== parseInt(dataTdCount)) continue;

                const get = (key) => {
                    const idx = headerMap[key];
                    if (idx === undefined) return '';
                    // Aplicar offset para colunas após "Ações"
                    const adjustedIdx = idx <= 1 ? idx : idx + tdOffset;
                    return cells[adjustedIdx] ? cells[adjustedIdx].textContent.trim() : '';
                };

                const doc = get('documento');
                // Filtrar: documento deve ser numérico (NF number)
                if (!doc || !/^\d+$/.test(doc.trim())) continue;

                allRows.push({
                    pagador: get('pagador'),
                    favorecido: get('favorecido'),
                    lancamento: get('lancamento'),
                    documento: doc.trim(),
                    numeroBancario: get('numeroBancario'),
                    vencimento: get('vencimento'),
                    pagamento: get('pagamento'),
                    valor: get('valor'),
                    situacao: get('situacao')
                });
            }
            } // fim for tables

            if (tablesProcessed === 0) return { error: 'Tabela de pagamentos não encontrada', tables: tables.length };
            return { data: allRows, tablesProcessed };
        });

        if (pagamentos.error) {
            throw new Error(pagamentos.error);
        }

        const dadosPagamento = pagamentos.data || [];
        if (paginaAtual === 1) {
            logger.info(`📊 ${pagamentos.tablesProcessed || 0} tabela(s) de pagamento encontrada(s)`);
        }
        logger.info(`✅ Página ${paginaAtual}: ${dadosPagamento.length} pagamentos extraídos`);
        allDadosPagamento = allDadosPagamento.concat(dadosPagamento);

        // Verificar se há próxima página
        if (dadosPagamento.length === 0) break;

        const temProximaPagina = await page.evaluate(() => {
            // Procurar botão/link de "próxima página" via CSS + texto
            const nextBtns = [...document.querySelectorAll('a.next, a[rel="next"], li.next a, .pagination .next a, .paginate_button.next:not(.disabled) a')];
            // Busca por texto (não usar :has-text — não é CSS válido em evaluate)
            document.querySelectorAll('a').forEach(a => {
                const t = a.textContent.trim();
                if (t === '>' || t === '>>' || t === '›' || /^pr[oó]xima$/i.test(t) || /^next$/i.test(t)) nextBtns.push(a);
            });
            for (const btn of nextBtns) {
                if (btn.offsetParent !== null) return true;
            }
            // Checar input current_page vs total
            const currentPageEl = document.getElementById('current_page');
            if (currentPageEl) {
                const current = parseInt(currentPageEl.value);
                const totalPagEl = document.querySelector('input[name="tot_pagamentos"]');
                const perPageEl = document.querySelector('input[name="pag_pagamentos"]');
                if (totalPagEl && perPageEl) {
                    const total = parseInt(totalPagEl.value);
                    const perPage = parseInt(perPageEl.value);
                    if (total > current * perPage) return true;
                }
            }
            return false;
        });

        if (!temProximaPagina) {
            logger.info(`📄 Todas as páginas extraídas (${paginaAtual} página(s))`);
            break;
        }

        // Navegar para próxima página
        logger.info(`📄 Navegando para página ${paginaAtual + 1}...`);
        const navegou = await page.evaluate(() => {
            const nextBtns = [...document.querySelectorAll('a.next, a[rel="next"], li.next a, .pagination .next a, .paginate_button.next:not(.disabled) a')];
            document.querySelectorAll('a').forEach(a => {
                const t = a.textContent.trim();
                if (t === '>' || t === '>>' || t === '›' || /^pr[oó]xima$/i.test(t) || /^next$/i.test(t)) nextBtns.push(a);
            });
            for (const btn of nextBtns) {
                if (btn.offsetParent !== null) { btn.click(); return true; }
            }
            // Tentar incrementar current_page e submeter
            const currentPageEl = document.getElementById('current_page');
            if (currentPageEl) {
                const current = parseInt(currentPageEl.value);
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(currentPageEl, String(current + 1));
                currentPageEl.dispatchEvent(new Event('change', {bubbles:true}));
                // Clicar em pesquisar
                const btn = document.querySelector('input[value="Pesquisar"], button[type="submit"]');
                if (btn) { btn.click(); return true; }
            }
            return false;
        });

        if (!navegou) {
            logger.info('📄 Não conseguiu navegar para próxima página');
            break;
        }

        await page.waitForLoadState('networkidle', { timeout: 30000 });
        await humanDelay(2000, 4000);
        paginaAtual++;
        } // fim while paginação

        logger.info(`✅ Total: ${allDadosPagamento.length} pagamentos extraídos de ${paginaAtual} página(s)`);

        const resultado = atualizarPagamentosNoBanco(allDadosPagamento);

        db.finalizarSincronizacao(syncId, {
            encontrados: allDadosPagamento.length,
            novos: resultado.atualizados
        });

        await browser.close();

        return {
            success: true,
            totalExtraidos: allDadosPagamento.length,
            atualizados: resultado.atualizados,
            jaRecebidos: resultado.jaRecebidos,
            naoEncontrados: resultado.naoEncontrados,
            detalhes: resultado.detalhes
        };

    } catch (error) {
        logger.error({ err: error.message }, '❌ Erro no scraping Painel Fornecedor');

        db.finalizarSincronizacao(syncId, {
            encontrados: 0, novos: 0, erro: error.message
        });

        if (browser) {
            try { await browser.close(); } catch (e) {}
        }

        throw error;
    }
}

/**
 * Converte string de data brasileira (DD/MM/YYYY) para ISO (YYYY-MM-DD)
 */
function parseDateBR(str) {
    if (!str) return null;
    const parts = str.trim().match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!parts) return null;
    return `${parts[3]}-${parts[2]}-${parts[1]}`;
}

/**
 * Converte string de valor brasileiro (R$ 1.234,56) para número
 */
function parseValorBR(str) {
    if (!str) return 0;
    return parseFloat(str.replace(/[R$\s.]/g, '').replace(',', '.')) || 0;
}

/**
 * Cruza os dados extraídos do portal com o banco de dados local.
 * Para cada pagamento do portal, busca a nota pelo número e atualiza
 * data_pagamento, status_conciliado, recebido, dias_pagamento.
 */
function atualizarPagamentosNoBanco(pagamentos) {
    let atualizados = 0;
    let jaRecebidos = 0;
    let naoEncontrados = 0;
    const detalhes = [];

    for (const pgto of pagamentos) {
        const numDoc = String(pgto.documento).trim();
        if (!numDoc) continue;

        const dataPgto = parseDateBR(pgto.pagamento);
        const dataVencimento = parseDateBR(pgto.vencimento);
        const valor = parseValorBR(pgto.valor);
        const situacao = (pgto.situacao || '').trim().toLowerCase();

        // Buscar nota pelo número no banco
        // O portal às vezes usa formatos diferentes:
        //   - Número exato (ex: 363)
        //   - Prefixo de ano + número (ex: 2025363 = ano 2025 + nota 363)
        //   - Dígito extra no início (ex: 5385 = nota 385)
        // Tentamos: exato → prefixo ano → sem primeiro dígito → sem primeiros 2 dígitos → LIKE %numero
        let notas = db.getDb().prepare(
            "SELECT id, numero, data_emissao, valor_nota, valor_liquido, recebido, previsao_recebimento FROM notas_fiscais WHERE numero = ?"
        ).all(numDoc);

        // Fallback 1: prefixo de ano (ex: 2025363 → nota 363, 2024150 → nota 150)
        // O portal Finnet pode formatar o documento como YYYYNNN onde YYYY é o ano
        if (notas.length === 0 && numDoc.length >= 5) {
            const anoMatch = numDoc.match(/^(20\d{2})(\d+)$/);
            if (anoMatch) {
                const anoPortal = anoMatch[1];
                const numNota = anoMatch[2];
                notas = db.getDb().prepare(
                    "SELECT id, numero, data_emissao, valor_nota, valor_liquido, recebido, previsao_recebimento FROM notas_fiscais WHERE numero = ?"
                ).all(numNota);
                if (notas.length > 0) {
                    logger.info(`🔄 Doc ${numDoc} → nota ${numNota} (removido prefixo de ano ${anoPortal})`);
                }
            }
        }

        // Fallback 2: remover primeiro dígito (5385 → 385)
        if (notas.length === 0 && numDoc.length > 3) {
            const semPrimeiro = numDoc.substring(1);
            notas = db.getDb().prepare(
                "SELECT id, numero, data_emissao, valor_nota, valor_liquido, recebido, previsao_recebimento FROM notas_fiscais WHERE numero = ?"
            ).all(semPrimeiro);
            if (notas.length > 0) {
                logger.info(`🔄 Doc ${numDoc} → nota ${semPrimeiro} (removido dígito extra do início)`);
            }
        }

        // Fallback 3: remover primeiros 2 dígitos (ex: 12385 → 385)
        if (notas.length === 0 && numDoc.length > 4) {
            const semDois = numDoc.substring(2);
            notas = db.getDb().prepare(
                "SELECT id, numero, data_emissao, valor_nota, valor_liquido, recebido, previsao_recebimento FROM notas_fiscais WHERE numero = ?"
            ).all(semDois);
            if (notas.length > 0) {
                logger.info(`🔄 Doc ${numDoc} → nota ${semDois} (removidos 2 dígitos extras do início)`);
            }
        }

        // Fallback 4: buscar notas que terminam com o mesmo número (LIKE %numero)
        if (notas.length === 0 && numDoc.length >= 3) {
            notas = db.getDb().prepare(
                "SELECT id, numero, data_emissao, valor_nota, valor_liquido, recebido, previsao_recebimento FROM notas_fiscais WHERE numero LIKE ?"
            ).all(`%${numDoc}`);
            if (notas.length > 0) {
                logger.info(`🔄 Doc ${numDoc} → nota ${notas[0].numero} (sufixo match)`);
            }
        }

        if (notas.length === 0) {
            naoEncontrados++;
            detalhes.push({ numero: numDoc, status: 'nao_encontrada', valor });
            continue;
        }

        // Se há múltiplas notas com o mesmo número, pegar a com valor mais próximo
        let nota = notas[0];

        // Validação cruzada por valor — se o match foi por fallback (número diferente),
        // confirmar que o valor bate (tolerância de 5%) para evitar falso positivo
        if (nota.numero !== numDoc && valor > 0) {
            const valorNota = nota.valor_liquido || nota.valor_nota;
            const diffPercent = Math.abs(valorNota - valor) / Math.max(valorNota, valor, 1);
            if (diffPercent > 0.05) {
                logger.info(`⚠️ Doc ${numDoc} → nota ${nota.numero}: valor diverge (portal: R$${valor.toFixed(2)}, DB: R$${valorNota.toFixed(2)}, diff: ${(diffPercent*100).toFixed(1)}%) — ignorado`);
                naoEncontrados++;
                detalhes.push({ numero: numDoc, status: 'valor_divergente', valor, valorDB: valorNota });
                continue;
            }
            logger.info(`✅ Doc ${numDoc} → nota ${nota.numero}: valor confirmado (R$${valor.toFixed(2)} ≈ R$${valorNota.toFixed(2)})`);
        }
        if (notas.length > 1) {
            nota = notas.reduce((best, n) => {
                const diffBest = Math.abs((best.valor_liquido || best.valor_nota) - valor);
                const diffN = Math.abs((n.valor_liquido || n.valor_nota) - valor);
                return diffN < diffBest ? n : best;
            });
        }

        // Se já está como Recebido, pular
        if (nota.recebido === 'Recebido') {
            jaRecebidos++;
            detalhes.push({ numero: numDoc, status: 'ja_recebido', valor });
            continue;
        }

        // Calcular dias para pagamento
        let diasPagamento = null;
        if (dataPgto && nota.data_emissao) {
            const emissao = new Date(nota.data_emissao);
            const pagamento = new Date(dataPgto);
            diasPagamento = Math.floor((pagamento - emissao) / (1000 * 60 * 60 * 24));
        }

        // Determinar status conciliado
        let statusConciliado = 'Pago';
        if (dataVencimento && dataPgto) {
            const venc = new Date(dataVencimento);
            const pgtoDate = new Date(dataPgto);
            if (pgtoDate > venc) {
                statusConciliado = 'Pago com Atraso';
            } else if (pgtoDate < venc) {
                statusConciliado = 'Pago Antecipado';
            } else {
                statusConciliado = 'Pago no Prazo';
            }
        }

        // Se situação do portal é "Agendado", marcar como previsão
        if (situacao === 'agendado') {
            db.atualizarNota(nota.id, {
                previsao_recebimento: dataPgto || dataVencimento,
                status_conciliado: 'Agendado',
                observacoes: `Pagamento agendado - Finnet (${pgto.lancamento || 'TED'})`
            });
            atualizados++;
            detalhes.push({ numero: numDoc, status: 'agendado', valor, dataPrevista: dataPgto || dataVencimento });
            continue;
        }

        // Marcar como pago
        if (situacao === 'pago' || situacao === '') {
            db.marcarComoPaga(nota.id, {
                data_pagamento: dataPgto,
                forma_pagamento: pgto.lancamento || 'TED',
                status_conciliado: statusConciliado,
                dias_pagamento: diasPagamento
            });

            // Adicionar observação com informação do portal
            const obs = `Pago via ${pgto.lancamento || 'TED'} - Finnet${pgto.numeroBancario ? ' (Nº ' + pgto.numeroBancario + ')' : ''}`;
            db.atualizarNota(nota.id, { observacoes: obs });

            atualizados++;
            detalhes.push({ numero: numDoc, status: 'atualizado', valor, dataPagamento: dataPgto, statusConciliado });
        }
    }

    logger.info(`📊 Resultado: ${atualizados} atualizados, ${jaRecebidos} já recebidos, ${naoEncontrados} não encontrados`);
    return { atualizados, jaRecebidos, naoEncontrados, detalhes };
}

module.exports = {
    sincronizarPagamentos,
    importarPagamentosXLS
};
