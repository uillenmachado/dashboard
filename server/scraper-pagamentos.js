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
const PORTAL_ANTECIPACAO = 'https://painelfornecedor.com.br/Cimed?ctr=operacoesAntecipacao&mt=index';
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
 * Esconde o toast/aviso residual (`#msgAttention`) que o portal deixa sobreposto
 * apos buscas, bloqueando cliques em pontos aparentemente aleatorios da tela
 * (inclusive fora da area de filtros) por ate 45s.
 */
async function esconderMsgAttention(page) {
    await page.evaluate(() => {
        const el = document.getElementById('msgAttention');
        if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    }).catch(() => {});
}

/**
 * Clica em um ponto do body de forma resiliente (usado para fechar datepickers
 * abertos). Some com o #msgAttention antes e usa forca como fallback.
 */
async function clicarForaDoCampo(page) {
    await esconderMsgAttention(page);
    try {
        await page.click('body', { position: { x: 10, y: 10 }, timeout: 5000 });
    } catch (e) {
        await page.click('body', { position: { x: 10, y: 10 }, force: true, timeout: 5000 }).catch(() => {});
    }
}

/**
 * Clica em "Pesquisar" de forma resiliente. O portal às vezes deixa um
 * toast/aviso residual (`#msgAttention`) sobreposto ao botão, que intercepta
 * o clique e trava por até 45s (timeout padrão do Playwright). Esconde o
 * aviso antes de clicar e usa clique forçado como fallback.
 */
async function clicarPesquisar(page) {
    const btn = await page.$('input[value="Pesquisar"], button:has-text("Pesquisar")');
    if (!btn) return false;

    await esconderMsgAttention(page);

    try {
        await btn.click({ timeout: 8000 });
    } catch (e) {
        logger.debug(`⚠️ Clique normal em Pesquisar falhou (${e.message.split('\n')[0]}) — tentando clique forçado...`);
        await btn.click({ force: true, timeout: 8000 }).catch(() => {});
    }
    return true;
}

/**
 * Expande a seção de filtros (se colapsada) e localiza/preenche o par de
 * inputs de data início/fim de UM filtro específico do portal para a janela
 * desejada. Mesmo motor de grid usado tanto na tela de pagamentos ("Pagamento
 * Inicial/Final") quanto na de antecipação ("Requisição Inicial/Final") —
 * telas que podem ter MAIS de um par de datas visível simultaneamente
 * (ex: Vencimento + Requisição), por isso a identificação por keyword/label
 * é sempre tentada antes do fallback posicional.
 * @param {string} keywordCampo - substring (lowercase) esperada no name/id do input (ex: 'pag', 'requis')
 * @param {string} labelIni - texto esperado no label do TD anterior ao input de início (ex: 'Pagamento Inicial')
 * @param {string} labelFim - idem para o input de fim
 * @returns {Promise<boolean>} true se os campos foram localizados e preenchidos
 */
