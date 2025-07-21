/**
 * Dashboard Analítico - Gerenciador de Cards KPI
 * Responsável pela renderização e atualização dos cards de KPIs
 */

class KPICards {
    constructor() {
        this.kpiContainer = null;
        this.currentData = null;
        
        // KPI definitions with calculation functions
        this.kpiDefinitions = [
            {
                id: 'faturamento-bruto',
                title: 'Faturamento Bruto Total',
                icon: 'dollar-sign',
                format: 'currency',
                calculate: (data) => data.reduce((sum, row) => sum + (row.valorNota || 0), 0)
            },
            {
                id: 'faturamento-liquido',
                title: 'Faturamento Líquido Total',
                icon: 'trending-up',
                format: 'currency',
                calculate: (data) => data.reduce((sum, row) => sum + (row.valorLiquido || 0), 0)
            },
            {
                id: 'numero-notas',
                title: 'Nº de Notas',
                icon: 'file-text',
                format: 'number',
                calculate: (data) => data.length
            },
            {
                id: 'ticket-medio-bruto',
                title: 'Ticket Médio Bruto',
                icon: 'calculator',
                format: 'currency',
                calculate: (data) => {
                    const total = data.reduce((sum, row) => sum + (row.valorNota || 0), 0);
                    return data.length > 0 ? total / data.length : 0;
                }
            },
            {
                id: 'ticket-medio-liquido',
                title: 'Ticket Médio Líquido',
                icon: 'calculator',
                format: 'currency',
                calculate: (data) => {
                    const total = data.reduce((sum, row) => sum + (row.valorLiquido || 0), 0);
                    return data.length > 0 ? total / data.length : 0;
                }
            },
            {
                id: 'top5-cnpjs',
                title: 'Top 5 CNPJs - % Receita',
                icon: 'award',
                format: 'percentage',
                calculate: (data) => {
                    const cnpjRevenue = {};
                    const totalRevenue = data.reduce((sum, row) => sum + (row.valorLiquido || 0), 0);
                    
                    data.forEach(row => {
                        const cnpj = row.cnpj || 'Não informado';
                        cnpjRevenue[cnpj] = (cnpjRevenue[cnpj] || 0) + (row.valorLiquido || 0);
                    });
                    
                    const top5Revenue = Object.values(cnpjRevenue)
                        .sort((a, b) => b - a)
                        .slice(0, 5)
                        .reduce((sum, revenue) => sum + revenue, 0);
                    
                    return totalRevenue > 0 ? (top5Revenue / totalRevenue) * 100 : 0;
                }
            },
            {
                id: 'valor-recebido',
                title: 'Valor Recebido',
                icon: 'check-circle',
                format: 'currency',
                calculate: (data) => data
                    .filter(row => row.recebido === 'Recebido')
                    .reduce((sum, row) => sum + (row.valorLiquido || 0), 0)
            },
            {
                id: 'valor-em-aberto',
                title: 'Valor em Aberto',
                icon: 'clock',
                format: 'currency',
                calculate: (data) => data
                    .filter(row => row.recebido === 'Em aberto')
                    .reduce((sum, row) => sum + (row.valorLiquido || 0), 0)
            },
            {
                id: 'percentual-recebido',
                title: '% Recebido',
                icon: 'percent',
                format: 'percentage',
                calculate: (data) => {
                    const totalBruto = data.reduce((sum, row) => sum + (row.valorNota || 0), 0);
                    const valorRecebido = data
                        .filter(row => row.recebido === 'Recebido')
                        .reduce((sum, row) => sum + (row.valorLiquido || 0), 0);
                    return totalBruto > 0 ? (valorRecebido / totalBruto) * 100 : 0;
                }
            },
            {
                id: 'dso',
                title: 'DSO (Dias Médios p/ Receber)',
                icon: 'calendar',
                format: 'days',
                calculate: (data) => {
                    const receivedData = data.filter(row => 
                        row.recebido === 'Recebido' && row.diasPagamento > 0
                    );
                    if (receivedData.length === 0) return 0;
                    
                    const totalDays = receivedData.reduce((sum, row) => sum + (row.diasPagamento || 0), 0);
                    return totalDays / receivedData.length;
                }
            },
            {
                id: 'notas-prazo',
                title: '% Notas Pagas no Prazo',
                icon: 'check',
                format: 'percentage',
                calculate: (data) => {
                    const totalNotas = data.length;
                    const notasPrazo = data.filter(row => row.statusConciliado === 'Pago no Prazo').length;
                    return totalNotas > 0 ? (notasPrazo / totalNotas) * 100 : 0;
                }
            },
            {
                id: 'notas-atraso',
                title: '% Notas Pagas com Atraso',
                icon: 'alert-triangle',
                format: 'percentage',
                calculate: (data) => {
                    const totalNotas = data.length;
                    const notasAtraso = data.filter(row => row.statusConciliado === 'Pago com Atraso').length;
                    return totalNotas > 0 ? (notasAtraso / totalNotas) * 100 : 0;
                }
            },
            {
                id: 'notas-antecipadas',
                title: '% Notas Antecipadas',
                icon: 'zap',
                format: 'percentage',
                calculate: (data) => {
                    const totalNotas = data.length;
                    const notasAntecipadas = data.filter(row => row.statusConciliado === 'Pago Antecipado').length;
                    return totalNotas > 0 ? (notasAntecipadas / totalNotas) * 100 : 0;
                }
            },
            {
                id: 'valor-antecipado',
                title: 'Valor Antecipado',
                icon: 'fast-forward',
                format: 'currency',
                calculate: (data) => data
                    .filter(row => row.statusConciliado === 'Pago Antecipado')
                    .reduce((sum, row) => sum + (row.valorLiquido || 0), 0)
            },
            {
                id: 'atraso-medio',
                title: 'Atraso Médio - Notas Atrasadas',
                icon: 'clock',
                format: 'days',
                calculate: (data) => {
                    const atrasadas = data.filter(row => 
                        row.statusConciliado === 'Pago com Atraso' && row.diasPagamento > 0
                    );
                    if (atrasadas.length === 0) return 0;
                    
                    const totalDias = atrasadas.reduce((sum, row) => sum + (row.diasPagamento || 0), 0);
                    return totalDias / atrasadas.length;
                }
            },
            {
                id: 'previsao-30d',
                title: 'Previsão de Recebimento (≤ 30d)',
                icon: 'calendar-days',
                format: 'currency',
                calculate: (data) => {
                    const hoje = new Date();
                    const em30Dias = new Date(hoje.getTime() + (30 * 24 * 60 * 60 * 1000));
                    
                    return data
                        .filter(row => 
                            row.recebido === 'Em aberto' && 
                            row.previsaoRecebimento && 
                            row.previsaoRecebimento <= em30Dias
                        )
                        .reduce((sum, row) => sum + (row.valorLiquido || 0), 0);
                }
            },
            {
                id: 'aging-0-30',
                title: 'Aging 0-30',
                icon: 'circle',
                format: 'currency',
                calculate: (data) => data
                    .filter(row => row.recebido === 'Em aberto' && row.agingBucket === '0-30')
                    .reduce((sum, row) => sum + (row.valorLiquido || 0), 0)
            },
            {
                id: 'aging-31-60',
                title: 'Aging 31-60',
                icon: 'circle',
                format: 'currency',
                calculate: (data) => data
                    .filter(row => row.recebido === 'Em aberto' && row.agingBucket === '31-60')
                    .reduce((sum, row) => sum + (row.valorLiquido || 0), 0)
            },
            {
                id: 'aging-61-90',
                title: 'Aging 61-90',
                icon: 'circle',
                format: 'currency',
                calculate: (data) => data
                    .filter(row => row.recebido === 'Em aberto' && row.agingBucket === '61-90')
                    .reduce((sum, row) => sum + (row.valorLiquido || 0), 0)
            },
            {
                id: 'aging-90-plus',
                title: 'Aging 90+',
                icon: 'alert-circle',
                format: 'currency',
                calculate: (data) => data
                    .filter(row => row.recebido === 'Em aberto' && row.agingBucket === '90+')
                    .reduce((sum, row) => sum + (row.valorLiquido || 0), 0)
            },
            {
                id: 'notas-90-plus',
                title: 'Notas Abertas > 90 dias (#)',
                icon: 'alert-triangle',
                format: 'number',
                calculate: (data) => data
                    .filter(row => row.recebido === 'Em aberto' && row.diasEmAberto > 90)
                    .length
            },
            {
                id: 'maior-atraso',
                title: 'Maior Atraso Individual',
                icon: 'alert-octagon',
                format: 'days',
                calculate: (data) => {
                    const diasEmAberto = data
                        .filter(row => row.recebido === 'Em aberto')
                        .map(row => row.diasEmAberto || 0);
                    return diasEmAberto.length > 0 ? Math.max(...diasEmAberto) : 0;
                }
            },
            {
                id: 'iss-total',
                title: 'ISS Retido Total',
                icon: 'receipt',
                format: 'currency',
                calculate: (data) => data.reduce((sum, row) => sum + (row.iss || 0), 0)
            },
            {
                id: 'iss-percentual',
                title: 'ISS Retido % sobre Bruto',
                icon: 'percent',
                format: 'percentage',
                calculate: (data) => {
                    const totalBruto = data.reduce((sum, row) => sum + (row.valorNota || 0), 0);
                    const totalISS = data.reduce((sum, row) => sum + (row.iss || 0), 0);
                    return totalBruto > 0 ? (totalISS / totalBruto) * 100 : 0;
                }
            },
            {
                id: 'iss-medio',
                title: 'ISS Retido médio por NF',
                icon: 'calculator',
                format: 'currency',
                calculate: (data) => {
                    const totalISS = data.reduce((sum, row) => sum + (row.iss || 0), 0);
                    return data.length > 0 ? totalISS / data.length : 0;
                }
            },
            {
                id: 'sem-status',
                title: 'Linhas sem Status de Pagamento',
                icon: 'help-circle',
                format: 'number',
                calculate: (data) => data
                    .filter(row => !row.statusPagamento || row.statusPagamento.trim() === '')
                    .length
            }
        ];
    }

