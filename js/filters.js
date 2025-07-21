/**
 * Dashboard Analítico - Gerenciador de Filtros
 * Responsável pela gestão de filtros e persistência no localStorage
 */

class FiltersManager {
    constructor() {
        this.originalData = null;
        this.currentFilters = {
            dateStart: null,
            dateEnd: null,
            estado: '',
            cnpj: '',
            status: []
        };
        
        this.filterElements = {
            startDate: null,
            endDate: null,
            ufFilter: null,
            cnpjFilter: null,
            statusFilters: null
        };
        
        // Bind methods
        this.initializeFilters = this.initializeFilters.bind(this);
        this.applyFilters = this.applyFilters.bind(this);
        this.clearFilters = this.clearFilters.bind(this);
    }

    /**
     * Inicializa os filtros com os dados fornecidos
     * @param {Array} data - Dados originais
     */
    initializeFilters(data) {
        this.originalData = data;
        
        // Get filter elements
        this.filterElements = {
            startDate: document.getElementById('startDate'),
            endDate: document.getElementById('endDate'),
            ufFilter: document.getElementById('ufFilter'),
            cnpjFilter: document.getElementById('cnpjFilter'),
            statusFilters: document.getElementById('statusFilters')
        };
        
        // Populate filter options
        this.populateUFFilter(data);
        this.populateCNPJFilter(data);
        this.populateStatusFilter(data);
        
        // Load saved filters
        this.loadSavedFilters();
        
        // Setup event listeners
        this.setupFilterEventListeners();
        
        console.log('🔍 Filtros inicializados');
    }

    /**
     * Popula o filtro de UF
     * @param {Array} data 
     */
    populateUFFilter(data) {
        const ufFilter = this.filterElements.ufFilter;
        if (!ufFilter) return;

        // Get unique states
        const states = [...new Set(data.map(row => row.estado).filter(Boolean))].sort();
        
        // Clear existing options (except "Todos")
        ufFilter.innerHTML = '<option value="">Todos os Estados</option>';
        
        // Add state options
        states.forEach(state => {
            const option = document.createElement('option');
            option.value = state;
            option.textContent = state;
            ufFilter.appendChild(option);
        });
    }

    /**
     * Popula o filtro de CNPJ
     * @param {Array} data 
     */
    populateCNPJFilter(data) {
        const cnpjFilter = this.filterElements.cnpjFilter;
        if (!cnpjFilter) return;

        // Get unique CNPJs with company names
        const cnpjMap = new Map();
        data.forEach(row => {
            if (row.cnpj && row.razaoSocial) {
                cnpjMap.set(row.cnpj, row.razaoSocial);
            }
        });
        
        // Sort by company name
        const sortedCNPJs = Array.from(cnpjMap.entries()).sort((a, b) => a[1].localeCompare(b[1]));
        
        // Clear existing options
        cnpjFilter.innerHTML = '<option value="">Todos os CNPJs</option>';
        
        // Add CNPJ options
        sortedCNPJs.forEach(([cnpj, razaoSocial]) => {
            const option = document.createElement('option');
            option.value = cnpj;
            option.textContent = `${razaoSocial} (${cnpj})`;
            cnpjFilter.appendChild(option);
        });
    }

    /**
     * Popula o filtro de status
     * @param {Array} data 
     */
    populateStatusFilter(data) {
        const statusContainer = this.filterElements.statusFilters;
        if (!statusContainer) return;

        // Get unique status values
        const statusValues = [...new Set(data.map(row => row.statusConciliado).filter(Boolean))].sort();
        
        // Clear existing checkboxes
        statusContainer.innerHTML = '';
        
        // Add status checkboxes
        statusValues.forEach(status => {
            const checkboxDiv = document.createElement('div');
            checkboxDiv.className = 'form-control';
            
            const label = document.createElement('label');
            label.className = 'label cursor-pointer justify-start space-x-2';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'checkbox checkbox-sm';
            checkbox.value = status;
            checkbox.id = `status-${status.replace(/\s+/g, '-')}`;
            
            const span = document.createElement('span');
            span.className = 'label-text text-sm';
            span.textContent = status;
            
            label.appendChild(checkbox);
            label.appendChild(span);
            checkboxDiv.appendChild(label);
            statusContainer.appendChild(checkboxDiv);
        });
    }

