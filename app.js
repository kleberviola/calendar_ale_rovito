/**
 * Calendário de Postagens - Google Sheets Integration
 * Desenvolvido para Reserva São Caetano
 */

// URL padrão da planilha fornecida pelo usuário
const DEFAULT_SHEET_URL = "https://docs.google.com/spreadsheets/d/1g1Iz5RSZFwfoyns0OjU89No5_RuzA643sE6ZBsWDsXw/edit?usp=sharing";

// Estado da Aplicação
const state = {
  sheetUrl: localStorage.getItem("post_calendar_sheet_url") || DEFAULT_SHEET_URL,
  sheetTabs: localStorage.getItem("post_calendar_sheet_tabs") || "Reserva SC, 10 Anos",
  posts: [],             // Lista completa de posts estruturados
  currentDate: new Date(), // Mês e ano ativo no calendário
  filters: {
    search: "",
    ambiente: "todos",
    tipo: "todos"
  },
  ambientesDisponiveis: new Set(),
  tiposDisponiveis: new Set()
};

// Mapeamento de Meses em Português
const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

// Inicialização
document.addEventListener("DOMContentLoaded", () => {
  setupEventListeners();
  loadConfig();
  fetchData();
});

// ==========================================================================
// Configuração & Persistência
// ==========================================================================
function loadConfig() {
  const urlInput = document.getElementById("sheet-url-input");
  const tabsInput = document.getElementById("sheet-tabs-input");
  if (urlInput) {
    urlInput.value = state.sheetUrl;
  }
  if (tabsInput) {
    tabsInput.value = state.sheetTabs;
  }
}

function saveConfig() {
  const urlInput = document.getElementById("sheet-url-input");
  const tabsInput = document.getElementById("sheet-tabs-input");
  if (!urlInput || !tabsInput) return;

  let url = urlInput.value.trim();
  let tabs = tabsInput.value.trim();

  if (!url) {
    alert("Por favor, insira uma URL válida.");
    return;
  }

  // Validação básica de URL do Google Sheets
  if (!url.includes("docs.google.com/spreadsheets")) {
    alert("URL inválida. Certifique-se de colar o link completo da sua planilha do Google Sheets.");
    return;
  }

  if (!tabs) {
    alert("Por favor, defina pelo menos uma aba para carregar.");
    return;
  }

  state.sheetUrl = url;
  state.sheetTabs = tabs;
  localStorage.setItem("post_calendar_sheet_url", url);
  localStorage.setItem("post_calendar_sheet_tabs", tabs);
  toggleConfigPanel(false);
  fetchData();
}

function getTabCsvUrl(url, sheetName) {
  try {
    const sheetIdMatch = url.match(/\/d\/([^/]+)/);
    if (sheetIdMatch && sheetIdMatch[1]) {
      const sheetId = sheetIdMatch[1];
      // A API de Visualização do Google (gviz) retorna CSV com cabeçalhos CORS liberados
      return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
    }
  } catch (e) {
    console.error("Erro ao converter URL para aba:", e);
  }
  return null;
}

// Parser de CSV robusto (trata aspas duplas, quebras de linha nos campos, etc.)
function parseCSV(text) {
  const lines = [];
  let row = [""];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          row[row.length - 1] += '"'; // Aspa escapada
          i++;
        } else {
          inQuotes = false; // Fim das aspas
        }
      } else {
        row[row.length - 1] += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        row.push("");
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && nextChar === '\n') {
          i++;
        }
        lines.push(row);
        row = [""];
      } else {
        row[row.length - 1] += char;
      }
    }
  }
  if (row.length > 1 || row[0] !== "") {
    lines.push(row);
  }
  return lines;
}

