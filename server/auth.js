/**
 * Middleware de Basic Auth opcional.
 * Ativo apenas quando DASHBOARD_USER e DASHBOARD_PASS estão definidos no env.
 * Lê env a cada request para permitir hot-reload e facilitar testes.
 */

const crypto = require('crypto');

function timingSafeEqual(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function basicAuth(req, res, next) {
    const user = process.env.DASHBOARD_USER || '';
    const pass = process.env.DASHBOARD_PASS || '';

    // Auth desativada — passa direto
    if (!user || !pass) return next();

    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');

    if (scheme !== 'Basic' || !encoded) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard AVANT", charset="UTF-8"');
        return res.status(401).json({ success: false, error: 'Autenticação requerida' });
    }

    let decoded;
    try {
        decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
        res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard AVANT"');
        return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    const sepIdx = decoded.indexOf(':');
    if (sepIdx < 0) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard AVANT"');
        return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    const reqUser = decoded.slice(0, sepIdx);
    const reqPass = decoded.slice(sepIdx + 1);

    const userOk = timingSafeEqual(reqUser, user);
    const passOk = timingSafeEqual(reqPass, pass);

    if (!userOk || !passOk) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard AVANT"');
        return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    next();
}

module.exports = basicAuth;