    /**
     * Configura event listeners para os filtros
     */
    setupFilterEventListeners() {
        // UF filter change
        if (this.filterElements.ufFilter) {
            this.filterElements.ufFilter.addEventListener('change', (e) => {
                this.currentFilters.estado = e.target.value;
                this.autoApplyFilters();
            });
        }

        // CNPJ filter change
        if (this.filterElements.cnpjFilter) {
            this.filterElements.cnpjFilter.addEventListener('change', (e) => {
                this.currentFilters.cnpj = e.target.value;
                this.autoApplyFilters();
            });
        }

        // Status checkboxes change
        if (this.filterElements.statusFilters) {
            this.filterElements.statusFilters.addEventListener('change', (e) => {
                if (e.target.type === 'checkbox') {
                    this.updateStatusFilter();
                    this.autoApplyFilters();
                }
            });
        }
    }

    /**
     * Atualiza o filtro de status baseado nos checkboxes selecionados
     */
    updateStatusFilter() {
        const checkboxes = this.filterElements.statusFilters.querySelectorAll('input[type="checkbox"]:checked');
        this.currentFilters.status = Array.from(checkboxes).map(cb => cb.value);
    }

    /**
     * Atualiza filtro de data
     * @param {string} type - 'start' ou 'end'
     * @param {Date} date - Data selecionada
     */
    updateDateFilter(type, date) {
        if (type === 'start') {
            this.currentFilters.dateStart = date;
        } else if (type === 'end') {
            this.currentFilters.dateEnd = date;
        }
        this.autoApplyFilters();
    }

    /**
     * Aplica filtros automaticamente (com debounce)
     */
    autoApplyFilters() {
        // Clear existing timeout
        if (this.autoApplyTimeout) {
            clearTimeout(this.autoApplyTimeout);
        }
        
        // Set new timeout for debounced application
        this.autoApplyTimeout = setTimeout(() => {
            this.applyFilters();
        }, 300);
    }

    /**
     * Aplica os filtros aos dados
     */
    applyFilters() {
        if (!this.originalData) return;

        let filteredData = [...this.originalData];

        // Date range filter
        if (this.currentFilters.dateStart) {
            filteredData = filteredData.filter(row => 
                row.dataEmissao && row.dataEmissao >= this.currentFilters.dateStart
            );
        }

        if (this.currentFilters.dateEnd) {
            filteredData = filteredData.filter(row => 
                row.dataEmissao && row.dataEmissao <= this.currentFilters.dateEnd
            );
        }

        // Estado filter
        if (this.currentFilters.estado) {
            filteredData = filteredData.filter(row => 
                row.estado === this.currentFilters.estado
            );
        }

        // CNPJ filter
        if (this.currentFilters.cnpj) {
            filteredData = filteredData.filter(row => 
                row.cnpj === this.currentFilters.cnpj
            );
        }

        // Status filter
        if (this.currentFilters.status.length > 0) {
            filteredData = filteredData.filter(row => 
                this.currentFilters.status.includes(row.statusConciliado)
            );
        }

        // Save current filters
        this.saveFilters();

        // Update dashboard with filtered data
        if (window.DashboardApp) {
            window.DashboardApp.updateFilteredData(filteredData);
        }

        console.log(`🔍 Filtros aplicados: ${filteredData.length} de ${this.originalData.length} registros`);
    }

