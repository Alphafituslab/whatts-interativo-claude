/*
 * Seja Alpha — frontend em JavaScript puro (sem build step/CDN),
 * independente do Alphafitus OS: login/senha próprios, caixa de entrada
 * de WhatsApp compartilhada entre os usuários cadastrados.
 */
(function () {
  "use strict";

  const API = "/api/v1";
  const app = document.getElementById("app");

  const state = {
    accessToken: null,
    refreshToken: localStorage.getItem("whatts_refresh_token") || null,
    usuarioAtual: null,
    tema: localStorage.getItem("whatts_tema") || "auto",
    flash: null,
    emailLembrado: localStorage.getItem("whatts_email_lembrado") || "",
    escopoConversas: "minhas", // "minhas" | "fila" | "todas" — aba ativa da caixa de entrada
    chatInternoEscopo: "minhas", // "minhas" | "encerradas" | "todas" (todas = admin vendo tudo da empresa)
    lembretesTodos: false, // admin: false = só os meus, true = de todo mundo
    agendamentosTodos: false,
    lembretesAlertados: new Set(), // ids de lembrete já alertados nesta sessão do navegador
    // Transcrições que a pessoa fechou. Só nesta aba e nesta sessão: é
    // preferência de quem está olhando, não algo que valha pros colegas.
    transcricoesFechadas: new Set(),
    _transcricoesPendentes: new Set(), // mensagens com transcrição rodando em segundo plano, aguardando o polling trazer o resultado
    // Quantas não lidas na contagem anterior — o aviso sonoro só toca
    // quando o número sobe. null = ainda não contamos nenhuma vez (não
    // toca pras mensagens que já estavam lá quando a pessoa entrou).
    naoLidasWpp: null,
    naoLidasInterno: null,
    // Pendências de follow-up na contagem anterior — o aviso só toca
    // quando aparece pendência nova, não a cada verificação.
    followupPendentes: null,
    filtroAtividadesUsuarioId: null,
    versaoServidor: null,
    buscaConversas: null,
    buscaData: null, // "AAAA-MM-DD" — filtro de data nas Conversas, pode vir junto com buscaConversas ou sozinho
    slaAlertasIds: new Set(),
  };
  if (state.tema !== "auto") document.documentElement.setAttribute("data-tema", state.tema);

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  function fmtNomeBackup(nome) {
    const m = nome.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (!m) return nome;
    const [, ano, mes, dia, h, min, s] = m;
    return `${dia}/${mes}/${ano} às ${h}:${min}:${s}`;
  }

  // A versão vem como AAAA.MM.DD.HHMMSS. Na tela mostramos até o minuto
  // — os segundos existem só pra duas atualizações no mesmo minuto não
  // gerarem o mesmo número. A comparação que dispara o recarregamento
  // usa o valor inteiro, não este.
  function _versaoCurta(versao) {
    return String(versao || "").slice(0, 15);
  }

  function fmtData(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
      return d.toLocaleString("pt-BR");
    } catch (e) { return iso; }
  }

  function _diaLocal(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    } catch (e) { return ""; }
  }

  function _rotuloDoDia(diaLocal) {
    const [ano, mes, dia] = diaLocal.split("-");
    return `${dia}/${mes}/${ano}`;
  }

  function htmlDivisorDeDia(diaLocal) {
    return `<div class="wpp-divisor-dia"><span>${_rotuloDoDia(diaLocal)}</span></div>`;
  }

  // Intercala um divisor de data toda vez que o dia muda entre uma
  // mensagem e a anterior — o "27/08/2026" que separa visualmente as
  // conversas de dias diferentes, do jeito que todo chat costuma
  // mostrar. Cada item ganha uma chave propria pra \_sincronizarLista
  // conseguir atualizar so o que mudou, sem redesenhar a lista inteira.
  function _comDivisoresDeDia(mensagens) {
    const itens = [];
    let diaAnterior = null;
    for (const m of mensagens) {
      const dia = _diaLocal(m.criado_em);
      if (dia && dia !== diaAnterior) {
        itens.push({ chave: `dia-${dia}`, divisor: dia });
        diaAnterior = dia;
      }
      itens.push({ chave: String(m.id), mensagem: m });
    }
    return itens;
  }

  function fmtHoraCurta(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
      return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  function iniciaisContato(nome, telefone) {
    const base = (nome || telefone || "?").trim();
    const partes = base.split(/\s+/).filter(Boolean);
    if (partes.length >= 2 && nome) return (partes[0][0] + partes[1][0]).toUpperCase();
    return base.slice(0, 2).toUpperCase();
  }

  const CORES_AVATAR = ["#0a8f74", "#7c5cff", "#c68a0a", "#2c7be5", "#e0453a", "#0aa3a0", "#8a5cf6", "#1a9c6b"];
  function corAvatar(chave) {
    let hash = 0;
    for (let i = 0; i < (chave || "").length; i++) hash = (hash * 31 + chave.charCodeAt(i)) >>> 0;
    return CORES_AVATAR[hash % CORES_AVATAR.length];
  }

  // A foto do contato vem de fora (URL devolvida pela Evolution API, que
  // por sua vez pega no WhatsApp) — ou seja, é dado que não controlamos.
  // Aceita só http(s) e escapa antes de virar atributo: sem isso, um
  // valor com aspas conseguiria fechar o src e injetar script na tela do
  // atendente.
  function urlImagemSegura(url) {
    const s = String(url || "").trim();
    return /^https?:\/\//i.test(s) || s.startsWith("/api/") ? escapeHtml(s) : "";
  }

  function htmlAvatarContato(fotoUrl, nome, telefone, tamanho = 40) {
    const estilo = `width:${tamanho}px;height:${tamanho}px;font-size:${Math.round(tamanho * 0.35)}px;`;
    const src = urlImagemSegura(fotoUrl);
    // Com foto, o avatar abre em tamanho grande no clique. Sem foto são
    // só as iniciais — não há nada pra ampliar, então nem vira botão.
    if (src) {
      return `<img class="wpp-avatar wpp-avatar-foto wpp-avatar-ampliavel" style="${estilo}" src="${src}" alt=""
        referrerpolicy="no-referrer" data-acao="ampliar-foto" data-url="${src}"
        data-nome="${escapeHtml(nome || telefone || "")}" title="Ver a foto maior">`;
    }
    return `<div class="wpp-avatar" style="${estilo}background:${corAvatar(telefone)};">${escapeHtml(iniciaisContato(nome, telefone))}</div>`;
  }

  // ---------------------------------------------------------------------
  // Cliente da API
  // ---------------------------------------------------------------------
  // Sem limite de tempo, uma rede que trava (wifi ruim, VPN caindo no
  // meio) deixava o pedido esperando pra sempre, sem erro nenhum — quem
  // clicou via a tela "não fazer nada" e clicava de novo achando que
  // tinha falhado, sem nunca saber que era a rede. 25s é mais que
  // suficiente pra qualquer pedido normal (mesmo com o servidor
  // ocupado); passado isso, avisa em vez de ficar mudo.
  const TEMPO_LIMITE_PEDIDO_MS = 25000;
  function _fetchComLimite(url, opcoes) {
    const controlador = new AbortController();
    const timer = setTimeout(() => controlador.abort(), TEMPO_LIMITE_PEDIDO_MS);
    return fetch(url, { ...opcoes, signal: controlador.signal })
      .catch((e) => {
        if (e.name === "AbortError") throw new Error("A internet demorou demais pra responder. Confira sua conexão e tente de novo.");
        throw e;
      })
      .finally(() => clearTimeout(timer));
  }

  async function chamarApi(caminho, { method = "GET", body, semAuth = false } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (!semAuth && state.accessToken) headers["Authorization"] = "Bearer " + state.accessToken;

    let resp = await _fetchComLimite(API + caminho, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });

    if (resp.status === 401 && !semAuth && state.refreshToken) {
      const renovou = await tentarRenovarToken();
      if (renovou) {
        headers["Authorization"] = "Bearer " + state.accessToken;
        resp = await _fetchComLimite(API + caminho, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      }
    }

    let dados = {};
    try { dados = await resp.json(); } catch (e) { /* corpo vazio, ok */ }

    if (!resp.ok) {
      if (resp.status === 401) { limparSessao(); navegarPara("#/login"); }
      const erro = new Error(dados.mensagem || `Erro ${resp.status} na requisição.`);
      erro.status = resp.status;
      erro.codigo = dados.erro;
      // O corpo inteiro, não só a frase: é dele que sai "com quem está a
      // conversa" pra tela poder oferecer o pedido de liberação.
      erro.dados = dados;
      throw erro;
    }
    return dados;
  }

  async function tentarRenovarToken() {
    try {
      // Também com limite de tempo: essa chamada acontece bem no início,
      // ANTES de qualquer tela abrir ("Restaurando sessão…") -- se
      // travasse sem limite, a tela nunca chegava a abrir de jeito
      // nenhum, o que parecia bem pior do que só um pedido lento.
      const resp = await _fetchComLimite(API + "/auth/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: state.refreshToken }),
      });
      if (!resp.ok) return false;
      const dados = await resp.json();
      state.accessToken = dados.access_token;
      state.refreshToken = dados.refresh_token;
      localStorage.setItem("whatts_refresh_token", state.refreshToken);
      return true;
    } catch (e) { return false; }
  }

  function limparSessao() {
    state.accessToken = null;
    state.refreshToken = null;
    state.usuarioAtual = null;
    localStorage.removeItem("whatts_refresh_token");
  }

  // ---------------------------------------------------------------------
  // Roteador (hash simples)
  // ---------------------------------------------------------------------
  function navegarPara(hash) {
    if (location.hash === hash) montarRota();
    else location.hash = hash;
  }
  window.addEventListener("hashchange", montarRota);

  async function montarRota() {
    const rota = location.hash || "#/login";
    pararPollingWhatsapp();
    pararPollingStatusWhatsapp();
    pararPollingChatInterno();

    if (!state.refreshToken) {
      if (rota !== "#/login") return navegarPara("#/login");
      return renderLogin();
    }

    if (!state.usuarioAtual) {
      app.innerHTML = '<div class="carregando-inicial">Restaurando sessão…</div>';
      const ok = await tentarRenovarToken();
      if (!ok) { limparSessao(); return renderLogin(); }
      try { state.usuarioAtual = await chamarApi("/auth/me"); }
      catch (e) { limparSessao(); return renderLogin(); }
    }

    if (rota === "#/login") return navegarPara("#/whatsapp");

    // Fica de olho nos lembretes vencidos independente de qual tela a
    // pessoa está — não faria sentido só avisar se ela estiver com a
    // tela de Lembretes aberta bem naquela hora.
    iniciarPollingLembretes();
    iniciarPollingStatusGlobal();

    const [, pagina, param] = rota.split("/");
    try {
      await (async () => {
        switch (pagina) {
          case "whatsapp": return renderWhatsapp(param ? Number(param) : null, rota.split("/")[3] === "negociacoes");
          case "chat-interno": return renderChatInterno(param ? Number(param) : null);
          case "_sem_acesso_conversas": break; // nunca casa; só pra deixar o switch legível
          case "agendamentos": return renderAgendamentos();
          case "lembretes": return renderLembretes();
          case "dashboard": return renderDashboard();
          case "atividades": return renderAtividades();
          case "seguranca": return renderSeguranca();
          case "configuracao": return renderWhatsappConfiguracao();
          case "usuarios": return renderUsuarios();
          case "ligacoes": return renderLigacoes();
          case "catalogo": return renderCatalogo();
          default: return renderWhatsapp(null);
        }
      })();
    } catch (e) {
      renderShell(`<div class="cartao"><p class="mensagem-erro">Erro ao carregar página: ${escapeHtml(e.message)}</p></div>`, pagina);
    }
  }

  // ---------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------
  const ITENS_MENU = [
    { rota: "#/whatsapp", chave: "whatsapp", label: "WhatsApp", icone: "💬", exigeConversas: true },
    { rota: "#/chat-interno", chave: "chat-interno", label: "Chat interno", icone: "🗨️" },
    { rota: "#/agendamentos", chave: "agendamentos", label: "Agendamentos", icone: "🕒" },
    { rota: "#/lembretes", chave: "lembretes", label: "Lembretes", icone: "🔔" },
    { rota: "#/dashboard", chave: "dashboard", label: "Dashboard", icone: "📊", admin: true },
    { rota: "#/atividades", chave: "atividades", label: "Atividades", icone: "📋", admin: true },
    { rota: "#/seguranca", chave: "seguranca", label: "Segurança", icone: "🔒" },
    { rota: "#/configuracao", chave: "configuracao", label: "Configuração", icone: "⚙️", admin: true },
    { rota: "#/usuarios", chave: "usuarios", label: "Usuários", icone: "👥", admin: true },
    { rota: "#/catalogo", chave: "catalogo", label: "Catálogo/Proposta", icone: "🗂️", admin: true },
  ];

  // Colaborador que só usa o chat interno. Esconder o menu é conforto;
  // a trava de verdade é no servidor (ver o before_request em
  // routes/whatsapp.py), senão bastaria digitar o endereço.
  function _podeVerConversas() {
    const u = state.usuarioAtual;
    if (!u) return false;
    return !!u.admin || u.acesso_conversas !== false;
  }

  // Setores que a pessoa atende. Vários de uma vez: quem faz Televendas
  // e Financeiro recebe a fila dos dois, sem precisar de dois cadastros.
  function htmlEscolhaSetores(todos, marcados) {
    const escolhidos = (marcados || []).map(String);
    if (!todos.length) {
      return `<label class="rotulo-forte">Setores que atende</label>
        <p class="dica">Nenhum setor cadastrado ainda — crie em <strong>Configuração → Setores</strong>.</p>`;
    }
    return `
      <label class="rotulo-forte">Setores desta pessoa</label>
      <p class="dica" style="margin-top:0;">Pode marcar mais de um — quem faz Televendas e Financeiro marca os dois.
      O setor vale sempre: é como a pessoa aparece para os colegas no chat interno, onde ela fala com <strong>qualquer setor</strong>.
      E, para quem atende clientes, é por ele que a conversa chega: o cliente escolhe o número no menu do WhatsApp e ela cai aqui.</p>
      <div class="escolha-lista">
        ${todos.map((s, i) => `
          <label class="escolha-item">
            <input type="checkbox" name="setores" value="${escapeHtml(s)}" ${escolhidos.includes(s) ? "checked" : ""}>
            <span class="escolha-numero">${i + 1}</span>
            <span class="escolha-texto">${escapeHtml(s)}</span>
          </label>`).join("")}
      </div>`;
  }

  function htmlEscolhaAcesso(temAcesso, ehAdmin) {
    return `
      <div class="campo" data-campo-acesso style="${ehAdmin ? "display:none;" : ""}">
        <label class="rotulo-forte">O que esta pessoa pode acessar</label>
        <div class="escolha-lista">
          <label class="escolha-item escolha-item-grande">
            <input type="checkbox" name="acesso_conversas" ${temAcesso ? "checked" : ""}>
            <span class="escolha-texto">
              <strong>Conversas de WhatsApp</strong>
              <span class="escolha-ajuda">Marcado: atende os clientes normalmente, nos setores escolhidos abaixo.<br>
              Desmarcado: <strong>só o chat interno</strong> — fala com a equipe, mas não vê nenhuma conversa de cliente. Dá pra liberar de novo a qualquer momento.</span>
            </span>
          </label>
        </div>
      </div>`;
  }

  function htmlAvatar(u, tamanho = 34) {
    const estilo = `width:${tamanho}px;height:${tamanho}px;font-size:${Math.round(tamanho * 0.35)}px;`;
    if (u && u.foto_perfil) return `<img class="wpp-avatar wpp-avatar-foto" style="${estilo}" src="${u.foto_perfil}" alt="">`;
    return `<div class="wpp-avatar" style="${estilo}background:${corAvatar(u ? u.email : "")};">${escapeHtml(iniciaisContato(u && u.nome))}</div>`;
  }

  // Loga automaticamente na página de downloads usando o token que a
  // pessoa já tem aqui dentro -- sem isso, clicar num link de "Baixar"
  // caía numa segunda tela de email/senha (mesmo já estando logada no
  // Seja Alpha). Memoizado: só tenta uma vez por sessão de fato.
  let _ssoDownloadsPromise = null;
  function _prepararDownloads() {
    if (!_ssoDownloadsPromise && state.accessToken) {
      _ssoDownloadsPromise = fetch("/downloads/sso", {
        method: "POST",
        headers: { Authorization: "Bearer " + state.accessToken },
      }).catch(() => {});
    }
    return _ssoDownloadsPromise;
  }

  function renderShell(conteudoHtml, paginaAtiva) {
    const usuario = state.usuarioAtual;
    if (usuario && usuario.admin) _prepararDownloads();
    const linksHtml = ITENS_MENU
      .filter((it) => !it.admin || (usuario && usuario.admin))
      .filter((it) => !it.exigeConversas || _podeVerConversas())
      .map((it) => {
        let extra = "";
        if (it.chave === "whatsapp") {
          extra = '<span class="wpp-badge-sla" data-wpp-sla-badge hidden title="Conversas paradas: o cliente falou e ninguém respondeu dentro do tempo combinado"></span>'
                + '<span class="wpp-badge-nao-lidas wpp-badge-nav" data-wpp-nao-lidas-badge hidden title="Mensagens novas que você ainda não leu"></span>';
        } else if (it.chave === "chat-interno") {
          extra = '<span class="wpp-badge-nao-lidas wpp-badge-nav" data-wpp-chat-interno-nao-lidas-badge hidden title="Mensagens novas de colegas que você ainda não leu"></span>';
        }
        return `<a class="link-nav ${it.chave === paginaAtiva ? "ativo" : ""}" href="${it.rota}"><span>${it.icone}</span> ${escapeHtml(it.label)}${extra}</a>`;
      })
      .join("")
      // Follow-up é botão, não link de página: abre o painel lateral sem
      // sair de onde a pessoa está. Fica no menu (e não flutuando sobre a
      // conversa) porque ali nunca disputa espaço com botão nenhum.
      + `<button type="button" class="link-nav link-nav-botao" data-acao="alternar-followup" title="Clientes que precisam de contato">
           <span>🔔</span> Follow-up
           <span class="wpp-badge-nao-lidas wpp-badge-nav" data-followup-contador hidden>0</span>
         </button>`
      // Ligações: pedido do Clayton (2026-09-03), logo abaixo do
      // Follow-up no menu.
      + (usuario && _podeVerConversas()
          ? `<a class="link-nav ${paginaAtiva === "ligacoes" ? "ativo" : ""}" href="#/ligacoes"><span>📞</span> Leads do Consulta Anvisa</a>`
          : "");

    const flashHtml = state.flash
      ? `<div class="${state.flash.tipo === "erro" ? "mensagem-erro" : "mensagem-ok"} flash-aviso">
           <span>${escapeHtml(state.flash.texto)}</span>
           <button type="button" class="flash-fechar" data-acao="fechar-flash" title="Fechar">✕</button>
         </div>`
      : "";

    app.innerHTML = `
      <div class="layout">
        <div class="fundo-menu-mobile" data-acao="alternar-menu-mobile"></div>
        <aside class="barra-lateral">
          <div class="marca"><img class="marca-icone marca-logo" src="${state.logoUrl || "/static/img/logo_alphafitus.png"}" alt="" data-wpp-logo> Seja Alpha</div>
          <div class="wpp-status-linha" data-wpp-status-linha>
            <span class="wpp-status-bolinha wpp-status-desconhecido" data-wpp-status-bolinha></span>
            <span data-wpp-status-texto>Verificando…</span>
          </div>
          <nav>${linksHtml}</nav>
          <div class="rodape-barra-lateral">
            <div class="usuario-atual-chip">
              <button type="button" class="wpp-avatar-botao" data-acao="abrir-seletor-foto" title="Trocar foto de perfil">${htmlAvatar(usuario, 34)}</button>
              <input type="file" class="wpp-input-foto-oculto" data-acao-change="enviar-foto-perfil" accept="image/*" hidden>
              <div>
                <div class="usuario-atual-nome" title="${escapeHtml(usuario ? usuario.nome : "")}">${escapeHtml(usuario ? usuario.nome : "")}</div>
                <div class="usuario-atual-email" title="${escapeHtml(usuario ? usuario.email : "")}">${escapeHtml(usuario ? usuario.email : "")}</div>
              </div>
            </div>
            ${(usuario && (_podeVerConversas() || usuario.admin)) ? `
              <button type="button" class="botao secundario pequeno" style="width:100%; margin-top:10px; display:flex; align-items:center; justify-content:space-between;" data-acao="alternar-mais-opcoes">
                <span>⋯ Mais opções</span> <span class="wpp-seta-mais-opcoes">▸</span>
              </button>
              <div class="wpp-mais-opcoes" ${state._maisOpcoesAberta ? "" : "hidden"}>
                ${_podeVerConversas() ? `
                  <button class="botao secundario pequeno" style="width:100%; margin-top:8px;" data-acao="camera-enviar-whatsapp" title="Bater uma foto agora e mandar direto pra um cliente, de qualquer tela do sistema">📷 Câmera → cliente</button>
                  <input type="file" class="wpp-input-camera-oculto" accept="image/*" capture="environment" hidden>` : ""}
                ${usuario.admin ? `
                  <button class="botao secundario pequeno" style="width:100%; margin-top:8px;" data-acao="instalar-app">📲 Instalar no aparelho</button>
                  <a class="botao secundario pequeno" href="/downloads/WhattsInbox-instalador.zip" style="display:block; text-align:center; text-decoration:none; margin-top:8px;">⬇ Instalar em outra máquina</a>` : ""}
              </div>` : ""}
            <button class="botao secundario pequeno ${usuario && usuario.ausente ? "botao-ausente-ligado" : ""}" style="width:100%; margin-top:10px;" data-acao="alternar-ausente"
              title="${usuario && usuario.ausente ? "Você está marcado como ausente — clique pra voltar" : "Avise que você saiu (almoço, reunião). Some das listas de quem pode atender."}">
              ${usuario && usuario.ausente ? `🟡 Ausente${usuario.ausente_motivo ? " — " + escapeHtml(usuario.ausente_motivo) : ""} · voltar` : "🟡 Marcar ausência"}
            </button>
            <div class="barra-acoes" style="margin-top:10px;">
              <button class="botao-icone" data-acao="alternar-tema" title="Alternar tema">🌓</button>
              <button class="botao secundario pequeno" data-acao="logout" style="margin-left:auto;">Sair</button>
            </div>
            ${usuario && usuario.admin ? `<div class="wpp-versao-rodape" data-wpp-versao title="Versão do sistema — muda a cada atualização">${state.versaoServidor ? `v${_versaoCurta(state.versaoServidor)}` : ""}</div>` : ""}
          </div>
        </aside>
        <div class="conteudo-principal">
          <div class="barra-superior-mobile">
            <button class="botao-icone botao-menu-mobile" data-acao="alternar-menu-mobile" title="Abrir menu">☰</button>
            <strong>💬 Seja Alpha</strong>
          </div>
          <div class="pagina">${flashHtml}${conteudoHtml}</div>
        </div>
        <aside class="followup-painel" data-followup-painel hidden>
          <div class="followup-cabecalho">
            <strong>Follow-up</strong>
            <button type="button" class="botao-icone" data-acao="alternar-followup" title="Fechar">✕</button>
          </div>
          <div class="followup-conteudo" data-followup-conteudo>
            <p class="texto-suave" style="padding:12px;">Carregando…</p>
          </div>
        </aside>
      </div>`;
    state.flash = null;
    atualizarBolinhaStatusGlobal(); // o DOM acabou de ser trocado inteiro — sem isso a bolinha mostraria "Verificando…" até o próximo tick do polling
  }

  function definirFlash(tipo, texto) { state.flash = { tipo, texto }; }

  // A logo da empresa e trocavel em Configuracao. Buscada sem token
  // porque a tela de login aparece antes de existir sessao; se falhar,
  // fica a logo padrao que ja esta no HTML.
  async function carregarLogo() {
    try {
      const r = await fetch(`${API}/marca`).then((x) => x.json());
      if (!r.logo_url) return;
      state.logoUrl = r.logo_url;
      document.querySelectorAll("[data-wpp-logo]").forEach((img) => { img.src = r.logo_url; });
    } catch (e) { /* fica a padrao */ }
  }

  document.addEventListener("click", async (e) => {
    const alvo = e.target.closest("[data-acao]");
    if (!alvo) return;
    e.preventDefault(); // nenhuma ação data-acao depende do comportamento nativo do navegador — inclusive quando o botão fica dentro de um <a> (ex.: "Assumir"/"Encaminhar" num item de lista clicável)
    try { await tratarAcao(alvo.dataset.acao, alvo, e); }
    catch (erro) { definirFlash("erro", erro.message || "Ocorreu um erro."); montarRota(); }
  });

  // Arrastar um arquivo do computador e soltar em cima da conversa
  // aberta anexa ele, igual clicar no clipe -- pedido do Clayton
  // (2026-08-31), vale pro WhatsApp e pro chat interno (os dois usam a
  // mesma classe .wpp-painel-chat no painel da direita).
  let _arrastandoArquivo = false;
  document.addEventListener("dragover", (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    const painel = e.target.closest(".wpp-painel-chat");
    if (!painel) return;
    e.preventDefault();
    if (!_arrastandoArquivo) { _arrastandoArquivo = true; painel.classList.add("wpp-arrastando-arquivo"); }
  });
  document.addEventListener("dragleave", (e) => {
    const painel = e.target.closest(".wpp-painel-chat");
    if (!painel || painel.contains(e.relatedTarget)) return; // ainda dentro do mesmo painel, não soltou de verdade
    painel.classList.remove("wpp-arrastando-arquivo");
    _arrastandoArquivo = false;
  });
  document.addEventListener("drop", async (e) => {
    const painel = e.target.closest(".wpp-painel-chat");
    if (!painel || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    painel.classList.remove("wpp-arrastando-arquivo");
    _arrastandoArquivo = false;
    const interna = !!painel.querySelector("[data-wpp-mensagens-interno]");
    const painelMensagens = painel.querySelector(interna ? "[data-wpp-mensagens-interno]" : "[data-wpp-mensagens]");
    const conversaId = painelMensagens ? Number(painelMensagens.dataset.conversaId) : null;
    if (!conversaId) { definirFlash("erro", "Abra uma conversa antes de soltar o arquivo aqui."); return; }
    const url = interna ? `${API}/chat-interno/conversas/${conversaId}/anexo` : `${API}/whatsapp/conversas/${conversaId}/anexo`;
    try {
      await _enviarVariosAnexos(e.dataTransfer.files, url);
    } finally {
      if (interna) renderChatInterno(conversaId); else renderWhatsapp(conversaId);
    }
  });

  document.addEventListener("submit", async (e) => {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault();
    try { await tratarFormulario(form.dataset.form, form); }
    catch (erro) { definirFlash("erro", erro.message || "Ocorreu um erro."); montarRota(); }
  });

  document.addEventListener("change", async (e) => {
    const alvo = e.target.closest("[data-acao-change]");
    if (!alvo) return;
    try { await tratarAcao(alvo.dataset.acaoChange, alvo, e); }
    catch (erro) { definirFlash("erro", erro.message || "Ocorreu um erro."); montarRota(); }
  });

  // Rascunho de mensagem: guardado no navegador (localStorage), por
  // conversa, sem tocar rede. Ver `_salvarRascunho`/`_lerRascunho`.
  function _chaveRascunho(tipo, conversaId) { return `rascunho:${tipo}:${conversaId}`; }
  function _salvarRascunho(tipo, conversaId, texto) {
    try {
      const chave = _chaveRascunho(tipo, conversaId);
      if (texto) localStorage.setItem(chave, texto);
      else localStorage.removeItem(chave);
    } catch (e) { /* localStorage indisponível (aba privada etc.) — sem rascunho, sem drama */ }
  }
  function _lerRascunho(tipo, conversaId) {
    try { return localStorage.getItem(_chaveRascunho(tipo, conversaId)) || ""; }
    catch (e) { return ""; }
  }
  document.addEventListener("input", (e) => {
    const textarea = e.target.closest('form[data-form="enviar-mensagem"] textarea[name="texto"], form[data-form="enviar-mensagem-interna"] textarea[name="texto"]');
    if (!textarea) return;
    const form = textarea.closest("form");
    const tipo = form.dataset.form === "enviar-mensagem-interna" ? "interna" : "cliente";
    _salvarRascunho(tipo, form.dataset.conversaId, textarea.value);
  });

  // Avisa "digitando…" pro colega quando a pessoa escreve no chat interno
  // — throttled (no máx. 1 a cada 4s) pra não martelar a API a cada tecla;
  // o próprio "digitando" expira sozinho no servidor depois de alguns
  // segundos (ver SEGUNDOS_DIGITANDO), então não precisa avisar "parei".
  let ultimoAvisoDigitando = 0;
  document.addEventListener("input", (e) => {
    const textarea = e.target.closest('form[data-form="enviar-mensagem-interna"] textarea[name="texto"]');
    if (!textarea) return;
    const agora = Date.now();
    if (agora - ultimoAvisoDigitando < 4000) return;
    ultimoAvisoDigitando = agora;
    const conversaId = textarea.closest("form").dataset.conversaId;
    chamarApi(`/chat-interno/conversas/${conversaId}/digitando`, { method: "POST" }).catch(() => {});
  });

  // Enter envia (padrão de todo chat); Shift+Enter quebra linha.
  // Vale nas barras de digitação das duas telas e também nas janelas de
  // iniciar conversa — lá o Enter fazia nada e a pessoa tinha que ir
  // com o mouse até o botão.
  const FORMS_ENTER_ENVIA = [
    "enviar-mensagem",            // conversa de cliente
    "enviar-mensagem-interna",    // conversa interna
    "iniciar-conversa",           // janela "Nova conversa" (cliente)
    "iniciar-conversa-interna",   // janela "Nova conversa interna"
  ];
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    // Gravando: Enter encerra e manda o áudio, mesmo sem foco no campo.
    if (_estaGravando()) { e.preventDefault(); _pararEEnviarAudio(); return; }
    const seletor = FORMS_ENTER_ENVIA.map((f) => `form[data-form="${f}"] textarea[name="texto"]`).join(", ");
    const textarea = e.target.closest(seletor);
    if (!textarea) return;
    const form = textarea.closest("form");
    // Nas janelas há campos obrigatórios antes (ex.: com quem falar) —
    // se faltar preencher, deixa o navegador mostrar o aviso dele em vez
    // de enviar pela metade.
    if (!form.checkValidity()) { form.reportValidity(); e.preventDefault(); return; }
    e.preventDefault();
    form.requestSubmit();
  });

  document.addEventListener("input", (e) => {
    const campo = e.target.closest("[data-wpp-busca-mensagens-input]");
    if (!campo) return;
    _buscarNasMensagens(campo.value);
  });
  document.addEventListener("keydown", (e) => {
    const campo = e.target.closest("[data-wpp-busca-mensagens-input]");
    if (!campo || e.key !== "Enter") return;
    e.preventDefault();
    _irParaResultadoBusca(e.shiftKey ? -1 : 1);
  });
  document.addEventListener("keydown", (e) => {
    // Atalho tipo navegador: Ctrl+F com uma conversa aberta abre a busca
    // em vez da busca nativa da página, que aqui não ajudaria em nada.
    if (!(e.key === "f" && (e.ctrlKey || e.metaKey))) return;
    const painel = document.querySelector("[data-wpp-mensagens], [data-wpp-mensagens-interno]");
    const barra = document.querySelector("[data-wpp-busca-mensagens]");
    if (!painel || !barra) return;
    e.preventDefault();
    barra.hidden = false;
    barra.querySelector("[data-wpp-busca-mensagens-input]").focus();
  });

  // Busca enquanto digita, nas Conversas.
  //
  // Antes só buscava no Enter (ou na lupa), e quem digitava ficava
  // olhando a lista antiga achando que não tinha achado nada. A pausa
  // de 350ms evita uma consulta por tecla; e o campo não é redesenhado
  // no meio da digitação, senão o cursor pularia pro começo.
  let _timerBusca = null;
  document.addEventListener("input", (e) => {
    const campo = e.target.closest('form[data-form="buscar-conversas"] input[name="q"]');
    if (!campo) return;
    clearTimeout(_timerBusca);
    _timerBusca = setTimeout(async () => {
      const texto = campo.value.trim();
      const digitos = texto.replace(/\D/g, "");
      // Número precisa de 4 dígitos pra valer a pena ("48" acharia quase
      // tudo); texto, de 2 letras. Menos que isso, volta a lista normal.
      const vale = digitos.length >= 4 || (digitos.length === 0 && texto.length >= 2) || texto.length >= 3;
      const novo = vale ? texto : null;
      if (novo === state.buscaConversas) return;
      state.buscaConversas = novo;
      await renderWhatsapp(null);
      // Devolve o foco e o cursor pro fim, pra pessoa seguir digitando.
      const recriado = document.querySelector('form[data-form="buscar-conversas"] input[name="q"]');
      if (recriado) {
        recriado.focus();
        recriado.setSelectionRange(recriado.value.length, recriado.value.length);
      }
    }, 350);
  });

  document.addEventListener("change", (e) => {
    const campoData = e.target.closest('form[data-form="buscar-conversas"] input[name="data"]');
    if (!campoData) return;
    state.buscaData = campoData.value || null;
    renderWhatsapp(null);
  });

  // Ctrl+V com um print na área de transferência manda a imagem pra
  // conversa aberta. Print é a coisa mais colada num atendimento — ter
  // que salvar em arquivo antes, só pra depois anexar, é um passo a
  // mais em algo que se faz dezenas de vezes por dia.
  //
  // Vale nas duas telas; a conversa é a que estiver aberta no momento.
  document.addEventListener("paste", async (e) => {
    const itens = [...((e.clipboardData || {}).items || [])];
    const imagem = itens.find((i) => i.type && i.type.startsWith("image/"));
    if (!imagem) return; // colar texto continua normal
    const conversaId = Number(location.hash.split("/")[2]) || null;
    const interna = location.hash.startsWith("#/chat-interno");
    if (!conversaId || (!interna && !location.hash.startsWith("#/whatsapp"))) return;
    const arquivo = imagem.getAsFile();
    if (!arquivo) return;
    e.preventDefault();
    // Print vem sem nome de arquivo; dar um com a data ajuda depois, na
    // hora de achar o anexo no histórico.
    const carimbo = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const comNome = new File([arquivo], `print-${carimbo}.png`, { type: arquivo.type || "image/png" });
    if (comNome.size > 90 * 1024 * 1024) {
      definirFlash("erro", "A imagem colada é maior que 90MB.");
      return montarRota();
    }
    // Mostra ANTES de mandar. Colar é rápido demais pra não ter uma
    // conferida: dá pra colar o print errado (a área de transferência
    // guarda o último de qualquer programa), e mandar imagem errada pro
    // cliente não tem desfazer bonito.
    modalPreviaPrint(comNome, conversaId, interna);
  });

  function modalPreviaPrint(arquivo, conversaId, interna) {
    const endereco = URL.createObjectURL(arquivo);
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">📋 Enviar print</h3>
      <div class="wpp-previa-print"><img src="${endereco}" alt="Prévia do print"></div>
      <div class="campo" style="margin-top:12px;">
        <label class="rotulo-forte">Escrever junto (opcional)</label>
        <textarea name="legenda" rows="2" placeholder="Ex.: veja o erro que aparece na tela"></textarea>
      </div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-enviar-print>Enviar</button>
      </div>`);
    // Solta a memória da prévia quando a janela sai, de um jeito ou de
    // outro — sem isso a imagem fica presa no navegador.
    const liberar = () => URL.revokeObjectURL(endereco);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) liberar(); });

    const legenda = wrap.querySelector('textarea[name="legenda"]');
    legenda.focus();
    const enviar = async (ev) => {
      const botao = ev ? ev.currentTarget : wrap.querySelector("[data-enviar-print]");
      botao.disabled = true;
      botao.textContent = "Enviando…";
      try {
        const base = interna
          ? `/chat-interno/conversas/${conversaId}/anexo`
          : `/whatsapp/conversas/${conversaId}/anexo`;
        await _subirAnexo(`${API}${base}`, arquivo, null, legenda.value.trim());
        liberar();
        fecharModais();
        if (interna) await atualizarMensagensInternasNoDom(conversaId);
        else await atualizarMensagensNoDom(conversaId);
      } catch (erro) {
        botao.disabled = false;
        botao.textContent = "Enviar";
        definirFlash("erro", erro.message || "Não consegui enviar a imagem.");
        montarRota();
      }
    };
    wrap.querySelector("[data-enviar-print]").addEventListener("click", enviar);
    // Enter manda, Shift+Enter quebra linha — mesmo comportamento do
    // campo de mensagem.
    legenda.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); }
    });
  }

  // Esbarrar em "esta conversa está com outra pessoa" era o fim da linha:
  // não dava pra saber com quem, nem pedir. Agora diz o nome e oferece
  // avisar a pessoa pelo chat interno — e, pra administrador, a opção de
  // devolver a conversa pra fila na hora.
  function modalConversaPresa(erro) {
    const d = erro.dados || {};
    const dono = d.atribuida_usuario_nome || "outra pessoa";
    const id = d.conversa_id;
    const souAdmin = !!(state.usuarioAtual && state.usuarioAtual.admin);
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">🔒 Atendimento em andamento</h3>
      <p>Esta conversa está com <strong>${escapeHtml(dono)}</strong>. Enquanto o atendimento não for encerrado ou encaminhado, ela continua sendo dela.</p>
      <div class="campo">
        <label class="rotulo-forte">Quer avisar ${escapeHtml(dono)}? (opcional: diga o porquê)</label>
        <input name="motivo" maxlength="140" placeholder="Ex.: o cliente me ligou pedindo o orçamento" autofocus>
      </div>
      <p class="dica">O aviso chega no chat interno de ${escapeHtml(dono)}, com o nome do cliente. Quem decide encerrar continua sendo ela.</p>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Deixar como está</button>
        ${souAdmin && id ? `<button type="button" class="botao secundario" data-acao="devolver-para-fila" data-id="${id}">Devolver pra fila</button>` : ""}
        ${id ? `<button type="button" class="botao" data-pedir-liberacao data-id="${id}">Avisar ${escapeHtml(dono)}</button>` : ""}
      </div>`);
    const botao = wrap.querySelector("[data-pedir-liberacao]");
    if (botao) {
      botao.addEventListener("click", async () => {
        botao.disabled = true;
        botao.textContent = "Avisando…";
        try {
          const r = await chamarApi(`/whatsapp/conversas/${id}/pedir-liberacao`, {
            method: "POST", body: { motivo: wrap.querySelector('input[name="motivo"]').value.trim() },
          });
          fecharModais();
          definirFlash("ok", `Avisei ${r.avisado} no chat interno. Assim que ela liberar, a conversa aparece pra você.`);
        } catch (e2) {
          botao.disabled = false;
          botao.textContent = "Avisar";
          definirFlash("erro", e2.message || "Não consegui avisar agora.");
        }
        montarRota();
      });
    }
    return wrap;
  }

  // Encaminhar sem sair da conversa: escolhe um ou vários contatos, com
  // busca (a lista de conversas é longa demais pra rolar procurando).
  async function modalEncaminharMensagem(conversaId, mensagemId, daTelaInterna) {
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">📨 Encaminhar mensagem</h3>
      <div class="wpp-encaminhar-abas">
        <button type="button" class="wpp-encaminhar-aba ativa" data-aba-encaminhar="clientes">👤 Clientes</button>
        <button type="button" class="wpp-encaminhar-aba" data-aba-encaminhar="colegas">🗨️ Colegas</button>
      </div>
      <div class="campo">
        <input data-busca-encaminhar placeholder="Procurar por nome ou número…" autofocus>
      </div>
      <div class="wpp-encaminhar-lista" data-lista-encaminhar><p class="dica">Carregando…</p></div>
      <p class="dica" data-resumo-escolhidos></p>
      <div class="campo" style="margin-top:10px;">
        <label class="rotulo-forte">Escrever algo antes (opcional)</label>
        <input name="comentario" maxlength="300" placeholder="Ex.: segue o laudo que a Tabata mandou">
      </div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-enviar-encaminhar disabled>Encaminhar</button>
      </div>`);

    const lista = wrap.querySelector("[data-lista-encaminhar]");
    const botao = wrap.querySelector("[data-enviar-encaminhar]");
    const resumo = wrap.querySelector("[data-resumo-escolhidos]");
    const busca = wrap.querySelector("[data-busca-encaminhar]");
    // Duas listas separadas: a escolha feita numa aba não some ao trocar
    // pra outra — dá pra mandar o mesmo documento pro cliente e pro
    // laboratório de uma vez só.
    const clientes = new Map();   // telefone -> conversa_id | null
    const colegas = new Map();    // usuario_id -> nome
    let aba = "clientes";

    function atualizarBotao() {
      const total = clientes.size + colegas.size;
      botao.disabled = total === 0;
      botao.textContent = total ? `Encaminhar para ${total}` : "Encaminhar";
      const partes = [];
      if (clientes.size) partes.push(`${clientes.size} cliente${clientes.size > 1 ? "s" : ""}`);
      if (colegas.size) partes.push(`${colegas.size} colega${colegas.size > 1 ? "s" : ""}`);
      resumo.textContent = partes.length ? `Selecionado: ${partes.join(" e ")}.` : "";
    }

    function desenhar(itens) {
      if (!itens.length) {
        lista.innerHTML = aba === "clientes"
          ? `<p class="dica">Nenhum contato encontrado. Você também pode digitar um número novo na busca.</p>`
          : `<p class="dica">Nenhum colega encontrado.</p>`;
        return;
      }
      lista.innerHTML = itens.map((c) => aba === "clientes"
        ? `<label class="wpp-encaminhar-item">
             <input type="checkbox" data-tipo="cliente" data-conversa="${c.conversa_id || ""}" data-telefone="${escapeHtml(c.telefone)}" ${clientes.has(c.telefone) ? "checked" : ""}>
             <span class="wpp-encaminhar-nome">${escapeHtml(c.nome || c.telefone)}</span>
             <span class="wpp-encaminhar-tel">${escapeHtml(c.telefone)}</span>
           </label>`
        : `<label class="wpp-encaminhar-item">
             <input type="checkbox" data-tipo="colega" data-usuario="${c.id}" data-nome="${escapeHtml(c.nome)}" ${colegas.has(c.id) ? "checked" : ""}>
             <span class="wpp-encaminhar-nome">${c.online ? "🟢" : "🔴"} ${escapeHtml(c.nome)}</span>
             <span class="wpp-encaminhar-tel">${escapeHtml(_setoresDoColega(c).join(", ") || "")}</span>
           </label>`).join("");
      lista.querySelectorAll("input[type=checkbox]").forEach((cx) => {
        cx.addEventListener("change", () => {
          if (cx.dataset.tipo === "cliente") {
            if (cx.checked) clientes.set(cx.dataset.telefone, cx.dataset.conversa ? Number(cx.dataset.conversa) : null);
            else clientes.delete(cx.dataset.telefone);
          } else {
            const id = Number(cx.dataset.usuario);
            if (cx.checked) colegas.set(id, cx.dataset.nome);
            else colegas.delete(id);
          }
          atualizarBotao();
        });
      });
    }

    async function buscar(termo) {
      try {
        if (aba === "clientes") {
          const r = await chamarApi(`/whatsapp/contatos?q=${encodeURIComponent(termo || "")}`);
          desenhar((r.contatos || r || []).slice(0, 60));
        } else {
          const eu = state.usuarioAtual.id;
          const t = (termo || "").toLowerCase();
          const todos = await chamarApi("/usuarios");
          desenhar((todos || []).filter((u) => u.ativo && u.id !== eu
            && (!t || (u.nome || "").toLowerCase().includes(t))).slice(0, 60));
        }
      } catch (e) {
        lista.innerHTML = `<p class="dica">Não consegui carregar a lista agora.</p>`;
      }
    }
    buscar("");

    let debounce = null;
    busca.addEventListener("input", (e) => {
      clearTimeout(debounce);
      const termo = e.target.value.trim();
      debounce = setTimeout(() => buscar(termo), 250);
    });

    wrap.querySelectorAll("[data-aba-encaminhar]").forEach((b) => {
      b.addEventListener("click", () => {
        aba = b.dataset.abaEncaminhar;
        wrap.querySelectorAll("[data-aba-encaminhar]").forEach((o) => o.classList.toggle("ativa", o === b));
        busca.placeholder = aba === "clientes" ? "Procurar por nome ou número…" : "Procurar colega pelo nome…";
        busca.value = "";
        lista.innerHTML = `<p class="dica">Carregando…</p>`;
        buscar("");
      });
    });

    botao.addEventListener("click", async () => {
      botao.disabled = true;
      botao.textContent = "Encaminhando…";
      const conversas = [...clientes.values()].filter((v) => v);
      const telefones = [...clientes.entries()].filter(([, v]) => !v).map(([t]) => t);
      const usuarios = [...colegas.keys()];
      try {
        const base = daTelaInterna ? "/chat-interno" : "/whatsapp";
        const r = await chamarApi(`${base}/conversas/${conversaId}/mensagens/${mensagemId}/encaminhar`, {
          method: "POST",
          body: { conversas, telefones, usuarios, comentario: wrap.querySelector('input[name="comentario"]').value.trim() },
        });
        fecharModais();
        const falhas = (r.resultados || []).filter((x) => !x.ok);
        if (!falhas.length) {
          definirFlash("ok", `Encaminhada para ${r.enviados} contato(s).`);
        } else {
          definirFlash(r.enviados ? "erro" : "erro",
            `Encaminhada para ${r.enviados}. Não deu certo em: ` +
            falhas.map((f) => `${f.nome || f.conversa_id || f.usuario_id} (${f.motivo || "falhou"})`).join("; "));
        }
      } catch (e) {
        definirFlash("erro", e.message || "Não consegui encaminhar.");
      }
      montarRota();
    });
    return wrap;
  }

  function abrirModal(html, classeExtra) {
    const wrap = document.createElement("div");
    wrap.className = "fundo-modal";
    wrap.innerHTML = `<div class="modal ${classeExtra || ""}">${html}</div>`;
    wrap.addEventListener("click", (e) => { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
    return wrap;
  }
  function fecharModais() { document.querySelectorAll(".fundo-modal").forEach((m) => m.remove()); }

  function _irParaOFim(painel) {
    if (!painel) return;
    // Se a pessoa rolar pra cima pra ler algo antigo, paramos na hora: o
    // pior defeito possível aqui seria arrancar a tela dela de volta pro
    // fim enquanto ela lê.
    let cancelado = false;
    const parar = () => { cancelado = true; };
    ["wheel", "touchstart", "keydown", "mousedown"].forEach((ev) =>
      painel.addEventListener(ev, parar, { once: true, passive: true }));

    const ir = () => { if (!cancelado) painel.scrollTop = painel.scrollHeight; };
    ir();
    requestAnimationFrame(ir);

    // Toda mídia que ainda não terminou de carregar muda a altura depois.
    painel.querySelectorAll("img, video, audio").forEach((el) => {
      if (el.tagName === "IMG" && el.complete) return;
      el.addEventListener("load", ir, { once: true });
      el.addEventListener("loadedmetadata", ir, { once: true });
      el.addEventListener("error", ir, { once: true });
    });
    // Rede lenta: as duas últimas chances, já canceladas se a pessoa mexeu.
    setTimeout(ir, 150);
    setTimeout(ir, 600);
  }

  // Fecha só a janela de cima: com duas abertas (uma janela que abriu
  // outra), Esc deve voltar um passo, não varrer as duas.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const abertas = document.querySelectorAll(".fundo-modal");
    if (!abertas.length) return;
    e.preventDefault();
    abertas[abertas.length - 1].remove();
  });

  // Menu de contexto (botão direito) num item da lista de conversas —
  // atalho pra agendar/lembrar/arquivar/excluir sem abrir a conversa.
  function fecharMenuContexto() {
    const menu = document.querySelector(".wpp-menu-contexto");
    if (menu) menu.remove();
  }
  // As etiquetas mudam pouco e o menu de contexto precisa abrir na hora
  // do clique (não dá pra esperar a rede), então ficam em cache. Quem
  // cria/renomeia/exclui limpa o cache.
  async function obterEtiquetas(forcar) {
    if (forcar) state._tagsCache = null;
    if (!state._tagsCache) {
      try { state._tagsCache = await chamarApi("/whatsapp/tags"); }
      catch (e) { state._tagsCache = []; }
    }
    return state._tagsCache;
  }

  // Monta as linhas de etiqueta do menu: cada uma liga/desliga na hora,
  // com ✓ nas que a conversa já tem. A lista resultante vai junto no
  // próprio item (data-tags), pra ação não precisar consultar de novo.
  function _itensEtiquetaMenu(conversaId, marcadasAtuais, etiquetas, interna) {
    const marcadas = marcadasAtuais.map(Number);
    const linhas = etiquetas.map((t) => {
      const tem = marcadas.includes(Number(t.id));
      const depois = tem ? marcadas.filter((x) => x !== Number(t.id)) : [...marcadas, Number(t.id)];
      return {
        acao: "alternar-etiqueta-conversa",
        id: conversaId,
        rotulo: escapeHtml(t.nome),
        cor: t.cor || "#6b7280",
        marcado: tem,
        dados: { tags: JSON.stringify(depois), interna: interna ? "1" : "0" },
      };
    });
    return [
      { separador: true, rotulo: "Etiquetas" },
      ...linhas,
      { acao: "nova-etiqueta-conversa", id: conversaId, rotulo: "➕ Nova etiqueta…", dados: { tags: JSON.stringify(marcadas), interna: interna ? "1" : "0" } },
      { acao: "excluir-etiqueta-escolher-menu", id: conversaId, rotulo: "🗑️ Excluir uma etiqueta…", dados: { interna: interna ? "1" : "0" } },
    ];
  }

  // Cliente e chat interno guardam etiqueta em tabelas diferentes (a
  // conversa é de tipo diferente), mas a etiqueta em si é a mesma da
  // empresa — daí só o endereço mudar.
  function _redesenharCanal(interna) {
    const id = Number(location.hash.split("/")[2]) || null;
    return interna ? renderChatInterno(id) : renderWhatsapp(id);
  }

  function _urlTagsDaConversa(id, interna) {
    return interna ? `/chat-interno/conversas/${id}/tags` : `/whatsapp/conversas/${id}/tags`;
  }

  function abrirMenuContexto(x, y, itens) {
    fecharMenuContexto();
    const menu = document.createElement("div");
    menu.className = "wpp-menu-contexto";
    menu.innerHTML = itens.map((it) => {
      if (it.separador) return `<div class="wpp-menu-contexto-titulo">${escapeHtml(it.rotulo)}</div>`;
      // data-* extras deixam o item carregar o que a ação precisa (ex.:
      // a lista de etiquetas que a conversa fica tendo depois do clique).
      const extras = Object.entries(it.dados || {})
        .map(([k, v]) => ` data-${k}="${escapeHtml(String(v))}"`).join("");
      const bolinha = it.cor ? `<span class="wpp-menu-contexto-cor" style="background:${escapeHtml(it.cor)};"></span>` : "";
      const marca = it.marcado === undefined ? "" : `<span class="wpp-menu-contexto-marca">${it.marcado ? "✓" : ""}</span>`;
      return `<button type="button" class="wpp-menu-contexto-item" data-acao="${it.acao}" data-id="${it.id}"${extras}>${marca}${bolinha}${it.rotulo}</button>`;
    }).join("");
    document.body.appendChild(menu);
    const largura = menu.offsetWidth, altura = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - largura - 8) + "px";
    menu.style.top = Math.min(y, window.innerHeight - altura - 8) + "px";
    setTimeout(() => document.addEventListener("click", fecharMenuContexto, { once: true }), 0);
  }
  document.addEventListener("contextmenu", async (e) => {
    // Vale tanto no chip do FILTRO (lá em cima) quanto no chip que já
    // aparece pintado na lista de conversas e no cabeçalho da conversa
    // aberta (.wpp-tag-chip) — o mesmo botão direito, editar ou excluir
    // a etiqueta de verdade (não é só tirar dessa conversa, que é o que
    // o ✕ dela já fazia).
    const chip = e.target.closest(".wpp-tag-filtro, .wpp-tag-chip");
    if (!chip || !chip.dataset.id) return; // o "✕ limpar" do filtro não tem id, não abre menu
    e.preventDefault();
    e.stopImmediatePropagation(); // sem isso, o menu geral da conversa (cadastrado depois, no mesmo document) roda também e apaga este
    const interna = chip.classList.contains("wpp-tag-chip")
      ? chip.dataset.interna === "1"
      : chip.dataset.acao === "filtrar-por-etiqueta-interno";
    abrirMenuContexto(e.clientX, e.clientY, [
      { separador: true, rotulo: chip.dataset.nome },
      { acao: "editar-etiqueta-menu", id: chip.dataset.id, rotulo: "✏️ Editar (nome/cor)", dados: { interna: interna ? "1" : "0" } },
      { acao: "excluir-etiqueta-menu", id: chip.dataset.id, rotulo: "🗑️ Excluir etiqueta",
        dados: { nome: chip.dataset.nome, interna: interna ? "1" : "0" } },
    ]);
  });

  document.addEventListener("contextmenu", async (e) => {
    const item = e.target.closest("[data-wpp-conversa-id]");
    if (!item) return;
    e.preventDefault();
    const id = item.dataset.wppConversaId;
    const arquivada = item.dataset.wppArquivada === "1";
    const marcadas = JSON.parse(item.dataset.wppTags || "[]");
    const etiquetas = await obterEtiquetas();
    abrirMenuContexto(e.clientX, e.clientY, [
      { acao: "fechar-conversa", id, rotulo: "✅ Encerrar atendimento" },
      { acao: "contexto-agendar", id, rotulo: "🕒 Agendar mensagem" },
      { acao: "contexto-lembrete", id, rotulo: "🔔 Abrir lembrete" },
      { acao: arquivada ? "desarquivar-conversa" : "arquivar-conversa", id, rotulo: arquivada ? "📤 Desarquivar" : "🗄️ Arquivar" },
      { acao: "excluir-conversa", id, rotulo: "🗑️ Excluir conversa" },
      ..._itensEtiquetaMenu(id, marcadas, etiquetas),
    ]);
  });

  // Clique direito em cima do nome no topo da conversa (WhatsApp ou chat
  // interno) já abre direto a tela de editar nome/apelido — mesmo botão
  // ✏️ que já existe ali, só um atalho mais rápido pra chegar nele.
  document.addEventListener("contextmenu", async (e) => {
    const item = e.target.closest("[data-wpp-interno-id]");
    if (!item) return;
    e.preventDefault();
    const etiquetas = await obterEtiquetas();
    abrirMenuContexto(e.clientX, e.clientY,
      _itensEtiquetaMenu(item.dataset.wppInternoId, JSON.parse(item.dataset.wppTags || "[]"), etiquetas, true));
  });

  document.addEventListener("contextmenu", async (e) => {
    const nomeEl = e.target.closest(".wpp-chat-nome");
    if (!nomeEl) return;
    const botaoTags = document.querySelector('[data-acao="abrir-tags-conversa"], [data-acao="abrir-tags-interna"]');
    // Sem nem o lápis de editar nome, nem o botão de etiquetar (caso
    // raríssimo — tela ainda não montou de todo) não tem menu nenhum
    // pra oferecer.
    const botaoEditar = nomeEl.querySelector('[data-acao="renomear-contato"], [data-acao="abrir-apelido-interno"]');
    if (!botaoEditar && !botaoTags) return;
    e.preventDefault();
    // Quem só SUPERVISIONA (admin vendo pela aba "Todas", sem ser dono
    // nem participante) não tem o lápis — não editar o nome de quem
    // não é dele, mas etiqueta é anotação PRÓPRIA de quem clica, então
    // continua valendo mesmo supervisionando.
    if (!botaoTags) { if (botaoEditar) botaoEditar.click(); return; }
    const interna = botaoTags.dataset.acao === "abrir-tags-interna"
      || botaoTags.getAttribute("data-acao") === "abrir-tags-interna";
    const id = botaoTags.dataset.id;
    const marcadas = JSON.parse(botaoTags.dataset.tags || "[]");
    const etiquetas = await obterEtiquetas();
    abrirMenuContexto(e.clientX, e.clientY, [
      ...(botaoEditar ? [{ acao: interna ? "abrir-apelido-interno-menu" : "renomear-contato-menu", id,
        rotulo: interna ? "✏️ Editar como você chama esta pessoa" : "✏️ Editar nome do contato" }] : []),
      ..._itensEtiquetaMenu(id, marcadas, etiquetas, interna),
    ]);
  });

  // =======================================================================
  // LOGIN
  // =======================================================================
  function renderLogin() {
    const flashHtml = state.flash
      ? `<div class="mensagem-erro flash-aviso">
           <span>${escapeHtml(state.flash.texto)}</span>
           <button type="button" class="flash-fechar" data-acao="fechar-flash" title="Fechar">✕</button>
         </div>`
      : "";
    const corpo = state._aguardando2fa ? `
        <form data-form="login-2fa" autocomplete="off">
          <p class="texto-suave">Digite o código de 6 dígitos do seu app autenticador (ou um código de recuperação).</p>
          <div class="campo">
            <label for="login-codigo-2fa">Código de verificação</label>
            <input id="login-codigo-2fa" name="codigo_2fa" inputmode="numeric" autocomplete="one-time-code" required autofocus>
          </div>
          <button class="botao largura-total" type="submit">Confirmar</button>
          <p class="dica" style="text-align:center; margin-top:14px;"><a href="#" data-acao="cancelar-2fa">← Voltar</a></p>
        </form>` : `
        <form data-form="login" autocomplete="on">
          <div class="campo">
            <label for="login-email">Email</label>
            <input id="login-email" name="email" type="email" autocomplete="username" value="${escapeHtml(state.emailLembrado)}" required ${state.emailLembrado ? "" : "autofocus"}>
          </div>
          <div class="campo">
            <label for="login-senha">Senha</label>
            <div class="campo-senha">
              <input id="login-senha" name="senha" type="password" autocomplete="current-password" required ${state.emailLembrado ? "autofocus" : ""}>
              <button type="button" class="botao-mostrar-senha" data-acao="alternar-mostrar-senha" title="Mostrar/ocultar senha" tabindex="-1">👁️</button>
            </div>
          </div>
          <div class="campo campo-checkbox"><label><input type="checkbox" name="lembrar" ${state.emailLembrado ? "checked" : ""}> Lembrar meu email neste aparelho</label></div>
          <button class="botao largura-total" type="submit">Entrar</button>
          <p class="dica" style="text-align:center; margin-top:14px;">O navegador pode oferecer para salvar sua senha — assim você não precisa digitar de novo.</p>
        </form>`;
    app.innerHTML = `
      <div class="tela-login">
        <div class="cartao-login">
          <div class="logo-3d-wrap"><img class="logo-3d" src="${state.logoUrl || "/static/img/logo_alphafitus.png"}" alt="" data-wpp-logo></div>
          <h1>Seja Alpha</h1>
          <p class="subtitulo">Caixa de entrada compartilhada de WhatsApp</p>
          ${flashHtml}
          ${corpo}
        </div>
      </div>`;
    state.flash = null;
  }

  // =======================================================================
  // BOLINHA DE STATUS DO WHATSAPP — sempre visível na barra lateral,
  // qualquer tela, pra qualquer usuário (não só admin) saber de relance
  // se o número está conectado.
  // =======================================================================
  const ROTULO_STATUS_WHATSAPP = {
    conectado: ["ativo", "🟢 Online"],
    aguardando_qrcode: ["aguardando", "🟡 Aguardando QR Code"],
    desconectado: ["inativo", "🔴 Offline"],
    erro: ["inativo", "🔴 Erro de conexão"],
  };

  // Gravação de mensagem de voz (composer da conversa) — variáveis de
  // módulo porque a gravação precisa sobreviver entre o clique de
  // iniciar e o clique de parar, sem depender de nenhum estado de tela.
  let _gravador = null, _gravadorChunks = [], _gravadorTimer = null;
  // Ligada quando o envio foi pedido por Enter/seta durante a gravação:
  // aí o áudio vai direto, sem a tela de prévia.
  let _enviarAudioDireto = false;

  function _estaGravando() {
    return !!(_gravador && _gravador.state === "recording");
  }

  /** Para a gravação e manda na hora. Devolve true se havia gravação
      rolando (pra quem chamou saber que não deve enviar o texto). */
  function _pararEEnviarAudio() {
    if (!_estaGravando()) return false;
    _enviarAudioDireto = true;
    _gravador.stop();
    return true;
  }

  // Sobe um arquivo pra uma conversa (de cliente ou interna) — as duas
  // telas mandam do mesmo jeito, só muda o endereço.
  const LIMITE_ANEXO_MB = 90; // pedido do Clayton 2026-08-31 -- servidor tem disco de sobra, sem motivo pra segurar PDF/vídeo comum de trabalho

  // Aceita tanto o <input type="file"> (seletor de arquivo normal) quanto
  // uma lista de arquivos "solta" (drag-and-drop, sem input nenhum por
  // trás) -- por isso o primeiro parâmetro pode ser os dois.
  async function _enviarVariosAnexos(campoOuArquivos, url) {
    const ehCampo = campoOuArquivos instanceof HTMLElement;
    const campo = ehCampo ? campoOuArquivos : null;
    const arquivos = [...((ehCampo ? campoOuArquivos.files : campoOuArquivos) || [])];
    if (!arquivos.length) return;

    // Grandes demais saem da fila aqui, com nome e tudo: antes o arquivo
    // sumia calado e a pessoa só descobria não vendo ele na conversa.
    const grandes = arquivos.filter((a) => a.size > LIMITE_ANEXO_MB * 1024 * 1024);
    const fila = arquivos.filter((a) => a.size <= LIMITE_ANEXO_MB * 1024 * 1024);
    if (grandes.length) {
      definirFlash("erro", `Passaram de ${LIMITE_ANEXO_MB}MB e não foram enviados: ${grandes.map((a) => a.name).join(", ")}.`);
    }
    if (!fila.length) { if (campo) campo.value = ""; return; }

    if (campo) campo.disabled = true;
    // Um de cada vez, na ordem em que foram escolhidos. Em paralelo
    // seria mais rápido e chegaria fora de ordem — numa conversa, a
    // ordem é a informação.
    const falhas = [];
    for (let i = 0; i < fila.length; i++) {
      if (fila.length > 1) definirFlash("ok", `Enviando ${i + 1} de ${fila.length}…`);
      try {
        await _subirAnexo(url, fila[i]);
      } catch (erro) {
        falhas.push(`${fila[i].name} (${erro.message || "falhou"})`);
      }
    }
    if (campo) { campo.disabled = false; campo.value = ""; }   // sem isso, escolher os mesmos arquivos de novo não dispara nada

    if (falhas.length) definirFlash("erro", `Não consegui enviar: ${falhas.join("; ")}.`);
    else if (fila.length > 1) definirFlash("ok", `${fila.length} arquivos enviados.`);
  }

  async function _subirAnexo(url, arquivo, tipoForcado, legenda) {
    const formData = new FormData();
    formData.append("arquivo", arquivo, arquivo.name || "arquivo");
    if (tipoForcado) formData.append("tipo", tipoForcado);
    if (legenda) formData.append("legenda", legenda);
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + state.accessToken },
      body: formData,
    });
    if (!resp.ok) {
      const corpo = await resp.json().catch(() => ({}));
      throw new Error(corpo.mensagem || `Erro ${resp.status}`);
    }
  }

  // Prévia da gravação: ouvir antes de mandar evita o clássico "mandei
  // um áudio sem querer / falei errado". Enter manda, Esc descarta.
  function _valorDataHoraPadrao(horasNaFrente) {
    const d = new Date(Date.now() + horasNaFrente * 3600 * 1000);
    // input datetime-local espera hora LOCAL, sem fuso no texto
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function modalLembreteInterno(conversaId) {
    abrirModal(`
      <h3 style="margin-top:0;">🔔 Lembrete</h3>
      <p class="dica">Fica atrelado a esta conversa interna e avisa <strong>só você</strong> na hora marcada.</p>
      <form data-form="lembrete-interno" data-conversa-id="${conversaId}">
        <div class="campo"><label>Quando me avisar</label><input type="datetime-local" name="quando" value="${_valorDataHoraPadrao(24)}" required></div>
        <div class="campo"><label>Sobre o quê (opcional)</label><textarea name="texto" rows="2" placeholder="Ex.: cobrar a resposta do orçamento"></textarea></div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Criar lembrete</button>
        </div>
      </form>`);
  }

  function modalAgendarInterno(conversaId) {
    abrirModal(`
      <h3 style="margin-top:0;">🕒 Agendar mensagem</h3>
      <p class="dica">Escreva agora e o colega recebe na hora marcada. Funciona mesmo com o WhatsApp desconectado — é entrega interna.</p>
      <form data-form="agendar-interno" data-conversa-id="${conversaId}">
        <div class="campo"><label>Enviar em</label><input type="datetime-local" name="quando" value="${_valorDataHoraPadrao(24)}" required></div>
        <div class="campo"><label>Mensagem</label><textarea name="texto" rows="3" required></textarea></div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Agendar</button>
        </div>
      </form>`);
  }

  async function modalAgendarEmMassa() {
    const eu = state.usuarioAtual.id;
    let colegas;
    try {
      colegas = (await chamarApi("/usuarios")).filter((u) => u.ativo && u.id !== eu);
    } catch (e) {
      definirFlash("erro", "Não consegui carregar a lista de colegas.");
      return;
    }
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">🕒 Agendar mensagem para vários</h3>
      <p class="dica">Escreve agora, escolhe quem recebe e quando — cada um recebe na própria conversa, todos no mesmo horário.</p>
      <div class="campo">
        <label><input type="checkbox" data-agendar-massa-todos checked> Selecionar todos (${colegas.length})</label>
      </div>
      <div class="wpp-encaminhar-lista" style="margin-bottom:12px; max-height:32vh; overflow-y:auto;">
        ${colegas.map((c) => `
          <label class="wpp-encaminhar-item">
            <input type="checkbox" data-agendar-massa-usuario value="${c.id}" checked>
            <span class="wpp-encaminhar-nome">${c.online ? "🟢" : "🔴"} ${escapeHtml(c.nome)}</span>
            <span class="wpp-encaminhar-tel">${escapeHtml(_setoresDoColega(c).join(", ") || "")}</span>
          </label>`).join("")}
      </div>
      <div class="campo"><label>Mensagem</label><textarea data-agendar-massa-texto rows="4" placeholder="Escreva a mensagem..." required></textarea></div>
      <div class="campo"><label>Enviar em</label><input type="datetime-local" data-agendar-massa-quando value="${_valorDataHoraPadrao(24)}" required></div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-acao="confirmar-agendar-em-massa">Agendar</button>
      </div>`, "modal-largo");

    const checkTodos = wrap.querySelector("[data-agendar-massa-todos]");
    const checksIndividuais = () => [...wrap.querySelectorAll("[data-agendar-massa-usuario]")];
    checkTodos.addEventListener("change", () => {
      checksIndividuais().forEach((cx) => { cx.checked = checkTodos.checked; });
    });
    checksIndividuais().forEach((cx) => {
      cx.addEventListener("change", () => {
        checkTodos.checked = checksIndividuais().every((c) => c.checked);
      });
    });
  }

  function modalAgendarContato(conversaId) {
    // Sugere amanhã às 10h: é o caso mais comum e evita digitação.
    const amanha = new Date(Date.now() + 24 * 3600 * 1000);
    const dataPadrao = amanha.toISOString().slice(0, 10);
    abrirModal(`
      <h3 style="margin-top:0;">📞 Próximo contato</h3>
      <p class="dica">Enquanto essa data não chegar, o sistema não vai cobrar você por essa conversa.</p>
      <form data-form="agendar-contato" data-conversa-id="${conversaId}">
        <div style="display:flex; gap:8px;">
          <div class="campo" style="flex:1;"><label>Data</label><input type="date" name="data" value="${dataPadrao}" required></div>
          <div class="campo" style="flex:1;"><label>Horário</label><input type="time" name="hora" value="10:00" required></div>
        </div>
        <div class="campo"><label>Forma de contato</label>
          <select name="forma">
            <option value="whatsapp">WhatsApp</option>
            <option value="ligacao">Ligação</option>
            <option value="email">E-mail</option>
            <option value="outro">Outro</option>
          </select>
        </div>
        <div class="campo"><label>Observação (opcional)</label><textarea name="observacao" rows="2" placeholder="Ex.: retornar com o orçamento revisado"></textarea></div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Agendar follow-up</button>
        </div>
      </form>`);
  }

  function modalAdiar(conversaId) {
    const opcoes = [["1h", "1 hora"], ["amanha", "Amanhã"], ["2dias", "2 dias"], ["3dias", "3 dias"], ["7dias", "7 dias"]];
    abrirModal(`
      <h3 style="margin-top:0;">Adiar follow-up</h3>
      <p class="dica">Só silencia o aviso por um tempo — diferente de agendar, não é um compromisso com o cliente.</p>
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin:14px 0;">
        ${opcoes.map(([v, r]) => `<button type="button" class="botao secundario" data-acao="adiar-rapido" data-id="${conversaId}" data-quanto="${v}">${r}</button>`).join("")}
      </div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
      </div>`);
  }

  /** Enquadrar a foto antes de salvar: a foto sai recortada em círculo,
      e sem isto quem manda uma foto de corpo inteiro fica com o rosto
      cortado. Mostra grande, deixa arrastar e dar zoom, e envia só o
      pedaço escolhido (recortado aqui no navegador — o servidor recebe
      a imagem já pronta). */
  function modalEnquadrarFoto(arquivo, aoConfirmar) {
    const LADO = 320;   // tamanho da área de recorte na tela
    const SAIDA = 512;  // resolução final salva
    const url = URL.createObjectURL(arquivo);
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">Ajustar foto</h3>
      <p class="dica">Arraste pra posicionar e use o controle pra aproximar. O que ficar dentro do círculo é o que vai aparecer.</p>
      <div class="foto-enquadrar" style="width:${LADO}px;height:${LADO}px;">
        <canvas data-foto-canvas width="${LADO}" height="${LADO}"></canvas>
        <div class="foto-enquadrar-mascara"></div>
      </div>
      <div class="campo" style="margin-top:14px;">
        <label>Aproximar</label>
        <input type="range" data-foto-zoom min="1" max="4" step="0.01" value="1">
      </div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-foto-salvar>Salvar foto</button>
      </div>`);

    const canvas = wrap.querySelector("[data-foto-canvas]");
    const ctx = canvas.getContext("2d");
    const zoom = wrap.querySelector("[data-foto-zoom]");
    const img = new Image();
    let escalaBase = 1, escala = 1, deslocX = 0, deslocY = 0;

    function desenhar() {
      ctx.clearRect(0, 0, LADO, LADO);
      const l = img.width * escalaBase * escala;
      const a = img.height * escalaBase * escala;
      // Não deixa arrastar além da borda: sempre sobra imagem cobrindo
      // o círculo inteiro, sem faixa vazia.
      deslocX = Math.min(0, Math.max(LADO - l, deslocX));
      deslocY = Math.min(0, Math.max(LADO - a, deslocY));
      ctx.drawImage(img, deslocX, deslocY, l, a);
    }

    img.onload = () => {
      // "cover": a menor dimensão preenche o quadro
      escalaBase = Math.max(LADO / img.width, LADO / img.height);
      deslocX = (LADO - img.width * escalaBase) / 2;
      deslocY = (LADO - img.height * escalaBase) / 2;
      desenhar();
    };
    img.src = url;

    let arrastando = false, ultimoX = 0, ultimoY = 0;
    const iniciar = (x, y) => { arrastando = true; ultimoX = x; ultimoY = y; };
    const mover = (x, y) => {
      if (!arrastando) return;
      deslocX += x - ultimoX; deslocY += y - ultimoY;
      ultimoX = x; ultimoY = y;
      desenhar();
    };
    canvas.addEventListener("mousedown", (e) => iniciar(e.clientX, e.clientY));
    window.addEventListener("mousemove", (e) => mover(e.clientX, e.clientY));
    window.addEventListener("mouseup", () => { arrastando = false; });
    canvas.addEventListener("touchstart", (e) => iniciar(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    canvas.addEventListener("touchmove", (e) => { mover(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, { passive: false });
    canvas.addEventListener("touchend", () => { arrastando = false; });

    zoom.addEventListener("input", () => {
      // Aproxima mirando o centro, senão a imagem "foge" do enquadramento.
      const antes = escala;
      escala = parseFloat(zoom.value);
      const fator = escala / antes;
      deslocX = LADO / 2 - (LADO / 2 - deslocX) * fator;
      deslocY = LADO / 2 - (LADO / 2 - deslocY) * fator;
      desenhar();
    });

    wrap.querySelector("[data-foto-salvar]").addEventListener("click", () => {
      const fora = document.createElement("canvas");
      fora.width = fora.height = SAIDA;
      fora.getContext("2d").drawImage(canvas, 0, 0, LADO, LADO, 0, 0, SAIDA, SAIDA);
      fora.toBlob((blob) => {
        URL.revokeObjectURL(url);
        fecharModais();
        aoConfirmar(new File([blob], "foto.png", { type: "image/png" }));
      }, "image/png");
    });
  }

  function modalPreviaAudio(blob, url, aoTerminar, botaoGravar) {
    const src = URL.createObjectURL(blob);
    const seg = Math.round(blob.size / 16000); // estimativa só pra dar noção do tamanho
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">🎙️ Áudio gravado</h3>
      <p class="dica">Ouça antes de enviar. Se não gostou, é só regravar.</p>
      <audio controls autofocus src="${src}" style="width:100%; margin:10px 0;"></audio>
      <p class="texto-suave" style="font-size:12px;">Aproximadamente ${seg}s${seg > 60 ? " (áudio longo)" : ""}</p>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao-previa="descartar">Descartar</button>
        <button type="button" class="botao secundario" data-acao-previa="regravar">Regravar</button>
        <button type="button" class="botao" data-acao-previa="enviar">Enviar áudio</button>
      </div>`);

    const limpar = () => { URL.revokeObjectURL(src); fecharModais(); };

    const enviar = async () => {
      limpar();
      definirFlash("ok", "Enviando áudio…");
      montarRota();
      try {
        // tipo="audio" explícito: o nome (audio.webm) não distingue de
        // um vídeo .webm, já que o navegador grava áudio dentro de webm.
        await _subirAnexo(url, blob, "audio");
        definirFlash("ok", "Áudio enviado.");
      } catch (e) {
        definirFlash("erro", "Erro ao enviar áudio: " + e.message);
      }
      return aoTerminar();
    };

    wrap.addEventListener("click", (e) => {
      const acao = e.target.closest("[data-acao-previa]");
      if (!acao) return;
      const qual = acao.dataset.acaoPrevia;
      if (qual === "enviar") return enviar();
      limpar();
      if (qual === "regravar" && botaoGravar && botaoGravar.isConnected) botaoGravar.click();
    });

    // Enter envia, Esc descarta — mesma lógica do resto do sistema.
    //
    // BUG REAL corrigido (relatado pela Andreia, 2026-09-02): mandar
    // pelo BOTÃO do mouse fechava o modal mas nunca tirava este
    // listener do documento inteiro — ele ficava vivo escutando Enter.
    // Qualquer Enter digitado DEPOIS (ex.: mandando uma mensagem de
    // texto na sequência) reenviava o MESMO áudio de novo, sem ninguém
    // pedir. Agora, se o modal já não está mais na tela (fechou por
    // outro caminho), o próprio listener se desliga em vez de agir —
    // mesmo padrão já usado em modalFotoAmpliada.
    const teclas = (e) => {
      if (!wrap.isConnected) { document.removeEventListener("keydown", teclas); return; }
      if (e.key === "Enter") { e.preventDefault(); document.removeEventListener("keydown", teclas); enviar(); }
      if (e.key === "Escape") { document.removeEventListener("keydown", teclas); limpar(); }
    };
    document.addEventListener("keydown", teclas);
  }

  // Primeiro clique começa a gravar, segundo para e envia. Serve pras
  // duas telas: quem chama diz pra onde mandar e o que redesenhar
  // depois.
  // Gravar vídeo pela câmera do próprio aparelho e mandar pro cliente.
  //
  // Sempre com prévia: vídeo é o anexo mais fácil de sair errado
  // (enquadramento, som, alguém passando atrás) e o mais constrangedor
  // de mandar por engano. E tem limite de tempo — 2 minutos já passa
  // do limite de anexo do WhatsApp e a gravação seria perdida no fim.
  const SEGUNDOS_MAX_VIDEO = 120;
  let _gravadorVideo = null;
  let _videoChunks = [];
  let _videoTimer = null;

  async function _gravarVideo(url, aoTerminar) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: true,
      });
    } catch (e) {
      definirFlash("erro", "Não consegui acessar a câmera — verifique a permissão do navegador pra este site.");
      return montarRota();
    }

    const wrap = abrirModal(`
      <h3 style="margin-top:0;">🎥 Gravar vídeo</h3>
      <div class="wpp-video-palco">
        <video data-camera autoplay muted playsinline></video>
        <span class="wpp-video-tempo" data-tempo hidden>● 0:00</span>
      </div>
      <div class="campo" style="margin-top:10px;">
        <label class="rotulo-forte">Escrever junto (opcional)</label>
        <textarea name="legenda" rows="2" placeholder="Ex.: olha como fica montado"></textarea>
      </div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-fechar-camera>Cancelar</button>
        <button type="button" class="botao" data-gravar>● Gravar</button>
      </div>`);

    const video = wrap.querySelector("[data-camera]");
    const tempo = wrap.querySelector("[data-tempo]");
    const botaoGravar = wrap.querySelector("[data-gravar]");
    const botaoFechar = wrap.querySelector("[data-fechar-camera]");
    video.srcObject = stream;

    // A câmera fica ligada enquanto a janela existe — desligar sempre
    // que ela sair, por qualquer caminho, senão a luz do aparelho fica
    // acesa e a pessoa (com razão) acha que está sendo filmada.
    const desligar = () => {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* já parou */ }
      clearInterval(_videoTimer);
    };
    botaoFechar.addEventListener("click", () => { desligar(); fecharModais(); });
    wrap.addEventListener("click", (e) => { if (e.target === wrap) desligar(); });

    let gravando = false;
    botaoGravar.addEventListener("click", () => {
      if (gravando) { _gravadorVideo.stop(); return; }
      gravando = true;
      _videoChunks = [];
      _gravadorVideo = new MediaRecorder(stream, { mimeType: _tipoDeVideoSuportado() });
      _gravadorVideo.ondataavailable = (e) => { if (e.data.size > 0) _videoChunks.push(e.data); };
      _gravadorVideo.onstop = () => {
        gravando = false;
        clearInterval(_videoTimer);
        desligar();
        const gravado = new Blob(_videoChunks, { type: _tipoDeVideoSuportado() });
        fecharModais();
        if (gravado.size < 2000) { definirFlash("erro", "Gravação muito curta — tente de novo."); return montarRota(); }
        const nome = `video-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.webm`;
        _previaVideoGravado(new File([gravado], nome, { type: gravado.type }), url, aoTerminar,
                            wrap.querySelector('textarea[name="legenda"]').value.trim());
      };
      _gravadorVideo.start();
      const inicio = Date.now();
      tempo.hidden = false;
      botaoGravar.textContent = "■ Parar";
      botaoGravar.classList.add("botao-perigo-suave");
      _videoTimer = setInterval(() => {
        const seg = Math.floor((Date.now() - inicio) / 1000);
        tempo.textContent = `● ${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, "0")}`;
        if (seg >= SEGUNDOS_MAX_VIDEO) _gravadorVideo.stop();
      }, 250);
    });
  }

  function _tipoDeVideoSuportado() {
    // Nem todo navegador aceita os mesmos formatos; pega o primeiro que
    // este aqui grava, em vez de assumir um e falhar em silêncio.
    for (const t of ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    }
    return "video/webm";
  }

  function _previaVideoGravado(arquivo, url, aoTerminar, legendaInicial) {
    const endereco = URL.createObjectURL(arquivo);
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">🎥 Conferir antes de enviar</h3>
      <div class="wpp-video-palco"><video src="${endereco}" controls playsinline></video></div>
      <div class="campo" style="margin-top:10px;">
        <label class="rotulo-forte">Escrever junto (opcional)</label>
        <textarea name="legenda" rows="2" placeholder="Ex.: olha como fica montado"></textarea>
      </div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Descartar</button>
        <button type="button" class="botao" data-enviar-video>Enviar</button>
      </div>`);
    const legenda = wrap.querySelector('textarea[name="legenda"]');
    legenda.value = legendaInicial || "";
    wrap.querySelector("[data-enviar-video]").addEventListener("click", async (ev) => {
      const botao = ev.currentTarget;
      botao.disabled = true;
      botao.textContent = "Enviando…";
      try {
        await _subirAnexo(url, arquivo, "video", legenda.value.trim());
        URL.revokeObjectURL(endereco);
        fecharModais();
        if (aoTerminar) await aoTerminar();
      } catch (erro) {
        botao.disabled = false;
        botao.textContent = "Enviar";
        definirFlash("erro", erro.message || "Não consegui enviar o vídeo.");
        montarRota();
      }
    });
  }

  async function _alternarGravacaoAudio(botao, url, aoTerminar) {
    if (_gravador && _gravador.state === "recording") {
      _gravador.stop(); // o resto acontece no onstop, registrado abaixo
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      definirFlash("erro", "Não consegui acessar o microfone — verifique a permissão do navegador pra este site.");
      return;
    }
    _gravadorChunks = [];
    _gravador = new MediaRecorder(stream);
    _gravador.ondataavailable = (e) => { if (e.data.size > 0) _gravadorChunks.push(e.data); };
    _gravador.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(_gravadorTimer);
      _atualizarBotaoGravacao(botao, false);
      const gravado = new Blob(_gravadorChunks, { type: "audio/webm" });
      if (gravado.size < 800) { definirFlash("erro", "Gravação muito curta — tente de novo."); return; }
      const blob = new File([gravado], "audio.webm", { type: "audio/webm" });
      // Enter ou a seta de envio durante a gravação = manda na hora, sem
      // passar pela prévia. Parar pelo próprio microfone abre a prévia,
      // pra quem quer conferir antes.
      if (_enviarAudioDireto) {
        _enviarAudioDireto = false;
        definirFlash("ok", "Enviando áudio…");
        montarRota();
        try {
          await _subirAnexo(url, blob, "audio");
          definirFlash("ok", "Áudio enviado.");
        } catch (e) {
          definirFlash("erro", "Erro ao enviar áudio: " + e.message);
        }
        return aoTerminar();
      }
      modalPreviaAudio(blob, url, aoTerminar, botao);
    };
    _gravador.start();
    _atualizarBotaoGravacao(botao, true, 0);
    const inicioGravacao = Date.now();
    _gravadorTimer = setInterval(() => _atualizarBotaoGravacao(botao, true, Date.now() - inicioGravacao), 500);
  }

  function _atualizarBotaoGravacao(btn, gravando, ms) {
    if (!btn || !btn.isConnected) return;
    if (gravando) {
      const seg = Math.floor((ms || 0) / 1000);
      btn.textContent = `⏹ ${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, "0")}`;
      btn.classList.add("gravando");
      btn.title = "Parar e enviar";
    } else {
      btn.textContent = "🎙️";
      btn.classList.remove("gravando");
      btn.title = "Gravar áudio";
    }
  }

  let timerStatusGlobal = null;
  let timerBadgesNaoLidos = null;
  function pararPollingStatusGlobal() {
    if (timerStatusGlobal) { clearInterval(timerStatusGlobal); timerStatusGlobal = null; }
    if (timerBadgesNaoLidos) { clearInterval(timerBadgesNaoLidos); timerBadgesNaoLidos = null; }
  }
  function iniciarPollingStatusGlobal() {
    if (timerStatusGlobal) return;
    atualizarBadgeSla();
    atualizarBadgesNaoLidos();
    verificarVersaoServidor();
    timerStatusGlobal = setInterval(() => { atualizarBolinhaStatusGlobal(); verificarVersaoServidor(); atualizarBadgeSla(); }, 8000);
    // Mais rápido que o resto — é o que avisa "chegou mensagem nova",
    // roda em qualquer tela (não só Conversas/Chat interno), pra piscar
    // o menu lateral mesmo se a pessoa estiver, por exemplo, no Dashboard.
    timerBadgesNaoLidos = setInterval(atualizarBadgesNaoLidos, 4000);
    _atualizarContadorDoIcone();
    setInterval(_atualizarContadorDoIcone, 8000);
    // Follow-up muda em dias, não em segundos — 60s já é de sobra e
    // evita consulta pesada a cada 4s.
    atualizarContadorFollowup();
    setInterval(atualizarContadorFollowup, 60000);
    // Chamada de voz "tocando" -- 2,5s dá uma latência baixa o
    // suficiente pra parecer telefone de verdade sem martelar o
    // servidor. Roda em QUALQUER tela, igual o resto dos avisos.
    _verificarChamadaPendente();
    setInterval(_verificarChamadaPendente, 2500);
  }

  // Avisa (com bolinha piscando no menu lateral) que chegou mensagem nova
  // — de cliente (Conversas) ou de colega (Chat interno) — mesmo que a
  // pessoa não esteja olhando pra nenhuma das duas telas agora.
  // Aviso sonoro de mensagem nova. Os sons são gerados na hora (Web
  // Audio) em vez de arquivos .mp3: não depende de baixar nada, funciona
  // offline e não estoura o limite de conteúdo externo. São dois toques
  // bem diferentes pra dar pra saber, sem olhar a tela, se veio cliente
  // ou colega.
  let _audioCtx = null;
  function _contextoAudio() {
    if (!_audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      _audioCtx = new Ctx();
    }
    // O navegador só libera som depois de algum clique; a primeira vez
    // costuma vir suspensa, então destrava aqui.
    if (_audioCtx.state === "suspended") _audioCtx.resume().catch(() => {});
    return _audioCtx;
  }

  function _tocarNotas(notas) {
    const ctx = _contextoAudio();
    if (!ctx) return;
    notas.forEach(({ hz, inicio, duracao, volume = 0.16 }) => {
      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      const t0 = ctx.currentTime + inicio;
      // Sobe e desce o volume suavemente — sem isso o som "estala".
      ganho.gain.setValueAtTime(0.0001, t0);
      ganho.gain.exponentialRampToValueAtTime(volume, t0 + 0.02);
      ganho.gain.exponentialRampToValueAtTime(0.0001, t0 + duracao);
      osc.connect(ganho).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duracao + 0.02);
    });
  }

  // Igual _tocarNotas, mas GUARDA o oscilador rodando -- os toques de
  // chamada (que duram até 4,5s) precisam poder ser cortados na hora
  // quando alguém desliga, e não só "parar de agendar o próximo".
  let _osciladoresDeChamada = [];
  function _tocarNotasCortaveis(notas) {
    const ctx = _contextoAudio();
    if (!ctx) return;
    notas.forEach(({ hz, inicio, duracao, volume = 0.16 }) => {
      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      const t0 = ctx.currentTime + inicio;
      ganho.gain.setValueAtTime(0.0001, t0);
      ganho.gain.exponentialRampToValueAtTime(volume, t0 + 0.02);
      ganho.gain.exponentialRampToValueAtTime(0.0001, t0 + duracao);
      osc.connect(ganho).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duracao + 0.02);
      _osciladoresDeChamada.push({ osc, ganho });
      osc.onended = () => { _osciladoresDeChamada = _osciladoresDeChamada.filter((o) => o.osc !== osc); };
    });
  }
  function _cortarSomDeChamadaNaHora() {
    const ctx = _audioCtx;
    _osciladoresDeChamada.forEach(({ osc, ganho }) => {
      try {
        if (ctx) {
          // Corta o volume rapidinho antes de parar o oscilador -- sem
          // isso dá um "pop" audível ao interromper no meio do som.
          ganho.gain.cancelScheduledValues(ctx.currentTime);
          ganho.gain.setValueAtTime(ganho.gain.value, ctx.currentTime);
          ganho.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.03);
          osc.stop(ctx.currentTime + 0.04);
        } else {
          osc.stop();
        }
      } catch (e) {}
    });
    _osciladoresDeChamada = [];
  }

  // Cliente no WhatsApp: dois toques subindo, mais agudo e "chamativo".
  // Cliente no WhatsApp: ~1,6s, subindo. Era um "ding" de 0,35s que se
  // perdia em sala com movimento — quem estava de costas pro
  // computador não pegava. Continua mais curto e mais agudo que o do
  // chat interno, pra dar pra saber de qual dos dois é sem olhar.
  function tocarAvisoWhatsapp() {
    _tocarNotas([
      { hz: 880,  inicio: 0,    duracao: 0.15, volume: 0.13 },
      { hz: 1318, inicio: 0.17, duracao: 0.15, volume: 0.13 },
      { hz: 1046, inicio: 0.36, duracao: 0.15, volume: 0.12 },
      { hz: 1318, inicio: 0.55, duracao: 0.17, volume: 0.13 },
      { hz: 1568, inicio: 0.76, duracao: 0.20, volume: 0.14 },
      { hz: 1318, inicio: 1.00, duracao: 0.18, volume: 0.12 },
      { hz: 1760, inicio: 1.22, duracao: 0.40, volume: 0.14 },
    ]);
  }

  // "Chamar atenção" no chat interno: bem mais insistente que o toque
  // normal de mensagem nova — 4 bipes secos e agudos, quase um alarme,
  // pra dar pra notar mesmo sem olhar a tela nem prestar atenção nela.
  function tocarAvisoAtencao() {
    _tocarNotas([
      { hz: 1760, inicio: 0,    duracao: 0.13, volume: 0.19 },
      { hz: 1760, inicio: 0.22, duracao: 0.13, volume: 0.19 },
      { hz: 1760, inicio: 0.44, duracao: 0.13, volume: 0.19 },
      { hz: 1760, inicio: 0.66, duracao: 0.13, volume: 0.19 },
      { hz: 1760, inicio: 0.98, duracao: 0.13, volume: 0.20 },
      { hz: 1760, inicio: 1.20, duracao: 0.13, volume: 0.20 },
      { hz: 1760, inicio: 1.42, duracao: 0.13, volume: 0.20 },
      { hz: 1760, inicio: 1.64, duracao: 0.90, volume: 0.21 },
    ]);
  }

  // Colega no chat interno: sequência mais longa e grave (4 notas
  // descendo, ~1s). O toque do cliente é curto e agudo; alongar este
  // aqui deixa a diferença óbvia sem precisar olhar a tela.
  function tocarAvisoChatInterno() {
    // ~3,6s: melodia grave que desce, sobe e fecha com uma nota longa.
    // Continua sendo a mais longa das duas — é assim que se sabe, sem
    // olhar, que quem chamou foi um colega e não um cliente.
    _tocarNotas([
      { hz: 659, inicio: 0,    duracao: 0.20, volume: 0.13 },
      { hz: 587, inicio: 0.24, duracao: 0.20, volume: 0.13 },
      { hz: 494, inicio: 0.48, duracao: 0.20, volume: 0.13 },
      { hz: 440, inicio: 0.72, duracao: 0.24, volume: 0.13 },
      { hz: 392, inicio: 1.00, duracao: 0.28, volume: 0.14 },
      { hz: 349, inicio: 1.32, duracao: 0.28, volume: 0.14 },
      { hz: 392, inicio: 1.64, duracao: 0.24, volume: 0.13 },
      { hz: 440, inicio: 1.92, duracao: 0.24, volume: 0.13 },
      { hz: 494, inicio: 2.20, duracao: 0.24, volume: 0.13 },
      { hz: 587, inicio: 2.48, duracao: 0.28, volume: 0.14 },
      { hz: 494, inicio: 2.80, duracao: 0.24, volume: 0.13 },
      { hz: 587, inicio: 3.08, duracao: 0.55, volume: 0.15 },
    ]);
  }

  // ---------------------------------------------------------------
  // FOLLOW-UP — painel lateral discreto: contador sempre visível, lista
  // só quando aberta (pra não pesar as telas nem roubar espaço).
  // ---------------------------------------------------------------
  const ROTULO_SITUACAO = {
    agendado_vencido: ["🔴", "Retorno prometido e não cumprido"],
    atrasado: ["🔴", "Sem contato há tempo demais"],
    proximo_do_vencimento: ["🟠", "Perto de vencer"],
    agendado: ["🟢", "Contato agendado"],
    adiado: ["⚪", "Adiado"],
    em_dia: ["🟢", "Em dia"],
  };

  // Som do follow-up: três notas iguais e espaçadas, diferente dos
  // outros dois avisos (cliente e colega) — é cobrança de pendência, não
  // mensagem nova chegando.
  function tocarAvisoFollowup() {
    _tocarNotas([
      { hz: 660, inicio: 0,    duracao: 0.14, volume: 0.12 },
      { hz: 660, inicio: 0.28, duracao: 0.14, volume: 0.12 },
      { hz: 660, inicio: 0.56, duracao: 0.24, volume: 0.12 },
    ]);
  }

  async function atualizarContadorFollowup() {
    const contador = document.querySelector("[data-followup-contador]");
    if (!contador) return;
    try {
      const r = await chamarApi("/followup/resumo");
      const total = r.total_pendente || 0;
      contador.hidden = total === 0;
      contador.textContent = total > 99 ? "99+" : String(total);
      contador.classList.toggle("piscando", total > 0);

      // Avisa quando APARECE pendência nova (o número subiu). Sem essa
      // comparação, tocaria a cada minuto enquanto houvesse pendência.
      if (state.followupPendentes !== null && total > state.followupPendentes) {
        tocarAvisoFollowup();
        const novos = total - state.followupPendentes;
        definirFlash("erro", `🔔 ${novos} cliente(s) precisam de contato — veja em Follow-up.`);
        if (window.Notification && Notification.permission === "granted") {
          try {
            new Notification("Follow-up necessário", {
              body: `${total} cliente(s) sem retorno esperando contato.`,
              tag: "followup", // substitui o aviso anterior em vez de empilhar
            });
          } catch (e) { /* navegador pode recusar, não é crítico */ }
        }
        // Se a pessoa está numa tela qualquer, o flash só aparece na
        // próxima troca de tela — repinta a atual pra ela ver na hora.
        if (!document.querySelector(".fundo-modal")) montarRota();
      }
      state.followupPendentes = total;
    } catch (e) { /* próximo tick corrige */ }
  }

  // Lembrete/agendamento pode ser de uma conversa de CLIENTE ou de uma
  // INTERNA. Este helper resolve o nome e o link certos pros dois casos
  // — sem ele, os itens internos apareciam sem nome nenhum na lista.
  function _alvoDoItem(item) {
    if (item.origem === "interno") {
      const eu = state.usuarioAtual && state.usuarioAtual.id;
      // Mostra o OUTRO lado da conversa, não quem criou.
      const outro = item.interna_criador_id === eu ? item.interna_participante : item.interna_criador;
      return {
        rotulo: `${outro || "—"} <span class="selo">interno</span>`,
        href: `#/chat-interno/${item.chat_interno_conversa_id}`,
      };
    }
    return {
      rotulo: escapeHtml(item.contato_nome || item.telefone || "—"),
      href: `#/whatsapp/${item.conversa_id}`,
    };
  }

  function _fmtDataCurta(iso) {
    const d = iso ? new Date(iso.endsWith("Z") ? iso : iso + "Z") : null;
    if (!d || isNaN(d)) return "—";
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function htmlItemFollowup(i) {
    const [cor, rotulo] = ROTULO_SITUACAO[i.situacao] || ["⚪", i.situacao];
    const detalhe = i.situacao === "agendado" || i.situacao === "agendado_vencido"
      ? `Contato marcado pra ${_fmtDataCurta(i.quando)}`
      : `${i.dias_parado} dia(s) sem retorno · prazo ${i.prazo_dias}d`;
    return `
      <div class="followup-item followup-${i.situacao}">
        <div class="followup-item-topo">
          <strong>${escapeHtml(i.contato_nome || "")}</strong>
          <span title="${escapeHtml(rotulo)}">${cor}</span>
        </div>
        <div class="texto-suave" style="font-size:11.5px;">${escapeHtml(detalhe)}</div>
        <div class="texto-suave" style="font-size:11.5px;">
          ${i.responsavel_nome ? "Resp.: " + escapeHtml(i.responsavel_nome) : "<em>sem responsável</em>"}
          ${i.menu_setor ? " · 🏷️ " + escapeHtml(i.menu_setor) : ""}
        </div>
        <div class="followup-item-acoes">
          <a class="botao pequeno" href="#/whatsapp/${i.conversa_id}" data-acao="fechar-followup">Abrir</a>
          <button type="button" class="botao secundario pequeno" data-acao="abrir-agendar-contato" data-id="${i.conversa_id}">Agendar</button>
          <button type="button" class="botao secundario pequeno" data-acao="abrir-adiar" data-id="${i.conversa_id}">Adiar</button>
          ${i.responsavel_id && i.responsavel_id !== state.usuarioAtual.id
            ? `<button type="button" class="botao secundario pequeno" data-acao="avisar-atraso-followup"
                 data-usuario="${i.responsavel_id}" data-nome="${escapeHtml(i.responsavel_nome || "")}"
                 data-cliente="${escapeHtml(i.contato_nome || "")}" data-dias="${i.dias_parado || 0}" data-prazo="${i.prazo_dias || 0}"
                 title="Manda um lembrete no chat interno pra ${escapeHtml(i.responsavel_nome || "o responsável")}">🔔 Avisar</button>`
            : ""}
        </div>
      </div>`;
  }

  // Os três números do topo do painel são FILTROS, e cada um mostra
  // exatamente o que ele conta. Por isso a classificação é feita aqui,
  // sobre a mesma lista que vai pra tela — se fosse contada no servidor
  // por outro critério, o número e a lista podiam discordar (era o que
  // acontecia: "0 agendados" com um agendamento logo abaixo).
  const FILTROS_FOLLOWUP = {
    atrasados: { rotulo: "atrasados", bolinha: "🔴", vazio: "Nada atrasado. 👏" },
    hoje: { rotulo: "pra hoje", bolinha: "🟠", vazio: "Nada marcado para hoje." },
    agendados: { rotulo: "agendados", bolinha: "🟢", vazio: "Nada agendado pra frente." },
  };

  function _quandoDoItem(x) {
    return x.quando || x.agendado_para || x.lembrar_em || null;
  }

  // atrasado = a hora já passou. hoje = ainda vai acontecer, mas hoje.
  // agendado = de amanhã em diante.
  function _faixaDoItem(x) {
    if (x.situacao === "atrasado" || x.situacao === "agendado_vencido") return "atrasados";
    if (x.situacao === "proximo_do_vencimento") return "hoje";
    const quando = _quandoDoItem(x);
    if (!quando) return "hoje";
    const d = new Date(quando.endsWith("Z") ? quando : quando + "Z");
    if (d < new Date()) return "atrasados";
    return d.toDateString() === new Date().toDateString() ? "hoje" : "agendados";
  }

  async function carregarPainelFollowup() {
    const alvo = document.querySelector("[data-followup-conteudo]");
    if (!alvo) return;
    try {
      // Três coisas diferentes, no mesmo painel porque a pergunta é a
      // mesma ("o que eu tenho pra fazer?"), mas cada uma com seu rótulo
      // porque funcionam de jeitos diferentes:
      //  - Follow-up: cliente sem retorno há tempo demais (o sistema
      //    descobre sozinho).
      //  - Agendamento: mensagem que o sistema ENVIA ao contato na hora
      //    marcada, e some daqui depois de enviada.
      //  - Lembrete: aviso só pra você, não vai pra ninguém.
      // Admin pode olhar o de uma pessoa só. O parâmetro vai nas três
      // listas juntas — meio painel filtrado e meio não seria pior do
      // que não filtrar nada.
      const souAdmin = !!(state.usuarioAtual && state.usuarioAtual.admin);
      const dePessoa = souAdmin ? (state.followupUsuario || "") : "";
      const q = dePessoa ? `?usuario_id=${dePessoa}` : (souAdmin ? "?todos=1" : "");
      const qFollow = dePessoa ? `?usuario_id=${dePessoa}` : "";
      const [itens, agendadas, lembretes, colegas] = await Promise.all([
        chamarApi(`/followup${qFollow}`),
        chamarApi(`/whatsapp/agendadas${q}`).catch(() => []),
        chamarApi(`/whatsapp/lembretes${q}`).catch(() => []),
        souAdmin ? chamarApi("/usuarios").catch(() => []) : Promise.resolve([]),
      ]);
      const followups = itens.filter((i) => i.situacao !== "adiado");
      const tudo = [
        ...followups.map((x) => ({ tipo: "followup", dado: x, faixa: _faixaDoItem(x) })),
        ...agendadas.map((x) => ({ tipo: "agendada", dado: x, faixa: _faixaDoItem(x) })),
        ...lembretes.map((x) => ({ tipo: "lembrete", dado: x, faixa: _faixaDoItem(x) })),
      ];
      const conta = (faixa) => tudo.filter((x) => x.faixa === faixa).length;
      const filtro = state.followupFiltro || null;
      const mostrados = filtro ? tudo.filter((x) => x.faixa === filtro) : tudo;

      const grupo = (tipo) => mostrados.filter((x) => x.tipo === tipo).map((x) => x.dado);
      const doFollowup = grupo("followup");
      const dasAgendadas = grupo("agendada");
      const dosLembretes = grupo("lembrete");

      const chips = Object.entries(FILTROS_FOLLOWUP).map(([chave, cfg]) => `
        <button type="button" class="followup-chip ${filtro === chave ? "ativo" : ""}"
                data-acao="filtrar-followup" data-filtro="${chave}"
                title="${filtro === chave ? "Clique de novo pra ver tudo" : `Ver só o que está ${cfg.rotulo}`}">
          ${cfg.bolinha} ${conta(chave)} ${cfg.rotulo}
        </button>`).join("");

      const secao = (titulo, dica, lista, desenha, vazio) => {
        // Com um filtro ligado, seção sem nada some — senão o painel
        // vira uma lista de "nenhum, nenhum, nenhum".
        if (filtro && !lista.length) return "";
        return `<div class="followup-secao">${titulo} <span class="followup-secao-dica">${dica}</span></div>` +
          (lista.length ? lista.map(desenha).join("")
                        : `<p class="texto-suave" style="padding:10px 12px; font-size:12.5px;">${vazio}</p>`);
      };

      const seletor = souAdmin ? `
        <div class="followup-quem">
          <label>Ver de:</label>
          <select data-acao-change="filtrar-followup-usuario">
            <option value="">Todo mundo</option>
            ${colegas.filter((u) => u.ativo).map((u) => `
              <option value="${u.id}" ${String(dePessoa) === String(u.id) ? "selected" : ""}>${escapeHtml(u.nome)}</option>`).join("")}
          </select>
        </div>` : "";

      alvo.innerHTML = `
        ${seletor}
        <div class="followup-resumo">${chips}</div>
        ${filtro ? `<div class="followup-filtro-aviso">Mostrando só <strong>${FILTROS_FOLLOWUP[filtro].rotulo}</strong> · <button type="button" class="followup-limpar" data-acao="filtrar-followup" data-filtro="">ver tudo</button></div>` : ""}
        ${filtro && !mostrados.length ? `<p class="texto-suave" style="padding:12px;">${FILTROS_FOLLOWUP[filtro].vazio}</p>` : ""}
        ${secao("📞 Clientes sem retorno", "o sistema descobre sozinho", doFollowup, htmlItemFollowup,
                "Nada atrasado. 👏 Esta lista se preenche sozinha conforme os clientes ficam sem retorno — pra marcar um retorno, abra a conversa e clique no 📞 no topo.")}
        ${secao("🕒 Mensagens agendadas", "o sistema envia sozinho na hora marcada", dasAgendadas, htmlItemAgendadaFollowup,
                "Nenhuma mensagem agendada.")}
        ${secao("🔔 Meus lembretes", "aviso só pra você, não vai pra ninguém", dosLembretes, htmlItemLembreteFollowup,
                "Nenhum lembrete marcado.")}`;
    } catch (e) {
      alvo.innerHTML = `<p class="texto-suave" style="padding:12px;">Não consegui carregar agora.</p>`;
    }
  }

  function _quemFollowup(item) {
    if (item.origem === "interno") {
      const eu = state.usuarioAtual.id;
      const outro = item.interna_criador_id === eu ? item.interna_participante : item.interna_criador;
      return `💬 ${escapeHtml(outro || item.interna_criador || "colega")}`;
    }
    return escapeHtml(item.contato_nome || item.telefone || "—");
  }

  function _linkFollowup(item) {
    return item.origem === "interno"
      ? `#/chat-interno/${item.chat_interno_conversa_id || item.interna_id || ""}`
      : `#/whatsapp/${item.conversa_id}`;
  }

  function _atrasado(quando) {
    return !!quando && new Date(quando.endsWith("Z") ? quando : quando + "Z") < new Date();
  }

  function htmlItemAgendadaFollowup(a) {
    const vencida = _atrasado(a.agendado_para);
    return `<div class="followup-item">
      <a class="followup-item-topo" href="${_linkFollowup(a)}" data-acao="fechar-followup">
        <strong>${_quemFollowup(a)}</strong>
        <span class="followup-quando ${vencida ? "followup-vencido" : ""}">${fmtData(a.agendado_para)}</span>
      </a>
      <div class="followup-item-texto">${escapeHtml((a.texto || "📎 Anexo").slice(0, 120))}</div>
      <div class="followup-item-acoes">
        <button type="button" class="botao secundario pequeno" data-acao="editar-agendada" data-id="${a.id}" data-texto="${escapeHtml(a.texto || "")}" data-quando="${escapeHtml(a.agendado_para || "")}">Editar</button>
        <button type="button" class="botao secundario pequeno" data-acao="cancelar-agendada-followup" data-id="${a.id}">Cancelar</button>
      </div>
    </div>`;
  }

  function htmlItemLembreteFollowup(l) {
    const vencido = _atrasado(l.lembrar_em);
    return `<div class="followup-item">
      <a class="followup-item-topo" href="${_linkFollowup(l)}" data-acao="fechar-followup">
        <strong>${_quemFollowup(l)}</strong>
        <span class="followup-quando ${vencido ? "followup-vencido" : ""}">${fmtData(l.lembrar_em)}</span>
      </a>
      <div class="followup-item-texto">${escapeHtml((l.texto || "Retomar o contato").slice(0, 120))}</div>
      <div class="followup-item-acoes">
        <button type="button" class="botao secundario pequeno" data-acao="prorrogar-lembrete-followup" data-id="${l.id}">Prorrogar</button>
        <button type="button" class="botao secundario pequeno" data-acao="concluir-lembrete-followup" data-id="${l.id}">Concluir</button>
      </div>
    </div>`;
  }

  async function atualizarBadgesNaoLidos() {
    // Sem acesso às conversas, não há o que contar — e chamar a API só
    // renderia 403 a cada 4 segundos.
    if (!_podeVerConversas()) return;
    try {
      // Conta pelas duas abas: "fila" é onde ficam as que estão
      // esperando resposta (é lá que a mensagem nova cai), e "minhas"
      // pega as em andamento que receberam algo novo entre uma resposta
      // e outra. Sem somar as duas, o aviso ficaria sempre zerado.
      const [emAndamento, aguardando] = await Promise.all([
        chamarApi("/whatsapp/conversas?escopo=minhas"),
        chamarApi("/whatsapp/conversas?escopo=fila"),
      ]);
      const vistas = new Set();
      const total = [...emAndamento, ...aguardando].reduce((soma, c) => {
        if (vistas.has(c.id)) return soma; // não conta a mesma conversa duas vezes
        vistas.add(c.id);
        return soma + (c.nao_lidas || 0);
      }, 0);
      const badge = document.querySelector("[data-wpp-nao-lidas-badge]");
      if (badge) {
        badge.hidden = total === 0;
        badge.textContent = total > 99 ? "99+" : String(total);
        badge.classList.toggle("piscando", total > 0);
      }
      // Só toca quando o número SOBE. Na primeira contagem depois de
      // entrar, state.naoLidasWpp ainda é null — sem essa guarda, tocaria
      // pras mensagens que já estavam lá esperando.
      if (state.naoLidasWpp !== null && total > state.naoLidasWpp) tocarAvisoWhatsapp();
      state.naoLidasWpp = total;
    } catch (e) { /* próxima tentativa corrige */ }
    try {
      const conversasInternas = await chamarApi("/chat-interno/conversas");
      const meuId = state.usuarioAtual && state.usuarioAtual.id;
      const total = conversasInternas.reduce((soma, c) => soma + (c.criado_por_id === meuId ? (c.nao_lidas_criador || 0) : (c.nao_lidas_participante || 0)), 0);
      const badge = document.querySelector("[data-wpp-chat-interno-nao-lidas-badge]");
      if (badge) {
        badge.hidden = total === 0;
        badge.textContent = total > 99 ? "99+" : String(total);
        badge.classList.toggle("piscando", total > 0);
      }
      if (state.naoLidasInterno !== null && total > state.naoLidasInterno) tocarAvisoChatInterno();
      state.naoLidasInterno = total;

      // "Chamar atenção": cada toque muda o instante gravado pro MEU
      // lado (ver chamar_atencao no backend). Comparar com o que a
      // gente já viu detecta toques novos, mesmo repetidos na mesma
      // conversa — é assim que dá pra apertar "quantas vezes for
      // necessário" e cada uma toca de novo.
      if (!state.avisosAtencaoVistos) state.avisosAtencaoVistos = {};
      for (const c of conversasInternas) {
        const souCriador = c.criado_por_id === meuId;
        const emMim = souCriador ? c.aviso_criador_em : c.aviso_participante_em;
        if (!emMim) continue;
        const visto = state.avisosAtencaoVistos[c.id];
        if (visto === undefined) { state.avisosAtencaoVistos[c.id] = emMim; continue; } // primeira leitura: só guarda, não toca
        if (emMim !== visto) {
          state.avisosAtencaoVistos[c.id] = emMim;
          const nomeDeQuemChamou = souCriador ? c.participante_nome : c.criado_por_nome;
          tocarAvisoAtencao();
          _mostrarAvisoAtencao(nomeDeQuemChamou, c.id);
        }
      }
    } catch (e) { /* próxima tentativa corrige */ }
  }

  // Conversa "travada" (sem resposta nossa há tempo demais) — mesmo
  // limiar configurado em Configuração > Horário de funcionamento.
  async function atualizarBadgeSla() {
    const badge = document.querySelector("[data-wpp-sla-badge]");
    if (!badge) return;
    try {
      const alertas = await chamarApi("/whatsapp/sla-alertas");
      state.slaAlertasIds = new Set(alertas.map((c) => c.id));
      badge.hidden = alertas.length === 0;
      // O ⏱ separa este número do verde ao lado: um é atraso, o outro é
      // mensagem nova. Só a cor não bastava pra distinguir.
      badge.textContent = "⏱ " + (alertas.length > 99 ? "99+" : String(alertas.length));
      badge.title = alertas.length === 1
        ? "1 conversa parada: o cliente falou e ninguém respondeu dentro do tempo combinado"
        : `${alertas.length} conversas paradas: o cliente falou e ninguém respondeu dentro do tempo combinado`;
    } catch (e) { /* próxima tentativa corrige */ }
  }

  function tocarConfirmacaoAtencaoEnviada() {
    _tocarNotas([
      { hz: 1046, inicio: 0,    duracao: 0.09, volume: 0.11 },
      { hz: 1568, inicio: 0.10, duracao: 0.13, volume: 0.12 },
    ]);
  }

  // Banner flutuante de "fulano está chamando sua atenção" — aparece
  // em cima de QUALQUER tela (não só no chat interno), porque o toque
  // não serve de nada se só aparece pra quem já está olhando a
  // conversa certa. Some sozinho depois de um tempo, ou no X.
  function _mostrarAvisoAtencao(nome, conversaId) {
    const existente = document.querySelector("[data-wpp-aviso-atencao]");
    if (existente) existente.remove();
    const banner = document.createElement("div");
    banner.className = "wpp-aviso-atencao";
    banner.setAttribute("data-wpp-aviso-atencao", "");
    banner.innerHTML = `
      <span>📣 <strong>${escapeHtml(nome || "Alguém")}</strong> está chamando sua atenção no chat interno!</span>
      <a class="botao pequeno" href="#/chat-interno/${conversaId}">Ver conversa</a>
      <button type="button" class="botao-icone" title="Fechar">✕</button>`;
    banner.querySelector("button").addEventListener("click", () => banner.remove());
    banner.querySelector("a").addEventListener("click", () => banner.remove());
    document.body.appendChild(banner);
    setTimeout(() => { if (banner.isConnected) banner.remove(); }, 9000);
  }

  // ============================================================
  // Chamada de voz no chat interno (WebRTC) -- pedido do Clayton
  // (2026-09-04): "e possivel implantar fazer chamadas de voz no chat
  // interno? como se eu estivesse fazendo uma ligação porem somente no
  // chat interno".
  //
  // O áudio vai DIRETO de um navegador pro outro (WebRTC) -- o
  // servidor só entrega o "bilhete" (quem está ligando pra quem) e
  // troca as poucas mensagens técnicas de conexão (oferta/resposta e
  // candidatos ICE) através da tabela chat_interno_chamadas_sinais,
  // consultada por polling (mesmo padrão do resto do sistema, sem
  // WebSocket). Uma vez conectada, a chamada não depende mais do
  // servidor pra nada além de saber quando desligar.
  //
  // Só STUN público (Google) por enquanto, sem TURN -- funciona bem
  // dentro da rede da empresa e na maioria das redes domésticas; uma
  // rede corporativa muito restritiva do outro lado pode não conseguir
  // conectar (aí precisaria de um servidor TURN, que é peça de
  // infraestrutura à parte, não só código).
  const ICE_SERVERS_STUN = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

  // Servidor TURN próprio (montado 2026-09-04) -- sem ele, o áudio só
  // passa quando os dois lados acham um caminho direto (depende da
  // rede/NAT de cada um NAQUELE momento -- por isso as chamadas
  // pareciam "aleatórias": às vezes conectava, às vezes não). Credencial
  // de curta duração, então busca de novo se a guardada já vai vencer.
  let _turnCache = null;
  async function _obterIceServers() {
    const agora = Date.now();
    if (_turnCache && _turnCache.expiraEm > agora + 5 * 60 * 1000) return _turnCache.servidores;
    try {
      const r = await chamarApi("/chat-interno/chamadas/turn-credenciais");
      const servidores = [...ICE_SERVERS_STUN, ...(r.iceServers || [])];
      _turnCache = { servidores, expiraEm: agora + 6 * 60 * 60 * 1000 };
      return servidores;
    } catch (e) {
      return ICE_SERVERS_STUN; // sem TURN, a ligação ainda tenta -- só sem a rede de segurança
    }
  }

  function _limparEstadoChamada() {
    _pararToqueChamada();
    const c = state._chamada;
    if (!c) return;
    if (c.pollSinais) clearInterval(c.pollSinais);
    if (c.pollStatus) clearInterval(c.pollStatus);
    if (c.timerDuracao) clearInterval(c.timerDuracao);
    if (c.timerQueda) clearTimeout(c.timerQueda);
    if (c.pc) { try { c.pc.close(); } catch (e) {} }
    if (c.streamLocal) c.streamLocal.getTracks().forEach((t) => t.stop());
    if (c.audioEl) { c.audioEl.pause(); c.audioEl.remove(); }
    if (c.barra) c.barra.remove();
    state._chamada = null;
  }

  function _tocarToqueChamada() {
    _pararToqueChamada();
    const tocar = () => _tocarNotasCortaveis([
      { hz: 880, inicio: 0,    duracao: 0.35, volume: 0.20 },
      { hz: 740, inicio: 0.40, duracao: 0.35, volume: 0.20 },
      { hz: 880, inicio: 1.10, duracao: 0.35, volume: 0.20 },
      { hz: 740, inicio: 1.50, duracao: 0.35, volume: 0.20 },
    ]);
    tocar();
    state._chamadaToqueInterval = setInterval(tocar, 2600);
  }
  function _tocarToqueChamando() {
    _pararToqueChamada();
    // Tom de chamada de telefone de verdade: um "tummmm" comprido e
    // sustentado (não um bipe curto), dois por ciclo, com uma pausa --
    // pedido do Clayton depois de achar a primeira versão curta demais.
    const tocar = () => _tocarNotasCortaveis([
      { hz: 400, inicio: 0,   duracao: 4.5, volume: 0.13 },
      { hz: 400, inicio: 5.3, duracao: 4.5, volume: 0.13 },
    ]);
    tocar();
    state._chamadaToqueInterval = setInterval(tocar, 12000);
  }
  function _pararToqueChamada() {
    if (state._chamadaToqueInterval) { clearInterval(state._chamadaToqueInterval); state._chamadaToqueInterval = null; }
    // Corta o tom NA HORA -- antes só parava de agendar o próximo, e um
    // "tummmm" de 4,5s já em andamento continuava tocando sozinho até o
    // fim, dando a falsa impressão de que a ligação ainda estava de pé.
    _cortarSomDeChamadaNaHora();
  }

  window.addEventListener("pagehide", () => {
    const c = state._chamada;
    if (!c || !state.accessToken) return;
    const opts = { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + state.accessToken }, keepalive: true };
    try {
      fetch(`${API}/chat-interno/chamadas/${c.id}/sinal`, { ...opts, body: JSON.stringify({ tipo: "encerrar", dados: null }) });
      fetch(`${API}/chat-interno/chamadas/${c.id}/encerrar`, opts);
    } catch (e) {}
  });

  function _mmss(segundos) {
    const m = Math.floor(segundos / 60), s2 = Math.floor(segundos % 60);
    return `${String(m).padStart(2, "0")}:${String(s2).padStart(2, "0")}`;
  }

  // Barra "em chamada" -- fica visível em QUALQUER tela (fixa no body,
  // fora do #app), porque a pessoa pode continuar navegando o sistema
  // enquanto conversa, do mesmo jeito que um telefone de verdade.
  function _mostrarBarraChamada(nome, foto) {
    const existente = document.querySelector("[data-wpp-barra-chamada]");
    if (existente) existente.remove();
    const barra = document.createElement("div");
    barra.className = "wpp-barra-chamada";
    barra.setAttribute("data-wpp-barra-chamada", "");
    barra.innerHTML = `
      ${htmlAvatarContato(foto, nome, nome, 30)}
      <div class="wpp-barra-chamada-info">
        <strong>${escapeHtml(nome || "Colega")}</strong>
        <span data-wpp-chamada-cronometro>Conectando…</span>
      </div>
      <button type="button" class="botao-icone" data-wpp-chamada-mudo title="Mutar meu microfone">🎙️</button>
      <button type="button" class="botao-icone wpp-botao-desligar" data-wpp-chamada-desligar title="Encerrar chamada">📵</button>`;
    barra.querySelector("[data-wpp-chamada-mudo]").addEventListener("click", () => {
      const c = state._chamada;
      if (!c || !c.streamLocal) return;
      c.mudo = !c.mudo;
      c.streamLocal.getAudioTracks().forEach((t) => { t.enabled = !c.mudo; });
      barra.querySelector("[data-wpp-chamada-mudo]").textContent = c.mudo ? "🔇" : "🎙️";
      barra.querySelector("[data-wpp-chamada-mudo]").title = c.mudo ? "Reativar meu microfone" : "Mutar meu microfone";
    });
    barra.querySelector("[data-wpp-chamada-desligar]").addEventListener("click", () => _desligarChamada());
    document.body.appendChild(barra);
    if (state._chamada) state._chamada.barra = barra;
    return barra;
  }

  function _iniciarCronometro() {
    const c = state._chamada;
    if (!c) return;
    c.inicioEm = Date.now();
    const el = () => document.querySelector("[data-wpp-chamada-cronometro]");
    const atualiza = () => { const span = el(); if (span) span.textContent = _mmss((Date.now() - c.inicioEm) / 1000); };
    atualiza();
    c.timerDuracao = setInterval(atualiza, 1000);
  }

  async function _desligarChamada(motivoRemoto) {
    const c = state._chamada;
    if (!c) return;
    try { await chamarApi(`/chat-interno/chamadas/${c.id}/encerrar`, { method: "POST" }); } catch (e) { /* já foi, sem problema */ }
    if (!motivoRemoto) {
      // Avisa o outro lado na hora, sem esperar ele reparar sozinho no
      // status -- o poll de sinais dele já está rodando durante a
      // chamada e pega isto no próximo ciclo (até 1s de atraso).
      try { await chamarApi(`/chat-interno/chamadas/${c.id}/sinal`, { method: "POST", body: { tipo: "encerrar", dados: null } }); } catch (e) {}
    }
    definirFlash("ok", motivoRemoto || "Chamada encerrada.");
    _limparEstadoChamada();
    montarRota();
  }

  // Poll genérico dos sinais do OUTRO lado -- roda tanto em quem ligou
  // quanto em quem atendeu, depois que os dois já têm RTCPeerConnection
  // criada. Cuida de candidato ICE chegando aos poucos (trickle) e do
  // aviso de "encerrar" vindo do outro lado.
  function _iniciarPollSinais(chamadaId, aoReceber) {
    let ultimoId = state._chamada && state._chamada.ultimoSinalId || 0;
    const tick = async () => {
      if (!state._chamada || state._chamada.id !== chamadaId) return;
      try {
        const sinais = await chamarApi(`/chat-interno/chamadas/${chamadaId}/sinais?apos=${ultimoId}`);
        for (const sinal of sinais) {
          ultimoId = sinal.id;
          await aoReceber(sinal);
        }
      } catch (e) { /* próximo ciclo tenta de novo */ }
    };
    const id = setInterval(tick, 1000);
    if (state._chamada) { state._chamada.pollSinais = id; state._chamada.ultimoSinalId = ultimoId; }
    return id;
  }

  async function _configurarPeerConnection(chamadaId) {
    const iceServers = await _obterIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      chamarApi(`/chat-interno/chamadas/${chamadaId}/sinal`, {
        method: "POST", body: { tipo: "candidato", dados: ev.candidate.toJSON() },
      }).catch(() => {});
    };
    pc.ontrack = (ev) => {
      const c = state._chamada;
      if (!c) return;
      if (!c.audioEl) {
        c.audioEl = document.createElement("audio");
        c.audioEl.autoplay = true;
        c.audioEl.volume = 1;
        document.body.appendChild(c.audioEl);
      }
      c.audioEl.srcObject = ev.streams[0];
      const tentar = () => c.audioEl.play().catch(() => {
        // Navegador bloqueou o autoplay (comum com fone Bluetooth ou
        // Safari) -- avisa e deixa destravar com um toque na barra,
        // que aí conta como gesto do usuário de verdade.
        const span = document.querySelector("[data-wpp-chamada-cronometro]");
        if (span) span.textContent = "🔊 Toque aqui pra ouvir";
        const barra = document.querySelector("[data-wpp-barra-chamada]");
        if (barra) {
          const destravar = () => { c.audioEl.play().catch(() => {}); barra.removeEventListener("click", destravar); };
          barra.addEventListener("click", destravar, { once: true });
        }
      });
      tentar();
    };
    pc.onconnectionstatechange = () => {
      if (!state._chamada || state._chamada.id !== chamadaId) return;
      if (["failed", "closed"].includes(pc.connectionState)) {
        if (state._chamada.timerQueda) clearTimeout(state._chamada.timerQueda);
        _desligarChamada("A ligação caiu.");
      } else if (pc.connectionState === "disconnected") {
        // Costuma piscar e voltar sozinho (rede instável) -- só desiste
        // de verdade se continuar assim depois de um tempo.
        if (state._chamada.timerQueda) clearTimeout(state._chamada.timerQueda);
        state._chamada.timerQueda = setTimeout(() => {
          if (state._chamada && state._chamada.id === chamadaId && pc.connectionState === "disconnected") {
            _desligarChamada("A ligação caiu.");
          }
        }, 8000);
      } else if (pc.connectionState === "connected" && state._chamada.timerQueda) {
        clearTimeout(state._chamada.timerQueda);
        state._chamada.timerQueda = null;
      }
    };
    return pc;
  }

  async function _tratarSinalDurantaChamada(sinal) {
    const c = state._chamada;
    if (!c || !c.pc) return;
    if (sinal.tipo === "candidato") {
      try { await c.pc.addIceCandidate(sinal.dados); } catch (e) {}
    } else if (sinal.tipo === "resposta" && c.papel === "chamador") {
      await c.pc.setRemoteDescription(sinal.dados);
    } else if (sinal.tipo === "encerrar") {
      _desligarChamada(`${c.outroNome || "O colega"} encerrou a chamada.`);
    }
  }

  // ---- Quem LIGA --------------------------------------------------
  function _tocarSinalOcupado() {
    _pararToqueChamada();
    _tocarNotasCortaveis([
      { hz: 480, inicio: 0,    duracao: 0.35, volume: 0.16 },
      { hz: 480, inicio: 0.55, duracao: 0.35, volume: 0.16 },
      { hz: 480, inicio: 1.10, duracao: 0.35, volume: 0.16 },
    ]);
  }

  async function _ligarChamada(conversaId, nome) {
    if (state._chamada) { definirFlash("erro", "Você já está em uma chamada."); return montarRota(); }
    // Os dois saem JUNTOS, disparados já no mesmo instante do clique --
    // pedir o microfone só depois de esperar o POST responder faz
    // alguns navegadores não reconhecerem mais aquilo como resultado
    // direto do clique, e a permissão falha (só funcionava na tentativa
    // seguinte, sem esse atraso). Se der ocupado/offline, larga o
    // microfone que já tinha sido pedido, sem usar.
    const [resultadoChamada, resultadoMicrofone] = await Promise.allSettled([
      chamarApi(`/chat-interno/conversas/${conversaId}/chamadas`, { method: "POST" }),
      navigator.mediaDevices.getUserMedia({ audio: true }),
    ]);

    if (resultadoChamada.status === "rejected") {
      if (resultadoMicrofone.status === "fulfilled") resultadoMicrofone.value.getTracks().forEach((t) => t.stop());
      const e = resultadoChamada.reason;
      if (e.codigo === "usuario_ocupado") {
        _tocarSinalOcupado();
        definirFlash("erro", e.mensagem || `${nome || "O colega"} está em outra chamada agora.`);
      } else {
        definirFlash("erro", e.mensagem || "Não deu pra iniciar a chamada.");
      }
      return montarRota();
    }
    const resp = resultadoChamada.value;
    if (resultadoMicrofone.status === "rejected") {
      definirFlash("erro", "Não consegui acessar seu microfone. Verifique a permissão do navegador.");
      chamarApi(`/chat-interno/chamadas/${resp.id}/encerrar`, { method: "POST" }).catch(() => {});
      return montarRota();
    }
    const streamLocal = resultadoMicrofone.value;
    state._chamada = {
      id: resp.id, papel: "chamador", conversaId, outroNome: nome, streamLocal, mudo: false, ultimoSinalId: 0,
    };
    const pc = await _configurarPeerConnection(resp.id);
    state._chamada.pc = pc;
    streamLocal.getTracks().forEach((t) => pc.addTrack(t, streamLocal));

    const oferta = await pc.createOffer();
    await pc.setLocalDescription(oferta);
    await chamarApi(`/chat-interno/chamadas/${resp.id}/sinal`, { method: "POST", body: { tipo: "oferta", dados: oferta } });

    const barra = _mostrarBarraChamada(nome, null);
    barra.querySelector("[data-wpp-chamada-cronometro]").textContent = "Chamando…";
    barra.querySelector("[data-wpp-chamada-mudo]").hidden = true;
    _tocarToqueChamando();

    _iniciarPollSinais(resp.id, _tratarSinalDurantaChamada);

    // Enquanto ninguém atende, fica de olho no status (recusou? perdeu
    // o prazo de 60s sem resposta?) -- os sinais só chegam DEPOIS de
    // atendida, então isto aqui é o único jeito de saber antes disso.
    const pollStatus = setInterval(async () => {
      if (!state._chamada || state._chamada.id !== resp.id) { clearInterval(pollStatus); return; }
      try {
        const atual = await chamarApi(`/chat-interno/chamadas/${resp.id}`);
        if (atual.status === "atendida" && state._chamada.inicioEm === undefined) {
          clearInterval(pollStatus);
          _pararToqueChamada();
          const span = document.querySelector("[data-wpp-chamada-cronometro]");
          if (span) span.textContent = "Conectando…";
          const botaoMudo = document.querySelector("[data-wpp-chamada-mudo]");
          if (botaoMudo) botaoMudo.hidden = false;
          _iniciarCronometro();
        } else if (atual.status === "recusada") {
          clearInterval(pollStatus);
          _pararToqueChamada();
          _limparEstadoChamada();
          definirFlash("erro", `${nome || "O colega"} recusou a chamada.`);
          montarRota();
        } else if (atual.status === "perdida") {
          clearInterval(pollStatus);
          _pararToqueChamada();
          _limparEstadoChamada();
          definirFlash("erro", `${nome || "O colega"} não atendeu.`);
          montarRota();
        }
      } catch (e) {}
    }, 1500);
    state._chamada.pollStatus = pollStatus;
  }

  // ---- Quem RECEBE --------------------------------------------------
  function _mostrarChamadaRecebendo(chamada) {
    const existente = document.querySelector("[data-wpp-chamada-recebendo]");
    if (existente) existente.remove();
    const banner = document.createElement("div");
    banner.className = "wpp-aviso-atencao wpp-chamada-recebendo";
    banner.setAttribute("data-wpp-chamada-recebendo", "");
    banner.innerHTML = `
      ${htmlAvatarContato(chamada.de_foto, chamada.de_nome, chamada.de_nome, 34)}
      <span>📞 <strong>${escapeHtml(chamada.de_nome || "Alguém")}</strong> está te ligando…</span>
      <button type="button" class="botao pequeno" data-wpp-chamada-atender style="background:var(--verde-whatsapp, #1fa855);">Atender</button>
      <button type="button" class="botao secundario pequeno" data-wpp-chamada-recusar>Recusar</button>`;
    banner.querySelector("[data-wpp-chamada-atender]").addEventListener("click", () => _atenderChamada(chamada));
    banner.querySelector("[data-wpp-chamada-recusar]").addEventListener("click", () => _recusarChamada(chamada));
    document.body.appendChild(banner);
    _tocarToqueChamada();
    return banner;
  }

  async function _recusarChamada(chamada) {
    _pararToqueChamada();
    const banner = document.querySelector("[data-wpp-chamada-recebendo]");
    if (banner) banner.remove();
    state._chamadaRecebendoId = null;
    try { await chamarApi(`/chat-interno/chamadas/${chamada.id}/recusar`, { method: "POST" }); } catch (e) {}
  }

  async function _atenderChamada(chamada) {
    _pararToqueChamada();
    const banner = document.querySelector("[data-wpp-chamada-recebendo]");
    if (banner) banner.remove();
    state._chamadaRecebendoId = null;

    let streamLocal;
    try {
      streamLocal = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      definirFlash("erro", "Não consegui acessar seu microfone. Verifique a permissão do navegador.");
      try { await chamarApi(`/chat-interno/chamadas/${chamada.id}/recusar`, { method: "POST" }); } catch (e2) {}
      return montarRota();
    }

    state._chamada = {
      id: chamada.id, papel: "atendente", outroNome: chamada.de_nome, streamLocal, mudo: false, ultimoSinalId: 0,
    };
    const pc = await _configurarPeerConnection(chamada.id);
    state._chamada.pc = pc;
    streamLocal.getTracks().forEach((t) => pc.addTrack(t, streamLocal));

    // A oferta pode já ter chegado (quem liga manda assim que disca) ou
    // chegar nos próximos instantes -- busca o que tiver e continua
    // ouvindo pelo poll normal depois.
    let oferta = chamada._ofertaPreCarregada || null;
    for (let tentativa = 0; !oferta && tentativa < 10; tentativa++) {
      const sinais = await chamarApi(`/chat-interno/chamadas/${chamada.id}/sinais?apos=0`).catch(() => []);
      const doOferta = sinais.find((s) => s.tipo === "oferta");
      if (doOferta) { oferta = doOferta.dados; state._chamada.ultimoSinalId = doOferta.id; break; }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!oferta) {
      definirFlash("erro", "Não deu pra conectar a chamada (sinal não chegou a tempo).");
      _limparEstadoChamada();
      return montarRota();
    }

    await pc.setRemoteDescription(oferta);
    const resposta = await pc.createAnswer();
    await pc.setLocalDescription(resposta);

    await chamarApi(`/chat-interno/chamadas/${chamada.id}/atender`, { method: "POST" });
    await chamarApi(`/chat-interno/chamadas/${chamada.id}/sinal`, { method: "POST", body: { tipo: "resposta", dados: resposta } });

    _mostrarBarraChamada(chamada.de_nome, chamada.de_foto);
    _iniciarCronometro();
    _iniciarPollSinais(chamada.id, _tratarSinalDurantaChamada);
  }

  // Consultado a cada poucos segundos, em QUALQUER tela (ver
  // iniciarPollingStatusGlobal) -- é assim que o telefone "toca" mesmo
  // se a pessoa estiver, por exemplo, olhando o Dashboard.
  async function _verificarChamadaPendente() {
    if (state._chamada) return; // já atendendo/ligando outra -- não interrompe
    try {
      const pendente = await chamarApi("/chat-interno/chamadas/pendente");
      if (!pendente) {
        if (state._chamadaRecebendoId) {
          // Sumiu sozinha: quem ligou desistiu, ou os 60s sem resposta
          // estouraram no servidor.
          _pararToqueChamada();
          const banner = document.querySelector("[data-wpp-chamada-recebendo]");
          if (banner) banner.remove();
          state._chamadaRecebendoId = null;
        }
        return;
      }
      if (state._chamadaRecebendoId === pendente.id) return; // já mostrando esta
      state._chamadaRecebendoId = pendente.id;
      _mostrarChamadaRecebendo(pendente);
    } catch (e) { /* próximo ciclo tenta de novo */ }
  }

  function _mostrarConfirmacaoAtencaoEnviada(nome) {
    const existente = document.querySelector("[data-wpp-aviso-atencao]");
    if (existente) existente.remove();
    const banner = document.createElement("div");
    banner.className = "wpp-aviso-atencao wpp-aviso-atencao-enviado";
    banner.setAttribute("data-wpp-aviso-atencao", "");
    banner.innerHTML = `<span>📣 Aviso enviado pra <strong>${escapeHtml(nome || "o colega")}</strong>.</span>`;
    document.body.appendChild(banner);
    setTimeout(() => { if (banner.isConnected) banner.remove(); }, 2500);
  }

  // Faixa no alto da tela enquanto o WhatsApp está fora do ar. Some
  // sozinha quando reconecta.
  function _faixaDesconectado(status) {
    const caiu = status && status !== "conectado";
    let faixa = document.querySelector("[data-wpp-faixa-caiu]");
    if (!caiu) { if (faixa) faixa.remove(); return; }
    if (faixa) return;

    const souAdmin = !!(state.usuarioAtual && state.usuarioAtual.admin);
    faixa = document.createElement("div");
    faixa.className = "wpp-faixa-caiu";
    faixa.setAttribute("data-wpp-faixa-caiu", "");
    faixa.innerHTML = `
      <span><strong>WhatsApp desconectado.</strong> Nenhuma mensagem entra nem sai enquanto isso — o que você enviar agora não chega ao cliente.</span>
      ${souAdmin
        ? `<a class="botao pequeno" href="#/configuracao">Reconectar</a>`
        : `<span class="wpp-faixa-caiu-dica">Avise um administrador para reconectar.</span>`}`;
    document.body.appendChild(faixa);
  }

  async function atualizarBolinhaStatusGlobal() {
    const bolinha = document.querySelector("[data-wpp-status-bolinha]");
    const texto = document.querySelector("[data-wpp-status-texto]");
    if (!bolinha || !texto) return;
    try {
      const resp = await chamarApi("/whatsapp/status-resumido");
      const [classe, rotulo] = ROTULO_STATUS_WHATSAPP[resp.status_conexao] || ["desconhecido", "— Status desconhecido"];
      bolinha.className = "wpp-status-bolinha wpp-status-" + classe;
      texto.textContent = rotulo;
      _faixaDesconectado(resp.status_conexao);
    } catch (e) { /* próxima tentativa corrige */ }
  }

  // Detecta quando o backend sobe uma versão nova (a cada restart do
  // processo, ver VERSAO_SERVIDOR em app/__init__.py) e força todo mundo
  // a logar de novo — assim ninguém fica preso rodando o app.js velho
  // em cache depois de uma atualização.
  async function verificarVersaoServidor() {
    try {
      const resp = await fetch(`${API}/versao`).then((r) => r.json());
      if (!state.versaoServidor) {
        state.versaoServidor = resp.versao;
        const badge = document.querySelector("[data-wpp-versao]");
        if (badge) badge.textContent = `v${_versaoCurta(resp.versao)}`;
        return;
      }
      if (resp.versao === state.versaoServidor) return;
      pararPollingStatusGlobal();
      pararPollingLembretes();
      pararPollingWhatsapp();
      pararPollingStatusWhatsapp();
      // Sai da conta e recarrega de verdade — o Clayton preferiu assim
      // (2026-08-27): um recarregar sem sair as vezes nao bastava pra
      // garantir que o navegador largasse o JS antigo que ja estava
      // rodando em memoria. Deslogar forca uma pagina nova do zero, sem
      // chance de sobrar nada da versao anterior.
      try { await chamarApi("/auth/logout", { method: "POST", body: { refresh_token: state.refreshToken } }); } catch (e) { /* ignora */ }
      limparSessao();
      localStorage.setItem("whatts_flash_pos_reload", "O sistema foi atualizado — faça login novamente pra usar a versão mais recente.");
      location.reload();
    } catch (e) { /* próxima tentativa corrige */ }
  }

  // =======================================================================
  // ALERTA DE LEMBRETE VENCIDO — roda em segundo plano independente da
  // tela atual (ver chamada em montarRota), pra realmente "chamar" a
  // pessoa na hora marcada, não só deixar numa lista pra ela lembrar de
  // checar. Cada lembrete só dispara UMA vez por sessão do navegador
  // (state.lembretesAlertados) — reabrir a aba/sessão de novo antes de
  // concluí-lo dispara de novo, de propósito (mesmo espírito de um
  // alarme que continua tocando até alguém desligar).
  // ---------------------------------------------------------------------
  let timerLembretes = null;
  function pararPollingLembretes() { if (timerLembretes) { clearInterval(timerLembretes); timerLembretes = null; } }
  function iniciarPollingLembretes() {
    if (timerLembretes) return; // já rodando, não duplica
    if (window.Notification && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    verificarLembretesVencidos();
    timerLembretes = setInterval(verificarLembretesVencidos, 30000);
  }

  async function verificarLembretesVencidos() {
    try {
      const lembretes = await chamarApi("/whatsapp/lembretes");
      const agora = new Date();
      for (const l of lembretes) {
        if (state.lembretesAlertados.has(l.id)) continue;
        const quando = new Date(l.lembrar_em.endsWith("Z") ? l.lembrar_em : l.lembrar_em + "Z");
        if (quando <= agora) {
          state.lembretesAlertados.add(l.id);
          dispararAlertaLembrete(l);
        }
      }
    } catch (e) { /* próxima checagem tenta de novo */ }
  }

  function tocarBeepLembrete() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.16, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
    } catch (e) { /* navegador pode bloquear áudio sem interação prévia do usuário — o modal abaixo já chama atenção de qualquer forma */ }
  }

  function dispararAlertaLembrete(l) {
    tocarBeepLembrete();
    if (window.Notification && Notification.permission === "granted") {
      try { new Notification("🔔 Lembrete — Seja Alpha", { body: l.texto || `Hora de falar com ${l.origem === "interno" ? (l.interna_participante || l.interna_criador) : (l.contato_nome || l.telefone)} de novo` }); }
      catch (e) { /* ignora — o modal já avisa */ }
    }
    abrirModal(`
      <h3 style="margin-top:0;">🔔 Lembrete: hora de retornar!</h3>
      <p>${l.texto ? escapeHtml(l.texto) : "Você marcou pra falar com este cliente de novo agora."}</p>
      <p class="texto-suave">${l.origem === "interno" ? "Conversa interna com" : "Cliente"}: ${_alvoDoItem(l).rotulo} — previsto para ${fmtData(l.lembrar_em)}</p>
      <p class="dica"><strong>Concluir</strong> apaga o lembrete de vez. <strong>Prorrogar</strong> só empurra pra frente — ele continua aqui até você concluir.</p>
      <div class="campo">
        <label>Prorrogar para</label>
        <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px;">
          <button type="button" class="botao secundario pequeno" data-acao="prorrogar-rapido" data-minutos="60">+1 hora</button>
          <button type="button" class="botao secundario pequeno" data-acao="prorrogar-rapido" data-minutos="180">+3 horas</button>
          <button type="button" class="botao secundario pequeno" data-acao="prorrogar-rapido" data-minutos="1440">Amanhã</button>
          <button type="button" class="botao secundario pequeno" data-acao="prorrogar-rapido" data-minutos="10080">Semana que vem</button>
        </div>
        <input type="datetime-local" data-wpp-prorrogar-quando value="${_valorDataHoraPadrao(1)}">
      </div>
      <div class="rodape-modal">
        <a class="botao secundario" href="${_alvoDoItem(l).href}" data-acao="fechar-modal">Ver conversa</a>
        <button type="button" class="botao secundario" data-acao="prorrogar-lembrete" data-id="${l.id}">Prorrogar</button>
        <button type="button" class="botao" data-acao="concluir-lembrete-alerta" data-id="${l.id}">Concluir</button>
      </div>`);
  }

  // =======================================================================
  // WHATSAPP — caixa de entrada (abas: Minhas / Fila / Todas)
  // =======================================================================
  // ---------------------------------------------------------------
  // Novidades quase na hora, sem pesar no servidor
  //
  // Buscar a lista inteira de conversas várias vezes por segundo seria
  // caro. Em vez disso a tela pergunta "mudou alguma coisa?" — uma
  // resposta de quatro números — e só busca de verdade quando a
  // resposta muda. Assim dá pra perguntar a cada 400ms em vez de 1,2s,
  // e a mensagem aparece quase no instante em que chega.
  //
  // Com a aba escondida o ritmo cai: ninguém está olhando, e continuar
  // no mesmo ritmo só gastaria bateria e servidor à toa.
  const PULSO_ATIVO_MS = 400;
  const PULSO_ESCONDIDO_MS = 4000;
  let _pulsoAnterior = null;

  // Ao voltar pra aba, verifica imediatamente: quem estava em outra
  // janela quer ver o que chegou no instante em que olha de volta.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    _pulsoAnterior = null; // força uma busca de verdade agora
    if (location.hash.startsWith("#/whatsapp")) {
      const id = Number(location.hash.split("/")[2]) || null;
      atualizarListaConversasNoDom().catch(() => {});
      if (id) atualizarMensagensNoDom(id).catch(() => {});
    } else if (location.hash.startsWith("#/chat-interno")) {
      const id = Number(location.hash.split("/")[2]) || null;
      atualizarListaConversasInternasNoDom().catch(() => {});
      if (id) atualizarMensagensInternasNoDom(id).catch(() => {});
    }
  });

  async function mudouAlgo() {
    try {
      // Manda a conversa aberta junto: é a única em que o status das
      // mensagens (o ✓✓) muda alguma coisa na tela.
      const aberta = Number(location.hash.split("/")[2]) || null;
      const ehCliente = location.hash.startsWith("#/whatsapp");
      const p = await chamarApi(`/whatsapp/pulso${aberta && ehCliente ? `?conversa_id=${aberta}` : ""}`);
      _marcarNaBarraDeTarefas(p.n || 0, p.nc || 0, p.ni || 0);
      const assinatura = `${p.c}|${p.i}|${p.v}|${p.s}`;
      const mudou = _pulsoAnterior !== null && assinatura !== _pulsoAnterior;
      const primeira = _pulsoAnterior === null;
      _pulsoAnterior = assinatura;
      // Na primeira vez busca de qualquer jeito, pra tela não ficar
      // esperando alguém mandar mensagem pra se preencher.
      return mudou || primeira;
    } catch (e) {
      // Sem resposta (rede oscilou): tenta buscar mesmo assim, é melhor
      // do que congelar a tela.
      return true;
    }
  }

  // O número no ícone da barra de tarefas, como o do WhatsApp.
  //
  // Vale só pro sistema instalado como aplicativo (é o navegador que
  // desenha o balãozinho no ícone). Aberto numa aba comum, o número vai
  // pro título — que é o que aparece na aba e ao passar o mouse na barra.
  let _ultimoTotalNaBarra = -1;
  const TITULO_BASE = "Seja Alpha";

  // Guarda o ícone original uma vez só, pra poder redesenhar por cima
  // dele e também pra saber pra onde voltar quando zerar.
  let _iconeBase = null;

  async function _atualizarContadorDoIcone() {
    // Pergunta direto ao pulso, sem depender da tela aberta: o número no
    // ícone tem que estar certo mesmo com a pessoa no Dashboard.
    try {
      const p = await chamarApi("/whatsapp/pulso");
      _marcarNaBarraDeTarefas(p.n || 0, p.nc || 0, p.ni || 0);
    } catch (e) { /* próxima volta corrige */ }
  }

  function _pintarIcone(total) {
    const link = document.querySelector('link[rel="icon"][sizes="64x64"]')
              || document.querySelector('link[rel="icon"]');
    if (!link) return;
    if (!_iconeBase) _iconeBase = link.getAttribute("href");

    if (!total) {
      document.querySelectorAll('link[rel="icon"]').forEach((l) => l.setAttribute("href", _iconeBase));
      return;
    }

    const img = new Image();
    img.onload = () => {
      // 128px: o dobro do que o navegador costuma pedir. Desenhar grande
      // e deixar ele encolher sai nítido; desenhar pequeno e esticar,
      // não.
      const L = 128;
      const cv = document.createElement("canvas");
      cv.width = L; cv.height = L;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0, L, L);

      const texto = total > 99 ? "99+" : String(total);
      // Quase metade do ícone. Na barra de tarefas o desenho chega a
      // 16px: bolinha discreta ali vira um ponto e o número some.
      const r = texto.length > 2 ? 56 : texto.length > 1 ? 52 : 46;
      const cx = L - r + 6, cy = r - 6;

      // Um vazio escuro atrás da bolinha separa ela da logo, senão o
      // vermelho encosta no verde e os dois somem juntos de longe.
      ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fill();

      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "#e5342b"; ctx.fill();
      ctx.lineWidth = 6; ctx.strokeStyle = "#ffffff"; ctx.stroke();

      ctx.fillStyle = "#ffffff";
      // O texto se ajusta pra caber: "99+" precisa de letra menor que "3".
      const tamanho = texto.length > 2 ? Math.round(r * 0.82) : Math.round(r * 1.05);
      ctx.font = `900 ${tamanho}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(texto, cx, cy + 2);

      link.setAttribute("href", cv.toDataURL("image/png"));
      // Todos os tamanhos de ícone apontam pro mesmo desenho: o navegador
      // escolhe um deles e, se sobrar o antigo em algum, aparece o ícone
      // limpo bem na hora em que deveria avisar.
      document.querySelectorAll('link[rel="icon"]').forEach((l) => l.setAttribute("href", cv.toDataURL("image/png")));
    };
    img.onerror = () => { /* sem ícone base, o título já avisa */ };
    img.src = _iconeBase;
  }

  function _marcarNaBarraDeTarefas(total, deClientes, doChatInterno) {
    if (total === _ultimoTotalNaBarra) return;   // não repinta à toa
    _ultimoTotalNaBarra = total;

    document.title = total ? `(${total}) ${TITULO_BASE}` : TITULO_BASE;
    _pintarIcone(total);

    if (!("setAppBadge" in navigator)) return;
    // Falha aqui não é problema de ninguém: navegador que não suporta,
    // ou aplicativo ainda não instalado. O título acima já cobre.
    try {
      if (total > 0) navigator.setAppBadge(total);
      else navigator.clearAppBadge();
    } catch (e) { /* sem balãozinho, segue com o título */ }

    // Guarda a divisão pra tela poder mostrar de onde vêm, se precisar.
    state.naoLidas = { total, clientes: deClientes, interno: doChatInterno };
  }

  function _ritmoDoPulso() {
    return document.hidden ? PULSO_ESCONDIDO_MS : PULSO_ATIVO_MS;
  }

  let timerWhatsapp = null;
  function pararPollingWhatsapp() { if (timerWhatsapp) { clearTimeout(timerWhatsapp); clearInterval(timerWhatsapp); timerWhatsapp = null; } }
  function iniciarPollingWhatsapp(conversaId) {
    pararPollingWhatsapp();
    // 1.2s — pediram explicitamente pra mensagem do cliente aparecer sem
    // delay perceptível. Continua sendo polling (o servidor não empurra
    // nada sozinho), mas nesse intervalo já fica bem próximo de tempo
    // real pro olho humano notar.
    const tick = async () => {
      if (!location.hash.startsWith("#/whatsapp")) { pararPollingWhatsapp(); return; }
      try {
        if (await mudouAlgo()) {
          await atualizarListaConversasNoDom();
          if (conversaId) await atualizarMensagensNoDom(conversaId);
          // Sem isto o número da aba só mudaria ao trocar de tela — e o
          // aviso de "caiu alguém na fila" chegaria tarde demais.
          await atualizarContagemAbas();
        }
      } catch (e) { /* próxima tentativa corrige */ }
      // setTimeout encadeado (em vez de setInterval): o próximo só é
      // marcado depois que este terminou, então uma resposta lenta nunca
      // empilha pedidos em cima da anterior.
      if (timerWhatsapp !== null) timerWhatsapp = setTimeout(tick, _ritmoDoPulso());
    };
    timerWhatsapp = setTimeout(tick, PULSO_ATIVO_MS);
  }

  let timerChatInterno = null;
  function pararPollingChatInterno() { if (timerChatInterno) { clearTimeout(timerChatInterno); clearInterval(timerChatInterno); timerChatInterno = null; } }
  function iniciarPollingChatInterno(conversaId) {
    pararPollingChatInterno();
    const tick = async () => {
      if (!location.hash.startsWith("#/chat-interno")) { pararPollingChatInterno(); return; }
      try {
        if (await mudouAlgo()) {
          await atualizarListaConversasInternasNoDom();
          if (conversaId) await atualizarMensagensInternasNoDom(conversaId);
        }
      } catch (e) { /* próxima tentativa corrige */ }
      if (timerChatInterno !== null) timerChatInterno = setTimeout(tick, _ritmoDoPulso());
    };
    timerChatInterno = setTimeout(tick, PULSO_ATIVO_MS);
  }

  // Placa de "Carregando…" só quando a pessoa está TROCANDO de tela.
  //
  // Antes, toda re-renderização apagava o <div id="app"> inteiro — e
  // várias ações redesenham a mesma tela (mandar mensagem, anexar,
  // apagar). O resultado era a tela inteira sumir e voltar a cada envio:
  // o "piscar" que incomodava. Voltando pra mesma tela, o conteúdo antigo
  // fica no lugar até o novo estar pronto.
  // Acordeão da tela de Configuração -- pedido do Clayton (2026-09-03):
  // "fazer com que todas as abas aqui dentro... ao clicar devem ficar
  // ocultos e abrir tipo um abre e fecha por uma setinha... para não
  // ficar uma poluição visual". Em vez de reescrever cada seção à mão
  // (são umas 15, com formulários e HTML bem diferentes entre si),
  // transforma qualquer ".cartao" com um <h3> no topo num acordeão,
  // depois que o HTML já está no DOM.
  function _aplicarAcordeaoCartoes(raiz) {
    if (!state._configSecoesAbertas) state._configSecoesAbertas = new Set();
    raiz.querySelectorAll(":scope > .cartao").forEach((cartao, i) => {
      const h3 = cartao.querySelector(":scope > h3");
      if (!h3) return;
      const chave = [...h3.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim() || `secao-${i}`;
      const corpo = document.createElement("div");
      corpo.className = "cartao-corpo";
      while (h3.nextSibling) corpo.appendChild(h3.nextSibling);
      cartao.appendChild(corpo);
      h3.classList.add("cartao-titulo-clicavel");
      h3.insertAdjacentHTML("afterbegin", '<span class="cartao-seta">▸</span>');
      const aberto = state._configSecoesAbertas.has(chave);
      corpo.hidden = !aberto;
      h3.classList.toggle("cartao-aberto", aberto);
      h3.addEventListener("click", () => {
        const vaiAbrir = corpo.hidden;
        corpo.hidden = !vaiAbrir;
        h3.classList.toggle("cartao-aberto", vaiAbrir);
        if (vaiAbrir) state._configSecoesAbertas.add(chave);
        else state._configSecoesAbertas.delete(chave);
      });
    });
  }

  function _carregandoSeTrocouDeTela(tela) {
    if (state._telaAtual !== tela) {
      app.innerHTML = '<div class="carregando-inicial">Carregando…</div>';
    }
    state._telaAtual = tela;
  }

  // Só troca o conteúdo quando ele REALMENTE mudou.
  //
  // O polling roda a cada 1,2s. Reescrever innerHTML sempre destrói e
  // recria tudo — as fotos dos contatos recarregam, a animação do badge
  // de não lidas volta pro começo, o hover se perde e a tela inteira
  // pisca 50 vezes por minuto, mesmo com ninguém conversando. Comparar a
  // string antes é barato e resolve.
  // Guarda a última versão numa propriedade JS do próprio elemento, e
  // não em data-* : um data-* vira atributo de verdade no HTML, e uma
  // conversa longa colocaria centenas de KB visíveis no DOM à toa.
  // Enquanto o botão do mouse/dedo está pressionado, nada é
  // reconstruído. Sem isso o polling podia trocar o item da lista entre
  // o "apertar" e o "soltar" — o navegador perdia o clique e a pessoa
  // precisava clicar duas vezes pra abrir a conversa.
  let _apertando = false;
  document.addEventListener("pointerdown", () => { _apertando = true; }, true);
  document.addEventListener("pointerup", () => { setTimeout(() => { _apertando = false; }, 60); }, true);
  document.addEventListener("pointercancel", () => { _apertando = false; }, true);

  function _pintarSeMudou(elemento, html) {
    if (_apertando) return false;
    if (elemento._htmlPintado === html) return false;
    elemento._htmlPintado = html;
    elemento.innerHTML = html;
    return true;
  }

  // Atualiza uma lista MEXENDO SÓ NO QUE MUDOU.
  //
  // Trocar o innerHTML inteiro a cada 1,2s destrói e recria todos os
  // itens — as fotos recarregam, a animação do badge recomeça, o hover
  // se perde e o clique some se cair entre o apertar e o soltar. Aqui,
  // cada item tem uma chave (o id): item igual não é tocado, item que
  // mudou é trocado sozinho, item novo entra, item que saiu é removido.
  // Com ninguém conversando, nada acontece na tela — nem um pixel.
  function _sincronizarLista(container, itens, chaveDe, htmlDe) {
    if (_apertando) return false;
    const antigos = new Map();
    for (const el of Array.from(container.children)) {
      if (el.dataset.chaveSync) antigos.set(el.dataset.chaveSync, el);
    }
    const desejados = [];
    let mudou = false;
    for (const item of itens) {
      const chave = String(chaveDe(item));
      const html = htmlDe(item);
      const existente = antigos.get(chave);
      if (existente && existente._htmlSync === html) {
        desejados.push(existente);
        antigos.delete(chave);
        continue;
      }
      const molde = document.createElement("div");
      molde.innerHTML = html;
      const el = molde.firstElementChild;
      if (!el) continue;
      el.dataset.chaveSync = chave;
      el._htmlSync = html;
      desejados.push(el);
      antigos.delete(chave);
      mudou = true;
    }
    // Põe na ordem certa sem recriar o que já estava certo. insertBefore
    // move um elemento que já está no container, não duplica.
    desejados.forEach((el, i) => {
      if (container.children[i] !== el) {
        container.insertBefore(el, container.children[i] || null);
        mudou = true;
      }
    });
    while (container.children.length > desejados.length) {
      container.lastElementChild.remove();
      mudou = true;
    }
    return mudou;
  }

  function htmlFiltroEtiquetasInterno(etiquetas) {
    if (!etiquetas || !etiquetas.length) return "";
    const aberto = !!state.etiquetasFiltroAbertasInterno;
    const chips = etiquetas.map((t) => {
      const ativa = String(state.tagFiltroInterno) === String(t.id);
      return `<button type="button" class="wpp-tag-filtro ${ativa ? "ativa" : ""}"
                data-acao="filtrar-por-etiqueta-interno" data-id="${t.id}" data-nome="${escapeHtml(t.nome)}"
                style="--cor-etiqueta:${escapeHtml(t.cor || "#6b7280")};"
                title="${ativa ? "Clique de novo pra tirar o filtro (botão direito: editar/excluir)" : `Ver só as conversas com a etiqueta ${escapeHtml(t.nome)} (botão direito: editar/excluir)`}">
        ${escapeHtml(t.nome)}
      </button>`;
    }).join("");
    return `<div class="wpp-tags-filtro-bloco">
      <button type="button" class="wpp-tags-filtro-alternar" data-acao="alternar-filtro-etiquetas" data-interna="1">🏷️ Etiquetas ${aberto ? "▾" : "▸"}</button>
      <div class="wpp-tags-filtro" ${aberto ? "" : "hidden"}>
        ${chips}
        ${state.tagFiltroInterno ? `<button type="button" class="wpp-tag-filtro-limpar" data-acao="filtrar-por-etiqueta-interno" data-id="">✕ limpar</button>` : ""}
      </div>
    </div>`;
  }

  function _queryChatInterno() {
    const partes = [];
    if (state.chatInternoEscopo === "encerradas") partes.push("encerradas=1");
    if (state.chatInternoEscopo === "todas") partes.push("todas=1");
    if (state.tagFiltroInterno) partes.push(`tag_id=${state.tagFiltroInterno}`);
    return partes.length ? `?${partes.join("&")}` : "";
  }

  async function atualizarListaConversasInternasNoDom() {
    const lista = document.querySelector("[data-wpp-lista-interno]");
    if (!lista) return;
    const conversas = await chamarApi(`/chat-interno/conversas${_queryChatInterno()}`);
    const conversaAtivaId = Number(location.hash.split("/")[2]) || null;
    if (!conversas.length) { _pintarSeMudou(lista, htmlListaConversasInternas(conversas, conversaAtivaId)); return; }
    lista._htmlPintado = null;
    _sincronizarLista(lista, conversas, (c) => c.id, (c) => htmlItemConversaInterna(c, conversaAtivaId));
  }

  async function atualizarMensagensInternasNoDom(conversaId) {
    const painelPedido = document.querySelector("[data-wpp-mensagens-interno]");
    if (!painelPedido || Number(painelPedido.dataset.conversaId) !== conversaId) return;
    const conversas = await chamarApi(`/chat-interno/conversas${_queryChatInterno()}`);
    const conversa = conversas.find((c) => c.id === conversaId);
    if (!conversa) return;
    const mensagens = await chamarApi(`/chat-interno/conversas/${conversaId}/mensagens`);
    // Re-consulta o painel: a pessoa pode ter trocado de conversa
    // enquanto os pedidos acima estavam no ar. Resposta atrasada de
    // uma conversa que não é mais a aberta é descartada, não colada.
    const painel = document.querySelector("[data-wpp-mensagens-interno]");
    if (!painel || Number(painel.dataset.conversaId) !== conversaId) return;
    // Compara o HTML pronto: pega mensagem nova, mensagem apagada E o
    // ✓✓ do outro lado (que não cria mensagem nenhuma, e por isso
    // aparecia só na mensagem seguinte quando a checagem era só a
    // contagem).
    const estavaNoFim = painel.scrollTop + painel.clientHeight >= painel.scrollHeight - 40;
    const itensInternos = _comDivisoresDeDia(mensagens);
    const mudou = _sincronizarLista(painel, itensInternos, (it) => it.chave,
      (it) => it.divisor ? htmlDivisorDeDia(it.divisor) : htmlBolhaInterna(it.mensagem, conversa));
    if (mudou && estavaNoFim) painel.scrollTop = painel.scrollHeight;
  }

  let timerStatusWhatsapp = null;
  function pararPollingStatusWhatsapp() { if (timerStatusWhatsapp) { clearInterval(timerStatusWhatsapp); timerStatusWhatsapp = null; } }
  function iniciarPollingStatusWhatsapp() {
    pararPollingStatusWhatsapp();
    timerStatusWhatsapp = setInterval(async () => {
      if (location.hash !== "#/configuracao") { pararPollingStatusWhatsapp(); return; }
      try { await atualizarSecaoConexaoNoDom(); }
      catch (e) { /* tenta de novo no próximo tick */ }
    }, 4000);
  }

  function _estaDigitando(ateIso) {
    return !!ateIso && new Date(ateIso).getTime() > Date.now();
  }

  function htmlContatosDaBusca(contatos) {
    if (!contatos || !contatos.length) return "";
    return `
      <div class="wpp-busca-contatos">
        <div class="wpp-busca-contatos-titulo">Na agenda (ainda sem conversa)</div>
        ${contatos.map((c) => `
          <div class="wpp-contato-linha">
            ${htmlAvatarContato(c.foto_url, c.nome, c.telefone, 32)}
            <div style="flex:1; min-width:0;">
              <strong>${escapeHtml(c.nome || c.telefone)}</strong>
              ${c.nome ? `<div class="texto-suave">${escapeHtml(c.telefone)}</div>` : ""}
            </div>
            <button type="button" class="botao secundario pequeno" data-acao="iniciar-conversa-contato" data-telefone="${escapeHtml(c.telefone)}" data-nome="${escapeHtml(c.nome || "")}">Conversar</button>
          </div>`).join("")}
      </div>`;
  }

  function htmlListaConversas(conversas, conversaAtivaId) {
    if (!conversas.length) {
      const msgs = {
        fila: "Ninguém esperando na fila. 👏 Aqui ficam só os clientes que ainda não têm dono.",
        todas: "Nenhuma conversa no sistema ainda.",
        minhas: "Você ainda não está atendendo ninguém. Assuma alguém da Fila e o atendimento fica aqui, mesmo depois que o cliente responder.",
        arquivadas: "Nenhuma conversa arquivada.",
        sem_menu: "Ninguém parado no menu agora. 👌 Aqui aparecem os clientes que escreveram e não escolheram nenhum número — passados alguns minutos, eles entram na Fila de todos.",
      };
      return `<div class="wpp-lista-vazia"><div class="wpp-lista-vazia-icone">📭</div><p class="texto-suave">${msgs[state.escopoConversas]}</p></div>`;
    }
    return conversas.map((c) => htmlItemConversa(c, conversaAtivaId)).join("");
  }

  function htmlItemConversa(c, conversaAtivaId) {
    {
      const nome = c.contato_nome || c.telefone;
      // Grupo nunca tem dono, então "sem dono" não significa "na fila":
      // só está na fila o grupo em que ninguém da equipe entrou ainda.
      // E conversa ENCERRADA nunca está "na fila" — encerrar tira do
      // jogo pra todo mundo; só volta a aparecer disponível se reabrir
      // (o cliente escrevendo de novo, ou alguém clicando Reabrir).
      const naFila = c.status !== "fechada" && (c.eh_grupo ? !c.equipe_no_grupo : !c.atribuida_usuario_id);
      const slaEstourado = state.slaAlertasIds.has(c.id);
      return `<a class="wpp-conversa-item ${c.id === conversaAtivaId ? "ativa" : ""} ${slaEstourado ? "wpp-conversa-sla" : ""}" href="#/whatsapp/${c.id}" data-wpp-conversa-id="${c.id}" data-wpp-arquivada="${c.arquivada ? "1" : "0"}" data-wpp-tags='${escapeHtml(JSON.stringify((c.tags || []).map((t) => t.id)))}' ${slaEstourado ? 'title="Sem resposta há tempo demais"' : ""}>
        ${htmlAvatarContato(c.contato_foto, c.contato_nome, c.telefone, 42)}
        <div class="wpp-conversa-info">
          <div class="wpp-conversa-linha1">
            <span class="wpp-conversa-nome">${escapeHtml(nome)}</span>
            <span class="wpp-conversa-hora">${fmtHoraCurta(c.ultima_mensagem_em)}</span>
          </div>
          <div class="wpp-conversa-linha2">
            ${_estaDigitando(c.digitando_ate)
              ? `<span class="wpp-conversa-preview wpp-digitando">digitando…</span>`
              : `<span class="wpp-conversa-preview">${escapeHtml(c.ultima_mensagem_preview || "")}</span>`}
            ${c.nao_lidas > 0 ? `<span class="wpp-badge-nao-lidas piscando">${c.nao_lidas > 99 ? "99+" : c.nao_lidas}</span>` : ""}
          </div>
          ${(() => {
            const partes = [];
            if (naFila) {
              partes.push('<span class="selo amarelo">Na fila</span>');
            } else if (state.escopoConversas === "todas" && c.atribuida_usuario_nome) {
              partes.push(`<span class="wpp-mini-bolinha ${c.atribuida_usuario_online ? "wpp-online-sim" : "wpp-online-nao"}" title="${c.atribuida_usuario_online ? "Online agora" : "Offline"}"></span> ${escapeHtml(c.atribuida_usuario_nome)}`);
            }
            if (c.status === "fechada") {
              partes.push((c.motivo_finalizacao || "").startsWith("auto_")
                ? '<span class="selo inativo" title="O sistema encerrou sozinho -- veja o motivo abrindo a conversa">🤖 Encerrada automaticamente</span>'
                : '<span class="selo inativo">Fechada</span>');
            }
            // Só o admin usa isso pra saber de quem cobrar/perguntar --
            // faz sentido só na aba Arquivadas (é onde arquivada_por_nome
            // vem preenchido; nas outras abas o campo nem é buscado).
            if (c.arquivada && c.arquivada_por_nome) partes.push(`📦 Arquivada por ${escapeHtml(c.arquivada_por_nome)}`);
            // O setor aparece sempre, em qualquer aba — não só em "Todas"/"Fila" — é informação útil pra qualquer atendente ver de cara.
            // Só em conversa de uma pessoa: esse 🏷️ é o setor que o
            // CLIENTE escolheu no menu, e grupo não passa por menu.
            // Mostrá-lo num grupo faz parecer que o grupo "é" daquele
            // setor, que é justamente a informação errada.
            if (c.menu_setor && !c.eh_grupo) partes.push(`🏷️ ${escapeHtml(c.menu_setor)}`);
            return partes.length ? `<div class="wpp-conversa-dono">${partes.join(" · ")}</div>` : "";
          })()}
          ${(c.tags || []).length ? `<div class="wpp-tags-linha wpp-tags-linha-lista">${c.tags.map((t) => `<span class="wpp-tag-chip" data-id="${t.id}" data-nome="${escapeHtml(t.nome)}" data-interna="0" style="background:${t.cor};" title="Botão direito: editar/excluir esta etiqueta">${escapeHtml(t.nome)}</span>`).join("")}</div>` : ""}
        </div>
        ${naFila ? `<button type="button" class="botao pequeno wpp-botao-assumir" data-acao="assumir-conversa" data-id="${c.id}">${c.eh_grupo ? "Entrar no grupo" : "Assumir"}</button>` : ""}
      </a>`;
    }
  }

  // O navegador escolhe o formato que consegue tocar.
  //
  // O original vem primeiro de propósito: Chrome, Edge e Firefox tocam
  // .webm e .oga direto, sem custo nenhum. Só o Safari (e portanto todo
  // navegador de iPhone) desce pro .m4a — e é só aí que a conversão
  // acontece, uma vez por áudio.
  function htmlPlayerAudio(midiaUrl) {
    const original = urlImagemSegura(midiaUrl);
    const nome = (midiaUrl || "").split("?")[0].split("/").pop();
    const compativel = urlImagemSegura(`/api/v1/whatsapp/audio-compativel/${nome}`);
    const ext = (nome.split(".").pop() || "").toLowerCase();
    const tipoOriginal = { webm: "audio/webm", oga: "audio/ogg", ogg: "audio/ogg",
                           mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav" }[ext] || "";
    return `<audio controls preload="metadata">
      <source src="${original}"${tipoOriginal ? ` type="${tipoOriginal}"` : ""}>
      <source src="${compativel}" type="audio/mp4">
    </audio>`;
  }

  function htmlAnexoBolha(m) {
    if (!m.midia_url) return "";
    if (m.tipo === "figurinha") return `
      <div class="wpp-bolha-midia-envolucro">
        <img class="wpp-bolha-figurinha" src="${urlImagemSegura(m.midia_url)}" alt="Figurinha">
        <button type="button" class="wpp-bolha-baixar wpp-salvar-figurinha" data-acao="salvar-figurinha" data-url="${escapeHtml(m.midia_url)}" title="Guardar esta figurinha para usar depois em qualquer conversa">💾 Salvar</button>
      </div>`;
    if (m.tipo === "imagem") return `
      <div class="wpp-bolha-midia-envolucro">
        <a href="${urlImagemSegura(m.midia_url)}" target="_blank" rel="noopener" title="Ver em tamanho grande"><img class="wpp-bolha-imagem" src="${urlImagemSegura(m.midia_url)}" alt="Imagem anexada"></a>
        <a class="wpp-bolha-baixar" href="${urlImagemSegura(m.midia_url)}" download title="Baixar imagem">⬇</a>
      </div>`;
    if (m.tipo === "video") return `
      <div class="wpp-bolha-midia-envolucro">
        <video class="wpp-bolha-video" src="${urlImagemSegura(m.midia_url)}" controls></video>
        <a class="wpp-bolha-baixar" href="${urlImagemSegura(m.midia_url)}" download title="Baixar vídeo">⬇</a>
      </div>`;
    // Áudio toca ali mesmo na conversa: antes virava só um link, e pra
    // reouvir um áudio (enviado ou recebido) tinha que abrir noutra aba.
    if (m.tipo === "audio") return `
      <div class="wpp-bolha-audio">
        ${htmlPlayerAudio(m.midia_url)}
        <a class="wpp-bolha-baixar wpp-bolha-baixar-audio" href="${urlImagemSegura(m.midia_url)}" download title="Baixar áudio">⬇</a>
      </div>
      ${htmlTranscricao(m)}`;
    // Nome de verdade do arquivo em vez do rótulo genérico -- pedido do
    // Clayton: quem recebe precisa saber o que é o documento sem
    // precisar abrir. Sem nome guardado (mensagem antiga), cai pro
    // rótulo genérico de sempre.
    const rotulo = m.nome_arquivo
      ? `📄 ${m.nome_arquivo}`
      : ({ documento: "📄 Documento" }[m.tipo] || "📎 Anexo");
    const extensao = ((m.midia_url || "").split("?")[0].split(".").pop() || "").toLowerCase();
    // PDF e imagens abrem na hora, sem baixar. Os outros formatos o
    // navegador não sabe exibir, então ali "abrir" é baixar mesmo — e é
    // melhor o botão dizer isso do que prometer o que não faz.
    const abreNaTela = ["pdf", "png", "jpg", "jpeg", "gif", "webp"].includes(extensao);
    return `
      <div class="wpp-bolha-anexo-linha">
        <span class="wpp-bolha-anexo-rotulo">${rotulo}</span>
        ${abreNaTela
          ? `<a class="wpp-bolha-anexo" href="${urlImagemSegura(m.midia_url)}" target="_blank" rel="noopener" title="Abrir aqui, sem baixar">👁 Visualizar</a>`
          : `<span class="wpp-bolha-anexo-aviso" title="Este formato o navegador não exibe — só dá pra baixar">só download</span>`}
        <a class="wpp-bolha-baixar" href="${urlImagemSegura(m.midia_url)}" download title="Salvar o arquivo no computador">⬇ Salvar</a>
      </div>`;
  }

  // Só o administrador recebe mensagens apagadas do servidor. Pra ele, em
  // vez de a mensagem sumir sem rastro, ela fica visível numa cor
  // diferente com quem apagou — é o que permite conferir depois.
  // Trecho citado, desenhado dentro da bolha que responde. Mostra só o
  // começo: é referência ("estou falando disto"), não uma segunda cópia
  // da mensagem.
  // Transcrição do áudio: ler em vez de ouvir. Fica embaixo do próprio
  // áudio, e só é gerada quando alguém pede — transcrever custa alguns
  // segundos de processador no servidor. Depois de feita, fica guardada
  // e todo mundo vê pronta.
  // "direcao" só existe em mensagem de cliente (entrada/saida); no chat
  // interno o campo nem vem. É o que separa os dois endereços da API.
  // Fechar a transcrição só a esconde — o texto continua guardado no
  // servidor, então reabrir é instantâneo e não transcreve de novo.
  // A chave leva o canal junto porque uma mensagem de cliente e uma do
  // chat interno podem ter o mesmo número.
  function _chaveTranscricao(m) {
    return `${m.direcao === undefined ? "i" : "c"}:${m.id}`;
  }

  function htmlTranscricao(m) {
    const interna = m.direcao === undefined ? "1" : "0";
    const fechada = state.transcricoesFechadas && state.transcricoesFechadas.has(_chaveTranscricao(m));

    // Transcrição roda em segundo plano no servidor -- terminou quando
    // transcricao_em aparece na mensagem (o polling normal traz isso
    // sozinho). Até lá, mantém o botão desabilitado em vez de deixar
    // clicar de novo (dispararia outra transcrição à toa).
    if (m.transcricao_em) state._transcricoesPendentes.delete(m.id);
    else if (state._transcricoesPendentes.has(m.id)) {
      return `<button type="button" class="wpp-transcricao-botao" disabled>📝 Transcrevendo…</button>`;
    }

    if (m.transcricao_em && !fechada) {
      const texto = (m.transcricao || "").trim();
      return `<div class="wpp-transcricao">
        <div class="wpp-transcricao-topo">
          <span class="wpp-transcricao-titulo">📝 Transcrição</span>
          <button type="button" class="wpp-transcricao-fechar" data-acao="fechar-transcricao"
            data-id="${m.id}" data-interna="${interna}" title="Fechar a transcrição (o texto continua guardado)">✕</button>
        </div>
        ${texto
          ? `<span class="wpp-transcricao-texto">${escapeHtml(texto)}</span>`
          : `<span class="wpp-transcricao-texto wpp-transcricao-vazia">Não deu pra entender nada neste áudio.</span>`}
      </div>`;
    }
    // Já transcrito e fechado: reabrir não custa nada, e o rótulo muda
    // pra deixar claro que o texto já existe.
    if (m.transcricao_em) {
      return `<button type="button" class="wpp-transcricao-botao" data-acao="abrir-transcricao"
        data-id="${m.id}" data-interna="${interna}" title="Mostrar de novo o texto do áudio">📝 Ver a transcrição</button>`;
    }
    if (state.usuarioAtual && state.usuarioAtual.transcricao_disponivel === false) return "";
    return `<button type="button" class="wpp-transcricao-botao"
      data-acao="transcrever-audio" data-id="${m.id}" data-interna="${interna}"
      title="Escrever aqui embaixo o que foi falado">📝 Ler o áudio</button>`;
  }

  function htmlCitacao(m) {
    if (!m.responde_a) return "";
    if (m.citada_texto === null || m.citada_texto === undefined) {
      if (!m.citada_tipo) return `<div class="wpp-citacao wpp-citacao-sumiu">Mensagem citada não está mais disponível</div>`;
    }
    if (m.citada_excluida_em) {
      return `<div class="wpp-citacao wpp-citacao-sumiu">🗑️ A mensagem citada foi apagada</div>`;
    }
    const autor = m.citada_autor
      || (m.citada_direcao === "entrada" ? "Cliente" : m.citada_direcao === "saida" ? "Você" : "");
    const previa = (m.citada_texto || {
      imagem: "📷 Imagem", video: "🎥 Vídeo", documento: "📄 Documento",
      audio: "🎵 Áudio", figurinha: "🩹 Figurinha",
    }[m.citada_tipo] || "📎 Anexo").slice(0, 140);
    return `<div class="wpp-citacao" data-acao="ir-para-citada" data-id="${m.responde_a}" title="Ir até a mensagem citada">
      ${autor ? `<span class="wpp-citacao-autor">${escapeHtml(autor)}</span>` : ""}
      <span class="wpp-citacao-texto">${escapeHtml(previa)}</span>
    </div>`;
  }

  // Barra "respondendo a ..." em cima do campo de digitar. Fica fora do
  // <form> num espaço próprio, porque mandar mensagem não redesenha a
  // tela — quem pinta/apaga é esta função.
  function _desenharBarraCitacao() {
    const espaco = document.querySelector("[data-wpp-citando]");
    if (!espaco) return;
    const c = state.citando;
    if (!c) { espaco.innerHTML = ""; return; }
    espaco.innerHTML = `
      <div class="wpp-citando-barra">
        <div class="wpp-citacao" style="margin:0; flex:1; min-width:0;">
          ${c.autor ? `<span class="wpp-citacao-autor">${escapeHtml(c.autor)}</span>` : ""}
          <span class="wpp-citacao-texto">${escapeHtml((c.texto || "📎 Anexo").slice(0, 140))}</span>
        </div>
        <button type="button" class="botao-icone" data-acao="cancelar-citacao" title="Não citar">✕</button>
      </div>`;
  }

  function htmlEditada(m) {
    return m.editada_em ? `<span class="wpp-bolha-editada" title="Editada em ${fmtData(m.editada_em)}">editada</span>` : "";
  }

  function htmlSeloApagada(m) {
    if (!m.excluida_em) return "";
    const quem = m.excluida_por_nome ? ` por ${escapeHtml(m.excluida_por_nome)}` : "";
    return `<div class="wpp-bolha-apagada-selo">🗑️ Apagada${quem} · ${fmtData(m.excluida_em)}</div>`;
  }

  // Telefone escrito dentro de uma mensagem vira botão.
  //
  // "liga pro 48 99867-8983" é uma das coisas mais comuns que um cliente
  // manda, e até agora dava trabalho: selecionar, copiar, abrir nova
  // conversa, colar. Aqui é um clique.
  //
  // Aceita os formatos que as pessoas realmente escrevem — com DDD entre
  // parênteses, com traço, com espaços, com +55 — e ignora o que só
  // parece telefone: CNPJ, valores, número de pedido. Por isso a regra é
  // 10 ou 11 dígitos (fixo ou celular com DDD), ou 12/13 com o 55 na
  // frente; qualquer outro tamanho fica como texto comum.
  const RE_TELEFONE = /(\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}/g;

  // Endereços de site dentro da mensagem. Roda ANTES do telefone porque
  // um link pode ter números que pareceriam telefone no meio dele.
  const RE_LINK = /\bhttps?:\/\/[^\s<>"]+/gi;

  function textoComLinks(escapado) {
    return escapado.replace(RE_LINK, (url) => {
      // Pontuação colada no fim ("...catalogo." ) não faz parte do
      // endereço — sai do link e volta como texto.
      const limpo = url.replace(/[.,;:)\]]+$/, "");
      const sobra = url.slice(limpo.length);
      return `<a href="${limpo}" target="_blank" rel="noopener noreferrer" class="wpp-link-na-mensagem">${limpo}</a>${sobra}`;
    });
  }

  function _telefonizarTrecho(trecho) {
    return trecho.replace(RE_TELEFONE, (achado) => {
      const digitos = achado.replace(/\D/g, "");
      const nu = digitos.startsWith("55") ? digitos.slice(2) : digitos;
      if (nu.length !== 10 && nu.length !== 11) return achado;
      return `<button type="button" class="wpp-telefone-no-texto" data-acao="conversar-com-numero" data-telefone="${digitos}" title="Iniciar uma conversa com este número">${achado}</button>`;
    });
  }

  function textoComTelefones(texto) {
    const linkificado = textoComLinks(escapeHtml(texto));
    // Nunca mexe DENTRO de um <a>...</a> já pronto -- uma coordenada ou
    // qualquer número dentro do endereço do link pode enganar o regex de
    // telefone (ex.: "-28.7038,-49.3041" batendo como se fosse um
    // número de celular) e quebrar a tag HTML do link ao inserir outra
    // tag no meio dela. Processa só os pedaços de texto FORA dos links.
    const RE_TAG_LINK = /<a[^>]*>.*?<\/a>/gi;
    let resultado = "";
    let ultimoIndex = 0;
    let m;
    while ((m = RE_TAG_LINK.exec(linkificado)) !== null) {
      resultado += _telefonizarTrecho(linkificado.slice(ultimoIndex, m.index)) + m[0];
      ultimoIndex = m.index + m[0].length;
    }
    resultado += _telefonizarTrecho(linkificado.slice(ultimoIndex));
    return resultado;
  }

  // 5548991234567 -> (48) 99123-4567. Quando não dá pra ter o nome, um
  // número legível ainda diz de quem é; uma tira de 13 dígitos não diz.
  function _telefoneBonito(tel) {
    const d = String(tel || "").replace(/\D/g, "");
    const n = d.startsWith("55") ? d.slice(2) : d;
    if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
    if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
    return tel || "";
  }

  function htmlBolha(m, ehGrupo, contatoNome) {
    const saida = m.direcao === "saida";
    const iconeStatus = { pendente: "🕓", enviada: "✓", entregue: "✓✓", lida: "✓✓", falhou: "⚠️", recebida: "" }[m.status] || "";
    return `<div class="wpp-bolha ${saida ? "wpp-bolha-saida" : "wpp-bolha-entrada"} ${m.status === "falhou" ? "wpp-bolha-falhou" : ""} ${m.excluida_em ? "wpp-bolha-apagada" : ""}" data-wpp-bolha-id="${m.id}">
      ${!saida
        ? `<div class="wpp-bolha-autor" title="${escapeHtml(m.autor_telefone || "")}">${
             ehGrupo
               ? (m.autor_nome ? escapeHtml(m.autor_nome)
                  : m.autor_telefone ? escapeHtml(_telefoneBonito(m.autor_telefone))
                  : "<span class=\"wpp-autor-desconhecido\">participante não identificado</span>")
               : escapeHtml(m.autor_nome || contatoNome || "Cliente")
           }</div>`
        : (m.usuario_nome ? `<div class="wpp-bolha-autor">${escapeHtml(m.usuario_nome)}</div>` : "")}
      ${htmlSeloApagada(m)}
      ${htmlCitacao(m)}
      ${htmlAnexoBolha(m)}
      ${m.encaminhada_de ? `<div class="wpp-bolha-encaminhada">↪️ Encaminhada</div>` : ""}
      ${m.texto ? `<div class="wpp-bolha-texto">${textoComTelefones(m.texto)}</div>` : ""}
      ${m.reacao ? `<span class="wpp-reacao" title="O cliente reagiu a esta mensagem${m.reacao_em ? " em " + fmtData(m.reacao_em) : ""}">${escapeHtml(m.reacao)}</span>` : ""}
      <div class="wpp-bolha-rodape">
        ${!m.excluida_em ? `<button type="button" class="wpp-bolha-excluir" data-acao="abrir-reacao" data-id="${m.id}" title="Reagir a esta mensagem">😊</button>` : ""}
        ${!m.excluida_em ? `<button type="button" class="wpp-bolha-excluir" data-acao="citar-mensagem" data-id="${m.id}" data-interna="0" title="Responder citando esta mensagem">↩️</button>` : ""}
        ${!m.excluida_em ? `<button type="button" class="wpp-bolha-excluir" data-acao="encaminhar-mensagem" data-id="${m.id}" title="Encaminhar para outros contatos">📨</button>` : ""}
        ${saida && !m.excluida_em && m.tipo === "texto" ? `<button type="button" class="wpp-bolha-excluir" data-acao="editar-mensagem" data-id="${m.id}" data-texto="${escapeHtml(m.texto || "")}" title="Editar o texto">✏️</button>` : ""}
        ${htmlEditada(m)}
        ${saida && m.status === "falhou" ? `<button type="button" class="wpp-bolha-excluir" data-acao="reenviar-mensagem" data-id="${m.id}" title="Tentar enviar de novo">🔄</button>` : ""}
        ${saida && !m.excluida_em ? `<button type="button" class="wpp-bolha-excluir" data-acao="excluir-mensagem" data-id="${m.id}" title="Excluir mensagem (ex.: enviada por engano)">🗑️</button>` : ""}
        <span class="wpp-bolha-hora">${fmtHoraCurta(m.criado_em)}</span>
        ${saida ? `<span class="wpp-bolha-status wpp-status-${m.status}" title="${m.erro ? escapeHtml(m.erro) : ""}">${iconeStatus}</span>` : ""}
      </div>
    </div>`;
  }

  const SAUDACAO_MENU_PADRAO = "Olá! 👋 Para te atender melhor, escolha o setor desejado (responda só com o número):";

  const EMOJIS_COMUNS = [
    "😀","😂","😊","😍","😉","😎","🙂","😅","🤔","😐","😢","😭","😡","👍","👎","🙏",
    "👏","🙌","💪","🤝","✅","❌","⭐","🔥","🎉","❤️","💬","📌","⏰","📎","📄","🖼️",
    "☕","🎁","💰","📦","🚚","📍","📅","🔔","👋","😴","🤗","😇","🥳","👌","✍️","📞",
  ];

  // Emojis e figurinhas que a empresa foi juntando. Ficam em cache
  // porque o painel é montado toda vez que a conversa é redesenhada
  // (que acontece a cada mensagem enviada) — buscar no servidor sempre
  // deixaria o envio lento à toa. Quem adiciona/remove limpa o cache.
  // Os catálogos mudam raramente e o botão precisa aparecer sem esperar
  // a rede — por isso o cache. Quem cadastra/edita limpa.
  async function obterCatalogos(forcar) {
    if (forcar === true && state._catalogosCache) return state._catalogosCache;
    if (forcar === "limpar") state._catalogosCache = null;
    if (!state._catalogosCache) {
      try { state._catalogosCache = await chamarApi("/whatsapp/catalogos"); }
      catch (e) { state._catalogosCache = []; }
    }
    return state._catalogosCache;
  }

  async function _mostrarBotaoCatalogo(seletor) {
    const envolucro = document.querySelector(seletor || "[data-wpp-catalogo-envolucro]");
    if (!envolucro) return;
    const catalogos = await obterCatalogos();
    envolucro.hidden = catalogos.length === 0;
  }

  async function obterEmojisSalvos() {
    if (!state._emojisCache) {
      try { state._emojisCache = await chamarApi("/whatsapp/emojis"); }
      catch (e) { state._emojisCache = []; }
    }
    return state._emojisCache;
  }

  async function obterFigurinhas() {
    if (!state._figurinhasCache) {
      try { state._figurinhasCache = await chamarApi("/whatsapp/figurinhas"); }
      catch (e) { state._figurinhasCache = []; }
    }
    return state._figurinhasCache;
  }

  function htmlPainelEmojis(emojisSalvos) {
    // Os da empresa primeiro: são os que aquele time realmente usa.
    const salvos = (emojisSalvos || []).map((e) => e.emoji);
    const lista = [...salvos, ...EMOJIS_COMUNS.filter((e) => !salvos.includes(e))];
    return `
      ${lista.map((e) => `<button type="button" class="wpp-emoji-item" data-acao="inserir-emoji" data-emoji="${e}">${e}</button>`).join("")}
      <button type="button" class="wpp-emoji-item wpp-emoji-adicionar" data-acao="adicionar-emoji" title="Adicionar um emoji à lista da empresa">➕</button>`;
  }

  function htmlPainelFigurinhas(figurinhas, conversaId) {
    if (!figurinhas || !figurinhas.length) {
      return `<p class="texto-suave" style="padding:10px; margin:0; font-size:12px;">Nenhuma figurinha salva ainda.<br>Quando um cliente mandar uma, clique em 💾 na mensagem dela pra guardar aqui.</p>`;
    }
    return figurinhas.map((f) => `
      <span class="wpp-figurinha-item">
        <button type="button" data-acao="enviar-figurinha" data-id="${f.id}" data-conversa-id="${conversaId}" title="Enviar esta figurinha">
          <img src="${urlImagemSegura(f.midia_url)}" alt="Figurinha">
        </button>
        <button type="button" class="wpp-figurinha-excluir" data-acao="excluir-figurinha" data-id="${f.id}" title="Tirar do banco">×</button>
      </span>`).join("");
  }

  async function obterRespostasProntas() {
    if (!state._respostasProntasCache) {
      state._respostasProntasCache = await chamarApi("/whatsapp/respostas-prontas");
    }
    return state._respostasProntasCache;
  }

  function htmlRespostasProntasLista(respostas) {
    const itens = respostas.length
      ? respostas.map((r) => `<button type="button" class="wpp-resposta-item" data-acao="inserir-resposta-pronta" data-id="${r.id}">
          <strong>/${escapeHtml(r.atalho)}</strong><span class="texto-suave"> — ${escapeHtml(r.titulo)}</span>
        </button>`).join("")
      : '<p class="texto-suave" style="padding:10px;">Nenhuma resposta pronta ainda.</p>';
    return `${itens}<button type="button" class="wpp-resposta-gerenciar" data-acao="abrir-gerenciar-respostas">⚙️ Gerenciar respostas prontas</button>`;
  }

  function htmlAgendadas(agendadas) {
    if (!agendadas.length) return "";
    return `<div class="wpp-agendadas">${agendadas.map((a) => `
      <div class="wpp-agendada-item">
        <span>🕒 ${fmtData(a.agendado_para)}${a.midia_url ? " 📎" : ""} — ${escapeHtml(a.texto.length > 70 ? a.texto.slice(0, 70) + "…" : a.texto)}</span>
        <button type="button" class="botao-icone" data-acao="cancelar-agendada" data-id="${a.id}" title="Cancelar envio agendado">✕</button>
      </div>`).join("")}</div>`;
  }

  function modalNotasInternas(conversaId, notas) {
    abrirModal(`
      <h3 style="margin-top:0;">🗒️ Notas internas</h3>
      <p class="dica">Só a equipe vê — nunca vai pro cliente.</p>
      <div class="wpp-notas-lista" style="margin-bottom:14px; max-height:38vh; overflow-y:auto;">
        ${notas.length ? notas.map((n) => `
          <div class="wpp-nota-item">
            <div class="wpp-nota-cabecalho"><strong>${escapeHtml(n.usuario_nome || "—")}</strong><span class="texto-suave">${fmtData(n.criado_em)}</span></div>
            <div>${escapeHtml(n.texto)}</div>
          </div>`).join("") : '<p class="texto-suave">Nenhuma nota ainda.</p>'}
      </div>
      <form data-form="criar-nota" data-conversa-id="${conversaId}" class="wpp-resumo-form">
        <textarea name="texto" rows="8" style="font-size:14.5px;" placeholder="Ex.: cliente pediu desconto, aguardando aprovação da gerência…" required></textarea>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Fechar</button>
          <button type="submit" class="botao secundario">Adicionar</button>
        </div>
      </form>`, "modal-largo");
  }

  async function modalNegociacoesFechadas(conversaId, negociacoes) {
    const souAdmin = !!state.usuarioAtual.admin;
    // Só busca a lista de colegas se precisar (admin trocando, ou
    // alguém pedindo troca) — sem isso todo mundo pagava essa chamada
    // à toa, mesmo sem nenhuma negociação marcada ainda.
    const colegas = negociacoes.length ? await chamarApi("/usuarios").catch(() => []) : [];
    abrirModal(`
      <h3 style="margin-top:0;">💰 Negociações fechadas</h3>
      <p class="dica">Só visível pra equipe — nunca vai pro cliente. Cada marcação conta separado no Dashboard, mesmo repetindo com o mesmo cliente ao longo do tempo.</p>
      <div class="wpp-negociacoes-lista" style="margin-bottom:14px;">
        ${negociacoes.length ? negociacoes.map((n) => `
          <div class="wpp-negociacao-item" style="flex-direction:column; align-items:stretch; gap:6px;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
              <span>Marcada por <strong>${escapeHtml(n.usuario_nome)}</strong> em ${fmtData(n.marcado_em)}</span>
              ${(souAdmin || n.usuario_id === state.usuarioAtual.id) ? `<button type="button" class="wpp-tag-tirar" data-acao="desfazer-negociacao" data-id="${conversaId}" data-negociacao="${n.id}" title="Desfazer — marquei por engano">✕</button>` : ""}
            </div>
            ${souAdmin ? `
              <div style="display:flex; gap:6px; align-items:center;">
                <select data-negociacao-select="${n.id}" style="flex:1; font-size:12px;">
                  ${colegas.map((u) => `<option value="${u.id}" ${u.id === n.usuario_id ? "selected" : ""}>${escapeHtml(u.nome)}</option>`).join("")}
                </select>
                <button type="button" class="botao secundario pequeno" data-acao="trocar-negociacao" data-id="${conversaId}" data-negociacao="${n.id}">Trocar</button>
              </div>` : `
              <button type="button" class="botao secundario pequeno" data-acao="abrir-solicitar-troca" data-id="${conversaId}" data-negociacao="${n.id}" data-usuario-atual="${escapeHtml(n.usuario_nome)}">🔁 Solicitar troca pro admin</button>`}
          </div>`).join("") : '<p class="texto-suave">Nenhuma marcada ainda.</p>'}
      </div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Fechar</button>
      </div>`);
  }

  async function modalSolicitarTroca(conversaId, negociacaoId, nomeAtual) {
    const [colegas, admins] = await Promise.all([
      chamarApi("/usuarios").catch(() => []),
      chamarApi("/usuarios").then((us) => us.filter((u) => u.admin)).catch(() => []),
    ]);
    abrirModal(`
      <h3 style="margin-top:0;">🔁 Solicitar troca</h3>
      <p class="dica">Está marcada com <strong>${escapeHtml(nomeAtual)}</strong>. Escolha pra quem deveria ir, e qual admin avisar — manda uma mensagem no chat interno com o link direto pra ele revisar. Só o admin troca de verdade.</p>
      <form data-form="solicitar-troca-negociacao" data-conversa-id="${conversaId}" data-negociacao-id="${negociacaoId}">
        <div class="campo"><label>Trocar para</label>
          <select name="usuario_id_desejado" required>${colegas.map((u) => `<option value="${u.id}">${escapeHtml(u.nome)}</option>`).join("")}</select>
        </div>
        <div class="campo"><label>Avisar qual admin</label>
          <select name="admin_id" required>${admins.map((u) => `<option value="${u.id}">${escapeHtml(u.nome)}</option>`).join("")}</select>
        </div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Enviar pedido</button>
        </div>
      </form>`);
  }

  // Busca dentro da conversa aberta -- 100% no que já está na tela (a
  // rota de mensagens não pagina, vem tudo de uma vez), sem precisar de
  // nenhuma chamada nova ao servidor. Ignora acento/maiúscula pra achar
  // "aniversario" mesmo escrito "Aniversário".
  function _normalizarBusca(txt) {
    return (txt || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function _buscarNasMensagens(texto) {
    const painel = document.querySelector("[data-wpp-mensagens], [data-wpp-mensagens-interno]");
    if (!painel) return;
    painel.querySelectorAll(".wpp-bolha-destaque, .wpp-bolha-destaque-atual").forEach((b) => {
      b.classList.remove("wpp-bolha-destaque", "wpp-bolha-destaque-atual");
    });
    const alvo = _normalizarBusca(texto).trim();
    if (!alvo) { state._buscaMensagens = null; _atualizarContadorBusca(); return; }
    const achados = [...painel.querySelectorAll(".wpp-bolha")].filter((b) => _normalizarBusca(b.textContent).includes(alvo));
    achados.forEach((b) => b.classList.add("wpp-bolha-destaque"));
    state._buscaMensagens = { itens: achados, indice: -1 };
    if (achados.length) _irParaResultadoBusca(1);
    else _atualizarContadorBusca();
  }

  function _irParaResultadoBusca(delta) {
    const b = state._buscaMensagens;
    if (!b || !b.itens.length) return;
    const atual = b.itens[b.indice];
    if (atual) atual.classList.remove("wpp-bolha-destaque-atual");
    b.indice = (b.indice + delta + b.itens.length) % b.itens.length;
    const novo = b.itens[b.indice];
    novo.classList.add("wpp-bolha-destaque-atual");
    novo.scrollIntoView({ block: "center", behavior: "smooth" });
    _atualizarContadorBusca();
  }

  function _atualizarContadorBusca() {
    const el = document.querySelector("[data-wpp-busca-mensagens-contador]");
    if (!el) return;
    const b = state._buscaMensagens;
    el.textContent = (!b || !b.itens.length) ? "0 de 0" : `${b.indice + 1} de ${b.itens.length}`;
  }

  function _limparBuscaMensagens() {
    state._buscaMensagens = null;
    const input = document.querySelector("[data-wpp-busca-mensagens-input]");
    if (input) input.value = "";
    document.querySelectorAll(".wpp-bolha-destaque, .wpp-bolha-destaque-atual").forEach((b) => {
      b.classList.remove("wpp-bolha-destaque", "wpp-bolha-destaque-atual");
    });
    _atualizarContadorBusca();
  }

  function htmlChat(conversa, mensagens, agendadas, respostasProntas, notas, emojisSalvos, figurinhas, negociacoes) {
    if (!conversa) {
      return `<div class="wpp-chat-vazio"><div class="wpp-chat-vazio-icone">💬</div><p class="texto-suave">Selecione uma conversa à esquerda para ver as mensagens.</p></div>`;
    }
    const usuario = state.usuarioAtual;
    const nome = conversa.contato_nome || conversa.telefone;
    const souDono = conversa.atribuida_usuario_id === usuario.id;
    const emSupervisao = usuario.admin && !souDono && conversa.atribuida_usuario_id;
    const fechada = conversa.status === "fechada";
    const motivosAuto = {
      auto_sem_resposta_cliente: "🤖 O sistema encerrou sozinho porque o cliente ficou muito tempo sem responder.",
      auto_30_dias_parada: "🤖 O sistema encerrou sozinho porque a conversa ficou 30 dias sem nenhum movimento.",
    };
    const avisoFechamentoAuto = fechada && motivosAuto[conversa.motivo_finalizacao];
    // Conversa ainda ABERTA, mas com fechamento automático já marcado
    // pra acontecer em breve (ver aviso_conversa_parada_* em
    // Configuração) -- dá pra prorrogar antes que feche sozinha.
    const contandoParaFechar = !fechada && conversa.aviso_fechamento_automatico_em;
    return `
      ${avisoFechamentoAuto ? `<div class="wpp-aviso-fechamento-auto">${avisoFechamentoAuto} Se não for o caso, é só clicar em "Reabrir".</div>` : ""}
      ${contandoParaFechar ? `<div class="wpp-aviso-fechamento-auto">
          ⏳ O cliente não responde há um tempo e essa conversa vai ser encerrada automaticamente em breve${conversa.vezes_prorrogada ? ` (já prorrogada ${conversa.vezes_prorrogada}x)` : ""}.
          ${conversa.pode_prorrogar
            ? `<button type="button" class="botao secundario pequeno" data-acao="prorrogar-conversa" data-id="${conversa.id}" style="margin-left:8px;">🔁 Prorrogar</button>`
            : ` Limite de prorrogações já usado — vai encerrar mesmo.`}
        </div>` : ""}
      <div class="wpp-chat-cabecalho">
        <button type="button" class="botao-icone wpp-botao-voltar" data-acao="voltar-lista" title="Voltar">←</button>
        <span style="position:relative;">
          ${htmlAvatarContato(conversa.contato_foto, conversa.contato_nome, conversa.telefone, 42)}
          <button type="button" class="wpp-avatar-atualizar" data-acao="atualizar-foto-contato" data-id="${conversa.id}" title="Atualizar foto do contato">🔄</button>
        </span>
        <div class="wpp-chat-identidade">
          <div class="wpp-chat-nome"><span class="wpp-chat-nome-texto" title="${escapeHtml(nome)}">${escapeHtml(nome)}</span> <button type="button" class="botao-icone" style="width:20px; height:20px; font-size:11px; vertical-align:middle;" data-acao="renomear-contato" data-contato-id="${conversa.contato_id}" data-nome="${escapeHtml(conversa.contato_nome || "")}" title="Trocar o nome deste contato (só você vê)">✏️</button></div>
          <div class="texto-suave wpp-chat-telefone">${conversa.eh_grupo
            ? `👥 Grupo${conversa.membros_whatsapp ? ` · ${conversa.membros_whatsapp} participantes` : ""}`
            : escapeHtml(_telefoneBonito(conversa.telefone))}${conversa.menu_setor && !conversa.eh_grupo ? ` · 🏷️ ${escapeHtml(conversa.menu_setor)}` : ""}${emSupervisao ? ` · 👁️ supervisionando <span class="wpp-mini-bolinha ${conversa.atribuida_usuario_online ? "wpp-online-sim" : "wpp-online-nao"}" title="${conversa.atribuida_usuario_online ? "Online agora" : "Offline"}"></span> (não marca como lida para ${escapeHtml(conversa.atribuida_usuario_nome || "o responsável")})` : ""}</div>
        </div>
        <div class="wpp-chat-acoes">
          <button type="button" class="botao-icone" data-acao="alternar-busca-mensagens" title="Buscar nesta conversa">🔍</button>
          ${conversa.sem_pendencia_em ? `<button type="button" class="botao secundario pequeno botao-sem-pendencia-ligado" data-acao="sem-pendencia" data-id="${conversa.id}" data-desmarcar="1" title="Esta conversa está marcada como resolvida e fora do alerta de atraso. Clique pra voltar a cobrar resposta.">✓ Sem pendência</button>`
            : `<button type="button" class="botao secundario pequeno" data-acao="sem-pendencia" data-id="${conversa.id}" title="Vi e não precisa responder — tira do alerta de atraso sem mandar mensagem">✓ Não precisa responder</button>`}
          <button type="button" class="botao secundario pequeno ${(notas || []).length ? "wpp-icone-preenchido" : ""}" data-acao="abrir-notas" data-id="${conversa.id}" title="Só a equipe vê, nunca vai pro cliente">🗒️ Notas internas${(notas || []).length ? ` (${notas.length})` : ""}</button>
          <button type="button" class="botao secundario pequeno" data-acao="abrir-encaminhar" data-id="${conversa.id}">Encaminhar</button>
          ${!conversa.eh_grupo ? `<button type="button" class="botao secundario pequeno" data-acao="marcar-negociacao" data-id="${conversa.id}" title="Marca a venda como concluída sem encerrar o atendimento — pode marcar de novo quando o cliente fechar outra negociação depois">💰 Marcar negociação fechada</button>` : ""}
          ${fechada
            ? `<button type="button" class="botao secundario pequeno" data-acao="reabrir-conversa" data-id="${conversa.id}">Reabrir</button>`
            : `<button type="button" class="botao secundario pequeno" data-acao="fechar-conversa" data-id="${conversa.id}">Encerrar atendimento</button>`}
          <button type="button" class="botao-icone wpp-mais-acoes ${conversa.resumo || conversa.proximo_contato_em || (negociacoes || []).length ? "wpp-icone-preenchido" : ""}" data-acao="abrir-mais-acoes" data-id="${conversa.id}"
            data-resumo="${escapeHtml(conversa.resumo || "")}" data-arquivada="${conversa.arquivada ? "1" : "0"}" data-eh-grupo="${conversa.eh_grupo ? "1" : "0"}"
            data-negociacoes="${(negociacoes || []).length}"
            data-proximo="${escapeHtml(conversa.proximo_contato_em || "")}" title="Mais ações">⋯</button>
        </div>
      </div>
      <div class="wpp-busca-mensagens" data-wpp-busca-mensagens hidden>
        <input type="search" class="wpp-busca-mensagens-input" data-wpp-busca-mensagens-input placeholder="Buscar nesta conversa…" autocomplete="off">
        <span class="texto-suave wpp-busca-mensagens-contador" data-wpp-busca-mensagens-contador>0 de 0</span>
        <button type="button" class="botao-icone" data-acao="busca-mensagens-anterior" title="Resultado anterior (Shift+Enter)">↑</button>
        <button type="button" class="botao-icone" data-acao="busca-mensagens-proxima" title="Próximo resultado (Enter)">↓</button>
        <button type="button" class="botao-icone" data-acao="fechar-busca-mensagens" title="Fechar busca">✕</button>
      </div>
      ${conversa.eh_grupo ? `
        <div class="wpp-grupo-membros">
          <span class="wpp-grupo-rotulo">👥 Da nossa equipe neste grupo:</span>
          ${(conversa.participantes || []).length
            ? conversa.participantes.map((p) => `
                <span class="wpp-grupo-membro">${escapeHtml(p.nome)}
                  <button type="button" class="wpp-tag-tirar" data-acao="tirar-do-grupo" data-id="${conversa.id}" data-usuario="${p.id}" title="Tirar ${escapeHtml(p.nome)} deste grupo">✕</button>
                </span>`).join("")
            : `<span class="texto-suave">ninguém ainda</span>`}
          <button type="button" class="wpp-tag-adicionar" data-acao="abrir-membros-grupo" data-id="${conversa.id}" title="Chamar um colega pra este grupo — só quem está aqui dentro vê a conversa">+ colega</button>
          <button type="button" class="wpp-tag-adicionar" data-acao="ver-membros-whatsapp" data-id="${conversa.id}" title="Ver quem está neste grupo no WhatsApp">👤 Quem está no grupo</button>
          <button type="button" class="wpp-tag-adicionar" data-acao="adicionar-ao-grupo" data-id="${conversa.id}" title="Incluir um contato neste grupo do WhatsApp">➕ Adicionar pessoa</button>
        </div>` : ""}
      <div class="wpp-tags-linha">
        ${(conversa.tags || []).map((t) => `<span class="wpp-tag-chip" data-id="${t.id}" data-nome="${escapeHtml(t.nome)}" data-interna="0" style="background:${t.cor};" title="Botão direito: editar/excluir esta etiqueta">${escapeHtml(t.nome)}<button type="button" class="wpp-tag-tirar" data-acao="tirar-etiqueta" data-id="${conversa.id}" data-tag="${t.id}" data-interna="0" title="Tirar a etiqueta ${escapeHtml(t.nome)} desta conversa">✕</button></span>`).join("")}
        <button type="button" class="wpp-tag-adicionar ${(conversa.tags || []).length ? "" : "wpp-tag-adicionar-vazio"}" data-acao="abrir-tags-conversa" data-id="${conversa.id}" data-tags='${escapeHtml(JSON.stringify((conversa.tags || []).map((t) => t.id)))}' title="Marcar este cliente com uma etiqueta sua — só você vê, e depois dá pra filtrar a lista por ela">${(conversa.tags || []).length ? "+ etiqueta" : "🏷️ Etiquetar cliente"}</button>
      </div>

      ${conversa.sugerir_encerrar ? `
        <div class="wpp-lembrar-encerrar">
          <span>Este atendimento está parado há mais de ${conversa.horas_sugerir_encerrar || 24}h. Se já terminou, encerre — assim o cliente passa pelo menu de novo quando voltar.</span>
          <button type="button" class="botao pequeno" data-acao="fechar-conversa" data-id="${conversa.id}">Encerrar atendimento</button>
        </div>` : ""}
      ${fechada ? `<p class="wpp-conversa-fechada-aviso">Esta conversa está fechada${conversa.aguardando_avaliacao ? " — aguardando avaliação do cliente" : ""}. Responder ou reabrir a torna ativa de novo.</p>` : ""}
      <div class="wpp-mensagens" data-wpp-mensagens data-conversa-id="${conversa.id}" data-eh-grupo="${conversa.eh_grupo ? "1" : "0"}" data-contato-nome="${escapeHtml(conversa.contato_nome || "")}">${_comDivisoresDeDia(mensagens).map((it) => it.divisor ? htmlDivisorDeDia(it.divisor) : htmlBolha(it.mensagem, !!conversa.eh_grupo, conversa.contato_nome)).join("")}</div>
      ${htmlAgendadas(agendadas)}
      <div data-wpp-citando></div>
      <form class="wpp-chat-input" data-form="enviar-mensagem" data-conversa-id="${conversa.id}">
        <input type="file" class="wpp-input-arquivo-oculto" data-acao-change="anexar-arquivo" data-conversa-id="${conversa.id}" multiple hidden>
        <button type="button" class="botao-icone" data-acao="abrir-seletor-arquivo" title="Anexar imagem, vídeo ou documento">📎</button>
        <div class="wpp-emoji-envolucro">
          <button type="button" class="botao-icone" data-acao="alternar-emoji" title="Emoji">😀</button>
          <div class="wpp-emoji-painel" data-wpp-emoji-painel hidden>${htmlPainelEmojis(emojisSalvos)}</div>
        </div>
        <div class="wpp-emoji-envolucro">
          <button type="button" class="botao-icone" data-acao="alternar-figurinhas" title="Figurinhas">🧩</button>
          <div class="wpp-figurinhas-painel" data-wpp-figurinhas-painel hidden>${htmlPainelFigurinhas(figurinhas, conversa.id)}</div>
        </div>
        <div class="wpp-emoji-envolucro">
          <button type="button" class="botao-icone" data-acao="alternar-respostas-prontas" title="Respostas prontas">📋</button>
          <div class="wpp-respostas-painel" data-wpp-respostas-painel hidden>${htmlRespostasProntasLista(respostasProntas || [])}</div>
        </div>
        <div class="wpp-emoji-envolucro" data-wpp-catalogo-envolucro hidden>
          <button type="button" class="botao-icone" data-acao="alternar-catalogos" data-id="${conversa.id}" title="Enviar portfólio ou catálogo">📚</button>
        <button type="button" class="botao-icone" data-acao="abrir-compartilhar-contato" data-id="${conversa.id}" data-interna="0" title="Compartilhar um contato salvo">👤</button>
        <button type="button" class="botao-icone" data-acao="compartilhar-localizacao" data-id="${conversa.id}" title="Compartilhar a localização da empresa">📍</button>
          <div class="wpp-respostas-painel" data-wpp-catalogos-painel hidden></div>
        </div>
        <textarea name="texto" class="wpp-textarea" placeholder="Digite uma mensagem…" rows="1">${escapeHtml(_lerRascunho("cliente", conversa.id))}</textarea>
        <button type="button" class="botao-icone" data-acao="pre-visualizar-mensagem" data-interna="0" title="Ver o texto inteiro antes de enviar">👁️</button>
        <button type="button" class="botao-icone" data-acao="alternar-gravacao-audio" data-id="${conversa.id}" title="Gravar áudio">🎙️</button>
        <button type="button" class="botao-icone" data-acao="gravar-video" data-id="${conversa.id}" title="Gravar vídeo pela câmera">🎥</button>
        <button type="button" class="botao-icone" data-acao="abrir-agendar" data-id="${conversa.id}" title="Agendar envio">🕒</button>
        <button type="submit" class="botao wpp-botao-enviar" title="Enviar">➤</button>
      </form>`;
  }

  function htmlAbasConversas() {
    const usuario = state.usuarioAtual;
    const abas = [
      { chave: "minhas", label: "Minhas", dica: "Seus atendimentos. O número mostra quantos têm mensagem esperando resposta." },
      { chave: "fila", label: "Fila", dica: "Clientes que ainda são de ninguém, esperando alguém assumir — do seu setor, mais os que não escolheram setor e já esperaram demais" },
      { chave: "sem_menu", label: "Sem escolha", dica: "Clientes que escreveram e não escolheram nenhum número do menu. Passados alguns minutos, eles também entram na Fila de todos, até alguém assumir." },
    ];
    // Só admin -- revertido em 2026-09-01 (tinha ficado geral desde
    // 31/08, Clayton pediu pra voltar a ser exclusivo do admin).
    if (usuario.super_admin) abas.push({ chave: "todas", label: "Todas" });
    abas.push({ chave: "arquivadas", label: "Arquivadas" });
    // O número em cada aba evita ter que clicar pra descobrir se caiu
    // alguém. Fila e "Sem escolha" piscam quando têm gente esperando:
    // ali o tempo conta, e ninguém está olhando pra aba o tempo todo.
    const cont = state.contagemAbas || {};
    return `<div class="wpp-abas">${abas.map((a) => {
      // Em "Minhas" o número é o que FALTA RESPONDER, não quantas
      // conversas existem. Um "6" que nunca muda porque você tem seis
      // atendimentos abertos não informa nada — o que a pessoa procura
      // ali é "tem alguém esperando?".
      const n = a.chave === "minhas" ? cont.minhas_nao_lidas : cont[a.chave];
      const urgente = (a.chave === "fila" || a.chave === "sem_menu") && n > 0;
      const naoLidas = a.chave === "minhas" && cont.minhas_nao_lidas > 0;
      const selo = (n === null || n === undefined || n === 0)
        ? ""
        : `<span class="wpp-aba-contador ${urgente ? "wpp-aba-contador-urgente piscando" : ""} ${naoLidas ? "wpp-aba-contador-novas" : ""}">${n > 99 ? "99+" : n}</span>`;
      return `<button type="button" class="wpp-aba ${state.escopoConversas === a.chave ? "ativa" : ""}" data-acao="trocar-escopo-conversas" data-escopo="${a.chave}"${a.dica ? ` title="${escapeHtml(a.dica)}"` : ""}>${a.label}${selo}</button>`;
    }).join("")}</div>`;
  }

  // Filtro "ver por atendente" — só admin, e só faz sentido dentro da
  // aba Todas (nas outras a lista já é implicitamente de uma pessoa
  // só: a própria, ou ninguém). Some sozinho se sair dali.
  function htmlFiltrosExtras() {
    const aberto = !!state.filtrosExtrasAbertos;
    const ativoGrupos = !!state.filtroSoGrupos;
    const ativoNegociacoes = !!state.filtroNegociacaoFechada;
    return `<div class="wpp-tags-filtro-bloco">
      <button type="button" class="wpp-tags-filtro-alternar" data-acao="alternar-filtros-extras">🔧 Mais filtros ${aberto ? "▾" : "▸"}</button>
      <div class="wpp-tags-filtro" ${aberto ? "" : "hidden"}>
        <button type="button" class="wpp-tag-filtro ${ativoGrupos ? "ativa" : ""}" data-acao="alternar-filtro-grupos"
          style="--cor-etiqueta:#7c5cff;" title="${ativoGrupos ? "Clique de novo pra tirar o filtro" : "Ver só os grupos"}">
          👥 Meus grupos
        </button>
        <button type="button" class="wpp-tag-filtro ${ativoNegociacoes ? "ativa" : ""}" data-acao="alternar-filtro-negociacao"
          style="--cor-etiqueta:#0a7d67;" title="${ativoNegociacoes ? "Clique de novo pra tirar o filtro" : "Ver só as conversas marcadas como negociação fechada"}">
          💰 Negociações fechadas
        </button>
      </div>
    </div>`;
  }

  function htmlFiltroAtendente(usuarios) {
    if (!state.usuarioAtual.admin || state.escopoConversas !== "todas" || !usuarios || !usuarios.length) return "";
    return `<div class="wpp-filtro-atendente">
      <select data-acao-change="filtrar-por-atendente" title="Ver o atendimento de um usuário só">
        <option value="">👤 Todos os atendentes</option>
        ${usuarios.map((u) => `<option value="${u.id}" ${String(state.usuarioFiltroAtendente) === String(u.id) ? "selected" : ""}>${escapeHtml(u.nome)}</option>`).join("")}
      </select>
    </div>`;
  }

  // Barra de etiquetas: clicar filtra a lista, clicar de novo tira o
  // filtro. Fica escondida se a empresa ainda não criou nenhuma — sem
  // etiqueta cadastrada a barra seria só um espaço vazio ocupando lugar.
  function htmlFiltroEtiquetas(etiquetas, contagem) {
    if (!etiquetas || !etiquetas.length) return "";
    const aberto = !!state.etiquetasFiltroAbertas;
    const chips = etiquetas.map((t) => {
      const total = (contagem || {})[String(t.id)] || 0;
      const ativa = String(state.tagFiltro) === String(t.id);
      return `<button type="button" class="wpp-tag-filtro ${ativa ? "ativa" : ""}"
                data-acao="filtrar-por-etiqueta" data-id="${t.id}" data-nome="${escapeHtml(t.nome)}"
                style="--cor-etiqueta:${escapeHtml(t.cor || "#6b7280")};"
                title="${ativa ? "Clique de novo pra tirar o filtro (botão direito: editar/excluir)" : `Ver só as conversas com a etiqueta ${escapeHtml(t.nome)} (botão direito: editar/excluir)`}">
        ${escapeHtml(t.nome)}${total ? ` <span class="wpp-tag-filtro-n">${total}</span>` : ""}
      </button>`;
    }).join("");
    return `<div class="wpp-tags-filtro-bloco">
      <button type="button" class="wpp-tags-filtro-alternar" data-acao="alternar-filtro-etiquetas" data-interna="0">🏷️ Etiquetas ${aberto ? "▾" : "▸"}</button>
      <div class="wpp-tags-filtro" ${aberto ? "" : "hidden"}>
        ${chips}
        ${state.tagFiltro ? `<button type="button" class="wpp-tag-filtro-limpar" data-acao="filtrar-por-etiqueta" data-id="">✕ limpar</button>` : ""}
      </div>
    </div>`;
  }

  function _queryConversas() {
    const arquivadas = state.escopoConversas === "arquivadas";
    // "sem_menu" vai direto pro servidor, que já sabe filtrar.
    const escopoQuery = arquivadas ? (state.usuarioAtual.admin ? "todas" : "minhas") : state.escopoConversas;
    const etiqueta = state.tagFiltro ? `&tag_id=${state.tagFiltro}` : "";
    // Só manda junto quando a aba é "Todas" — nas outras o parâmetro
    // seria ignorado mesmo (server só aceita com escopo=todas na
    // prática, já que só admin usa), mas assim evita mandar à toa.
    const atendente = (state.usuarioFiltroAtendente && escopoQuery === "todas") ? `&usuario_id=${state.usuarioFiltroAtendente}` : "";
    const negociacao = state.filtroNegociacaoFechada ? "&resultado=venda" : "";
    const soGrupos = state.filtroSoGrupos ? "&so_grupos=1" : "";
    return `escopo=${escopoQuery}${arquivadas ? "&arquivadas=1" : ""}${etiqueta}${atendente}${negociacao}${soGrupos}`;
  }

  let _geracaoRenderWhatsapp = 0;
  async function renderWhatsapp(conversaId, abrirNegociacoes) {
    const _minhaGeracao = ++_geracaoRenderWhatsapp;
    if (!_podeVerConversas()) {
      // Chegou aqui digitando o endereço ou por um link antigo — manda
      // pro chat interno em vez de deixar a tela quebrada carregando
      // algo que o servidor vai recusar.
      definirFlash("erro", "Seu acesso é só ao chat interno. Fale com um administrador se precisar das conversas.");
      location.hash = "#/chat-interno";
      return;
    }
    _limparCitacaoSeTrocou(`cliente:${conversaId}`);
    _carregandoSeTrocouDeTela("whatsapp");
    if (!state._escopoAutoAplicado && state.usuarioAtual.admin && !state.buscaConversas && !state.buscaData) {
      state._escopoAutoAplicado = true;
      try {
        const cont = await chamarApi("/whatsapp/contagem-abas");
        state.contagemAbas = cont;
        if (!cont.minhas_nao_lidas) state.escopoConversas = "todas";
      } catch (e) { /* segue com o padrão (Minhas) se a checagem falhar */ }
    }
    let conversas;
    let contatosSemConversa = [];
    if (state.buscaConversas || state.buscaData) {
      // A busca de conversas parte das CONVERSAS, então um contato salvo
      // que nunca escreveu não apareceria nunca. Procura na agenda
      // também e mostra à parte, com botão pra iniciar a conversa — mas
      // só faz sentido pra busca por texto (a agenda não tem data de
      // conversa nenhuma).
      const paramsBusca = new URLSearchParams();
      if (state.buscaConversas) paramsBusca.set("q", state.buscaConversas);
      if (state.buscaData) paramsBusca.set("data", state.buscaData);
      const [achadas, contatos] = await Promise.all([
        chamarApi(`/whatsapp/conversas/buscar?${paramsBusca.toString()}`),
        state.buscaConversas
          ? chamarApi(`/whatsapp/contatos?q=${encodeURIComponent(state.buscaConversas)}`).catch(() => [])
          : Promise.resolve([]),
      ]);
      conversas = achadas;
      const telefonesComConversa = new Set(achadas.map((c) => c.telefone));
      contatosSemConversa = contatos.filter((c) => !telefonesComConversa.has(c.telefone));
    } else {
      conversas = await chamarApi(`/whatsapp/conversas?${_queryConversas()}`);
    }

    // Etiquetas e a contagem de cada uma alimentam a barra de filtro.
    // Falhar aqui não pode derrubar a tela de conversas inteira. A
    // lista de usuários só interessa pro admin (filtro por atendente).
    const [etiquetas, contagemEtiquetas, contagemAbas, usuariosParaFiltro] = await Promise.all([
      chamarApi("/whatsapp/tags").catch(() => []),
      chamarApi("/whatsapp/tags/contagem").catch(() => ({})),
      chamarApi("/whatsapp/contagem-abas").catch(() => ({})),
      state.usuarioAtual.admin ? chamarApi("/usuarios").catch(() => []) : Promise.resolve([]),
    ]);
    state.contagemAbas = contagemAbas;

    let conversaAtual = null, mensagens = [], agendadas = [], respostasProntas = [], notas = [];
    let emojisSalvos = [], figurinhas = [], negociacoes = [];
    if (conversaId) {
      conversaAtual = conversas.find((c) => c.id === conversaId) || null;
      if (!conversaAtual) {
        // A conversa existe mas não está na aba atual — acontece o tempo
        // todo: a pessoa assume o atendimento (a conversa sai da Fila) e
        // continua com a aba Fila aberta.
        //
        // Antes isso caía em ?escopo=todas, que só admin pode pedir:
        // atendente levava 403, a tela abria SEM o campo de digitar e
        // parecia que a conversa tinha travado. Agora busca a conversa
        // direto, num endereço que respeita a permissão de cada um.
        conversaAtual = await chamarApi(`/whatsapp/conversas/${conversaId}`).catch(() => null);
      }
      if (conversaAtual) {
        [mensagens, agendadas, respostasProntas, notas, emojisSalvos, figurinhas, negociacoes] = await Promise.all([
          chamarApi(`/whatsapp/conversas/${conversaId}/mensagens`),
          chamarApi(`/whatsapp/conversas/${conversaId}/agendadas`),
          obterRespostasProntas(),
          chamarApi(`/whatsapp/conversas/${conversaId}/notas`),
          obterEmojisSalvos(),
          obterFigurinhas(),
          chamarApi(`/whatsapp/conversas/${conversaId}/negociacoes`).catch(() => []),
        ]);
        if (conversaAtual.atribuida_usuario_id === state.usuarioAtual.id) conversaAtual.nao_lidas = 0;
      }
    }

    if (_minhaGeracao !== _geracaoRenderWhatsapp) return; // uma chamada mais nova já assumiu — essa aqui desiste
    state._buscaMensagens = null; // troca de conversa: os elementos destacados de antes nem existem mais no DOM
    renderShell(
      `<div class="wpp-cabecalho-tela">
         <h2 style="margin:0;">Conversas</h2>
         <div style="display:flex; gap:8px;">
           ${state.usuarioAtual.admin ? `<button type="button" class="botao secundario pequeno" data-acao="abrir-envio-massa" title="Mandar a mesma mensagem pra vários contatos">📢 Envio em massa</button>` : ""}
           <button type="button" class="botao secundario pequeno" data-acao="abrir-contatos">📇 Contatos</button>
           <button type="button" class="botao pequeno" data-acao="abrir-nova-conversa">+ Nova conversa</button>
         </div>
       </div>
       <div class="wpp-layout ${conversaId ? "wpp-conversa-aberta" : ""}">
         <div class="wpp-painel-lista">
           <form class="wpp-busca-form" data-form="buscar-conversas">
             <input type="search" name="q" class="wpp-busca-input" placeholder="Buscar por nome, telefone ou mensagem…" autocomplete="off" value="${escapeHtml(state.buscaConversas || "")}">
             <input type="date" name="data" class="wpp-busca-data" title="Filtrar por um dia" value="${state.buscaData || ""}">
             <button type="submit" class="botao-icone" title="Buscar">🔍</button>
             <button type="button" class="botao-icone" data-acao="abrir-contatos" title="Ver todos os contatos salvos">📇</button>
             ${(state.buscaConversas || state.buscaData) ? `<button type="button" class="botao-icone" data-acao="limpar-busca-conversas" title="Limpar busca">✕</button>` : ""}
           </form>
           ${(state.buscaConversas || state.buscaData) ? `<p class="texto-suave" style="padding:0 4px 8px;">Resultados${state.buscaConversas ? ` para "${escapeHtml(state.buscaConversas)}"` : ""}${state.buscaData ? ` em ${_rotuloDoDia(state.buscaData)}` : ""}</p>` : htmlAbasConversas() + htmlFiltroAtendente(usuariosParaFiltro) + htmlFiltrosExtras() + htmlFiltroEtiquetas(etiquetas, contagemEtiquetas)}
           <div class="wpp-lista-conversas" data-wpp-lista>${htmlListaConversas(conversas, conversaId)}${htmlContatosDaBusca(contatosSemConversa)}</div>
         </div>
         <div class="wpp-painel-chat">${htmlChat(conversaAtual, mensagens, agendadas, respostasProntas, notas, emojisSalvos, figurinhas, negociacoes)}</div>
       </div>`,
      "whatsapp"
    );

    _irParaOFim(document.querySelector("[data-wpp-mensagens]"));
    if (abrirNegociacoes && conversaAtual) {
      const negociacoesFrescas = await chamarApi(`/whatsapp/conversas/${conversaAtual.id}/negociacoes`).catch(() => []);
      modalNegociacoesFechadas(conversaAtual.id, negociacoesFrescas);
    }
    _mostrarBotaoCatalogo();
    iniciarPollingWhatsapp(conversaId);
  }

  async function atualizarContagemAbas() {
    try {
      const nova = await chamarApi("/whatsapp/contagem-abas");
      if (JSON.stringify(nova) === JSON.stringify(state.contagemAbas)) return;
      state.contagemAbas = nova;
      const barra = document.querySelector(".wpp-abas");
      if (!barra) return;
      const molde = document.createElement("div");
      molde.innerHTML = htmlAbasConversas();
      const nova_barra = molde.firstElementChild;
      if (nova_barra && barra.innerHTML !== nova_barra.innerHTML) barra.innerHTML = nova_barra.innerHTML;
    } catch (e) { /* próxima tentativa corrige */ }
  }

  async function atualizarListaConversasNoDom() {
    const lista = document.querySelector("[data-wpp-lista]");
    if (!lista) return;
    if (state.buscaConversas || state.buscaData) return; // não sobrescreve um resultado de busca ativo
    const conversas = await chamarApi(`/whatsapp/conversas?${_queryConversas()}`);
    const conversaAtivaId = Number(location.hash.split("/")[2]) || null;
    if (!conversas.length) { _pintarSeMudou(lista, htmlListaConversas(conversas, conversaAtivaId)); return; }
    lista._htmlPintado = null;
    _sincronizarLista(lista, conversas, (c) => c.id, (c) => htmlItemConversa(c, conversaAtivaId));
  }

  async function atualizarMensagensNoDom(conversaId) {
    const painelPedido = document.querySelector("[data-wpp-mensagens]");
    if (!painelPedido || Number(painelPedido.dataset.conversaId) !== conversaId) return;
    const mensagens = await chamarApi(`/whatsapp/conversas/${conversaId}/mensagens`);
    // Re-consulta o painel: a pessoa pode ter trocado de conversa
    // enquanto o pedido acima estava no ar. Resposta atrasada de uma
    // conversa que não é mais a aberta é descartada, não colada aqui.
    const painel = document.querySelector("[data-wpp-mensagens]");
    if (!painel || Number(painel.dataset.conversaId) !== conversaId) return;
    const estavaNoFim = painel.scrollTop + painel.clientHeight >= painel.scrollHeight - 40;
    // Precisa saber se é grupo (e o nome do contato) pra desenhar o autor
    // de cada mensagem — sem isso o redesenho apagava os nomes que a
    // montagem tinha posto.
    const ehGrupo = !!(painel.dataset.ehGrupo === "1");
    const contatoNome = painel.dataset.contatoNome || "";
    const itens = _comDivisoresDeDia(mensagens);
    const mudou = _sincronizarLista(painel, itens, (it) => it.chave,
      (it) => it.divisor ? htmlDivisorDeDia(it.divisor) : htmlBolha(it.mensagem, ehGrupo, contatoNome));
    if (mudou && estavaNoFim) painel.scrollTop = painel.scrollHeight;
  }

  // "2026-08-24T15:30:00.000Z" -> "2026-08-24T15:30", que é o formato
  // que o <input type="datetime-local"> aceita.
  function _paraCampoDataHora(iso) {
    if (!iso) return _valorDataHoraPadrao(1);
    try {
      const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
      const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
      return local.toISOString().slice(0, 16);
    } catch (e) { return _valorDataHoraPadrao(1); }
  }

  // Nome é obrigatório de propósito: etiqueta sem nome vira uma bolinha
  // colorida que ninguém lembra o que significa.
  // Foto de perfil em tamanho grande. Serve pra conferir quem é a pessoa
  // (o avatar de 32px não ajuda muito), então o foco é a imagem: nada de
  // moldura pesada em volta. Clicar fora ou apertar Esc fecha.
  function modalFotoAmpliada(url, nome) {
    const wrap = abrirModal(`
      <div class="wpp-foto-ampliada">
        <img src="${escapeHtml(url)}" alt="Foto de ${escapeHtml(nome)}" referrerpolicy="no-referrer" data-wpp-foto-grande>
        <div class="wpp-foto-ampliada-rodape">
          <strong>${escapeHtml(nome || "")}</strong>
          <button type="button" class="botao secundario pequeno" data-acao="fechar-foto-ampliada">Fechar</button>
        </div>
      </div>`);
    wrap.classList.add("fundo-modal-foto");
    // A URL da foto vem do WhatsApp e expira depois de um tempo. Se ela
    // já morreu, é melhor dizer isso do que deixar um quadrado quebrado.
    const img = wrap.querySelector("[data-wpp-foto-grande]");
    img.addEventListener("error", () => {
      img.replaceWith(Object.assign(document.createElement("p"), {
        className: "texto-suave",
        style: "padding:28px; text-align:center;",
        textContent: "Não consegui carregar esta foto agora — o link dela pode ter expirado. Use o 🔄 ao lado do nome, dentro da conversa, pra buscar de novo.",
      }));
    });
    // Solta o listener quando a janela sai por qualquer caminho (Esc,
    // botão ou clique fora), pra não deixar tecla presa no documento.
    const aoTeclar = (e) => {
      if (!wrap.isConnected) { document.removeEventListener("keydown", aoTeclar); return; }
      if (e.key !== "Escape") return;
      document.removeEventListener("keydown", aoTeclar);
      wrap.remove();
    };
    document.addEventListener("keydown", aoTeclar);
    return wrap;
  }

  // O motivo é opcional, mas ajuda muito: "ausente" sozinho faz o colega
  // ficar sem saber se espera 5 minutos ou procura outra pessoa.
  function modalAusencia() {
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">🟡 Marcar ausência</h3>
      <p class="dica">Você sai das listas de quem pode atender e aparece como <strong>ausente</strong> para os colegas. O menu automático deixa de oferecer o seu setor se todo mundo dele estiver ausente. Nada é perdido: as conversas continuam suas.</p>
      <div class="campo"><label class="rotulo-forte">Motivo (opcional)</label>
        <input name="motivo" maxlength="60" placeholder="Ex.: almoço, reunião, atendimento externo" autofocus>
        <div class="escolha-lista" style="margin-top:8px;">
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            ${["Almoço", "Reunião", "Atendimento externo", "Pausa"].map((m) =>
              `<button type="button" class="botao secundario pequeno" data-motivo-rapido="${m}">${m}</button>`).join("")}
          </div>
        </div>
      </div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-confirmar-ausencia>Ficar ausente</button>
      </div>`);
    const campo = wrap.querySelector('input[name="motivo"]');
    for (const b of wrap.querySelectorAll("[data-motivo-rapido]")) {
      b.addEventListener("click", () => { campo.value = b.dataset.motivoRapido; campo.focus(); });
    }
    wrap.querySelector("[data-confirmar-ausencia]").addEventListener("click", async () => {
      const motivo = campo.value.trim();
      await chamarApi("/usuarios/ausente", { method: "PUT", body: { ausente: true, motivo } });
      state.usuarioAtual = { ...state.usuarioAtual, ausente: true, ausente_motivo: motivo || null };
      fecharModais();
      definirFlash("ok", motivo ? `Marcado como ausente (${motivo}).` : "Marcado como ausente.");
      montarRota();
    });
  }

  function modalNovaEtiqueta(aoCriar) {
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">🏷️ Nova etiqueta</h3>
      <p class="dica">Só você enxerga suas etiquetas. Ela fica disponível em todas as suas conversas — de cliente e do chat interno — e a lista pode ser filtrada por ela.</p>
      <div class="campo"><label>Nome</label><input name="nome" placeholder="Ex.: Orçamento enviado" required maxlength="40"></div>
      <div class="campo"><label>Cor</label><input type="color" name="cor" value="#0a7d67" style="width:64px; padding:2px;"></div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-wpp-criar-etiqueta>Criar e aplicar</button>
      </div>`);
    const campoNome = wrap.querySelector('input[name="nome"]');
    const campoCor = wrap.querySelector('input[name="cor"]');
    campoNome.focus();
    const criar = async () => {
      const nome = campoNome.value.trim();
      if (!nome) { campoNome.focus(); return; }
      await aoCriar(nome, campoCor.value);
    };
    wrap.querySelector("[data-wpp-criar-etiqueta]").addEventListener("click", criar);
    campoNome.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); criar(); } });
  }

  function modalEditarAgendada(id, textoAtual, quandoAtual) {
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">🕒 Editar agendamento</h3>
      <p class="dica">Esta mensagem ainda não saiu. Na hora marcada o sistema envia sozinho para o contato e ela some desta lista.</p>
      <div class="campo"><label>Mensagem</label><textarea name="texto" rows="4"></textarea></div>
      <div class="campo"><label>Enviar em</label><input type="datetime-local" name="quando" required></div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-wpp-salvar-agendada>Salvar</button>
      </div>`);
    const campoTexto = wrap.querySelector('textarea[name="texto"]');
    const campoQuando = wrap.querySelector('input[name="quando"]');
    campoTexto.value = textoAtual;
    campoQuando.value = _paraCampoDataHora(quandoAtual);
    campoTexto.focus();
    wrap.querySelector("[data-wpp-salvar-agendada]").addEventListener("click", async () => {
      if (!campoQuando.value) { campoQuando.focus(); return; }
      await chamarApi(`/whatsapp/agendadas/${id}`, {
        method: "PUT",
        body: { texto: campoTexto.value.trim(), agendado_para: `${campoQuando.value}:00` },
      });
      fecharModais();
      definirFlash("ok", "Agendamento atualizado.");
      carregarPainelFollowup();
      montarRota();
    });
  }

  function modalProrrogarLembrete(id) {
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">🔔 Prorrogar lembrete</h3>
      <p class="dica">Ele continua na lista até você concluir — prorrogar só muda a hora do aviso.</p>
      <div class="campo"><label>Avisar de novo em</label><input type="datetime-local" name="quando" required></div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-wpp-salvar-prorrogar>Prorrogar</button>
      </div>`);
    const campo = wrap.querySelector('input[name="quando"]');
    campo.value = _valorDataHoraPadrao(24);
    wrap.querySelector("[data-wpp-salvar-prorrogar]").addEventListener("click", async () => {
      if (!campo.value) { campo.focus(); return; }
      await chamarApi(`/whatsapp/lembretes/${id}`, { method: "PUT", body: { lembrar_em: `${campo.value}:00` } });
      state.lembretesAlertados.delete(id);
      fecharModais();
      definirFlash("ok", "Lembrete prorrogado.");
      carregarPainelFollowup();
      montarRota();
    });
  }

  function modalEditarMensagem(textoAtual, ehCliente, aoSalvar) {
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">✏️ Editar mensagem</h3>
      ${ehCliente ? `<p class="dica">A correção vai também pro celular do cliente, e a mensagem passa a mostrar "editada" nos dois lados. O WhatsApp só aceita corrigir mensagem <strong>recente</strong> (mais ou menos 15 minutos): passado disso, o texto muda aqui e o cliente fica com o original — a tela avisa quando isso acontecer.</p>` : `<p class="dica">A mensagem passa a mostrar "editada", pra outra pessoa saber que o texto mudou.</p>`}
      <div class="campo"><label>Texto</label><textarea name="texto" rows="4" required></textarea></div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-wpp-salvar-edicao>Salvar</button>
      </div>`);
    const campo = wrap.querySelector('textarea[name="texto"]');
    campo.value = textoAtual;
    campo.focus();
    campo.setSelectionRange(campo.value.length, campo.value.length);
    wrap.querySelector("[data-wpp-salvar-edicao]").addEventListener("click", async () => {
      const texto = campo.value.trim();
      if (!texto) { campo.focus(); return; }
      await aoSalvar(texto);
    });
  }

  function modalEscolherContatoParaFoto(arquivo) {
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">📷 Enviar foto para…</h3>
      <div class="campo"><input data-busca-foto-contato placeholder="Procurar cliente por nome ou número…" autofocus></div>
      <div class="wpp-encaminhar-lista" data-lista-foto-contato><p class="dica">Carregando…</p></div>`);

    const lista = wrap.querySelector("[data-lista-foto-contato]");
    const busca = wrap.querySelector("[data-busca-foto-contato]");

    async function enviarPara(conversaId, nome) {
      wrap.innerHTML = `<p class="dica">Enviando foto para ${escapeHtml(nome)}…</p>`;
      try {
        await _subirAnexo(`${API}/whatsapp/conversas/${conversaId}/anexo`, arquivo);
        fecharModais();
        definirFlash("ok", `Foto enviada para ${nome}.`);
        if (state.rota && state.rota.startsWith("#/whatsapp/")) montarRota();
      } catch (erro) {
        fecharModais();
        definirFlash("erro", erro.message || "Não consegui enviar a foto.");
      }
    }

    function desenhar(itens) {
      const comConversa = itens.filter((c) => c.conversa_id);
      if (!comConversa.length) {
        lista.innerHTML = `<p class="dica">Nenhum cliente com conversa já iniciada encontrado. Abra a conversa com essa pessoa uma vez antes de mandar foto direto por aqui.</p>`;
        return;
      }
      lista.innerHTML = comConversa.map((c) => `
        <button type="button" class="wpp-encaminhar-item" style="width:100%; text-align:left; cursor:pointer; background:none; border:none;" data-conversa="${c.conversa_id}" data-nome="${escapeHtml(c.nome || c.telefone)}">
          <span class="wpp-encaminhar-nome">${escapeHtml(c.nome || c.telefone)}</span>
          <span class="wpp-encaminhar-tel">${escapeHtml(c.telefone)}</span>
        </button>`).join("");
      lista.querySelectorAll("[data-conversa]").forEach((b) => {
        b.addEventListener("click", () => enviarPara(Number(b.dataset.conversa), b.dataset.nome));
      });
    }

    async function buscar(termo) {
      try {
        const r = await chamarApi(`/whatsapp/contatos?q=${encodeURIComponent(termo || "")}`);
        desenhar((r.contatos || r || []).slice(0, 60));
      } catch (e) {
        lista.innerHTML = `<p class="dica">Não consegui carregar a lista agora.</p>`;
      }
    }
    buscar("");
    let debounce = null;
    busca.addEventListener("input", (e) => {
      clearTimeout(debounce);
      const termo = e.target.value.trim();
      debounce = setTimeout(() => buscar(termo), 250);
    });
  }

  function modalEncaminhar(conversaId, usuarios) {
    const opcoes = usuarios.filter((u) => u.ativo).map((u) => `<option value="${u.id}">${u.online ? "🟢" : "🔴"} ${escapeHtml(u.nome)} (${escapeHtml(u.email)})</option>`).join("");
    abrirModal(`
      <h3 style="margin-top:0;">Encaminhar conversa</h3>
      <p class="dica">A pessoa escolhida passa a ser a responsável por esta conversa — ela some da sua aba "Minhas" e aparece na dela.</p>
      <form data-form="encaminhar-conversa" data-conversa-id="${conversaId}">
        <div class="campo"><label>Encaminhar para</label><select name="usuario_id" required><option value="">Selecione…</option>${opcoes}</select></div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Encaminhar</button>
        </div>
      </form>`);
  }

  // <input type="datetime-local"> espera "AAAA-MM-DDTHH:MM" em horário
  // LOCAL do navegador — por isso usa getHours()/getMinutes() (locais),
  // nunca toISOString() (que devolve UTC e bagunçaria o horário mostrado).
  function minDatetimeLocal(minutosNoFuturo) {
    const d = new Date(Date.now() + minutosNoFuturo * 60000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // =======================================================================
  // CHAT INTERNO — privado entre colaboradores, separado das conversas
  // de clientes. Sempre 1-para-1, encaminhável sem perder histórico.
  // =======================================================================
  // Saber se o colega está na frente do computador muda o que você faz
  // (esperar resposta agora, ou ir atrás por outro caminho), então isso
  // aparece escrito — não só como uma bolinha de 8px que se perde no
  // meio da tela.
  function htmlSeloPresenca(online, ausente, motivo) {
    if (online) return `<span class="wpp-presenca wpp-presenca-online">● Online agora</span>`;
    // Ausente é diferente de offline: a pessoa está por perto e avisou
    // que saiu. Cor própria (amarelo) pra dar pra decidir se vale
    // esperar ou procurar outra pessoa.
    if (ausente) {
      return `<span class="wpp-presenca wpp-presenca-ausente" title="${escapeHtml(motivo || "Avisou que está ausente")}">● Ausente${motivo ? " — " + escapeHtml(motivo) : ""}</span>`;
    }
    return `<span class="wpp-presenca wpp-presenca-offline">● Offline</span>`;
  }

  function htmlListaConversasInternas(conversas, ativaId) {
    if (!conversas.length) {
      return `<div class="wpp-lista-vazia"><div class="wpp-lista-vazia-icone">🗨️</div><p class="texto-suave">Nenhuma conversa interna ainda — clique em "+ Nova conversa" pra chamar alguém de um setor.</p></div>`;
    }
    return conversas.map((c) => htmlItemConversaInterna(c, ativaId)).join("");
  }

  function htmlItemConversaInterna(c, ativaId) {
    {
      const eu = state.usuarioAtual.id;
      const souCriador = c.criado_por_id === eu;
      const souParticipante = c.participante_id === eu;
      // Admin espiando pela aba "Todas" uma conversa que não é dele: mostra
      // os dois nomes (quem fala com quem), sem contador de não-lida —
      // esse número é de quem realmente participa, não faz sentido pro
      // admin, e olhar aqui nunca deve mexer nele (ver renderChatInterno).
      const souAlheio = !souCriador && !souParticipante;
      const outroNome = souAlheio ? `${c.criado_por_nome} → ${c.participante_nome || "—"}` : (souCriador ? (c.participante_nome || "—") : c.criado_por_nome);
      const naoLidas = souAlheio ? 0 : (souCriador ? c.nao_lidas_criador : c.nao_lidas_participante);
      const outroDigitandoAte = souAlheio ? (c.digitando_criador_ate || c.digitando_participante_ate) : (souCriador ? c.digitando_participante_ate : c.digitando_criador_ate);
      // Online de quem está do OUTRO lado — é o que interessa saber antes
      // de escrever. Na supervisão (admin), mostra a do participante,
      // que costuma ser quem deve a resposta.
      const outroOnline = souCriador ? c.participante_online : (souAlheio ? c.participante_online : c.criado_por_online);
      // Foto acompanha o nome que aparece PRIMEIRO na linha (outroNome,
      // acima): quando sou o criador, quem aparece é o participante; nos
      // outros dois casos (sou participante, ou sou admin supervisionando
      // "Todas") quem aparece primeiro é sempre o criador. Antes a
      // supervisão usava a foto do participante mesmo com o nome do
      // criador na frente -- parecia foto trocada (ex.: "Daiana →
      // Adrian" com a foto do Adrian ao lado do nome da Daiana).
      const outraFoto = souCriador ? c.participante_foto : c.criado_por_foto;
      return `<a class="wpp-conversa-item ${c.id === ativaId ? "ativa" : ""}" href="#/chat-interno/${c.id}" data-wpp-interno-id="${c.id}" data-wpp-tags='${escapeHtml(JSON.stringify((c.tags || []).map((t) => t.id)))}'>
        <span style="position:relative; flex-shrink:0;">
          ${htmlAvatarContato(outraFoto, outroNome, outroNome, 36)}
          <span class="wpp-online-bolinha ${outroOnline ? "wpp-online-sim" : "wpp-online-nao"}" title="${outroOnline ? "Online agora" : "Offline"}"></span>
        </span>
        <div class="wpp-conversa-info">
          <div class="wpp-conversa-linha1">
            <span class="wpp-conversa-nome">${escapeHtml(outroNome)}</span>
            ${htmlSeloPresenca(outroOnline, souCriador ? c.participante_ausente : c.criado_por_ausente, souCriador ? c.participante_ausente_motivo : c.criado_por_ausente_motivo)}
            <span class="wpp-conversa-hora">${fmtHoraCurta(c.ultima_mensagem_em)}</span>
          </div>
          <div class="wpp-conversa-linha2">
            ${_estaDigitando(outroDigitandoAte)
              ? `<span class="wpp-conversa-preview wpp-digitando">digitando…</span>`
              : `<span class="wpp-conversa-preview">${escapeHtml(c.ultima_mensagem_preview || "")}</span>`}
            ${naoLidas > 0 ? `<span class="wpp-badge-nao-lidas piscando">${naoLidas > 99 ? "99+" : naoLidas}</span>` : ""}
          </div>
          ${(() => {
            // O setor de QUEM ESTÁ DO OUTRO LADO desta conversa — não o
            // setor_destino, que é só o filtro usado pra achar a pessoa
            // e mostrava a função trocada embaixo do nome.
            const eu = state.usuarioAtual.id;
            const doOutro = c.criado_por_id === eu ? c.participante_setores : c.criado_por_setores;
            // Por PESSOA: cada lado enxerga o próprio estado, não o
            // status geral (só fechada quando os dois já fecharam).
            const fechada = souAlheio ? c.status === "fechada" : !!(souCriador ? c.fechada_para_criador_em : c.fechada_para_participante_em);
            if (!doOutro && !fechada) return "";
            return `<div class="wpp-conversa-dono">${doOutro ? `🏷️ ${escapeHtml(doOutro)}` : ""}${fechada ? `${doOutro ? " · " : ""}<span class="selo inativo">Fechada</span>` : ""}</div>`;
          })()}
          ${(c.tags || []).length ? `<div class="wpp-tags-linha wpp-tags-linha-lista">${c.tags.map((t) => `<span class="wpp-tag-chip" data-id="${t.id}" data-nome="${escapeHtml(t.nome)}" data-interna="1" style="background:${t.cor};" title="Botão direito: editar/excluir esta etiqueta">${escapeHtml(t.nome)}</span>`).join("")}</div>` : ""}
        </div>
      </a>`;
    }
  }

  // Visto no chat interno: em vez de marcar mensagem por mensagem, o
  // sistema guarda quando cada lado leu a conversa pela última vez —
  // toda mensagem anterior a esse instante já foi vista.
  function htmlVistoInterno(m, conversa, eu) {
    const souCriador = conversa.criado_por_id === eu;
    const vistoOutro = souCriador ? conversa.visto_participante_em : conversa.visto_criador_em;
    const outroOnline = souCriador ? conversa.participante_online : conversa.criado_por_online;
    const lida = vistoOutro && new Date(vistoOutro) >= new Date(m.criado_em);
    // Três estados, do jeito que o Clayton pediu:
    //   ✓     a pessoa está OFFLINE agora — a mensagem está aqui
    //         esperando, mas o aparelho dela nem está ligado pra "chegar".
    //   ✓✓    a pessoa está online, mas ainda não abriu esta conversa.
    //   ✓✓ azul  a pessoa abriu e viu.
    if (lida) {
      return `<span class="wpp-bolha-status wpp-status-lida" title="Visualizada em ${fmtData(vistoOutro)}">✓✓</span>`;
    }
    if (outroOnline) {
      return `<span class="wpp-bolha-status" title="Online, mas ainda não abriu esta conversa">✓✓</span>`;
    }
    return `<span class="wpp-bolha-status" title="A pessoa está offline no momento">✓</span>`;
  }

  function htmlBolhaInterna(m, conversa) {
    const eu = state.usuarioAtual.id;
    const souAlheio = conversa.criado_por_id !== eu && conversa.participante_id !== eu;
    // Admin espiando (nenhum dos dois é ele): não tem "eu" nessa conversa
    // pra alinhar bolha à direita — usa quem criou como referência de
    // lado, só pra não ficar tudo emendado do mesmo lado.
    const saida = souAlheio ? m.usuario_id === conversa.criado_por_id : m.usuario_id === eu;
    const nomeAutor = m.usuario_id === conversa.criado_por_id ? conversa.criado_por_nome : (conversa.participante_nome || "—");
    return `<div class="wpp-bolha ${saida ? "wpp-bolha-saida" : "wpp-bolha-entrada"} ${m.excluida_em ? "wpp-bolha-apagada" : ""}">
      <div class="texto-suave" style="font-size:11px; font-weight:700; margin-bottom:2px;">${escapeHtml(nomeAutor)}</div>
      ${htmlSeloApagada(m)}
      ${htmlCitacao(m)}
      ${htmlAnexoBolha(m)}
      ${m.texto ? `<div class="wpp-bolha-texto">${textoComTelefones(m.texto)}</div>` : ""}
      ${m.reacao ? `<span class="wpp-reacao" title="Reagiu${m.reacao_por_nome ? ": " + escapeHtml(m.reacao_por_nome) : ""}${m.reacao_em ? " em " + fmtData(m.reacao_em) : ""}">${escapeHtml(m.reacao)}</span>` : ""}
      <div class="wpp-bolha-rodape">
        ${!m.excluida_em && !souAlheio ? `<button type="button" class="wpp-bolha-excluir" data-acao="abrir-reacao" data-id="${m.id}" data-interna="1" title="Reagir a esta mensagem">😊</button>` : ""}
        ${!m.excluida_em && !souAlheio ? `<button type="button" class="wpp-bolha-excluir" data-acao="citar-mensagem" data-id="${m.id}" data-interna="1" title="Responder citando esta mensagem">↩️</button>` : ""}
        ${!m.excluida_em && !souAlheio ? `<button type="button" class="wpp-bolha-excluir" data-acao="encaminhar-mensagem" data-id="${m.id}" data-interna="1" title="Encaminhar para clientes ou colegas">📨</button>` : ""}
        ${m.usuario_id === eu && !m.excluida_em && (m.tipo || "texto") === "texto" ? `<button type="button" class="wpp-bolha-excluir" data-acao="editar-mensagem-interna" data-id="${m.id}" data-conversa-id="${conversa.id}" data-texto="${escapeHtml(m.texto || "")}" title="Editar o texto">✏️</button>` : ""}
        ${htmlEditada(m)}
        ${m.usuario_id === eu && !m.excluida_em ? `<button type="button" class="wpp-bolha-excluir" data-acao="excluir-mensagem-interna" data-id="${m.id}" data-conversa-id="${conversa.id}" title="Apagar (mandei por engano)">🗑️</button>` : ""}
        <span class="wpp-bolha-hora">${fmtHoraCurta(m.criado_em)}</span>
        ${m.usuario_id === eu ? htmlVistoInterno(m, conversa, eu) : ""}
      </div>
    </div>`;
  }

  function htmlChatInterno(conversa, mensagens) {
    if (!conversa) {
      return `<div class="wpp-chat-vazio"><div class="wpp-chat-vazio-icone">🗨️</div><p class="texto-suave">Selecione uma conversa à esquerda, ou inicie uma nova.</p></div>`;
    }
    const eu = state.usuarioAtual.id;
    const souCriador = conversa.criado_por_id === eu;
    const souAlheio = !souCriador && conversa.participante_id !== eu;
    const outroNome = souAlheio ? `${conversa.criado_por_nome} ↔ ${conversa.participante_nome || "—"}` : (souCriador ? (conversa.participante_nome || "—") : conversa.criado_por_nome);
    // Fechada é por PESSOA agora -- cada lado vê o próprio estado, não
    // o status geral (que só marca fechada quando os dois já fecharam).
    const fechada = souAlheio ? conversa.status === "fechada" : !!(souCriador ? conversa.fechada_para_criador_em : conversa.fechada_para_participante_em);
    return `
      <div class="wpp-chat-cabecalho">
        <button type="button" class="botao-icone wpp-botao-voltar" data-acao="voltar-lista-interno" title="Voltar">←</button>
        <span style="position:relative; flex-shrink:0;">
          ${htmlAvatarContato(souCriador ? conversa.participante_foto : conversa.criado_por_foto, outroNome, outroNome, 36)}
          <span class="wpp-online-bolinha ${(souCriador ? conversa.participante_online : conversa.criado_por_online) ? "wpp-online-sim" : "wpp-online-nao"}"></span>
        </span>
        <div class="wpp-chat-identidade">
          <div class="wpp-chat-nome">${escapeHtml(outroNome)}${souAlheio ? "" : ` <button type="button" class="botao-icone" style="width:20px; height:20px; font-size:11px; vertical-align:middle;" data-acao="abrir-apelido-interno" data-conversa-id="${conversa.id}" data-apelido="${escapeHtml(outroNome)}" title="Definir apelido (só você vê)">✏️</button>`}</div>
          <div class="texto-suave wpp-chat-telefone">
            ${htmlSeloPresenca(souCriador ? conversa.participante_online : conversa.criado_por_online, souCriador ? conversa.participante_ausente : conversa.criado_por_ausente, souCriador ? conversa.participante_ausente_motivo : conversa.criado_por_ausente_motivo)}
            ${souAlheio ? " · 👁️ supervisionando — a leitura não marca a mensagem como vista pra eles" : ""}${(() => {
              const eu = state.usuarioAtual.id;
              const doOutro = conversa.criado_por_id === eu ? conversa.participante_setores : conversa.criado_por_setores;
              return doOutro ? ` · 🏷️ ${escapeHtml(doOutro)}` : "";
            })()}
          </div>
        </div>
        <div class="wpp-chat-acoes">
          ${souAlheio ? "" : `
          <button type="button" class="botao-icone" data-acao="alternar-busca-mensagens" title="Buscar nesta conversa">🔍</button>
          <button type="button" class="botao-icone wpp-botao-ligar" data-acao="ligar-interno" data-id="${conversa.id}" data-nome="${escapeHtml(outroNome)}" title="Chamada de voz com ${escapeHtml(outroNome)}">📞</button>
          <button type="button" class="botao-icone" data-acao="abrir-lembrete-interno" data-id="${conversa.id}" title="Criar lembrete (avisa só você)">🔔</button>
          <button type="button" class="botao-icone" data-acao="abrir-agendar-interno" data-id="${conversa.id}" title="Agendar mensagem pro colega">🕒</button>
          <button type="button" class="botao-icone" data-acao="chamar-atencao-interna" data-id="${conversa.id}" data-nome="${escapeHtml(outroNome)}" title="Dar um toque sonoro no colega — aperte quantas vezes precisar até ele responder">📣</button>
          <button type="button" class="botao secundario pequeno" data-acao="abrir-encaminhar-interno" data-id="${conversa.id}">Encaminhar</button>
          ${fechada
            ? `<button type="button" class="botao secundario pequeno" data-acao="reabrir-interno" data-id="${conversa.id}">Reabrir</button>`
            : `<button type="button" class="botao secundario pequeno" data-acao="fechar-interno" data-id="${conversa.id}">Encerrar atendimento</button>`}`}
        </div>
      </div>
      <div class="wpp-tags-linha">
        ${(conversa.tags || []).map((t) => `<span class="wpp-tag-chip" data-id="${t.id}" data-nome="${escapeHtml(t.nome)}" data-interna="1" style="background:${t.cor};" title="Botão direito: editar/excluir esta etiqueta">${escapeHtml(t.nome)}${souAlheio ? "" : `<button type="button" class="wpp-tag-tirar" data-acao="tirar-etiqueta" data-id="${conversa.id}" data-tag="${t.id}" data-interna="1" title="Tirar a etiqueta ${escapeHtml(t.nome)} desta conversa">✕</button>`}</span>`).join("")}
        ${souAlheio ? "" : `<button type="button" class="wpp-tag-adicionar ${(conversa.tags || []).length ? "" : "wpp-tag-adicionar-vazio"}" data-acao="abrir-tags-interna" data-id="${conversa.id}" data-tags='${escapeHtml(JSON.stringify((conversa.tags || []).map((t) => t.id)))}' title="Etiquetar esta conversa — só você vê, e depois dá pra filtrar a lista por ela">${(conversa.tags || []).length ? "+ etiqueta" : "🏷️ Etiquetar conversa"}</button>`}
      </div>
      <div class="wpp-busca-mensagens" data-wpp-busca-mensagens hidden>
        <input type="search" class="wpp-busca-mensagens-input" data-wpp-busca-mensagens-input placeholder="Buscar nesta conversa…" autocomplete="off">
        <span class="texto-suave wpp-busca-mensagens-contador" data-wpp-busca-mensagens-contador>0 de 0</span>
        <button type="button" class="botao-icone" data-acao="busca-mensagens-anterior" title="Resultado anterior (Shift+Enter)">↑</button>
        <button type="button" class="botao-icone" data-acao="busca-mensagens-proxima" title="Próximo resultado (Enter)">↓</button>
        <button type="button" class="botao-icone" data-acao="fechar-busca-mensagens" title="Fechar busca">✕</button>
      </div>
      ${fechada ? `<p class="wpp-conversa-fechada-aviso">Esta conversa está fechada. Responder ou reabrir a torna ativa de novo.</p>` : ""}
      <div class="wpp-mensagens" data-wpp-mensagens-interno data-conversa-id="${conversa.id}">${_comDivisoresDeDia(mensagens).map((it) => it.divisor ? htmlDivisorDeDia(it.divisor) : htmlBolhaInterna(it.mensagem, conversa)).join("")}</div>
      <div data-wpp-citando></div>
      ${souAlheio ? `<p class="wpp-conversa-fechada-aviso">👁️ Você está só visualizando esta conversa (supervisão) — não é possível responder nem interagir aqui.</p>` : `
      <form class="wpp-chat-input" data-form="enviar-mensagem-interna" data-conversa-id="${conversa.id}">
        <input type="file" class="wpp-input-arquivo-oculto" data-acao-change="anexar-arquivo-interno" data-conversa-id="${conversa.id}" multiple hidden>
        <div class="wpp-emoji-envolucro" data-wpp-catalogo-envolucro-interno hidden>
          <button type="button" class="botao-icone" data-acao="alternar-catalogos-interno" data-id="${conversa.id}" title="Enviar portfólio ou catálogo pro colega">📚</button>
        <button type="button" class="botao-icone" data-acao="abrir-compartilhar-contato" data-id="${conversa.id}" data-interna="1" title="Compartilhar um contato salvo">👤</button>
        <button type="button" class="botao-icone" data-acao="compartilhar-localizacao-interno" data-id="${conversa.id}" title="Compartilhar a localização da empresa">📍</button>
          <div class="wpp-respostas-painel" data-wpp-catalogos-painel hidden></div>
        </div>
        <button type="button" class="botao-icone" data-acao="abrir-seletor-arquivo" title="Anexar imagem, vídeo ou documento">📎</button>
        <div class="wpp-emoji-envolucro">
          <button type="button" class="botao-icone" data-acao="alternar-emoji" title="Emoji">😀</button>
          <div class="wpp-emoji-painel" data-wpp-emoji-painel hidden>${EMOJIS_COMUNS.map((e) => `<button type="button" class="wpp-emoji-item" data-acao="inserir-emoji" data-emoji="${e}">${e}</button>`).join("")}</div>
        </div>
        <textarea name="texto" class="wpp-textarea" placeholder="Digite uma mensagem…" rows="1">${escapeHtml(_lerRascunho("interna", conversa.id))}</textarea>
        <button type="button" class="botao-icone" data-acao="pre-visualizar-mensagem" data-interna="1" title="Ver o texto inteiro antes de enviar">👁️</button>
        <button type="button" class="botao-icone" data-acao="alternar-gravacao-audio-interno" data-id="${conversa.id}" title="Gravar áudio">🎙️</button>
        <button type="button" class="botao-icone" data-acao="gravar-video-interno" data-id="${conversa.id}" title="Gravar vídeo pela câmera">🎥</button>
        <button type="submit" class="botao wpp-botao-enviar" title="Enviar">➤</button>
      </form>`}`;
  }

  // Trocar de conversa/tela descarta a citação pendente — citar algo numa
  // conversa e mandar em outra seria confuso (e o servidor recusaria).
  function _rolarParaOFimAgora(seletorPainel) {
    const painel = document.querySelector(seletorPainel);
    if (painel) painel.scrollTop = painel.scrollHeight;
  }

  function _limparCitacaoSeTrocou(chave) {
    if (state._citandoDe !== chave) { state.citando = null; state._citandoDe = chave; }
  }

  let _geracaoRenderChatInterno = 0;
  async function renderChatInterno(conversaId) {
    const _minhaGeracaoInterno = ++_geracaoRenderChatInterno;
    _limparCitacaoSeTrocou(`interno:${conversaId}`);
    _carregandoSeTrocouDeTela("chat-interno");
    const usuario = state.usuarioAtual;
    const escopo = state.chatInternoEscopo;
    // Etiquetas, lista de conversas e (se tiver uma conversa aberta) as
    // mensagens dela saem TODAS ao mesmo tempo, não uma esperando a
    // outra -- eram até 3 idas sequenciais ao servidor toda vez que a
    // tela abria, e isso pesava especialmente ao alternar entre
    // WhatsApp e Chat interno, onde tudo recomeça do zero. Pedido do
    // Clayton (2026-08-31): "como se estivesse pesado" ao ir e voltar.
    const [etiquetas, conversas, mensagensAdiantadas] = await Promise.all([
      obterEtiquetas(),
      chamarApi(`/chat-interno/conversas${_queryChatInterno()}`),
      conversaId ? chamarApi(`/chat-interno/conversas/${conversaId}/mensagens`).catch(() => null) : Promise.resolve(null),
    ]);

    let conversaAtual = null, mensagens = [];
    if (conversaId) {
      conversaAtual = conversas.find((c) => c.id === conversaId) || null;
      if (!conversaAtual) {
        // Pode ser uma conversa de outro escopo acessada direto pelo link
        // (ex.: aba "Minhas" selecionada mas o link é de uma encerrada) —
        // busca nos outros escopos antes de desistir. Em PARALELO (não
        // uma de cada vez): eram até 3 idas ao servidor em fila, e cada
        // clique enquanto isso corria via de novo do zero (o clique
        // anterior se abandona sozinho, ver _minhaGeracaoInterno) —
        // dava a sensação de precisar clicar várias vezes pra abrir.
        const escoposFaltando = ["minhas", "encerradas", "todas"].filter(
          (e) => e !== escopo && (e !== "todas" || usuario.admin)
        );
        const resultados = await Promise.all(
          escoposFaltando.map((e) => {
            const q = e === "encerradas" ? "?encerradas=1" : e === "todas" ? "?todas=1" : "";
            return chamarApi(`/chat-interno/conversas${q}`).catch(() => []);
          })
        );
        for (const outras of resultados) {
          conversaAtual = outras.find((c) => c.id === conversaId) || null;
          if (conversaAtual) break;
        }
      }
      if (conversaAtual) {
        // Já veio pronta do pedido em paralelo lá em cima (caminho
        // normal); só busca de novo se aquele pedido falhou por algum
        // motivo, ou se a conversa só foi achada no fallback de outro
        // escopo (aí o pedido adiantado mirou o escopo errado).
        mensagens = mensagensAdiantadas || await chamarApi(`/chat-interno/conversas/${conversaId}/mensagens`);
        // Só zera não-lida de quem a mensagem é DE VERDADE — um admin
        // espiando (na aba "Todas") uma conversa que não é dele não deve
        // mexer no contador de ninguém, mesma régua da supervisão em
        // Conversas (WhatsApp).
        if (conversaAtual.criado_por_id === usuario.id) conversaAtual.nao_lidas_criador = 0;
        else if (conversaAtual.participante_id === usuario.id) conversaAtual.nao_lidas_participante = 0;
      }
    }

    const abas = [{ chave: "minhas", label: "Minhas" }, { chave: "encerradas", label: "Encerradas" }];
    if (usuario.super_admin) abas.push({ chave: "todas", label: "Todas" });

    if (_minhaGeracaoInterno !== _geracaoRenderChatInterno) return; // uma chamada mais nova já assumiu — essa aqui desiste
    state._buscaMensagens = null; // troca de conversa: os elementos destacados de antes nem existem mais no DOM
    renderShell(
      `<div class="wpp-cabecalho-tela">
         <h2 style="margin:0;">Chat interno</h2>
         <button type="button" class="botao secundario pequeno" data-acao="abrir-agendar-em-massa">🕒 Agendar p/ vários</button>
         <button type="button" class="botao pequeno" data-acao="abrir-nova-conversa-interna">+ Nova conversa</button>
       </div>
       <p class="dica" style="margin-top:-8px;">🔒 Privado — só quem participa da conversa pode ver.</p>
       <div class="wpp-abas">
         ${abas.map((a) => `<button type="button" class="wpp-aba ${escopo === a.chave ? "ativa" : ""}" data-acao="chat-interno-trocar-escopo" data-escopo="${a.chave}">${a.label}</button>`).join("")}
       </div>
       <div class="wpp-layout ${conversaId ? "wpp-conversa-aberta" : ""}">
         <div class="wpp-painel-lista">
           ${htmlFiltroEtiquetasInterno(etiquetas)}
           <div class="wpp-lista-conversas" data-wpp-lista-interno>${htmlListaConversasInternas(conversas, conversaId)}</div>
         </div>
         <div class="wpp-painel-chat">${htmlChatInterno(conversaAtual, mensagens)}</div>
       </div>`,
      "chat-interno"
    );

    _irParaOFim(document.querySelector("[data-wpp-mensagens-interno]"));
    _mostrarBotaoCatalogo("[data-wpp-catalogo-envolucro-interno]");
    iniciarPollingChatInterno(conversaId);
  }

  // Todos os setores da pessoa, pra rótulo e filtro. Uma pessoa pode
  // atender mais de um (ex.: Televendas e Financeiro), e olhar só o
  // principal a faria sumir da lista ao filtrar pelo segundo.
  function _setoresDoColega(u) {
    if (u.setores && u.setores.length) return u.setores;
    return u.setor ? [u.setor] : [];
  }

  async function modalEnvioMassa() {
    let config;
    try {
      config = await chamarApi("/whatsapp/configuracao");
    } catch (e) {
      definirFlash("erro", "Não consegui verificar a configuração.");
      return;
    }
    if (!config.envio_massa_ativo) {
      abrirModal(`
        <h3 style="margin-top:0;">📢 Envio em massa</h3>
        <p class="dica">Essa função está desativada. Ative em <strong>Configuração → Envio em massa</strong> antes de usar.</p>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Fechar</button>
          <a class="botao" href="#/configuracao" data-acao="fechar-modal">Ir pra Configuração</a>
        </div>`);
      return;
    }

    const wrap = abrirModal(`
      <h3 style="margin-top:0;">📢 Envio em massa</h3>
      <p class="dica" style="background:color-mix(in srgb, var(--vermelho) 10%, transparent); padding:8px 10px; border-radius:8px;">
        ⚠️ Mandado espaçado (${config.envio_massa_intervalo_segundos || 8}s entre cada um), respeitando os limites de ritmo já configurados. Ainda assim, use com moderação — número banido por disparo em massa não volta fácil.
      </p>
      <div class="campo">
        <input data-busca-envio-massa placeholder="Procurar cliente por nome ou número…" autofocus>
      </div>
      <div class="wpp-encaminhar-lista" style="margin-bottom:12px; max-height:26vh; overflow-y:auto;" data-lista-envio-massa><p class="dica">Digite pra buscar…</p></div>
      <p class="dica" data-resumo-envio-massa>Nenhum destinatário escolhido ainda.</p>
      <div class="campo"><label>Mensagem</label><textarea data-envio-massa-texto rows="4" placeholder="Escreva a mensagem..." required></textarea></div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-acao="confirmar-envio-massa">Iniciar envio</button>
      </div>`, "modal-largo");

    const escolhidos = new Map(); // telefone -> nome
    const lista = wrap.querySelector("[data-lista-envio-massa]");
    const busca = wrap.querySelector("[data-busca-envio-massa]");
    const resumo = wrap.querySelector("[data-resumo-envio-massa]");
    wrap._envioMassaEscolhidos = escolhidos;

    function atualizarResumo() {
      resumo.textContent = escolhidos.size
        ? `${escolhidos.size} destinatário(s): ${[...escolhidos.values()].slice(0, 6).join(", ")}${escolhidos.size > 6 ? "…" : ""}`
        : "Nenhum destinatário escolhido ainda.";
    }

    function desenhar(itens) {
      if (!itens.length) { lista.innerHTML = `<p class="dica">Nenhum contato encontrado.</p>`; return; }
      lista.innerHTML = itens.map((c) => `
        <label class="wpp-encaminhar-item">
          <input type="checkbox" data-envio-massa-item value="${escapeHtml(c.telefone)}" data-nome="${escapeHtml(c.nome || c.telefone)}" ${escolhidos.has(c.telefone) ? "checked" : ""}>
          <span class="wpp-encaminhar-nome">${escapeHtml(c.nome || c.telefone)}</span>
          <span class="wpp-encaminhar-tel">${escapeHtml(c.telefone)}</span>
        </label>`).join("");
      lista.querySelectorAll("[data-envio-massa-item]").forEach((cx) => {
        cx.addEventListener("change", () => {
          if (cx.checked) escolhidos.set(cx.value, cx.dataset.nome);
          else escolhidos.delete(cx.value);
          atualizarResumo();
        });
      });
    }

    async function buscarContatos(termo) {
      if (!termo || termo.trim().length < 2) { lista.innerHTML = `<p class="dica">Digite pelo menos 2 letras/números…</p>`; return; }
      try {
        const r = await chamarApi(`/whatsapp/contatos?q=${encodeURIComponent(termo)}`);
        desenhar((r.contatos || r || []).filter((c) => !c.eh_grupo).slice(0, 40));
      } catch (e) {
        lista.innerHTML = `<p class="dica">Não consegui buscar agora.</p>`;
      }
    }
    let debounce = null;
    busca.addEventListener("input", (e) => {
      clearTimeout(debounce);
      const termo = e.target.value;
      debounce = setTimeout(() => buscarContatos(termo), 250);
    });
  }

  function modalNovaConversaInterna(usuarios, setores) {
    const eu = state.usuarioAtual.id;
    // No chat interno se fala com QUALQUER pessoa da empresa, de
    // qualquer setor — o campo de setor abaixo é só um filtro pra achar
    // mais rápido, nunca uma restrição.
    const disponiveis = usuarios.filter((u) => u.ativo && u.id !== eu);
    abrirModal(`
      <h3 style="margin-top:0;">Nova conversa interna</h3>
      <form data-form="iniciar-conversa-interna">
        <div class="campo"><label>Filtrar por setor <span class="texto-suave" style="font-weight:400;">(opcional — dá pra falar com qualquer setor)</span></label>
          <select name="setor_filtro" data-acao-change="filtrar-participantes-interno">
            <option value="">Todos os setores</option>
            ${setores.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
          </select>
        </div>
        <div class="campo"><label>Falar com</label>
          <select name="participante_id" required data-lista-participantes>
            <option value="">Selecione…</option>
            ${disponiveis.map((u) => {
              const seus = _setoresDoColega(u);
              return `<option value="${u.id}" data-setores="${escapeHtml(seus.join("|"))}">${u.online ? "🟢" : "🔴"} ${escapeHtml(u.nome)}${seus.length ? " — " + escapeHtml(seus.join(", ")) : ""}${u.admin ? " (Admin)" : ""}</option>`;
            }).join("")}
          </select>
        </div>
        <div class="campo"><label>Mensagem (opcional)</label><textarea name="texto" rows="3" placeholder="Pode já escrever a primeira mensagem, ou deixar em branco e só abrir a conversa"></textarea></div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Iniciar conversa</button>
        </div>
      </form>`);
  }

  function modalEncaminharInterno(conversaId, usuarios, criadoPorId) {
    const eu = state.usuarioAtual.id;
    const opcoes = usuarios.filter((u) => u.ativo && u.id !== eu && u.id !== criadoPorId)
      .map((u) => {
        const seus = _setoresDoColega(u);
        return `<option value="${u.id}">${u.online ? "🟢" : "🔴"} ${escapeHtml(u.nome)}${seus.length ? " — " + escapeHtml(seus.join(", ")) : ""}</option>`;
      }).join("");
    abrirModal(`
      <h3 style="margin-top:0;">Encaminhar conversa interna</h3>
      <p class="dica">A pessoa escolhida passa a fazer parte da conversa no seu lugar — o histórico inteiro continua lá, ninguém perde nada.</p>
      <form data-form="encaminhar-interno" data-conversa-id="${conversaId}">
        <div class="campo"><label>Encaminhar para</label><select name="participante_id" required><option value="">Selecione…</option>${opcoes}</select></div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Encaminhar</button>
        </div>
      </form>`);
  }

  function modalNovaConversa(telefonePreenchido, nomePreenchido) {
    abrirModal(`
      <h3 style="margin-top:0;">Nova conversa</h3>
      <p class="dica">Começa uma conversa com um número que ainda não falou com a empresa. Ela vai aparecer na sua aba "Minhas" depois de enviada.</p>
      <form data-form="iniciar-conversa">
        <div class="campo"><label>Telefone (com DDD)</label><input name="telefone" type="tel" placeholder="(11) 99999-8888" value="${escapeHtml(telefonePreenchido || "")}" required autofocus></div>
        <div class="campo"><label>Nome do contato (opcional)</label><input name="nome" placeholder="Ex.: João da Padaria" value="${escapeHtml(nomePreenchido || "")}"></div>
        <div class="campo"><label>Mensagem</label><textarea name="texto" rows="3" required></textarea></div>
        <p class="dica"><a href="#" data-acao="abrir-contatos">📇 Escolher de um contato salvo</a></p>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Enviar</button>
        </div>
      </form>`);
  }

  function htmlListaContatosCompartilhar(contatos, conversaId, interna) {
    const semGrupo = contatos.filter((c) => !c.eh_grupo);
    if (!semGrupo.length) return '<p class="texto-suave">Nenhum contato ainda.</p>';
    return semGrupo.map((c) => `
      <div class="wpp-contato-linha">
        ${htmlAvatarContato(c.foto_url, c.nome, c.telefone, 32)}
        <div style="flex:1; min-width:0;"><strong>${escapeHtml(c.nome || c.telefone)}</strong>${c.nome ? `<div class="texto-suave">${escapeHtml(c.telefone)}</div>` : ""}</div>
        <button type="button" class="botao secundario pequeno" data-acao="compartilhar-contato" data-id="${conversaId}" data-interna="${interna ? "1" : "0"}" data-nome="${escapeHtml(c.nome || "")}" data-telefone="${escapeHtml(c.telefone)}">Compartilhar</button>
      </div>`).join("");
  }

  // Pega a localização atual do navegador — devolve null (sem travar
  // nada) se a pessoa negar a permissão, o navegador não suportar, ou
  // demorar demais (10s). Quem chamar decide o que fazer sem GPS.
  function _obterLocalizacaoAtual() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  async function modalCompartilharContato(conversaId, interna) {
    const contatos = await chamarApi("/whatsapp/contatos");
    abrirModal(`
      <h3 style="margin-top:0;">👤 Compartilhar contato</h3>
      <p class="dica">${interna ? "Manda o nome e telefone numa mensagem pro colega — ele já consegue clicar no número pra falar direto." : "Manda um cartão de contato de verdade — o cliente consegue salvar na agenda dele com um toque."}</p>
      <input type="search" placeholder="Buscar por nome ou telefone…" data-acao-change="buscar-contatos-compartilhar" data-conversa-id="${conversaId}" data-interna="${interna ? "1" : "0"}" style="width:100%; margin-bottom:10px;" autofocus>
      <div data-wpp-contatos-compartilhar-lista style="max-height:50vh; overflow-y:auto;">${htmlListaContatosCompartilhar(contatos, conversaId, interna)}</div>
      <div class="rodape-modal"><button type="button" class="botao secundario" data-acao="fechar-modal">Fechar</button></div>`);
  }

  function htmlListaContatosModal(contatos) {
    if (!contatos.length) return '<p class="texto-suave">Nenhum contato ainda — importe um arquivo acima, ou eles aparecem aqui sozinhos assim que alguém escrever pela primeira vez.</p>';
    return contatos.map((c) => `
      <div class="wpp-contato-linha">
        ${htmlAvatarContato(c.foto_url, c.nome, c.telefone, 32)}
        <div style="flex:1; min-width:0;"><strong>${c.eh_grupo ? "👥 " : ""}${escapeHtml(c.nome || c.telefone)}</strong>${c.nome && !c.eh_grupo ? `<div class="texto-suave">${escapeHtml(c.telefone)}</div>` : ""}${c.eh_grupo ? '<div class="texto-suave">Grupo</div>' : ""}</div>
        <button type="button" class="botao-icone" data-acao="editar-contato" data-id="${c.id}" data-nome="${escapeHtml(c.nome || "")}" data-telefone="${escapeHtml(c.telefone)}" title="Corrigir o nome deste contato">✏️</button>
        <button type="button" class="botao secundario pequeno" data-acao="iniciar-conversa-contato" data-telefone="${escapeHtml(c.telefone)}" data-nome="${escapeHtml(c.nome || "")}">Conversar</button>
      </div>`).join("");
  }

  async function modalCriarGrupo() {
    const contatos = (await chamarApi("/whatsapp/contatos")).filter((c) => !c.eh_grupo);
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">👥 Criar grupo</h3>
      <p class="dica">O grupo é criado no WhatsApp de verdade, com o número conectado como administrador. Depois ele aparece aqui na lista de Conversas como qualquer outra.</p>
      <div class="campo"><label class="rotulo-forte">Nome do grupo</label>
        <input name="nome" required maxlength="60" placeholder="Ex.: Obra Centro — Fornecedores" autofocus></div>
      <div class="campo"><label class="rotulo-forte">Imagem do grupo (opcional)</label>
        <input type="file" name="imagem" accept="image/*">
        <p class="dica" style="margin-top:4px;">Se der problema ao definir a imagem, o grupo é criado do mesmo jeito — dá pra pôr a foto depois pelo WhatsApp.</p>
      </div>
      <div class="campo"><label class="rotulo-forte">Quem entra no grupo</label>
        <input type="search" data-busca-grupo placeholder="Filtrar por nome ou telefone…" style="margin-bottom:8px;">
        <div class="escolha-lista" data-lista-grupo style="max-height:260px; overflow-y:auto;">
          ${contatos.length
            ? contatos.map((c) => `
              <label class="escolha-item" data-nome-contato="${escapeHtml((c.nome || "") + " " + c.telefone)}">
                <input type="checkbox" name="participantes" value="${escapeHtml(c.telefone)}">
                <span class="escolha-texto"><strong>${escapeHtml(c.nome || c.telefone)}</strong>${c.nome ? `<span class="escolha-ajuda">${escapeHtml(c.telefone)}</span>` : ""}</span>
              </label>`).join("")
            : '<p class="texto-suave">Nenhum contato salvo ainda — adicione contatos antes de montar um grupo.</p>'}
        </div>
        <p class="dica" data-contagem-grupo style="margin-top:6px;">Ninguém escolhido ainda.</p>
      </div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-criar-grupo>Criar grupo</button>
      </div>`);

    const campoNome = wrap.querySelector('input[name="nome"]');
    const busca = wrap.querySelector("[data-busca-grupo]");
    const contagem = wrap.querySelector("[data-contagem-grupo]");
    const marcados = () => [...wrap.querySelectorAll('input[name="participantes"]:checked')].map((i) => i.value);

    const atualizarContagem = () => {
      const n = marcados().length;
      contagem.textContent = n === 0 ? "Ninguém escolhido ainda."
        : n === 1 ? "1 pessoa escolhida." : `${n} pessoas escolhidas.`;
    };
    wrap.addEventListener("change", atualizarContagem);
    busca.addEventListener("input", () => {
      const termo = busca.value.trim().toLowerCase();
      for (const item of wrap.querySelectorAll("[data-nome-contato]")) {
        item.hidden = !!termo && !item.dataset.nomeContato.toLowerCase().includes(termo);
      }
    });

    wrap.querySelector("[data-criar-grupo]").addEventListener("click", async (ev) => {
      const nome = campoNome.value.trim();
      const telefones = marcados();
      if (!nome) { campoNome.focus(); return; }
      if (!telefones.length) { definirFlash("erro", "Escolha pelo menos uma pessoa para o grupo."); return montarRota(); }
      const botao = ev.currentTarget;
      botao.disabled = true;
      botao.textContent = "Criando…";
      try {
        // A imagem sobe primeiro, pelo mesmo caminho dos anexos: o
        // WhatsApp busca a foto por URL, então ela precisa estar num
        // endereço público antes do grupo existir.
        let imagem_url = null;
        const arquivo = wrap.querySelector('input[name="imagem"]').files[0];
        if (arquivo) {
          const forma = new FormData();
          forma.append("arquivo", arquivo, arquivo.name || "imagem");
          const resp = await fetch(`${API}/whatsapp/upload-avulso`, {
            method: "POST",
            headers: { Authorization: "Bearer " + state.accessToken },
            body: forma,
          });
          if (resp.ok) imagem_url = (await resp.json()).url;
        }
        const r = await chamarApi("/whatsapp/grupos", { method: "POST", body: { nome, telefones, imagem_url } });
        fecharModais();
        definirFlash("ok", `Grupo "${nome}" criado com ${telefones.length} pessoa(s).`);
        location.hash = `#/whatsapp/${r.conversa_id}`;
      } catch (e) {
        botao.disabled = false;
        botao.textContent = "Criar grupo";
        throw e;
      }
    });
  }

  function modalEditarContato(id, nomeAtual, telefoneAtual) {
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">✏️ Editar contato</h3>
      <p class="dica">Corrige o <strong>nome de cadastro</strong>, que vale para a empresa inteira. Se alguém tiver definido um apelido próprio para este contato, o apelido dele continua valendo na tela dele.</p>
      <div class="campo"><label>Nome</label><input name="nome" required maxlength="80"></div>
      <div class="campo"><label>Telefone</label><input name="telefone" type="tel"></div>
      <p class="dica">O telefone só pode ser corrigido enquanto o contato ainda não tem conversa — depois disso, as mensagens já trocadas ficariam ligadas ao número errado.</p>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-wpp-salvar-contato>Salvar</button>
      </div>`);
    const campoNome = wrap.querySelector('input[name="nome"]');
    const campoTel = wrap.querySelector('input[name="telefone"]');
    campoNome.value = nomeAtual;
    campoTel.value = telefoneAtual;
    campoNome.focus();
    campoNome.setSelectionRange(campoNome.value.length, campoNome.value.length);
    const salvar = async () => {
      const nome = campoNome.value.trim();
      if (!nome) { campoNome.focus(); return; }
      await chamarApi(`/whatsapp/contatos/${id}`, { method: "PUT", body: { nome, telefone: campoTel.value.trim() } });
      fecharModais();
      definirFlash("ok", "Contato atualizado.");
      await modalContatos();
    };
    wrap.querySelector("[data-wpp-salvar-contato]").addEventListener("click", salvar);
    campoNome.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); salvar(); } });
  }

  async function modalContatos() {
    const contatos = await chamarApi("/whatsapp/contatos");
    abrirModal(`
      <h3 style="margin-top:0; display:flex; align-items:center; justify-content:space-between; gap:10px;">
        <span>Contatos</span>
        <button type="button" class="botao secundario pequeno" data-acao="abrir-criar-grupo">👥 Criar grupo</button>
      </h3>
      <form data-form="criar-contato" style="display:flex; gap:6px; margin-bottom:16px;">
        <input name="telefone" type="tel" placeholder="Telefone (com DDD)" required style="flex:1;">
        <input name="nome" placeholder="Nome" style="flex:1;">
        <button type="submit" class="botao secundario pequeno">Adicionar</button>
      </form>
      <form data-form="importar-contatos" style="margin-bottom:16px;">
        <div class="campo">
          <label>Importar contatos do celular (arquivo .csv ou .vcf exportado da agenda)</label>
          <input type="file" name="arquivo" accept=".csv,.vcf" required>
        </div>
        <button type="submit" class="botao secundario pequeno">Importar</button>
      </form>
      <hr style="border-color:var(--borda); margin-bottom:14px;">
      <form data-form="buscar-contatos-modal" style="display:flex; gap:6px; margin-bottom:12px;">
        <input type="search" name="q" placeholder="Buscar contato por nome ou telefone…" class="wpp-busca-input">
        <button type="submit" class="botao-icone" title="Buscar">🔍</button>
      </form>
      <div class="wpp-contatos-lista" data-wpp-contatos-lista>${htmlListaContatosModal(contatos)}</div>`);
  }

  function modalFecharConversa(conversaId) {
    abrirModal(`
      <h3 style="margin-top:0;">Encerrar atendimento</h3>
      <p class="texto-suave">Confirma encerrar este atendimento? O cliente passa pelo menu de novo se chamar sobre outro assunto depois.</p>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <button type="button" class="botao" data-acao="fechar-conversa-com-resultado" data-id="${conversaId}">Confirmar encerramento</button>
      </div>`);
  }

  function modalResumo(conversaId, resumoAtual) {
    abrirModal(`
      <h3 style="margin-top:0;">📝 Resumo do atendimento</h3>
      <p class="dica">Pra quem abrir a conversa depois não precisar reler tudo (útil sobretudo após um "Encaminhar").</p>
      <form data-form="salvar-resumo" data-conversa-id="${conversaId}">
        <div class="campo">
          <textarea name="resumo" rows="4" placeholder="Ex.: cliente perguntou sobre o produto X, aguardando confirmação de estoque…">${escapeHtml(resumoAtual || "")}</textarea>
        </div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Salvar resumo</button>
        </div>
      </form>`);
  }

  function modalTags(conversaId, todasTags, marcadas, interna) {
    abrirModal(`
      <h3 style="margin-top:0;">Etiquetas</h3>
      <p class="dica">Suas etiquetas — os colegas não veem as que você marca aqui.</p>
      <form data-form="definir-tags-conversa" data-conversa-id="${conversaId}" data-interna="${interna ? "1" : "0"}">
        <div class="wpp-tags-checklist">
          ${todasTags.length ? todasTags.map((t) => `
            <label class="wpp-tag-check">
              <input type="checkbox" name="tag_ids" value="${t.id}" ${marcadas.includes(t.id) ? "checked" : ""}>
              <span class="wpp-tag-chip" style="background:${t.cor};">${escapeHtml(t.nome)}</span>
            </label>`).join("") : '<p class="texto-suave">Nenhuma etiqueta cadastrada ainda.</p>'}
        </div>
        <hr style="margin:14px 0; border-color:var(--borda);">
        <div class="campo"><label>Nova etiqueta</label>
          <div style="display:flex; gap:8px;">
            <input name="nova_tag_nome" placeholder="Ex.: Urgente" style="flex:1;">
            <input type="color" name="nova_tag_cor" value="#6b7280" style="width:44px; padding:2px;">
            <button type="button" class="botao secundario pequeno" data-acao="criar-tag-inline">Criar</button>
          </div>
        </div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Salvar</button>
        </div>
      </form>`);
  }

  function modalEditarEtiqueta(tag, interna) {
    abrirModal(`
      <h3 style="margin-top:0;">Editar etiqueta</h3>
      <form data-form="salvar-edicao-etiqueta" data-id="${tag.id}" data-interna="${interna ? "1" : "0"}">
        <div class="campo"><label>Nome</label><input name="nome" value="${escapeHtml(tag.nome)}" required autofocus></div>
        <div class="campo"><label>Cor</label><input type="color" name="cor" value="${escapeHtml(tag.cor || "#6b7280")}" style="width:60px; padding:2px;"></div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Salvar</button>
        </div>
      </form>`);
  }

  function modalGerenciarRespostas(respostas) {
    const linhas = respostas.length
      ? respostas.map((r) => `
        <div class="wpp-resposta-linha">
          <div><strong>/${escapeHtml(r.atalho)}</strong> — ${escapeHtml(r.titulo)}<div class="texto-suave">${escapeHtml(r.texto)}</div></div>
          <button type="button" class="botao-icone" data-acao="excluir-resposta-pronta" data-id="${r.id}" title="Excluir">🗑️</button>
        </div>`).join("")
      : '<p class="texto-suave">Nenhuma resposta pronta ainda.</p>';
    abrirModal(`
      <h3 style="margin-top:0;">Respostas prontas</h3>
      <div class="wpp-respostas-gerenciar-lista">${linhas}</div>
      <hr style="margin:16px 0; border-color:var(--borda);">
      <form data-form="criar-resposta-pronta">
        <div class="campo"><label>Atalho (curto, sem espaço)</label><input name="atalho" placeholder="orcamento" required></div>
        <div class="campo"><label>Título</label><input name="titulo" placeholder="Pedir dados pro orçamento" required></div>
        <div class="campo"><label>Texto da mensagem</label><textarea name="texto" rows="3" required></textarea></div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Fechar</button>
          <button type="submit" class="botao">+ Adicionar resposta</button>
        </div>
      </form>`);
  }

  function modalAgendar(conversaId) {
    abrirModal(`
      <h3 style="margin-top:0;">Agendar envio de mensagem</h3>
      <p class="dica">A mensagem é enviada automaticamente no horário escolhido, mesmo que ninguém esteja com a conversa aberta. Pode agendar quantas quiser, uma de cada vez — em dias diferentes ou várias no mesmo dia — sem fechar esta janela.</p>
      <div data-wpp-agendadas-sessao></div>
      <form data-form="agendar-mensagem" data-conversa-id="${conversaId}">
        <div class="campo"><label>Mensagem</label><textarea name="texto" rows="3" required></textarea></div>
        <div class="campo"><label>Anexo (opcional)</label><input type="file" name="arquivo"></div>
        <div class="campo"><label>Enviar em</label><input type="datetime-local" name="agendado_para" min="${minDatetimeLocal(1)}" required></div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Fechar</button>
          <button type="submit" class="botao">+ Agendar este envio</button>
        </div>
      </form>`);
  }

  function modalLembrete(conversaId) {
    abrirModal(`
      <h3 style="margin-top:0;">Criar lembrete de retorno</h3>
      <p class="dica">Avisa você (ou outra pessoa) para entrar em contato com este cliente de novo na data escolhida.</p>
      <form data-form="criar-lembrete" data-conversa-id="${conversaId}">
        <div class="campo"><label>Lembrar em</label><input type="datetime-local" name="lembrar_em" min="${minDatetimeLocal(1)}" required></div>
        <div class="campo"><label>Anotação (opcional)</label><textarea name="texto" rows="2" placeholder="Ex.: ligar para fechar a negociação"></textarea></div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Criar lembrete</button>
        </div>
      </form>`);
  }

  // =======================================================================
  // CONFIGURAÇÃO (admin)
  // =======================================================================
  const SELO_STATUS_CONEXAO = {
    conectado: ["ativo", "Conectado"],
    aguardando_qrcode: ["amarelo", "Aguardando QR Code"],
    desconectado: ["inativo", "Desconectado"],
    erro: ["bloqueado", "Erro"],
  };

  function htmlSecaoConexao(config, webhookUrl) {
    const [seloClasse, seloTexto] = SELO_STATUS_CONEXAO[config.status_conexao] || ["inativo", config.status_conexao];
    return `
       <h3 style="margin-top:0;">Conexão <span class="selo ${seloClasse}">${seloTexto}</span></h3>
       ${webhookUrl ? `
         <div class="campo">
           <label>URL de webhook (cole na configuração da instância na Evolution API)</label>
           <div class="wpp-webhook-url"><input readonly value="${escapeHtml(webhookUrl)}"><button type="button" class="botao secundario pequeno" data-acao="copiar-webhook-url">Copiar</button></div>
         </div>` : `<p class="texto-suave">Ative e salve a configuração acima para gerar a URL de webhook.</p>`}

       <div class="barra-acoes">
         ${config.status_conexao !== "conectado"
           ? `<button class="botao" data-acao="conectar-whatsapp" ${!config.ativo || !config.evolution_url ? "disabled" : ""}>Conectar (gerar QR Code)</button>
              <button class="botao secundario" data-acao="abrir-conectar-numero" ${!config.ativo || !config.evolution_url ? "disabled" : ""}>Conectar sem QR Code (código)</button>`
           : `<button class="botao perigo" data-acao="desconectar-whatsapp">Desconectar</button>`}
       </div>

       ${config.status_conexao === "aguardando_qrcode" && config.qrcode_base64 ? `
         <div class="wpp-qrcode-wrap" data-wpp-qr-area>
           <div class="wpp-qrcode-moldura">
             <img class="wpp-qrcode" src="data:image/png;base64,${config.qrcode_base64}" alt="QR Code de pareamento do WhatsApp">
             <div class="wpp-qrcode-expirado" data-wpp-qr-expirado hidden>
               <strong>Código expirado</strong>
               <span>O WhatsApp troca o código a cada meio minuto.</span>
               <button type="button" class="botao pequeno" data-acao="novo-qrcode">Gerar um novo</button>
             </div>
           </div>
           <p class="wpp-qrcode-validade" data-wpp-qr-validade></p>
           <p class="texto-suave">No celular: <strong>WhatsApp → Aparelhos conectados → Conectar um aparelho</strong> e aponte a câmera. Deixe a tela do WhatsApp já aberta antes de gerar o código — ele vale por pouco tempo.</p>
         </div>` : ""}

       ${config.status_conexao === "conectado" && config.numero_conectado ? `<p>Número conectado: <strong>${escapeHtml(config.numero_conectado)}</strong></p>` : ""}
    `;
  }

  function modalDesconectarWhatsapp() {
    abrirModal(`
      <h3 style="margin-top:0;">Desconectar o WhatsApp</h3>
      <p class="dica">Você vai conectar o <strong>mesmo número</strong> de WhatsApp de antes, ou vai ler o QR Code com um número diferente?</p>
      <div style="display:flex; flex-direction:column; gap:10px; margin:16px 0;">
        <button type="button" class="botao secundario largura-total" style="text-align:left;" data-acao="desconectar-whatsapp-confirmado" data-limpeza="manter">
          <strong>É o mesmo número</strong><br><span class="texto-suave">Não mexe em nada — as conversas continuam aparecendo normalmente depois de reconectar.</span>
        </button>
        <button type="button" class="botao secundario largura-total" style="text-align:left;" data-acao="abrir-desconectar-numero-diferente">
          <strong>É um número diferente</strong><br><span class="texto-suave">Escolher o que fazer com as conversas do número atual.</span>
        </button>
      </div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
      </div>`);
  }

  function modalDesconectarNumeroDiferente() {
    abrirModal(`
      <h3 style="margin-top:0;">Número diferente — o que fazer com as conversas atuais?</h3>
      <p class="dica">Já que vai ser outro número, o que acontece com tudo que está salvo agora?</p>
      <div style="display:flex; flex-direction:column; gap:10px; margin:16px 0;">
        <button type="button" class="botao secundario largura-total" style="text-align:left;" data-acao="desconectar-whatsapp-confirmado" data-limpeza="ocultar">
          <strong>Ocultar até esse número conectar de novo</strong><br><span class="texto-suave">Arquiva todas as conversas agora — somem da tela, mas nada é apagado (dá pra ver depois em "Arquivadas").</span>
        </button>
        <button type="button" class="botao perigo largura-total" style="text-align:left;" data-acao="desconectar-whatsapp-confirmado" data-limpeza="apagar">
          <strong>Apagar tudo e começar do zero</strong><br><span style="opacity:0.85;">Some de vez com contatos, conversas, mensagens e anexos do número anterior. Não tem como desfazer.</span>
        </button>
      </div>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
      </div>`);
  }

  function modalConectarPorNumero() {
    abrirModal(`
      <h3 style="margin-top:0;">Conectar sem QR Code</h3>
      <p class="dica">Use isso se não conseguir escanear o QR Code — por exemplo, um número fixo sem celular à mão. Esse número já precisa ter WhatsApp (ou WhatsApp Business) ativo em algum aparelho; aqui você só vai digitar um código, sem precisar de câmera.</p>
      <form data-form="conectar-whatsapp-numero">
        <div class="campo">
          <label>Número (com DDD, só números)</label>
          <input name="numero" placeholder="4834201881" required pattern="[0-9]{10,15}" inputmode="numeric">
          <p class="dica">Pode digitar com ou sem o 55 na frente (ex: 4834201881 ou 554834201881) — o sistema completa sozinho. Só não esqueça o DDD.</p>
        </div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Gerar código</button>
        </div>
      </form>`);
  }

  function modalRenomearContato(contatoId, nomeAtual) {
    abrirModal(`
      <h3 style="margin-top:0;">Nome do contato</h3>
      <p class="dica">Esse nome é <strong>só seu</strong> — os outros atendentes continuam vendo o nome original. Deixe em branco pra voltar ao nome de cadastro.</p>
      <form data-form="renomear-contato" data-contato-id="${contatoId}">
        <div class="campo"><label>Nome</label><input name="nome" value="${escapeHtml(nomeAtual)}" autofocus></div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Salvar</button>
        </div>
      </form>`);
  }

  function modalApelidoInterno(conversaId, apelidoAtual) {
    abrirModal(`
      <h3 style="margin-top:0;">Apelido</h3>
      <p class="dica">Só você vê esse nome — não muda o cadastro da pessoa pra mais ninguém. Deixe em branco pra voltar ao nome de cadastro.</p>
      <form data-form="definir-apelido-interno" data-conversa-id="${conversaId}">
        <div class="campo"><label>Apelido</label><input name="apelido" value="${escapeHtml(apelidoAtual || "")}" autofocus></div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Salvar</button>
        </div>
      </form>`);
  }

  function modalCodigoPareamento(codigo) {
    abrirModal(`
      <h3 style="margin-top:0;">Código de pareamento</h3>
      <p class="dica">No aparelho onde esse número tem WhatsApp: Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone → digite o código abaixo.</p>
      <p class="wpp-codigo-pareamento" style="font-size:28px; font-weight:700; letter-spacing:4px; text-align:center; margin:20px 0; font-variant-numeric:tabular-nums;">${escapeHtml(codigo)}</p>
      <div class="rodape-modal">
        <button type="button" class="botao" data-acao="fechar-modal">Concluído</button>
      </div>`);
  }

  async function buscarConfigECriarWebhookUrl() {
    const config = await chamarApi("/whatsapp/configuracao");
    let webhookUrl = null;
    if (config.webhook_segredo_configurado) {
      try { webhookUrl = (await chamarApi("/whatsapp/webhook-url")).url; } catch (e) { /* ainda sem segredo */ }
    }
    return { config, webhookUrl };
  }

  async function renderWhatsappConfiguracao() {
    _carregandoSeTrocouDeTela("configuracao");
    const etiquetas = await chamarApi("/whatsapp/tags").catch(() => []);
    // Backup é do banco inteiro (todas as empresas), então só quem opera
    // a plataforma tem acesso — o servidor barra de qualquer jeito, aqui
    // é só pra não mostrar uma seção que daria erro ao usar.
    const ehSuperAdmin = !!state.usuarioAtual.super_admin;
    const [{ config, webhookUrl }, setoresDetalhado, backups, catalogos, usuarios] = await Promise.all([
      buscarConfigECriarWebhookUrl(),
      chamarApi("/usuarios/setores/detalhado"),
      ehSuperAdmin ? chamarApi("/sistema/backups") : Promise.resolve([]),
      chamarApi("/whatsapp/catalogos?todos=1").catch(() => []),
      chamarApi("/usuarios").catch(() => []),
    ]);
    const setoresAtuais = setoresDetalhado.map((s) => s.nome);

    renderShell(
      `<h2>Configuração</h2>
       <div class="cartao">
         <h3 style="margin-top:0;">Conexão — Evolution API</h3>
         <p class="dica">
           Conexão <strong>não-oficial</strong>, via <a href="https://github.com/EvolutionAPI/evolution-api" target="_blank" rel="noopener">Evolution API</a>
           (auto-hospedada, gratuita) — não é a API oficial da Meta. O número pode ser banido em caso de uso
           abusivo (disparo em massa, sem resposta humana). Use só para atendimento normal, um a um.
           Veja o passo a passo completo no README.
         </p>
         <form data-form="salvar-configuracao">
           <div class="campo campo-checkbox"><label><input type="checkbox" name="ativo" ${config.ativo ? "checked" : ""}> Ativo</label></div>
           <div class="campo"><label>URL da Evolution API</label><input name="evolution_url" value="${escapeHtml(config.evolution_url || "")}" placeholder="http://localhost:8080"></div>
           <div class="campo"><label>Nome da instância</label><input name="instancia_nome" value="${escapeHtml(config.instancia_nome || "whatts")}"></div>
           <div class="campo"><label>Chave de API</label>
             <div class="campo-senha">
               <input name="evolution_apikey" type="password" autocomplete="new-password"
                 placeholder="${config.apikey_configurada ? "deixe em branco para manter a chave atual" : "nenhuma chave configurada ainda"}">
               <button type="button" class="botao-mostrar-senha" data-acao="alternar-mostrar-senha" title="Mostrar/ocultar" tabindex="-1">👁️</button>
             </div></div>
           <div class="campo"><label>Endereço do webhook (avançado)</label>
             <input name="webhook_base_url" value="${escapeHtml(config.webhook_base_url || "")}" placeholder="http://host.docker.internal:5050 (padrão)">
             <p class="dica">Endereço pelo qual a Evolution API consegue chamar de volta este servidor pra entregar mensagens recebidas. Deixe em branco pra usar o padrão (Docker local).</p>
           </div>
           ${config.atualizado_em ? `<p class="dica">Última alteração: ${fmtData(config.atualizado_em)}.</p>` : ""}
           <div class="rodape-modal" style="padding:0; justify-content:flex-start;"><button type="submit" class="botao">Salvar</button></div>
         </form>
       </div>

       <div class="cartao" data-wpp-secao-conexao>${htmlSecaoConexao(config, webhookUrl)}</div>

       <div class="cartao">
         <h3 style="margin-top:0;">Logo da empresa</h3>
         <p class="dica">Aparece na tela de login. Use png, jpg, gif, webp ou svg (até 3MB). Fundo transparente costuma ficar melhor.</p>
         <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
           <img src="${config.logo_url || "/static/img/logo_alphafitus.png"}" alt="" style="max-width:150px; max-height:80px; object-fit:contain; background:var(--superficie-2); border-radius:10px; padding:8px;">
           <form data-form="enviar-logo" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
             <input type="file" name="logo" accept="image/*" required>
             <button type="submit" class="botao secundario">Enviar</button>
             ${config.logo_url ? '<button type="button" class="botao-icone" data-acao="remover-logo" title="Voltar pra logo padrão">🗑️</button>' : ""}
           </form>
         </div>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">Setores</h3>
         <p class="dica">Pra onde o cliente é direcionado no menu automático do WhatsApp, e o que cada atendente escolhe como área dele. Crie, renomeie ou exclua livremente — a ordem abaixo é a mesma ordem dos números que o cliente digita no menu.</p>
         ${setoresDetalhado.some((s) => s.atendentes === 0) ? `
           <p class="aviso-setor-vazio">⚠️ Os setores marcados abaixo estão no menu mas <strong>não têm ninguém cadastrado</strong>. O cliente que escolher um deles vai pra fila de <em>todos</em> os atendentes, porque não existe um dono. Ou cadastre alguém no setor (em Usuários), ou tire ele do menu.</p>` : ""}
         <ul style="list-style:none; padding:0; margin:0 0 14px; display:flex; flex-direction:column; gap:8px;">
           ${setoresDetalhado.map((s, i) => `
             <li style="display:flex; align-items:center; gap:8px;">
               <span class="texto-suave" style="min-width:20px;">${i + 1}.</span>
               <input value="${escapeHtml(s.nome)}" data-acao-change="renomear-setor" data-setor-id="${s.id}" style="flex:1;">
               ${s.atendentes === 0
                 ? `<span class="selo-setor-vazio" title="Ninguém está cadastrado neste setor. O cliente que escolher este número cai na fila de todo mundo, porque não há dono.">⚠️ sem atendente</span>`
                 : `<span class="texto-suave" style="font-size:12px; white-space:nowrap;">${s.atendentes} atendente${s.atendentes > 1 ? "s" : ""}</span>`}
               <button type="button" class="botao-icone" data-acao="excluir-setor" data-id="${s.id}" data-nome="${escapeHtml(s.nome)}" title="Excluir setor">🗑️</button>
             </li>`).join("")}
         </ul>
         <form data-form="criar-setor" style="display:flex; gap:8px;">
           <input name="nome" placeholder="Nome do novo setor" required style="flex:1;">
           <button type="submit" class="botao secundario">Adicionar setor</button>
         </form>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">🛡️ Proteção contra bloqueio do WhatsApp</h3>
         <p class="dica">
           A conexão é <strong>não-oficial</strong>: o WhatsApp pode bloquear o número se o comportamento
           parecer de robô. O que mais derruba número, em ordem: <strong>denúncia de quem recebeu</strong>,
           mandar pra quem <strong>nunca falou com a gente</strong>, e <strong>rajada de mensagens</strong>.
           Os freios abaixo seguram os dois últimos. O primeiro só depende de atender gente de verdade —
           nenhum sistema protege de disparo em massa.
         </p>
         <form data-form="salvar-limites-envio" class="wpp-limites">
           <div class="campo">
             <label>Mensagens por minuto</label>
             <input type="number" name="limite_envios_minuto" min="0" max="200" value="${config.limite_envios_minuto ?? 20}">
             <span class="dica">Pega o disparo em rajada. Atendimento humano raramente passa de 20.</span>
           </div>
           <div class="campo">
             <label>Mensagens por hora</label>
             <input type="number" name="limite_envios_hora" min="0" max="5000" value="${config.limite_envios_hora ?? 250}">
             <span class="dica">Pega o disparo espalhado. Suba se a equipe crescer e o freio atrapalhar.</span>
           </div>
           <div class="campo">
             <label>Conversas novas por hora</label>
             <input type="number" name="limite_novos_contatos_hora" min="0" max="500" value="${config.limite_novos_contatos_hora ?? 20}">
             <span class="dica"><strong>O mais importante.</strong> Conta só quem nunca escreveu pra gente — é daí que vem denúncia.</span>
           </div>
           <div class="campo" style="align-self:end;">
             <button type="submit" class="botao secundario">Salvar limites</button>
           </div>
         </form>
         <p class="dica" style="margin-bottom:0;">0 desliga o freio. Só faça isso sabendo o risco: sem ele, um envio em massa por engano pode custar o número da empresa.</p>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">📚 Portfólio e catálogos</h3>
         <p class="dica">O que a equipe manda pro cliente em um clique, pelo botão 📚 dentro da conversa. Dois formatos: <strong>link</strong> (o portfólio que já está no ar, sempre atualizado) e <strong>PDF</strong> (tabela de preço, encarte — o que não cabe no site). Em cada um você escolhe <strong>quem pode mandar</strong>.</p>

         <div class="wpp-catalogos-lista">
           ${catalogos.length ? catalogos.map((c) => `
             <div class="wpp-catalogo-item ${c.ativo ? "" : "wpp-catalogo-desligado"}">
               <div class="wpp-catalogo-topo">
                 <span class="wpp-catalogo-icone">${c.tipo === "pdf" ? "📄" : "🌐"}</span>
                 <input value="${escapeHtml(c.nome)}" data-acao-change="renomear-catalogo" data-id="${c.id}" style="flex:1; font-weight:600;">
                 <button type="button" class="botao-icone" data-acao="alternar-catalogo-ativo" data-id="${c.id}" data-ativo="${c.ativo ? 1 : 0}" title="${c.ativo ? "Desligar (some da lista da equipe)" : "Ligar"}">${c.ativo ? "👁" : "🚫"}</button>
                 <button type="button" class="botao-icone" data-acao="excluir-catalogo" data-id="${c.id}" data-nome="${escapeHtml(c.nome)}" title="Excluir">🗑️</button>
               </div>
               <div class="wpp-catalogo-endereco">
                 ${c.tipo === "pdf"
                   ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.nome_arquivo || "ver arquivo")}</a>`
                   : `<input value="${escapeHtml(c.url)}" data-acao-change="trocar-url-catalogo" data-id="${c.id}" placeholder="https://…">`}
               </div>
               <label class="wpp-catalogo-restrito">
                 <input type="checkbox" data-acao-change="alternar-catalogo-restrito" data-id="${c.id}" ${c.restrito ? "checked" : ""}>
                 <span>Só algumas pessoas podem mandar este catálogo</span>
               </label>
               ${c.restrito ? `
                 <div class="wpp-catalogo-quem" data-quem="${c.id}">
                   ${usuarios.filter((u) => u.ativo).map((u) => `
                     <label class="wpp-catalogo-pessoa">
                       <input type="checkbox" data-acao-change="marcar-usuario-catalogo" data-id="${c.id}" data-usuario="${u.id}" ${(c.usuarios || []).includes(u.id) ? "checked" : ""}>
                       <span>${escapeHtml(u.nome)}${u.admin ? " (admin)" : ""}</span>
                     </label>`).join("")}
                   <p class="dica" style="margin:6px 0 0;">Administrador manda qualquer catálogo, marcado ou não.</p>
                 </div>` : ""}
             </div>`).join("") : `<p class="dica">Nenhum catálogo cadastrado ainda.</p>`}
         </div>

         <form data-form="criar-catalogo" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:14px;">
           <input name="nome" placeholder="Nome (ex.: Portfólio 2026)" required style="flex:1; min-width:180px;">
           <input name="url" placeholder="https://…" required style="flex:2; min-width:220px;">
           <button type="submit" class="botao secundario">+ Adicionar link</button>
         </form>
         <form data-form="subir-catalogo-pdf" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; align-items:center;">
           <input name="nome" placeholder="Nome (ex.: Tabela de preços)" style="flex:1; min-width:180px;">
           <input type="file" name="arquivo" accept=".pdf,.doc,.docx,.xls,.xlsx" required style="flex:2; min-width:220px;">
           <button type="submit" class="botao secundario">+ Enviar PDF</button>
         </form>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">Minhas etiquetas</h3>
         <p class="dica">Marque conversas por assunto ou fase — "Orçamento enviado", "Cliente novo", "Urgente" — e depois filtre a lista por elas. <strong>São suas:</strong> ninguém mais vê as etiquetas que você põe, e cada colega tem as dele (dois podem ter uma "Urgente" cada um, com cores diferentes). Valem tanto nas conversas de cliente quanto no chat interno. Renomear ou trocar a cor aqui muda em todas as suas conversas já etiquetadas de uma vez.</p>
         <ul style="list-style:none; padding:0; margin:0 0 14px; display:flex; flex-direction:column; gap:8px;">
           ${etiquetas.map((t) => `
             <li style="display:flex; align-items:center; gap:8px;">
               <input type="color" value="${escapeHtml(t.cor || "#6b7280")}" data-acao-change="recolorir-etiqueta" data-tag-id="${t.id}" style="width:44px; padding:2px; flex-shrink:0;" title="Cor da etiqueta">
               <input value="${escapeHtml(t.nome)}" data-acao-change="renomear-etiqueta" data-tag-id="${t.id}" style="flex:1;">
               <span class="wpp-tag-chip" style="background:${escapeHtml(t.cor || "#6b7280")};">${escapeHtml(t.nome)}</span>
               <button type="button" class="botao-icone" data-acao="excluir-etiqueta" data-id="${t.id}" data-nome="${escapeHtml(t.nome)}" title="Excluir etiqueta">🗑️</button>
             </li>`).join("")}
           ${etiquetas.length ? "" : '<li class="texto-suave" style="font-size:13px;">Nenhuma etiqueta criada ainda.</li>'}
         </ul>
         <form data-form="criar-etiqueta" style="display:flex; gap:8px;">
           <input type="color" name="cor" value="#0a7d67" style="width:44px; padding:2px;" title="Cor">
           <input name="nome" placeholder="Nome da nova etiqueta" required style="flex:1;">
           <button type="submit" class="botao secundario">Adicionar etiqueta</button>
         </form>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">Fotos dos contatos</h3>
         <p class="dica">Na lista de conversas aparece a foto de perfil do WhatsApp de cada cliente; quem não tem foto pública fica com as iniciais. Contatos que já existiam antes de conectar o número foram criados sem foto — este botão busca todas de uma vez.</p>
         <button type="button" class="botao secundario" data-acao="atualizar-fotos-contatos">🖼️ Buscar fotos que faltam</button>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">Mensagem de saudação</h3>
         <p class="dica">É a primeira mensagem que o cliente recebe. Deixe em branco pra usar o padrão automático (saudação simples + lista gerada a partir dos setores cadastrados). Se escrever aqui, esse texto vale <strong>exatamente como está escrito</strong> — inclusive a lista numerada — nada é acrescentado depois.</p>
         <p class="dica">Importante: mantenha os números 1, 2, 3… na <strong>mesma ordem</strong> dos setores cadastrados hoje (${setoresAtuais.map((s, i) => `${i + 1}=${s}`).join(", ")}) — é por esse número que o sistema sabe pra qual setor direcionar, o texto ao lado do número é só o que o cliente lê.</p>
         <form data-form="salvar-saudacao">
           <div class="campo">
             <textarea name="saudacao_mensagem" rows="10" placeholder="${escapeHtml(SAUDACAO_MENU_PADRAO)}\n\n1. Televendas\n2. Financeiro\n...">${escapeHtml(config.saudacao_mensagem || "")}</textarea>
           </div>
           <div class="rodape-modal" style="padding:0; justify-content:flex-start;"><button type="submit" class="botao">Salvar</button></div>
         </form>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">Assinar mensagens com o nome de quem atende</h3>
         <p class="dica">O WhatsApp não mostra pro cliente qual atendente da equipe está falando — ele só vê o número/perfil da empresa. Ligando isto, toda mensagem de texto sai com o nome de quem respondeu na frente (ex.: "<strong>Andreia:</strong> Bom dia!"). Vale só pra texto digitado na hora — não mexe em áudio, imagem, documento nem nas mensagens automáticas do menu.</p>
         <form data-form="salvar-assinar-mensagens">
           <div class="campo campo-checkbox"><label><input type="checkbox" name="assinar_mensagens" ${config.assinar_mensagens ? "checked" : ""}> Assinar com o nome do atendente</label></div>
           <div class="rodape-modal" style="padding:0; justify-content:flex-start;"><button type="submit" class="botao secundario">Salvar</button></div>
         </form>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">📍 Localização</h3>
         <p class="dica">Cadastre uma vez o endereço da empresa — depois é só clicar em 📍 em qualquer conversa (WhatsApp ou chat interno) pra compartilhar, sem digitar de novo. Se estiver no local agora, "Usar minha localização atual" preenche latitude/longitude sozinho.</p>
         <form data-form="salvar-localizacao">
           <div class="campo"><label>Nome do lugar</label><input name="localizacao_nome" placeholder="Ex.: Alphafitus — sede" value="${escapeHtml(config.localizacao_nome || "")}"></div>
           <div class="campo"><label>Endereço (aparece embaixo do nome)</label><input name="localizacao_endereco" placeholder="Rua Exemplo, 123 — Bairro, Cidade/UF" value="${escapeHtml(config.localizacao_endereco || "")}"></div>
           <div style="display:flex; gap:8px;">
             <div class="campo" style="flex:1;"><label>Latitude</label><input name="localizacao_lat" type="number" step="any" value="${config.localizacao_lat != null ? config.localizacao_lat : ""}"></div>
             <div class="campo" style="flex:1;"><label>Longitude</label><input name="localizacao_lng" type="number" step="any" value="${config.localizacao_lng != null ? config.localizacao_lng : ""}"></div>
           </div>
           <button type="button" class="botao secundario pequeno" data-acao="usar-localizacao-atual" style="margin-bottom:12px;">📍 Usar minha localização atual</button>
           <div class="rodape-modal" style="padding:0; justify-content:flex-start;"><button type="submit" class="botao secundario">Salvar</button></div>
         </form>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">Horário de funcionamento</h3>
         <p class="dica">Fora dessas janelas, quem escrever recebe um aviso automático em vez de silêncio.</p>
         <form data-form="salvar-expediente">
           <div class="campo campo-checkbox"><label><input type="checkbox" name="expediente_ativo" ${config.expediente_ativo ? "checked" : ""}> Ativar aviso de fora do expediente</label></div>
           <div class="campo">
             <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
               <input type="time" name="janela1_inicio" value="${(config.expediente_janelas[0] || {}).inicio || ""}"> <span class="texto-suave">até</span> <input type="time" name="janela1_fim" value="${(config.expediente_janelas[0] || {}).fim || ""}">
             </div>
             <div style="display:flex; gap:8px; align-items:center;">
               <input type="time" name="janela2_inicio" value="${(config.expediente_janelas[1] || {}).inicio || ""}"> <span class="texto-suave">até</span> <input type="time" name="janela2_fim" value="${(config.expediente_janelas[1] || {}).fim || ""}">
             </div>
           </div>
           <div class="campo"><label>Mensagem automática (opcional)</label>
             <textarea name="expediente_mensagem" rows="2" placeholder="No momento estamos fora do horário de atendimento…">${escapeHtml(config.expediente_mensagem || "")}</textarea>
           </div>
           <div class="campo"><label>Alertar conversa parada após (minutos)</label>
             <input type="number" name="sla_minutos_alerta" min="1" value="${config.sla_minutos_alerta || 15}" style="max-width:120px;">
           </div>
           <div class="rodape-modal" style="padding:0; justify-content:flex-start;"><button type="submit" class="botao">Salvar</button></div>
         </form>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">Avisos automáticos</h3>
         <p class="dica">Mensagens que o próprio sistema manda sozinho no chat interno, sem ninguém precisar clicar em nada.</p>
         <form data-form="salvar-avisos-automaticos">
           <div class="campo">
             <label>Usuário do sistema</label>
             <select name="usuario_sistema_id">
               <option value="">Nenhum — usa o administrador mais antigo</option>
               ${usuarios.filter((u) => u.ativo).map((u) => `<option value="${u.id}" ${config.usuario_sistema_id === u.id ? "selected" : ""}>${escapeHtml(u.nome)}</option>`).join("")}
             </select>
             <p class="texto-suave" style="font-size:11.5px; margin:4px 0 0;">De quem saem os avisos abaixo (lembrete de follow-up, fila parada). Pensando também em, mais pra frente, ser a conta da IA quando for liberada.</p>
           </div>
           <div class="campo">
             <label>Follow-up: avisar o responsável quando o atraso passar de (dias além do prazo)</label>
             <input type="number" name="followup_dias_aviso_automatico" min="0" max="60"
               value="${config.followup_dias_aviso_automatico ?? ""}" placeholder="Deixe em branco para desligar" style="max-width:160px;">
             <p class="texto-suave" style="font-size:11.5px; margin:4px 0 0;">0 ou em branco desliga — o botão manual "🔔 Avisar" no Follow-up continua funcionando do mesmo jeito.</p>
           </div>
           <div class="campo campo-checkbox">
             <label><input type="checkbox" name="aviso_fila_sem_escolha_ativo" ${config.aviso_fila_sem_escolha_ativo ? "checked" : ""}>
               Avisar quando tiver cliente esperando no "Sem escolha" há mais de 10 minutos</label>
           </div>
           <div class="campo">
             <label>Avisar quem (deixe tudo desmarcado para avisar todo mundo online)</label>
             <div style="display:flex; flex-wrap:wrap; gap:10px; margin-top:4px;">
               ${setoresAtuais.map((nome) => `
                 <label style="display:flex; align-items:center; gap:5px; font-weight:400;">
                   <input type="checkbox" name="aviso_fila_sem_escolha_setores" value="${escapeHtml(nome)}" ${(config.aviso_fila_sem_escolha_setores || []).includes(nome) ? "checked" : ""}>
                   ${escapeHtml(nome)}
                 </label>`).join("")}
             </div>
           </div>
           <hr style="border:none; border-top:1px solid var(--borda); margin:16px 0;">
           <p class="dica" style="margin-top:0;">Mais avisos (desligados até você ligar aqui):</p>
           <div class="campo campo-checkbox">
             <label><input type="checkbox" name="aviso_sla_ativo" ${config.aviso_sla_ativo ? "checked" : ""}>
               Conversa parada sem resposta — avisar o responsável quando estourar o tempo combinado</label>
           </div>
           <div class="campo campo-checkbox">
             <label><input type="checkbox" name="aviso_resumo_diario_ativo" ${config.aviso_resumo_diario_ativo ? "checked" : ""}>
               Resumo diário pro administrador (atendimentos, atrasados, nota média)</label>
           </div>
           <div class="campo campo-checkbox">
             <label><input type="checkbox" name="aviso_boasvindas_ativo" ${config.aviso_boasvindas_ativo ? "checked" : ""}>
               Boas-vindas automáticas quando cadastrar um colaborador novo</label>
           </div>
           <div class="campo campo-checkbox">
             <label><input type="checkbox" name="aviso_conversa_parada_ativo" ${config.aviso_conversa_parada_ativo ? "checked" : ""}>
               Cliente sumiu — avisar o responsável e encerrar sozinha se ninguém mexer</label>
             <p class="texto-suave" style="font-size:11.5px; margin:4px 0 0;">Quando o agente já respondeu e o cliente para de responder, a conversa fica "aberta" pra sempre até alguém fechar — o que distorce até o "pior atendimento" do Dashboard. Ativando isso: depois de X horas sem resposta do cliente, avisa o responsável; se não houver interação em Y minutos, encerra sozinha.</p>
           </div>
           <div style="display:flex; gap:16px; flex-wrap:wrap;">
             <div class="campo" style="max-width:220px;">
               <label>Avisar depois de quantas horas sem resposta do cliente</label>
               <input type="number" name="aviso_conversa_parada_horas" min="1" max="720" value="${config.aviso_conversa_parada_horas ?? 24}">
             </div>
             <div class="campo" style="max-width:220px;">
               <label>Encerrar sozinha X minutos depois do aviso</label>
               <input type="number" name="aviso_conversa_parada_minutos_fechar" min="1" max="1440" value="${config.aviso_conversa_parada_minutos_fechar ?? 10}">
             </div>
             <div class="campo" style="max-width:220px;">
               <label>Quantas vezes pode prorrogar antes de encerrar de vez</label>
               <input type="number" name="aviso_conversa_parada_max_prorrogacoes" min="0" max="20" value="${config.aviso_conversa_parada_max_prorrogacoes ?? 3}">
             </div>
           </div>
           <div class="campo campo-checkbox">
             <label><input type="checkbox" name="aviso_ligacoes_ativo" ${config.aviso_ligacoes_ativo ? "checked" : ""}>
               Lembrete de "Próximo contato" da planilha de Ligações — avisar no chat interno quando chegar o dia marcado pra ligar de novo</label>
           </div>
           <div class="campo" style="max-width:220px;">
             <label>Ao prorrogar o lembrete, adiar quantos dias</label>
             <input type="number" name="dias_prorrogar_ligacao" min="1" max="90" value="${config.dias_prorrogar_ligacao ?? 3}">
           </div>
           <div class="rodape-modal" style="padding:0; justify-content:flex-start;"><button type="submit" class="botao">Salvar</button></div>
         </form>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">📢 Envio em massa</h3>
         <p class="dica" style="background:color-mix(in srgb, var(--vermelho) 10%, transparent); padding:8px 10px; border-radius:8px;">
           ⚠️ Risco real: mandar a mesma mensagem pra muita gente de uma vez é o tipo de coisa que faz o WhatsApp marcar o número como robô e banir — mesmo com o freio de ritmo (limites de envio por minuto/hora, já configurados na Conexão) e o intervalo entre mensagens aqui embaixo. Use só quando precisar mesmo, e prefira listas pequenas.
         </p>
         <form data-form="salvar-envio-massa">
           <div class="campo campo-checkbox">
             <label><input type="checkbox" name="envio_massa_ativo" ${config.envio_massa_ativo ? "checked" : ""}> Habilitar envio em massa</label>
           </div>
           <div class="campo" style="max-width:260px;">
             <label>Intervalo entre cada mensagem (segundos)</label>
             <input type="number" name="envio_massa_intervalo_segundos" min="3" max="120" value="${config.envio_massa_intervalo_segundos ?? 8}">
             <p class="texto-suave" style="font-size:11.5px; margin:4px 0 0;">Quanto maior, mais devagar e mais parecido com uma pessoa mandando de verdade.</p>
           </div>
           <div class="rodape-modal" style="padding:0; justify-content:flex-start;"><button type="submit" class="botao">Salvar</button></div>
         </form>
       </div>

       ${!ehSuperAdmin ? "" : `
       <div class="cartao">
         <h3 style="margin-top:0;">🤖 Assistente de IA</h3>
         <p class="dica">Fase 1: só a infraestrutura, ainda sem custo nenhum. Enquanto não tiver uma chave de API cadastrada aqui, nada é chamado — fica desligado de verdade. Quando você tiver a chave da Anthropic, cola aqui e habilita; começa no modo <strong>sugestão</strong> (ele sugere, o atendente decide) e você pode desligar quando quiser.</p>
         <form data-form="salvar-ia">
           <div class="campo campo-checkbox">
             <label><input type="checkbox" name="ia_ativa" ${config.ia_ativa ? "checked" : ""}> Habilitar assistente de IA</label>
           </div>
           <div class="campo">
             <label>Chave da API (Anthropic / Claude)</label>
             <input type="password" name="ia_api_key" placeholder="${config.ia_api_key_configurada ? "•••••••••••• (já configurada — deixe em branco pra manter)" : "sk-ant-..."}" autocomplete="off">
           </div>
           <div class="campo">
             <label>Chave da API (OpenAI / ChatGPT)</label>
             <input type="password" name="ia_openai_api_key" placeholder="${config.ia_openai_api_key_configurada ? "•••••••••••• (já configurada — deixe em branco pra manter)" : "sk-..."}" autocomplete="off">
           </div>
           <p class="texto-suave" style="font-size:11.5px; margin:4px 0 0;">Pode preencher uma ou as duas — quando a fase 2 entrar, dá pra escolher qual usar.</p>
           <div class="rodape-modal" style="padding:0; justify-content:flex-start;"><button type="submit" class="botao">Salvar</button></div>
         </form>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">🗂️ Catálogo / Proposta</h3>
         <p class="dica">Fase 1: só o cadastro dos itens (em <a href="#/catalogo">Catálogo/Proposta</a> no menu), ainda sem tela pro cliente. Este botão vai controlar se a FUTURA tela do cliente fica acessível — por enquanto, deixe desligado.</p>
         <form data-form="salvar-catalogo-config">
           <div class="campo campo-checkbox">
             <label><input type="checkbox" name="catalogo_proposta_ativo" ${config.catalogo_proposta_ativo ? "checked" : ""}> Liberar catálogo pro cliente</label>
           </div>
           <div class="rodape-modal" style="padding:0; justify-content:flex-start;"><button type="submit" class="botao">Salvar</button></div>
         </form>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">Backup</h3>
         <p class="dica">Backup automático todo dia, guardando os últimos 14 dias. Baixe uma cópia de vez em quando pra guardar fora deste computador — se algo acontecer, é só importar de volta.</p>
         <div class="barra-acoes" style="margin-bottom:14px;">
           <button type="button" class="botao secundario" data-acao="fazer-backup-agora">Fazer backup agora</button>
         </div>
         <ul style="list-style:none; padding:0; margin:0 0 16px; display:flex; flex-direction:column; gap:8px;">
           ${backups.length ? backups.map((nome) => `
             <li style="display:flex; align-items:center; gap:8px;">
               <span style="flex:1;">${fmtNomeBackup(nome)}</span>
               <button type="button" class="botao secundario pequeno" data-acao="baixar-backup" data-nome="${escapeHtml(nome)}">Baixar</button>
               <button type="button" class="botao secundario pequeno" data-acao="restaurar-backup" data-nome="${escapeHtml(nome)}">Restaurar</button>
             </li>`).join("") : '<li class="texto-suave">Nenhum backup ainda.</li>'}
         </ul>
         <form data-form="importar-backup" style="display:flex; gap:8px; align-items:center;">
           <input type="file" name="arquivo" accept=".zip" required style="flex:1;">
           <button type="submit" class="botao secundario">Importar e restaurar</button>
         </form>
         <p class="dica" style="margin-top:8px;">Restaurar (de qualquer uma das duas formas) substitui todos os dados atuais pelo estado salvo — um backup de segurança do momento atual é feito automaticamente antes, então dá pra desfazer se for engano.</p>
       </div>`}`,
      "configuracao"
    );
    if (config.status_conexao === "aguardando_qrcode") state._configSecoesAbertas = new Set([...(state._configSecoesAbertas || []), "Conexão"]);
    _aplicarAcordeaoCartoes(document.querySelector(".pagina"));

    if (config.status_conexao === "aguardando_qrcode") iniciarPollingStatusWhatsapp();
    else pararPollingStatusWhatsapp();
  }

  // Atualiza SÓ o cartão de status/QR Code no lugar, sem redesenhar a
  // página inteira — um re-render completo a cada 4s (o intervalo do
  // polling abaixo) jogava a rolagem de volta pro topo bem na hora de
  // escanear o QR Code, derrubando ele da tela repetidamente.
  // Quantos segundos um QR Code vale. O WhatsApp não anuncia o prazo; ~40s
  // é o que ele costuma dar, e é melhor avisar um pouco antes do que
  // deixar a pessoa apontando a câmera pra um código morto.
  const SEGUNDOS_VALIDADE_QR = 40;
  let _qrMostradoEm = 0;

  let _qrNaTela = null;

  function _contarValidadeQr() {
    const area = document.querySelector("[data-wpp-qr-area]");
    if (!area) { _qrNaTela = null; return; }
    // Código diferente do que estava aqui: começa a contar deste agora.
    const img = area.querySelector(".wpp-qrcode");
    const atual = img ? img.src.slice(-60) : null;
    if (atual && atual !== _qrNaTela) {
      _qrNaTela = atual;
      _qrMostradoEm = Date.now();
    }
    const restam = Math.max(0, SEGUNDOS_VALIDADE_QR - Math.round((Date.now() - _qrMostradoEm) / 1000));
    const validade = area.querySelector("[data-wpp-qr-validade]");
    const expirado = area.querySelector("[data-wpp-qr-expirado]");
    if (validade) {
      validade.textContent = restam ? `Este código vale por mais ${restam}s` : "";
      validade.classList.toggle("wpp-qrcode-acabando", restam > 0 && restam <= 12);
    }
    if (expirado) expirado.hidden = restam > 0;
  }

  setInterval(_contarValidadeQr, 1000);

  async function atualizarSecaoConexaoNoDom() {
    const container = document.querySelector("[data-wpp-secao-conexao]");
    if (!container) { pararPollingStatusWhatsapp(); return; }
    await chamarApi("/whatsapp/status"); // consulta de verdade a Evolution API e atualiza o banco
    const { config, webhookUrl } = await buscarConfigECriarWebhookUrl();

    // Enquanto espera a leitura, NÃO redesenha: trocar a imagem do QR
    // debaixo da câmera é exatamente o que fazia a leitura falhar. Só a
    // contagem regressiva se mexe.
    if (config.status_conexao === "aguardando_qrcode" && document.querySelector("[data-wpp-qr-area]")) {
      _contarValidadeQr();
      return;
    }

    container.innerHTML = htmlSecaoConexao(config, webhookUrl);
    if (config.status_conexao === "aguardando_qrcode") {
      _qrMostradoEm = Date.now();
      _contarValidadeQr();
    }
    if (config.status_conexao !== "aguardando_qrcode") {
      pararPollingStatusWhatsapp();
      if (config.status_conexao === "conectado") {
        fecharModais(); // some com o código de pareamento (se estava aberto) assim que conecta de verdade
        definirFlash("ok", "WhatsApp conectado!");
      }
      montarRota(); // agora sim, uma troca de tela de verdade (ex.: botão Conectar↔Desconectar)
    }
  }

  // =======================================================================
  // AGENDAMENTOS — visão global de mensagens programadas (admin pode ver
  // de todo mundo), sem precisar entrar em cada conversa.
  // =======================================================================
  async function renderAgendamentos() {
    _carregandoSeTrocouDeTela("agendamentos");
    const usuario = state.usuarioAtual;
    const verTodos = usuario.admin && state.agendamentosTodos;
    const agendadas = await chamarApi(`/whatsapp/agendadas${verTodos ? "?todos=1" : ""}`);

    const linhas = agendadas.map((a) => `
      <tr>
        <td>${fmtData(a.agendado_para)}</td>
        <td><a href="${_alvoDoItem(a).href}">${_alvoDoItem(a).rotulo}</a></td>
        <td>${escapeHtml(a.texto.length > 90 ? a.texto.slice(0, 90) + "…" : a.texto)}</td>
        ${verTodos ? `<td>${escapeHtml(a.criado_por_nome)}</td>` : ""}
        <td><button type="button" class="botao secundario pequeno" data-acao="cancelar-agendada-global" data-id="${a.id}">Cancelar</button></td>
      </tr>`).join("");

    renderShell(
      `<h2>Agendamentos</h2>
       <div class="cartao">
         ${usuario.admin ? `<div class="barra-acoes" style="margin-top:0; margin-bottom:14px;">
           <button type="button" class="wpp-aba ${!state.agendamentosTodos ? "ativa" : ""}" style="flex:none; padding:6px 14px;" data-acao="alternar-agendamentos-todos" data-todos="0">Meus</button>
           <button type="button" class="wpp-aba ${state.agendamentosTodos ? "ativa" : ""}" style="flex:none; padding:6px 14px;" data-acao="alternar-agendamentos-todos" data-todos="1">De todos</button>
         </div>` : ""}
         ${agendadas.length ? `<table>
           <thead><tr><th>Enviar em</th><th>Cliente</th><th>Mensagem</th>${verTodos ? "<th>Criado por</th>" : ""}<th></th></tr></thead>
           <tbody>${linhas}</tbody>
         </table>` : `<p class="texto-suave">Nenhuma mensagem agendada no momento.</p>`}
       </div>`,
      "agendamentos"
    );
  }

  // =======================================================================
  // LEMBRETES — meus pendentes (admin pode ver de todo mundo)
  // =======================================================================
  async function renderLembretes() {
    _carregandoSeTrocouDeTela("lembretes");
    const usuario = state.usuarioAtual;
    const verTodos = usuario.admin && state.lembretesTodos;
    const lembretes = await chamarApi(`/whatsapp/lembretes${verTodos ? "?todos=1" : ""}`);

    const agora = new Date();
    const linhas = lembretes.map((l) => {
      const vencido = new Date(l.lembrar_em.endsWith("Z") ? l.lembrar_em : l.lembrar_em + "Z") <= agora;
      return `<tr class="${vencido ? "linha-alerta" : ""}">
        <td>${fmtData(l.lembrar_em)}${vencido ? ' <span class="selo bloqueado">Vencido</span>' : ""}</td>
        <td><a href="${_alvoDoItem(l).href}">${_alvoDoItem(l).rotulo}</a></td>
        <td>${escapeHtml(l.texto || "—")}</td>
        ${verTodos ? `<td>${escapeHtml(l.usuario_nome)}</td>` : ""}
        <td><button type="button" class="botao secundario pequeno" data-acao="concluir-lembrete" data-id="${l.id}">Concluir</button></td>
      </tr>`;
    }).join("");

    renderShell(
      `<h2>Lembretes de retorno</h2>
       <div class="cartao">
         ${usuario.admin ? `<div class="barra-acoes" style="margin-top:0; margin-bottom:14px;">
           <button type="button" class="wpp-aba ${!state.lembretesTodos ? "ativa" : ""}" style="flex:none; padding:6px 14px;" data-acao="alternar-lembretes-todos" data-todos="0">Meus</button>
           <button type="button" class="wpp-aba ${state.lembretesTodos ? "ativa" : ""}" style="flex:none; padding:6px 14px;" data-acao="alternar-lembretes-todos" data-todos="1">De todos</button>
         </div>` : ""}
         ${lembretes.length ? `<table>
           <thead><tr><th>Quando</th><th>Cliente</th><th>Anotação</th>${verTodos ? "<th>Responsável</th>" : ""}<th></th></tr></thead>
           <tbody>${linhas}</tbody>
         </table>` : `<p class="texto-suave">Nenhum lembrete pendente.</p>
           <p class="dica">Lembretes são criados <strong>dentro da conversa</strong>: abra o cliente em <a href="#/whatsapp">WhatsApp</a> e clique no 🔔 no topo. Serve pra você não esquecer de algo — só você é avisado.</p>`}
       </div>`,
      "lembretes"
    );
  }

  // =======================================================================
  // DASHBOARD (admin) — controle total: números globais + desempenho
  // por usuário (tempo de resposta e de atendimento).
  // =======================================================================
  function fmtMinutos(v) {
    if (v === null || v === undefined) return "—";
    const total = Math.round(v); // inteiro ANTES de separar h/min — senão um resto tipo 59.9 virava "60min" em vez de completar a hora
    if (total < 60) return `${total}min`;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${h}h${m > 0 ? ` ${m}min` : ""}`;
  }

  function htmlEstrelas(nota) {
    if (nota === null || nota === undefined) return '<span class="texto-suave">sem avaliações</span>';
    return `<span class="dash-estrelas" title="${nota.toFixed(1)} de 5">${"★".repeat(Math.round(nota))}${"☆".repeat(5 - Math.round(nota))}</span>`;
  }

  // -----------------------------------------------------------------------
  // Mini-gráficos SVG (sem biblioteca externa) — usados no Dashboard.
  // -----------------------------------------------------------------------
  function _polarParaCartesiano(cx, cy, r, anguloGraus) {
    const rad = ((anguloGraus - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }
  function _fatiaDonut(cx, cy, rExt, rInt, inicio, fim) {
    const large = fim - inicio > 180 ? 1 : 0;
    const a = _polarParaCartesiano(cx, cy, rExt, fim), b = _polarParaCartesiano(cx, cy, rExt, inicio);
    const c = _polarParaCartesiano(cx, cy, rInt, inicio), d = _polarParaCartesiano(cx, cy, rInt, fim);
    return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${rExt} ${rExt} 0 ${large} 0 ${b.x.toFixed(2)} ${b.y.toFixed(2)} L ${c.x.toFixed(2)} ${c.y.toFixed(2)} A ${rInt} ${rInt} 0 ${large} 1 ${d.x.toFixed(2)} ${d.y.toFixed(2)} Z`;
  }
  function htmlDonut(dados, tamanho) {
    tamanho = tamanho || 168;
    const total = dados.reduce((s, d) => s + d.valor, 0);
    if (!total) return '<p class="texto-suave">Sem dados ainda.</p>';
    const cx = tamanho / 2, cy = tamanho / 2, rExt = tamanho / 2 - 4, rInt = rExt - 24;
    const positivos = dados.filter((d) => d.valor > 0);
    let acumulado = 0;
    const fatias = positivos.map((d) => {
      const fim = acumulado + (d.valor / total) * 360;
      const gap = positivos.length > 1 ? 1.5 : 0;
      const caminho = _fatiaDonut(cx, cy, rExt, rInt, acumulado, Math.max(fim - gap, acumulado));
      acumulado = fim;
      return `<path d="${caminho}" fill="${d.cor}"><title>${escapeHtml(d.label)}: ${d.valor}</title></path>`;
    }).join("");
    const legenda = positivos.map((d) => `
      <div class="wpp-graf-legenda-item"><span class="wpp-graf-legenda-bolinha" style="background:${d.cor};"></span>${escapeHtml(d.label)} <span class="texto-suave">(${d.valor})</span></div>`).join("");
    return `
      <div class="wpp-graf-donut-envolucro">
        <svg viewBox="0 0 ${tamanho} ${tamanho}" width="${tamanho}" height="${tamanho}">
          ${fatias}
          <text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="22" font-weight="800" fill="var(--texto)">${total}</text>
          <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="10" fill="var(--texto-suave)">total</text>
        </svg>
        <div class="wpp-graf-legenda">${legenda}</div>
      </div>`;
  }
  function htmlBarrasHorizontais(dados) {
    const max = Math.max(...dados.map((d) => d.valor), 1);
    return `<div class="wpp-graf-barras">${dados.map((d) => `
      <div class="wpp-graf-barra-linha">
        <span class="wpp-graf-barra-label">${escapeHtml(d.label)}</span>
        <div class="wpp-graf-barra-trilha"><div class="wpp-graf-barra-preenchida" style="width:${Math.max((d.valor / max) * 100, 3)}%; background:${d.cor || "var(--primaria)"};"></div></div>
        <span class="wpp-graf-barra-valor">${d.valor}</span>
      </div>`).join("")}</div>`;
  }
  const CORES_REGIAO = { "Norte": "#22c55e", "Nordeste": "#f59e0b", "Centro-Oeste": "#eab308", "Sudeste": "#7c5cff", "Sul": "#0a8f74", "Não identificado": "#6b7280" };

  function htmlMapaRegioes(mapa) {
    const porRegiao = {};
    mapa.regioes.forEach((r) => { porRegiao[r.regiao] = r; });
    const maxLeads = Math.max(...mapa.regioes.map((r) => r.leads), 1);
    const cartaoRegiao = (nome) => {
      const r = porRegiao[nome];
      if (!r || !r.leads) return `<div class="wpp-mapa-regiao wpp-mapa-regiao-vazia">${nome}<span class="texto-suave">sem leads ainda</span></div>`;
      const intensidade = Math.round(15 + (r.leads / maxLeads) * 65);
      return `<div class="wpp-mapa-regiao" style="background:color-mix(in srgb, ${CORES_REGIAO[nome] || "var(--primaria)"} ${intensidade}%, var(--superficie-2));">
        <strong>${nome}</strong>
        <span class="wpp-mapa-regiao-numero">${r.leads}</span><span class="texto-suave" style="font-size:10px;">leads</span>
        <span class="texto-suave" style="font-size:11px;">${r.atendimentos} atendimentos${r.taxa_conversao !== null ? ` · ${r.taxa_conversao}% conversão` : ""}</span>
      </div>`;
    };
    return `<div class="wpp-mapa-grid">
      <div style="grid-area:norte;">${cartaoRegiao("Norte")}</div>
      <div style="grid-area:nordeste;">${cartaoRegiao("Nordeste")}</div>
      <div style="grid-area:centro;">${cartaoRegiao("Centro-Oeste")}</div>
      <div style="grid-area:sudeste;">${cartaoRegiao("Sudeste")}</div>
      <div style="grid-area:sul;">${cartaoRegiao("Sul")}</div>
    </div>`;
  }

  async function renderDashboard() {
    _carregandoSeTrocouDeTela("dashboard");
    const [painel, mapa] = await Promise.all([
      chamarApi("/whatsapp/dashboard"),
      chamarApi("/whatsapp/dashboard/mapa"),
    ]);
    const t = painel.totais;

    const cartoes = [
      { rotulo: "Na fila", valor: t.fila, icone: "📥" },
      { rotulo: "Conversas abertas", valor: t.abertas, icone: "💬" },
      { rotulo: "Conversas fechadas", valor: t.fechadas, icone: "✅" },
      { rotulo: "Mensagens hoje", valor: t.mensagens_hoje, icone: "📨" },
      { rotulo: `Paradas +${t.limite_demora_min}min`, valor: t.paradas_agora, icone: "⏰" },
      { rotulo: "Avaliação média", valor: t.media_avaliacao_geral !== null ? `${t.media_avaliacao_geral.toFixed(1)} ★` : "—", icone: "⭐" },
    ].map((c) => `<div class="dash-cartao"><span class="dash-cartao-icone">${c.icone}</span><div><div class="dash-cartao-valor">${c.valor}</div><div class="dash-cartao-rotulo">${c.rotulo}</div></div></div>`).join("");

    const medalhas = ["🥇", "🥈", "🥉"];
    const ranking = painel.ranking_fechadas.length
      ? `<ol class="dash-ranking">${painel.ranking_fechadas.map((u, i) => `
          <li class="dash-ranking-item">
            <span class="dash-ranking-posicao">${medalhas[i] || `${i + 1}º`}</span>
            <div class="wpp-avatar" style="width:32px;height:32px;font-size:12px;background:${corAvatar(u.email)};">${escapeHtml(iniciaisContato(u.nome))}</div>
            <div class="dash-ranking-info">
              <div class="dash-ranking-nome">${escapeHtml(u.nome)}</div>
              <div class="texto-suave">${htmlEstrelas(u.media_avaliacao)} · atendimento médio ${fmtMinutos(u.tempo_medio_atendimento_min)}</div>
            </div>
            <div class="dash-ranking-numero">${u.conversas_fechadas}<span class="texto-suave"> fechadas</span></div>
          </li>`).join("")}</ol>`
      : `<p class="texto-suave">Nenhuma conversa fechada ainda.</p>`;

    const linhas = painel.usuarios.map((u) => `
      <tr>
        <td>
          <div style="display:flex; align-items:center; gap:8px;">
            <div class="wpp-avatar" style="width:28px;height:28px;font-size:11px;background:${corAvatar(u.email)};">${escapeHtml(iniciaisContato(u.nome))}</div>
            <div>${escapeHtml(u.nome)}${u.admin ? ' <span class="selo ativo">Admin</span>' : ""}${!u.ativo ? ' <span class="selo bloqueado">Inativo</span>' : ""}</div>
          </div>
        </td>
        <td>${u.conversas_atribuidas} <span class="texto-suave">(${u.conversas_abertas} abertas)</span></td>
        <td>${u.nao_lidas_pendentes > 0 ? `<span class="wpp-badge-nao-lidas">${u.nao_lidas_pendentes}</span>` : "—"}</td>
        <td>${u.mensagens_enviadas}</td>
        <td>${fmtMinutos(u.tempo_medio_primeira_resposta_min)}</td>
        <td>${fmtMinutos(u.tempo_medio_resposta_min)}</td>
        <td>${u.piores_atendimentos && u.piores_atendimentos.length
          ? `<button type="button" class="botao-link" data-acao="ver-piores-atendimentos" data-usuario='${escapeHtml(JSON.stringify(u.piores_atendimentos))}' data-nome="${escapeHtml(u.nome)}" style="text-decoration:underline; cursor:pointer; background:none; border:none; padding:0; color:inherit; font:inherit;" title="Ver quais atendimentos foram esses">${fmtMinutos(u.pior_atendimento_min)} 🔍</button>`
          : fmtMinutos(u.pior_atendimento_min)}</td>
        <td>${u.paradas_agora > 0 ? `<span class="selo bloqueado piscando">${u.paradas_agora}</span>` : "—"}</td>
        <td>${htmlEstrelas(u.media_avaliacao)}${u.total_avaliacoes ? ` <span class="texto-suave">(${u.total_avaliacoes})</span>` : ""}</td>
      </tr>`).join("");

    const comentarios = painel.avaliacoes_recentes.length
      ? painel.avaliacoes_recentes.map((a) => `
          <div class="dash-comentario">
            <div class="dash-comentario-cabecalho">
              ${htmlEstrelas(a.nota)}
              <span class="texto-suave">${escapeHtml(a.contato_nome || a.telefone)} → ${escapeHtml(a.usuario_nome || "—")} · ${fmtData(a.criado_em)}</span>
            </div>
            ${a.comentario ? `<p class="dash-comentario-texto">"${escapeHtml(a.comentario)}"</p>` : ""}
          </div>`).join("")
      : `<p class="texto-suave">Nenhum comentário de cliente ainda.</p>`;

    const donutRegioes = htmlDonut(mapa.regioes.map((r) => ({ label: r.regiao, valor: r.leads, cor: CORES_REGIAO[r.regiao] || "#6b7280" })));
    const barrasAtendimentos = mapa.regioes.length
      ? htmlBarrasHorizontais(mapa.regioes.map((r) => ({ label: r.regiao, valor: r.atendimentos, cor: CORES_REGIAO[r.regiao] })))
      : '<p class="texto-suave">Sem dados ainda.</p>';
    const linhasEstados = mapa.estados.length
      ? mapa.estados.map((e) => `
        <tr>
          <td>${escapeHtml(e.estado)} <span class="texto-suave">— ${escapeHtml(e.regiao)}</span></td>
          <td>${e.leads}</td>
          <td>${e.atendimentos}</td>
          <td>${e.vendas}</td>
          <td>${e.taxa_conversao !== null ? `${e.taxa_conversao}%` : "—"}</td>
        </tr>`).join("")
      : `<tr><td colspan="5" class="texto-suave">Nenhum contato ainda.</td></tr>`;

    renderShell(
      `<div class="wpp-cabecalho-tela">
         <h2 style="margin:0;">Dashboard</h2>
         <div style="display:flex; gap:8px;">
           <a class="botao secundario pequeno" href="${API}/whatsapp/dashboard/exportar" data-acao="exportar-dashboard">⬇ Exportar CSV</a>
           <button type="button" class="botao secundario pequeno" data-acao="resetar-dashboard">↺ Resetar contadores</button>
         </div>
       </div>
       ${t.dashboard_reset_em ? `<p class="dica" style="margin-top:-8px;">Contando desde ${fmtData(t.dashboard_reset_em)} — as conversas de antes continuam salvas, só não entram nesses números.</p>` : ""}
       <div class="dash-cartoes">${cartoes}</div>

       <div class="cartao">
         <h3 style="margin-top:0;">🗺️ De onde vêm os leads</h3>
         <p class="dica">Região identificada automaticamente pelo DDD do telefone de cada contato — nenhum cliente precisa informar nada.</p>
         ${htmlMapaRegioes(mapa)}
         <div class="dash-graficos-linha">
           <div>
             <h4 class="dash-subtitulo">Leads por região</h4>
             ${donutRegioes}
           </div>
           <div>
             <h4 class="dash-subtitulo">Atendimentos por região</h4>
             ${barrasAtendimentos}
           </div>
         </div>
         <table style="margin-top:14px;">
           <thead><tr><th>Estado</th><th>Leads</th><th>Atendimentos</th><th>Vendas</th><th>Conversão</th></tr></thead>
           <tbody>${linhasEstados}</tbody>
         </table>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">🏆 Ranking de negociações fechadas</h3>
         ${ranking}
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">Desempenho por usuário</h3>
         <p class="dica">Tempo de 1ª resposta: da chegada da conversa até a primeira resposta. Tempo de resposta: tempo até responder cada mensagem do cliente. Pior atendimento: a conversa fechada que demorou mais (não é média) -- pra você ver o pior caso de cada um. Os três usam a <strong>mediana</strong> (valor típico do dia a dia), não a média simples — assim uma conversa que ficou dias parada não distorce sozinha o número de todo mundo. Avaliação: nota que o próprio cliente deu ao final do atendimento.</p>
         <table>
           <thead><tr><th>Usuário</th><th>Conversas</th><th>Não lidas</th><th>Msgs enviadas</th><th>1ª resposta</th><th>Resposta média</th><th title="Atendimento mais demorado (pior caso, não é média)">Pior atendimento</th><th title="Conversas paradas agora, cliente esperando">Paradas agora</th><th>Avaliação</th></tr></thead>
           <tbody>${linhas}</tbody>
         </table>
       </div>

       <div class="cartao">
         <h3 style="margin-top:0;">💬 Comentários recentes dos clientes</h3>
         ${comentarios}
       </div>`,
      "dashboard"
    );
  }

  // =======================================================================
  // SEGURANÇA — cada usuário ativa/desativa a própria verificação em
  // duas etapas (2FA/TOTP)
  // =======================================================================
  async function renderSeguranca() {
    _carregandoSeTrocouDeTela("seguranca");
    const usuario = await chamarApi("/auth/me");
    state.usuarioAtual = usuario;

    renderShell(
      `<h2>Segurança</h2>
       <div class="cartao" style="max-width:520px;">
         <h3 style="margin-top:0;">Meu perfil</h3>
         <form data-form="editar-meu-perfil">
           <div class="campo"><label>Nome de exibição</label><input name="nome" value="${escapeHtml(usuario.nome)}" required></div>
           <button type="submit" class="botao">Salvar nome</button>
         </form>
       </div>

       <div class="cartao" style="max-width:520px;">
         <h3 style="margin-top:0;">Trocar senha</h3>
         <form data-form="trocar-senha" autocomplete="off">
           <div class="campo"><label>Senha atual</label>
             <div class="campo-senha">
               <input name="senha_atual" type="password" required autocomplete="off">
               <button type="button" class="botao-mostrar-senha" data-acao="alternar-mostrar-senha" title="Mostrar/ocultar" tabindex="-1">👁️</button>
             </div></div>
           <div class="campo"><label>Senha nova</label>
             <div class="campo-senha">
               <input name="senha_nova" type="password" required minlength="10" autocomplete="new-password">
               <button type="button" class="botao-mostrar-senha" data-acao="alternar-mostrar-senha" title="Mostrar/ocultar" tabindex="-1">👁️</button>
             </div></div>
           <button type="submit" class="botao">Trocar senha</button>
         </form>
       </div>

       <div class="cartao" style="max-width:520px;">
         <h3 style="margin-top:0;">Verificação em duas etapas (2FA)</h3>
         <p class="texto-suave">Além da senha, pede um código de 6 dígitos gerado por um app autenticador (Google Authenticator, Authy, etc.) a cada login.</p>
         ${usuario.totp_ativado ? `
           <p><span class="selo ativo">Ativada</span></p>
           <form data-form="desativar-2fa" style="max-width:320px;">
             <div class="campo"><label>Confirme sua senha pra desativar</label>
               <div class="campo-senha">
                 <input name="senha" type="password" required>
                 <button type="button" class="botao-mostrar-senha" data-acao="alternar-mostrar-senha" title="Mostrar/ocultar" tabindex="-1">👁️</button>
               </div></div>
             <button type="submit" class="botao perigo">Desativar 2FA</button>
           </form>` : `
           <p><span class="selo inativo">Desativada</span></p>
           <button class="botao" data-acao="iniciar-2fa">Ativar verificação em duas etapas</button>
           <div data-2fa-enrolamento></div>`}
       </div>`,
      "seguranca"
    );
  }

  function html2faEnrolamento(secreto, uri) {
    return `
      <div class="cartao" style="margin-top:14px; background:var(--superficie-2);">
        <p>1. Abra seu app autenticador e escolha "Inserir chave manualmente" (ou similar).</p>
        <div class="campo">
          <label>Chave de configuração</label>
          <div class="wpp-webhook-url"><input readonly value="${secreto}"><button type="button" class="botao secundario pequeno" data-acao="copiar-2fa-secreto" data-valor="${secreto}">Copiar</button></div>
        </div>
        <p class="texto-suave">Ou cole esta URI diretamente, se seu app aceitar: <code style="word-break:break-all;">${escapeHtml(uri)}</code></p>
        <p>2. Digite o código de 6 dígitos que apareceu no app pra confirmar:</p>
        <form data-form="confirmar-2fa">
          <div class="campo"><input name="codigo" inputmode="numeric" required autofocus placeholder="000000"></div>
          <button type="submit" class="botao">Confirmar e ativar</button>
        </form>
      </div>`;
  }

  function htmlCodigosRecuperacao(codigos) {
    return `
      <div class="cartao" style="margin-top:14px; border: 1px solid var(--amarelo);">
        <h3 style="margin-top:0;">⚠️ Guarde estes códigos de recuperação agora</h3>
        <p class="texto-suave">Cada um funciona uma única vez, caso você perca acesso ao app autenticador. Eles não serão mostrados de novo.</p>
        <div class="wpp-codigos-recuperacao">${codigos.map((c) => `<code>${c}</code>`).join("")}</div>
        <button class="botao" data-acao="fechar-codigos-2fa" style="margin-top:12px;">Já anotei, entendi</button>
      </div>`;
  }

  // =======================================================================
  // ATIVIDADES (admin) — rastro do que cada usuário fez
  // =======================================================================
  const ROTULO_ATIVIDADE = {
    login: "🔓 Login",
    logout: "🔒 Logout",
    conversa_iniciada: "💬 Iniciou conversa",
    mensagem_enviada: "📨 Enviou mensagem",
    mensagem_excluida: "🗑️ Excluiu mensagem",
    anexo_enviado: "📎 Enviou anexo",
    conversa_assumida: "🙋 Assumiu conversa",
    conversa_encaminhada: "↪️ Encaminhou conversa",
    conversa_fechada: "✅ Fechou conversa",
    conversa_reaberta: "🔁 Reabriu conversa",
    conversa_arquivada: "🗄️ Arquivou conversa",
    conversa_desarquivada: "📤 Desarquivou conversa",
    conversa_excluida: "🗑️ Excluiu conversa",
    lembrete_criado: "🔔 Criou lembrete",
    lembrete_concluido: "✔️ Concluiu lembrete",
    mensagem_agendada: "🕒 Agendou mensagem",
    agendamento_cancelado: "✕ Cancelou agendamento",
  };

  async function renderAtividades() {
    _carregandoSeTrocouDeTela("atividades");
    const [usuarios, atividades] = await Promise.all([
      chamarApi("/usuarios"),
      chamarApi(`/whatsapp/atividades${state.filtroAtividadesUsuarioId ? `?usuario_id=${state.filtroAtividadesUsuarioId}` : ""}`),
    ]);

    const linhas = atividades.length
      ? atividades.map((a) => `
        <tr>
          <td class="texto-suave" style="white-space:nowrap;">${fmtData(a.criado_em)}</td>
          <td>${escapeHtml(a.usuario_nome || "—")}</td>
          <td>${ROTULO_ATIVIDADE[a.tipo] || escapeHtml(a.tipo)}</td>
          <td class="texto-suave">${escapeHtml(a.descricao || "")}</td>
          <td>${a.conversa_id ? `<a href="#/whatsapp/${a.conversa_id}">ver conversa →</a>` : ""}</td>
        </tr>`).join("")
      : `<tr><td colspan="5" class="texto-suave">Nenhuma atividade registrada ainda.</td></tr>`;

    renderShell(
      `<h2>Atividades</h2>
       <div class="cartao">
         <div class="campo" style="max-width:280px;">
           <label>Filtrar por usuário</label>
           <select data-acao-change="filtrar-atividades">
             <option value="">Todos os usuários</option>
             ${usuarios.map((u) => `<option value="${u.id}" ${String(u.id) === String(state.filtroAtividadesUsuarioId) ? "selected" : ""}>${escapeHtml(u.nome)}</option>`).join("")}
           </select>
         </div>
         <table>
           <thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Detalhe</th><th></th></tr></thead>
           <tbody>${linhas}</tbody>
         </table>
       </div>`,
      "atividades"
    );
  }

  // =======================================================================
  // USUÁRIOS (admin) — quem pode fazer login
  // =======================================================================
  // Baixa um arquivo que exige o token do app (Bearer) -- um <a href>
  // comum não manda esse cabeçalho, então busca via fetch, vira Blob e
  // dispara o download por trás de um <a download> temporário. Pedido
  // do Clayton (2026-09-03): exportar a planilha de Ligações em Excel
  // ou PDF.
  async function _baixarArquivoAutenticado(caminho, nomeArquivo) {
    const resp = await fetch(API + caminho, { headers: { Authorization: "Bearer " + state.accessToken } });
    if (!resp.ok) throw new Error("Não consegui gerar o arquivo agora.");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nomeArquivo;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const COLUNAS_LIGACOES = [
    ["data_ligacao", "Data", "date", 130],
    ["empresa_contatada", "Empresa", "text", 180],
    ["contato_nome", "Com quem falei", "text", 160],
    ["telefone", "Telefone", "text", 140],
    ["email", "E-mail", "email", 190],
    ["data_envio_email", "Data envio e-mail", "date", 140],
    ["terceiriza_para", "Terceirizam com", "text", 180],
    ["responsavel_area", "Responsável (suplementos/novos produtos/fabricantes)", "text", 260],
    ["proximo_contato_em", "Próximo contato", "date", 150],
    ["aceitacao", "Aceitação", "select-aceitacao", 130],
    ["negociacao_fechada", "Negociação fechada", "checkbox", 70],
    ["observacoes", "Observações", "text", 260],
  ];

  const ROTULO_ACEITACAO = { quente: "🔥 Quente", morno: "🟡 Morno", frio: "❄️ Frio" };

  async function renderLigacoes() {
    _carregandoSeTrocouDeTela("ligacoes");
    const souAdmin = !!state.usuarioAtual.admin;
    if (!state._ligacoesFiltro) state._ligacoesFiltro = { aceitacao: "", soFechadas: false, ordenar: false, usuarioId: "" };
    const filtro = state._ligacoesFiltro;

    let linhas, usuarios = [];
    try {
      const [linhasResp, usuariosResp] = await Promise.all([
        chamarApi(`/ligacoes${souAdmin && filtro.usuarioId ? `?usuario_id=${filtro.usuarioId}` : ""}`),
        souAdmin ? chamarApi("/usuarios").catch(() => []) : Promise.resolve([]),
      ]);
      linhas = linhasResp;
      usuarios = usuariosResp;
    } catch (e) {
      linhas = [];
    }

    // Filtro/ordenação por aceitação -- pedido do Clayton: "depois eu
    // posso fazer uma consulta por filtro e elencar por ordem de
    // aceitação e possível negociações fechadas". Fica na memória da
    // tela (não salva no servidor) pra não sumir ao reabrir sem querer.
    const ORDEM_ACEITACAO = { quente: 0, morno: 1, frio: 2, "": 3 };

    let linhasFiltradas = linhas.filter((l) => {
      if (filtro.aceitacao === "vazio" && l.aceitacao) return false;
      if (filtro.aceitacao && filtro.aceitacao !== "vazio" && l.aceitacao !== filtro.aceitacao) return false;
      if (filtro.soFechadas && !l.negociacao_fechada) return false;
      return true;
    });
    if (filtro.ordenar) {
      linhasFiltradas = [...linhasFiltradas].sort((a, b) =>
        (ORDEM_ACEITACAO[a.aceitacao || ""] ?? 3) - (ORDEM_ACEITACAO[b.aceitacao || ""] ?? 3));
    }

    const hoje = new Date().toISOString().slice(0, 10);
    const htmlCampo = (l, campo, tipo) => {
      if (tipo === "select-aceitacao") {
        return `<select data-campo-ligacao="${campo}" style="min-width:120px;">
          <option value="">— em branco —</option>
          ${["quente", "morno", "frio"].map((v) => `<option value="${v}" ${l.aceitacao === v ? "selected" : ""}>${ROTULO_ACEITACAO[v]}</option>`).join("")}
        </select>`;
      }
      if (tipo === "checkbox") {
        return `<input type="checkbox" data-campo-ligacao="${campo}" ${l[campo] ? "checked" : ""} style="width:18px; height:18px;">`;
      }
      return `<input type="${tipo}" data-campo-ligacao="${campo}" value="${escapeHtml(l[campo] || "")}" style="min-width:${tipo === "date" ? "130" : "150"}px;">`;
    };
    const htmlLinha = (l) => {
      const vencida = l.proximo_contato_em && l.proximo_contato_em <= hoje;
      return `
      <tr data-linha-ligacao="${l.id}" class="${vencida ? "wpp-linha-ligacao-vencida" : ""}">
        ${souAdmin ? `<td class="texto-suave">${escapeHtml(l.criado_por_nome || "—")}</td>` : ""}
        ${COLUNAS_LIGACOES.map(([campo, , tipo]) => `
          <td>
            ${htmlCampo(l, campo, tipo)}
            ${campo === "proximo_contato_em" && vencida ? `<button type="button" class="botao secundario pequeno" data-acao="prorrogar-ligacao" data-id="${l.id}" style="margin-top:4px; white-space:nowrap;" title="Adia o próximo contato">🔁 Prorrogar${l.vezes_prorrogado ? ` (${l.vezes_prorrogado}x)` : ""}</button>` : ""}
          </td>
        `).join("")}
        <td><button type="button" class="botao-icone" data-acao="excluir-ligacao" data-id="${l.id}" title="Excluir esta linha">🗑️</button></td>
      </tr>`;
    };

    renderShell(
      `<h2>📞 Leads do Consulta Anvisa</h2>
       <div class="cartao">
         <p class="dica">Controle das suas ligações de prospecção — dia, empresa, com quem falou, pra quem terceirizam, e quem é o responsável pela área de suplementos/novos produtos/contratação de fabricantes. Clique numa célula pra editar; salva sozinho ao sair do campo. Marque "Próximo contato" pra o Assistente Seja Alpha te lembrar no chat interno quando chegar o dia (ative em Configuração). "Aceitação" mede o quanto o cliente demonstrou interesse ao conversar ou responder o e-mail.</p>
         <div class="barra-acoes" style="margin-bottom:12px;">
           <button type="button" class="botao" data-acao="nova-ligacao">+ Nova linha</button>
           <button type="button" class="botao secundario" data-acao="exportar-ligacoes-xlsx">⬇ Exportar Excel</button>
           <button type="button" class="botao secundario" data-acao="exportar-ligacoes-pdf">⬇ Exportar PDF</button>
         </div>
         <div class="barra-acoes" style="margin-bottom:12px; align-items:center;">
           ${souAdmin ? `
           <label class="texto-suave" style="display:flex; align-items:center; gap:6px;">Colaborador:
             <select data-acao-change="filtrar-ligacoes-usuario">
               <option value="" ${!filtro.usuarioId ? "selected" : ""}>Todos</option>
               ${usuarios.filter((u) => u.ativo).map((u) => `<option value="${u.id}" ${String(filtro.usuarioId) === String(u.id) ? "selected" : ""}>${escapeHtml(u.nome)}</option>`).join("")}
             </select>
           </label>` : ""}
           <label class="texto-suave" style="display:flex; align-items:center; gap:6px;">Filtrar aceitação:
             <select data-acao-change="filtrar-ligacoes-aceitacao">
               <option value="" ${!filtro.aceitacao ? "selected" : ""}>Todas</option>
               <option value="quente" ${filtro.aceitacao === "quente" ? "selected" : ""}>🔥 Quente</option>
               <option value="morno" ${filtro.aceitacao === "morno" ? "selected" : ""}>🟡 Morno</option>
               <option value="frio" ${filtro.aceitacao === "frio" ? "selected" : ""}>❄️ Frio</option>
               <option value="vazio" ${filtro.aceitacao === "vazio" ? "selected" : ""}>— em branco —</option>
             </select>
           </label>
           <label class="texto-suave" style="display:flex; align-items:center; gap:6px;">
             <input type="checkbox" data-acao-change="filtrar-ligacoes-fechadas" ${filtro.soFechadas ? "checked" : ""}> Só negociações fechadas
           </label>
           <button type="button" class="botao secundario pequeno" data-acao="ordenar-ligacoes-aceitacao">${filtro.ordenar ? "✓ " : ""}Ordenar por aceitação</button>
           <span class="texto-suave">${linhasFiltradas.length} de ${linhas.length}</span>
         </div>
         <div style="overflow-x:auto;">
           <table class="wpp-tabela-ligacoes">
             <thead><tr>${souAdmin ? "<th>Colaborador</th>" : ""}${COLUNAS_LIGACOES.map(([, rotulo]) => `<th>${escapeHtml(rotulo)}</th>`).join("")}<th></th></tr></thead>
             <tbody>${linhasFiltradas.length ? linhasFiltradas.map(htmlLinha).join("") : `<tr><td colspan="${COLUNAS_LIGACOES.length + 1 + (souAdmin ? 1 : 0)}" class="texto-suave">${linhas.length ? "Nenhuma linha bate com o filtro." : `Nenhuma ligação registrada ainda — clique em "+ Nova linha" pra começar.`}</td></tr>`}</tbody>
           </table>
         </div>
       </div>`,
      "ligacoes"
    );

    // Salva ao sair do campo (blur pros de texto/data, change pros de
    // seleção/checkbox) -- não a cada tecla, senão vira uma chamada por
    // letra digitada.
    document.querySelectorAll("[data-campo-ligacao]").forEach((campo) => {
      const evento = (campo.tagName === "SELECT" || campo.type === "checkbox") ? "change" : "blur";
      campo.addEventListener(evento, async () => {
        const tr = campo.closest("[data-linha-ligacao]");
        const id = Number(tr.dataset.linhaLigacao);
        const nomeCampo = campo.dataset.campoLigacao;
        const valor = campo.type === "checkbox" ? campo.checked : campo.value;
        try {
          await chamarApi(`/ligacoes/${id}`, { method: "PUT", body: { [nomeCampo]: valor } });
        } catch (e) {
          definirFlash("erro", "Não consegui salvar — tenta de novo.");
        }
      });
    });
  }

  // ============================================================
  // Catálogo / montador de proposta -- Fase 1 (só cadastro do admin).
  // Pedido do Clayton (2026-09-04): pegar o portifólio de terceirização
  // e no futuro deixar o cliente escolher item + quantidade já vendo o
  // preço. Por enquanto é só aqui que os itens/faixas são cadastrados;
  // a tela do cliente (fase 2) só liga de verdade com o toggle em
  // Configuração, que fica desligado até o Clayton terminar de testar.
  function fmtMoeda(v) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
    return Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function _resumoFaixas(item) {
    if (!item.faixas || !item.faixas.length) return "sem faixas";
    const precos = item.faixas.map((f) => f.preco);
    const min = Math.min(...precos), max = Math.max(...precos);
    return min === max ? fmtMoeda(min) : `${fmtMoeda(min)} – ${fmtMoeda(max)}`;
  }

  async function renderCatalogo() {
    _carregandoSeTrocouDeTela("catalogo");
    const itens = await chamarApi("/whatsapp/catalogo?todos=1");
    renderShell(`
      <div class="wpp-cabecalho-tela">
        <h2 style="margin:0;">🗂️ Catálogo / Proposta</h2>
        <button type="button" class="botao pequeno" data-acao="abrir-catalogo-item">+ Novo item</button>
      </div>
      <p class="dica">Cadastro dos itens e faixas de preço do portfólio de terceirização. A tela do cliente ainda não existe — isso aqui é só a base pra montar ela depois. Liberar/travar pro cliente é em <strong>Configuração → Catálogo/Proposta</strong>.</p>
      <div class="cartao">
        ${itens.length ? `
        <table class="tabela-simples">
          <thead><tr><th></th><th>Nome</th><th>Forma / Linha</th><th>Faixa de preço</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${itens.map((it) => `
              <tr>
                <td>${it.imagem_url ? `<img src="${urlImagemSegura(it.imagem_url)}" alt="" style="width:40px; height:40px; object-fit:cover; border-radius:8px;">` : `<div style="width:40px; height:40px; border-radius:8px; background:var(--superficie-2); display:flex; align-items:center; justify-content:center; font-size:16px;">📦</div>`}</td>
                <td>${escapeHtml(it.nome)}</td>
                <td class="texto-suave">${escapeHtml([it.forma, it.linha].filter(Boolean).join(" · ") || "—")}</td>
                <td>${escapeHtml(_resumoFaixas(it))}<div class="texto-suave" style="font-size:11px;">${it.faixas.length} faixa(s)</div></td>
                <td>${it.ativo ? '<span class="selo ativo">Ativo</span>' : '<span class="selo inativo">Inativo</span>'}</td>
                <td style="white-space:nowrap;">
                  <button type="button" class="botao-icone" data-acao="abrir-catalogo-item" data-id="${it.id}" title="Editar">✏️</button>
                  ${it.ativo ? `<button type="button" class="botao-icone" data-acao="excluir-catalogo-item" data-id="${it.id}" data-nome="${escapeHtml(it.nome)}" title="Desativar">🗑️</button>` : ""}
                </td>
              </tr>`).join("")}
          </tbody>
        </table>` : `<p class="dica">Nenhum item cadastrado ainda. Clique em "+ Novo item" pra começar.</p>`}
      </div>`,
      "catalogo"
    );
  }

  async function _obterLinhasSugeridas() {
    if (!state._linhasCatalogoCache) {
      try { state._linhasCatalogoCache = await chamarApi("/whatsapp/catalogo/linhas-sugeridas"); }
      catch (e) { state._linhasCatalogoCache = []; }
    }
    return state._linhasCatalogoCache;
  }

  function _htmlLinhaNutriente(n) {
    const id = n ? n.id : `novo-${Math.random().toString(36).slice(2, 8)}`;
    return `
      <div class="wpp-faixa-linha" data-nutriente-linha data-id="${id}" style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
        <input type="text" placeholder="Nome (ex.: Creatina (mg))" value="${escapeHtml(n ? n.nome : "")}" data-nutriente-nome style="flex:1;">
        <input type="text" placeholder="Quantidade" value="${escapeHtml(n && n.quantidade || "")}" data-nutriente-qtd style="width:110px;">
        <input type="text" placeholder="%VD" value="${escapeHtml(n && n.vd || "")}" data-nutriente-vd style="width:80px;">
        <button type="button" class="botao-icone" data-acao="remover-linha-nutriente" title="Remover esta linha">✕</button>
      </div>`;
  }

  function _htmlLinhaFaixa(f) {
    const id = f ? f.id : `novo-${Math.random().toString(36).slice(2, 8)}`;
    return `
      <div class="wpp-faixa-linha" data-faixa-linha data-id="${id}" style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
        <input type="number" min="1" placeholder="De" value="${f ? f.quantidade_min : ""}" data-faixa-min style="width:90px;">
        <span class="texto-suave">até</span>
        <input type="number" min="1" placeholder="(vazio = sem teto)" value="${f && f.quantidade_max != null ? f.quantidade_max : ""}" data-faixa-max style="width:150px;">
        <span class="texto-suave">un. →</span>
        <input type="number" min="0" step="0.01" placeholder="R$" value="${f ? f.preco : ""}" data-faixa-preco style="width:110px;">
        <button type="button" class="botao-icone" data-acao="remover-linha-faixa" title="Remover esta faixa">✕</button>
      </div>`;
  }

  async function modalCatalogoItem(itemId) {
    const [item, linhasSugeridas] = await Promise.all([
      itemId ? chamarApi(`/whatsapp/catalogo/${itemId}`) : null,
      _obterLinhasSugeridas(),
    ]);
    const wrap = abrirModal(`
      <h3 style="margin-top:0;">🗂️ ${item ? "Editar item" : "Novo item"} do catálogo</h3>
      <form data-form="salvar-catalogo-item" data-id="${item ? item.id : ""}">
        <div class="campo"><label>Nome do produto</label><input type="text" name="nome" required value="${escapeHtml(item ? item.nome : "")}"></div>
        <div style="display:flex; gap:10px;">
          <div class="campo" style="flex:1;"><label>Forma</label><input type="text" name="forma" placeholder="Sachê, Stick, Pó, Cápsula…" value="${escapeHtml(item && item.forma || "")}"></div>
          <div class="campo" style="flex:1;">
            <label>Linha</label>
            <input type="text" name="linha" list="lista-linhas-catalogo" placeholder="Escolha ou digite…" value="${escapeHtml(item && item.linha || "")}">
            <datalist id="lista-linhas-catalogo">${linhasSugeridas.map((l) => `<option value="${escapeHtml(l)}">`).join("")}</datalist>
          </div>
          <div class="campo" style="flex:1;"><label>Sabor <span class="texto-suave">(se tiver)</span></label><input type="text" name="sabor" placeholder="Morango, Limão…" value="${escapeHtml(item && item.sabor || "")}"></div>
        </div>
        <div class="campo">
          <label>Imagem</label>
          <div style="display:flex; align-items:center; gap:10px;">
            <img data-preview-imagem src="${item && item.imagem_url ? urlImagemSegura(item.imagem_url) : ""}" style="width:56px; height:56px; object-fit:cover; border-radius:8px; background:var(--superficie-2); ${item && item.imagem_url ? "" : "display:none;"}">
            <input type="file" name="imagem" accept="image/*" data-input-imagem>
          </div>
          <input type="hidden" name="imagem_url" value="${escapeHtml(item && item.imagem_url || "")}">
        </div>
        <label class="rotulo-forte">Faixas de quantidade → preço</label>
        <p class="dica" style="margin-top:0;">Ex.: 1 a 300 un. = R$ 32,50 · 301 a 500 = R$ 29,90…</p>
        <div data-lista-faixas>${(item && item.faixas.length ? item.faixas : [null, null]).map((f) => _htmlLinhaFaixa(f)).join("")}</div>
        <button type="button" class="botao secundario pequeno" data-acao="adicionar-linha-faixa" style="margin-bottom:14px;">+ faixa</button>

        <label class="rotulo-forte">Informação nutricional</label>
        <p class="dica" style="margin-top:0;">Copiado do modelo de portifólio: porção + tabela de nutrientes.</p>
        <div class="campo" style="max-width:260px;"><label>Porção</label><input type="text" name="porcao" placeholder="Ex.: 3g (1 dosador)" value="${escapeHtml(item && item.porcao || "")}"></div>
        <div data-lista-nutrientes>${(item && item.nutrientes.length ? item.nutrientes : [null]).map((n) => _htmlLinhaNutriente(n)).join("")}</div>
        <button type="button" class="botao secundario pequeno" data-acao="adicionar-linha-nutriente" style="margin-bottom:14px;">+ nutriente</button>
        <div class="campo"><label>Observação nutricional <span class="texto-suave">(ex.: "*Valores diários com base em 2.000kcal")</span></label><textarea name="observacao_nutricional" rows="2">${escapeHtml(item && item.observacao_nutricional || "")}</textarea></div>
        <div class="campo"><label>Ingredientes</label><textarea name="ingredientes" rows="2">${escapeHtml(item && item.ingredientes || "")}</textarea></div>
        <div class="campo"><label>Modo de uso</label><textarea name="modo_de_uso" rows="2">${escapeHtml(item && item.modo_de_uso || "")}</textarea></div>

        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Salvar</button>
        </div>
      </form>`, "modal-largo");

    wrap.querySelector("[data-input-imagem]").addEventListener("change", async (ev) => {
      const arquivo = ev.target.files[0];
      if (!arquivo) return;
      const forma = new FormData();
      forma.append("arquivo", arquivo, arquivo.name || "imagem");
      const resp = await fetch(`${API}/whatsapp/upload-avulso`, {
        method: "POST", headers: { Authorization: "Bearer " + state.accessToken }, body: forma,
      });
      if (!resp.ok) { definirFlash("erro", "Não deu pra enviar a imagem."); return; }
      const { url } = await resp.json();
      wrap.querySelector('input[name="imagem_url"]').value = url;
      const preview = wrap.querySelector("[data-preview-imagem]");
      preview.src = urlImagemSegura(url);
      preview.style.display = "";
    });
  }

  async function renderUsuarios() {
    _carregandoSeTrocouDeTela("usuarios");
    const [usuarios, setores] = await Promise.all([chamarApi("/usuarios"), chamarApi("/usuarios/setores")]);
    const linhas = usuarios.map((u) => `
      <tr>
        <td style="position:relative;"><button type="button" class="wpp-avatar-botao" data-acao="abrir-seletor-foto-usuario" data-id="${u.id}" title="Trocar a foto de ${escapeHtml(u.nome)}">${htmlAvatar(u, 28)}</button><span class="wpp-online-bolinha ${u.online ? "wpp-online-sim" : "wpp-online-nao"}" title="${u.online ? "Online agora" : "Offline"}"></span></td>
        <td>${escapeHtml(u.nome)}</td>
        <td class="texto-suave">${escapeHtml(u.email)}</td>
        <td class="texto-suave">${(u.setores && u.setores.length) ? u.setores.map((s) => escapeHtml(s)).join(", ") : escapeHtml(u.setor || "—")}${u.acesso_conversas === false ? ' <span class="selo inativo" title="Não vê as conversas de clientes">só chat interno</span>' : ""}
          ${u.ativo ? `<div style="margin-top:4px;">
            ${(() => {
              // Um rotulo so, juntando os dois sinais que importam pra
              // saber se essa pessoa pode atender agora: se marcou
              // ausencia (decisao dela) e se esta com o sistema aberto
              // (online). Antes o botao so olhava a ausencia manual e
              // mostrava "Disponivel" ate pra quem estava offline havia
              // horas — o oposto do que a palavra diz.
              if (u.ausente) {
                return `<button type="button" class="botao secundario pequeno botao-ausente-ligado"
                          data-acao="ausencia-de-usuario" data-id="${u.id}" data-nome="${escapeHtml(u.nome)}" data-ausente="1"
                          title="Está marcado como ausente — clique pra voltar a ficar disponível">
                          🟡 Ausente${u.ausente_motivo ? " — " + escapeHtml(u.ausente_motivo) : ""} · liberar
                        </button>`;
              }
              if (!u.online) {
                return `<button type="button" class="botao secundario pequeno botao-indisponivel"
                          data-acao="ausencia-de-usuario" data-id="${u.id}" data-nome="${escapeHtml(u.nome)}" data-ausente="0"
                          title="O sistema não está aberto no aparelho dela agora. Clique pra marcar ausência manualmente também, se for o caso.">
                          🔴 Indisponível <span class="texto-suave">(offline)</span>
                        </button>`;
              }
              return `<button type="button" class="botao secundario pequeno"
                        data-acao="ausencia-de-usuario" data-id="${u.id}" data-nome="${escapeHtml(u.nome)}" data-ausente="0"
                        title="Online e disponível — clique pra marcar ausência">
                        🟢 Disponível
                      </button>`;
            })()}
          </div>` : ""}</td>
        <td>${u.admin ? '<span class="selo ativo">Admin</span>' : '<span class="selo inativo">Padrão</span>'}${u.super_admin ? ' <span class="selo ativo" style="background:color-mix(in srgb, var(--acento) 18%, transparent); color:var(--acento);" title="Vê e acompanha todas as conversas de todo mundo">Master</span>' : ""}</td>
        <td>${u.ativo ? '<span class="selo ativo">Ativo</span>' : '<span class="selo bloqueado">Inativo</span>'}</td>
        <td class="texto-suave">${u.admin ? "sem restrição" : (u.horario_permitido && u.horario_permitido.length ? u.horario_permitido.map((j) => `${j.inicio}–${j.fim}`).join(", ") : "sem restrição")}</td>
        <td style="display:flex; gap:6px; flex-wrap:wrap;">
          <button class="botao secundario pequeno" data-acao="abrir-editar-usuario" data-usuario='${escapeHtml(JSON.stringify(u))}'>Editar</button>
          ${!u.admin ? `<button class="botao secundario pequeno" data-acao="abrir-horario-usuario" data-id="${u.id}" data-nome="${escapeHtml(u.nome)}" data-horario='${escapeHtml(JSON.stringify(u.horario_permitido || []))}'>Horário</button>` : ""}
          ${u.id === state.usuarioAtual.id ? "" : u.ativo
            ? `<button class="botao secundario pequeno" data-acao="inativar-usuario" data-id="${u.id}">Inativar</button>`
            : `<button class="botao secundario pequeno" data-acao="reativar-usuario" data-id="${u.id}">Reativar</button>`}
        </td>
      </tr>`).join("");

    renderShell(
      `<h2>Usuários</h2>
       <div class="cartao">
         <div class="barra-acoes" style="margin-top:0; margin-bottom:14px;">
           <button class="botao" data-acao="novo-usuario">+ Novo usuário</button>
           <input type="file" data-wpp-foto-usuario data-acao-change="enviar-foto-usuario" accept="image/*" hidden>
         </div>
         <table>
           <thead><tr><th></th><th>Nome</th><th>Email</th><th>Setor</th><th>Perfil</th><th>Status</th><th>Horário permitido</th><th></th></tr></thead>
           <tbody>${linhas}</tbody>
         </table>
       </div>`,
      "usuarios"
    );
    state._setoresCache = setores;
  }

  function modalNovoUsuario() {
    const setores = state._setoresCache || [];
    abrirModal(`
      <h3 style="margin-top:0;">Novo usuário</h3>
      <form data-form="criar-usuario" autocomplete="off">
        <div class="campo"><label>Nome</label><input name="nome" required autofocus autocomplete="off"></div>
        <div class="campo"><label>Email do novo usuário</label><input name="email" type="email" required autocomplete="off" placeholder="email@do-usuario.com"></div>
        <div class="campo"><label>Senha inicial (o usuário pode trocar depois em Segurança)</label>
          <div class="campo-senha">
            <input name="senha" type="password" required minlength="10" autocomplete="new-password" placeholder="Defina uma senha para ele">
            <button type="button" class="botao-mostrar-senha" data-acao="alternar-mostrar-senha" title="Mostrar/ocultar" tabindex="-1">👁️</button>
          </div></div>
        <div class="campo campo-checkbox"><label><input type="checkbox" name="admin" data-acao-change="alternar-campo-setor"> Administrador (pode configurar a conexão e gerenciar usuários)</label></div>
        ${state.usuarioAtual.super_admin ? `
        <div class="campo campo-checkbox"><label><input type="checkbox" name="super_admin"> Admin <strong>Master</strong> (além de administrador, também vê e acompanha TODAS as conversas — WhatsApp e chat interno — de todo mundo)</label></div>` : ""}
        ${htmlEscolhaAcesso(true)}
        <div class="campo" data-campo-setor>
          ${htmlEscolhaSetores(setores, [])}
        </div>
        <div class="campo">
          <label>Horário de login permitido (opcional — em branco = sem restrição)</label>
          <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
            <input type="time" name="janela1_inicio"> <span class="texto-suave">até</span> <input type="time" name="janela1_fim">
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="time" name="janela2_inicio"> <span class="texto-suave">até</span> <input type="time" name="janela2_fim">
          </div>
        </div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Criar usuário</button>
        </div>
      </form>`);
  }

  function modalEditarUsuario(u) {
    const setores = state._setoresCache || [];
    const souEu = u.id === state.usuarioAtual.id;
    abrirModal(`
      <h3 style="margin-top:0;">Editar usuário</h3>
      <form data-form="editar-usuario" data-id="${u.id}">
        <div class="campo"><label>Nome</label><input name="nome" required value="${escapeHtml(u.nome)}"></div>
        <div class="campo"><label>Email</label><input name="email" type="email" required value="${escapeHtml(u.email)}"></div>
        <div class="campo campo-checkbox"><label><input type="checkbox" name="admin" data-acao-change="alternar-campo-setor" ${u.admin ? "checked" : ""} ${souEu ? "disabled" : ""}> Administrador (pode configurar a conexão e gerenciar usuários)</label></div>
        ${souEu ? `<input type="hidden" name="admin" value="${u.admin ? "1" : ""}">` : ""}
        ${state.usuarioAtual.super_admin ? `
        <div class="campo campo-checkbox"><label><input type="checkbox" name="super_admin" ${u.super_admin ? "checked" : ""} ${souEu ? "disabled" : ""}> Admin <strong>Master</strong> (além de administrador, também vê e acompanha TODAS as conversas — WhatsApp e chat interno — de todo mundo)</label></div>
        ${souEu ? `<input type="hidden" name="super_admin" value="${u.super_admin ? "1" : ""}">` : ""}` : ""}
        ${htmlEscolhaAcesso(u.acesso_conversas !== false, u.admin)}
        <div class="campo" data-campo-setor style="${u.admin ? "display:none;" : ""}">
          ${htmlEscolhaSetores(setores, u.setores || (u.setor ? [u.setor] : []))}
        </div>
        <div class="campo campo-checkbox"><label><input type="checkbox" name="offline_forcado" ${u.offline_forcado ? "checked" : ""}> Marcar como offline manualmente (afastado/férias — some das listas de "online" e do menu automático mesmo se ele estiver logado)</label></div>
        <div class="campo">
          <label>Redefinir senha (opcional — deixe em branco pra não mexer)</label>
          <div class="campo-senha">
            <input name="senha_nova" type="password" minlength="10" autocomplete="new-password" placeholder="Só preencha se ele esqueceu a senha">
            <button type="button" class="botao-mostrar-senha" data-acao="alternar-mostrar-senha" title="Mostrar/ocultar" tabindex="-1">👁️</button>
          </div>
          <p class="dica" style="margin-top:4px;">Se preencher, não precisa da senha atual dele — e ele é deslogado de todos os aparelhos e precisa entrar de novo com essa senha (pode trocar por uma da escolha dele depois, em Segurança).</p>
        </div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Salvar</button>
        </div>
      </form>`);
  }

  function modalHorarioUsuario(id, nome, horarioAtual) {
    const j1 = horarioAtual[0] || {}, j2 = horarioAtual[1] || {};
    abrirModal(`
      <h3 style="margin-top:0;">Horário de login — ${escapeHtml(nome)}</h3>
      <p class="texto-suave">Fora dessas janelas, o login é bloqueado. Deixe tudo em branco pra liberar qualquer horário.</p>
      <form data-form="definir-horario-usuario" data-id="${id}">
        <div class="campo">
          <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
            <input type="time" name="janela1_inicio" value="${j1.inicio || ""}"> <span class="texto-suave">até</span> <input type="time" name="janela1_fim" value="${j1.fim || ""}">
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="time" name="janela2_inicio" value="${j2.inicio || ""}"> <span class="texto-suave">até</span> <input type="time" name="janela2_fim" value="${j2.fim || ""}">
          </div>
        </div>
        <div class="rodape-modal">
          <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
          <button type="submit" class="botao">Salvar horário</button>
        </div>
      </form>`);
  }

  // =======================================================================
  // Ações (data-acao) e formulários (data-form)
  // =======================================================================
  async function tratarAcao(acao, alvo) {
    switch (acao) {
      case "nova-ligacao": {
        try {
          await chamarApi("/ligacoes", { method: "POST" });
        } catch (e) {
          definirFlash("erro", "Não consegui criar a linha.");
          return;
        }
        return renderLigacoes();
      }
      case "filtrar-ligacoes-usuario": {
        if (!state._ligacoesFiltro) state._ligacoesFiltro = { aceitacao: "", soFechadas: false, ordenar: false, usuarioId: "" };
        state._ligacoesFiltro.usuarioId = alvo.value;
        return renderLigacoes();
      }
      case "filtrar-ligacoes-aceitacao": {
        if (!state._ligacoesFiltro) state._ligacoesFiltro = { aceitacao: "", soFechadas: false, ordenar: false };
        state._ligacoesFiltro.aceitacao = alvo.value;
        return renderLigacoes();
      }
      case "filtrar-ligacoes-fechadas": {
        if (!state._ligacoesFiltro) state._ligacoesFiltro = { aceitacao: "", soFechadas: false, ordenar: false };
        state._ligacoesFiltro.soFechadas = alvo.checked;
        return renderLigacoes();
      }
      case "ver-piores-atendimentos": {
        let itens = [];
        try { itens = JSON.parse(alvo.dataset.usuario || "[]"); } catch (e) { itens = []; }
        const nome = alvo.dataset.nome || "";
        abrirModal(`
          <h3 style="margin-top:0;">🔍 Piores atendimentos — ${escapeHtml(nome)}</h3>
          <p class="dica">Os atendimentos fechados que mais demoraram, do pior pro melhor. Clica num cliente pra abrir a conversa.</p>
          <div style="display:flex; flex-direction:column; gap:8px; max-height:50vh; overflow-y:auto;">
            ${itens.length ? itens.map((it) => `
              <button type="button" data-acao="ir-para-atendimento" data-conversa-id="${it.conversa_id}" style="display:block; width:100%; text-align:left; text-decoration:none; color:inherit; background:none; border:1px solid var(--borda); border-radius:10px; padding:10px 12px; cursor:pointer; font:inherit;">
                <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline;">
                  <strong>${escapeHtml(it.contato_nome || it.telefone || "—")}</strong>
                  <span class="selo bloqueado">${fmtMinutos(it.duracao_min)}</span>
                </div>
                <div class="texto-suave" style="font-size:12px; margin-top:2px;">${escapeHtml(it.telefone || "")} · começou em ${fmtData(it.criado_em)}</div>
              </button>`).join("") : `<p class="dica">Nenhum atendimento fechado ainda.</p>`}
          </div>
          <div class="rodape-modal"><button type="button" class="botao secundario" data-acao="fechar-modal">Fechar</button></div>`, "modal-largo");
        return;
      }
      case "ir-para-atendimento": {
        fecharModais();
        return navegarPara(`#/whatsapp/${alvo.dataset.conversaId}`);
      }
      case "ordenar-ligacoes-aceitacao": {
        if (!state._ligacoesFiltro) state._ligacoesFiltro = { aceitacao: "", soFechadas: false, ordenar: false };
        state._ligacoesFiltro.ordenar = !state._ligacoesFiltro.ordenar;
        return renderLigacoes();
      }
      case "prorrogar-ligacao": {
        const id = Number(alvo.dataset.id);
        try {
          await chamarApi(`/ligacoes/${id}/prorrogar`, { method: "POST" });
        } catch (e) {
          definirFlash("erro", "Não consegui prorrogar.");
          return;
        }
        definirFlash("ok", "Próximo contato adiado.");
        return renderLigacoes();
      }
      case "excluir-ligacao": {
        const id = Number(alvo.dataset.id);
        if (!confirm("Excluir esta linha? Não tem como desfazer.")) return;
        try {
          await chamarApi(`/ligacoes/${id}`, { method: "DELETE" });
        } catch (e) {
          definirFlash("erro", "Não consegui excluir.");
          return;
        }
        return renderLigacoes();
      }
      case "exportar-ligacoes-xlsx": {
        try {
          await _baixarArquivoAutenticado("/ligacoes/exportar.xlsx", "ligacoes.xlsx");
        } catch (e) {
          definirFlash("erro", e.message || "Não consegui exportar.");
        }
        return;
      }
      case "exportar-ligacoes-pdf": {
        try {
          await _baixarArquivoAutenticado("/ligacoes/exportar.pdf", "ligacoes.pdf");
        } catch (e) {
          definirFlash("erro", e.message || "Não consegui exportar.");
        }
        return;
      }
      case "camera-enviar-whatsapp": {
        const campo = document.querySelector(".wpp-input-camera-oculto");
        if (!campo) return;
        campo.onchange = () => {
          const arquivo = campo.files && campo.files[0];
          campo.value = "";
          if (arquivo) modalEscolherContatoParaFoto(arquivo);
        };
        campo.click();
        return;
      }
      case "alternar-mais-opcoes": {
        state._maisOpcoesAberta = !state._maisOpcoesAberta;
        const painel = document.querySelector(".wpp-mais-opcoes");
        const seta = document.querySelector(".wpp-seta-mais-opcoes");
        if (painel) painel.hidden = !state._maisOpcoesAberta;
        if (seta) seta.classList.toggle("wpp-seta-mais-opcoes-aberta", state._maisOpcoesAberta);
        return;
      }
      case "instalar-app": {
        // (async por causa do await _prepararDownloads() logo abaixo)
        // O navegador só deixa chamar prompt() a partir de um clique de
        // verdade — por isso o evento fica guardado desde o carregamento
        // e é usado aqui, não na hora em que ele chega.
        const evt = state._promptInstalar;
        if (!evt) {
          // Sem atalho automático. É o caso NORMAL no iPhone (o Safari
          // nunca oferece), e também acontece no Android quando o app já
          // está instalado ou o aviso já foi dispensado antes. Em vez de
          // esconder o botão — que era o pior dos mundos, some justo
          // quando a pessoa mais precisa da instrução — mostramos o
          // caminho manual, com o do aparelho dela em destaque.
          const ua = navigator.userAgent;
          const ehApple = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
          const jaInstalado = matchMedia("(display-mode: standalone)").matches;
          await _prepararDownloads();
          const cardAndroid = `
            <div class="escolha-item" style="cursor:default; align-items:flex-start;">
              <span class="escolha-texto"><strong>🤖 Android</strong>
                <span class="escolha-ajuda">Pelo Chrome, sem precisar instalar arquivo nenhum:<br>
                1. Toque em <strong>⋮</strong> no canto superior direito.<br>
                2. Escolha <strong>Instalar app</strong> (ou "Adicionar à tela inicial").<br>
                3. Confirme.</span>
                <a class="botao secundario pequeno" href="/downloads/SejaAlpha.apk" style="display:inline-block; text-decoration:none; margin-top:8px;">⬇ Ou baixar o app (.apk)</a></span>
            </div>`;
          const cardApple = `
            <div class="escolha-item" style="cursor:default; align-items:flex-start;">
              <span class="escolha-texto"><strong>🍎 iPhone e iPad (Safari)</strong>
                <span class="escolha-ajuda">1. Toque no botão <strong>Compartilhar</strong> (o quadrado com a seta pra cima, embaixo).<br>
                2. Role a lista e escolha <strong>Adicionar à Tela de Início</strong>.<br>
                3. Toque em <strong>Adicionar</strong>.<br>
                <em>Só funciona pelo Safari — pelo Chrome do iPhone essa opção não existe. Não existe arquivo pra instalar no iPhone: a Apple só permite pela App Store.</em></span></span>
            </div>`;
          return abrirModal(`
            <h3 style="margin-top:0;">📲 Instalar no aparelho</h3>
            ${jaInstalado
              ? `<p class="dica">Você já está usando o app instalado — não precisa instalar de novo.</p>`
              : `<p class="dica">Escolha o aparelho:</p>`}
            <div class="escolha-lista">
              ${ehApple ? cardApple + cardAndroid : cardAndroid + cardApple}
            </div>
            <div class="rodape-modal"><button type="button" class="botao" data-acao="fechar-modal">Entendi</button></div>`);
        }
        evt.prompt();
        const escolha = await evt.userChoice;
        state._promptInstalar = null;
        state.podeInstalarApp = false;
        if (escolha && escolha.outcome === "accepted") definirFlash("ok", "Pronto — o ícone do Seja Alpha foi criado no aparelho.");
        return montarRota();
      }
      case "alternar-menu-mobile":
        document.querySelector(".barra-lateral").classList.toggle("aberta");
        document.querySelector(".fundo-menu-mobile").classList.toggle("visivel");
        return;
      case "abrir-reacao": {
        // Os seis do WhatsApp, na mesma ordem — quem já usa o aplicativo
        // acha o que quer sem procurar.
        const rapidas = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
        const id = Number(alvo.dataset.id);
        const interna = alvo.dataset.interna === "1" ? "1" : "0";
        const bolha = alvo.closest(".wpp-bolha");
        const jaTem = bolha && bolha.querySelector(".wpp-reacao");
        document.querySelectorAll(".wpp-reacao-painel").forEach((p) => p.remove());
        const painel = document.createElement("div");
        painel.className = "wpp-reacao-painel";
        painel.innerHTML = rapidas.map((e) =>
          `<button type="button" class="wpp-reacao-opcao" data-acao="reagir" data-id="${id}" data-interna="${interna}" data-emoji="${e}">${e}</button>`
        ).join("") + (jaTem
          ? `<button type="button" class="wpp-reacao-opcao wpp-reacao-tirar" data-acao="reagir" data-id="${id}" data-interna="${interna}" data-emoji="" title="Tirar a reação">✕</button>`
          : "");
        document.body.appendChild(painel);

        // Encosta o painel no botão e puxa pra dentro se estourar a
        // janela — sem isso, quem reage numa mensagem colada na beirada
        // recebe metade dos emojis fora da tela.
        const r = alvo.getBoundingClientRect();
        const largura = painel.offsetWidth, altura = painel.offsetHeight;
        let x = r.right - largura;
        if (x < 8) x = 8;
        if (x + largura > window.innerWidth - 8) x = window.innerWidth - largura - 8;
        // Acima do botão; se não couber, abaixo.
        let y = r.top - altura - 6;
        if (y < 8) y = r.bottom + 6;
        if (y + altura > window.innerHeight - 8) y = window.innerHeight - altura - 8;
        if (y < 8) y = 8;
        painel.style.left = x + "px";
        painel.style.top = y + "px";

        // Rolar a conversa deixaria o painel parado no ar, longe da
        // mensagem — fecha junto, como faz o menu do botão direito.
        const painelMensagens = alvo.closest(".wpp-mensagens");
        const fechar = (ev) => {
          if (ev && ev.type === "click" && painel.contains(ev.target)) return;
          painel.remove();
          document.removeEventListener("click", fechar);
          window.removeEventListener("resize", fechar);
          if (painelMensagens) painelMensagens.removeEventListener("scroll", fechar);
        };
        setTimeout(() => {
          document.addEventListener("click", fechar);
          window.addEventListener("resize", fechar);
          if (painelMensagens) painelMensagens.addEventListener("scroll", fechar, { passive: true });
        }, 0);
        return;
      }
      case "reagir": {
        const conversaId = Number(location.hash.split("/")[2]);
        const id = Number(alvo.dataset.id);
        const interna = alvo.dataset.interna === "1";
        document.querySelectorAll(".wpp-reacao-painel").forEach((p) => p.remove());
        const base = interna ? "/chat-interno" : "/whatsapp";
        const r = await chamarApi(`${base}/conversas/${conversaId}/mensagens/${id}/reagir`, {
          method: "POST", body: { emoji: alvo.dataset.emoji },
        });
        // No chat interno não existe "mandar pro cliente": a reação já
        // está onde precisa estar. O aviso abaixo é só do outro lado.
        if (!interna && !r.enviada_ao_cliente && alvo.dataset.emoji) {
          definirFlash("erro", "A reação ficou registrada aqui, mas o WhatsApp não aceitou enviá-la ao cliente.");
        }
        return interna ? atualizarMensagensInternasNoDom(conversaId) : atualizarMensagensNoDom(conversaId);
      }
      case "gravar-video": {
        const id = Number(alvo.dataset.id);
        return _gravarVideo(`${API}/whatsapp/conversas/${id}/anexo`, () => atualizarMensagensNoDom(id));
      }
      case "gravar-video-interno": {
        const id = Number(alvo.dataset.id);
        return _gravarVideo(`${API}/chat-interno/conversas/${id}/anexo`, () => atualizarMensagensInternasNoDom(id));
      }
      case "sem-pendencia": {
        const id = Number(alvo.dataset.id);
        const desmarcar = alvo.dataset.desmarcar === "1";
        await chamarApi(`/whatsapp/conversas/${id}/sem-pendencia`, { method: "POST", body: { desmarcar } });
        definirFlash("ok", desmarcar
          ? "Conversa voltou a contar como pendente."
          : "Marcada como resolvida — sai do alerta de atraso. Se o cliente escrever de novo, volta a cobrar.");
        atualizarBadgeSla();
        return renderWhatsapp(id);
      }
      case "prorrogar-conversa": {
        const id = Number(alvo.dataset.id);
        try {
          await chamarApi(`/whatsapp/conversas/${id}/prorrogar`, { method: "POST" });
        } catch (erro) {
          definirFlash("erro", erro.message || "Não foi possível prorrogar.");
          return;
        }
        definirFlash("ok", "Conversa prorrogada.");
        return renderWhatsapp(id);
      }
      case "alternar-ausente": {
        const jaAusente = state.usuarioAtual && state.usuarioAtual.ausente;
        if (jaAusente) {
          const u = await chamarApi("/usuarios/ausente", { method: "PUT", body: { ausente: false } });
          state.usuarioAtual = { ...state.usuarioAtual, ausente: false, ausente_motivo: null };
          definirFlash("ok", "Bem-vindo de volta — você voltou a aparecer como disponível.");
          return montarRota();
        }
        return modalAusencia();
      }
      case "alternar-tema": {
        const atual = document.documentElement.getAttribute("data-tema") || "auto";
        const proximo = atual === "escuro" ? "claro" : atual === "claro" ? "auto" : "escuro";
        if (proximo === "auto") document.documentElement.removeAttribute("data-tema");
        else document.documentElement.setAttribute("data-tema", proximo);
        localStorage.setItem("whatts_tema", proximo);
        return;
      }
      case "logout": {
        pararPollingLembretes();
        pararPollingStatusGlobal();
        try { await chamarApi("/auth/logout", { method: "POST", body: { refresh_token: state.refreshToken } }); } catch (e) { /* ignora */ }
        limparSessao();
        return navegarPara("#/login");
      }
      case "ir-conversa-lembrete": {
        fecharModais();
        return navegarPara(`#/whatsapp/${alvo.dataset.conversaId}`);
      }
      case "concluir-lembrete-alerta": {
        await chamarApi(`/whatsapp/lembretes/${alvo.dataset.id}/concluir`, { method: "POST" });
        fecharModais();
        definirFlash("ok", "Lembrete concluído.");
        return montarRota();
      }
      case "fechar-modal": fecharModais(); return;
      // Pedido do Clayton (2026-08-31): fecha o aviso (erro/sucesso) do
      // topo da tela na hora, sem esperar sumir sozinho -- ele só some
      // de verdade no PRÓXIMO redesenho da tela inteira (fica queimado
      // até lá, mesmo que a pessoa já tenha lido e siga trabalhando).
      case "fechar-flash": { alvo.closest(".flash-aviso")?.remove(); state.flash = null; return; }
      case "cancelar-2fa": {
        state._aguardando2fa = false;
        state._loginPendente = null;
        return renderLogin();
      }
      case "alternar-mostrar-senha": {
        const input = alvo.closest(".campo-senha").querySelector("input");
        input.type = input.type === "password" ? "text" : "password";
        alvo.textContent = input.type === "password" ? "👁️" : "🙈";
        return;
      }
      case "voltar-lista": navegarPara("#/whatsapp"); return;
      case "voltar-lista-interno": navegarPara("#/chat-interno"); return;
      case "chat-interno-trocar-escopo": state.chatInternoEscopo = alvo.dataset.escopo; return renderChatInterno(null);
      case "abrir-agendar-em-massa": {
        return modalAgendarEmMassa();
      }
      case "confirmar-agendar-em-massa": {
        const modal = alvo.closest(".modal");
        const texto = modal.querySelector("[data-agendar-massa-texto]").value.trim();
        const quando = modal.querySelector("[data-agendar-massa-quando]").value;
        const marcados = [...modal.querySelectorAll("[data-agendar-massa-usuario]:checked")].map((cx) => Number(cx.value));
        const todosMarcados = modal.querySelector("[data-agendar-massa-todos]").checked;
        if (!texto) { definirFlash("erro", "Escreva a mensagem."); return; }
        if (!quando) { definirFlash("erro", "Informe quando enviar."); return; }
        if (!marcados.length) { definirFlash("erro", "Escolha pelo menos um destinatário."); return; }
        try {
          const r = await chamarApi("/chat-interno/agendar-em-massa", {
            method: "POST",
            body: { texto, agendado_para: new Date(quando).toISOString(), usuarios: todosMarcados ? null : marcados },
          });
          fecharModais();
          definirFlash("ok", `Agendado para ${r.agendados} pessoa(s).`);
        } catch (e) {
          definirFlash("erro", e.message || "Não consegui agendar.");
        }
        return;
      }
      case "abrir-nova-conversa-interna": {
        const [usuarios, setores] = await Promise.all([chamarApi("/usuarios"), chamarApi("/usuarios/setores")]);
        modalNovaConversaInterna(usuarios, setores);
        return;
      }
      case "filtrar-participantes-interno": {
        const setor = alvo.value;
        const select = document.querySelector("[data-lista-participantes]");
        for (const opt of select.options) {
          if (!opt.value) continue;
          const seus = (opt.dataset.setores || "").split("|").filter(Boolean);
          opt.hidden = !!setor && !seus.includes(setor);
        }
        select.value = "";
        return;
      }
      case "abrir-encaminhar-interno": {
        const id = Number(alvo.dataset.id);
        const [usuarios, conversa] = await Promise.all([chamarApi("/usuarios"), chamarApi("/chat-interno/conversas").then((cs) => cs.find((c) => c.id === id))]);
        modalEncaminharInterno(id, usuarios, conversa ? conversa.criado_por_id : null);
        return;
      }
      case "fechar-interno": {
        const id = Number(alvo.dataset.id);
        await chamarApi(`/chat-interno/conversas/${id}/fechar`, { method: "POST" });
        definirFlash("ok", "Conversa fechada.");
        return renderChatInterno(id);
      }
      case "reabrir-interno": {
        const id = Number(alvo.dataset.id);
        await chamarApi(`/chat-interno/conversas/${id}/reabrir`, { method: "POST" });
        definirFlash("ok", "Conversa reaberta.");
        return renderChatInterno(id);
      }
      case "tirar-etiqueta": {
        const interna = alvo.dataset.interna === "1";
        const conversaId = alvo.dataset.id;
        const tirar = Number(alvo.dataset.tag);
        // Lê as que estão lá agora e regrava sem esta — o servidor
        // espera a lista final, não "remova esta".
        const botao = document.querySelector(`[data-acao="${interna ? "abrir-tags-interna" : "abrir-tags-conversa"}"]`);
        const atuais = JSON.parse((botao && botao.dataset.tags) || "[]").map(Number);
        await chamarApi(_urlTagsDaConversa(conversaId, interna), {
          method: "PUT", body: { tag_ids: atuais.filter((x) => x !== tirar) },
        });
        return _redesenharCanal(interna);
      }
      case "alternar-etiqueta-conversa": {
        const tags = JSON.parse(alvo.dataset.tags || "[]");
        const interna = alvo.dataset.interna === "1";
        await chamarApi(_urlTagsDaConversa(alvo.dataset.id, interna), { method: "PUT", body: { tag_ids: tags } });
        return _redesenharCanal(interna);
      }
      case "nova-etiqueta-conversa": {
        const conversaId = alvo.dataset.id;
        const interna = alvo.dataset.interna === "1";
        const jaTem = JSON.parse(alvo.dataset.tags || "[]");
        return modalNovaEtiqueta(async (nome, cor) => {
          const nova = await chamarApi("/whatsapp/tags", { method: "POST", body: { nome, cor } });
          await chamarApi(_urlTagsDaConversa(conversaId, interna), { method: "PUT", body: { tag_ids: [...jaTem, nova.id] } });
          await obterEtiquetas(true); // o menu precisa enxergar a etiqueta nova
          fecharModais();
          definirFlash("ok", `Etiqueta "${nome}" criada e aplicada.`);
          _redesenharCanal(interna);
        });
      }
      case "abrir-apelido-interno-menu": {
        const botao = document.querySelector('[data-acao="abrir-apelido-interno"]');
        if (botao) botao.click();
        return;
      }
      case "renomear-contato-menu": {
        const botao = document.querySelector('[data-acao="renomear-contato"]');
        if (botao) botao.click();
        return;
      }
      case "fechar-foto-ampliada": {
        const janela = alvo.closest(".fundo-modal-foto");
        if (janela) janela.remove();
        return;
      }
      case "fechar-transcricao":
      case "abrir-transcricao": {
        if (!state.transcricoesFechadas) state.transcricoesFechadas = new Set();
        const chave = `${alvo.dataset.interna === "1" ? "i" : "c"}:${alvo.dataset.id}`;
        if (acao === "fechar-transcricao") state.transcricoesFechadas.add(chave);
        else state.transcricoesFechadas.delete(chave);
        const conversaId = Number(location.hash.split("/")[2]);
        return alvo.dataset.interna === "1"
          ? atualizarMensagensInternasNoDom(conversaId)
          : atualizarMensagensNoDom(conversaId);
      }
      case "transcrever-audio": {
        const id = Number(alvo.dataset.id);
        const interna = alvo.dataset.interna === "1";
        const conversaId = Number(location.hash.split("/")[2]);
        const original = alvo.textContent;
        alvo.disabled = true;
        alvo.textContent = "📝 Transcrevendo…";
        try {
          const base = interna ? `/chat-interno/conversas/${conversaId}` : `/whatsapp/conversas/${conversaId}`;
          await chamarApi(`${base}/mensagens/${id}/transcrever`, { method: "POST" });
        } catch (e) {
          alvo.disabled = false;
          alvo.textContent = original;
          throw e;
        }
        // A transcrição agora roda em SEGUNDO PLANO no servidor (pra não
        // travar o sistema todo enquanto processa — só 1 CPU) — o pedido
        // acima só avisa "comecei", não espera terminar. O botão fica
        // "Transcrevendo…" (marcado como pendente) até o polling normal
        // da tela trazer a transcrição pronta sozinho, em alguns
        // segundos, e trocar o botão pelo texto.
        state._transcricoesPendentes.add(id);
        return interna ? atualizarMensagensInternasNoDom(conversaId) : atualizarMensagensNoDom(conversaId);
      }
      case "ampliar-foto": {
        modalFotoAmpliada(alvo.dataset.url, alvo.dataset.nome || "");
        return;
      }
      case "filtrar-por-etiqueta-interno": {
        const id = alvo.dataset.id || null;
        state.tagFiltroInterno = String(state.tagFiltroInterno) === String(id) ? null : id;
        return renderChatInterno(null);
      }
      case "filtrar-por-etiqueta": {
        const id = alvo.dataset.id || null;
        state.tagFiltro = String(state.tagFiltro) === String(id) ? null : id;
        return renderWhatsapp(null);
      }
      case "trocar-escopo-conversas": {
        state.escopoConversas = alvo.dataset.escopo;
        // O filtro de atendente só faz sentido dentro de "Todas" — sair
        // de lá sem limpar fazia outras abas (ex.: Arquivadas) mostrarem
        // a lista vazia mesmo com contagem > 0, porque o filtro de uma
        // pessoa específica continuava grudado.
        if (alvo.dataset.escopo !== "todas") state.usuarioFiltroAtendente = null;
        return renderWhatsapp(null);
      }
      case "filtrar-por-atendente": {
        state.usuarioFiltroAtendente = alvo.value || null;
        return renderWhatsapp(null);
      }
      case "alternar-filtro-negociacao": {
        state.filtroNegociacaoFechada = !state.filtroNegociacaoFechada;
        if (state.filtroNegociacaoFechada) state.filtroSoGrupos = false;
        return renderWhatsapp(null);
      }
      case "alternar-filtros-extras": {
        state.filtrosExtrasAbertos = !state.filtrosExtrasAbertos;
        const aberto = state.filtrosExtrasAbertos;
        const bloco = alvo.closest(".wpp-tags-filtro-bloco");
        const chips = bloco && bloco.querySelector(".wpp-tags-filtro");
        if (chips) chips.hidden = !aberto;
        alvo.textContent = `🔧 Mais filtros ${aberto ? "▾" : "▸"}`;
        return;
      }
      case "alternar-filtro-grupos": {
        state.filtroSoGrupos = !state.filtroSoGrupos;
        if (state.filtroSoGrupos) state.filtroNegociacaoFechada = false;
        return renderWhatsapp(null);
      }
      case "alternar-lembretes-todos": {
        state.lembretesTodos = alvo.dataset.todos === "1";
        return renderLembretes();
      }
      case "alternar-agendamentos-todos": {
        state.agendamentosTodos = alvo.dataset.todos === "1";
        return renderAgendamentos();
      }
      case "cancelar-agendada-global": {
        if (!confirm("Cancelar este envio agendado?")) return;
        await chamarApi(`/whatsapp/agendadas/${alvo.dataset.id}`, { method: "DELETE" });
        definirFlash("ok", "Agendamento cancelado.");
        return renderAgendamentos();
      }
      case "assumir-conversa": {
        const id = Number(alvo.dataset.id);
        try {
          await chamarApi(`/whatsapp/conversas/${id}/assumir`, { method: "POST" });
        } catch (erro) {
          if (erro.codigo === "conversa_atribuida" || erro.codigo === "ja_atribuida") {
            return modalConversaPresa(erro);
          }
          throw erro;
        }
        state.escopoConversas = "minhas";
        return navegarPara(`#/whatsapp/${id}`);
      }
      case "abrir-seletor-foto": document.querySelector(".wpp-input-foto-oculto").click(); return;
      case "iniciar-2fa": {
        const resp = await chamarApi("/auth/2fa/iniciar", { method: "POST" });
        document.querySelector("[data-2fa-enrolamento]").innerHTML = html2faEnrolamento(resp.secreto, resp.uri);
        return;
      }
      case "copiar-2fa-secreto": {
        try { await navigator.clipboard.writeText(alvo.dataset.valor); definirFlash("ok", "Chave copiada."); montarRota(); }
        catch (e) { /* usuário pode selecionar e copiar manualmente */ }
        return;
      }
      case "fechar-codigos-2fa": return renderSeguranca();
      case "alternar-campo-setor": {
        const campo = document.querySelector("[data-campo-setor]");
        const ehAdmin = alvo.checked;
        // Admin não tem fila de setor: ele vê a empresa inteira.
        campo.style.display = ehAdmin ? "none" : "";
        // Administrador enxerga tudo por definição — deixar a caixa de
        // "pode ver as conversas" à mostra só criaria a impressão de que
        // dá pra tirar isso dele.
        const acesso = document.querySelector("[data-campo-acesso]");
        if (acesso) {
          acesso.style.display = ehAdmin ? "none" : "";
          if (ehAdmin) acesso.querySelector("input").checked = true;
        }
        return;
      }
      case "enviar-foto-perfil": {
        const escolhido = alvo.files[0];
        if (!escolhido) return;
        alvo.value = ""; // permite escolher a mesma foto de novo depois
        return modalEnquadrarFoto(escolhido, async (arquivo) => {
        const formData = new FormData();
        formData.append("foto", arquivo);
        const resp = await fetch(`${API}/usuarios/foto`, {
          method: "POST",
          headers: { Authorization: "Bearer " + state.accessToken },
          body: formData,
        }).then(async (r) => {
          if (!r.ok) { const c = await r.json().catch(() => ({})); throw Object.assign(new Error(c.mensagem || `Erro ${r.status}`), { status: r.status }); }
          return r.json();
        });
        state.usuarioAtual.foto_perfil = resp.foto_perfil;
        definirFlash("ok", "Foto de perfil atualizada.");
        return montarRota();
        });
      }
      case "exportar-dashboard": {
        const resp = await fetch(`${API}/whatsapp/dashboard/exportar`, { headers: { Authorization: "Bearer " + state.accessToken } });
        if (!resp.ok) { definirFlash("erro", "Não foi possível exportar o dashboard."); return montarRota(); }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `dashboard_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return;
      }
      case "alternar-filtro-etiquetas": {
        const interna = alvo.dataset.interna === "1";
        if (interna) state.etiquetasFiltroAbertasInterno = !state.etiquetasFiltroAbertasInterno;
        else state.etiquetasFiltroAbertas = !state.etiquetasFiltroAbertas;
        const aberto = interna ? state.etiquetasFiltroAbertasInterno : state.etiquetasFiltroAbertas;
        const bloco = alvo.closest(".wpp-tags-filtro-bloco");
        const chips = bloco && bloco.querySelector(".wpp-tags-filtro");
        if (chips) chips.hidden = !aberto;
        alvo.textContent = `🏷️ Etiquetas ${aberto ? "▾" : "▸"}`;
        return;
      }
      case "filtrar-atividades": {
        state.filtroAtividadesUsuarioId = alvo.value || null;
        return renderAtividades();
      }
      case "limpar-busca-conversas": {
        state.buscaConversas = null;
        state.buscaData = null;
        return renderWhatsapp(null);
      }
      case "devolver-para-fila": {
        const id = Number(alvo.dataset.id);
        await chamarApi(`/whatsapp/conversas/${id}/atribuir`, { method: "PUT", body: { usuario_id: null } });
        fecharModais();
        definirFlash("ok", "Conversa devolvida pra fila — qualquer pessoa do setor já pode assumir.");
        return renderWhatsapp(null);
      }
      case "encaminhar-mensagem": {
        const conversaId = Number(location.hash.split("/")[2]);
        return modalEncaminharMensagem(conversaId, Number(alvo.dataset.id), alvo.dataset.interna === "1");
      }
      case "conversar-com-numero": {
        // Já existe conversa com esse número? Abre ela. Se não, cai na
        // janela de nova conversa com o número já preenchido — assim o
        // clique nunca "não faz nada".
        const tel = alvo.dataset.telefone;
        try {
          const r = await chamarApi(`/whatsapp/contatos?q=${encodeURIComponent(tel)}`);
          const achados = r.contatos || r || [];
          const exato = achados.find((c) => (c.telefone || "").replace(/\D/g, "").endsWith(tel.slice(-8)));
          if (exato && exato.conversa_id) {
            state.escopoConversas = "todas";
            return navegarPara(`#/whatsapp/${exato.conversa_id}`);
          }
        } catch (e) { /* sem contato: segue pra janela de nova conversa */ }
        return modalNovaConversa(tel);
      }
      case "abrir-mais-acoes": {
        const id = alvo.dataset.id;
        const r = alvo.getBoundingClientRect();
        const arquivada = alvo.dataset.arquivada === "1";
        const proximo = alvo.dataset.proximo;
        const ehGrupo = alvo.dataset.ehGrupo === "1";
        const totalNegociacoes = Number(alvo.dataset.negociacoes || 0);
        return abrirMenuContexto(r.right - 250, r.bottom + 4, [
          { acao: "abrir-resumo", id, rotulo: alvo.dataset.resumo ? "📝 Ver/editar resumo" : "📝 Escrever resumo",
            dados: { resumo: alvo.dataset.resumo } },
          { acao: "abrir-lembrete", id, rotulo: "🔔 Criar lembrete de retorno" },
          ...(!ehGrupo ? [{ acao: "ver-negociacoes", id, rotulo: `💰 Negociações fechadas${totalNegociacoes ? ` (${totalNegociacoes})` : ""}` }] : []),
          { acao: "abrir-agendar-contato", id,
            rotulo: proximo ? `📞 Próximo contato: ${fmtData(proximo)}` : "📞 Agendar próximo contato" },
          { acao: arquivada ? "desarquivar-conversa" : "arquivar-conversa", id,
            rotulo: arquivada ? "📤 Desarquivar" : "🗄️ Arquivar" },
          { acao: "excluir-conversa", id, rotulo: "🗑️ Excluir conversa" },
        ]);
      }
      case "abrir-envio-massa": return modalEnvioMassa();
      case "confirmar-envio-massa": {
        const wrapModal = alvo.closest(".fundo-modal");
        const modal = alvo.closest(".modal");
        const escolhidos = wrapModal ? wrapModal._envioMassaEscolhidos : null;
        const texto = modal.querySelector("[data-envio-massa-texto]").value.trim();
        if (!escolhidos || !escolhidos.size) { definirFlash("erro", "Escolha pelo menos um destinatário."); return; }
        if (!texto) { definirFlash("erro", "Escreva a mensagem."); return; }
        if (!confirm(`Confirma o envio pra ${escolhidos.size} contato(s)? Vai ser mandado aos poucos, não tem como desfazer depois de começar.`)) return;
        try {
          const r = await chamarApi("/whatsapp/envio-massa", {
            method: "POST",
            body: { texto, telefones: [...escolhidos.keys()] },
          });
          fecharModais();
          definirFlash("ok", `Envio iniciado — ${r.total} destinatário(s) na fila, sendo mandado aos poucos.`);
        } catch (e) {
          definirFlash("erro", e.message || "Não consegui iniciar o envio.");
        }
        return;
      }
      case "abrir-nova-conversa": modalNovaConversa(); return;
      case "abrir-criar-grupo": {
        return modalCriarGrupo();
      }
      case "editar-contato": {
        return modalEditarContato(Number(alvo.dataset.id), alvo.dataset.nome || "", alvo.dataset.telefone || "");
      }
      case "abrir-contatos": {
        fecharModais();
        await modalContatos();
        return;
      }
      case "iniciar-conversa-contato": {
        fecharModais();
        modalNovaConversa(alvo.dataset.telefone, alvo.dataset.nome);
        return;
      }
      case "abrir-encaminhar": {
        const usuarios = await chamarApi("/usuarios");
        modalEncaminhar(Number(alvo.dataset.id), usuarios);
        return;
      }
      case "filtrar-followup": {
        const escolhido = alvo.dataset.filtro || null;
        state.followupFiltro = state.followupFiltro === escolhido ? null : escolhido;
        return carregarPainelFollowup();
      }
      case "prorrogar-rapido": {
        // Botões de atalho ("+1 hora", "amanhã") só preenchem o campo —
        // quem confirma é o botão Prorrogar, pra dar chance de ajustar.
        const campo = document.querySelector("[data-wpp-prorrogar-quando]");
        if (campo) campo.value = _valorDataHoraPadrao(Number(alvo.dataset.minutos) / 60);
        return;
      }
      case "prorrogar-lembrete": {
        const campo = document.querySelector("[data-wpp-prorrogar-quando]");
        const quando = campo && campo.value;
        if (!quando) { definirFlash("erro", "Escolha a nova data e hora."); return montarRota(); }
        await chamarApi(`/whatsapp/lembretes/${alvo.dataset.id}`, { method: "PUT", body: { lembrar_em: `${quando}:00` } });
        // Sai da lista de "já avisei" pra voltar a alertar na hora nova.
        state.lembretesAlertados.delete(Number(alvo.dataset.id));
        fecharModais();
        definirFlash("ok", "Lembrete prorrogado — ele continua aqui até você concluir.");
        carregarPainelFollowup();
        return montarRota();
      }
      case "prorrogar-lembrete-followup": {
        return modalProrrogarLembrete(Number(alvo.dataset.id));
      }
      case "concluir-lembrete-followup": {
        await chamarApi(`/whatsapp/lembretes/${alvo.dataset.id}/concluir`, { method: "POST" });
        definirFlash("ok", "Lembrete concluído.");
        carregarPainelFollowup();
        return;
      }
      case "cancelar-agendada-followup": {
        if (!confirm("Cancelar este agendamento? A mensagem não será enviada.")) return;
        await chamarApi(`/whatsapp/agendadas/${alvo.dataset.id}`, { method: "DELETE" });
        definirFlash("ok", "Agendamento cancelado.");
        carregarPainelFollowup();
        return;
      }
      case "editar-agendada": {
        return modalEditarAgendada(Number(alvo.dataset.id), alvo.dataset.texto || "", alvo.dataset.quando || "");
      }
      case "citar-mensagem": {
        const bolha = alvo.closest(".wpp-bolha");
        const corpo = bolha ? bolha.querySelector(".wpp-bolha-texto") : null;
        const autorEl = bolha ? bolha.querySelector('div[style*="font-weight:700"]') : null;
        state.citando = {
          id: Number(alvo.dataset.id),
          interna: alvo.dataset.interna === "1",
          texto: corpo ? corpo.textContent : "📎 Anexo",
          autor: autorEl ? autorEl.textContent : (bolha && bolha.classList.contains("wpp-bolha-saida") ? "Você" : ""),
        };
        _desenharBarraCitacao();
        const campo = document.querySelector('form.wpp-chat-input textarea[name="texto"]');
        if (campo) campo.focus();
        return;
      }
      case "cancelar-citacao": {
        state.citando = null;
        _desenharBarraCitacao();
        return;
      }
      case "ir-para-citada": {
        const alvoBolha = document.querySelector(`[data-wpp-bolha-id="${alvo.dataset.id}"]`)
          || document.querySelector(`[data-chave-sync="${alvo.dataset.id}"]`);
        if (!alvoBolha) { definirFlash("erro", "A mensagem citada não está nesta parte da conversa."); return montarRota(); }
        alvoBolha.scrollIntoView({ behavior: "smooth", block: "center" });
        alvoBolha.classList.add("wpp-bolha-realce");
        setTimeout(() => alvoBolha.classList.remove("wpp-bolha-realce"), 1600);
        return;
      }
      case "editar-mensagem": {
        const id = Number(alvo.dataset.id);
        const conversaId = Number(location.hash.split("/")[2]);
        return modalEditarMensagem(alvo.dataset.texto || "", true, async (texto) => {
          const r = await chamarApi(`/whatsapp/conversas/${conversaId}/mensagens/${id}`, { method: "PUT", body: { texto } });
          fecharModais();
          // Diz em qual dos dois lados a correção pegou — corrigir só
          // aqui e achar que o cliente viu é o pior desfecho possível.
          if (r && r.editada_no_cliente === false) {
            definirFlash("erro", "Corrigi aqui, mas o WhatsApp não aceitou corrigir no celular do cliente (mensagem antiga demais). Lá continua o texto original.");
          } else {
            definirFlash("ok", "Mensagem corrigida aqui e no celular do cliente.");
          }
          await atualizarMensagensNoDom(conversaId);
        });
      }
      case "editar-mensagem-interna": {
        const id = Number(alvo.dataset.id);
        const conversaId = Number(alvo.dataset.conversaId);
        return modalEditarMensagem(alvo.dataset.texto || "", false, async (texto) => {
          await chamarApi(`/chat-interno/conversas/${conversaId}/mensagens/${id}`, { method: "PUT", body: { texto } });
          fecharModais();
          await atualizarMensagensInternasNoDom(conversaId);
        });
      }
      case "renomear-etiqueta": {
        const nome = alvo.value.trim();
        if (!nome) { definirFlash("erro", "A etiqueta precisa de um nome."); return renderWhatsappConfiguracao(); }
        await chamarApi(`/whatsapp/tags/${alvo.dataset.tagId}`, { method: "PUT", body: { nome } });
        state._tagsCache = null;
        definirFlash("ok", "Etiqueta renomeada em todas as suas conversas.");
        return renderWhatsappConfiguracao();
      }
      case "recolorir-etiqueta": {
        const linha = alvo.closest("li");
        const nome = linha.querySelector('input[data-acao-change="renomear-etiqueta"]').value.trim();
        await chamarApi(`/whatsapp/tags/${alvo.dataset.tagId}`, { method: "PUT", body: { nome, cor: alvo.value } });
        state._tagsCache = null;
        return renderWhatsappConfiguracao();
      }
      case "excluir-etiqueta": {
        if (!confirm(`Excluir a etiqueta "${alvo.dataset.nome}"? Ela sai de todas as conversas onde você a usou. As conversas em si não são apagadas.`)) return;
        await chamarApi(`/whatsapp/tags/${alvo.dataset.id}`, { method: "DELETE" });
        state._tagsCache = null;
        if (String(state.tagFiltro) === String(alvo.dataset.id)) state.tagFiltro = null;
        definirFlash("ok", "Etiqueta excluída.");
        return renderWhatsappConfiguracao();
      }
      case "atualizar-fotos-contatos": {
        alvo.disabled = true;
        alvo.textContent = "Buscando…";
        try {
          const r = await chamarApi("/whatsapp/contatos/atualizar-fotos", { method: "POST" });
          definirFlash("ok", `${r.encontradas} foto(s) encontrada(s) em ${r.consultados} contato(s) sem foto. Quem não apareceu é porque não tem foto pública no WhatsApp.`);
        } finally {
          alvo.disabled = false;
        }
        return renderWhatsappConfiguracao();
      }
      case "atualizar-foto-contato": {
        const id = Number(alvo.dataset.id);
        const resp = await chamarApi(`/whatsapp/conversas/${id}/atualizar-foto-contato`, { method: "POST" });
        definirFlash("ok", resp.foto_url ? "Foto atualizada." : "Esse contato não tem foto de perfil pública no momento.");
        return montarRota();
      }
      case "fechar-conversa": modalFecharConversa(Number(alvo.dataset.id)); return;
      case "usar-localizacao-atual": {
        if (!navigator.geolocation) { definirFlash("erro", "Este navegador não sabe pegar localização."); return renderWhatsappConfiguracao(); }
        alvo.disabled = true;
        alvo.textContent = "Buscando…";
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const form = alvo.closest("form");
            form.querySelector('[name="localizacao_lat"]').value = pos.coords.latitude;
            form.querySelector('[name="localizacao_lng"]').value = pos.coords.longitude;
            alvo.disabled = false;
            alvo.textContent = "📍 Usar minha localização atual";
            definirFlash("ok", "Preenchido — confira e clique em Salvar.");
          },
          () => {
            alvo.disabled = false;
            alvo.textContent = "📍 Usar minha localização atual";
            definirFlash("erro", "Não consegui pegar a localização — seu navegador pode ter bloqueado a permissão.");
          }
        );
        return;
      }
      case "compartilhar-localizacao": {
        const conversaId = Number(alvo.dataset.id);
        if (!confirm("Compartilhar sua localização atual nesta conversa?")) return;
        const pos = await _obterLocalizacaoAtual();
        const body = pos ? { lat: pos.lat, lng: pos.lng } : {};
        const r = await chamarApi(`/whatsapp/conversas/${conversaId}/compartilhar-localizacao`, { method: "POST", body });
        definirFlash(r.status === "enviada" ? "ok" : "erro", r.status === "enviada" ? "Localização compartilhada." : `Não foi possível enviar: ${r.erro || "erro desconhecido"}`);
        await Promise.all([atualizarMensagensNoDom(conversaId), atualizarListaConversasNoDom()]);
        return;
      }
      case "compartilhar-localizacao-interno": {
        const conversaId = Number(alvo.dataset.id);
        const pos = await _obterLocalizacaoAtual();
        let lat = pos ? pos.lat : null, lng = pos ? pos.lng : null, nome = "Localização atual";
        if (lat == null) {
          // Sem GPS no navegador: cai pra localização salva em Configuração, se tiver.
          const config = await chamarApi("/whatsapp/configuracao").catch(() => null);
          if (config && config.localizacao_lat != null) { lat = config.localizacao_lat; lng = config.localizacao_lng; nome = config.localizacao_nome || "Localização"; }
        }
        if (lat == null) { definirFlash("erro", "Não consegui pegar sua localização (permissão do navegador?), e não há uma cadastrada em Configuração como reserva."); return; }
        const link = `https://www.google.com/maps?q=${lat},${lng}`;
        const texto = `📍 ${nome}\n${link}`;
        await chamarApi(`/chat-interno/conversas/${conversaId}/mensagens`, { method: "POST", body: { texto } });
        await Promise.all([atualizarMensagensInternasNoDom(conversaId), atualizarListaConversasInternasNoDom()]);
        return;
      }
      case "abrir-compartilhar-contato": {
        return modalCompartilharContato(Number(alvo.dataset.id), alvo.dataset.interna === "1");
      }
      case "pre-visualizar-mensagem": {
        // Pedido do Clayton: texto comprido crescia demais na caixinha
        // de escrever, ficava difícil reler tudo antes de mandar. Aqui
        // mostra o texto inteiro numa caixa BEM maior — e editável: dá
        // pra corrigir ali mesmo, sem voltar pra caixinha pequena.
        const interna = alvo.dataset.interna === "1";
        const form = alvo.closest("form");
        const textareaOriginal = form.querySelector('textarea[name="texto"]');
        const texto = (textareaOriginal.value || "").trim();
        // montarRota() pra aparecer NA HORA -- só chamar definirFlash não
        // redesenha nada sozinho, o aviso ficava "pendurado" e só surgia
        // (sem contexto nenhum) na próxima vez que a tela mudasse por
        // outro motivo qualquer.
        if (!texto) { definirFlash("erro", "Escreva algo antes de pré-visualizar."); return montarRota(); }
        abrirModal(`
          <h3 style="margin-top:0;">Pré-visualização</h3>
          <textarea class="wpp-previsualizacao-texto" data-previsualizacao-texto>${escapeHtml(texto)}</textarea>
          <div class="rodape-modal">
            <button type="button" class="botao secundario" data-acao="voltar-a-editar-previsualizacao" data-interna="${interna ? "1" : "0"}">Voltar a editar</button>
            <button type="button" class="botao" data-acao="enviar-da-previsualizacao" data-interna="${interna ? "1" : "0"}">Enviar</button>
          </div>
        `);
        // Cursor já no fim, pra continuar escrevendo/corrigindo sem
        // precisar clicar dentro da caixa primeiro.
        const areaPrevia = document.querySelector("[data-previsualizacao-texto]");
        areaPrevia.focus();
        areaPrevia.setSelectionRange(areaPrevia.value.length, areaPrevia.value.length);
        return;
      }
      // Some o texto (editado ou não) da pré-visualização de volta pra
      // caixinha real, antes de fechar o modal ou enviar — assim uma
      // correção feita ali nunca se perde, seja voltando ou mandando.
      case "voltar-a-editar-previsualizacao":
      case "enviar-da-previsualizacao": {
        const interna = alvo.dataset.interna === "1";
        const seletor = interna ? 'form[data-form="enviar-mensagem-interna"]' : 'form[data-form="enviar-mensagem"]';
        const form = document.querySelector(seletor);
        const areaPrevia = document.querySelector("[data-previsualizacao-texto]");
        if (form && areaPrevia) {
          form.querySelector('textarea[name="texto"]').value = areaPrevia.value;
          // Sem isto a edição feita na pré-visualização não ia pro
          // rascunho (localStorage) -- só pro campo na tela. Bastava a
          // tela atualizar sozinha (o polling troca a tela a cada
          // poucos segundos) pra correção se perder, voltando pro texto
          // de antes de abrir a pré-visualização.
          _salvarRascunho(interna ? "interna" : "cliente", form.dataset.conversaId, areaPrevia.value);
        }
        fecharModais();
        if (acao === "enviar-da-previsualizacao" && form) form.requestSubmit();
        return;
      }
      case "compartilhar-contato": {
        const conversaId = Number(alvo.dataset.id);
        const interna = alvo.dataset.interna === "1";
        const nome = alvo.dataset.nome;
        const telefone = alvo.dataset.telefone;
        fecharModais();
        if (interna) {
          // Chat interno não é WhatsApp de verdade — manda como
          // mensagem normal mesmo; o número vira clicável sozinho
          // (ver textoComTelefones), o colega já consegue "Conversar"
          // direto a partir daí.
          const texto = `👤 Contato: *${nome || telefone}*\n📞 ${telefone}`;
          await chamarApi(`/chat-interno/conversas/${conversaId}/mensagens`, { method: "POST", body: { texto } });
          await Promise.all([atualizarMensagensInternasNoDom(conversaId), atualizarListaConversasInternasNoDom()]);
        } else {
          const r = await chamarApi(`/whatsapp/conversas/${conversaId}/compartilhar-contato`, { method: "POST", body: { nome, telefone } });
          definirFlash(r.status === "enviada" ? "ok" : "erro", r.status === "enviada" ? "Contato compartilhado." : `Não foi possível enviar: ${r.erro || "erro desconhecido"}`);
          await Promise.all([atualizarMensagensNoDom(conversaId), atualizarListaConversasNoDom()]);
        }
        return;
      }
      case "abrir-notas": {
        const conversaId = Number(alvo.dataset.id);
        const notasAtuais = await chamarApi(`/whatsapp/conversas/${conversaId}/notas`).catch(() => []);
        return modalNotasInternas(conversaId, notasAtuais);
      }
      case "abrir-solicitar-troca": {
        return modalSolicitarTroca(Number(alvo.dataset.id), Number(alvo.dataset.negociacao), alvo.dataset.usuarioAtual);
      }
      case "trocar-negociacao": {
        const conversaId = Number(alvo.dataset.id);
        const negociacaoId = Number(alvo.dataset.negociacao);
        const select = document.querySelector(`[data-negociacao-select="${negociacaoId}"]`);
        const r = await chamarApi(`/whatsapp/conversas/${conversaId}/negociacoes/${negociacaoId}`, { method: "PUT", body: { usuario_id: Number(select.value) } });
        fecharModais();
        definirFlash("ok", `Negociação trocada pra ${r.usuario_nome}.`);
        return renderWhatsapp(conversaId);
      }
      case "ver-negociacoes": {
        const conversaId = Number(alvo.dataset.id);
        const negociacoes = await chamarApi(`/whatsapp/conversas/${conversaId}/negociacoes`).catch(() => []);
        return modalNegociacoesFechadas(conversaId, negociacoes);
      }
      case "marcar-negociacao": {
        if (!confirm("Marcar esta conversa como negociação fechada? Isso já entra na taxa de conversão do Dashboard.")) return;
        const conversaId = Number(alvo.dataset.id);
        await chamarApi(`/whatsapp/conversas/${conversaId}/resultado`, { method: "PUT", body: { resultado: "venda" } });
        fecharModais();
        definirFlash("ok", "Negociação fechada marcada — já entra no Dashboard, sem encerrar o atendimento.");
        return renderWhatsapp(conversaId);
      }
      case "desfazer-negociacao": {
        const conversaId = Number(alvo.dataset.id);
        const negociacaoId = Number(alvo.dataset.negociacao);
        await chamarApi(`/whatsapp/conversas/${conversaId}/negociacoes/${negociacaoId}`, { method: "DELETE" });
        definirFlash("ok", "Marcação desfeita.");
        fecharModais();
        return renderWhatsapp(conversaId);
      }
      case "fechar-conversa-com-resultado": {
        const id = Number(alvo.dataset.id);
        const resultado = alvo.dataset.resultado || undefined;
        fecharModais();
        await chamarApi(`/whatsapp/conversas/${id}/fechar`, { method: "POST", body: { resultado } });
        definirFlash("ok", "Conversa encerrada.");
        return renderWhatsapp(id);
      }
      case "reabrir-conversa": {
        const id = Number(alvo.dataset.id);
        await chamarApi(`/whatsapp/conversas/${id}/reabrir`, { method: "POST" });
        definirFlash("ok", "Conversa reaberta.");
        return renderWhatsapp(id);
      }
      case "abrir-seletor-arquivo": {
        document.querySelector(".wpp-input-arquivo-oculto").click();
        return;
      }
      case "anexar-arquivo": {
        const conversaId = Number(alvo.dataset.conversaId);
        await _enviarVariosAnexos(alvo, `${API}/whatsapp/conversas/${conversaId}/anexo`);
        return renderWhatsapp(conversaId);
      }
      case "alternar-gravacao-audio":
        return _alternarGravacaoAudio(
          alvo,
          `${API}/whatsapp/conversas/${Number(alvo.dataset.id)}/anexo`,
          () => renderWhatsapp(Number(alvo.dataset.id)),
        );
      case "alternar-gravacao-audio-interno":
        return _alternarGravacaoAudio(
          alvo,
          `${API}/chat-interno/conversas/${Number(alvo.dataset.id)}/anexo`,
          () => renderChatInterno(Number(alvo.dataset.id)),
        );
      case "anexar-arquivo-interno": {
        const conversaId = Number(alvo.dataset.conversaId);
        await _enviarVariosAnexos(alvo, `${API}/chat-interno/conversas/${conversaId}/anexo`);
        return renderChatInterno(conversaId);
      }
      case "excluir-mensagem-interna": {
        if (!confirm("Apagar esta mensagem? Ela some pra você e pro colega.")) return;
        const conversaId = Number(alvo.dataset.conversaId);
        await chamarApi(`/chat-interno/conversas/${conversaId}/mensagens/${alvo.dataset.id}`, { method: "DELETE" });
        definirFlash("ok", "Mensagem apagada.");
        return renderChatInterno(conversaId);
      }
      case "alternar-followup": {
        const painel = document.querySelector("[data-followup-painel]");
        painel.hidden = !painel.hidden;
        if (!painel.hidden) carregarPainelFollowup();
        return;
      }
      case "fechar-followup": {
        const painel = document.querySelector("[data-followup-painel]");
        if (painel) painel.hidden = true;
        return; // o href do link segue normalmente
      }
      case "abrir-lembrete-interno": {
        modalLembreteInterno(Number(alvo.dataset.id));
        return;
      }
      case "abrir-agendar-interno": {
        modalAgendarInterno(Number(alvo.dataset.id));
        return;
      }
      case "editar-etiqueta-menu": {
        const etiquetas = await obterEtiquetas();
        const tag = etiquetas.find((t) => String(t.id) === String(alvo.dataset.id));
        if (!tag) { definirFlash("erro", "Etiqueta não encontrada — pode já ter sido excluída."); return _redesenharCanal(alvo.dataset.interna === "1"); }
        return modalEditarEtiqueta(tag, alvo.dataset.interna === "1");
      }
      case "excluir-etiqueta-menu": {
        if (!confirm(`Excluir a etiqueta "${alvo.dataset.nome}"? Ela sai de todas as conversas onde foi usada. As conversas em si (e as mensagens) não são apagadas.`)) return;
        await chamarApi(`/whatsapp/tags/${alvo.dataset.id}`, { method: "DELETE" });
        state._tagsCache = null;
        if (String(state.tagFiltro) === String(alvo.dataset.id)) state.tagFiltro = null;
        if (String(state.tagFiltroInterno) === String(alvo.dataset.id)) state.tagFiltroInterno = null;
        definirFlash("ok", "Etiqueta excluída.");
        return _redesenharCanal(alvo.dataset.interna === "1");
      }
      case "excluir-etiqueta-escolher-menu": {
        const interna = alvo.dataset.interna === "1";
        const etiquetas = await obterEtiquetas();
        if (!etiquetas.length) { definirFlash("erro", "Nenhuma etiqueta criada ainda."); return; }
        const rect = alvo.getBoundingClientRect();
        abrirMenuContexto(rect.left, rect.bottom, [
          { separador: true, rotulo: "Excluir qual etiqueta?" },
          ...etiquetas.map((t) => ({
            acao: "excluir-etiqueta-menu", id: t.id, rotulo: escapeHtml(t.nome), cor: t.cor || "#6b7280",
            dados: { nome: t.nome, interna: interna ? "1" : "0" },
          })),
        ]);
        return;
      }
      case "chamar-atencao-interna": {
        if (alvo.disabled) return;
        const conversaId = Number(alvo.dataset.id);
        alvo.disabled = true;
        const iconeOriginal = alvo.textContent;
        try {
          await chamarApi(`/chat-interno/conversas/${conversaId}/chamar-atencao`, { method: "POST" });
          alvo.textContent = "✅";
          tocarConfirmacaoAtencaoEnviada();
          _mostrarConfirmacaoAtencaoEnviada(alvo.dataset.nome);
        } catch (erro) {
          alvo.textContent = "⚠️";
        } finally {
          // Trava 1,5s só pra evitar clique duplo sem querer — não é
          // limite de quantas vezes chamar, é só não martelar sem
          // querer no mesmo toque de dedo.
          setTimeout(() => { alvo.textContent = iconeOriginal; alvo.disabled = false; }, 1500);
        }
        return;
      }
      case "abrir-agendar-contato": {
        modalAgendarContato(Number(alvo.dataset.id));
        return;
      }
      case "abrir-adiar": {
        modalAdiar(Number(alvo.dataset.id));
        return;
      }
      case "avisar-atraso-followup": {
        // Manda um lembrete direto no chat interno pro responsável --
        // sem sair da tela de Follow-up. Reaproveita a mesma rota que
        // "Nova conversa interna" usa (acha a conversa com essa pessoa
        // se já existir, ou cria).
        const usuarioId = Number(alvo.dataset.usuario);
        const cliente = alvo.dataset.cliente || "um cliente";
        const dias = alvo.dataset.dias;
        const prazo = alvo.dataset.prazo;
        const texto = `🔔 Lembrete de follow-up: *${cliente}* está há ${dias} dia(s) sem retorno (prazo combinado: ${prazo}d). Dá uma olhada quando puder!`;
        alvo.disabled = true;
        const rotuloOriginal = alvo.textContent;
        alvo.textContent = "Avisando…";
        try {
          await chamarApi("/chat-interno/conversas", { method: "POST", body: { participante_id: usuarioId, texto } });
          alvo.textContent = "✓ Avisado";
        } catch (erro) {
          alvo.disabled = false;
          alvo.textContent = rotuloOriginal;
          throw erro;
        }
        return;
      }
      case "adiar-rapido": {
        await chamarApi(`/followup/conversas/${alvo.dataset.id}/adiar`, { method: "POST", body: { quanto: alvo.dataset.quanto } });
        fecharModais();
        definirFlash("ok", "Follow-up adiado.");
        atualizarContadorFollowup();
        carregarPainelFollowup();
        return;
      }
      case "alternar-figurinhas": {
        const painel = alvo.parentElement.querySelector("[data-wpp-figurinhas-painel]");
        painel.hidden = !painel.hidden;
        return;
      }
      case "adicionar-emoji": {
        const emoji = prompt("Cole aqui o emoji que quer adicionar à lista da empresa:");
        if (!emoji || !emoji.trim()) return;
        await chamarApi("/whatsapp/emojis", { method: "POST", body: { emoji: emoji.trim() } });
        state._emojisCache = null; // força buscar de novo com o novo item
        definirFlash("ok", "Emoji adicionado à lista da empresa.");
        return montarRota();
      }
      case "salvar-figurinha": {
        await chamarApi("/whatsapp/figurinhas", { method: "POST", body: { midia_url: alvo.dataset.url } });
        state._figurinhasCache = null;
        definirFlash("ok", "Figurinha guardada — já dá pra usar em qualquer conversa.");
        return montarRota();
      }
      case "enviar-figurinha": {
        const conversaId = Number(alvo.dataset.conversaId);
        const resp = await chamarApi(`/whatsapp/conversas/${conversaId}/figurinha`, {
          method: "POST", body: { figurinha_id: Number(alvo.dataset.id) },
        });
        if (!resp.ok) definirFlash("erro", "Figurinha registrada, mas o envio falhou: " + (resp.aviso || ""));
        return renderWhatsapp(conversaId);
      }
      case "excluir-figurinha": {
        if (!confirm("Tirar esta figurinha do banco da empresa? As mensagens já enviadas com ela não mudam.")) return;
        await chamarApi(`/whatsapp/figurinhas/${alvo.dataset.id}`, { method: "DELETE" });
        state._figurinhasCache = null;
        definirFlash("ok", "Figurinha removida do banco.");
        return montarRota();
      }
      case "alternar-emoji": {
        const painel = alvo.parentElement.querySelector("[data-wpp-emoji-painel]");
        painel.hidden = !painel.hidden;
        return;
      }
      case "alternar-busca-mensagens": {
        const barra = document.querySelector("[data-wpp-busca-mensagens]");
        if (!barra) return;
        barra.hidden = !barra.hidden;
        if (barra.hidden) {
          _limparBuscaMensagens();
        } else {
          barra.querySelector("[data-wpp-busca-mensagens-input]").focus();
        }
        return;
      }
      case "fechar-busca-mensagens": {
        const barra = document.querySelector("[data-wpp-busca-mensagens]");
        if (barra) barra.hidden = true;
        _limparBuscaMensagens();
        return;
      }
      case "busca-mensagens-proxima": _irParaResultadoBusca(1); return;
      case "busca-mensagens-anterior": _irParaResultadoBusca(-1); return;
      case "ligar-interno": return _ligarChamada(Number(alvo.dataset.id), alvo.dataset.nome);
      case "abrir-catalogo-item": return modalCatalogoItem(alvo.dataset.id ? Number(alvo.dataset.id) : null);
      case "adicionar-linha-faixa": {
        const lista = alvo.closest("form").querySelector("[data-lista-faixas]");
        lista.insertAdjacentHTML("beforeend", _htmlLinhaFaixa(null));
        return;
      }
      case "remover-linha-faixa": {
        const linha = alvo.closest("[data-faixa-linha]");
        const lista = alvo.closest("[data-lista-faixas]");
        if (lista.querySelectorAll("[data-faixa-linha]").length > 1) linha.remove();
        else definirFlash("erro", "Precisa de pelo menos uma faixa.");
        return;
      }
      case "adicionar-linha-nutriente": {
        const lista = alvo.closest("form").querySelector("[data-lista-nutrientes]");
        lista.insertAdjacentHTML("beforeend", _htmlLinhaNutriente(null));
        return;
      }
      case "remover-linha-nutriente": {
        alvo.closest("[data-nutriente-linha]").remove();
        return;
      }
      case "excluir-catalogo-item": {
        if (!confirm(`Desativar "${alvo.dataset.nome}"? Ele some da lista mas não quebra propostas antigas.`)) return;
        await chamarApi(`/whatsapp/catalogo/${alvo.dataset.id}`, { method: "DELETE" });
        definirFlash("ok", "Item desativado.");
        return renderCatalogo();
      }
      case "inserir-emoji": {
        const textarea = document.querySelector(".wpp-textarea");
        const inicio = textarea.selectionStart || textarea.value.length;
        const fim = textarea.selectionEnd || textarea.value.length;
        textarea.value = textarea.value.slice(0, inicio) + alvo.dataset.emoji + textarea.value.slice(fim);
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = inicio + alvo.dataset.emoji.length;
        alvo.closest("[data-wpp-emoji-painel]").hidden = true;
        return;
      }
      case "alternar-catalogo-ativo": {
        await chamarApi(`/whatsapp/catalogos/${alvo.dataset.id}`, {
          method: "PUT", body: { ativo: alvo.dataset.ativo !== "1" },
        });
        obterCatalogos("limpar");
        return renderWhatsappConfiguracao();
      }
      case "excluir-catalogo": {
        if (!confirm(`Excluir o catálogo "${alvo.dataset.nome}"? A equipe deixa de poder mandá-lo.`)) return;
        await chamarApi(`/whatsapp/catalogos/${alvo.dataset.id}`, { method: "DELETE" });
        obterCatalogos("limpar");
        definirFlash("ok", "Catálogo excluído.");
        return renderWhatsappConfiguracao();
      }
      case "ausencia-de-usuario": {
        const id = Number(alvo.dataset.id);
        const estaAusente = alvo.dataset.ausente === "1";
        let motivo = null;
        if (!estaAusente) {
          motivo = prompt(`Marcar ${alvo.dataset.nome} como ausente. Motivo (opcional):`, "");
          if (motivo === null) return;   // cancelou
        }
        await chamarApi(`/usuarios/${id}/ausente`, {
          method: "PUT", body: { ausente: !estaAusente, motivo: (motivo || "").trim() },
        });
        definirFlash("ok", estaAusente
          ? `${alvo.dataset.nome} voltou a aparecer como disponível.`
          : `${alvo.dataset.nome} está marcado como ausente.`);
        return renderUsuarios();
      }
      case "adicionar-ao-grupo": {
        const id = Number(alvo.dataset.id);
        const wrap = abrirModal(`
          <h3 style="margin-top:0;">➕ Adicionar ao grupo</h3>
          <p class="dica">A pessoa entra no grupo <strong>no WhatsApp</strong> — todo mundo lá dentro vê que ela entrou. Escolha um contato ou digite um número novo.</p>
          <div class="campo">
            <input data-busca-add placeholder="Procurar por nome ou número…" autofocus>
          </div>
          <div class="wpp-encaminhar-lista" data-lista-add><p class="dica">Carregando…</p></div>
          <p class="dica" data-resumo-add></p>
          <div class="rodape-modal">
            <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
            <button type="button" class="botao" data-add-ao-grupo disabled>Adicionar</button>
          </div>`);
        const lista = wrap.querySelector("[data-lista-add]");
        const botao = wrap.querySelector("[data-add-ao-grupo]");
        const resumo = wrap.querySelector("[data-resumo-add]");
        const busca = wrap.querySelector("[data-busca-add]");
        const escolhidos = new Set();

        const atualizar = () => {
          botao.disabled = escolhidos.size === 0;
          botao.textContent = escolhidos.size ? `Adicionar ${escolhidos.size}` : "Adicionar";
          resumo.textContent = escolhidos.size ? `Selecionado: ${[...escolhidos].join(", ")}` : "";
        };
        const desenhar = (contatos) => {
          const digitado = busca.value.replace(/\D/g, "");
          // Número que não está na agenda também pode entrar — é comum
          // o cliente passar um contato novo pra incluir no grupo.
          const avulso = digitado.length >= 10 && !contatos.some((c) => (c.telefone || "").includes(digitado))
            ? [{ nome: `Adicionar o número ${_telefoneBonito(digitado)}`, telefone: digitado, avulso: true }]
            : [];
          const tudo = [...avulso, ...contatos.filter((c) => !c.eh_grupo)];
          lista.innerHTML = tudo.length ? tudo.map((c) => `
            <label class="wpp-encaminhar-item">
              <input type="checkbox" data-telefone="${escapeHtml(c.telefone)}" ${escolhidos.has(c.telefone) ? "checked" : ""}>
              <span class="wpp-encaminhar-nome">${escapeHtml(c.nome || c.telefone)}</span>
              <span class="wpp-encaminhar-tel">${c.avulso ? "" : escapeHtml(_telefoneBonito(c.telefone))}</span>
            </label>`).join("") : `<p class="dica">Nenhum contato encontrado. Digite o número completo com DDD.</p>`;
          lista.querySelectorAll("input[type=checkbox]").forEach((cx) => {
            cx.addEventListener("change", () => {
              if (cx.checked) escolhidos.add(cx.dataset.telefone);
              else escolhidos.delete(cx.dataset.telefone);
              atualizar();
            });
          });
        };
        const buscar = async (termo) => {
          try { desenhar((await chamarApi(`/whatsapp/contatos?q=${encodeURIComponent(termo || "")}`) || []).slice(0, 60)); }
          catch (e) { lista.innerHTML = `<p class="dica">Não consegui carregar os contatos.</p>`; }
        };
        buscar("");
        let debounce = null;
        busca.addEventListener("input", () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => buscar(busca.value.trim()), 250);
        });

        botao.addEventListener("click", async () => {
          botao.disabled = true;
          botao.textContent = "Adicionando…";
          try {
            const r = await chamarApi(`/whatsapp/grupos/${id}/participantes`, {
              method: "POST", body: { telefones: [...escolhidos] },
            });
            const recusados = (r.resultados || []).filter((x) => !x.entrou);
            if (!recusados.length) {
              fecharModais();
              definirFlash("ok", `${r.adicionados} pessoa(s) entrou(entraram) no grupo.`);
              return renderWhatsapp(id);
            }
            // Alguém não entrou: mostra QUEM e POR QUÊ, e entrega o link
            // de convite quando é o caso de a pessoa ter que entrar
            // sozinha. Fechar a janela aqui esconderia a informação.
            fecharModais();
            abrirModal(`
              <h3 style="margin-top:0;">Nem todo mundo entrou</h3>
              ${r.adicionados ? `<p class="dica">${r.adicionados} pessoa(s) entrou(entraram) normalmente.</p>` : ""}
              <div class="wpp-encaminhar-lista">
                ${recusados.map((x) => `
                  <div class="wpp-encaminhar-item" style="display:block;">
                    <strong>${escapeHtml(_telefoneBonito(x.telefone))}</strong>
                    <div class="texto-suave" style="font-size:12.5px;">${escapeHtml(x.motivo || "")}</div>
                  </div>`).join("")}
              </div>
              ${r.link_convite ? `
                <div class="campo" style="margin-top:12px;">
                  <label class="rotulo-forte">Link de convite do grupo</label>
                  <input value="${escapeHtml(r.link_convite)}" readonly onclick="this.select()">
                  <span class="dica">Mande este link pra pessoa — ela entra sozinha, sem precisar de permissão.</span>
                </div>` : ""}
              <div class="rodape-modal">
                <button type="button" class="botao" data-acao="fechar-modal">Entendi</button>
              </div>`);
          } catch (e) {
            definirFlash("erro", e.message || "Não consegui adicionar. Só quem é administrador do grupo no WhatsApp pode incluir gente.");
            fecharModais();
          }
          return renderWhatsapp(id);
        });
        return;
      }
      case "ver-membros-whatsapp": {
        const id = Number(alvo.dataset.id);
        const wrap = abrirModal(`
          <h3 style="margin-top:0;">👤 Quem está neste grupo</h3>
          <div class="wpp-encaminhar-lista" data-lista-membros><p class="dica">Carregando…</p></div>
          <div class="rodape-modal">
            <button type="button" class="botao secundario" data-acao="fechar-modal">Fechar</button>
            <button type="button" class="botao secundario" data-atualizar-membros>🔄 Buscar de novo</button>
          </div>`);
        const desenhar = (membros) => {
          const lista = wrap.querySelector("[data-lista-membros]");
          lista.innerHTML = membros.length ? membros.map((m) => `
            <div class="wpp-encaminhar-item">
              <span class="wpp-encaminhar-nome">${escapeHtml(m.nome || m.telefone || "sem nome")}${m.admin ? ` <span class="selo">${m.admin === "superadmin" ? "criador" : "admin"}</span>` : ""}</span>
              <span class="wpp-encaminhar-tel">${escapeHtml(m.telefone || "")}</span>
            </div>`).join("")
            : `<p class="dica">Não consegui listar agora. Isso acontece quando o WhatsApp está desconectado.</p>`;
        };
        const buscar = async (forcar) => {
          try { desenhar(await chamarApi(`/whatsapp/conversas/${id}/membros${forcar ? "?atualizar=1" : ""}`)); }
          catch (e) { wrap.querySelector("[data-lista-membros]").innerHTML = `<p class="dica">${escapeHtml(e.message || "Não consegui carregar.")}</p>`; }
        };
        buscar(false);
        wrap.querySelector("[data-atualizar-membros]").addEventListener("click", () => buscar(true));
        return;
      }
      case "abrir-membros-grupo": {
        const id = Number(alvo.dataset.id);
        const [participantes, usuarios] = await Promise.all([
          chamarApi(`/whatsapp/conversas/${id}/participantes`),
          chamarApi("/usuarios"),
        ]);
        const dentro = new Set(participantes.map((p) => p.id));
        const fora = usuarios.filter((u) => u.ativo && u.acesso_conversas !== false && !dentro.has(u.id));
        const wrap = abrirModal(`
          <h3 style="margin-top:0;">👥 Chamar alguém pro grupo</h3>
          <p class="dica">Quem entrar passa a ver e escrever neste grupo. Quem está de fora não vê nada dele.</p>
          <div class="wpp-encaminhar-lista">
            ${fora.length ? fora.map((u) => `
              <label class="wpp-encaminhar-item">
                <input type="checkbox" data-usuario="${u.id}">
                <span class="wpp-encaminhar-nome">${u.online ? "🟢" : "🔴"} ${escapeHtml(u.nome)}</span>
                <span class="wpp-encaminhar-tel">${escapeHtml(_setoresDoColega(u).join(", ") || "")}</span>
              </label>`).join("") : `<p class="dica">Todo mundo já está no grupo.</p>`}
          </div>
          <div class="rodape-modal">
            <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
            <button type="button" class="botao" data-add-membros>Chamar</button>
          </div>`);
        wrap.querySelector("[data-add-membros]").addEventListener("click", async (ev) => {
          const escolhidos = [...wrap.querySelectorAll("input:checked")].map((c) => Number(c.dataset.usuario));
          if (!escolhidos.length) { definirFlash("erro", "Marque quem você quer chamar."); return; }
          ev.currentTarget.disabled = true;
          try {
            const r = await chamarApi(`/whatsapp/conversas/${id}/participantes`, { method: "POST", body: { usuarios: escolhidos } });
            fecharModais();
            definirFlash("ok", `${(r.entraram || []).join(", ")} agora participa deste grupo.`);
          } catch (e) {
            definirFlash("erro", e.message || "Não consegui chamar.");
          }
          return renderWhatsapp(id);
        });
        return;
      }
      case "tirar-do-grupo": {
        const id = Number(alvo.dataset.id);
        const uid = Number(alvo.dataset.usuario);
        if (!confirm("Tirar esta pessoa do grupo? Ela deixa de ver a conversa.")) return;
        await chamarApi(`/whatsapp/conversas/${id}/participantes/${uid}`, { method: "DELETE" });
        definirFlash("ok", "Pronto.");
        return renderWhatsapp(id);
      }
      case "alternar-catalogos-interno": {
        const painel = alvo.parentElement.querySelector("[data-wpp-catalogos-painel]");
        if (!painel.hidden) { painel.hidden = true; return; }
        painel.hidden = false;
        painel.innerHTML = `<p class="dica" style="padding:10px;">Carregando…</p>`;
        const catalogos = await obterCatalogos(true);
        painel.innerHTML = catalogos.length
          ? catalogos.map((c) => `
              <button type="button" class="wpp-resposta-item" data-acao="enviar-catalogo-interno" data-id="${c.id}" data-conversa="${alvo.dataset.id}">
                <strong>${c.tipo === "pdf" ? "📄" : "🌐"} ${escapeHtml(c.nome)}</strong>
                ${c.descricao ? `<span class="texto-suave">${escapeHtml(c.descricao)}</span>` : ""}
              </button>`).join("")
          : `<p class="dica" style="padding:10px;">Nenhum catálogo liberado pra você.</p>`;
        return;
      }
      case "enviar-catalogo-interno": {
        const conversaId = Number(alvo.dataset.conversa);
        const painel = alvo.closest("[data-wpp-catalogos-painel]");
        if (painel) painel.hidden = true;
        try {
          const r = await chamarApi(`/chat-interno/conversas/${conversaId}/catalogo/${Number(alvo.dataset.id)}`, { method: "POST" });
          definirFlash("ok", `${r.nome} enviado.`);
        } catch (erro) {
          definirFlash("erro", erro.message || "Não consegui enviar o catálogo.");
        }
        return renderChatInterno(conversaId);
      }
      case "alternar-catalogos": {
        const painel = alvo.parentElement.querySelector("[data-wpp-catalogos-painel]");
        if (!painel.hidden) { painel.hidden = true; return; }
        painel.hidden = false;
        painel.innerHTML = `<p class="dica" style="padding:10px;">Carregando…</p>`;
        const catalogos = await obterCatalogos(true);
        painel.innerHTML = catalogos.length
          ? catalogos.map((c) => `
              <button type="button" class="wpp-resposta-item" data-acao="enviar-catalogo" data-id="${c.id}" data-conversa="${alvo.dataset.id}">
                <strong>${c.tipo === "pdf" ? "📄" : "🌐"} ${escapeHtml(c.nome)}</strong>
                ${c.descricao ? `<span class="texto-suave">${escapeHtml(c.descricao)}</span>` : ""}
              </button>`).join("")
          : `<p class="dica" style="padding:10px;">Nenhum catálogo liberado pra você. Um administrador cadastra em Configuração.</p>`;
        return;
      }
      case "enviar-catalogo": {
        const conversaId = Number(alvo.dataset.conversa);
        const catalogoId = Number(alvo.dataset.id);
        const painel = alvo.closest("[data-wpp-catalogos-painel]");
        if (painel) painel.hidden = true;
        try {
          const r = await chamarApi(`/whatsapp/conversas/${conversaId}/catalogo/${catalogoId}`, { method: "POST" });
          definirFlash("ok", `${r.nome} enviado.`);
        } catch (erro) {
          definirFlash("erro", erro.message || "Não consegui enviar o catálogo.");
        }
        return renderWhatsapp(conversaId);
      }
      case "alternar-respostas-prontas": {
        const painel = alvo.parentElement.querySelector("[data-wpp-respostas-painel]");
        painel.hidden = !painel.hidden;
        return;
      }
      case "inserir-resposta-pronta": {
        const resposta = (state._respostasProntasCache || []).find((r) => r.id === Number(alvo.dataset.id));
        if (!resposta) return;
        const textarea = document.querySelector(".wpp-textarea");
        textarea.value = resposta.texto;
        textarea.focus();
        alvo.closest("[data-wpp-respostas-painel]").hidden = true;
        return;
      }
      case "abrir-gerenciar-respostas": {
        const respostas = await obterRespostasProntas();
        modalGerenciarRespostas(respostas);
        return;
      }
      case "excluir-resposta-pronta": {
        if (!confirm("Excluir esta resposta pronta?")) return;
        await chamarApi(`/whatsapp/respostas-prontas/${alvo.dataset.id}`, { method: "DELETE" });
        state._respostasProntasCache = null;
        modalGerenciarRespostas(await obterRespostasProntas());
        return;
      }
      case "abrir-agendar": modalAgendar(Number(alvo.dataset.id)); return;
      case "cancelar-agendada": {
        if (!confirm("Cancelar este envio agendado?")) return;
        await chamarApi(`/whatsapp/agendadas/${alvo.dataset.id}`, { method: "DELETE" });
        definirFlash("ok", "Agendamento cancelado.");
        return renderWhatsapp(Number(location.hash.split("/")[2]));
      }
      case "excluir-mensagem": {
        if (!confirm("Excluir esta mensagem? Ela some da conversa aqui, e o sistema tenta apagar do WhatsApp também (só funciona se ainda estiver dentro da janela de tempo que o próprio WhatsApp permite).")) return;
        const conversaId = Number(location.hash.split("/")[2]);
        const resp = await chamarApi(`/whatsapp/conversas/${conversaId}/mensagens/${alvo.dataset.id}`, { method: "DELETE" });
        definirFlash("ok", resp.apagada_no_whatsapp ? "Mensagem excluída (também apagada no WhatsApp)." : "Mensagem excluída aqui — pode ainda estar visível pro cliente, se já passou da janela de exclusão do WhatsApp.");
        return renderWhatsapp(conversaId);
      }
      case "reenviar-mensagem": {
        const conversaId = Number(location.hash.split("/")[2]);
        alvo.disabled = true;
        try {
          await chamarApi(`/whatsapp/conversas/${conversaId}/mensagens/${alvo.dataset.id}/reenviar`, { method: "POST" });
          definirFlash("ok", "Mensagem reenviada.");
        } catch (e) {
          definirFlash("erro", "Reenvio falhou: " + e.message);
        }
        return renderWhatsapp(conversaId);
      }
      case "arquivar-conversa":
      case "desarquivar-conversa": {
        const id = Number(alvo.dataset.id);
        fecharMenuContexto();
        await chamarApi(`/whatsapp/conversas/${id}/arquivar`, { method: "POST", body: { arquivar: acao === "arquivar-conversa" } });
        definirFlash("ok", acao === "arquivar-conversa" ? "Conversa arquivada." : "Conversa desarquivada.");
        return renderWhatsapp(null);
      }
      case "excluir-conversa": {
        fecharMenuContexto();
        if (!confirm("Excluir esta conversa? Ela some de todas as listas do sistema (não é possível desfazer por aqui).")) return;
        const id = Number(alvo.dataset.id);
        await chamarApi(`/whatsapp/conversas/${id}`, { method: "DELETE" });
        definirFlash("ok", "Conversa excluída.");
        return renderWhatsapp(null);
      }
      case "contexto-agendar": fecharMenuContexto(); modalAgendar(Number(alvo.dataset.id)); return;
      case "contexto-lembrete": fecharMenuContexto(); modalLembrete(Number(alvo.dataset.id)); return;
      case "abrir-resumo": {
        modalResumo(Number(alvo.dataset.id), alvo.dataset.resumo);
        return;
      }
      case "abrir-tags-conversa":
      case "abrir-tags-interna": {
        const conversaId = Number(alvo.dataset.id);
        const marcadas = JSON.parse(alvo.dataset.tags || "[]");
        const todasTags = await obterEtiquetas(true);
        modalTags(conversaId, todasTags, marcadas, acao === "abrir-tags-interna");
        return;
      }
      case "criar-tag-inline": {
        const form = alvo.closest("form");
        const nomeInput = form.querySelector('[name="nova_tag_nome"]');
        const nome = nomeInput.value.trim();
        if (!nome) return;
        const cor = form.querySelector('[name="nova_tag_cor"]').value;
        const nova = await chamarApi("/whatsapp/tags", { method: "POST", body: { nome, cor } });
        state._tagsCache = null;
        const marcadas = [...form.querySelectorAll('input[name="tag_ids"]:checked')].map((i) => Number(i.value));
        marcadas.push(nova.id);
        const conversaId = Number(form.dataset.conversaId);
        const interna = form.dataset.interna === "1";
        const todasTags = await chamarApi("/whatsapp/tags");
        fecharModais();
        modalTags(conversaId, todasTags, marcadas);
        return;
      }
      case "abrir-lembrete": modalLembrete(Number(alvo.dataset.id)); return;
      case "concluir-lembrete": {
        await chamarApi(`/whatsapp/lembretes/${alvo.dataset.id}/concluir`, { method: "POST" });
        definirFlash("ok", "Lembrete concluído.");
        return renderLembretes();
      }
      case "novo-qrcode": {
        // Pega o código mais recente que a Evolution já gerou (ela troca
        // sozinha o tempo todo) e recomeça a contagem. Sem pedir um
        // "conectar" novo, que reiniciaria a sessão à toa.
        const botao = alvo;
        botao.disabled = true;
        botao.textContent = "Gerando…";
        try {
          // Pede um código NOVO à Evolution. Só ler o último guardado não
          // servia: com a sessão parada não existe nenhum guardado, e o
          // botão não fazia nada.
          const r = await chamarApi("/whatsapp/conectar", { method: "POST" });
          const area = document.querySelector("[data-wpp-qr-area]");
          const img = area && area.querySelector(".wpp-qrcode");
          if (r.qrcode_base64 && img) {
            img.src = `data:image/png;base64,${r.qrcode_base64}`;
            _qrNaTela = img.src.slice(-60);
            _qrMostradoEm = Date.now();
            _contarValidadeQr();
            botao.disabled = false;
            botao.textContent = "Gerar um novo";
            return;
          }
          // Sem área na tela ainda (ex.: veio da faixa vermelha): monta a
          // seção inteira, que já desenha o código.
          return renderWhatsappConfiguracao();
        } catch (e) {
          botao.disabled = false;
          botao.textContent = "Gerar um novo";
          definirFlash("erro", e.message || "Não consegui gerar um código novo.");
        }
        return;
      }
      case "conectar-whatsapp": {
        await chamarApi("/whatsapp/conectar", { method: "POST" });
        return renderWhatsappConfiguracao();
      }
      case "renomear-contato": {
        modalRenomearContato(Number(alvo.dataset.contatoId), alvo.dataset.nome);
        return;
      }
      case "resetar-dashboard": {
        if (!confirm("Zerar os contadores do Dashboard? As conversas e mensagens continuam salvas normalmente — só os números voltam a contar a partir de agora.")) return;
        await chamarApi("/whatsapp/dashboard/resetar", { method: "POST" });
        definirFlash("ok", "Dashboard resetado.");
        return renderDashboard();
      }
      case "abrir-seletor-foto-usuario": {
        const entrada = document.querySelector("[data-wpp-foto-usuario]");
        entrada.dataset.alvoId = alvo.dataset.id; // guarda de quem e a foto ate o arquivo ser escolhido
        entrada.click();
        return;
      }
      case "enviar-foto-usuario": {
        const arquivo = alvo.files[0];
        if (!arquivo) return;
        const alvoId = alvo.dataset.alvoId;
        const fd = new FormData();
        fd.append("foto", arquivo);
        await fetch(`${API}/usuarios/${alvoId}/foto`, {
          method: "POST",
          headers: { Authorization: "Bearer " + state.accessToken },
          body: fd,
        }).then(async (x) => {
          if (!x.ok) { const c = await x.json().catch(() => ({})); throw new Error(c.mensagem || `Erro ${x.status}`); }
        });
        alvo.value = "";
        definirFlash("ok", "Foto atualizada.");
        return renderUsuarios();
      }
      case "remover-logo": {
        if (!confirm("Voltar pra logo padrão do sistema?")) return;
        await chamarApi("/whatsapp/configuracao/logo", { method: "DELETE" });
        state.logoUrl = null;
        definirFlash("ok", "Logo removida.");
        return renderWhatsappConfiguracao();
      }
      case "fazer-backup-agora": {
        await chamarApi("/sistema/backups", { method: "POST" });
        definirFlash("ok", "Backup criado.");
        return renderWhatsappConfiguracao();
      }
      case "baixar-backup": {
        const nome = alvo.dataset.nome;
        const resp = await fetch(`${API}/sistema/backups/${encodeURIComponent(nome)}/download`, {
          headers: { Authorization: "Bearer " + state.accessToken },
        });
        if (!resp.ok) { definirFlash("erro", "Não foi possível baixar o backup."); return; }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `whatts-backup-${nome}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return;
      }
      case "restaurar-backup": {
        const nome = alvo.dataset.nome;
        if (!confirm(`Restaurar o backup de ${fmtNomeBackup(nome)}? Isso substitui TODOS os dados atuais (conversas, contatos, tudo) pelo estado salvo nesse backup. Um backup de segurança do estado atual é feito automaticamente antes, mas essa ação ainda assim desfaz o que mudou depois dessa data. Confirma?`)) return;
        await chamarApi(`/sistema/backups/${encodeURIComponent(nome)}/restaurar`, { method: "POST" });
        definirFlash("ok", "Backup restaurado.");
        return renderWhatsappConfiguracao();
      }
      case "abrir-apelido-interno": {
        modalApelidoInterno(Number(alvo.dataset.conversaId), alvo.dataset.apelido);
        return;
      }
      case "abrir-conectar-numero": {
        modalConectarPorNumero();
        return;
      }
      case "desconectar-whatsapp": {
        modalDesconectarWhatsapp();
        return;
      }
      case "abrir-desconectar-numero-diferente": {
        modalDesconectarNumeroDiferente();
        return;
      }
      case "desconectar-whatsapp-confirmado": {
        const limpeza = alvo.dataset.limpeza;
        if (limpeza === "apagar" && !confirm("Tem certeza? Isso apaga PRA SEMPRE todas as conversas, mensagens e contatos de clientes. Não tem como desfazer.")) return;
        fecharModais();
        await chamarApi("/whatsapp/desconectar", { method: "POST", body: { limpeza } });
        definirFlash("ok",
          limpeza === "apagar" ? "WhatsApp desconectado e todas as conversas de clientes foram apagadas."
          : limpeza === "ocultar" ? "WhatsApp desconectado e as conversas foram ocultadas (arquivadas) até o próximo número conectar."
          : "WhatsApp desconectado.");
        return renderWhatsappConfiguracao();
      }
      case "copiar-webhook-url": {
        const campo = alvo.closest(".wpp-webhook-url").querySelector("input");
        campo.select();
        try { await navigator.clipboard.writeText(campo.value); definirFlash("ok", "URL do webhook copiada."); }
        catch (e) { definirFlash("erro", "Não foi possível copiar automaticamente — selecione e copie manualmente (Ctrl+C)."); }
        return renderWhatsappConfiguracao();
      }
      case "novo-usuario": modalNovoUsuario(); return;
      case "inativar-usuario": {
        if (!confirm("Inativar este usuário? Ele não vai mais conseguir fazer login.")) return;
        await chamarApi(`/usuarios/${alvo.dataset.id}/inativar`, { method: "POST" });
        definirFlash("ok", "Usuário inativado.");
        return renderUsuarios();
      }
      case "reativar-usuario": {
        await chamarApi(`/usuarios/${alvo.dataset.id}/reativar`, { method: "POST" });
        definirFlash("ok", "Usuário reativado.");
        return renderUsuarios();
      }
      case "buscar-contatos-compartilhar": {
        const conversaId = Number(alvo.dataset.conversaId);
        const interna = alvo.dataset.interna === "1";
        const contatos = await chamarApi(`/whatsapp/contatos?q=${encodeURIComponent(alvo.value || "")}`).catch(() => []);
        const lista = document.querySelector("[data-wpp-contatos-compartilhar-lista]");
        if (lista) lista.innerHTML = htmlListaContatosCompartilhar(contatos, conversaId, interna);
        return;
      }
      case "filtrar-followup-usuario": {
        state.followupUsuario = alvo.value || null;
        return carregarPainelFollowup();
      }
      case "renomear-catalogo": {
        const nome = alvo.value.trim();
        if (!nome) return renderWhatsappConfiguracao();
        await chamarApi(`/whatsapp/catalogos/${alvo.dataset.id}`, { method: "PUT", body: { nome } });
        obterCatalogos("limpar");
        definirFlash("ok", "Nome atualizado.");
        return;
      }
      case "trocar-url-catalogo": {
        await chamarApi(`/whatsapp/catalogos/${alvo.dataset.id}`, { method: "PUT", body: { url: alvo.value.trim() } });
        obterCatalogos("limpar");
        definirFlash("ok", "Endereço atualizado.");
        return;
      }
      case "alternar-catalogo-restrito": {
        await chamarApi(`/whatsapp/catalogos/${alvo.dataset.id}`, { method: "PUT", body: { restrito: alvo.checked } });
        obterCatalogos("limpar");
        return renderWhatsappConfiguracao();
      }
      case "marcar-usuario-catalogo": {
        // Manda a seleção inteira: é o que o servidor grava, e evita
        // ficar somando e subtraindo pessoa por pessoa.
        const caixa = document.querySelector(`[data-quem="${alvo.dataset.id}"]`);
        const escolhidos = [...caixa.querySelectorAll("input:checked")].map((c) => Number(c.dataset.usuario));
        await chamarApi(`/whatsapp/catalogos/${alvo.dataset.id}`, { method: "PUT", body: { usuarios: escolhidos } });
        obterCatalogos("limpar");
        definirFlash("ok", "Quem pode mandar foi atualizado.");
        return;
      }
      case "renomear-setor": {
        const nome = alvo.value.trim();
        if (!nome) { definirFlash("erro", "O nome do setor não pode ficar em branco."); return renderWhatsappConfiguracao(); }
        await chamarApi(`/usuarios/setores/${alvo.dataset.setorId}`, { method: "PUT", body: { nome } });
        definirFlash("ok", "Setor renomeado.");
        return renderWhatsappConfiguracao();
      }
      case "excluir-setor": {
        if (!confirm(`Excluir o setor "${alvo.dataset.nome}"? Usuários e conversas que já usavam esse nome mantêm o nome antigo, mas ele some das opções de escolha.`)) return;
        await chamarApi(`/usuarios/setores/${alvo.dataset.id}`, { method: "DELETE" });
        definirFlash("ok", "Setor excluído.");
        return renderWhatsappConfiguracao();
      }
      case "abrir-horario-usuario": {
        modalHorarioUsuario(Number(alvo.dataset.id), alvo.dataset.nome, JSON.parse(alvo.dataset.horario || "[]"));
        return;
      }
      case "abrir-editar-usuario": {
        modalEditarUsuario(JSON.parse(alvo.dataset.usuario));
        return;
      }
    }
  }

  function _janelasDoFormulario(dados) {
    const janelas = [];
    for (const n of [1, 2]) {
      const inicio = dados.get(`janela${n}_inicio`), fim = dados.get(`janela${n}_fim`);
      if (inicio && fim) janelas.push({ inicio, fim });
    }
    return janelas;
  }

  function _finalizarLogin(resp, email, lembrar) {
    state.accessToken = resp.access_token;
    state.refreshToken = resp.refresh_token;
    localStorage.setItem("whatts_refresh_token", state.refreshToken);
    if (lembrar) localStorage.setItem("whatts_email_lembrado", email);
    else localStorage.removeItem("whatts_email_lembrado");
    state.usuarioAtual = resp.usuario;
    state._aguardando2fa = false;
    state._loginPendente = null;
    return navegarPara("#/whatsapp");
  }

  async function tratarFormulario(nomeForm, form) {
    const dados = new FormData(form);
    switch (nomeForm) {
      case "login": {
        const email = dados.get("email");
        const senha = dados.get("senha");
        // Sem isto o clique não mostrava nada enquanto esperava o
        // servidor — uma resposta um pouco mais lenta parecia "não fez
        // nada", e a pessoa clicava de novo (e de novo) achando que não
        // tinha funcionado, empilhando pedidos à toa.
        const botao = form.querySelector('button[type="submit"]');
        const rotuloOriginal = botao.textContent;
        botao.disabled = true;
        botao.textContent = "Entrando…";
        try {
          const resp = await chamarApi("/auth/login", { method: "POST", semAuth: true, body: { email, senha } });
          if (resp.requer_2fa) {
            state._aguardando2fa = true;
            state._loginPendente = { email, senha, lembrar: !!dados.get("lembrar") };
            return renderLogin();
          }
          return _finalizarLogin(resp, email, !!dados.get("lembrar"));
        } catch (erro) {
          botao.disabled = false;
          botao.textContent = rotuloOriginal;
          throw erro;
        }
      }
      case "login-2fa": {
        const { email, senha, lembrar } = state._loginPendente || {};
        const botao = form.querySelector('button[type="submit"]');
        const rotuloOriginal = botao.textContent;
        botao.disabled = true;
        botao.textContent = "Confirmando…";
        try {
          const resp = await chamarApi("/auth/login", {
            method: "POST", semAuth: true,
            body: { email, senha, codigo_2fa: dados.get("codigo_2fa") },
          });
          return _finalizarLogin(resp, email, lembrar);
        } catch (erro) {
          botao.disabled = false;
          botao.textContent = rotuloOriginal;
          throw erro;
        }
      }
      case "confirmar-2fa": {
        const resp = await chamarApi("/auth/2fa/confirmar", { method: "POST", body: { codigo: dados.get("codigo") } });
        document.querySelector(".pagina").innerHTML = `<h2>Segurança</h2>${htmlCodigosRecuperacao(resp.codigos_recuperacao)}`;
        return;
      }
      case "desativar-2fa": {
        await chamarApi("/auth/2fa/desativar", { method: "POST", body: { senha: dados.get("senha") } });
        definirFlash("ok", "Verificação em duas etapas desativada.");
        return renderSeguranca();
      }
      case "editar-meu-perfil": {
        const atualizado = await chamarApi("/usuarios/perfil", { method: "PUT", body: { nome: dados.get("nome") } });
        state.usuarioAtual = atualizado;
        definirFlash("ok", "Nome atualizado.");
        return renderSeguranca();
      }
      case "trocar-senha": {
        await chamarApi("/auth/senha", { method: "POST", body: { senha_atual: dados.get("senha_atual"), senha_nova: dados.get("senha_nova") } });
        limparSessao();
        definirFlash("ok", "Senha alterada. Faça login novamente com a nova senha.");
        return navegarPara("#/login");
      }
      case "buscar-conversas": {
        const q = (dados.get("q") || "").trim();
        state.buscaConversas = q.length >= 2 ? q : null;
        state.buscaData = (dados.get("data") || "").trim() || null;
        return renderWhatsapp(null);
      }
      case "buscar-contatos-modal": {
        const contatos = await chamarApi(`/whatsapp/contatos?q=${encodeURIComponent(dados.get("q") || "")}`);
        document.querySelector("[data-wpp-contatos-lista]").innerHTML = htmlListaContatosModal(contatos);
        return;
      }
      case "criar-contato": {
        await chamarApi("/whatsapp/contatos", { method: "POST", body: { telefone: dados.get("telefone"), nome: dados.get("nome") || "" } });
        definirFlash("ok", "Contato salvo.");
        fecharModais();
        return modalContatos();
      }
      case "enviar-logo": {
        const arquivo = form.querySelector('[name="logo"]').files[0];
        if (!arquivo) return;
        const fd = new FormData();
        fd.append("logo", arquivo);
        const botao = form.querySelector('button[type="submit"]');
        botao.disabled = true;
        try {
          const r = await fetch(`${API}/whatsapp/configuracao/logo`, {
            method: "POST",
            headers: { Authorization: "Bearer " + state.accessToken },
            body: fd,
          }).then(async (x) => {
            if (!x.ok) { const c = await x.json().catch(() => ({})); throw new Error(c.mensagem || `Erro ${x.status}`); }
            return x.json();
          });
          state.logoUrl = r.logo_url;
          definirFlash("ok", "Logo atualizada.");
          return renderWhatsappConfiguracao();
        } finally { botao.disabled = false; }
      }
      case "importar-backup": {
        const arquivo = form.querySelector('[name="arquivo"]').files[0];
        if (!arquivo) return;
        if (!confirm("Importar esse backup vai SUBSTITUIR todos os dados atuais pelo que estiver no arquivo. Um backup de segurança do estado atual é feito automaticamente antes. Confirma?")) return;
        const formData = new FormData();
        formData.append("arquivo", arquivo);
        const botao = form.querySelector('button[type="submit"]');
        botao.disabled = true;
        try {
          await fetch(`${API}/sistema/backups/importar`, {
            method: "POST",
            headers: { Authorization: "Bearer " + state.accessToken },
            body: formData,
          }).then(async (r) => {
            if (!r.ok) { const c = await r.json().catch(() => ({})); throw new Error(c.mensagem || `Erro ${r.status}`); }
            return r.json();
          });
          definirFlash("ok", "Backup importado e restaurado.");
          return renderWhatsappConfiguracao();
        } finally {
          botao.disabled = false;
        }
      }
      case "importar-contatos": {
        const arquivo = form.querySelector('[name="arquivo"]').files[0];
        if (!arquivo) return;
        const formData = new FormData();
        formData.append("arquivo", arquivo);
        const botao = form.querySelector('button[type="submit"]');
        botao.disabled = true;
        let resp;
        try {
          resp = await fetch(`${API}/whatsapp/contatos/importar`, {
            method: "POST",
            headers: { Authorization: "Bearer " + state.accessToken },
            body: formData,
          }).then(async (r) => {
            if (!r.ok) { const c = await r.json().catch(() => ({})); throw new Error(c.mensagem || `Erro ${r.status}`); }
            return r.json();
          });
        } finally {
          botao.disabled = false;
        }
        definirFlash("ok", `${resp.importados} contato(s) novo(s) importado(s)${resp.ja_existiam ? `, ${resp.ja_existiam} já existiam` : ""}${resp.invalidos ? `, ${resp.invalidos} inválido(s)` : ""}.`);
        fecharModais();
        return montarRota();
      }
      case "solicitar-troca-negociacao": {
        const conversaId = Number(form.dataset.conversaId);
        const negociacaoId = Number(form.dataset.negociacaoId);
        await chamarApi(`/whatsapp/conversas/${conversaId}/negociacoes/${negociacaoId}/solicitar-troca`, {
          method: "POST",
          body: { usuario_id_desejado: Number(dados.get("usuario_id_desejado")), admin_id: Number(dados.get("admin_id")) },
        });
        fecharModais();
        definirFlash("ok", "Pedido enviado — o admin recebeu uma mensagem no chat interno com o link pra revisar.");
        return;
      }
      case "salvar-edicao-etiqueta": {
        const nome = (dados.get("nome") || "").trim();
        const cor = dados.get("cor") || "";
        if (!nome) { definirFlash("erro", "Informe o nome da etiqueta."); return; }
        await chamarApi(`/whatsapp/tags/${form.dataset.id}`, { method: "PUT", body: { nome, cor } });
        state._tagsCache = null;
        fecharModais();
        definirFlash("ok", "Etiqueta atualizada em todas as conversas onde é usada.");
        return _redesenharCanal(form.dataset.interna === "1");
      }
      case "definir-tags-conversa": {
        const conversaId = Number(form.dataset.conversaId);
        const interna = form.dataset.interna === "1";
        const tagIds = dados.getAll("tag_ids").map(Number);
        await chamarApi(_urlTagsDaConversa(conversaId, interna), { method: "PUT", body: { tag_ids: tagIds } });
        fecharModais();
        definirFlash("ok", "Etiquetas atualizadas.");
        return interna ? renderChatInterno(conversaId) : renderWhatsapp(conversaId);
      }
      case "criar-nota": {
        const conversaId = Number(form.dataset.conversaId);
        await chamarApi(`/whatsapp/conversas/${conversaId}/notas`, { method: "POST", body: { texto: dados.get("texto") } });
        fecharModais();
        return renderWhatsapp(conversaId);
      }
      case "criar-resposta-pronta": {
        await chamarApi("/whatsapp/respostas-prontas", {
          method: "POST",
          body: { atalho: dados.get("atalho"), titulo: dados.get("titulo"), texto: dados.get("texto") },
        });
        state._respostasProntasCache = null;
        fecharModais();
        definirFlash("ok", "Resposta pronta criada.");
        return montarRota();
      }
      case "enviar-mensagem": {
        // Se está gravando, a seta encerra e manda o áudio — não o texto.
        if (_pararEEnviarAudio()) return;
        const texto = (dados.get("texto") || "").trim();
        if (!texto) return;
        const conversaId = Number(form.dataset.conversaId);
        const textarea = form.querySelector("textarea");
        // Limpa e devolve o foco JÁ — não espera a resposta do servidor
        // pra parecer instantâneo (a mensagem sempre fica registrada do
        // lado do servidor mesmo se o envio real ao WhatsApp falhar, ver
        // routes/whatsapp.py::enviar_mensagem).
        //
        // NÃO usa form.reset(): reset() volta pro valor "padrão" do
        // campo, que é o texto que estava escrito no HTML quando a tela
        // foi desenhada — e depois de restaurar um rascunho salvo, o
        // "padrão" passa a SER o rascunho. Resultado: mandava a
        // mensagem e ela reaparecia sozinha na caixa. Limpa o valor
        // direto.
        textarea.value = "";
        textarea.focus();
        _salvarRascunho("cliente", conversaId, "");
        const citada = state.citando && !state.citando.interna ? state.citando.id : null;
        state.citando = null;
        _desenharBarraCitacao();
        await chamarApi(`/whatsapp/conversas/${conversaId}/mensagens`, { method: "POST", body: { texto, responde_a: citada } });
        // Atualização leve — só a lista de mensagens e a prévia na lista
        // de conversas, sem reconstruir a tela inteira (cabeçalho,
        // respostas prontas, notas, agendadas...) que é o que deixava
        // lento.
        await Promise.all([atualizarMensagensNoDom(conversaId), atualizarListaConversasNoDom()]);
        // Quem ACABOU de mandar sempre vê a própria mensagem — mesmo se
        // tinha rolado pra cima lendo histórico antes de escrever. Isso
        // é diferente do polling normal, que respeita onde a pessoa
        // estava lendo quando é mensagem de OUTRA pessoa chegando.
        _rolarParaOFimAgora("[data-wpp-mensagens]");
        return;
      }
      case "iniciar-conversa-interna": {
        const participanteId = Number(dados.get("participante_id"));
        if (!participanteId) return;
        const conversa = await chamarApi("/chat-interno/conversas", { method: "POST", body: { participante_id: participanteId, texto: dados.get("texto") || undefined } });
        fecharModais();
        return navegarPara(`#/chat-interno/${conversa.id}`);
      }
      case "enviar-mensagem-interna": {
        // Se está gravando, a seta encerra e manda o áudio — não o texto.
        if (_pararEEnviarAudio()) return;
        const texto = (dados.get("texto") || "").trim();
        if (!texto) return;
        const conversaId = Number(form.dataset.conversaId);
        const textarea = form.querySelector("textarea");
        // Mesmo motivo do WhatsApp acima: NÃO usa form.reset() (volta
        // pro rascunho restaurado, não pro vazio).
        textarea.value = "";
        textarea.focus();
        _salvarRascunho("interna", conversaId, "");
        // Pega e já limpa a citação: se o envio falhar, a pessoa reescreve
        // e cita de novo — pior seria a citação ficar grudada e a próxima
        // mensagem sair respondendo algo que ela nem quis citar.
        const citada = state.citando && state.citando.interna ? state.citando.id : null;
        state.citando = null;
        _desenharBarraCitacao();
        await chamarApi(`/chat-interno/conversas/${conversaId}/mensagens`, { method: "POST", body: { texto, responde_a: citada } });
        await Promise.all([atualizarMensagensInternasNoDom(conversaId), atualizarListaConversasInternasNoDom()]);
        // Mesma regra do WhatsApp: quem manda sempre vê a própria
        // mensagem, mesmo tendo rolado pra cima antes de escrever.
        _rolarParaOFimAgora("[data-wpp-mensagens-interno]");
        return;
      }
      case "encaminhar-interno": {
        const conversaId = Number(form.dataset.conversaId);
        await chamarApi(`/chat-interno/conversas/${conversaId}/encaminhar`, { method: "POST", body: { participante_id: Number(dados.get("participante_id")) } });
        fecharModais();
        definirFlash("ok", "Conversa encaminhada.");
        return renderChatInterno(null);
      }
      case "conectar-whatsapp-numero": {
        const numero = (dados.get("numero") || "").trim();
        const botao = form.querySelector('button[type="submit"]');
        botao.disabled = true;
        try {
          const resp = await chamarApi("/whatsapp/conectar", { method: "POST", body: { numero } });
          fecharModais();
          if (resp.codigo_pareamento) {
            modalCodigoPareamento(resp.codigo_pareamento);
          } else {
            definirFlash("erro", "Não foi possível gerar o código. Confirme se o número já tem WhatsApp ativo em algum aparelho.");
          }
        } finally {
          botao.disabled = false;
        }
        return renderWhatsappConfiguracao();
      }
      case "salvar-resumo": {
        const conversaId = Number(form.dataset.conversaId);
        await chamarApi(`/whatsapp/conversas/${conversaId}/resumo`, { method: "PUT", body: { resumo: dados.get("resumo") || "" } });
        fecharModais();
        definirFlash("ok", "Resumo salvo.");
        return renderWhatsapp(conversaId);
      }
      case "agendar-mensagem": {
        const conversaId = Number(form.dataset.conversaId);
        const agendadoPara = new Date(dados.get("agendado_para")).toISOString();
        const arquivo = form.querySelector('[name="arquivo"]').files[0];
        const botao = form.querySelector('button[type="submit"]');
        botao.disabled = true;
        let agendada;
        try {
          if (arquivo) {
            if (arquivo.size > 90 * 1024 * 1024) { definirFlash("erro", "Arquivo maior que 90MB."); return; }
            const formData = new FormData();
            formData.append("texto", dados.get("texto"));
            formData.append("agendado_para", agendadoPara);
            formData.append("arquivo", arquivo);
            agendada = await fetch(`${API}/whatsapp/conversas/${conversaId}/agendar`, {
              method: "POST",
              headers: { Authorization: "Bearer " + state.accessToken },
              body: formData,
            }).then(async (r) => {
              if (!r.ok) { const c = await r.json().catch(() => ({})); throw new Error(c.mensagem || `Erro ${r.status}`); }
              return r.json();
            });
          } else {
            agendada = await chamarApi(`/whatsapp/conversas/${conversaId}/agendar`, { method: "POST", body: { texto: dados.get("texto"), agendado_para: agendadoPara } });
          }
        } finally {
          botao.disabled = false;
        }
        // Não fecha o modal — deixa agendar mais de uma mensagem (dias
        // diferentes, ou várias no mesmo dia) sem reabrir tudo de novo.
        const painel = document.querySelector("[data-wpp-agendadas-sessao]");
        if (painel) {
          painel.insertAdjacentHTML("afterbegin", `<div class="wpp-agendada-item" style="margin-bottom:8px;">✅ Agendado pra ${fmtData(agendada.agendado_para)}${agendada.midia_url ? " 📎" : ""} — ${escapeHtml((agendada.texto || "").slice(0, 60))}</div>`);
        }
        form.reset();
        form.querySelector('[name="texto"]').focus();
        renderWhatsapp(conversaId);
        return;
      }
      case "criar-lembrete": {
        const conversaId = Number(form.dataset.conversaId);
        const lembrarEm = new Date(dados.get("lembrar_em")).toISOString();
        await chamarApi(`/whatsapp/conversas/${conversaId}/lembretes`, { method: "POST", body: { texto: dados.get("texto") || undefined, lembrar_em: lembrarEm } });
        fecharModais();
        definirFlash("ok", "Lembrete criado.");
        return renderWhatsapp(conversaId);
      }
      case "salvar-configuracao": {
        await chamarApi("/whatsapp/configuracao", {
          method: "PUT",
          body: {
            ativo: !!dados.get("ativo"),
            evolution_url: dados.get("evolution_url") || undefined,
            instancia_nome: dados.get("instancia_nome") || undefined,
            evolution_apikey: dados.get("evolution_apikey") || undefined,
            webhook_base_url: dados.get("webhook_base_url") || "",
          },
        });
        definirFlash("ok", "Configuração salva.");
        return renderWhatsappConfiguracao();
      }
      case "salvar-localizacao": {
        await chamarApi("/whatsapp/configuracao", {
          method: "PUT",
          body: {
            localizacao_nome: dados.get("localizacao_nome") || "",
            localizacao_endereco: dados.get("localizacao_endereco") || "",
            localizacao_lat: dados.get("localizacao_lat") || "",
            localizacao_lng: dados.get("localizacao_lng") || "",
          },
        });
        definirFlash("ok", "Localização salva.");
        return renderWhatsappConfiguracao();
      }
      case "salvar-assinar-mensagens": {
        await chamarApi("/whatsapp/configuracao", { method: "PUT", body: { assinar_mensagens: form.querySelector('[name="assinar_mensagens"]').checked } });
        definirFlash("ok", "Preferência salva.");
        return renderWhatsappConfiguracao();
      }
      case "salvar-saudacao": {
        await chamarApi("/whatsapp/configuracao", { method: "PUT", body: { saudacao_mensagem: dados.get("saudacao_mensagem") || "" } });
        definirFlash("ok", "Mensagem de saudação salva.");
        return renderWhatsappConfiguracao();
      }
      case "renomear-contato": {
        const contatoId = Number(form.dataset.contatoId);
        await chamarApi(`/whatsapp/contatos/${contatoId}/apelido`, { method: "PUT", body: { apelido: dados.get("nome") || "" } });
        fecharModais();
        definirFlash("ok", dados.get("nome") ? "Nome salvo (só você vê)." : "Voltou ao nome de cadastro.");
        return renderWhatsapp(Number(location.hash.split("/")[2]) || null);
      }
      case "definir-apelido-interno": {
        const conversaId = Number(form.dataset.conversaId);
        await chamarApi(`/chat-interno/conversas/${conversaId}/apelido`, { method: "PUT", body: { apelido: dados.get("apelido") || "" } });
        fecharModais();
        definirFlash("ok", "Apelido salvo.");
        return renderChatInterno(conversaId);
      }
      case "lembrete-interno": {
        const conversaId = Number(form.dataset.conversaId);
        await chamarApi(`/chat-interno/conversas/${conversaId}/lembretes`, {
          method: "POST",
          body: { lembrar_em: new Date(dados.get("quando")).toISOString(), texto: dados.get("texto") || "" },
        });
        fecharModais();
        definirFlash("ok", "Lembrete criado — aparece em Lembretes.");
        return renderChatInterno(conversaId);
      }
      case "agendar-interno": {
        const conversaId = Number(form.dataset.conversaId);
        await chamarApi(`/chat-interno/conversas/${conversaId}/agendar`, {
          method: "POST",
          body: { agendado_para: new Date(dados.get("quando")).toISOString(), texto: dados.get("texto") },
        });
        fecharModais();
        definirFlash("ok", "Mensagem agendada — aparece em Agendamentos.");
        return renderChatInterno(conversaId);
      }
      case "agendar-contato": {
        const conversaId = Number(form.dataset.conversaId);
        const quando = `${dados.get("data")}T${dados.get("hora")}:00.000Z`;
        await chamarApi(`/followup/conversas/${conversaId}/agendar`, {
          method: "PUT",
          body: { quando, forma: dados.get("forma"), observacao: dados.get("observacao") || "" },
        });
        fecharModais();
        definirFlash("ok", "Próximo contato agendado.");
        atualizarContadorFollowup();
        carregarPainelFollowup();
        return;
      }
      case "criar-etiqueta": {
        const nome = (dados.get("nome") || "").trim();
        if (!nome) return;
        await chamarApi("/whatsapp/tags", { method: "POST", body: { nome, cor: dados.get("cor") } });
        state._tagsCache = null;
        definirFlash("ok", `Etiqueta "${nome}" criada.`);
        return renderWhatsappConfiguracao();
      }
      case "salvar-limites-envio": {
        await chamarApi("/whatsapp/configuracao", {
          method: "PUT",
          body: {
            limite_envios_minuto: dados.get("limite_envios_minuto"),
            limite_envios_hora: dados.get("limite_envios_hora"),
            limite_novos_contatos_hora: dados.get("limite_novos_contatos_hora"),
          },
        });
        definirFlash("ok", "Limites de envio salvos.");
        return renderWhatsappConfiguracao();
      }
      case "criar-catalogo": {
        await chamarApi("/whatsapp/catalogos", {
          method: "POST",
          body: { nome: dados.get("nome"), url: dados.get("url") },
        });
        obterCatalogos("limpar");
        definirFlash("ok", "Catálogo adicionado.");
        return renderWhatsappConfiguracao();
      }
      case "subir-catalogo-pdf": {
        const arquivo = form.querySelector('input[name="arquivo"]').files[0];
        if (!arquivo) { definirFlash("erro", "Escolha o arquivo."); return; }
        const fd = new FormData();
        fd.append("arquivo", arquivo);
        if (dados.get("nome")) fd.append("nome", dados.get("nome"));
        const resp = await fetch(`${API}/whatsapp/catalogos/pdf`, {
          method: "POST", headers: { Authorization: "Bearer " + state.accessToken }, body: fd,
        });
        if (!resp.ok) {
          const corpo = await resp.json().catch(() => ({}));
          definirFlash("erro", corpo.mensagem || "Não consegui enviar o arquivo.");
          return renderWhatsappConfiguracao();
        }
        obterCatalogos("limpar");
        definirFlash("ok", "Catálogo em PDF adicionado.");
        return renderWhatsappConfiguracao();
      }
      case "criar-setor": {
        await chamarApi("/usuarios/setores", { method: "POST", body: { nome: dados.get("nome") || "" } });
        definirFlash("ok", "Setor criado.");
        return renderWhatsappConfiguracao();
      }
      case "salvar-expediente": {
        await chamarApi("/whatsapp/configuracao", {
          method: "PUT",
          body: {
            expediente_ativo: !!dados.get("expediente_ativo"),
            expediente_janelas: _janelasDoFormulario(dados),
            expediente_mensagem: dados.get("expediente_mensagem") || "",
            sla_minutos_alerta: Number(dados.get("sla_minutos_alerta")) || 15,
          },
        });
        definirFlash("ok", "Horário de funcionamento salvo.");
        return renderWhatsappConfiguracao();
      }
      case "salvar-avisos-automaticos": {
        const valorFollowup = (dados.get("followup_dias_aviso_automatico") || "").trim();
        const valorUsuarioSistema = (dados.get("usuario_sistema_id") || "").trim();
        await chamarApi("/whatsapp/configuracao", {
          method: "PUT",
          body: {
            usuario_sistema_id: valorUsuarioSistema === "" ? null : Number(valorUsuarioSistema),
            followup_dias_aviso_automatico: valorFollowup === "" ? null : Number(valorFollowup),
            aviso_fila_sem_escolha_ativo: !!dados.get("aviso_fila_sem_escolha_ativo"),
            aviso_fila_sem_escolha_setores: dados.getAll("aviso_fila_sem_escolha_setores"),
            aviso_sla_ativo: !!dados.get("aviso_sla_ativo"),
            aviso_resumo_diario_ativo: !!dados.get("aviso_resumo_diario_ativo"),
            aviso_boasvindas_ativo: !!dados.get("aviso_boasvindas_ativo"),
            aviso_conversa_parada_ativo: !!dados.get("aviso_conversa_parada_ativo"),
            aviso_conversa_parada_horas: Number(dados.get("aviso_conversa_parada_horas")) || 24,
            aviso_conversa_parada_minutos_fechar: Number(dados.get("aviso_conversa_parada_minutos_fechar")) || 10,
            aviso_conversa_parada_max_prorrogacoes: Number(dados.get("aviso_conversa_parada_max_prorrogacoes") ?? 3),
            aviso_ligacoes_ativo: !!dados.get("aviso_ligacoes_ativo"),
            dias_prorrogar_ligacao: Number(dados.get("dias_prorrogar_ligacao")) || 3,
          },
        });
        definirFlash("ok", "Avisos automáticos salvos.");
        return renderWhatsappConfiguracao();
      }
      case "salvar-ia": {
        try {
          await chamarApi("/whatsapp/configuracao", {
            method: "PUT",
            body: {
              ia_ativa: !!dados.get("ia_ativa"),
              ia_api_key: dados.get("ia_api_key") || undefined,
              ia_openai_api_key: dados.get("ia_openai_api_key") || undefined,
            },
          });
        } catch (erro) {
          definirFlash("erro", erro.mensagem || "Não deu pra salvar.");
          return renderWhatsappConfiguracao();
        }
        definirFlash("ok", "Configuração do assistente de IA salva.");
        return renderWhatsappConfiguracao();
      }
      case "salvar-catalogo-config": {
        try {
          await chamarApi("/whatsapp/configuracao", {
            method: "PUT", body: { catalogo_proposta_ativo: !!dados.get("catalogo_proposta_ativo") },
          });
        } catch (erro) {
          definirFlash("erro", erro.mensagem || "Não deu pra salvar.");
          return renderWhatsappConfiguracao();
        }
        definirFlash("ok", "Configuração do catálogo salva.");
        return renderWhatsappConfiguracao();
      }
      case "salvar-catalogo-item": {
        const linhas = [...form.querySelectorAll("[data-faixa-linha]")];
        const faixas = linhas.map((linha) => ({
          quantidade_min: linha.querySelector("[data-faixa-min]").value,
          quantidade_max: linha.querySelector("[data-faixa-max]").value || null,
          preco: linha.querySelector("[data-faixa-preco]").value,
        })).filter((f) => f.quantidade_min !== "" && f.preco !== "");
        const linhasNutri = [...form.querySelectorAll("[data-nutriente-linha]")];
        const nutrientes = linhasNutri.map((linha) => ({
          nome: linha.querySelector("[data-nutriente-nome]").value,
          quantidade: linha.querySelector("[data-nutriente-qtd]").value,
          vd: linha.querySelector("[data-nutriente-vd]").value,
        })).filter((n) => n.nome.trim() !== "");
        const itemId = form.dataset.id;
        const corpo = {
          nome: dados.get("nome"), forma: dados.get("forma") || undefined, linha: dados.get("linha") || undefined,
          sabor: dados.get("sabor") || "", porcao: dados.get("porcao") || "",
          ingredientes: dados.get("ingredientes") || "", modo_de_uso: dados.get("modo_de_uso") || "",
          observacao_nutricional: dados.get("observacao_nutricional") || "",
          imagem_url: dados.get("imagem_url") || null, faixas, nutrientes,
        };
        try {
          await chamarApi(itemId ? `/whatsapp/catalogo/${itemId}` : "/whatsapp/catalogo", {
            method: itemId ? "PUT" : "POST", body: corpo,
          });
        } catch (erro) {
          definirFlash("erro", erro.mensagem || "Não deu pra salvar o item.");
          return;
        }
        fecharModais();
        definirFlash("ok", itemId ? "Item atualizado." : "Item cadastrado.");
        return renderCatalogo();
      }
      case "salvar-envio-massa": {
        await chamarApi("/whatsapp/configuracao", {
          method: "PUT",
          body: {
            envio_massa_ativo: !!dados.get("envio_massa_ativo"),
            envio_massa_intervalo_segundos: Number(dados.get("envio_massa_intervalo_segundos")) || 8,
          },
        });
        definirFlash("ok", "Configuração de envio em massa salva.");
        return renderWhatsappConfiguracao();
      }
      case "iniciar-conversa": {
        let resp;
        try {
          resp = await chamarApi("/whatsapp/conversas", {
            method: "POST",
            body: { telefone: dados.get("telefone"), nome: dados.get("nome") || undefined, texto: dados.get("texto") },
          });
        } catch (erro) {
          if (erro.codigo === "conversa_atribuida" || erro.codigo === "conversa_existente") {
            fecharModais();
            return modalConversaPresa(erro);
          }
          throw erro;
        }
        fecharModais();
        definirFlash(resp.envio_ok ? "ok" : "erro", resp.envio_ok ? "Conversa iniciada." : `Conversa criada, mas o envio falhou: ${resp.aviso}`);
        state.escopoConversas = "minhas";
        return navegarPara(`#/whatsapp/${resp.conversa_id}`);
      }
      case "encaminhar-conversa": {
        const conversaId = Number(form.dataset.conversaId);
        await chamarApi(`/whatsapp/conversas/${conversaId}/atribuir`, { method: "PUT", body: { usuario_id: Number(dados.get("usuario_id")) } });
        fecharModais();
        definirFlash("ok", "Conversa encaminhada.");
        return renderWhatsapp(null);
      }
      case "criar-usuario": {
        await chamarApi("/usuarios", {
          method: "POST",
          body: {
            nome: dados.get("nome"), email: dados.get("email"), senha: dados.get("senha"), admin: !!dados.get("admin"),
            super_admin: !!dados.get("super_admin"),
            setores: dados.getAll("setores"),
            acesso_conversas: !!dados.get("acesso_conversas"),
            horario_permitido: _janelasDoFormulario(dados),
          },
        });
        fecharModais();
        definirFlash("ok", "Usuário criado.");
        return renderUsuarios();
      }
      case "editar-usuario": {
        const id = Number(form.dataset.id);
        await chamarApi(`/usuarios/${id}`, {
          method: "PUT",
          body: {
            nome: dados.get("nome"), email: dados.get("email"), admin: !!dados.get("admin"),
            super_admin: !!dados.get("super_admin"),
            setores: dados.getAll("setores"),
            offline_forcado: !!dados.get("offline_forcado"),
            acesso_conversas: !!dados.get("acesso_conversas"),
          },
        });
        const senhaNova = dados.get("senha_nova");
        if (senhaNova) {
          await chamarApi(`/usuarios/${id}/senha`, { method: "PUT", body: { senha_nova: senhaNova } });
        }
        fecharModais();
        definirFlash("ok", senhaNova ? "Usuário atualizado e senha redefinida (ele foi deslogado de todos os aparelhos)." : "Usuário atualizado.");
        return renderUsuarios();
      }
      case "definir-horario-usuario": {
        const id = Number(form.dataset.id);
        await chamarApi(`/usuarios/${id}/horario`, { method: "PUT", body: { horario_permitido: _janelasDoFormulario(dados) } });
        fecharModais();
        definirFlash("ok", "Horário de login atualizado.");
        return renderUsuarios();
      }
    }
  }

  const flashPosReload = localStorage.getItem("whatts_flash_pos_reload");
  if (flashPosReload) {
    state.flash = { tipo: "ok", texto: flashPosReload };
    localStorage.removeItem("whatts_flash_pos_reload");
  }
  // App instalável no celular: o service worker é o que permite ao
  // Android/iPhone oferecer "instalar" e abrir sem barra do navegador.
  // Falhar aqui não pode derrubar nada — o sistema funciona igual no
  // navegador comum, instalar é só conveniência.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
  window.addEventListener("beforeinstallprompt", (evento) => {
    evento.preventDefault();
    state._promptInstalar = evento;
    state.podeInstalarApp = true;
    if (state.usuarioAtual) montarRota();
  });

  carregarLogo();
  montarRota();
})();
