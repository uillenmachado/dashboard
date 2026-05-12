/**
 * Módulo de Scraping - Portal NFS-e MetropolisWEB (Lauro de Freitas)
 * URL: https://lftributos.metropolisweb.com.br/metropolisWEB/?origem=1
 * 
 * Fluxo semi-automático:
 * 1. Playwright abre o portal e captura imagem do CAPTCHA (Kaptcha.jpg)
 * 2. Dashboard exibe o CAPTCHA para o usuário digitar
 * 3. Após resolver CAPTCHA, completa login e extrai notas
 * 4. Notas novas são inseridas no banco de dados
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const ocr = require('./ocr');
const pdfParse = require('pdf-parse');
const { extrairDadosDoPdfText, parsearValorBR, parsearDataBR } = require('./utils');

const PORTAL_URL = 'https://lftributos.metropolisweb.com.br/metropolisWEB/?origem=1';
const DEBUG_DIR = path.join(__dirname, '..', 'data', 'debug');
const NOTAS_PDF_DIR = path.join(__dirname, '..', 'data', 'notas_pdf');

// Seletores mapeados do portal MetropolisWEB
const SEL = {
    loginInput:    'input[name="login"]',
    senhaInput:    'input[name="senha"]',
    captchaInput:  'input[name="kaptchafield"]',
    captchaImg:    'img[src*="Kaptcha.jpg"]',
    captchaRefresh:'img[alt="Recarregar Imagem"]',
    btnEntrar:     'input[type="submit"][value="Entrar"]',
    formLogin:     'form[name="FormLogin"]',
};

function ensureDebugDir() {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

// Estado da sessão de scraping em andamento
let sessaoAtiva = null;

/**
 * Inicia uma sessão de scraping — abre o navegador, navega ao portal,
 * captura o CAPTCHA e retorna a imagem em base64
 */
async function iniciarSessao(login, senha) {
    if (sessaoAtiva) await encerrarSessao();

    const syncId = db.registrarSincronizacao('scraping_nfse');

    try {
        console.log('🌐 Abrindo navegador para portal MetropolisWEB...');

        const browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 900 },
            acceptDownloads: true
        });

        const page = await context.newPage();
        page.setDefaultTimeout(45000); // Timeout global de 45s para evitar travamento

        console.log('📄 Navegando para o portal...');
        await page.goto(PORTAL_URL, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);

        // Capturar imagem do CAPTCHA
        console.log('🖼️ Capturando CAPTCHA...');
        const captchaElement = await page.$(SEL.captchaImg);

        let captchaBase64 = null;
        if (captchaElement) {
            const captchaBuffer = await captchaElement.screenshot();
            captchaBase64 = captchaBuffer.toString('base64');
            console.log('✅ CAPTCHA capturado (Kaptcha.jpg)');
        } else {
            console.log('⚠️ CAPTCHA não encontrado, capturando tela...');
            ensureDebugDir();
            await page.screenshot({ path: path.join(DEBUG_DIR, 'login-page.png'), fullPage: true });
            const fullBuffer = await page.screenshot({ fullPage: false });
            captchaBase64 = fullBuffer.toString('base64');
        }

        sessaoAtiva = {
            browser, context, page, syncId,
            login, senha,
            status: 'aguardando_captcha',
            iniciadoEm: new Date()
        };

        console.log('⏳ Aguardando resolução do CAPTCHA pelo usuário...');

        return {
            success: true,
            captchaImage: captchaBase64,
            captchaEncontrado: !!captchaElement,
            syncId
        };

    } catch (error) {
        console.error('❌ Erro ao iniciar sessão:', error.message);
        db.finalizarSincronizacao(syncId, { erro: error.message });
        await encerrarSessao();
        throw error;
    }
}

/**
 * Resolve o CAPTCHA, completa o login e extrai notas
 */
async function resolverCaptchaELogar(textoCaptcha) {
    if (!sessaoAtiva || sessaoAtiva.status !== 'aguardando_captcha') {
        throw new Error('Nenhuma sessão ativa aguardando CAPTCHA');
    }

    const { page, login, senha, syncId } = sessaoAtiva;
    sessaoAtiva.status = 'logando';

    try {
        console.log('🔑 Preenchendo formulário de login...');

        await page.fill(SEL.loginInput, login);
        await page.waitForTimeout(300);
        await page.fill(SEL.senhaInput, senha);
        await page.waitForTimeout(300);
        await page.fill(SEL.captchaInput, textoCaptcha);
        await page.waitForTimeout(300);

        console.log('🚀 Clicando em Entrar...');
        await page.click(SEL.btnEntrar);

        // Aguardar navegação pós-login
        await page.waitForTimeout(4000);

        ensureDebugDir();
        await page.screenshot({ path: path.join(DEBUG_DIR, 'pos-login.png'), fullPage: true });

        const urlAtual = page.url();
        const conteudo = await page.content();
        console.log('📍 URL pós-login:', urlAtual);

        // Se ainda está na página de login com o form visível = falhou
        const aindaNaLogin = conteudo.includes('FormLogin') && conteudo.includes('kaptchafield');
        
        if (aindaNaLogin) {
            const msgErro = await page.evaluate(() => {
                const els = document.querySelectorAll('span, div, td, p');
                for (const el of els) {
                    const text = el.textContent.trim().toLowerCase();
                    if (text.includes('incorret') || text.includes('inválid') || 
                        text.includes('tente novamente') || text.includes('caracteres') ||
                        text.includes('login e/ou')) {
                        return el.textContent.trim();
                    }
                }
                return null;
            });

            console.log('⚠️ Ainda na página de login. Erro:', msgErro || 'CAPTCHA provavelmente incorreto');
            sessaoAtiva.status = 'aguardando_captcha';

            const novoCaptcha = await capturarNovoCaptcha();

            return {
                success: false,
                error: msgErro || 'CAPTCHA incorreto ou credenciais inválidas. Tente novamente.',
                retryCaptcha: true,
                captchaImage: novoCaptcha
            };
        }

        // Login bem-sucedido!
        console.log('✅ Login bem-sucedido!');
        sessaoAtiva.status = 'logado';

        const notas = await extrairNotas(page);
        const resultado = await salvarNotasExtraidas(notas, syncId);

        db.finalizarSincronizacao(syncId, {
            encontrados: notas.length,
            novos: resultado.inseridos
        });

        await encerrarSessao();

        return {
            success: true,
            notasEncontradas: notas.length,
            notasNovas: resultado.inseridos,
            notasDuplicadas: resultado.ignorados,
            notasAtualizadasCnpj: resultado.atualizados || 0,
            syncId
        };

    } catch (error) {
        console.error('❌ Erro no login/extração:', error.message);
        ensureDebugDir();
        try { await page.screenshot({ path: path.join(DEBUG_DIR, 'erro.png'), fullPage: true }); } catch(e) {}
        
        db.finalizarSincronizacao(syncId, { erro: error.message });

        if (error.message.toLowerCase().includes('captcha')) {
            sessaoAtiva.status = 'aguardando_captcha';
            const novoCaptcha = await capturarNovoCaptcha();
            return {
                success: false,
                error: error.message,
                retryCaptcha: true,
                captchaImage: novoCaptcha
            };
        }

        await encerrarSessao();
        throw error;
    }
}