    /**
     * Limpa todos os filtros
     */
    clearFilters() {
        // Reset filter values
        this.currentFilters = {
            dateStart: null,
            dateEnd: null,
            estado: '',
            cnpj: '',
            status: []
        };

        // Reset UI elements
        if (this.filterElements.startDate) {
            this.filterElements.startDate.value = '';
            this.filterElements.startDate._flatpickr?.clear();
        }

        if (this.filterElements.endDate) {
            this.filterElements.endDate.value = '';
            this.filterElements.endDate._flatpickr?.clear();
        }

        if (this.filterElements.ufFilter) {
            this.filterElements.ufFilter.value = '';
        }

        if (this.filterElements.cnpjFilter) {
            this.filterElements.cnpjFilter.value = '';
        }

        // Uncheck all status checkboxes
        if (this.filterElements.statusFilters) {
            const checkboxes = this.filterElements.statusFilters.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = false);
        }

        // Clear saved filters
        localStorage.removeItem('dashboard-filters');

        // Apply cleared filters
        this.applyFilters();

        console.log('🧹 Filtros limpos');
    }

    /**
     * Salva filtros no localStorage
     */
    saveFilters() {
        const filtersToSave = {
            ...this.currentFilters,
            dateStart: this.currentFilters.dateStart?.toISOString(),
            dateEnd: this.currentFilters.dateEnd?.toISOString()
        };

        localStorage.setItem('dashboard-filters', JSON.stringify(filtersToSave));
    }

    /**
     * Carrega filtros salvos do localStorage
     */
    loadSavedFilters() {
        try {
            const savedFilters = localStorage.getItem('dashboard-filters');
            if (!savedFilters) return;

            const filters = JSON.parse(savedFilters);

            // Restore date filters
            if (filters.dateStart) {
                this.currentFilters.dateStart = new Date(filters.dateStart);
                if (this.filterElements.startDate && this.filterElements.startDate._flatpickr) {
                    this.filterElements.startDate._flatpickr.setDate(this.currentFilters.dateStart);
                }
            }

            if (filters.dateEnd) {
                this.currentFilters.dateEnd = new Date(filters.dateEnd);
                if (this.filterElements.endDate && this.filterElements.endDate._flatpickr) {
                    this.filterElements.endDate._flatpickr.setDate(this.currentFilters.dateEnd);
                }
            }

            // Restore other filters
            if (filters.estado && this.filterElements.ufFilter) {
                this.currentFilters.estado = filters.estado;
                this.filterElements.ufFilter.value = filters.estado;
            }

            if (filters.cnpj && this.filterElements.cnpjFilter) {
                this.currentFilters.cnpj = filters.cnpj;
                this.filterElements.cnpjFilter.value = filters.cnpj;
            }

            // Restore status filters
            if (filters.status && Array.isArray(filters.status)) {
                this.currentFilters.status = filters.status;
                
                if (this.filterElements.statusFilters) {
                    const checkboxes = this.filterElements.statusFilters.querySelectorAll('input[type="checkbox"]');
                    checkboxes.forEach(cb => {
                        cb.checked = filters.status.includes(cb.value);
                    });
                }
            }

            console.log('💾 Filtros salvos carregados');

        } catch (error) {
            console.warn('⚠️ Erro ao carregar filtros salvos:', error);
            localStorage.removeItem('dashboard-filters');
        }
    }

    /**
     * Obtém resumo dos filtros ativos
     * @returns {Object}
     */
    getActiveFiltersCount() {
        let count = 0;
        
        if (this.currentFilters.dateStart || this.currentFilters.dateEnd) count++;
        if (this.currentFilters.estado) count++;
        if (this.currentFilters.cnpj) count++;
        if (this.currentFilters.status.length > 0) count++;
        
        return count;
    }

    /**
     * Obtém dados filtrados atuais
     * @returns {Array}
     */
    getFilteredData() {
        return window.DashboardApp?.filteredData || this.originalData || [];
    }
}

// Initialize and export
window.FiltersManager = new FiltersManager();