    /**
     * Inicializa o container de KPIs
     */
    initialize() {
        this.kpiContainer = document.getElementById('kpiGrid');
        if (!this.kpiContainer) {
            console.error('❌ Container de KPIs não encontrado');
            return;
        }
        
        console.log('📊 KPI Cards inicializados');
    }

    /**
     * Atualiza todos os KPIs com novos dados
     * @param {Array} data - Dados para cálculo dos KPIs
     */
    updateKPIs(data) {
        if (!this.kpiContainer) {
            this.initialize();
        }
        
        this.currentData = data;
        this.renderKPICards();
        
        console.log(`📊 KPIs atualizados com ${data.length} registros`);
    }

    /**
     * Renderiza todos os cards de KPI
     */
    renderKPICards() {
        if (!this.kpiContainer || !this.currentData) return;

        // Clear existing cards
        this.kpiContainer.innerHTML = '';

        // Create cards for each KPI
        this.kpiDefinitions.forEach(kpi => {
            const cardElement = this.createKPICard(kpi);
            this.kpiContainer.appendChild(cardElement);
        });

        // Initialize Lucide icons for new cards
        lucide.createIcons();
    }

    /**
     * Cria um card de KPI individual
     * @param {Object} kpi - Definição do KPI
     * @returns {HTMLElement}
     */
    createKPICard(kpi) {
        const value = kpi.calculate(this.currentData);
        const formattedValue = this.formatValue(value, kpi.format);
        const colorClass = this.getColorClass(kpi.id, value);

        const card = document.createElement('div');
        card.className = `card bg-base-100 shadow-lg kpi-card ${colorClass}`;
        card.innerHTML = `
            <div class="card-body p-4">
                <div class="flex items-start justify-between">
                    <div class="flex-1">
                        <h3 class="card-title text-sm font-medium text-base-content/70 mb-2">
                            ${kpi.title}
                        </h3>
                        <div class="text-2xl font-bold text-base-content">
                            ${formattedValue}
                        </div>
                    </div>
                    <div class="flex-shrink-0">
                        <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                            <i data-lucide="${kpi.icon}" class="w-5 h-5 text-primary"></i>
                        </div>
                    </div>
                </div>
                ${this.getKPIInsight(kpi.id, value)}
            </div>
        `;

        return card;
    }