/**
 * Captura um novo CAPTCHA (para retry)
 */
async function capturarNovoCaptcha() {
    if (!sessaoAtiva || !sessaoAtiva.page) return null;

    try {
        const page = sessaoAtiva.page;
        console.log('🔄 Capturando novo CAPTCHA para retry...');

        // Tentar clicar no refresh primeiro
        const refreshBtn = await page.$(SEL.captchaRefresh);
        if (refreshBtn) {
            console.log('🔄 Clicando em refresh do CAPTCHA...');
            await refreshBtn.click();
            await page.waitForTimeout(1500);
        }

        // Tentar executar a função JavaScript de reset do CAPTCHA
        try {
            await page.evaluate(() => {
                if (typeof resetarCaptcha === 'function') resetarCaptcha();
            });
            await page.waitForTimeout(1000);
        } catch(e) { /* ignorar */ }

        // Capturar CAPTCHA
        const captchaEl = await page.$(SEL.captchaImg);
        if (captchaEl) {
            const buf = await captchaEl.screenshot();
            console.log('✅ Novo CAPTCHA capturado');
            return buf.toString('base64');
        }

        // Fallback: reload total da página
        console.log('🔄 Reload da página para novo CAPTCHA...');
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        const captchaEl2 = await page.$(SEL.captchaImg);
        if (captchaEl2) {
            const buf = await captchaEl2.screenshot();
            console.log('✅ Novo CAPTCHA capturado após reload');
            return buf.toString('base64');
        }

        console.log('❌ Não foi possível capturar novo CAPTCHA');
        return null;
    } catch (error) {
        console.error('Erro ao capturar novo CAPTCHA:', error.message);
        return null;
    }
}

/**
 * Extrai notas fiscais da área logada do portal MetropolisWEB.
 * 
 * Estrutura do portal pós-login:
 * - Menu accordion lateral: NFS-e (onclick="mostrarFecharSetorNF()"), DES-e, NFTS-e
 * - Sub-item alvo: "Nota Fiscal Eletrônica" → notaFiscalEletronica.do?metodo=executarFiltrar
 * - Links usam onclick="return checaUsuarioContribuinteNfe(id)" antes de navegar
 * - Tabela paginada (até 10+ páginas) com ~50 registros por página
 * - Colunas: Número NFS-e, Prestador, Tomador, de Emissão, Valor Total Nota, Valor ISS,
 *   Responsável Recolhimento, Status, N° RPS
 */