async function preencherFiltroDataJanela(page, dataInicio, dataFim, keywordCampo, labelIni, labelFim) {
    // Expandir filtros se estiverem colapsados
    const toggleFiltros = await page.$('a:has-text("Filtros"), a:has-text("filtros"), button:has-text("Filtros"), .toggle-filtros, [data-toggle="collapse"], a[href*="filtro"], a[onclick*="filtro"], .panel-heading a, .card-header a, a:has-text("Filtrar"), a:has-text("Exibir filtros")');
    if (toggleFiltros) {
        const isVisible = await toggleFiltros.isVisible();
        if (isVisible) {
            logger.debug('📅 Expandindo seção de filtros...');
            await toggleFiltros.click();
            await humanDelay(1000, 2000);
        }
    }

    // Dump de TODOS os inputs para entender a estrutura do formulário
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

    // Encontrar os campos de data entre os inputs VISÍVEIS (type text, valor DD/MM/YYYY)
    const dateVisibleInputs = allInputsDump.filter(i =>
        i.visible && i.type === 'text' && /^\d{2}\/\d{2}\/\d{4}$/.test(i.value)
    );
    logger.debug(`📅 [${keywordCampo}] Inputs visíveis com datas: ${JSON.stringify(dateVisibleInputs)}`);

    let inputIniSelector = null;
    let inputFimSelector = null;

    // Estratégia 1: Identificar pelos nomes/ids (convenção do portal: data_pag_ini, data_pag_fim)
    for (const inp of dateVisibleInputs) {
        const identifier = (inp.id + ' ' + inp.name + ' ' + inp.label).toLowerCase();
        if (identifier.includes(keywordCampo) && (identifier.includes('ini') || identifier.includes('inicial'))) {
            inputIniSelector = inp.id ? `#${inp.id}` : `input[name="${inp.name}"]`;
        }
        if (identifier.includes(keywordCampo) && (identifier.includes('fim') || identifier.includes('final'))) {
            inputFimSelector = inp.id ? `#${inp.id}` : `input[name="${inp.name}"]`;
        }
    }

    // Estratégia 2: Se não achou por nome, usar label exato do TD anterior
    if (!inputIniSelector || !inputFimSelector) {
        for (const inp of dateVisibleInputs) {
            if (inp.label.includes(labelIni) && !inputIniSelector) {
                inputIniSelector = inp.id ? `#${inp.id}` : `input[name="${inp.name}"]`;
            }
            if (inp.label.includes(labelFim) && !inputFimSelector) {
                inputFimSelector = inp.id ? `#${inp.id}` : `input[name="${inp.name}"]`;
            }
        }
    }

    // Estratégia 3 (último recurso): fallback posicional — só quando há
    // EXATAMENTE 2 inputs de data visíveis (evita pegar o par errado em telas
    // com múltiplos filtros de data, como Vencimento + Requisição)
    if (!inputIniSelector && !inputFimSelector && dateVisibleInputs.length === 2) {
        const first = dateVisibleInputs[0];
        const second = dateVisibleInputs[1];
        inputIniSelector = first.id ? `#${first.id}` : `input[name="${first.name}"]`;
        inputFimSelector = second.id ? `#${second.id}` : `input[name="${second.name}"]`;
        logger.debug(`📅 [${keywordCampo}] Usando fallback posicional: únicos 2 inputs de data visíveis`);
    }

    logger.debug(`📅 [${keywordCampo}] Seletores finais: ini=${inputIniSelector}, fim=${inputFimSelector}`);

    if (!inputIniSelector || !inputFimSelector) return false;

    const inputIni = await page.$(inputIniSelector);
    const inputFim = await page.$(inputFimSelector);
    if (!inputIni || !inputFim) return false;

    const iniVisible = await inputIni.isVisible();
    const fimVisible = await inputFim.isVisible();
    if (!iniVisible || !fimVisible) return false;

    // Forçar valor via DOM + evaluate (datepickers ignoram keyboard.type)
    // CUIDADO: o datepicker do portal valida "fim >= início" a cada mudança
    // de campo. Não dá pra assumir uma ordem fixa (ini-primeiro ou fim-primeiro)
    // porque o valor ANTIGO que ainda está no outro campo pode conflitar com o
    // NOVO valor em qualquer direção (janela nova pode ser inteira antes OU
    // inteira depois da janela anterior). Solução universal: 1) joga o início
    // para uma data-sentinela bem antiga (nunca conflita com nenhum fim antigo),
    // 2) seta o fim novo (nunca conflita com a sentinela), 3) só então seta o
    // início real (nunca conflita, pois início<=fim é garantido por construção).
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
        setDateInput(iniSel, '01/01/1900'); // sentinela: nunca conflita com nenhum fim
        setDateInput(fimSel, dtFim);
        setDateInput(iniSel, dtIni);
    }, { iniSel: inputIniSelector, fimSel: inputFimSelector, dtIni: dataInicio, dtFim: dataFim });

    await humanDelay(500, 1000);

    // Verificar se os valores foram realmente aplicados
    const valIni = await inputIni.inputValue();
    const valFim = await inputFim.inputValue();
    logger.debug(`📅 [${keywordCampo}] Valores após preenchimento: ini=${valIni}, fim=${valFim}`);

    if (valIni !== dataInicio || valFim !== dataFim) {
        // Fallback: triple-click + type como último recurso.
        // Mesma ordem (fim antes de início) pelo mesmo motivo de validação
        // "fim >= início" do datepicker do portal. Os campos costumam ser
        // readonly (widget de calendário) — .fill() pode nunca funcionar,
        // por isso cada passo tem timeout curto em vez do padrão de 45s.
        logger.debug(`📅 [${keywordCampo}] Valores não bateram, tentando via keyboard...`);
        try {
            await esconderMsgAttention(page);
            await inputFim.click({ clickCount: 3, timeout: 5000 }).catch(() => inputFim.click({ clickCount: 3, force: true, timeout: 5000 }));
            await humanDelay(200, 400);
            await page.keyboard.press('Backspace');
            await humanDelay(100, 200);
            await inputFim.fill(dataFim, { timeout: 5000 });
            await humanDelay(400, 800);
            await clicarForaDoCampo(page);
            await humanDelay(500, 800);

            await esconderMsgAttention(page);
            await inputIni.click({ clickCount: 3, timeout: 5000 }).catch(() => inputIni.click({ clickCount: 3, force: true, timeout: 5000 }));
            await humanDelay(200, 400);
            await page.keyboard.press('Backspace');
            await humanDelay(100, 200);
            await inputIni.fill(dataInicio, { timeout: 5000 });
            await humanDelay(500, 1000);
            await clicarForaDoCampo(page);
            await humanDelay(300, 500);
        } catch (e) {
            logger.debug(`📅 [${keywordCampo}] Fallback via keyboard não funcionou (campo provavelmente readonly): ${e.message.split('\n')[0]}`);
        }
    }

    logger.info(`📅 [${keywordCampo}] Filtro preenchido: ${dataInicio} a ${dataFim}`);
    return true;
}

