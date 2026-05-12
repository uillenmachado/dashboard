/**
 * Módulo OCR - Resolve CAPTCHA Kaptcha automaticamente
 * Usa sharp para pré-processar a imagem e tesseract.js para OCR
 * Abordagem: ColorMask — remove grade azul e fundo branco por cor,
 * mantendo apenas os pixels do texto vermelho/rosa.
 */

const { createWorker } = require('tesseract.js');
const sharp = require('sharp');

let worker = null;

/**
 * Inicializa o worker do Tesseract (reutilizável)
 */
async function getWorker() {
    if (!worker) {
        console.log('🔤 Inicializando Tesseract OCR...');
        worker = await createWorker('eng', 1, {});
        await worker.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
            tessedit_pageseg_mode: '8', // Single word
        });
        console.log('✅ Tesseract OCR pronto');
    }
    return worker;
}

/**
 * Pré-processa a imagem do CAPTCHA usando a abordagem ColorMask.
 * O Kaptcha do portal usa texto VERMELHO/ROSA sobre grade AZUL com fundo BRANCO.
 * Estratégia: classificar cada pixel por cor → remover azul e branco → manter texto.
 */
async function preprocessarCaptcha(imageBuffer) {
    const variantes = [];

    // Extrair pixels brutos da imagem original
    const raw = await sharp(imageBuffer).raw().toBuffer({ resolveWithObject: true });
    const { data: pixels, info } = raw;
    const { width, height, channels } = info;

    // === Passo 1: Classificação por cor ===
    // Grid azul → branco (fundo), Background branco → branco (fundo), Resto → preto (texto)
    const textMask = Buffer.alloc(width * height);
    for (let i = 0; i < width * height; i++) {
        const r = pixels[i * channels];
        const g = pixels[i * channels + 1];
        const b = pixels[i * channels + 2];

        // Grade azul: componente B dominante
        const isBlue = b > 80 && b > r * 1.2 && b > g * 1.2;
        // Background branco/claro
        const isLight = r > 190 && g > 190 && b > 190;
        // Pixel misturado com componente vermelho (texto sobre grade)
        const hasRed = r > 100 && r > g;

        if (isLight) {
            textMask[i] = 255; // fundo → branco
        } else if (isBlue && !hasRed) {
            textMask[i] = 255; // grade pura → branco
        } else {
            textMask[i] = 0;   // texto → preto
        }
    }

    // === Passo 2: Inpainting horizontal (reconectar texto cortado pela grade) ===
    const inpainted = Buffer.from(textMask);
    for (let y = 0; y < height; y++) {
        for (let x = 1; x < width - 1; x++) {
            if (textMask[y * width + x] === 255) {
                const left = x > 1 ? textMask[y * width + (x - 2)] : 255;
                const right = x < width - 2 ? textMask[y * width + (x + 2)] : 255;
                if (left === 0 && right === 0) {
                    inpainted[y * width + x] = 0;
                }
            }
        }
    }

    // === Passo 3: Remover pixels isolados (ruído) ===
    const cleaned = Buffer.from(inpainted);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            if (inpainted[y * width + x] === 0) {
                let n = 0;
                for (let dy = -1; dy <= 1; dy++)
                    for (let dx = -1; dx <= 1; dx++)
                        if (!(dy === 0 && dx === 0) && inpainted[(y + dy) * width + (x + dx)] === 0) n++;
                if (n <= 1) cleaned[y * width + x] = 255;
            }
        }
    }

    // === Passo 4: Dilação (engrossar traços para compensar remoção da grade) ===
    const dilated = Buffer.alloc(width * height, 255);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            if (cleaned[y * width + x] === 0 ||
                cleaned[y * width + (x - 1)] === 0 || cleaned[y * width + (x + 1)] === 0 ||
                cleaned[(y - 1) * width + x] === 0 || cleaned[(y + 1) * width + x] === 0) {
                dilated[y * width + x] = 0;
            }
        }
    }

    // === Variante 1: Nearest-neighbor upscale (texto nítido) ===
    try {
        const v1 = await sharp(cleaned, { raw: { width, height, channels: 1 } })
            .resize({ width: 600, height: 180, fit: 'fill', kernel: 'nearest' })
            .extend({ top: 25, bottom: 25, left: 25, right: 25, background: '#ffffff' })
            .png()
            .toBuffer();
        variantes.push({ nome: 'colorMask-nearest', buffer: v1 });
    } catch (e) { /* ignorar */ }

    // === Variante 2: Lanczos upscale + threshold (suavizado) ===
    try {
        const v2 = await sharp(cleaned, { raw: { width, height, channels: 1 } })
            .resize({ width: 600, height: 180, fit: 'fill', kernel: 'lanczos3' })
            .threshold(128)
            .extend({ top: 25, bottom: 25, left: 25, right: 25, background: '#ffffff' })
            .png()
            .toBuffer();
        variantes.push({ nome: 'colorMask-lanczos', buffer: v2 });
    } catch (e) { /* ignorar */ }

    // === Variante 3: Dilated + nearest (traços mais grossos) ===
    try {
        const v3 = await sharp(dilated, { raw: { width, height, channels: 1 } })
            .resize({ width: 600, height: 180, fit: 'fill', kernel: 'nearest' })
            .extend({ top: 25, bottom: 25, left: 25, right: 25, background: '#ffffff' })
            .png()
            .toBuffer();
        variantes.push({ nome: 'colorMask-dilated', buffer: v3 });
    } catch (e) { /* ignorar */ }

    return variantes;
}

/**
 * Limpa o texto reconhecido pelo OCR
 */
function limparTextoOCR(texto) {
    return texto
        .replace(/[\s\n\r]/g, '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .trim();
}

/**
 * Resolve um CAPTCHA a partir de um buffer de imagem.
 * Tenta múltiplas variantes de pré-processamento e retorna o melhor resultado.
 */
async function resolverCaptcha(imageBuffer) {
    const ocrWorker = await getWorker();
    const variantes = await preprocessarCaptcha(imageBuffer);

    let melhorResultado = { texto: '', confianca: 0 };

    for (const variante of variantes) {
        try {
            const { data } = await ocrWorker.recognize(variante.buffer);
            const textoLimpo = limparTextoOCR(data.text);
            const confianca = data.confidence;

            console.log(`  [OCR] ${variante.nome}: "${textoLimpo}" (confiança: ${Math.round(confianca)}%)`);

            if (textoLimpo.length >= 3 && textoLimpo.length <= 8 && confianca > melhorResultado.confianca) {
                melhorResultado = { texto: textoLimpo, confianca };
            }
        } catch (e) {
            console.warn(`  [OCR] ${variante.nome}: erro -`, e.message);
        }
    }

    // Se nenhuma variante deu resultado válido, pegar qualquer uma com texto
    if (!melhorResultado.texto) {
        for (const variante of variantes) {
            try {
                const { data } = await ocrWorker.recognize(variante.buffer);
                const textoLimpo = limparTextoOCR(data.text);
                if (textoLimpo.length >= 3) {
                    melhorResultado = { texto: textoLimpo, confianca: data.confidence };
                    break;
                }
            } catch (e) { /* ignorar */ }
        }
    }

    console.log(`🔤 OCR melhor resultado: "${melhorResultado.texto}" (confiança: ${Math.round(melhorResultado.confianca)}%)`);
    return melhorResultado;
}

/**
 * Encerra o worker do Tesseract (liberar memória)
 */
async function encerrar() {
    if (worker) {
        await worker.terminate();
        worker = null;
        console.log('🔤 Tesseract OCR encerrado');
    }
}

module.exports = {
    resolverCaptcha,
    encerrar
};