async function extrairNotas(page) {
    console.log('📊 Extraindo notas fiscais do portal...');
    const notas = [];

    try {
        ensureDebugDir();

        // === Passo 1: Expandir accordion NFS-e ===
        console.log('📂 Expandindo menu NFS-e...');
        const tdNfse = await page.$('td[onclick*="mostrarFecharSetorNF"]');
        if (tdNfse) {
            await tdNfse.click();
            await page.waitForTimeout(1500);
        } else {
            // Fallback: clicar no td que contém exatamente "NFS-e"
            const els = await page.$$('td');
            for (const el of els) {
                const text = await el.textContent();
                if (text.trim() === 'NFS-e') {
                    await el.click();
                    await page.waitForTimeout(1500);
                    break;
                }
            }
        }

        // === Passo 2: Clicar em "Nota Fiscal Eletrônica" ===
        console.log('📌 Navegando para "Nota Fiscal Eletrônica"...');
        const linkNFE = await page.$('a:has-text("Nota Fiscal Eletrônica")');
        if (!linkNFE) {
            console.error('❌ Link "Nota Fiscal Eletrônica" não encontrado');
            const htmlContent = await page.content();
            fs.writeFileSync(path.join(DEBUG_DIR, 'pagina-notas.html'), htmlContent);
            return notas;
        }

        // O link usa onclick="return checaUsuarioContribuinteNfe(id)" + href com a URL real
        // Playwright vai executar o onclick automaticamente ao clicar
        await linkNFE.click();
        await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);

        // Verificar se chegou na página correta
        const url = page.url();
        console.log(`📍 URL: ${url}`);

        // Se a URL contém notaFiscalEletronica ou executarFiltrar, estamos na página certa
        if (!url.includes('notaFiscalEletronica') && !url.includes('executarFiltrar')) {
            console.log('⚠️ Não chegou à página de notas. Tentando URL direta...');
            await page.goto('https://lftributos.metropolisweb.com.br/metropolisWEB/nfe/notaFiscalEletronica.do?metodo=executarFiltrar&codMenu=7', {
                waitUntil: 'load', timeout: 15000
            }).catch(() => {});
            await page.waitForTimeout(3000);
        }

        await page.screenshot({ path: path.join(DEBUG_DIR, 'pagina-notas.png'), fullPage: true });

        // === Passo 3: Clicar Pesquisar SOMENTE se visível ===
        // A URL executarFiltrar já carrega os dados; Pesquisar pode não ser necessário
        try {
            const btnPesquisar = await page.$('input[value="Pesquisar"]');
            if (btnPesquisar) {
                const isVisible = await btnPesquisar.isVisible().catch(() => false);
                if (isVisible) {
                    console.log('🔍 Clicando em Pesquisar...');
                    await btnPesquisar.click();
                    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
                    await page.waitForTimeout(3000);
                } else {
                    console.log('ℹ️ Pesquisar não visível — dados já carregados pela URL');
                }
            } else {
                console.log('ℹ️ Sem botão Pesquisar — dados já carregados pela URL');
            }
        } catch (e) {
            console.log('ℹ️ Pesquisar ignorado:', e.message);
        }

        // === Passo 4: Verificar total de registros ===
        const totalRegistros = await page.evaluate(() => {
            // Buscar "Foram encontrado(s) 459 registro(s)" - o número pode estar em tag <b>, <span> etc.
            const text = document.body.innerText;
            const match = text.match(/encontrado\(s\)\s*(\d+)\s*registro/i);
            return match ? parseInt(match[1]) : null;
        });
        if (totalRegistros) {
            console.log(`📊 Total de registros no portal: ${totalRegistros}`);
        } else {
            console.log('ℹ️ Texto de total de registros não encontrado');
        }

        // === Passo 5: Extrair notas página por página ===
        // Portal usa submetePaginacao('executarFiltrar', pageNum, 'dataEmissao')
        // para navegar entre páginas via form submit
        let paginaAtual = 1;
        const maxPaginas = totalRegistros ? Math.ceil(totalRegistros / 10) + 2 : 100;

        // Extrair primeira página
        console.log(`📄 Extraindo página 1...`);
        const notasPag1 = await extrairNotasDaTabela(page);
        console.log(`   → ${notasPag1.length} notas na página 1`);
        notas.push(...notasPag1);
        await page.screenshot({ path: path.join(DEBUG_DIR, 'resultado-pesquisa.png'), fullPage: true });

        // Determinar registros por página
        const regsPorPagina = notasPag1.length || 10;
        const totalPaginas = totalRegistros ? Math.ceil(totalRegistros / regsPorPagina) : maxPaginas;
        console.log(`📊 Estimativa: ${totalPaginas} páginas (${regsPorPagina} por página)`);

        // Extrair páginas restantes usando submetePaginacao diretamente
        for (let nextPage = 2; nextPage <= totalPaginas; nextPage++) {
            console.log(`📄 Navegando para página ${nextPage}/${totalPaginas}...`);

            try {
                // Chamar diretamente a função de paginação do portal
                await page.evaluate((pg) => {
                    if (typeof submetePaginacao === 'function') {
                        submetePaginacao('executarFiltrar', String(pg), 'dataEmissao');
                    } else {
                        // Fallback: manipular o form diretamente
                        const form = document.forms[0];
                        if (form) {
                            const pageInput = document.getElementById('page.current');
                            const orderInput = document.getElementById('order');
                            const paginandoInput = document.getElementById('paginando');
                            if (pageInput) pageInput.value = String(pg);
                            if (orderInput) orderInput.value = 'dataEmissao';
                            if (paginandoInput) paginandoInput.value = 'true';
                            form.elements['metodo'].value = 'executarFiltrar';
                            form.submit();
                        }
                    }
                }, nextPage);

                // Aguardar carregamento da nova página
                await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
                await page.waitForTimeout(1500);

                const notasPagina = await extrairNotasDaTabela(page);
                console.log(`   → ${notasPagina.length} notas na página ${nextPage}`);
                notas.push(...notasPagina);

                // Se página veio vazia, pode ter acabado
                if (notasPagina.length === 0) {
                    console.log('ℹ️ Página vazia — fim da paginação');
                    break;
                }
            } catch (e) {
                console.error(`⚠️ Erro na página ${nextPage}: ${e.message}`);
                // Tentar continuar com a próxima página
                continue;
            }
        }

        console.log(`✅ ${notas.length} notas extraídas do portal (${Math.min(paginaAtual, totalPaginas)} páginas)`);

        // === Passo 6: Enriquecer dados dos clientes visitando páginas de detalhe ===
        try {
            await enriquecerDadosClientes(page, notas);
        } catch(e) {
            console.warn('⚠️ Erro no enriquecimento de clientes (continua sem CNPJ):', e.message);
            // Limpar campos temporários que podem ter ficado
            for (const n of notas) {
                delete n._pdfLink; delete n._link; delete n._onclick; delete n._tomadorOriginal;
                delete n._prestadorOriginal; delete n._servicoContratado;
                delete n._razaoCurta;
            }
        }

        return notas;

    } catch (error) {
        console.error('❌ Erro ao extrair notas:', error.message);
        ensureDebugDir();
        try { await page.screenshot({ path: path.join(DEBUG_DIR, 'erro-extracao.png'), fullPage: true }); } catch(e) {}
        return notas;
    }
}

/**
 * Extrai notas da tabela visível na página atual.
 * 
 * A página do portal MetropolisWEB contém muitas tabelas de layout (~27).
 * A tabela real de notas tem exatamente estas colunas header (em TH):
 *   Número NFS-e | Prestador | Tomador | de Emissão | Valor Total Nota |
 *   Valor ISS | Responsável Recolhimento | Status | N° RPS
 * 
 * Critério chave: a tabela certa tem entre 8 e 15 colunas (não 269!),
 * usa <th> nos headers, e contém "Número" e "Prestador" juntos no header.
 */
