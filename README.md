# Dashboard Analítico — Notas Fiscais  
> **Arquivo único (`index.html`) – 100 % offline**

## Sumário
1. [Propósito](#propósito)  
2. [Principais Recursos](#principais-recursos)  
3. [Requisitos](#requisitos)  
4. [Instalação & Uso Rápido](#instalação--uso-rápido)  
5. [Carregando Dados](#carregando-dados)  
6. [Estrutura do Código](#estrutura-do-código)  
7. [Personalização](#personalização)  
8. [Desenvolvimento e Build](#desenvolvimento-e-build)  
9. [Boas Práticas de Contribuição](#boas-práticas-de-contribuição)  
10. [Licença](#licença)  
11. [Autor & Contato](#autor--contato)  

---

## Propósito

Este projeto entrega um **dashboard financeiro completo** – focado em análise de **Notas Fiscais eletrônicas (serviços/produtos)** – **em um único arquivo HTML**.  
Foi concebido para uso **100 % local** (sem servidor), garantindo:

* Portabilidade: abre com duplo‑clique em qualquer navegador moderno.  
* Privacidade: todos os dados permanecem somente na máquina do usuário.  
* Zero dependência de compilação: bibliotecas externas são carregadas via CDN.

---

## Principais Recursos

| Módulo | Destaques |
|--------|-----------|
| **KPI Cards** (27 indicadores) | Faturamento (bruto/liquido), DSO, aging buckets, ISS, recepção vs. aberto, entre outros. |
| **Filtros Dinâmicos** | Período, UF, CNPJ, Status. Persistem no `localStorage`. |
| **Gráficos** | Chart.js + Plugin DataLabels (pie, bar, line) com design responsivo. |
| **Importação Excel** | Leitura client‑side via SheetJS (`.xlsx` ou `.xls`), sem upload. |
| **Tema Claro/Escuro** | Alternância instantânea com persistência local. |
| **Feedback UX** | Overlay de loading, toasts de sucesso/erro, atalhos de teclado (⇧⌘/Ctrl). |
| **Código Otimizado** | Comentários redundantes removidos, espaços compactados e lógica refatorada. |

---

## Requisitos

| Item | Versão Mínima |
|------|---------------|
| Navegador | Chrome / Edge / Firefox / Safari 2022+ |
| Memória RAM | ≥ 512 MB livres (arquivos até ~5 MB) |
| Planilha de dados | Colunas compatíveis com o **mapeamento** em `columnMapping` (ver [Carregando Dados](#carregando-dados)). |

> **Obs.** Todas as dependências (Tailwind, DaisyUI, Chart.js, Flatpickr, Lucide, Alpine.js) são servidas por CDN; não há instalação local.

---

## Instalação & Uso Rápido

1. **Baixe** `dashboard-financeiro.html` (ou `dashboard-refatorado.txt`, renomeando para `.html`).  
2. **Abra** o arquivo no navegador (duplo‑clique ou `Ctrl+O` → Selecionar).  
3. Clique em **Upload** e selecione sua planilha Excel.  
4. Explore KPIs, gráficos e filtros.  
5. (Opcional) Alternar tema com `Ctrl/Cmd + T`.

---

## Carregando Dados

| Coluna Excel (português) | Campo Interno | Tipo Esperado |
|--------------------------|---------------|---------------|
| Número                   | `numero`      | Texto/Número |
| Razão Social             | `razaoSocial` | Texto |
| Data de Emissão          | `dataEmissao` | Data |
| Valor da Nota            | `valorNota`   | Número |
| ISS                      | `iss`         | Número |
| Valor Líquido            | `valorLiquido`| Número |
| ESTADO                   | `estado`      | Texto (sigla) |
| CIDADE                   | `cidade`      | Texto |
| CNPJ                     | `cnpj`        | Texto |
| STATUS DE PAGAMENTO      | `statusPagamento` | Texto |
| Data de Pagamento        | `dataPagamento` | Data |
| Dias para Pagamento      | `diasPagamento`  | Número |
| Status Conciliado        | `statusConciliado` | Texto |
| Recebido                 | `recebido` | “Recebido” \| “Em aberto” |
| Previsão de Recebimento  | `previsaoRecebimento` | Data |

*Caso a aba **Notas Fiscais** não exista, a primeira aba será lida automaticamente.*

---

## Estrutura do Código

index.html # Único arquivo de entrega
│
├─ <head> # Metadados + CDN links
├─ <style> # Tailwind override & custom UI
├─ <body>
│ ├─ Navbar # Upload, toggle tema
│ ├─ Drawer Sidebar # Filtros + resumo
│ ├─ KPI Grid # Cards dinâmicos
│ └─ Charts Section # Canvas Chart.js
└─ <script> # Classes:
DashboardApp # Orquestra fluxo
DataService # ETL do Excel
FiltersManager # Persistência & lógica dos filtros
ChartsManager # Configura/atualiza gráficos
KPICards # Render KPIs


---

## Personalização

| O que mudar | Onde | Como |
|-------------|------|------|
| Paleta/Tema | Variáveis DaisyUI (`data-theme`) | Adicionar tema custom via `daisyui.themes` |
| KPIs        | Array `kpiDefinitions` | Adicionar/editar objetos (`id`, `title`, `calculate`) |
| Mapeamento de colunas | `columnMapping` em `DataService` | Ajustar chaves para suas colunas |
| Limites de alertas (DSO, atraso, etc.) | `getKPIInsight()` | Alterar condicionais/valores |
| CDN vs. local | Trocar `<script src>` para arquivos locais | Copiar libs desejadas para uma pasta `vendor/` |

---

## Desenvolvimento e Build

1. **Edição**  
   Trabalhe sobre a _versão legível_ (`dashboard-financeiro.html` original).  
2. **Minificação**  
   Execute o script Python de refatoração fornecido (`tools/minify.py`) ou use qualquer HTML minifier.  
3. **Teste**  
   Abra o resultado no navegador → `DevTools > Lighthouse` para checar performance e acessibilidade.  
4. **Versionamento**  
   Por ser um único arquivo, git diff permanece rastreável; use **tags** para releases.

---

## Boas Práticas de Contribuição

* Manter compatibilidade com **uso offline**.  
* Evitar dependências que exigem build (Webpack, Vite).  
* Nomear funções/variáveis em **inglês**; texto da UI em **português**.  
* Incluir comentários apenas quando indispensáveis; favor manter minificação no branch `main-dist`.  
* Abrir *pull requests* sempre contra `develop` com descrição clara do escopo.

---

## Licença

MIT © 2025 — **Uillen Machado / IVI B2B**  
Inclui dependências de terceiros sob suas respectivas licenças (MIT, ISC, etc.).

---

## Autor & Contato
- **Uillen Machado** – [LinkedIn](https://www.linkedin.com/in/uillenmachado)  
- Dúvidas ou sugestões: `uillenmachado@gmail.com`

> *“Dados claros, decisões certas.”*  
