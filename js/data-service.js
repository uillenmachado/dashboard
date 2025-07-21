/**
 * Dashboard Analítico - Serviço de Dados
 * Responsável pela leitura de arquivos Excel e processamento dos dados
 */

class DataService {
    constructor() {
        this.rawData = null;
        this.processedData = null;
        
        // Column mapping for the Excel file
        this.columnMapping = {
            'Número': 'numero',
            'Razão Social': 'razaoSocial',
            'Data de Emissão': 'dataEmissao',
            'Valor da Nota': 'valorNota',
            'ISS': 'iss',
            'Valor Líquido': 'valorLiquido',
            'ESTADO': 'estado',
            'CIDADE': 'cidade',
            'CNPJ': 'cnpj',
            'STATUS DE PAGAMENTO': 'statusPagamento',
            'Data de Pagamento': 'dataPagamento',
            'Dias para Pagamento': 'diasPagamento',
            'Status Conciliado': 'statusConciliado',
            'Recebido': 'recebido',
            'Previsão de Recebimento': 'previsaoRecebimento'
        };
    }

    /**
     * Carrega arquivo Excel e processa os dados
     * @param {File} file - Arquivo Excel
     * @returns {Array} Dados processados
     */
    async loadExcelFile(file) {
        try {
            console.log('📖 Lendo arquivo Excel:', file.name);
            
            const arrayBuffer = await this.fileToArrayBuffer(file);
            const workbook = XLSX.read(arrayBuffer, { type: 'array' });
            
            // Try to find the "Notas Fiscais" sheet
            let sheetName = 'Notas Fiscais';
            if (!workbook.Sheets[sheetName]) {
                // If not found, use the first sheet
                sheetName = workbook.SheetNames[0];
                console.log(`⚠️ Aba "Notas Fiscais" não encontrada, usando: ${sheetName}`);
            }
            
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet);
            
            console.log(`📊 ${jsonData.length} registros encontrados`);
            
            // Process and validate data
            const processedData = this.processData(jsonData);
            
            this.rawData = jsonData;
            this.processedData = processedData;
            
            return processedData;
            
        } catch (error) {
            console.error('❌ Erro ao processar arquivo:', error);
            throw new Error('Erro ao processar arquivo Excel: ' + error.message);
        }
    }

    /**
     * Converte File para ArrayBuffer
     * @param {File} file 
     * @returns {Promise<ArrayBuffer>}
     */
    fileToArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Processa e valida os dados do Excel
     * @param {Array} rawData 
     * @returns {Array} Dados processados
     */
    processData(rawData) {
        console.log('🔄 Processando dados...');
        
        const processedData = rawData.map((row, index) => {
            try {
                const processedRow = {};
                
                // Map columns to standardized names
                Object.keys(this.columnMapping).forEach(originalCol => {
                    const standardCol = this.columnMapping[originalCol];
                    processedRow[standardCol] = row[originalCol];
                });
                
                // Process dates
                processedRow.dataEmissao = this.parseDate(processedRow.dataEmissao);
                processedRow.dataPagamento = this.parseDate(processedRow.dataPagamento);
                processedRow.previsaoRecebimento = this.parseDate(processedRow.previsaoRecebimento);
                
                // Process numeric values
                processedRow.valorNota = this.parseNumber(processedRow.valorNota);
                processedRow.iss = this.parseNumber(processedRow.iss);
                processedRow.valorLiquido = this.parseNumber(processedRow.valorLiquido);
                processedRow.diasPagamento = this.parseNumber(processedRow.diasPagamento);
                
                // Calculate additional fields
                processedRow.diasEmAberto = this.calculateDaysOpen(processedRow);
                processedRow.agingBucket = this.calculateAgingBucket(processedRow.diasEmAberto);
                processedRow.mesEmissao = this.getMonthYear(processedRow.dataEmissao);
                
                // Clean and standardize text fields
                processedRow.estado = this.cleanText(processedRow.estado);
                processedRow.cidade = this.cleanText(processedRow.cidade);
                processedRow.cnpj = this.cleanCNPJ(processedRow.cnpj);
                processedRow.statusConciliado = this.cleanText(processedRow.statusConciliado);
                processedRow.recebido = this.cleanText(processedRow.recebido);
                processedRow.statusPagamento = this.cleanText(processedRow.statusPagamento);
                
                // Add row index for reference
                processedRow.rowIndex = index;
                
                return processedRow;
                
            } catch (error) {
                console.warn(`⚠️ Erro ao processar linha ${index + 1}:`, error);
                return null;
            }
        }).filter(row => row !== null);
        
        console.log(`✅ ${processedData.length} registros processados com sucesso`);
        
        // Validate required fields
        this.validateData(processedData);
        
        return processedData;
    }

    /**
     * Converte valor para Date
     * @param {*} value 
     * @returns {Date|null}
     */
    parseDate(value) {
        if (!value) return null;
        
        if (value instanceof Date) return value;
        
        if (typeof value === 'number') {
            // Excel date serial number
            return new Date((value - 25569) * 86400 * 1000);
        }
        
        if (typeof value === 'string') {
            const date = new Date(value);
            return isNaN(date.getTime()) ? null : date;
        }
        
        return null;
    }

    /**
     * Converte valor para número
     * @param {*} value 
     * @returns {number}
     */
    parseNumber(value) {
        if (typeof value === 'number') return value;
        if (!value) return 0;
        
        const num = parseFloat(String(value).replace(/[^\d.-]/g, ''));
        return isNaN(num) ? 0 : num;
    }

    /**
     * Limpa texto removendo espaços extras
     * @param {*} value 
     * @returns {string}
     */
    cleanText(value) {
        if (!value) return '';
        return String(value).trim();
    }

    /**
     * Limpa e formata CNPJ
     * @param {*} value 
     * @returns {string}
     */
    cleanCNPJ(value) {
        if (!value) return '';
        return String(value).replace(/[^\d]/g, '').replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    }

    /**
     * Calcula dias em aberto
     * @param {Object} row 
     * @returns {number}
     */
    calculateDaysOpen(row) {
        if (row.recebido === 'Recebido') return 0;
        
        const today = new Date();
        const emissionDate = row.dataEmissao;
        
        if (!emissionDate) return 0;
        
        const diffTime = today - emissionDate;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        return Math.max(0, diffDays);
    }

    /**
     * Calcula bucket de aging
     * @param {number} daysOpen 
     * @returns {string}
     */
    calculateAgingBucket(daysOpen) {
        if (daysOpen <= 30) return '0-30';
        if (daysOpen <= 60) return '31-60';
        if (daysOpen <= 90) return '61-90';
        return '90+';
    }

    /**
     * Extrai mês/ano da data
     * @param {Date} date 
     * @returns {string}
     */
    getMonthYear(date) {
        if (!date) return '';
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    /**
     * Valida dados processados
     * @param {Array} data 
     */
    validateData(data) {
        if (!data || data.length === 0) {
            throw new Error('Nenhum dado válido encontrado no arquivo');
        }

        const requiredFields = ['valorNota', 'valorLiquido', 'dataEmissao'];
        const invalidRows = [];

        data.forEach((row, index) => {
            const missingFields = requiredFields.filter(field => 
                row[field] === null || row[field] === undefined || 
                (typeof row[field] === 'number' && isNaN(row[field]))
            );

            if (missingFields.length > 0) {
                invalidRows.push({ index: index + 1, missingFields });
            }
        });

        if (invalidRows.length > 0) {
            console.warn('⚠️ Linhas com dados inválidos:', invalidRows);
        }

        console.log('✅ Validação de dados concluída');
    }

    /**
     * Obtém estatísticas básicas dos dados
     * @param {Array} data 
     * @returns {Object}
     */
    getDataStatistics(data) {
        if (!data || data.length === 0) return {};

        const stats = {
            totalRecords: data.length,
            dateRange: {
                min: null,
                max: null
            },
            financials: {
                totalBruto: 0,
                totalLiquido: 0,
                totalISS: 0
            },
            status: {},
            states: new Set(),
            cnpjs: new Set()
        };

        data.forEach(row => {
            // Date range
            if (row.dataEmissao) {
                if (!stats.dateRange.min || row.dataEmissao < stats.dateRange.min) {
                    stats.dateRange.min = row.dataEmissao;
                }
                if (!stats.dateRange.max || row.dataEmissao > stats.dateRange.max) {
                    stats.dateRange.max = row.dataEmissao;
                }
            }

            // Financials
            stats.financials.totalBruto += row.valorNota || 0;
            stats.financials.totalLiquido += row.valorLiquido || 0;
            stats.financials.totalISS += row.iss || 0;

            // Status distribution
            const status = row.statusConciliado || 'Não informado';
            stats.status[status] = (stats.status[status] || 0) + 1;

            // Unique values
            if (row.estado) stats.states.add(row.estado);
            if (row.cnpj) stats.cnpjs.add(row.cnpj);
        });

        // Convert sets to arrays
        stats.states = Array.from(stats.states).sort();
        stats.cnpjs = Array.from(stats.cnpjs).sort();

        return stats;
    }
}

// Initialize and export
window.DataService = new DataService();