async function extrairNotasDaTabela(page) {
    // Primeiro: salvar HTML para debug
    try {
        const html = await page.content();
        fs.writeFileSync(path.join(DEBUG_DIR, 'pagina-extracao.html'), html);
    } catch(e) {}

    const resultado = await page.evaluate(() => {
        const notas = [];
        const debug = { tabelas: 0, candidatas: [], tabelaUsada: null };
        const tabelas = document.querySelectorAll('table');
        debug.tabelas = tabelas.length;

        let melhorTabela = null;
        let melhorScore = 0;

        for (const tabela of tabelas) {
            // Buscar row de header com TH
            const thRows = tabela.querySelectorAll('tr');
            if (thRows.length < 2) continue;

            // Procurar a row que tem <th> (header row)
            let headerRow = null;
            let dataRowStart = 1;
            for (let r = 0; r < Math.min(3, thRows.length); r++) {
                const ths = thRows[r].querySelectorAll('th');
                if (ths.length >= 5) {
                    headerRow = thRows[r];
                    dataRowStart = r + 1;
                    break;
                }
            }

            // Se não encontrou headers com th, tentar td na primeira row
            if (!headerRow) {
                const firstRowCells = thRows[0].querySelectorAll('td');
                // Mas APENAS se a tabela tem um número razoável de colunas (8-20)
                if (firstRowCells.length >= 8 && firstRowCells.length <= 20) {
                    headerRow = thRows[0];
                    dataRowStart = 1;
                }
            }

            if (!headerRow) continue;

            const headerCells = headerRow.querySelectorAll('th, td');
            const numCols = headerCells.length;

            // FILTRO CRUCIAL: tabela de notas tem entre 8 e 20 colunas
            // Tabelas de layout têm 200+ colunas
            if (numCols < 8 || numCols > 25) continue;

            const headers = Array.from(headerCells).map(c => c.textContent.trim().toLowerCase().replace(/\s+/g, ' '));
            const headersJoined = headers.join(' | ');

            // Pontuar a tabela
            let score = 0;
            const temNumeroNfse = headers.some(h => h.includes('número') && h.includes('nfs'));
            const temPrestador = headers.some(h => h.includes('prestador'));
            const temTomador = headers.some(h => h.includes('tomador'));
            const temEmissao = headers.some(h => h.includes('emissão') || h.includes('emissao'));
            const temValor = headers.some(h => h.includes('valor'));
            const temStatus = headers.some(h => h.includes('status'));
            const temRps = headers.some(h => h.includes('rps'));

            if (temNumeroNfse) score += 3;
            if (temPrestador) score += 2;
            if (temTomador) score += 2;
            if (temEmissao) score += 2;
            if (temValor) score += 2;
            if (temStatus) score += 1;
            if (temRps) score += 1;

            debug.candidatas.push({
                rows: thRows.length,
                cols: numCols,
                score,
                headers: headersJoined.substring(0, 200)
            });

            // Precisa de pelo menos 6 pontos (Número NFS-e + Prestador + Valor = 7)
            if (score < 6) continue;

            if (score > melhorScore) {
                melhorScore = score;
                melhorTabela = { tabela, headerCells, headers, thRows, dataRowStart, numCols, score };
            }
        }

        if (!melhorTabela) {
            return { notas, debug };
        }

        const { tabela, headers, thRows, dataRowStart, numCols, score } = melhorTabela;

        // Mapear colunas pelo header
        const colIdx = {};
        for (let i = 0; i < headers.length; i++) {
            const h = headers[i];
            if ((h.includes('número') || h.includes('nfs-e') || h.includes('nfse')) && colIdx.numero === undefined) {
                colIdx.numero = i;
            } else if (h.includes('prestador') && colIdx.prestador === undefined) {
                colIdx.prestador = i;
            } else if (h.includes('tomador') && colIdx.tomador === undefined) {
                colIdx.tomador = i;
            } else if ((h.includes('emissão') || h.includes('emissao')) && colIdx.data === undefined) {
                colIdx.data = i;
            } else if (h.includes('valor total') && colIdx.valor === undefined) {
                colIdx.valor = i;
            } else if (h.includes('valor') && h.includes('iss') && colIdx.iss === undefined) {
                colIdx.iss = i;
            } else if (h.includes('valor') && !h.includes('iss') && colIdx.valor === undefined) {
                colIdx.valor = i;
            } else if ((h.includes('responsável') || h.includes('recolhimento')) && colIdx.responsavel === undefined) {
                colIdx.responsavel = i;
            } else if (h.includes('status') && colIdx.status === undefined) {
                colIdx.status = i;
            } else if (h.includes('rps') && colIdx.rps === undefined) {
                colIdx.rps = i;
            }
        }

        debug.tabelaUsada = { rows: thRows.length, cols: numCols, score, colIdx };

        // Extrair linhas de dados
        for (let i = dataRowStart; i < thRows.length; i++) {
            const cells = thRows[i].querySelectorAll('td');
            if (cells.length < 4) continue;

            const cellTexts = Array.from(cells).map(c => c.textContent.trim());

            const numero = colIdx.numero !== undefined ? cellTexts[colIdx.numero] || '' : '';
            const prestador = colIdx.prestador !== undefined ? cellTexts[colIdx.prestador] || '' : '';
            const tomador = colIdx.tomador !== undefined ? cellTexts[colIdx.tomador] || '' : '';
            const data = colIdx.data !== undefined ? cellTexts[colIdx.data] || '' : '';
            const valor = colIdx.valor !== undefined ? cellTexts[colIdx.valor] || '0' : '0';
            const iss = colIdx.iss !== undefined ? cellTexts[colIdx.iss] || '0' : '0';
            const status = colIdx.status !== undefined ? cellTexts[colIdx.status] || '' : '';

            // Capturar link do PDF da nota (ícone icon_pdf.gif na listagem)
            let pdfLink = '';
            let link = '';
            let onclick = '';
            const allLinks = thRows[i].querySelectorAll('a');
            for (const a of allLinks) {
                const href = a.getAttribute('href') || '';
                const img = a.querySelector('img');
                const imgSrc = img ? (img.getAttribute('src') || '') : '';
                
                // Detectar link de PDF (icon_pdf.gif ou metodo=relatorio)
                if (!pdfLink && (imgSrc.toLowerCase().includes('pdf') || 
                    href.toLowerCase().includes('relatorio') || href.toLowerCase().includes('imprimir'))) {
                    pdfLink = href;
                }
            }
            // Fallback: pegar link/onclick do número
            if (colIdx.numero !== undefined && cells[colIdx.numero]) {
                const aTag = cells[colIdx.numero].querySelector('a');
                if (aTag) {
                    link = aTag.getAttribute('href') || '';
                    onclick = aTag.getAttribute('onclick') || '';
                }
            }

            // Ignorar linhas sem número de nota válido
            if (!numero || !/\d+/.test(numero)) continue;
            // Ignorar linhas que parecem paginação ou JavaScript
            if (numero.length > 10) continue;
            if (cellTexts.join('').includes('function ')) continue;
            if (cellTexts.join('').includes('submetePaginacao')) continue;

            notas.push({ numero, prestador, tomador, data, valor, iss, status, link, onclick, pdfLink });
        }

        return { notas, debug };
    });

    // Log de debug
    const { notas: rows, debug } = resultado;
    if (!debug.tabelaUsada) {
        console.log('   ⚠️ Nenhuma tabela de notas identificada!');
    }

    // Converter para formato padronizado
    // No portal: Prestador = quem emitiu. Tomador = quem contratou.
    // AVANT é prestador em notas emitidas por ela. Se AVANT é tomador, é serviço contratado.
    return rows.map(r => {
        const prestadorAvant = (r.prestador || '').toUpperCase().includes('AVANT');
        const tomadorAvant = (r.tomador || '').toUpperCase().includes('AVANT');
        // Se AVANT é Tomador (contratou o serviço de outro)
        const servicoContratado = tomadorAvant && !prestadorAvant;

        let statusConciliado = r.status === 'Cancelada' ? 'Cancelada' : 'Não Pago';
        let recebido = r.status === 'Cancelada' ? 'Cancelada' : 'Em aberto';
        let observacoes = '';

        if (servicoContratado) {
            statusConciliado = 'Serviço Contratado';
            recebido = 'N/A';
            observacoes = 'NFS-e emitida por terceiro - AVANT é tomador do serviço';
        }

        return {
            numero: r.numero,
            razao_social: servicoContratado ? r.prestador : r.tomador || r.prestador,
            cnpj: '',
            data_emissao: parsearDataBR(r.data),
            valor_nota: parsearValorBR(r.valor),
            iss: parsearValorBR(r.iss),
            valor_liquido: parsearValorBR(r.valor) - parsearValorBR(r.iss),
            estado: 'BA',
            cidade: 'Lauro de Freitas',
            status_conciliado: statusConciliado,
            recebido: recebido,
            observacoes: observacoes,
            origem: 'scraping_nfse',
            _pdfLink: r.pdfLink || '',
            _link: r.link || '',
            _onclick: r.onclick || '',
            _tomadorOriginal: r.tomador || '',
            _prestadorOriginal: r.prestador || '',
            _servicoContratado: servicoContratado
        };
    }).filter(n => n.numero || n.valor_nota > 0);
}