// Trata as datas retornadas no CSV do gviz de forma robusta
function parseCsvDate(cleanVal) {
  if (!cleanVal) return null;
  
  cleanVal = cleanVal.trim();

  // Formato brasileiro comum: DD/MM/YYYY
  if (cleanVal.includes('/')) {
    const parts = cleanVal.split("/");
    if (parts.length === 3) {
      const dia = parseInt(parts[0], 10);
      const mes = parseInt(parts[1], 10) - 1;
      const ano = parseInt(parts[2], 10);
      return new Date(ano, mes, dia);
    }
  }

  // Formato ISO: YYYY-MM-DD
  if (cleanVal.includes('-')) {
    const parts = cleanVal.split(" ")[0].split("-");
    if (parts.length === 3) {
      const ano = parseInt(parts[0], 10);
      const mes = parseInt(parts[1], 10) - 1;
      const dia = parseInt(parts[2], 10);
      return new Date(ano, mes, dia);
    }
  }

  // Google gviz às vezes retorna a data como string "Date(YYYY,M,D)"
  if (cleanVal.includes("Date(") && cleanVal.includes(")")) {
    const match = cleanVal.match(/Date\((\d+),(\d+),(\d+)\)/);
    if (match) {
      const ano = parseInt(match[1], 10);
      const mes = parseInt(match[2], 10); // No gviz o mês é 0-indexado
      const dia = parseInt(match[3], 10);
      return new Date(ano, mes, dia);
    }
  }

  // Fallback genérico
  const parsed = new Date(cleanVal);
  if (!isNaN(parsed.getTime())) {
    const dia = parsed.getDate();
    const mes = parsed.getMonth();
    const ano = parsed.getFullYear();
    return new Date(ano, mes, dia);
  }

  return null;
}

// ==========================================================================
// Carregamento de Dados (Fetch e Parser de CSV por Aba)
// ==========================================================================
async function fetchData() {
  showLoading(true);

  // Separar nomes das abas
  const tabs = state.sheetTabs.split(",")
    .map(t => t.trim())
    .filter(t => t.length > 0 && !t.toLowerCase().includes("horário") && !t.toLowerCase().includes("horario"));

  if (tabs.length === 0) {
    showError("Por favor, defina pelo menos uma aba para carregar nas configurações.");
    showLoading(false);
    return;
  }

  // Fazer fetch de cada aba em paralelo (CORS-friendly com gviz)
  const fetchPromises = tabs.map(async (tabName) => {
    const csvUrl = getTabCsvUrl(state.sheetUrl, tabName);
    if (!csvUrl) throw new Error(`URL da planilha inválida.`);

    const response = await fetch(`${csvUrl}&t=${new Date().getTime()}`);
    if (!response.ok) {
      throw new Error(`Não foi possível carregar a aba "${tabName}". Verifique se o nome dela está correto na planilha.`);
    }
    const csvText = await response.text();
    return { tabName, csvText };
  });

  try {
    const results = await Promise.all(fetchPromises);
    processAllCsvResults(results);
    updateSyncTime();
    showLoading(false);
  } catch (error) {
    console.error("Erro ao buscar dados do Sheets:", error);
    showError(error.message || "Erro de conexão. Verifique se a planilha está compartilhada como 'Leitor' público.");
    showLoading(false);
  }
}

