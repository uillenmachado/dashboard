/**
 * Dashboard Analítico - Gerenciador de Gráficos
 * Responsável pela criação e atualização dos gráficos usando Chart.js
 */

class ChartsManager {
    constructor() {
        this.charts = {};
        this.chartConfigs = {};
        
        // Chart.js default configuration
        Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
        Chart.defaults.color = '#4b5563'; // Cinza escuro para texto
        Chart.defaults.borderColor = '#e5e7eb'; // Cinza claro para bordas
        Chart.defaults.backgroundColor = '#f3f4f6'; // Cinza claro para fundo
        
        // Register datalabels plugin globally
        Chart.register(ChartDataLabels);
    }

    /**
     * Inicializa todos os gráficos
     * @param {Array} data - Dados para os gráficos
     */
    initializeCharts(data) {
        console.log('📊 Inicializando gráficos...');
        
        try {
            this.createStatusChart(data);
            this.createAgingChart(data);
            this.createDSOChart(data);
            this.createRevenueUFChart(data);
            this.createRevenueOutstandingChart(data);
            
            console.log('✅ Gráficos inicializados com sucesso');
        } catch (error) {
            console.error('❌ Erro ao inicializar gráficos:', error);
        }
    }

    /**
     * Atualiza todos os gráficos com novos dados
     * @param {Array} data - Novos dados
     */
    updateCharts(data) {
        console.log('🔄 Atualizando gráficos...');
        
        try {
            this.updateStatusChart(data);
            this.updateAgingChart(data);
            this.updateDSOChart(data);
            this.updateRevenueUFChart(data);
            this.updateRevenueOutstandingChart(data);
            
            console.log('✅ Gráficos atualizados');
        } catch (error) {
            console.error('❌ Erro ao atualizar gráficos:', error);
        }
    }

    /**
     * Cria gráfico de Status Conciliado (Pie Chart)
     * @param {Array} data 
     */
    createStatusChart(data) {
        const ctx = document.getElementById('statusChart');
        if (!ctx) return;

        const statusData = this.processStatusData(data);
        
        this.chartConfigs.statusChart = {
            type: 'pie',
            data: {
                labels: statusData.labels,
                datasets: [{
                    data: statusData.values,
                    backgroundColor: [
                        '#22c55e', // Success (Pago no Prazo) - Verde
                        '#f59e0b', // Warning (Pago com Atraso) - Amarelo
                        '#3b82f6', // Info (Pago Antecipado) - Azul
                        '#ef4444'  // Error (Não Pago) - Vermelho
                    ],
                    borderWidth: 2,
                    borderColor: '#ffffff' // Borda branca
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            padding: 20,
                            usePointStyle: true
                        }
                    },
                    datalabels: {
                        color: '#ffffff',
                        font: {
                            weight: 'bold',
                            size: 12
                        },
                        formatter: (value, context) => {
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = ((value / total) * 100).toFixed(1);
                            return `${percentage}%`;
                        }
                    }
                }
            }
        };