/**
 * Enriquece dados de CADA nota baixando o PDF da NFS-e via ícone de PDF da listagem.
 * 
 * IMPORTANTE: Não agrupa por cliente — cada nota pode ter CNPJ diferente
 * (filiais diferentes com mesma razão social). A única forma segura é
 * baixar o PDF de cada nota individual.
 * 
 * Estratégia:
 * 1. Usa _pdfLink (ícone de PDF na listagem) — faz download e extrai texto
 * 2. Fallback: _link (link do número) — também baixa PDF
 * 3. Fallback: click no número da nota na listagem
 */
async function enriquecerDadosClientes(page, notas) {
    // Filtrar notas que têm algum link E que ainda não possuem CNPJ no DB
    const notasParaEnriquecer = notas.filter(n => {
        if (!n._pdfLink && !n._link && !n._onclick) return false;
        const existente = db.buscarNotaPorNumeroECnpj(String(n.numero), '');
        if (!existente) {
            try {
                const rawDb = db.getDb();
                const comCnpj = rawDb.prepare('SELECT cnpj FROM notas_fiscais WHERE numero = ? AND cnpj != ?').get(String(n.numero), '');
                if (comCnpj && comCnpj.cnpj) {
                    n.cnpj = comCnpj.cnpj;
                    return false;
                }
            } catch(e) {}
        }
        return true;
    });

    if (notasParaEnriquecer.length === 0) {
        console.log('ℹ️ Todas as notas já possuem CNPJ ou não têm link de detalhe');
        for (const n of notas) {
            delete n._pdfLink; delete n._link; delete n._onclick;
            delete n._tomadorOriginal; delete n._prestadorOriginal;
            delete n._servicoContratado;
        }
        return;
    }

    console.log(`🔍 Enriquecendo ${notasParaEnriquecer.length}/${notas.length} notas via download de PDF...`);
    ensureDebugDir();

    const urlListagem = page.url();
    let enriquecidos = 0;
    let erros = 0;

    for (let idx = 0; idx < notasParaEnriquecer.length; idx++) {
        const nota = notasParaEnriquecer[idx];
        const numNota = nota.numero;
        const progresso = `[${idx + 1}/${notasParaEnriquecer.length}]`;

        try {
            console.log(`   ${progresso} NF #${numNota} (${(nota.razao_social || '').substring(0, 15)})...`);

            const alvoEhTomador = !nota._servicoContratado;
            let dados = null;

            // Tentar baixar PDF de cada link disponível
            const linksParaTentar = [nota._pdfLink, nota._link].filter(Boolean);

            for (const rawUrl of linksParaTentar) {
                if (dados?.cnpj) break;
                try {
                    let url = rawUrl;
                    if (!url.startsWith('http')) {
                        try { url = new URL(url, urlListagem).href; }
                        catch(e) { url = urlListagem.replace(/[^/]*(\?.*)?$/, '') + url; }
                    }

                    // Interceptar download
                    const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
                    
                    let gotPage = false;
                    try {
                        await page.goto(url, { waitUntil: 'load', timeout: 15000 });
                        // Se chegou aqui sem erro, é página HTML
                        gotPage = true;
                    } catch(gotoErr) {
                        // Download disparado — capturar
                        if (gotoErr.message.includes('Download') || gotoErr.message.includes('download')) {
                            const download = await downloadPromise;
                            if (download) {
                                dados = await processarDownloadPdf(download, numNota, alvoEhTomador);
                            }
                        }
                    }

                    // Se foi uma página HTML, tentar extrair direto
                    if (gotPage && !dados?.cnpj) {
                        const urlAtual = page.url();
                        if (!urlAtual.includes('executarFiltrar')) {
                            if (idx < 3) {
                                try { fs.writeFileSync(path.join(DEBUG_DIR, `detalhe-nf-${numNota}.html`), await page.content()); } catch(e) {}
                            }
                            dados = await extrairDadosDetalhe(page, alvoEhTomador);
                        }
                    }
                } catch(e) {
                    // Silenciar, tentar próximo link
                }
            }

            // Fallback: clicar no número da nota na listagem
            if (!dados?.cnpj) {
                try {
                    // Voltar para listagem se necessário
                    if (!page.url().includes('executarFiltrar')) {
                        await page.goto(urlListagem, { waitUntil: 'load', timeout: 15000 });
                        await page.waitForTimeout(1500);
                    }

                    const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);

                    const clicou = await page.evaluate((num) => {
                        const links = document.querySelectorAll('a');
                        for (const a of links) {
                            if (a.textContent.trim() === String(num)) {
                                a.click();
                                return true;
                            }
                        }
                        return false;
                    }, numNota);

                    if (clicou) {
                        // Esperar por download ou navegação
                        const download = await Promise.race([
                            downloadPromise,
                            page.waitForLoadState('load', { timeout: 10000 }).then(() => null).catch(() => null)
                        ]);

                        if (download && download.suggestedFilename) {
                            dados = await processarDownloadPdf(download, numNota, alvoEhTomador);
                        } else if (!page.url().includes('executarFiltrar')) {
                            dados = await extrairDadosDetalhe(page, alvoEhTomador);
                        }
                    }
                } catch(e) {}
            }

            if (dados && dados.cnpj) {
                nota.cnpj = dados.cnpj;
                if (dados.razaoCompleta) nota.razao_social = dados.razaoCompleta;
                if (dados.estado) nota.estado = dados.estado;
                if (dados.cidade) nota.cidade = dados.cidade;
                enriquecidos++;
                console.log(`      ✅ CNPJ: ${dados.cnpj}${dados.razaoCompleta ? ' — ' + dados.razaoCompleta.substring(0, 40) : ''}`);

                try {
                    const razaoCurta = nota._tomadorOriginal || nota.razao_social || '';
                    const chaveMap = `${razaoCurta}|${dados.cnpj}`;
                    db.salvarMapeamentoCliente({
                        razao_social_curta: chaveMap,
                        razao_social_completa: dados.razaoCompleta || razaoCurta,
                        cnpj: dados.cnpj,
                        email: dados.email || null,
                        telefone: dados.telefone || null,
                        endereco: dados.endereco || null,
                        cidade: dados.cidade || null,
                        estado: dados.estado || null,
                        contato: null,
                        observacoes: `NF #${numNota} — Extraído automaticamente`
                    });
                } catch(e) {}
            } else {
                console.log(`      ⚠️ CNPJ não encontrado para NF #${numNota}`);
                erros++;
            }

        } catch(e) {
            console.warn(`      ❌ Erro NF #${numNota}: ${e.message.substring(0, 80)}`);
            erros++;
        }
    }

    // Limpar campos temporários
    for (const n of notas) {
        delete n._pdfLink; delete n._link; delete n._onclick;
        delete n._tomadorOriginal; delete n._prestadorOriginal;
        delete n._servicoContratado; delete n._razaoCurta;
    }

    console.log(`✅ Enriquecimento: ${enriquecidos}/${notasParaEnriquecer.length} notas com CNPJ (${erros} erros)`);
}