function processAllCsvResults(results) {
  try {
    const posts = [];
    state.ambientesDisponiveis.clear();
    state.tiposDisponiveis.clear();

    results.forEach(({ tabName, csvText }) => {
      const rows = parseCSV(csvText);
      if (rows.length < 3) return; // Planilha muito curta

      // Procurar o cabeçalho útil da aba específica de forma resiliente
      let headerIndex = -1;
      for (let i = 0; i < Math.min(rows.length, 15); i++) {
        const rowStr = rows[i].join("").toLowerCase();
        if (rowStr.includes("data") && rowStr.includes("ambiente") && rowStr.includes("tipo")) {
          headerIndex = i;
          break;
        }
      }

      if (headerIndex === -1) {
        // Fallback caso a aba não tenha exatamente a linha inicial de cabeçalho
        headerIndex = 0;
      }

      // Mapeamento dinâmico dos índices de colunas com base no cabeçalho útil encontrado
      let colIndexes = {
        data: 0,
        horario: -1,
        ambiente: 2,
        tipo: 4,
        legenda: 6,
        arquivo: 8
      };

      const headerRow = rows[headerIndex];
      headerRow.forEach((col, idx) => {
        const val = String(col).toLowerCase().trim();
        if (val.includes("data")) colIndexes.data = idx;
        else if (val.includes("horário") || val.includes("horario")) colIndexes.horario = idx;
        else if (val.includes("ambiente")) colIndexes.ambiente = idx;
        else if (val.includes("tipo") || val.includes("formato")) colIndexes.tipo = idx;
        else if (val.includes("legenda")) colIndexes.legenda = idx;
        else if (val.includes("arquivo") || val.includes("mídia") || val.includes("midia")) colIndexes.arquivo = idx;
      });

      // Processar dados da aba atual
      for (let i = headerIndex + 1; i < rows.length; i++) {
        const row = rows[i];
        
        // Pular linhas vazias
        if (!row || row.length === 0 || row.join("").trim() === "") continue;

        // Pegar valores dinamicamente usando os índices mapeados
        const rawData = colIndexes.data !== -1 && row[colIndexes.data] ? String(row[colIndexes.data]).trim() : "";
        const rawHorario = colIndexes.horario !== -1 && row[colIndexes.horario] ? String(row[colIndexes.horario]).trim() : "";
        const rawAmbiente = colIndexes.ambiente !== -1 && row[colIndexes.ambiente] ? String(row[colIndexes.ambiente]).trim() : "";
        const rawTipo = colIndexes.tipo !== -1 && row[colIndexes.tipo] ? String(row[colIndexes.tipo]).trim() : "";
        const rawLegenda = colIndexes.legenda !== -1 && row[colIndexes.legenda] ? String(row[colIndexes.legenda]).trim() : "";
        const rawArquivo = colIndexes.arquivo !== -1 && row[colIndexes.arquivo] ? String(row[colIndexes.arquivo]).trim() : "";

        // Se ambiente e tipo forem vazios, não é um post válido
        if (!rawAmbiente && !rawTipo) continue;

        // Parse inteligente da data
        const parsedDate = parseCsvDate(rawData);
        let formattedDateString = "";
        
        if (parsedDate) {
          const dia = String(parsedDate.getDate()).padStart(2, '0');
          const mes = String(parsedDate.getMonth() + 1).padStart(2, '0');
          const ano = parsedDate.getFullYear();
          formattedDateString = `${dia}/${mes}/${ano}`;
        }

        const post = {
          id: `post-${tabName}-${i}`,
          aba: tabName,
          dataRaw: rawData,
          data: parsedDate,
          dataString: formattedDateString,
          horario: rawHorario,
          ambiente: rawAmbiente || "Não especificado",
          tipo: rawTipo || "Outro",
          legenda: rawLegenda,
          arquivo: rawArquivo
        };

        posts.push(post);

        if (rawAmbiente) state.ambientesDisponiveis.add(rawAmbiente);
        if (rawTipo) state.tiposDisponiveis.add(rawTipo);
      }
    });

    state.posts = posts;
    populateFilterSelects();
    renderAll();

  } catch (err) {
    console.error("Erro ao analisar dados da planilha:", err);
    showError("Erro ao processar os dados das planilhas. Verifique a formatação do arquivo.");
  }
}

function populateFilterSelects() {
  const filterAmbiente = document.getElementById("filter-ambiente");
  const filterTipo = document.getElementById("filter-tipo");

  if (!filterAmbiente || !filterTipo) return;

  // Salvar valores atuais selecionados
  const selectedAmbiente = filterAmbiente.value;
  const selectedTipo = filterTipo.value;

  // Reiniciar seletores
  filterAmbiente.innerHTML = '<option value="todos">Todos os Ambientes</option>';
  filterTipo.innerHTML = '<option value="todos">Todos os Formatos</option>';

  // Adicionar opções ordenadas
  Array.from(state.ambientesDisponiveis).sort().forEach(amb => {
    const opt = document.createElement("option");
    opt.value = amb;
    opt.textContent = amb;
    filterAmbiente.appendChild(opt);
  });

  Array.from(state.tiposDisponiveis).sort().forEach(tipo => {
    const opt = document.createElement("option");
    opt.value = tipo;
    opt.textContent = tipo;
    filterTipo.appendChild(opt);
  });

  // Restaurar seletores ou definir padrão
  filterAmbiente.value = state.ambientesDisponiveis.has(selectedAmbiente) ? selectedAmbiente : "todos";
  filterTipo.value = state.tiposDisponiveis.has(selectedTipo) ? selectedTipo : "todos";
}

// ==========================================================================
// Renderização de Telas & Filtros
// ==========================================================================
function renderAll() {
  renderCalendar();
  renderBacklog();
  updateStats();
}

