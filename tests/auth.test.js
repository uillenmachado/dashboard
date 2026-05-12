import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub do logger para silenciar saída durante testes
vi.mock('../server/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn() }
}));

describe('basicAuth middleware', () => {
    let basicAuth;
    let originalEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        vi.resetModules();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    function loadAuth(user, pass) {
        process.env.DASHBOARD_USER = user || '';
        process.env.DASHBOARD_PASS = pass || '';
        return import('../server/auth.js').then(m => m.default);
    }

    function mockRes() {
        return {
            statusCode: 200,
            headers: {},
            body: null,
            setHeader(k, v) { this.headers[k] = v; },
            status(code) { this.statusCode = code; return this; },
            json(obj) { this.body = obj; return this; }
        };
    }

    it('passa direto quando auth não está configurado', async () => {
        const auth = await loadAuth('', '');
        const next = vi.fn();
        const res = mockRes();
        auth({ headers: {} }, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
    });

    it('retorna 401 sem header Authorization', async () => {
        const auth = await loadAuth('admin', 'secret');
        const next = vi.fn();
        const res = mockRes();
        auth({ headers: {} }, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.headers['WWW-Authenticate']).toContain('Basic');
    });

    it('aceita credenciais corretas', async () => {
        const auth = await loadAuth('admin', 'secret');
        const next = vi.fn();
        const res = mockRes();
        const encoded = Buffer.from('admin:secret').toString('base64');
        auth({ headers: { authorization: `Basic ${encoded}` } }, res, next);
        expect(next).toHaveBeenCalled();
    });

    it('rejeita senha errada', async () => {
        const auth = await loadAuth('admin', 'secret');
        const next = vi.fn();
        const res = mockRes();
        const encoded = Buffer.from('admin:wrong').toString('base64');
        auth({ headers: { authorization: `Basic ${encoded}` } }, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
    });

    it('rejeita usuário errado', async () => {
        const auth = await loadAuth('admin', 'secret');
        const next = vi.fn();
        const res = mockRes();
        const encoded = Buffer.from('hacker:secret').toString('base64');
        auth({ headers: { authorization: `Basic ${encoded}` } }, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
    });

    it('rejeita esquema diferente de Basic', async () => {
        const auth = await loadAuth('admin', 'secret');
        const next = vi.fn();
        const res = mockRes();
        auth({ headers: { authorization: 'Bearer abc.def' } }, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
    });

    it('rejeita base64 sem separador :', async () => {
        const auth = await loadAuth('admin', 'secret');
        const next = vi.fn();
        const res = mockRes();
        const encoded = Buffer.from('semseparador').toString('base64');
        auth({ headers: { authorization: `Basic ${encoded}` } }, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
    });
});