/**
 * Processa um download de PDF: salva na pasta local, extrai texto e retorna dados.
 */
async function processarDownloadPdf(download, numNota, alvoEhTomador) {
    try {
        const tmpPath = await download.path();
        if (!tmpPath) return null;

        // Salvar PDF permanentemente na pasta data/notas_pdf/
        if (!fs.existsSync(NOTAS_PDF_DIR)) fs.mkdirSync(NOTAS_PDF_DIR, { recursive: true });
        const destPath = path.join(NOTAS_PDF_DIR, `NF-${numNota}.pdf`);
        fs.copyFileSync(tmpPath, destPath);
        console.log(`      📄 PDF salvo: notas_pdf/NF-${numNota}.pdf`);

        // Ler e extrair texto
        const pdfBuffer = fs.readFileSync(destPath);
        const pdfData = await pdfParse(pdfBuffer);

        // Salvar texto para debug
        try { fs.writeFileSync(path.join(DEBUG_DIR, `pdf-nf-${numNota}.txt`), pdfData.text); } catch(e) {}

        return extrairDadosDoPdfText(pdfData.text, alvoEhTomador);
    } catch(e) {
        console.log(`      ❌ PDF falhou: ${e.message.substring(0, 80)}`);
        return null;
    }
}

// extrairDadosDoPdfText importado de ./utils

/**
 * Extrai CNPJ e dados do tomador/prestador da página de detalhe de uma NFS-e.
 * Usa 3 estratégias de fallback para encontrar os dados.
 */
