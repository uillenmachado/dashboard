/**
 * Módulo utilitário compartilhado — funções de parsing e extração
 * usadas por scraper.js e scripts de manutenção.
 */

/** Raiz do CNPJ da empresa emissora AVANT/NDS */
const AVANT_CNPJ_RAIZ = '41.187.368';

/**
 * Extrai dados do tomador/prestador a partir do TEXTO de um PDF de NFS-e.
 * 
 * O PDF do MetropolisWEB tem layout em duas colunas (Prestador | Tomador)
 * que o pdf-parse extrai em ordem misturada. Usamos abordagem posicional:
 * - Encontrar TODOS os blocos "Nome/Razão" no texto
 * - Identificar AVANT pelo nome para separar prestador de tomador
 * - CNPJs deduplicados e identificados pela raiz AVANT (41.187.368)
 * 
 * @param {string} text - Texto extraído do PDF
 * @param {boolean} alvoEhTomador - true=dados do tomador (cliente), false=dados do prestador
 * @returns {Object} { cnpj, razaoCompleta, endereco, cidade, estado, email, telefone }
 */
function extrairDadosDoPdfText(text, alvoEhTomador) {
    const result = { cnpj: '', razaoCompleta: '', endereco: '', cidade: '', estado: '', email: '', telefone: '' };

    // Encontrar todos os blocos Nome/Razão no texto
    const nomeRazaoRegex = /nome\s*\/?\s*raz[ãa]o?\s*:?\s*(?:social\s*:?\s*)?(.+)/gi;
    const nomes = [];
    let m;
    while ((m = nomeRazaoRegex.exec(text)) !== null) {
        const nome = m[1].trim().replace(/\s+/g, ' ');
        if (nome.length > 2) nomes.push({ nome, pos: m.index });
    }

    // Encontrar todos os CNPJs formatados (deduplicados para evitar CNPJ da discriminação)
    const cnpjRegex = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g;
    const cnpjsRaw = [];
    while ((m = cnpjRegex.exec(text)) !== null) {
        cnpjsRaw.push({ cnpj: m[0], pos: m.index });
    }
    const seen = new Set();
    const cnpjs = cnpjsRaw.filter(c => {
        if (seen.has(c.cnpj)) return false;
        seen.add(c.cnpj);
        return true;
    });

    // Identificar qual bloco é AVANT (prestador) e qual é o outro (tomador)
    let idxAvant = -1;
    let idxOutro = -1;
    for (let i = 0; i < nomes.length; i++) {
        if (nomes[i].nome.toUpperCase().includes('AVANT')) {
            idxAvant = i;
        } else if (idxOutro === -1) {
            idxOutro = i;
        }
    }

    // Pegar o nome do alvo
    if (alvoEhTomador && idxOutro >= 0) {
        result.razaoCompleta = nomes[idxOutro].nome;
    } else if (!alvoEhTomador && idxAvant >= 0) {
        result.razaoCompleta = nomes[idxAvant].nome;
    } else if (nomes.length === 1) {
        result.razaoCompleta = nomes[0].nome;
    }

    // Identificar CNPJ pela raiz da AVANT — o outro é do tomador
    const idxCnpjAvant = cnpjs.findIndex(c => c.cnpj.startsWith(AVANT_CNPJ_RAIZ));
    const idxCnpjOutro = cnpjs.findIndex((c, i) => i !== idxCnpjAvant);

    if (alvoEhTomador) {
        result.cnpj = idxCnpjOutro >= 0 ? cnpjs[idxCnpjOutro].cnpj : (cnpjs[0] ? cnpjs[0].cnpj : '');
    } else {
        result.cnpj = idxCnpjAvant >= 0 ? cnpjs[idxCnpjAvant].cnpj : (cnpjs[0] ? cnpjs[0].cnpj : '');
    }

    // Extrair dados complementares do texto próximo ao nome-alvo
    const alvoNome = alvoEhTomador ? idxOutro : idxAvant;
    if (alvoNome >= 0 && nomes[alvoNome]) {
        const startPos = nomes[alvoNome].pos;
        const trecho = text.substring(startPos, startPos + 500);

        const endMatch = trecho.match(/endere[çc]o\s*:?\s*([^\n\r]+)/i);
        if (endMatch) result.endereco = endMatch[1].trim();

        const cidMatch = trecho.match(/munic[ií]pio\s*:?\s*([^\n\r]+)/i);
        if (cidMatch) result.cidade = cidMatch[1].trim();

        const ufMatch = trecho.match(/\bUF\s*:?\s*([A-Z]{2})\b/i);
        if (ufMatch) result.estado = ufMatch[1].toUpperCase();

        const emailMatch = trecho.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
        if (emailMatch) result.email = emailMatch[1];
    }

    return result;
}

/** Parseia valor monetário brasileiro (1.234,56 ou R$ 1.234,56) para float */
function parsearValorBR(texto) {
    if (!texto) return 0;
    const limpo = texto.replace(/[R$\s]/g, '').trim();
    const convertido = limpo.replace(/\./g, '').replace(',', '.');
    return parseFloat(convertido) || 0;
}

/** Parseia data brasileira (DD/MM/YYYY) para formato ISO (YYYY-MM-DD) */
function parsearDataBR(texto) {
    if (!texto) return '';
    const match = texto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (match) return `${match[3]}-${match[2]}-${match[1]}`;
    return texto;
}

/**
 * Converte data do Excel (serial number ou string) para string ISO (YYYY-MM-DD)
 */
function parseExcelDate(value) {
    if (!value) return null;
    if (typeof value === 'number') {
        const date = new Date((value - 25569) * 86400 * 1000);
        if (isNaN(date.getTime())) return null;
        return date.toISOString().split('T')[0];
    }
    if (typeof value === 'string') {
        const brMatch = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (brMatch) return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;
        const date = new Date(value);
        if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
    }
    if (value instanceof Date) return value.toISOString().split('T')[0];
    return null;
}

module.exports = {
    AVANT_CNPJ_RAIZ,
    extrairDadosDoPdfText,
    parsearValorBR,
    parsearDataBR,
    parseExcelDate
};