/**
 * O filtro "Status" da grid de antecipação abre por padrão em "Antecipação
 * Agendada" (não "Todos") — sem selecionar "Todos" explicitamente, operações
 * já concluídas ("Antecipação Realizada", que são as que interessam para
 * conciliação) ficam de fora e a busca sempre retorna vazia.
 * @returns {Promise<boolean>} true se encontrou e selecionou o filtro
 */
async function selecionarStatusTodos(page) {
    return await page.evaluate(() => {
        const selects = document.querySelectorAll('select');
        for (const sel of selects) {
            const opts = Array.from(sel.options);
            const textos = opts.map(o => (o.textContent || '').trim());
            const temTodos = textos.some(t => /^todos$/i.test(t));
            const ehStatusAntecipacao = textos.some(t => /antecipa[çc][ãa]o/i.test(t));
            if (temTodos && ehStatusAntecipacao) {
                const optTodos = opts.find(o => /^todos$/i.test((o.textContent || '').trim()));
                if (optTodos && sel.value !== optTodos.value) {
                    sel.value = optTodos.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
                return sel.value === optTodos.value;
            }
        }
        return false;
    });
}

/**
 * Extrai os registros da grid "Operações de Antecipação" (ctr=operacoesAntecipacao),
 * reaproveitando a sessão logada. Colunas relevantes: Nº NF, Número do Contrato,
 * Valor da Nota. Mesma técnica de paginação via #current_page da tela de pagamentos
 * (mesmo motor de grid do portal).
 */
async function extrairOperacoesAntecipacao(page) {
    // IMPORTANTE: NÃO reutilizar aqui o "aumentar registros por página via <select>"
    // usado na tela de pagamentos — nesta grid os selects de Status (values "10"-"15")
    // e Banco Pagador (values "84","462"...) também têm opções numéricas >= 10 e o
    // heurístico antigo confundia um deles com paginação, sobrescrevendo o filtro
    // (ex: Status virava "Antecipação Agendada" mesmo com "Todos" selecionado) e
    // zerando os resultados. A paginação via #current_page abaixo já é suficiente.

    let allRows = [];
    let paginaAtual = 1;
    let assinaturaAnterior = null;
    const MAX_PAGINAS = 20;

    while (paginaAtual <= MAX_PAGINAS) {
        const resultado = await page.evaluate(() => {
            const rows = [];
            const debugTabelas = [];
            const tables = document.querySelectorAll('table');
            for (const table of tables) {
                const headers = table.querySelectorAll('th');
                const headerTexts = Array.from(headers).map(h => h.textContent.trim());
                if (!headerTexts.some(h => /n[ºo°]\s*nf/i.test(h)) || !headerTexts.some(h => /valor/i.test(h))) continue;

                const headerMap = {};
                headerTexts.forEach((txt, i) => {
                    const t = txt.toLowerCase();
                    if (/n[ºo°]\s*nf/.test(t)) headerMap.numeroNF = i;
                    else if (t.includes('contrato')) headerMap.numeroContrato = i;
                    else if (t === 'valor da nota' || t.startsWith('valor da nota')) headerMap.valorNota = i;
                    else if (t === 'fornecedor' || t.startsWith('fornecedor')) headerMap.fornecedor = i;
                });
                if (headerMap.numeroNF === undefined) continue;

                const thCount = headerTexts.length;
                const allTrs = table.querySelectorAll('tbody tr');
                const cellCounts = {};
                for (const tr of allTrs) {
                    const count = tr.querySelectorAll('td').length;
                    cellCounts[count] = (cellCounts[count] || 0) + 1;
                }
                const dataTdCount = Object.entries(cellCounts)
                    .filter(([c]) => parseInt(c) >= thCount)
                    .sort((a, b) => b[1] - a[1])[0]?.[0];
                const tdOffset = dataTdCount ? parseInt(dataTdCount) - thCount : 0;
                debugTabelas.push({ headerTexts, headerMap, thCount, cellCounts, dataTdCount, tdOffset });

                for (const tr of allTrs) {
                    const cells = tr.querySelectorAll('td');
                    if (!dataTdCount || cells.length !== parseInt(dataTdCount)) continue;
                    const get = (key) => {
                        const idx = headerMap[key];
                        if (idx === undefined) return '';
                        const adjustedIdx = idx <= 1 ? idx : idx + tdOffset;
                        return cells[adjustedIdx] ? cells[adjustedIdx].textContent.trim() : '';
                    };
                    const numeroNF = get('numeroNF');
                    if (!numeroNF || !/^\d+$/.test(numeroNF.trim())) continue;
                    rows.push({
                        numeroNF: numeroNF.trim(),
                        numeroContrato: get('numeroContrato'),
                        valorNota: get('valorNota'),
                        fornecedor: get('fornecedor')
                    });
                }
            }
            return { rows, debugTabelas };
        });

        const dados = resultado.rows;
        if (resultado.debugTabelas.length > 0) {
            logger.debug(`💠 Antecipação — debug tabela: ${JSON.stringify(resultado.debugTabelas)}`);
        }

        if (dados.length === 0) break;

        const assinaturaAtual = dados.map(d => d.numeroNF).join(',');
        if (assinaturaAnterior !== null && assinaturaAtual === assinaturaAnterior) break;
        assinaturaAnterior = assinaturaAtual;
        allRows = allRows.concat(dados);

        // Próxima página — mesma técnica do #current_page usada na tela de pagamentos
        const currentPageAntes = await page.evaluate(() => document.getElementById('current_page')?.value || null);
        if (currentPageAntes === null) break;
        const proximaPagina = String(parseInt(currentPageAntes, 10) + 1);
        await page.fill('#current_page', proximaPagina);
        await page.press('#current_page', 'Enter');
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await humanDelay(1500, 3000);
        paginaAtual++;
    }

    return allRows;
}

/**
 * Corrige data_pagamento de notas já marcadas como pagas via antecipação em
 * execuções anteriores que usavam datas erradas (versão antiga usava só
 * data_emissao, sem os +30 dias). Idempotente — só atualiza quando a data
 * guardada diverge do padrão atual (data_emissao + 30 dias).
 */
function corrigirDatasAntecipacoesExistentes() {
    const notas = db.getDb().prepare(
        "SELECT id, data_emissao, data_pagamento FROM notas_fiscais WHERE forma_pagamento = 'Antecipação (Factoring)' AND data_emissao IS NOT NULL AND data_emissao != ''"
    ).all();

    let corrigidos = 0;
    for (const nota of notas) {
        const emissaoMais30 = new Date(nota.data_emissao);
        if (isNaN(emissaoMais30.getTime())) continue;
        emissaoMais30.setDate(emissaoMais30.getDate() + 30);
        const dataCorreta = emissaoMais30.toISOString().split('T')[0];
        if (nota.data_pagamento !== dataCorreta) {
            const diasPagamento = Math.floor((emissaoMais30 - new Date(nota.data_emissao)) / (1000 * 60 * 60 * 24));
            db.atualizarNota(nota.id, { data_pagamento: dataCorreta, dias_pagamento: diasPagamento });
            corrigidos++;
        }
    }
    if (corrigidos > 0) logger.info(`🛠️ ${corrigidos} nota(s) com data de antecipação corrigida(s) para emissão+30 dias`);
    return corrigidos;
}

/**
 * Sincroniza pagamentos via scraping direto do portal.
 * Usa playwright-extra + stealth plugin para contornar WAF.
 * headless: false obrigatório (modo headed evita detecção).
 */
async function sincronizarPagamentos(email, senha, opcoes = {}) {
    const syncId = db.registrarSincronizacao('painel_fornecedor_cimed');
    corrigirDatasAntecipacoesExistentes();
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

        // ── Janelas de busca: o portal parece limitar/ignorar buscas com período
        // maior que 365 dias (confirmado: aplicar um range de anos deixava o filtro
        // sem efeito real — "total registros" continuava idêntico ao da janela de
        // 1 ano anterior). Por isso percorremos o histórico em janelas de até 365 dias.
        //
        // Sync incremental: só a PRIMEIRA sincronização bem-sucedida varre desde 2020.
        // Das próximas em diante, parte de 90 dias antes da última sync concluída —
        // margem de segurança para pagamentos que o portal lança com atraso/retroativos —
        // em vez de reprocessar anos inteiros já cobertos toda vez que o usuário clica em sincronizar.
        const hoje = new Date();
        const FLOOR_ABSOLUTO = new Date(2020, 0, 1); // cobre toda a base de notas (mais antiga: 2023-03)
        let pisoHistorico = FLOOR_ABSOLUTO;
        if (opcoes.forcarCompleto) {
            logger.info('📅 Sync TOTAL forçado — ignorando incremental, varrendo histórico completo desde 2020');
        } else {
            const ultimaSyncOk = db.obterUltimaSincronizacaoConcluida('painel_fornecedor_cimed');
            if (ultimaSyncOk) {
                const dataUltimaSync = new Date(ultimaSyncOk.finalizado_at || ultimaSyncOk.created_at);
                if (!isNaN(dataUltimaSync.getTime())) {
                    const margemSeguranca = new Date(dataUltimaSync);
                    margemSeguranca.setDate(margemSeguranca.getDate() - 90);
                    if (margemSeguranca > FLOOR_ABSOLUTO) pisoHistorico = margemSeguranca;
                    logger.info(`📅 Sync incremental: última sincronização concluída em ${dataUltimaSync.toLocaleDateString('pt-BR')} — reprocessando a partir de ${pisoHistorico.toLocaleDateString('pt-BR')}`);
                }
            } else {
                logger.info('📅 Nenhuma sincronização anterior concluída — varrendo histórico completo desde 2020');
            }
        }
        const formatarData = (d) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
        const janelas = [];
        {
            let cursor = new Date(pisoHistorico);
            while (cursor <= hoje) {
                const fimJanela = new Date(cursor);
                fimJanela.setDate(fimJanela.getDate() + 364); // 365 dias inclusive
                if (fimJanela > hoje) fimJanela.setTime(hoje.getTime());
                janelas.push({ inicio: new Date(cursor), fim: new Date(fimJanela) });
                cursor = new Date(fimJanela);
                cursor.setDate(cursor.getDate() + 1);
            }
        }
        logger.info(`📅 Percorrendo histórico em ${janelas.length} janela(s) de até 365 dias (${formatarData(pisoHistorico)} a ${formatarData(hoje)})`);

        let allDadosPagamento = [];

        for (let janelaIdx = 0; janelaIdx < janelas.length; janelaIdx++) {
        const dataInicio = formatarData(janelas[janelaIdx].inicio);
        const dataFim = formatarData(janelas[janelaIdx].fim);
        logger.info(`📅 Janela ${janelaIdx + 1}/${janelas.length}: ${dataInicio} a ${dataFim}`);
        await esconderMsgAttention(page);

        // ── STEP 4: Ajustar filtros de data para esta janela ──
        let totalRegistrosPortal = null;
        const filtrosAplicados = await preencherFiltroDataJanela(page, dataInicio, dataFim, 'pag', 'Pagamento Inicial', 'Pagamento Final');

        if (filtrosAplicados) {
            if (await clicarPesquisar(page)) {
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
                totalRegistrosPortal = totalInfo ? parseInt(totalInfo, 10) : null;
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
                if (await clicarPesquisar(page)) {
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

        let paginaAtual = 1;
        let assinaturaPaginaAnterior = null;
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

        // Página vazia mas ainda esperamos mais registros (total do portal indica mais dados):
        // pode ser carregamento lento em vez de fim real (mesma classe de bug já vista no
        // scraper de NFS-e). Retenta 1x com espera maior antes de aceitar como vazia.
        let dadosPaginaFinal = dadosPagamento;
        if (dadosPaginaFinal.length === 0 && totalRegistrosPortal && allDadosPagamento.length < totalRegistrosPortal) {
            logger.info('   ⚠️ Página veio vazia — aguardando mais e tentando novamente...');
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            await humanDelay(2000, 3000);
            const retry = await page.evaluate(() => {
                const allRows = [];
                const tables = document.querySelectorAll('table');
                for (const table of tables) {
                    const headers = table.querySelectorAll('th');
                    const headerTexts = Array.from(headers).map(h => h.textContent.trim());
                    if (!headerTexts.some(h => h.includes('Documento')) ||
                        !headerTexts.some(h => h.includes('Pagamento') || h.includes('Valor'))) {
                        continue;
                    }
                    const headerMap = {};
                    headerTexts.forEach((txt, i) => {
                        const t = txt.toLowerCase();
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
                    const allTrs = table.querySelectorAll('tbody tr');
                    const cellCounts = {};
                    for (const tr of allTrs) {
                        const count = tr.querySelectorAll('td').length;
                        cellCounts[count] = (cellCounts[count] || 0) + 1;
                    }
                    const thCount = headerTexts.length;
                    const dataTdCount = Object.entries(cellCounts)
                        .filter(([c]) => parseInt(c) >= thCount)
                        .sort((a, b) => b[1] - a[1])[0]?.[0];
                    const tdOffset = dataTdCount ? parseInt(dataTdCount) - thCount : 0;
                    for (const tr of allTrs) {
                        const cells = tr.querySelectorAll('td');
                        if (!dataTdCount || cells.length !== parseInt(dataTdCount)) continue;
                        const get = (key) => {
                            const idx = headerMap[key];
                            if (idx === undefined) return '';
                            const adjustedIdx = idx <= 1 ? idx : idx + tdOffset;
                            return cells[adjustedIdx] ? cells[adjustedIdx].textContent.trim() : '';
                        };
                        const doc = get('documento');
                        if (!doc || !/^\d+$/.test(doc.trim())) continue;
                        allRows.push({
                            pagador: get('pagador'), favorecido: get('favorecido'), lancamento: get('lancamento'),
                            documento: doc.trim(), numeroBancario: get('numeroBancario'), vencimento: get('vencimento'),
                            pagamento: get('pagamento'), valor: get('valor'), situacao: get('situacao')
                        });
                    }
                }
                return allRows;
            });
            if (retry.length > 0) {
                logger.info(`   → ${retry.length} pagamentos após retry`);
                dadosPaginaFinal = retry;
            }
        }

        allDadosPagamento = allDadosPagamento.concat(dadosPaginaFinal);

        // Verificar se há próxima página
        if (dadosPaginaFinal.length === 0) break;

        // Guarda contra navegação que não avançou de fato: se a página "nova" tem a
        // MESMA assinatura (mesmos documentos) da página anterior, o clique/input de
        // paginação não funcionou e estamos vendo os mesmos dados de novo — para aqui
        // em vez de duplicar infinitamente.
        const assinaturaAtual = dadosPaginaFinal.map(p => p.documento).join(',');
        if (assinaturaPaginaAnterior !== null && assinaturaAtual === assinaturaPaginaAnterior) {
            logger.info('⚠️ Página repetida (navegação não avançou) — encerrando paginação');
            allDadosPagamento = allDadosPagamento.slice(0, allDadosPagamento.length - dadosPaginaFinal.length);
            break;
        }
        assinaturaPaginaAnterior = assinaturaAtual;

        let temProximaPagina = await page.evaluate(() => {
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

        // Fallback: se sabemos o total real de registros do portal e ainda não
        // atingimos esse total, força tentativa de próxima página mesmo que a
        // detecção de botão/paginação no DOM não tenha encontrado nada (evita
        // parar cedo demais como aconteceu quando o total ficava desatualizado
        // por causa do popup #msgAttention bloqueando a atualização da página).
        if (!temProximaPagina && totalRegistrosPortal && allDadosPagamento.length < totalRegistrosPortal) {
            logger.debug(`📄 DOM não indicou próxima página, mas ${allDadosPagamento.length}/${totalRegistrosPortal} — tentando mesmo assim`);
            temProximaPagina = true;
        }

        if (!temProximaPagina) {
            logger.info(`📄 Todas as páginas extraídas (${paginaAtual} página(s))`);
            break;
        }

        // Navegar para próxima página
        logger.info(`📄 Navegando para página ${paginaAtual + 1}...`);
        // Sem botão/link de "próxima página" dedicado neste portal (grid custom sem
        // paginador visível) — o único mecanismo é o input #current_page. Clicar em
        // "Pesquisar" depois de alterá-lo NÃO funciona: reseta a busca para a página 1
        // em vez de avançar (causava página 2 idêntica à página 1). O input precisa
        // de uma interação real de teclado (Enter) para dispensar o handler correto.
        const currentPageAntes = await page.evaluate(() => document.getElementById('current_page')?.value || null);
        let navegou = false;
        if (currentPageAntes !== null) {
            const proximaPagina = String(parseInt(currentPageAntes, 10) + 1);
            await page.fill('#current_page', proximaPagina);
            await page.press('#current_page', 'Enter');
            navegou = true;
        } else {
            // Fallback: procurar algum link/botão de navegação (ícones sem texto incluídos)
            navegou = await page.evaluate(() => {
                const candidatos = [...document.querySelectorAll('a, img, button')].filter(el => {
                    const attrs = (el.getAttribute('title') || '') + ' ' + (el.getAttribute('alt') || '') + ' ' + (el.className || '');
                    return /pr[oó]xim|next|avan[çc]ar/i.test(attrs);
                });
                for (const el of candidatos) {
                    const clicavel = el.tagName === 'IMG' ? el.closest('a, button') : el;
                    if (clicavel && clicavel.offsetParent !== null) { clicavel.click(); return true; }
                }
                return false;
            });
        }

        if (!navegou) {
            logger.info('📄 Não conseguiu navegar para próxima página');
            break;
        }

        await page.waitForLoadState('networkidle', { timeout: 30000 });
        await humanDelay(2000, 4000);
        paginaAtual++;
        } // fim while paginação

        logger.info(`   → janela ${janelaIdx + 1}/${janelas.length}: ${allDadosPagamento.length} pagamentos acumulados até aqui`);
        } // fim for janelas

        logger.info(`✅ Total: ${allDadosPagamento.length} pagamentos extraídos de ${janelas.length} janela(s) de data`);

        // ── STEP 7: Operações de Antecipação — outra página do portal, mesma sessão logada ──
        // Notas pagas via antecipação (factoring) não aparecem na visão de pagamentos comum,
        // só nesta grid separada. Aparecer aqui já significa que a operação foi realizada.
        // Mesmas janelas de 365 dias da visão de pagamentos (o filtro "Data Requisição"
        // dessa grid só mostra ~3 meses por padrão — sem varrer por janela, antecipações
        // antigas ficam de fora e nunca são conciliadas).
        let allOperacoesAntecipacao = [];
        try {
            logger.info('💠 Navegando para Operações de Antecipação...');
            await humanDelay(1000, 2000);
            // networkidle pode nunca disparar se o portal mantiver polling em background —
            // tenta domcontentloaded primeiro (rápido e confiável) e só espera idle depois,
            // sem derrubar a etapa inteira se o idle demorar.
            await page.goto(PORTAL_ANTECIPACAO, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            await humanDelay(2000, 4000);

            const bodyTextAntecipacao = await page.evaluate(() => document.body.innerText);
            if (bodyTextAntecipacao.includes('bloqueada') || bodyTextAntecipacao.includes('blocked')) {
                logger.info('⚠️ Portal bloqueou acesso a Operações de Antecipação — etapa ignorada, pagamentos normais não são afetados');
            } else {
                for (let janelaIdx = 0; janelaIdx < janelas.length; janelaIdx++) {
                    const dataInicioJanela = formatarData(janelas[janelaIdx].inicio);
                    const dataFimJanela = formatarData(janelas[janelaIdx].fim);
                    logger.info(`💠 Antecipação — janela ${janelaIdx + 1}/${janelas.length}: ${dataInicioJanela} a ${dataFimJanela}`);
                    await esconderMsgAttention(page);

                    // Filtro "Status" abre em "Antecipação Agendada" por padrão — sem
                    // forçar "Todos", as antecipações já concluídas (Realizada) ficam de
                    // fora e a busca sempre volta vazia.
                    await selecionarStatusTodos(page);

                    const filtroOk = await preencherFiltroDataJanela(page, dataInicioJanela, dataFimJanela, 'requis', 'Requisição Inicial', 'Requisição Final');
                    if (filtroOk) {
                        if (await clicarPesquisar(page)) {
                            await page.waitForLoadState('networkidle', { timeout: 30000 });
                            await humanDelay(2000, 4000);
                        }
                    } else {
                        logger.info('💠 Campos de Data Requisição não encontrados nesta janela — usando filtro padrão do portal');
                    }

                    const dadosJanela = await extrairOperacoesAntecipacao(page);
                    logger.info(`   → ${dadosJanela.length} operações de antecipação nesta janela`);
                    allOperacoesAntecipacao = allOperacoesAntecipacao.concat(dadosJanela);
                }
                ensureDebugDir();
                await page.screenshot({ path: path.join(DEBUG_DIR, 'finnet-antecipacao.png'), fullPage: true });

                // Deduplicar — a margem de 90 dias do sync incremental pode fazer a
                // mesma operação aparecer em janelas adjacentes
                const vistos = new Set();
                allOperacoesAntecipacao = allOperacoesAntecipacao.filter(op => {
                    const chave = `${op.numeroNF}_${op.numeroContrato}`;
                    if (vistos.has(chave)) return false;
                    vistos.add(chave);
                    return true;
                });
            }
        } catch (e) {
            logger.info(`⚠️ Falha ao extrair Operações de Antecipação (${e.message.split('\n')[0]}) — pagamentos normais não são afetados`);
        }
        logger.info(`✅ ${allOperacoesAntecipacao.length} operações de antecipação extraídas`);

        // Antecipação é só mais uma forma de pagamento — entra na MESMA fila de
        // conciliação dos pagamentos normais, sem status/cor separados. Não há data
        // de liquidação nessa grid do portal, então fica em branco e o fallback de
        // atualizarPagamentosNoBanco usa emissão+30 dias da nota.
        const pagamentosViaAntecipacao = allOperacoesAntecipacao.map(op => ({
            pagador: '',
            favorecido: op.fornecedor || '',
            lancamento: 'Antecipação (Factoring)',
            documento: op.numeroNF,
            numeroBancario: op.numeroContrato || '',
            vencimento: '',
            pagamento: '',
            valor: op.valorNota,
            situacao: ''
        }));
        allDadosPagamento = allDadosPagamento.concat(pagamentosViaAntecipacao);

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
                    logger.debug(`🔄 Doc ${numDoc} → nota ${numNota} (removido prefixo de ano ${anoPortal})`);
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
                logger.debug(`🔄 Doc ${numDoc} → nota ${semPrimeiro} (removido dígito extra do início)`);
            }
        }

        // Fallback 3: remover primeiros 2 dígitos (ex: 12385 → 385)
        if (notas.length === 0 && numDoc.length > 4) {
            const semDois = numDoc.substring(2);
            notas = db.getDb().prepare(
                "SELECT id, numero, data_emissao, valor_nota, valor_liquido, recebido, previsao_recebimento FROM notas_fiscais WHERE numero = ?"
            ).all(semDois);
            if (notas.length > 0) {
                logger.debug(`🔄 Doc ${numDoc} → nota ${semDois} (removidos 2 dígitos extras do início)`);
            }
        }

        // Fallback 4: buscar notas que terminam com o mesmo número (LIKE %numero)
        if (notas.length === 0 && numDoc.length >= 3) {
            notas = db.getDb().prepare(
                "SELECT id, numero, data_emissao, valor_nota, valor_liquido, recebido, previsao_recebimento FROM notas_fiscais WHERE numero LIKE ?"
            ).all(`%${numDoc}`);
            if (notas.length > 0) {
                logger.debug(`🔄 Doc ${numDoc} → nota ${notas[0].numero} (sufixo match)`);
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
            logger.debug(`✅ Doc ${numDoc} → nota ${nota.numero}: valor confirmado (R$${valor.toFixed(2)} ≈ R$${valorNota.toFixed(2)})`);
        }
        if (notas.length > 1) {
            nota = notas.reduce((best, n) => {
                const diffBest = Math.abs((best.valor_liquido || best.valor_nota) - valor);
                const diffN = Math.abs((n.valor_liquido || n.valor_nota) - valor);
                return diffN < diffBest ? n : best;
            });
        }

        // Nunca marcar como paga uma nota Cancelada (inclui canceladas e substituídas —
        // o portal NFS-e reporta ambas como 'Cancelada') nem uma nota N/A (serviço
        // contratado de terceiro) — evita duplicidade quando o fallback de matching
        // (prefixo de ano/dígito extra/sufixo) acerta o número errado.
        if (nota.recebido === 'Cancelada' || nota.recebido === 'N/A') {
            logger.info(`⚠️ Doc ${numDoc} → nota ${nota.numero}: nota está '${nota.recebido}' — ignorado para evitar duplicidade`);
            detalhes.push({ numero: numDoc, status: 'ignorado_cancelada_ou_nao_aplicavel', valor });
            continue;
        }

        // Se já está como Recebido, pular
        if (nota.recebido === 'Recebido') {
            jaRecebidos++;
            detalhes.push({ numero: numDoc, status: 'ja_recebido', valor });
            continue;
        }

        // Sem data de pagamento do portal (caso das antecipações, que não têm essa
        // coluna) — usa emissão + 30 dias como data_pagamento (padrão definido pelo usuário).
        let dataPgtoEfetiva = dataPgto;
        if (!dataPgtoEfetiva && nota.data_emissao) {
            const emissaoMais30 = new Date(nota.data_emissao);
            if (!isNaN(emissaoMais30.getTime())) {
                emissaoMais30.setDate(emissaoMais30.getDate() + 30);
                dataPgtoEfetiva = emissaoMais30.toISOString().split('T')[0];
            }
        }

        // Calcular dias para pagamento
        let diasPagamento = null;
        if (dataPgtoEfetiva && nota.data_emissao) {
            const emissao = new Date(nota.data_emissao);
            const pagamento = new Date(dataPgtoEfetiva);
            diasPagamento = Math.floor((pagamento - emissao) / (1000 * 60 * 60 * 24));
        }

        // Determinar status conciliado
        let statusConciliado = 'Pago';
        if (dataVencimento && dataPgtoEfetiva) {
            const venc = new Date(dataVencimento);
            const pgtoDate = new Date(dataPgtoEfetiva);
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
                previsao_recebimento: dataPgtoEfetiva || dataVencimento,
                status_conciliado: 'Agendado',
                observacoes: `Pagamento agendado - Finnet (${pgto.lancamento || 'TED'})`
            });
            atualizados++;
            detalhes.push({ numero: numDoc, status: 'agendado', valor, dataPrevista: dataPgtoEfetiva || dataVencimento });
            continue;
        }

        // Marcar como pago.
        // O portal usa "Liquidada/Liquidado pelo Pagador" para antecipações — equivale a Pago.
        const ehLiquidacaoAntecipada = situacao.includes('liquidad');
        if (situacao === 'pago' || situacao === '' || ehLiquidacaoAntecipada) {
            db.marcarComoPaga(nota.id, {
                data_pagamento: dataPgtoEfetiva,
                forma_pagamento: pgto.lancamento || 'TED',
                status_conciliado: statusConciliado,
                dias_pagamento: diasPagamento
            });

            // Adicionar observação com informação do portal
            const origemLabel = ehLiquidacaoAntecipada ? 'Liquidado pelo Pagador (Antecipação)' : (pgto.lancamento || 'TED');
            const obs = `Pago via ${origemLabel} - Finnet${pgto.numeroBancario ? ' (Nº ' + pgto.numeroBancario + ')' : ''}`;
            db.atualizarNota(nota.id, { observacoes: obs });

            atualizados++;
            detalhes.push({ numero: numDoc, status: 'atualizado', valor, dataPagamento: dataPgtoEfetiva, statusConciliado });
        }
    }

    logger.info(`📊 Resultado: ${atualizados} atualizados, ${jaRecebidos} já recebidos, ${naoEncontrados} não encontrados`);
    return { atualizados, jaRecebidos, naoEncontrados, detalhes };
}

module.exports = {
    sincronizarPagamentos,
    importarPagamentosXLS
};