async function extrairDadosDetalhe(page, alvoEhTomador) {
    return await page.evaluate((alvoTomador) => {
        const body = document.body.innerText;
        const result = { cnpj: '', razaoCompleta: '', endereco: '', cidade: '', estado: '', email: '', telefone: '' };

        // ── Estratégia 1: Encontrar seção "Tomador" ou "Prestador" e extrair dados ──
        const secaoAlvo = alvoTomador ? /tomador\s*(de\s*servi[çc]os?)?/i : /prestador\s*(de\s*servi[çc]os?)?/i;

        const idxAlvo = body.search(secaoAlvo);

        if (idxAlvo > -1) {
            // Pegar texto entre a seção alvo e a próxima seção
            let fim = body.length;
            const afterAlvo = body.substring(idxAlvo + 10);
            const nextSection = afterAlvo.search(/\b(prestador|tomador|discrimina[çc][ãa]o|servi[çc]os?|tribut|valor|intermediário)\b/i);
            if (nextSection > 0) fim = idxAlvo + 10 + nextSection;

            const trecho = body.substring(idxAlvo, Math.min(fim, idxAlvo + 2000));

            // CNPJ: XX.XXX.XXX/XXXX-XX
            const cnpjMatch = trecho.match(/(\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})/);
            if (cnpjMatch) result.cnpj = cnpjMatch[1].replace(/\s/g, '');

            // Razão Social
            const razaoMatch = trecho.match(/raz[ãa]o\s*social[:\s]*([^\n\r]+)/i);
            if (razaoMatch) result.razaoCompleta = razaoMatch[1].trim();
            if (!result.razaoCompleta) {
                const nomeMatch = trecho.match(/nome\s*fantasia[:\s]*([^\n\r]+)/i);
                if (nomeMatch) result.razaoCompleta = nomeMatch[1].trim();
            }

            // Endereço
            const endMatch = trecho.match(/endere[çc]o[:\s]*([^\n\r]+)/i);
            if (endMatch) result.endereco = endMatch[1].trim();

            // Município/Cidade
            const cidMatch = trecho.match(/munic[ií]pio[:\s]*([^\n\r]+)/i);
            if (cidMatch) result.cidade = cidMatch[1].trim();
            if (!result.cidade) {
                const cidMatch2 = trecho.match(/cidade[:\s]*([^\n\r]+)/i);
                if (cidMatch2) result.cidade = cidMatch2[1].trim();
            }

            // UF
            const ufMatch = trecho.match(/\bUF[:\s]*([A-Z]{2})\b/i);
            if (ufMatch) result.estado = ufMatch[1].toUpperCase();

            // Email
            const emailMatch = trecho.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
            if (emailMatch) result.email = emailMatch[1];

            // Telefone
            const telMatch = trecho.match(/(\(?\d{2}\)?\s*\d{4,5}[-\s]?\d{4})/);
            if (telMatch) result.telefone = telMatch[1];
        }

        // ── Estratégia 2: Busca em tabelas por labels ──
        if (!result.cnpj) {
            const tds = document.querySelectorAll('td, th, dt, dd, span, label');
            let foundSection = false;
            const alvoText = alvoTomador ? 'tomador' : 'prestador';
            for (let i = 0; i < tds.length; i++) {
                const txt = tds[i].textContent.trim().toLowerCase();
                if (txt.includes(alvoText)) foundSection = true;
                if (foundSection) {
                    const cnpjMatch = tds[i].textContent.match(/(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/);
                    if (cnpjMatch) {
                        result.cnpj = cnpjMatch[1];
                        if (i + 1 < tds.length && !result.razaoCompleta) {
                            const nextText = tds[i + 1].textContent.trim();
                            if (nextText.length > 5 && !nextText.match(/^\d/) && !nextText.toLowerCase().includes('cnpj')) {
                                result.razaoCompleta = nextText;
                            }
                        }
                        break;
                    }
                }
            }
        }

        // ── Estratégia 3: Todos os CNPJs na página — pegar o correto por posição ──
        if (!result.cnpj) {
            const allCnpjs = body.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g);
            if (allCnpjs && allCnpjs.length >= 2) {
                // Em NFS-e: 1º CNPJ = prestador, 2º = tomador
                result.cnpj = alvoTomador ? allCnpjs[1] : allCnpjs[0];
            } else if (allCnpjs && allCnpjs.length === 1) {
                result.cnpj = allCnpjs[0];
            }
        }

        return result;
    }, alvoEhTomador);
}

/**
 * Mapeia valores extraídos de uma tabela para campos padronizados de nota
 */
function mapearValoresParaNota(headers, valores) {
    const nota = {
        numero: '',
        razao_social: '',
        cnpj: '',
        data_emissao: '',
        valor_nota: 0,
        iss: 0,
        valor_liquido: 0,
        estado: 'BA',
        cidade: 'Lauro de Freitas',
        status_conciliado: 'Não Pago',
        recebido: 'Em aberto',
        origem: 'scraping_nfse'
    };

    const mapeamento = {
        numero: ['número', 'numero', 'nf', 'nº', 'nota', 'num', 'nº nfse', 'nfse'],
        razao_social: ['razão social', 'razao social', 'tomador', 'prestador', 'nome', 'cliente', 'razão'],
        cnpj: ['cnpj', 'cpf/cnpj', 'cpf', 'documento', 'cnpj/cpf'],
        data_emissao: ['data', 'data emissão', 'data de emissão', 'emissão', 'emissao', 'dt emissão', 'competência', 'dt. emissão'],
        valor_nota: ['valor', 'valor total', 'valor da nota', 'valor bruto', 'vlr', 'valor (r$)', 'valor serviço', 'valor serviços'],
        iss: ['iss', 'iss retido', 'imposto', 'iss (r$)', 'valor iss'],
        valor_liquido: ['valor líquido', 'valor liquido', 'líquido', 'liquido', 'vlr líquido']
    };

    for (let i = 0; i < Math.min(headers.length, valores.length); i++) {
        const header = headers[i];
        const valor = valores[i];

        for (const [campo, aliases] of Object.entries(mapeamento)) {
            if (aliases.some(a => header.includes(a))) {
                if (['valor_nota', 'iss', 'valor_liquido'].includes(campo)) {
                    nota[campo] = parsearValorBR(valor);
                } else if (campo === 'data_emissao') {
                    nota[campo] = parsearDataBR(valor);
                } else {
                    nota[campo] = valor;
                }
                break;
            }
        }
    }

    if (nota.valor_nota > 0 && nota.valor_liquido === 0) {
        nota.valor_liquido = nota.valor_nota - nota.iss;
    }

    if (!nota.numero && nota.valor_nota === 0) return null;
    return nota;
}

// parsearValorBR e parsearDataBR importados de ./utils

/** Salva notas extraídas no banco de dados (evitando duplicatas) */
async function salvarNotasExtraidas(notas, syncId) {
    let inseridos = 0;
    let ignorados = 0;
    let atualizados = 0;

    for (const nota of notas) {
        try {
            // 1. Verificar se já existe com o mesmo CNPJ (match exato)
            if (nota.cnpj) {
                const existeComCnpj = db.buscarNotaPorNumeroECnpj(String(nota.numero), nota.cnpj);
                if (existeComCnpj) { ignorados++; continue; }

                // 2. Verificar se existe com CNPJ vazio (notas anteriores sem enriquecimento)
                const existeSemCnpj = db.buscarNotaPorNumeroECnpj(String(nota.numero), '');
                if (existeSemCnpj) {
                    // Atualizar a nota existente com os dados enriquecidos
                    db.atualizarNota(existeSemCnpj.id, {
                        cnpj: nota.cnpj,
                        razao_social: nota.razao_social,
                        estado: nota.estado,
                        cidade: nota.cidade
                    });
                    atualizados++;
                    continue;
                }
            } else {
                const existente = db.buscarNotaPorNumeroECnpj(String(nota.numero), '');
                if (existente) { ignorados++; continue; }
            }

            // 3. Inserir como nova
            if (nota.cnpj) {
                db.inserirOuAtualizarCliente({
                    cnpj: nota.cnpj,
                    razao_social: nota.razao_social,
                    cidade: nota.cidade,
                    estado: nota.estado
                });
            }
            db.inserirNota(nota);
            inseridos++;
        } catch (error) {
            console.warn(`⚠️ Erro ao inserir nota ${nota.numero}:`, error.message);
            ignorados++;
        }
    }

    console.log(`💾 Notas salvas: ${inseridos} novas, ${atualizados} atualizadas com CNPJ, ${ignorados} ignoradas`);
    return { inseridos, ignorados, atualizados, total: notas.length };
}