    /**
     * Formata valor de acordo com o tipo
     * @param {number} value - Valor a ser formatado
     * @param {string} format - Tipo de formatação
     * @returns {string}
     */
    formatValue(value, format) {
        if (value === null || value === undefined || isNaN(value)) {
            return '-';
        }

        switch (format) {
            case 'currency':
                return new Intl.NumberFormat('pt-BR', {
                    style: 'currency',
                    currency: 'BRL',
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                }).format(value);

            case 'percentage':
                return new Intl.NumberFormat('pt-BR', {
                    style: 'percent',
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1
                }).format(value / 100);

            case 'number':
                return new Intl.NumberFormat('pt-BR').format(Math.round(value));

            case 'days':
                const days = Math.round(value);
                return `${days} ${days === 1 ? 'dia' : 'dias'}`;

            default:
                return value.toString();
        }
    }

    /**
     * Obtém classe de cor baseada no KPI e valor
     * @param {string} kpiId - ID do KPI
     * @param {number} value - Valor do KPI
     * @returns {string}
     */
    getColorClass(kpiId, value) {
        // Define color logic based on KPI type and value
        if (kpiId.includes('atraso') || kpiId.includes('90-plus') || kpiId === 'maior-atraso') {
            return value > 0 ? 'border-l-4 border-l-error' : 'border-l-4 border-l-success';
        }
        
        if (kpiId.includes('recebido') || kpiId.includes('prazo')) {
            return 'border-l-4 border-l-success';
        }
        
        if (kpiId.includes('aberto') || kpiId.includes('sem-status')) {
            return value > 0 ? 'border-l-4 border-l-warning' : 'border-l-4 border-l-success';
        }
        
        return 'border-l-4 border-l-primary';
    }