// Filtra a lista de posts de acordo com os filtros de pesquisa e seleção
function getFilteredPosts() {
  return state.posts.filter(post => {
    // 1. Busca por Texto (Busca no ambiente ou legenda/link)
    const matchesSearch = !state.filters.search || 
      post.ambiente.toLowerCase().includes(state.filters.search.toLowerCase()) ||
      post.tipo.toLowerCase().includes(state.filters.search.toLowerCase()) ||
      post.legenda.toLowerCase().includes(state.filters.search.toLowerCase());

    // 2. Filtro de Ambiente
    const matchesAmbiente = state.filters.ambiente === "todos" || post.ambiente === state.filters.ambiente;

    // 3. Filtro de Tipo
    const matchesTipo = state.filters.tipo === "todos" || post.tipo === state.filters.tipo;

    return matchesSearch && matchesAmbiente && matchesTipo;
  });
}

function renderCalendar() {
  const gridContainer = document.getElementById("calendar-days-grid");
  const monthTitle = document.getElementById("calendar-month-year");
  if (!gridContainer || !monthTitle) return;

  gridContainer.innerHTML = "";

  const year = state.currentDate.getFullYear();
  const month = state.currentDate.getMonth();

  // Definir Título (Mês e Ano)
  monthTitle.textContent = `${MESES[month]} ${year}`;

  // Primeiro dia da semana do mês atual (0 = Domingo, ..., 6 = Sábado)
  const firstDayIndex = new Date(year, month, 1).getDay();

  // Último dia do mês atual
  const lastDayDate = new Date(year, month + 1, 0).getDate();

  // Último dia do mês anterior (para os dias de transição iniciais)
  const prevMonthLastDay = new Date(year, month, 0).getDate();

  // Total de células a renderizar. Para manter a proporção perfeita do Google Calendar
  // exibimos 6 linhas completas (6 * 7 = 42 células)
  const totalCells = 42;

  const filteredPosts = getFilteredPosts();
  const today = new Date();

  for (let i = 0; i < totalCells; i++) {
    const cell = document.createElement("div");
    cell.classList.add("calendar-day-cell");

    let cellDayNumber;
    let cellMonth;
    let cellYear;

    if (i < firstDayIndex) {
      // Dias do Mês Anterior
      cell.classList.add("other-month");
      cellDayNumber = prevMonthLastDay - firstDayIndex + i + 1;
      cellMonth = month - 1;
      cellYear = year;
      if (cellMonth < 0) {
        cellMonth = 11;
        cellYear--;
      }
    } else if (i >= firstDayIndex + lastDayDate) {
      // Dias do Próximo Mês
      cell.classList.add("other-month");
      cellDayNumber = i - firstDayIndex - lastDayDate + 1;
      cellMonth = month + 1;
      cellYear = year;
      if (cellMonth > 11) {
        cellMonth = 0;
        cellYear++;
      }
    } else {
      // Dias do Mês Atual
      cellDayNumber = i - firstDayIndex + 1;
      cellMonth = month;
      cellYear = year;

      // Destacar o Dia de Hoje
      if (cellDayNumber === today.getDate() && cellMonth === today.getMonth() && cellYear === today.getFullYear()) {
        cell.classList.add("today");
      }
    }

    // Identificar a data desta célula em string formatada para cruzamento
    const cellDateStr = `${String(cellDayNumber).padStart(2, '0')}/${String(cellMonth + 1).padStart(2, '0')}/${cellYear}`;

    // Header do Dia (Número da Data)
    const dayHeader = document.createElement("div");
    dayHeader.classList.add("day-header");
    
    const dayNumber = document.createElement("span");
    dayNumber.classList.add("day-number");
    dayNumber.textContent = cellDayNumber;
    dayHeader.appendChild(dayNumber);
    cell.appendChild(dayHeader);

    // Contêiner de posts do dia
    const dayEvents = document.createElement("div");
    dayEvents.classList.add("day-events");

    // Buscar posts do dia
    const dayPosts = filteredPosts.filter(p => p.dataString === cellDateStr);

    dayPosts.forEach(post => {
      const eventEl = document.createElement("div");
      eventEl.classList.add("calendar-event", getCssClassByTipo(post.tipo));
      
      // Ícone baseado na plataforma ou formato (opcional) - Exibe Horário se houver
      const timePrefix = post.horario ? `${post.horario} • ` : "";
      eventEl.textContent = `${timePrefix}${post.ambiente} (${post.tipo})`;
      eventEl.title = `${post.ambiente} - Formato: ${post.tipo}\nHorário: ${post.horario || "Não definido"}\nOrigem: ${post.aba}\nClique para ver detalhes`;
      
      eventEl.addEventListener("click", (e) => {
        e.stopPropagation(); // Evita clicks indesejados no container
        openPostModal(post);
      });

      dayEvents.appendChild(eventEl);
    });

    cell.appendChild(dayEvents);
    gridContainer.appendChild(cell);
  }
}