        this.charts.statusChart = new Chart(ctx, this.chartConfigs.statusChart);
    }

    /**
     * Cria gráfico de Aging (Bar Chart)
     * @param {Array} data 
     */
    createAgingChart(data) {
        const ctx = document.getElementById('agingChart');
        if (!ctx) return;

        const agingData = this.processAgingData(data);
        
        this.chartConfigs.agingChart = {
            type: 'bar',
            data: {
                labels: agingData.labels,
                datasets: [{
                    label: 'Valor em Aberto (R$)',
                    data: agingData.values,
                    backgroundColor: [
                        '#22c55e', // 0-30 dias - Verde
                        '#f59e0b', // 31-60 dias - Amarelo
                        '#ef4444', // 61-90 dias - Vermelho
                        '#991b1b'  // 90+ dias - Vermelho escuro
                    ],
                    borderColor: [
                        '#22c55e',
                        '#f59e0b',
                        '#ef4444',
                        '#991b1b'
                    ],
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: function(value) {
                                return 'R$ ' + value.toLocaleString('pt-BR');
                            }
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    datalabels: {
                        anchor: 'end',
                        align: 'top',
                        color: '#4b5563',
                        font: {
                            weight: 'bold',
                            size: 10
                        },
                        formatter: (value) => {
                            return 'R$ ' + value.toLocaleString('pt-BR', { 
                                minimumFractionDigits: 0,
                                maximumFractionDigits: 0 
                            });
                        }
                    }
                }
            }
        };

        this.charts.agingChart = new Chart(ctx, this.chartConfigs.agingChart);
    }

    /**
     * Cria gráfico de DSO Mensal (Line Chart)
     * @param {Array} data 
     */
    createDSOChart(data) {
        const ctx = document.getElementById('dsoChart');
        if (!ctx) return;

        const dsoData = this.processDSOData(data);
        
        this.chartConfigs.dsoChart = {
            type: 'line',
            data: {
                labels: dsoData.labels,
                datasets: [{
                    label: 'DSO (dias)',
                    data: dsoData.values,
                    borderColor: '#3b82f6', // Azul vibrante
                    backgroundColor: 'rgba(59, 130, 246, 0.1)', // Azul com transparência
                    borderWidth: 3,
                    fill: true,
                    tension: 0.4,
                    pointBackgroundColor: '#3b82f6',
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 2,
                    pointRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Dias'
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'Mês'
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    datalabels: {
                        backgroundColor: '#3b82f6',
                        borderColor: '#ffffff',
                        borderRadius: 4,
                        borderWidth: 1,
                        color: '#ffffff',
                        font: {
                            weight: 'bold',
                            size: 10
                        },
                        padding: 4,
                        formatter: (value) => {
                            return Math.round(value) + 'd';
                        }
                    }
                }
            }
        };

        this.charts.dsoChart = new Chart(ctx, this.chartConfigs.dsoChart);
    }

    /**
     * Cria gráfico de Receita por UF (Column Chart)
     * @param {Array} data 
     */
    createRevenueUFChart(data) {
        const ctx = document.getElementById('revenueUfChart');
        if (!ctx) return;

        const revenueData = this.processRevenueUFData(data);
        
        this.chartConfigs.revenueUfChart = {
            type: 'bar',
            data: {
                labels: revenueData.labels,
                datasets: [{
                    label: 'Receita Líquida (R$)',
                    data: revenueData.values,
                    backgroundColor: '#10b981', // Verde esmeralda
                    borderColor: '#10b981',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                scales: {
                    x: {
                        beginAtZero: true,
                        ticks: {
                            callback: function(value) {
                                return 'R$ ' + value.toLocaleString('pt-BR');
                            }
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    datalabels: {
                        anchor: 'end',
                        align: 'right',
                        color: '#4b5563',
                        font: {
                            weight: 'bold',
                            size: 10
                        },
                        formatter: (value) => {
                            return 'R$ ' + value.toLocaleString('pt-BR', { 
                                minimumFractionDigits: 0,
                                maximumFractionDigits: 0 
                            });
                        }
                    }
                }
            }
        };

        this.charts.revenueUfChart = new Chart(ctx, this.chartConfigs.revenueUfChart);
    }

    /**
     * Cria gráfico de Receita vs Valor em Aberto (Column Chart)
     * @param {Array} data 
     */
    createRevenueOutstandingChart(data) {
        const ctx = document.getElementById('revenueOutstandingChart');
        if (!ctx) return;

        const comparisonData = this.processRevenueOutstandingData(data);
        
        this.chartConfigs.revenueOutstandingChart = {
            type: 'bar',
            data: {
                labels: comparisonData.labels,
                datasets: [{
                    label: 'Valor Recebido',
                    data: comparisonData.received,
                    backgroundColor: '#22c55e', // Verde
                    borderColor: '#22c55e',
                    borderWidth: 1
                }, {
                    label: 'Valor em Aberto',
                    data: comparisonData.outstanding,
                    backgroundColor: '#f59e0b', // Amarelo
                    borderColor: '#f59e0b',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        stacked: false,
                        ticks: {
                            callback: function(value) {
                                return 'R$ ' + value.toLocaleString('pt-BR');
                            }
                        }
                    },
                    x: {
                        stacked: false
                    }
                },
                plugins: {
                    legend: {
                        position: 'top'
                    },
                    datalabels: {
                        display: false // Too crowded for this chart
                    }
                }
            }
        };

        this.charts.revenueOutstandingChart = new Chart(ctx, this.chartConfigs.revenueOutstandingChart);
    }

    /**
     * Processa dados para gráfico de status
     * @param {Array} data 
     * @returns {Object}
     */
    processStatusData(data) {
        const statusCount = {};
        
        data.forEach(row => {
            const status = row.statusConciliado || 'Não informado';
            statusCount[status] = (statusCount[status] || 0) + 1;
        });

        return {
            labels: Object.keys(statusCount),
            values: Object.values(statusCount)
        };
    }

    /**
     * Processa dados para gráfico de aging
     * @param {Array} data 
     * @returns {Object}
     */
    processAgingData(data) {
        const agingBuckets = {
            '0-30': 0,
            '31-60': 0,
            '61-90': 0,
            '90+': 0
        };

        data.forEach(row => {
            if (row.recebido === 'Em aberto') {
                const bucket = row.agingBucket || '0-30';
                agingBuckets[bucket] += row.valorLiquido || 0;
            }
        });

        return {
            labels: Object.keys(agingBuckets),
            values: Object.values(agingBuckets)
        };
    }

    /**
     * Processa dados para gráfico de DSO
     * @param {Array} data 
     * @returns {Object}
     */
    processDSOData(data) {
        const monthlyData = {};

        data.forEach(row => {
            if (row.mesEmissao && row.diasPagamento && row.recebido === 'Recebido') {
                if (!monthlyData[row.mesEmissao]) {
                    monthlyData[row.mesEmissao] = {
                        totalDays: 0,
                        count: 0
                    };
                }
                monthlyData[row.mesEmissao].totalDays += row.diasPagamento;
                monthlyData[row.mesEmissao].count += 1;
            }
        });

        const sortedMonths = Object.keys(monthlyData).sort();
        const dsoValues = sortedMonths.map(month => {
            const data = monthlyData[month];
            return data.count > 0 ? data.totalDays / data.count : 0;
        });

        return {
            labels: sortedMonths.map(month => {
                const [year, monthNum] = month.split('-');
                const date = new Date(year, monthNum - 1);
                return date.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' });
            }),
            values: dsoValues
        };
    }

    /**
     * Processa dados para gráfico de receita por UF
     * @param {Array} data 
     * @returns {Object}
     */
    processRevenueUFData(data) {
        const ufRevenue = {};

        data.forEach(row => {
            const uf = row.estado || 'Não informado';
            ufRevenue[uf] = (ufRevenue[uf] || 0) + (row.valorLiquido || 0);
        });

        // Sort by revenue (descending)
        const sortedUFs = Object.entries(ufRevenue)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10); // Top 10

        return {
            labels: sortedUFs.map(([uf]) => uf),
            values: sortedUFs.map(([, revenue]) => revenue)
        };
    }

    /**
     * Processa dados para gráfico de receita vs valor em aberto
     * @param {Array} data 
     * @returns {Object}
     */
    processRevenueOutstandingData(data) {
        const monthlyData = {};

        data.forEach(row => {
            const month = row.mesEmissao || 'Não informado';
            if (!monthlyData[month]) {
                monthlyData[month] = {
                    received: 0,
                    outstanding: 0
                };
            }

            if (row.recebido === 'Recebido') {
                monthlyData[month].received += row.valorLiquido || 0;
            } else {
                monthlyData[month].outstanding += row.valorLiquido || 0;
            }
        });

        const sortedMonths = Object.keys(monthlyData).sort();

        return {
            labels: sortedMonths.map(month => {
                if (month === 'Não informado') return month;
                const [year, monthNum] = month.split('-');
                const date = new Date(year, monthNum - 1);
                return date.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' });
            }),
            received: sortedMonths.map(month => monthlyData[month].received),
            outstanding: sortedMonths.map(month => monthlyData[month].outstanding)
        };
    }

    /**
     * Atualiza gráfico de status
     * @param {Array} data 
     */
    updateStatusChart(data) {
        if (!this.charts.statusChart) return;
        
        const statusData = this.processStatusData(data);
        this.charts.statusChart.data.labels = statusData.labels;
        this.charts.statusChart.data.datasets[0].data = statusData.values;
        this.charts.statusChart.update();
    }

    /**
     * Atualiza gráfico de aging
     * @param {Array} data 
     */
    updateAgingChart(data) {
        if (!this.charts.agingChart) return;
        
        const agingData = this.processAgingData(data);
        this.charts.agingChart.data.datasets[0].data = agingData.values;
        this.charts.agingChart.update();
    }

    /**
     * Atualiza gráfico de DSO
     * @param {Array} data 
     */
    updateDSOChart(data) {
        if (!this.charts.dsoChart) return;
        
        const dsoData = this.processDSOData(data);
        this.charts.dsoChart.data.labels = dsoData.labels;
        this.charts.dsoChart.data.datasets[0].data = dsoData.values;
        this.charts.dsoChart.update();
    }

    /**
     * Atualiza gráfico de receita por UF
     * @param {Array} data 
     */
    updateRevenueUFChart(data) {
        if (!this.charts.revenueUfChart) return;
        
        const revenueData = this.processRevenueUFData(data);
        this.charts.revenueUfChart.data.labels = revenueData.labels;
        this.charts.revenueUfChart.data.datasets[0].data = revenueData.values;
        this.charts.revenueUfChart.update();
    }

    /**
     * Atualiza gráfico de receita vs valor em aberto
     * @param {Array} data 
     */
    updateRevenueOutstandingChart(data) {
        if (!this.charts.revenueOutstandingChart) return;
        
        const comparisonData = this.processRevenueOutstandingData(data);
        this.charts.revenueOutstandingChart.data.labels = comparisonData.labels;
        this.charts.revenueOutstandingChart.data.datasets[0].data = comparisonData.received;
        this.charts.revenueOutstandingChart.data.datasets[1].data = comparisonData.outstanding;
        this.charts.revenueOutstandingChart.update();
    }

    /**
     * Destrói todos os gráficos
     */
    destroyCharts() {
        Object.values(this.charts).forEach(chart => {
            if (chart) chart.destroy();
        });
        this.charts = {};
    }
}

// Initialize and export
window.ChartsManager = new ChartsManager();