    /**
     * Obtém insight adicional para o KPI
     * @param {string} kpiId - ID do KPI
     * @param {number} value - Valor do KPI
     * @returns {string}
     */
    getKPIInsight(kpiId, value) {
        let insight = '';
        
        switch (kpiId) {
            case 'dso':
                if (value > 45) {
                    insight = '<div class="text-xs text-warning mt-1">⚠️ DSO acima da média</div>';
                } else if (value < 30) {
                    insight = '<div class="text-xs text-success mt-1">✅ DSO excelente</div>';
                }
                break;
                
            case 'notas-atraso':
                if (value > 30) {
                    insight = '<div class="text-xs text-error mt-1">🚨 Alto índice de atraso</div>';
                } else if (value < 10) {
                    insight = '<div class="text-xs text-success mt-1">✅ Baixo índice de atraso</div>';
                }
                break;
                
            case 'aging-90-plus':
                if (value > 0) {
                    insight = '<div class="text-xs text-error mt-1">🚨 Atenção necessária</div>';
                }
                break;
                
            case 'percentual-recebido':
                if (value > 80) {
                    insight = '<div class="text-xs text-success mt-1">✅ Boa taxa de recebimento</div>';
                } else if (value < 60) {
                    insight = '<div class="text-xs text-warning mt-1">⚠️ Taxa baixa de recebimento</div>';
                }
                break;
        }
        
        return insight;
    }

    /**
     * Obtém dados de um KPI específico
     * @param {string} kpiId - ID do KPI
     * @returns {Object}
     */
    getKPIData(kpiId) {
        const kpi = this.kpiDefinitions.find(k => k.id === kpiId);
        if (!kpi || !this.currentData) return null;

        const value = kpi.calculate(this.currentData);
        return {
            id: kpiId,
            title: kpi.title,
            value: value,
            formattedValue: this.formatValue(value, kpi.format),
            format: kpi.format
        };
    }

    /**
     * Obtém todos os dados de KPIs
     * @returns {Array}
     */
    getAllKPIData() {
        return this.kpiDefinitions.map(kpi => this.getKPIData(kpi.id));
    }

    /**
     * Exporta dados de KPIs para CSV
     * @returns {string}
     */
    exportKPIsToCSV() {
        const kpiData = this.getAllKPIData();
        const headers = ['KPI', 'Valor', 'Valor Formatado'];
        const rows = kpiData.map(kpi => [
            kpi.title,
            kpi.value,
            kpi.formattedValue
        ]);

        const csvContent = [headers, ...rows]
            .map(row => row.map(cell => `"${cell}"`).join(','))
            .join('\n');

        return csvContent;
    }
}

// Initialize and export
window.KPICards = new KPICards();