function renderBacklog() {
  const backlogContainer = document.getElementById("backlog-list");
  if (!backlogContainer) return;

  backlogContainer.innerHTML = "";

  // Filtra posts que NÃO têm data definida
  const filteredPosts = getFilteredPosts();
  const backlogPosts = filteredPosts.filter(post => post.data === null);

  const countBadge = document.getElementById("backlog-count");
  if (countBadge) {
    countBadge.textContent = `${backlogPosts.length} posts`;
  }
  
  // Atualizar o badge numérico no menu lateral esquerdo
  const sidebarBadge = document.getElementById("menu-backlog-badge");
  if (sidebarBadge) {
    sidebarBadge.textContent = backlogPosts.length;
  }

  if (backlogPosts.length === 0) {
    backlogContainer.innerHTML = `
      <div class="empty-state">
        Nenhum post pendente no backlog com os filtros selecionados.
      </div>
    `;
    return;
  }

  backlogPosts.forEach(post => {
    const card = document.createElement("div");
    card.classList.add("post-card", getCssClassByTipo(post.tipo));

    // Elemento interno do cartão - Mostra a aba de origem no cabeçalho
    card.innerHTML = `
      <div class="post-card-header">
        <span class="post-card-type">${post.tipo}</span>
        <span class="post-card-time" title="Origem">${post.aba}</span>
      </div>
      <div class="post-card-title">${post.ambiente}</div>
      <div class="post-card-footer">
        <span class="post-card-ambiente">Sem data definida</span>
        <div class="post-card-links">
          ${post.legenda ? `<svg title="Contém Legenda" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-file-text"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>` : ""}
          ${post.arquivo ? `<svg title="Contém Arquivos" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-folder"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>` : ""}
        </div>
      </div>
    `;

    card.addEventListener("click", () => {
      openPostModal(post);
    });

    backlogContainer.appendChild(card);
  });
}

function updateStats() {
  const statTotal = document.getElementById("stat-total");
  const statAgendados = document.getElementById("stat-agendados");
  const statBacklog = document.getElementById("stat-backlog");

  if (!statTotal || !statAgendados || !statBacklog) return;

  const total = state.posts.length;
  const agendados = state.posts.filter(p => p.data !== null).length;
  const backlog = total - agendados;

  statTotal.textContent = total;
  statAgendados.textContent = agendados;
  statBacklog.textContent = backlog;
}

// Helpers CSS baseados no formato/tipo do post
function getCssClassByTipo(tipo) {
  const t = tipo.toLowerCase();
  if (t.includes("reels")) return "reels";
  if (t.includes("story") || t.includes("stories")) return "story";
  if (t.includes("carrossel")) return "carrossel";
  if (t.includes("3d x real") || t.includes("3d")) return "real3d";
  if (t.includes("post feed") || t.includes("feed")) return "postfeed";
  if (t.includes("detalhe") || t.includes("detalhes")) return "detalhes";
  return "default";
}

// ==========================================================================
// Modal & Detalhes do Post
// ==========================================================================
function openPostModal(post) {
  const modal = document.getElementById("post-modal");
  const badge = document.getElementById("modal-post-type");
  const title = document.getElementById("modal-post-title");
  const date = document.getElementById("modal-post-date");
  const horario = document.getElementById("modal-post-time");
  const ambiente = document.getElementById("modal-post-ambiente");
  const aba = document.getElementById("modal-post-aba");
  const docLink = document.getElementById("modal-doc-link");
  const driveLink = document.getElementById("modal-drive-link");

  if (!modal) return;

  // Preencher Badge de Tipo
  badge.textContent = post.tipo;
  badge.className = "modal-badge " + getCssClassByTipo(post.tipo);

  // Preencher Título
  title.textContent = `Ambiente: ${post.ambiente}`;
  
  // Data de Postagem e Informações
  date.textContent = post.dataString || "Pendente de Agendamento";
  if (horario) horario.textContent = post.horario || "Não especificado";
  ambiente.textContent = post.ambiente;
  if (aba) aba.textContent = post.aba || "Geral";

  // Configurar Link da Legenda (Google Docs)
  if (post.legenda && post.legenda.startsWith("http")) {
    docLink.href = post.legenda;
    docLink.style.display = "flex";
  } else {
    docLink.style.display = "none";
  }

  // Configurar Link da Mídia (Google Drive)
  if (post.arquivo && post.arquivo.startsWith("http")) {
    driveLink.href = post.arquivo;
    driveLink.style.display = "flex";
  } else {
    driveLink.style.display = "none";
  }

  // Exibir Modal
  modal.classList.add("open");
}

function closePostModal() {
  const modal = document.getElementById("post-modal");
  if (modal) {
    modal.classList.remove("open");
  }
}

// ==========================================================================
// Event Listeners e Lógicas de Navegação
// ==========================================================================
function setupEventListeners() {
  // Navegação do Calendário
  const prevBtn = document.getElementById("prev-month-btn");
  const nextBtn = document.getElementById("next-month-btn");
  const todayBtn = document.getElementById("today-btn");

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      state.currentDate.setMonth(state.currentDate.getMonth() - 1);
      renderCalendar();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      state.currentDate.setMonth(state.currentDate.getMonth() + 1);
      renderCalendar();
    });
  }

  if (todayBtn) {
    todayBtn.addEventListener("click", () => {
      state.currentDate = new Date();
      renderCalendar();
    });
  }

  // Filtros
  const searchInput = document.getElementById("search-input");
  const filterAmbiente = document.getElementById("filter-ambiente");
  const filterTipo = document.getElementById("filter-tipo");

  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      state.filters.search = e.target.value;
      renderAll();
    });
  }

  if (filterAmbiente) {
    filterAmbiente.addEventListener("change", (e) => {
      state.filters.ambiente = e.target.value;
      renderAll();
    });
  }

  if (filterTipo) {
    filterTipo.addEventListener("change", (e) => {
      state.filters.tipo = e.target.value;
      renderAll();
    });
  }

  // Botão Sincronizar (Refresh)
  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      fetchData();
    });
  }

  // Barra Lateral & Navegação de Gavetas (Drawer)
  const menuCalendar = document.getElementById("menu-calendar");
  const menuBacklog = document.getElementById("menu-backlog");
  const menuConfig = document.getElementById("menu-config");
  const backlogDrawer = document.getElementById("backlog-drawer");
  const closeDrawerBtn = document.getElementById("close-drawer-btn");

  function setActiveNav(navElement) {
    [menuCalendar, menuBacklog, menuConfig].forEach(item => {
      if (item) item.classList.remove("active");
    });
    if (navElement) navElement.classList.add("active");
  }

  if (menuCalendar) {
    menuCalendar.addEventListener("click", (e) => {
      e.preventDefault();
      setActiveNav(menuCalendar);
      if (backlogDrawer) backlogDrawer.classList.remove("open");
      toggleConfigPanel(false);
    });
  }

  if (menuBacklog) {
    menuBacklog.addEventListener("click", (e) => {
      e.preventDefault();
      setActiveNav(menuBacklog);
      if (backlogDrawer) backlogDrawer.classList.add("open");
      toggleConfigPanel(false);
    });
  }

  if (closeDrawerBtn) {
    closeDrawerBtn.addEventListener("click", () => {
      if (backlogDrawer) backlogDrawer.classList.remove("open");
      setActiveNav(menuCalendar);
    });
  }

  if (menuConfig) {
    menuConfig.addEventListener("click", (e) => {
      e.preventDefault();
      setActiveNav(menuConfig);
      toggleConfigPanel(true);
      if (backlogDrawer) backlogDrawer.classList.remove("open");
    });
  }

  // Configurações (Fechar e Salvar)
  const closeConfigBtn = document.getElementById("close-config-btn");
  const saveConfigBtn = document.getElementById("save-config-btn");

  if (closeConfigBtn) {
    closeConfigBtn.addEventListener("click", () => {
      toggleConfigPanel(false);
      setActiveNav(menuCalendar);
    });
  }
  if (saveConfigBtn) {
    saveConfigBtn.addEventListener("click", saveConfig);
  }

  // Modal Fechamento
  const closeModalBtn = document.getElementById("close-modal-btn");
  const closeModalFooterBtn = document.getElementById("close-modal-footer-btn");
  const modalContainer = document.getElementById("post-modal");

  if (closeModalBtn) closeModalBtn.addEventListener("click", closePostModal);
  if (closeModalFooterBtn) closeModalFooterBtn.addEventListener("click", closePostModal);
  
  if (modalContainer) {
    modalContainer.addEventListener("click", (e) => {
      if (e.target === modalContainer) {
        closePostModal();
      }
    });
  }

  // Exportação
  const exportPngBtn = document.getElementById("export-png-btn");
  const exportPdfBtn = document.getElementById("export-pdf-btn");

  if (exportPngBtn) {
    exportPngBtn.addEventListener("click", (e) => {
      e.preventDefault();
      exportAsImage();
    });
  }

  if (exportPdfBtn) {
    exportPdfBtn.addEventListener("click", (e) => {
      e.preventDefault();
      exportAsPdf();
    });
  }
}

function toggleConfigPanel(open) {
  const panel = document.getElementById("config-panel");
  if (panel) {
    if (open) {
      panel.classList.add("open");
    } else {
      panel.classList.remove("open");
    }
  }
}

// ==========================================================================
// Feedbacks e Exportação Visual
// ==========================================================================
function showLoading(isLoading) {
  const refreshBtn = document.getElementById("refresh-btn");
  if (!refreshBtn) return;

  const btnText = refreshBtn.querySelector(".btn-text");
  const iconLeft = refreshBtn.querySelector(".icon-left");
  const iconRight = refreshBtn.querySelector(".icon-right");

  // Garantir que a animação spinner esteja registrada no CSS
  if (!document.getElementById("spinner-styles")) {
    const style = document.createElement("style");
    style.id = "spinner-styles";
    style.textContent = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .spinner {
        animation: spin 1.2s linear infinite;
      }
    `;
    document.head.appendChild(style);
  }

  if (isLoading) {
    refreshBtn.disabled = true;
    if (btnText) btnText.textContent = "Sincronizando...";
    if (iconLeft) iconLeft.classList.add("spinner");
    if (iconRight) iconRight.classList.add("spinner");
  } else {
    refreshBtn.disabled = false;
    if (btnText) btnText.textContent = "Atualizar";
    if (iconLeft) iconLeft.classList.remove("spinner");
    if (iconRight) iconRight.classList.remove("spinner");
  }
}

function updateSyncTime() {
  const syncText = document.getElementById("sync-time-text");
  if (syncText) {
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    syncText.textContent = `Sincronizado às ${timeStr}`;
  }
}

function showError(message) {
  console.error("Erro da Aplicação:", message);
  alert(message);
}

// Exportar Grade do Calendário como PNG de alta qualidade
function exportAsImage() {
  const targetArea = document.getElementById("calendar-export-area");
  if (!targetArea) return;

  // Feedback de exportando
  const exportBtn = document.querySelector(".export-dropdown > .flow-btn");
  const btnText = exportBtn ? exportBtn.querySelector(".btn-text") : null;
  const iconLeft = exportBtn ? exportBtn.querySelector(".icon-left") : null;
  const iconRight = exportBtn ? exportBtn.querySelector(".icon-right") : null;

  if (exportBtn) {
    exportBtn.disabled = true;
    if (btnText) btnText.textContent = "Exportando...";
    if (iconLeft) iconLeft.classList.add("spinner");
    if (iconRight) iconRight.classList.add("spinner");
  }

  html2canvas(targetArea, {
    scale: 2, // Alta qualidade
    useCORS: true,
    backgroundColor: "#ffffff", // Fundo branco estilo Light Mode Referência
    logging: false,
    onclone: (clonedDoc) => {
      // Ocultar controles de navegação na imagem
      const clonedControls = clonedDoc.querySelector(".calendar-navigation-controls");
      if (clonedControls) clonedControls.style.display = "none";
      
      const clonedContainer = clonedDoc.getElementById("calendar-export-area");
      if (clonedContainer) {
        clonedContainer.style.width = "1200px";
        clonedContainer.style.height = "800px"; // Altura estática para evitar travamentos no clone flex/grid
        clonedContainer.style.borderRadius = "0";
        clonedContainer.style.border = "none";
      }

      const clonedSheet = clonedDoc.querySelector(".calendar-sheet");
      if (clonedSheet) {
        clonedSheet.style.height = "700px";
        clonedSheet.style.display = "flex";
        clonedSheet.style.flexDirection = "column";
      }

      const clonedGrid = clonedDoc.getElementById("calendar-days-grid");
      if (clonedGrid) {
        clonedGrid.style.height = "650px";
        clonedGrid.style.gridTemplateRows = "repeat(6, 105px)"; // Fixando altura de linha no grid clone
      }
    }
  }).then(canvas => {
    if (exportBtn) {
      exportBtn.disabled = false;
      if (btnText) btnText.textContent = "Exportar";
      if (iconLeft) iconLeft.classList.remove("spinner");
      if (iconRight) iconRight.classList.remove("spinner");
    }

    const link = document.createElement("a");
    const monthTitle = document.getElementById("calendar-month-year").textContent.replace(" ", "_").toLowerCase();
    link.download = `calendario_postagem_${monthTitle}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }).catch(err => {
    console.error("Erro ao gerar imagem:", err);
    alert("Ocorreu um erro ao exportar o calendário como imagem.");
    if (exportBtn) {
      exportBtn.disabled = false;
      if (btnText) btnText.textContent = "Exportar";
      if (iconLeft) iconLeft.classList.remove("spinner");
      if (iconRight) iconRight.classList.remove("spinner");
    }
  });
}

// Exportar Calendário como arquivo PDF nativo (sem abrir janela de impressão)
function exportAsPdf() {
  const targetArea = document.getElementById("calendar-export-area");
  if (!targetArea) return;

  // Feedback de exportando
  const exportBtn = document.querySelector(".export-dropdown > .flow-btn");
  const btnText = exportBtn ? exportBtn.querySelector(".btn-text") : null;
  const iconLeft = exportBtn ? exportBtn.querySelector(".icon-left") : null;
  const iconRight = exportBtn ? exportBtn.querySelector(".icon-right") : null;

  if (exportBtn) {
    exportBtn.disabled = true;
    if (btnText) btnText.textContent = "Gerando PDF...";
    if (iconLeft) iconLeft.classList.add("spinner");
    if (iconRight) iconRight.classList.add("spinner");
  }

  const monthTitle = document.getElementById("calendar-month-year").textContent.replace(" ", "_").toLowerCase();
  
  // Configuração do html2pdf.js
  const opt = {
    margin: 10,
    filename: `calendario_postagem_${monthTitle}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { 
      scale: 2, 
      useCORS: true,
      backgroundColor: '#ffffff',
      onclone: (clonedDoc) => {
        // Ocultar controles de navegação no PDF
        const clonedControls = clonedDoc.querySelector(".calendar-navigation-controls");
        if (clonedControls) clonedControls.style.display = "none";
        
        const clonedContainer = clonedDoc.getElementById("calendar-export-area");
        if (clonedContainer) {
          clonedContainer.style.width = "1200px";
          clonedContainer.style.height = "800px"; // Altura fixa
          clonedContainer.style.borderRadius = "0";
          clonedContainer.style.border = "none";
        }
        
        const clonedSheet = clonedDoc.querySelector(".calendar-sheet");
        if (clonedSheet) {
          clonedSheet.style.height = "700px";
          clonedSheet.style.display = "flex";
          clonedSheet.style.flexDirection = "column";
        }
        
        const clonedGrid = clonedDoc.getElementById("calendar-days-grid");
        if (clonedGrid) {
          clonedGrid.style.height = "650px";
          clonedGrid.style.gridTemplateRows = "repeat(6, 105px)";
        }
      }
    },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
  };

  html2pdf().set(opt).from(targetArea).save().then(() => {
    if (exportBtn) {
      exportBtn.disabled = false;
      if (btnText) btnText.textContent = "Exportar";
      if (iconLeft) iconLeft.classList.remove("spinner");
      if (iconRight) iconRight.classList.remove("spinner");
    }
  }).catch(err => {
    console.error("Erro ao gerar PDF:", err);
    alert("Ocorreu um erro ao exportar o calendário como PDF.");
    if (exportBtn) {
      exportBtn.disabled = false;
      if (btnText) btnText.textContent = "Exportar";
      if (iconLeft) iconLeft.classList.remove("spinner");
      if (iconRight) iconRight.classList.remove("spinner");
    }
  });
}
