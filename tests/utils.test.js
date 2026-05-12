import { describe, it, expect } from 'vitest';
import {
    parsearValorBR,
    parsearDataBR,
    parseExcelDate,
    extrairDadosDoPdfText,
    AVANT_CNPJ_RAIZ
} from '../server/utils.js';

describe('parsearValorBR', () => {
    it('converte valor BR formatado com R$', () => {
        expect(parsearValorBR('R$ 1.234,56')).toBe(1234.56);
    });

    it('converte valor sem prefixo', () => {
        expect(parsearValorBR('1.234,56')).toBe(1234.56);
    });

    it('lida com valor sem milhar', () => {
        expect(parsearValorBR('99,90')).toBe(99.9);
    });

    it('retorna 0 para entrada vazia ou inválida', () => {
        expect(parsearValorBR('')).toBe(0);
        expect(parsearValorBR(null)).toBe(0);
        expect(parsearValorBR('abc')).toBe(0);
    });

    it('lida com valor inteiro', () => {
        expect(parsearValorBR('1500')).toBe(1500);
    });
});

describe('parsearDataBR', () => {
    it('converte DD/MM/YYYY para ISO', () => {
        expect(parsearDataBR('15/03/2025')).toBe('2025-03-15');
    });

    it('extrai data de string maior', () => {
        expect(parsearDataBR('Emissão: 01/12/2024 14:30')).toBe('2024-12-01');
    });

    it('retorna string original quando não bate o padrão', () => {
        expect(parsearDataBR('sem data')).toBe('sem data');
    });

    it('retorna vazio para entrada vazia', () => {
        expect(parsearDataBR('')).toBe('');
        expect(parsearDataBR(null)).toBe('');
    });
});

describe('parseExcelDate', () => {
    it('converte serial number do Excel', () => {
        // 45000 = 17/04/2023 aprox
        const result = parseExcelDate(45000);
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('converte string DD/MM/YYYY', () => {
        expect(parseExcelDate('15/03/2025')).toBe('2025-03-15');
    });

    it('converte string ISO', () => {
        expect(parseExcelDate('2025-03-15')).toBe('2025-03-15');
    });

    it('retorna null para entrada inválida', () => {
        expect(parseExcelDate(null)).toBe(null);
        expect(parseExcelDate('')).toBe(null);
        expect(parseExcelDate('texto qualquer')).toBe(null);
    });

    it('aceita objeto Date', () => {
        const d = new Date('2025-03-15T00:00:00Z');
        expect(parseExcelDate(d)).toBe('2025-03-15');
    });
});

describe('AVANT_CNPJ_RAIZ', () => {
    it('é o CNPJ raiz da AVANT', () => {
        expect(AVANT_CNPJ_RAIZ).toBe('41.187.368');
    });
});

describe('extrairDadosDoPdfText', () => {
    const pdfTextSample = `
        Prestador
        Nome/Razão SocialAVANT SERVICOS INTEGRADOS LTDA
        CNPJ: 41.187.368/0001-98
        Endereço: Rua das Flores, 100
        Município: Lauro de Freitas
        UF: BA
        contato@avant.com.br

        Tomador
        Nome/Razão SocialCIMED & CO. S.A.
        CNPJ: 16.619.378/0023-13
        Endereço: Av. Paulista, 1000
        Município: São Paulo
        UF: SP
        financeiro@cimed.com.br
    `;

    it('extrai dados do tomador corretamente', () => {
        const tomador = extrairDadosDoPdfText(pdfTextSample, true);
        expect(tomador.razaoCompleta).toContain('CIMED');
        expect(tomador.cnpj).toBe('16.619.378/0023-13');
        expect(tomador.estado).toBe('SP');
    });

    it('extrai dados do prestador (AVANT) corretamente', () => {
        const prestador = extrairDadosDoPdfText(pdfTextSample, false);
        expect(prestador.razaoCompleta).toContain('AVANT');
        expect(prestador.cnpj).toBe('41.187.368/0001-98');
        expect(prestador.estado).toBe('BA');
    });

    it('deduplica CNPJs repetidos no texto', () => {
        const textoDup = pdfTextSample + '\nDiscriminação: serviço prestado por CNPJ 41.187.368/0001-98';
        const tomador = extrairDadosDoPdfText(textoDup, true);
        expect(tomador.cnpj).toBe('16.619.378/0023-13'); // não deve pegar AVANT duplicado
    });
});