/** Encerra a sessão de scraping */
async function encerrarSessao() {
    if (sessaoAtiva) {
        try {
            if (sessaoAtiva.browser) await sessaoAtiva.browser.close();
        } catch (e) { /* ignorar */ }
        sessaoAtiva = null;
        console.log('🛑 Sessão de scraping encerrada');
    }
}

/** Retorna o estado atual da sessão */
function obterStatusSessao() {
    if (!sessaoAtiva) return { ativa: false, status: 'inativa' };
    return {
        ativa: true,
        status: sessaoAtiva.status,
        syncId: sessaoAtiva.syncId,
        iniciadoEm: sessaoAtiva.iniciadoEm
    };
}

/**
 * Sincronização 100% automática — OCR resolve o CAPTCHA
 * Tenta até MAX_TENTATIVAS vezes com CAPTCHAs novos
 */
const MAX_TENTATIVAS_OCR = 3;

async function sincronizarAutomatico(login, senha, onProgresso) {
    const progresso = onProgresso || (() => {});

    progresso('iniciando', 'Abrindo portal...');
    const sessao = await iniciarSessao(login, senha);

    if (!sessao.success || !sessao.captchaImage) {
        throw new Error('Não foi possível acessar o portal ou capturar CAPTCHA');
    }

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_OCR; tentativa++) {
        progresso('ocr', `Tentativa OCR ${tentativa}/${MAX_TENTATIVAS_OCR} — lendo CAPTCHA...`);

        // Obter buffer do CAPTCHA atual
        const captchaBuffer = await obterCaptchaBuffer();
        if (!captchaBuffer) {
            progresso('erro', 'Não foi possível capturar imagem do CAPTCHA');
            throw new Error('Falha ao capturar CAPTCHA para OCR');
        }

        // Salvar CAPTCHA original para debug
        ensureDebugDir();
        fs.writeFileSync(path.join(DEBUG_DIR, `captcha-tentativa-${tentativa}.png`), captchaBuffer);

        // Resolver com OCR
        const resultado = await ocr.resolverCaptcha(captchaBuffer);
        console.log(`🔤 Tentativa ${tentativa}: OCR leu "${resultado.texto}" (confiança: ${Math.round(resultado.confianca)}%)`);

        if (!resultado.texto || resultado.texto.length < 3) {
            console.log('⚠️ OCR não conseguiu ler texto válido, renovando CAPTCHA...');
            if (tentativa < MAX_TENTATIVAS_OCR) {
                await capturarNovoCaptcha();
                continue;
            }
            break;
        }

        progresso('login', `Tentando login com CAPTCHA "${resultado.texto}"...`);

        // Tentar logar
        const loginResult = await resolverCaptchaELogar(resultado.texto);

        if (loginResult.success) {
            progresso('concluido', `Sucesso! ${loginResult.notasEncontradas} notas encontradas, ${loginResult.notasNovas} novas.`);
            return {
                success: true,
                tentativas: tentativa,
                textoOCR: resultado.texto,
                confiancaOCR: resultado.confianca,
                notasEncontradas: loginResult.notasEncontradas,
                notasNovas: loginResult.notasNovas,
                notasDuplicadas: loginResult.notasDuplicadas,
                notasAtualizadasCnpj: loginResult.notasAtualizadasCnpj || 0,
                syncId: loginResult.syncId
            };
        }

        // Falhou — CAPTCHA incorreto
        console.log(`❌ Tentativa ${tentativa} falhou: ${loginResult.error}`);

        if (tentativa >= MAX_TENTATIVAS_OCR) break;

        // A função resolverCaptchaELogar já pegou novo CAPTCHA se retryCaptcha=true
        if (!loginResult.retryCaptcha) {
            // Se não tem retry, algo diferente falhou (credenciais?)
            throw new Error(loginResult.error || 'Falha no login — verifique as credenciais');
        }

        progresso('retry', `CAPTCHA incorreto, tentando novamente...`);
    }

    // Esgotou tentativas — manter sessão aberta para fallback manual
    progresso('fallback', 'OCR não conseguiu resolver. Enviando CAPTCHA para entrada manual...');
    let captchaImageBase64 = null;
    try {
        // Renovar CAPTCHA para mostrar um novo ao usuário
        await capturarNovoCaptcha();
        const novoCaptcha = await obterCaptchaBuffer();
        if (novoCaptcha) {
            captchaImageBase64 = `data:image/png;base64,${novoCaptcha.toString('base64')}`;
        }
    } catch (e) {
        console.warn('Não foi possível capturar CAPTCHA para fallback manual:', e.message);
    }
    return {
        success: false,
        tentativas: MAX_TENTATIVAS_OCR,
        error: `OCR não conseguiu resolver o CAPTCHA em ${MAX_TENTATIVAS_OCR} tentativas`,
        captchaImage: captchaImageBase64
    };
}

/**
 * Captura o buffer bruto do CAPTCHA da sessão ativa (para OCR)
 */
async function obterCaptchaBuffer() {
    if (!sessaoAtiva || !sessaoAtiva.page) return null;
    try {
        const captchaEl = await sessaoAtiva.page.$(SEL.captchaImg);
        if (captchaEl) {
            return await captchaEl.screenshot();
        }
        return null;
    } catch (e) {
        console.error('Erro ao obter buffer do CAPTCHA:', e.message);
        return null;
    }
}

module.exports = {
    iniciarSessao,
    resolverCaptchaELogar,
    sincronizarAutomatico,
    encerrarSessao,
    obterStatusSessao
};
