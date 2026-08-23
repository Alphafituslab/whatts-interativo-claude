/*
 * Whatts Inbox — frontend em JavaScript puro (sem build step/CDN),
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
    filtroAtividadesUsuarioId: null,
    versaoServidor: null,
    buscaConversas: null,
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

  function fmtData(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
      return d.toLocaleString("pt-BR");
    } catch (e) { return iso; }
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

  function htmlAvatarContato(fotoUrl, nome, telefone, tamanho = 40) {
    const estilo = `width:${tamanho}px;height:${tamanho}px;font-size:${Math.round(tamanho * 0.35)}px;`;
    if (fotoUrl) return `<img class="wpp-avatar wpp-avatar-foto" style="${estilo}" src="${fotoUrl}" alt="" referrerpolicy="no-referrer">`;
    return `<div class="wpp-avatar" style="${estilo}background:${corAvatar(telefone)};">${escapeHtml(iniciaisContato(nome, telefone))}</div>`;
  }

  // ---------------------------------------------------------------------
  // Cliente da API
  // ---------------------------------------------------------------------
  async function chamarApi(caminho, { method = "GET", body, semAuth = false } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (!semAuth && state.accessToken) headers["Authorization"] = "Bearer " + state.accessToken;

    let resp = await fetch(API + caminho, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });

    if (resp.status === 401 && !semAuth && state.refreshToken) {
      const renovou = await tentarRenovarToken();
      if (renovou) {
        headers["Authorization"] = "Bearer " + state.accessToken;
        resp = await fetch(API + caminho, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      }
    }

    let dados = {};
    try { dados = await resp.json(); } catch (e) { /* corpo vazio, ok */ }

    if (!resp.ok) {
      if (resp.status === 401) { limparSessao(); navegarPara("#/login"); }
      const erro = new Error(dados.mensagem || `Erro ${resp.status} na requisição.`);
      erro.status = resp.status;
      erro.codigo = dados.erro;
      throw erro;
    }
    return dados;
  }

  async function tentarRenovarToken() {
    try {
      const resp = await fetch(API + "/auth/refresh", {
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
          case "whatsapp": return renderWhatsapp(param ? Number(param) : null);
          case "chat-interno": return renderChatInterno(param ? Number(param) : null);
          case "agendamentos": return renderAgendamentos();
          case "lembretes": return renderLembretes();
          case "dashboard": return renderDashboard();
          case "atividades": return renderAtividades();
          case "seguranca": return renderSeguranca();
          case "configuracao": return renderWhatsappConfiguracao();
          case "usuarios": return renderUsuarios();
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
    { rota: "#/whatsapp", chave: "whatsapp", label: "Conversas", icone: "💬" },
    { rota: "#/chat-interno", chave: "chat-interno", label: "Chat interno", icone: "🗨️" },
    { rota: "#/agendamentos", chave: "agendamentos", label: "Agendamentos", icone: "🕒" },
    { rota: "#/lembretes", chave: "lembretes", label: "Lembretes", icone: "🔔" },
    { rota: "#/dashboard", chave: "dashboard", label: "Dashboard", icone: "📊", admin: true },
    { rota: "#/atividades", chave: "atividades", label: "Atividades", icone: "📋", admin: true },
    { rota: "#/seguranca", chave: "seguranca", label: "Segurança", icone: "🔒" },
    { rota: "#/configuracao", chave: "configuracao", label: "Configuração", icone: "⚙️", admin: true },
    { rota: "#/usuarios", chave: "usuarios", label: "Usuários", icone: "👥", admin: true },
  ];

  function htmlAvatar(u, tamanho = 34) {
    const estilo = `width:${tamanho}px;height:${tamanho}px;font-size:${Math.round(tamanho * 0.35)}px;`;
    if (u && u.foto_perfil) return `<img class="wpp-avatar wpp-avatar-foto" style="${estilo}" src="${u.foto_perfil}" alt="">`;
    return `<div class="wpp-avatar" style="${estilo}background:${corAvatar(u ? u.email : "")};">${escapeHtml(iniciaisContato(u && u.nome))}</div>`;
  }

  function renderShell(conteudoHtml, paginaAtiva) {
    const usuario = state.usuarioAtual;
    const linksHtml = ITENS_MENU
      .filter((it) => !it.admin || (usuario && usuario.admin))
      .map((it) => {
        let extra = "";
        if (it.chave === "whatsapp") {
          extra = '<span class="wpp-badge-sla" data-wpp-sla-badge hidden></span><span class="wpp-badge-nao-lidas wpp-badge-nav" data-wpp-nao-lidas-badge hidden></span>';
        } else if (it.chave === "chat-interno") {
          extra = '<span class="wpp-badge-nao-lidas wpp-badge-nav" data-wpp-chat-interno-nao-lidas-badge hidden></span>';
        }
        return `<a class="link-nav ${it.chave === paginaAtiva ? "ativo" : ""}" href="${it.rota}"><span>${it.icone}</span> ${escapeHtml(it.label)}${extra}</a>`;
      })
      .join("");

    const flashHtml = state.flash
      ? `<p class="${state.flash.tipo === "erro" ? "mensagem-erro" : "mensagem-ok"}">${escapeHtml(state.flash.texto)}</p>`
      : "";

    app.innerHTML = `
      <div class="layout">
        <div class="fundo-menu-mobile" data-acao="alternar-menu-mobile"></div>
        <aside class="barra-lateral">
          <div class="marca"><span class="marca-icone">💬</span> Whatts Inbox</div>
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
                <div class="usuario-atual-nome">${escapeHtml(usuario ? usuario.nome : "")}</div>
                <div class="usuario-atual-email">${escapeHtml(usuario ? usuario.email : "")}</div>
              </div>
            </div>
            <div class="barra-acoes" style="margin-top:10px;">
              <button class="botao-icone" data-acao="alternar-tema" title="Alternar tema">🌓</button>
              <button class="botao secundario pequeno" data-acao="logout" style="margin-left:auto;">Sair</button>
            </div>
            <div class="wpp-versao-rodape" data-wpp-versao title="Versão do sistema — muda a cada atualização">${state.versaoServidor ? `v${state.versaoServidor.slice(0, 8)}` : ""}</div>
          </div>
        </aside>
        <div class="conteudo-principal">
          <div class="barra-superior-mobile">
            <button class="botao-icone botao-menu-mobile" data-acao="alternar-menu-mobile" title="Abrir menu">☰</button>
            <strong>💬 Whatts Inbox</strong>
          </div>
          <div class="pagina">${flashHtml}${conteudoHtml}</div>
        </div>
      </div>`;
    state.flash = null;
    atualizarBolinhaStatusGlobal(); // o DOM acabou de ser trocado inteiro — sem isso a bolinha mostraria "Verificando…" até o próximo tick do polling
  }

  function definirFlash(tipo, texto) { state.flash = { tipo, texto }; }

  document.addEventListener("click", async (e) => {
    const alvo = e.target.closest("[data-acao]");
    if (!alvo) return;
    e.preventDefault(); // nenhuma ação data-acao depende do comportamento nativo do navegador — inclusive quando o botão fica dentro de um <a> (ex.: "Assumir"/"Encaminhar" num item de lista clicável)
    try { await tratarAcao(alvo.dataset.acao, alvo, e); }
    catch (erro) { definirFlash("erro", erro.message || "Ocorreu um erro."); montarRota(); }
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

  // Enter envia a mensagem (padrão de todo chat); Shift+Enter quebra linha.
  // Cobre tanto o WhatsApp quanto o chat interno.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    const textarea = e.target.closest('form[data-form="enviar-mensagem"] textarea[name="texto"], form[data-form="enviar-mensagem-interna"] textarea[name="texto"]');
    if (!textarea) return;
    e.preventDefault();
    textarea.closest("form").requestSubmit();
  });

  function abrirModal(html) {
    const wrap = document.createElement("div");
    wrap.className = "fundo-modal";
    wrap.innerHTML = `<div class="modal">${html}</div>`;
    wrap.addEventListener("click", (e) => { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
    return wrap;
  }
  function fecharModais() { document.querySelectorAll(".fundo-modal").forEach((m) => m.remove()); }

  // Menu de contexto (botão direito) num item da lista de conversas —
  // atalho pra agendar/lembrar/arquivar/excluir sem abrir a conversa.
  function fecharMenuContexto() {
    const menu = document.querySelector(".wpp-menu-contexto");
    if (menu) menu.remove();
  }
  function abrirMenuContexto(x, y, itens) {
    fecharMenuContexto();
    const menu = document.createElement("div");
    menu.className = "wpp-menu-contexto";
    menu.innerHTML = itens.map((it) => `<button type="button" class="wpp-menu-contexto-item" data-acao="${it.acao}" data-id="${it.id}">${it.rotulo}</button>`).join("");
    document.body.appendChild(menu);
    const largura = menu.offsetWidth, altura = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - largura - 8) + "px";
    menu.style.top = Math.min(y, window.innerHeight - altura - 8) + "px";
    setTimeout(() => document.addEventListener("click", fecharMenuContexto, { once: true }), 0);
  }
  document.addEventListener("contextmenu", (e) => {
    const item = e.target.closest("[data-wpp-conversa-id]");
    if (!item) return;
    e.preventDefault();
    const id = item.dataset.wppConversaId;
    const arquivada = item.dataset.wppArquivada === "1";
    abrirMenuContexto(e.clientX, e.clientY, [
      { acao: "contexto-agendar", id, rotulo: "🕒 Agendar mensagem" },
      { acao: "contexto-lembrete", id, rotulo: "🔔 Abrir lembrete" },
      { acao: arquivada ? "desarquivar-conversa" : "arquivar-conversa", id, rotulo: arquivada ? "📤 Desarquivar" : "🗄️ Arquivar" },
      { acao: "excluir-conversa", id, rotulo: "🗑️ Excluir conversa" },
    ]);
  });

  // Clique direito em cima do nome no topo da conversa (WhatsApp ou chat
  // interno) já abre direto a tela de editar nome/apelido — mesmo botão
  // ✏️ que já existe ali, só um atalho mais rápido pra chegar nele.
  document.addEventListener("contextmenu", (e) => {
    const nomeEl = e.target.closest(".wpp-chat-nome");
    if (!nomeEl) return;
    const botaoEditar = nomeEl.querySelector('[data-acao="renomear-contato"], [data-acao="abrir-apelido-interno"]');
    if (!botaoEditar) return;
    e.preventDefault();
    botaoEditar.click();
  });

  // =======================================================================
  // LOGIN
  // =======================================================================
  function renderLogin() {
    const flashHtml = state.flash ? `<p class="mensagem-erro">${escapeHtml(state.flash.texto)}</p>` : "";
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
          <div class="logo-3d-wrap"><img class="logo-3d" src="/static/img/logo_alphafitus.png" alt="Alphafitus"></div>
          <h1>Whatts Inbox</h1>
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
    timerStatusGlobal = setInterval(() => { atualizarBolinhaStatusGlobal(); verificarVersaoServidor(); atualizarBadgeSla(); }, 20000);
    // Mais rápido que o resto — é o que avisa "chegou mensagem nova",
    // roda em qualquer tela (não só Conversas/Chat interno), pra piscar
    // o menu lateral mesmo se a pessoa estiver, por exemplo, no Dashboard.
    timerBadgesNaoLidos = setInterval(atualizarBadgesNaoLidos, 4000);
  }

  // Avisa (com bolinha piscando no menu lateral) que chegou mensagem nova
  // — de cliente (Conversas) ou de colega (Chat interno) — mesmo que a
  // pessoa não esteja olhando pra nenhuma das duas telas agora.
  async function atualizarBadgesNaoLidos() {
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
      badge.textContent = alertas.length > 99 ? "99+" : String(alertas.length);
    } catch (e) { /* próxima tentativa corrige */ }
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
        if (badge) badge.textContent = `v${resp.versao.slice(0, 8)}`;
        return;
      }
      if (resp.versao === state.versaoServidor) return;
      pararPollingStatusGlobal();
      pararPollingLembretes();
      pararPollingWhatsapp();
      pararPollingStatusWhatsapp();
      try { await chamarApi("/auth/logout", { method: "POST", body: { refresh_token: state.refreshToken } }); } catch (e) { /* ignora */ }
      limparSessao();
      // Recarrega a página de verdade (não só troca de tela dentro do
      // SPA) — só assim o navegador busca o app.js/styles.css novos.
      // Sem isso, a aba continuava rodando o JS/CSS antigo em memória
      // pra sempre, mesmo depois de deslogar e logar de novo nela mesma.
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
      try { new Notification("🔔 Lembrete — Whatts Inbox", { body: l.texto || `Hora de falar com ${l.contato_nome || l.telefone} de novo` }); }
      catch (e) { /* ignora — o modal já avisa */ }
    }
    abrirModal(`
      <h3 style="margin-top:0;">🔔 Lembrete: hora de retornar!</h3>
      <p>${l.texto ? escapeHtml(l.texto) : "Você marcou pra falar com este cliente de novo agora."}</p>
      <p class="texto-suave">Cliente: ${escapeHtml(l.contato_nome || l.telefone)} — previsto para ${fmtData(l.lembrar_em)}</p>
      <div class="rodape-modal">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Fechar</button>
        <button type="button" class="botao secundario" data-acao="ir-conversa-lembrete" data-conversa-id="${l.conversa_id}">Ver conversa</button>
        <button type="button" class="botao" data-acao="concluir-lembrete-alerta" data-id="${l.id}">Concluir</button>
      </div>`);
  }

  // =======================================================================
  // WHATSAPP — caixa de entrada (abas: Minhas / Fila / Todas)
  // =======================================================================
  let timerWhatsapp = null;
  function pararPollingWhatsapp() { if (timerWhatsapp) { clearInterval(timerWhatsapp); timerWhatsapp = null; } }
  function iniciarPollingWhatsapp(conversaId) {
    pararPollingWhatsapp();
    // 1.2s — pediram explicitamente pra mensagem do cliente aparecer sem
    // delay perceptível. Continua sendo polling (o servidor não empurra
    // nada sozinho), mas nesse intervalo já fica bem próximo de tempo
    // real pro olho humano notar.
    timerWhatsapp = setInterval(async () => {
      if (!location.hash.startsWith("#/whatsapp")) { pararPollingWhatsapp(); return; }
      try {
        await atualizarListaConversasNoDom();
        if (conversaId) await atualizarMensagensNoDom(conversaId);
      } catch (e) { /* próxima tentativa corrige */ }
    }, 1200);
  }

  let timerChatInterno = null;
  function pararPollingChatInterno() { if (timerChatInterno) { clearInterval(timerChatInterno); timerChatInterno = null; } }
  function iniciarPollingChatInterno(conversaId) {
    pararPollingChatInterno();
    timerChatInterno = setInterval(async () => {
      if (!location.hash.startsWith("#/chat-interno")) { pararPollingChatInterno(); return; }
      try {
        await atualizarListaConversasInternasNoDom();
        if (conversaId) await atualizarMensagensInternasNoDom(conversaId);
      } catch (e) { /* próxima tentativa corrige */ }
    }, 2500);
  }

  function _queryChatInterno() {
    if (state.chatInternoEscopo === "encerradas") return "?encerradas=1";
    if (state.chatInternoEscopo === "todas") return "?todas=1";
    return "";
  }

  async function atualizarListaConversasInternasNoDom() {
    const lista = document.querySelector("[data-wpp-lista-interno]");
    if (!lista) return;
    const conversas = await chamarApi(`/chat-interno/conversas${_queryChatInterno()}`);
    const conversaAtivaId = Number(location.hash.split("/")[2]) || null;
    lista.innerHTML = htmlListaConversasInternas(conversas, conversaAtivaId);
  }

  async function atualizarMensagensInternasNoDom(conversaId) {
    const painel = document.querySelector("[data-wpp-mensagens-interno]");
    if (!painel) return;
    const conversas = await chamarApi(`/chat-interno/conversas${_queryChatInterno()}`);
    const conversa = conversas.find((c) => c.id === conversaId);
    if (!conversa) return;
    const mensagens = await chamarApi(`/chat-interno/conversas/${conversaId}/mensagens`);
    if (mensagens.length === painel.children.length) return;
    const estavaNoFim = painel.scrollTop + painel.clientHeight >= painel.scrollHeight - 40;
    painel.innerHTML = mensagens.map((m) => htmlBolhaInterna(m, conversa)).join("");
    if (estavaNoFim) painel.scrollTop = painel.scrollHeight;
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

  function htmlListaConversas(conversas, conversaAtivaId) {
    if (!conversas.length) {
      const msgs = {
        fila: "Nada aguardando resposta no momento. 👏",
        todas: "Nenhuma conversa no sistema ainda.",
        minhas: "Nenhuma conversa em andamento — as que estão esperando resposta ficam na aba Fila.",
        arquivadas: "Nenhuma conversa arquivada.",
      };
      return `<div class="wpp-lista-vazia"><div class="wpp-lista-vazia-icone">📭</div><p class="texto-suave">${msgs[state.escopoConversas]}</p></div>`;
    }
    return conversas.map((c) => {
      const nome = c.contato_nome || c.telefone;
      const naFila = !c.atribuida_usuario_id;
      const slaEstourado = state.slaAlertasIds.has(c.id);
      return `<a class="wpp-conversa-item ${c.id === conversaAtivaId ? "ativa" : ""} ${slaEstourado ? "wpp-conversa-sla" : ""}" href="#/whatsapp/${c.id}" data-wpp-conversa-id="${c.id}" data-wpp-arquivada="${c.arquivada ? "1" : "0"}" ${slaEstourado ? 'title="Sem resposta há tempo demais"' : ""}>
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
            if (state.escopoConversas === "todas" || naFila) {
              partes.push(naFila ? '<span class="selo amarelo">Na fila</span>' : `<span class="wpp-mini-bolinha ${c.atribuida_usuario_online ? "wpp-online-sim" : "wpp-online-nao"}" title="${c.atribuida_usuario_online ? "Online agora" : "Offline"}"></span> ${escapeHtml(c.atribuida_usuario_nome || "")}`);
            }
            if (c.status === "fechada") partes.push('<span class="selo inativo">Fechada</span>');
            // O setor aparece sempre, em qualquer aba — não só em "Todas"/"Fila" — é informação útil pra qualquer atendente ver de cara.
            if (c.menu_setor) partes.push(`🏷️ ${escapeHtml(c.menu_setor)}`);
            return partes.length ? `<div class="wpp-conversa-dono">${partes.join(" · ")}</div>` : "";
          })()}
          ${(c.tags || []).length ? `<div class="wpp-tags-linha wpp-tags-linha-lista">${c.tags.map((t) => `<span class="wpp-tag-chip" style="background:${t.cor};">${escapeHtml(t.nome)}</span>`).join("")}</div>` : ""}
        </div>
        ${naFila ? `<button type="button" class="botao pequeno wpp-botao-assumir" data-acao="assumir-conversa" data-id="${c.id}">Assumir</button>` : ""}
      </a>`;
    }).join("");
  }

  function htmlAnexoBolha(m) {
    if (!m.midia_url) return "";
    if (m.tipo === "imagem") return `
      <div class="wpp-bolha-midia-envolucro">
        <a href="${m.midia_url}" target="_blank" rel="noopener" title="Ver em tamanho grande"><img class="wpp-bolha-imagem" src="${m.midia_url}" alt="Imagem anexada"></a>
        <a class="wpp-bolha-baixar" href="${m.midia_url}" download title="Baixar imagem">⬇</a>
      </div>`;
    if (m.tipo === "video") return `
      <div class="wpp-bolha-midia-envolucro">
        <video class="wpp-bolha-video" src="${m.midia_url}" controls></video>
        <a class="wpp-bolha-baixar" href="${m.midia_url}" download title="Baixar vídeo">⬇</a>
      </div>`;
    const rotulo = { documento: "📄 Documento", audio: "🎵 Áudio" }[m.tipo] || "📎 Anexo";
    return `
      <div class="wpp-bolha-anexo-linha">
        <a class="wpp-bolha-anexo" href="${m.midia_url}" target="_blank" rel="noopener" title="Abrir (PDFs abrem direto no navegador)">${rotulo} — visualizar</a>
        <a class="wpp-bolha-baixar" href="${m.midia_url}" download title="Baixar">⬇</a>
      </div>`;
  }

  function htmlBolha(m) {
    const saida = m.direcao === "saida";
    const iconeStatus = { pendente: "🕓", enviada: "✓", entregue: "✓✓", lida: "✓✓", falhou: "⚠️", recebida: "" }[m.status] || "";
    return `<div class="wpp-bolha ${saida ? "wpp-bolha-saida" : "wpp-bolha-entrada"} ${m.status === "falhou" ? "wpp-bolha-falhou" : ""}" data-wpp-bolha-id="${m.id}">
      ${htmlAnexoBolha(m)}
      ${m.texto ? `<div class="wpp-bolha-texto">${escapeHtml(m.texto)}</div>` : ""}
      <div class="wpp-bolha-rodape">
        ${saida && m.status === "falhou" ? `<button type="button" class="wpp-bolha-excluir" data-acao="reenviar-mensagem" data-id="${m.id}" title="Tentar enviar de novo">🔄</button>` : ""}
        ${saida ? `<button type="button" class="wpp-bolha-excluir" data-acao="excluir-mensagem" data-id="${m.id}" title="Excluir mensagem (ex.: enviada por engano)">🗑️</button>` : ""}
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

  function htmlNotas(conversaId, notas) {
    return `<details class="wpp-resumo">
      <summary class="wpp-resumo-rotulo">🗒️ Notas internas <span class="texto-suave">— só a equipe vê, nunca vai pro cliente${notas.length ? ` (${notas.length})` : ""}</span></summary>
      <div class="wpp-notas-lista">
        ${notas.length ? notas.map((n) => `
          <div class="wpp-nota-item">
            <div class="wpp-nota-cabecalho"><strong>${escapeHtml(n.usuario_nome || "—")}</strong><span class="texto-suave">${fmtData(n.criado_em)}</span></div>
            <div>${escapeHtml(n.texto)}</div>
          </div>`).join("") : '<p class="texto-suave">Nenhuma nota ainda.</p>'}
      </div>
      <form data-form="criar-nota" data-conversa-id="${conversaId}" class="wpp-resumo-form">
        <textarea name="texto" rows="2" placeholder="Ex.: cliente pediu desconto, aguardando aprovação da gerência…" required></textarea>
        <button type="submit" class="botao secundario pequeno">Adicionar</button>
      </form>
    </details>`;
  }

  function htmlChat(conversa, mensagens, agendadas, respostasProntas, notas) {
    if (!conversa) {
      return `<div class="wpp-chat-vazio"><div class="wpp-chat-vazio-icone">💬</div><p class="texto-suave">Selecione uma conversa à esquerda para ver as mensagens.</p></div>`;
    }
    const usuario = state.usuarioAtual;
    const nome = conversa.contato_nome || conversa.telefone;
    const souDono = conversa.atribuida_usuario_id === usuario.id;
    const emSupervisao = usuario.admin && !souDono && conversa.atribuida_usuario_id;
    const fechada = conversa.status === "fechada";
    return `
      <div class="wpp-chat-cabecalho">
        <button type="button" class="botao-icone wpp-botao-voltar" data-acao="voltar-lista" title="Voltar">←</button>
        <span style="position:relative;">
          ${htmlAvatarContato(conversa.contato_foto, conversa.contato_nome, conversa.telefone, 42)}
          <button type="button" class="wpp-avatar-atualizar" data-acao="atualizar-foto-contato" data-id="${conversa.id}" title="Atualizar foto do contato">🔄</button>
        </span>
        <div style="flex:1; min-width:0;">
          <div class="wpp-chat-nome">${escapeHtml(nome)} <button type="button" class="botao-icone" style="width:20px; height:20px; font-size:11px; vertical-align:middle;" data-acao="renomear-contato" data-contato-id="${conversa.contato_id}" data-nome="${escapeHtml(conversa.contato_nome || "")}" title="Trocar o nome deste contato (só você vê)">✏️</button></div>
          <div class="texto-suave wpp-chat-telefone">${escapeHtml(conversa.telefone)}${conversa.menu_setor ? ` · 🏷️ ${escapeHtml(conversa.menu_setor)}` : ""}${emSupervisao ? ` · 👁️ supervisionando <span class="wpp-mini-bolinha ${conversa.atribuida_usuario_online ? "wpp-online-sim" : "wpp-online-nao"}" title="${conversa.atribuida_usuario_online ? "Online agora" : "Offline"}"></span> (não marca como lida para ${escapeHtml(conversa.atribuida_usuario_nome || "o responsável")})` : ""}</div>
        </div>
        <div class="wpp-chat-acoes">
          <button type="button" class="botao-icone ${conversa.resumo ? "wpp-icone-preenchido" : ""}" data-acao="abrir-resumo" data-id="${conversa.id}" data-resumo="${escapeHtml(conversa.resumo || "")}" title="${conversa.resumo ? "Ver/editar resumo do atendimento" : "Adicionar resumo do atendimento"}">📝</button>
          <button type="button" class="botao-icone" data-acao="abrir-lembrete" data-id="${conversa.id}" title="Criar lembrete de retorno">🔔</button>
          <button type="button" class="botao secundario pequeno" data-acao="abrir-encaminhar" data-id="${conversa.id}">Encaminhar</button>
          ${fechada
            ? `<button type="button" class="botao secundario pequeno" data-acao="reabrir-conversa" data-id="${conversa.id}">Reabrir</button>`
            : `<button type="button" class="botao secundario pequeno" data-acao="fechar-conversa" data-id="${conversa.id}">Encerrar atendimento</button>`}
          <button type="button" class="botao-icone" data-acao="${conversa.arquivada ? "desarquivar-conversa" : "arquivar-conversa"}" data-id="${conversa.id}" title="${conversa.arquivada ? "Desarquivar" : "Arquivar"}">${conversa.arquivada ? "📤" : "🗄️"}</button>
          <button type="button" class="botao-icone" data-acao="excluir-conversa" data-id="${conversa.id}" title="Excluir conversa">🗑️</button>
        </div>
      </div>
      <div class="wpp-tags-linha">
        ${(conversa.tags || []).map((t) => `<span class="wpp-tag-chip" style="background:${t.cor};">${escapeHtml(t.nome)}</span>`).join("")}
        <button type="button" class="wpp-tag-adicionar" data-acao="abrir-tags-conversa" data-id="${conversa.id}" data-tags='${escapeHtml(JSON.stringify((conversa.tags || []).map((t) => t.id)))}'>+ etiqueta</button>
      </div>
      ${htmlNotas(conversa.id, notas || [])}
      ${fechada ? `<p class="wpp-conversa-fechada-aviso">Esta conversa está fechada${conversa.aguardando_avaliacao ? " — aguardando avaliação do cliente" : ""}. Responder ou reabrir a torna ativa de novo.</p>` : ""}
      <div class="wpp-mensagens" data-wpp-mensagens>${mensagens.map(htmlBolha).join("")}</div>
      ${htmlAgendadas(agendadas)}
      <form class="wpp-chat-input" data-form="enviar-mensagem" data-conversa-id="${conversa.id}">
        <input type="file" class="wpp-input-arquivo-oculto" data-acao-change="anexar-arquivo" data-conversa-id="${conversa.id}" hidden>
        <button type="button" class="botao-icone" data-acao="abrir-seletor-arquivo" title="Anexar imagem, vídeo ou documento">📎</button>
        <div class="wpp-emoji-envolucro">
          <button type="button" class="botao-icone" data-acao="alternar-emoji" title="Emoji">😀</button>
          <div class="wpp-emoji-painel" data-wpp-emoji-painel hidden>${EMOJIS_COMUNS.map((e) => `<button type="button" class="wpp-emoji-item" data-acao="inserir-emoji" data-emoji="${e}">${e}</button>`).join("")}</div>
        </div>
        <div class="wpp-emoji-envolucro">
          <button type="button" class="botao-icone" data-acao="alternar-respostas-prontas" title="Respostas prontas">📋</button>
          <div class="wpp-respostas-painel" data-wpp-respostas-painel hidden>${htmlRespostasProntasLista(respostasProntas || [])}</div>
        </div>
        <textarea name="texto" class="wpp-textarea" placeholder="Digite uma mensagem…" rows="1"></textarea>
        <button type="button" class="botao-icone" data-acao="alternar-gravacao-audio" data-id="${conversa.id}" title="Gravar áudio">🎙️</button>
        <button type="button" class="botao-icone" data-acao="abrir-agendar" data-id="${conversa.id}" title="Agendar envio">🕒</button>
        <button type="submit" class="botao wpp-botao-enviar" title="Enviar">➤</button>
      </form>`;
  }

  function htmlAbasConversas() {
    const usuario = state.usuarioAtual;
    const abas = [
      { chave: "minhas", label: "Minhas", dica: "Conversas em andamento — você já respondeu, aguardando o cliente" },
      { chave: "fila", label: "Fila", dica: "Aguardando resposta sua — inclui as ainda sem dono do seu setor" },
    ];
    if (usuario.admin) abas.push({ chave: "todas", label: "Todas" });
    abas.push({ chave: "arquivadas", label: "Arquivadas" });
    return `<div class="wpp-abas">${abas.map((a) => `<button type="button" class="wpp-aba ${state.escopoConversas === a.chave ? "ativa" : ""}" data-acao="trocar-escopo-conversas" data-escopo="${a.chave}"${a.dica ? ` title="${escapeHtml(a.dica)}"` : ""}>${a.label}</button>`).join("")}</div>`;
  }

  function _queryConversas() {
    const arquivadas = state.escopoConversas === "arquivadas";
    const escopoQuery = arquivadas ? (state.usuarioAtual.admin ? "todas" : "minhas") : state.escopoConversas;
    return `escopo=${escopoQuery}${arquivadas ? "&arquivadas=1" : ""}`;
  }

  async function renderWhatsapp(conversaId) {
    app.innerHTML = '<div class="carregando-inicial">Carregando…</div>';
    let conversas;
    if (state.buscaConversas) {
      conversas = await chamarApi(`/whatsapp/conversas/buscar?q=${encodeURIComponent(state.buscaConversas)}`);
    } else {
      conversas = await chamarApi(`/whatsapp/conversas?${_queryConversas()}`);
    }

    let conversaAtual = null, mensagens = [], agendadas = [], respostasProntas = [], notas = [];
    if (conversaId) {
      conversaAtual = conversas.find((c) => c.id === conversaId) || null;
      if (!conversaAtual) {
        // A conversa pode existir mas não estar na aba atual (ex.: link
        // direto para uma conversa de outra pessoa) — busca à parte; se
        // o servidor recusar (403/404), o catch de montarRota mostra o erro.
        conversaAtual = await chamarApi(`/whatsapp/conversas?escopo=todas`).then((todas) => todas.find((c) => c.id === conversaId)).catch(() => null);
      }
      if (conversaAtual) {
        [mensagens, agendadas, respostasProntas, notas] = await Promise.all([
          chamarApi(`/whatsapp/conversas/${conversaId}/mensagens`),
          chamarApi(`/whatsapp/conversas/${conversaId}/agendadas`),
          obterRespostasProntas(),
          chamarApi(`/whatsapp/conversas/${conversaId}/notas`),
        ]);
        if (conversaAtual.atribuida_usuario_id === state.usuarioAtual.id) conversaAtual.nao_lidas = 0;
      }
    }

    renderShell(
      `<div class="wpp-cabecalho-tela">
         <h2 style="margin:0;">Conversas</h2>
         <div style="display:flex; gap:8px;">
           <button type="button" class="botao secundario pequeno" data-acao="abrir-contatos">📇 Contatos</button>
           <button type="button" class="botao pequeno" data-acao="abrir-nova-conversa">+ Nova conversa</button>
         </div>
       </div>
       <div class="wpp-layout ${conversaId ? "wpp-conversa-aberta" : ""}">
         <div class="wpp-painel-lista">
           <form class="wpp-busca-form" data-form="buscar-conversas">
             <input type="search" name="q" class="wpp-busca-input" placeholder="Buscar por nome, telefone ou mensagem…" value="${escapeHtml(state.buscaConversas || "")}">
             <button type="submit" class="botao-icone" title="Buscar">🔍</button>
             ${state.buscaConversas ? `<button type="button" class="botao-icone" data-acao="limpar-busca-conversas" title="Limpar busca">✕</button>` : ""}
           </form>
           ${state.buscaConversas ? `<p class="texto-suave" style="padding:0 4px 8px;">Resultados para "${escapeHtml(state.buscaConversas)}"</p>` : htmlAbasConversas()}
           <div class="wpp-lista-conversas" data-wpp-lista>${htmlListaConversas(conversas, conversaId)}</div>
         </div>
         <div class="wpp-painel-chat">${htmlChat(conversaAtual, mensagens, agendadas, respostasProntas, notas)}</div>
       </div>`,
      "whatsapp"
    );

    const painelMensagens = document.querySelector("[data-wpp-mensagens]");
    if (painelMensagens) painelMensagens.scrollTop = painelMensagens.scrollHeight;
    iniciarPollingWhatsapp(conversaId);
  }

  async function atualizarListaConversasNoDom() {
    const lista = document.querySelector("[data-wpp-lista]");
    if (!lista) return;
    if (state.buscaConversas) return; // não sobrescreve um resultado de busca ativo
    const conversas = await chamarApi(`/whatsapp/conversas?${_queryConversas()}`);
    const conversaAtivaId = Number(location.hash.split("/")[2]) || null;
    lista.innerHTML = htmlListaConversas(conversas, conversaAtivaId);
  }

  async function atualizarMensagensNoDom(conversaId) {
    const painel = document.querySelector("[data-wpp-mensagens]");
    if (!painel) return;
    const mensagens = await chamarApi(`/whatsapp/conversas/${conversaId}/mensagens`);
    if (mensagens.length === painel.children.length) return;
    const estavaNoFim = painel.scrollTop + painel.clientHeight >= painel.scrollHeight - 40;
    painel.innerHTML = mensagens.map(htmlBolha).join("");
    if (estavaNoFim) painel.scrollTop = painel.scrollHeight;
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
  function htmlListaConversasInternas(conversas, ativaId) {
    if (!conversas.length) {
      return `<div class="wpp-lista-vazia"><div class="wpp-lista-vazia-icone">🗨️</div><p class="texto-suave">Nenhuma conversa interna ainda — clique em "+ Nova conversa" pra chamar alguém de um setor.</p></div>`;
    }
    const eu = state.usuarioAtual.id;
    return conversas.map((c) => {
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
      return `<a class="wpp-conversa-item ${c.id === ativaId ? "ativa" : ""}" href="#/chat-interno/${c.id}">
        <div class="wpp-avatar" style="background:${corAvatar(outroNome)};">${escapeHtml(iniciaisContato(outroNome))}</div>
        <div class="wpp-conversa-info">
          <div class="wpp-conversa-linha1">
            <span class="wpp-conversa-nome">${escapeHtml(outroNome)}</span>
            <span class="wpp-conversa-hora">${fmtHoraCurta(c.ultima_mensagem_em)}</span>
          </div>
          <div class="wpp-conversa-linha2">
            ${_estaDigitando(outroDigitandoAte)
              ? `<span class="wpp-conversa-preview wpp-digitando">digitando…</span>`
              : `<span class="wpp-conversa-preview">${escapeHtml(c.ultima_mensagem_preview || "")}</span>`}
            ${naoLidas > 0 ? `<span class="wpp-badge-nao-lidas piscando">${naoLidas > 99 ? "99+" : naoLidas}</span>` : ""}
          </div>
          ${c.setor_destino || c.status === "fechada" ? `<div class="wpp-conversa-dono">${c.setor_destino ? `🏷️ ${escapeHtml(c.setor_destino)}` : ""}${c.status === "fechada" ? ' · <span class="selo inativo">Fechada</span>' : ""}</div>` : ""}
        </div>
      </a>`;
    }).join("");
  }

  function htmlBolhaInterna(m, conversa) {
    const eu = state.usuarioAtual.id;
    const souAlheio = conversa.criado_por_id !== eu && conversa.participante_id !== eu;
    // Admin espiando (nenhum dos dois é ele): não tem "eu" nessa conversa
    // pra alinhar bolha à direita — usa quem criou como referência de
    // lado, só pra não ficar tudo emendado do mesmo lado.
    const saida = souAlheio ? m.usuario_id === conversa.criado_por_id : m.usuario_id === eu;
    const nomeAutor = m.usuario_id === conversa.criado_por_id ? conversa.criado_por_nome : (conversa.participante_nome || "—");
    return `<div class="wpp-bolha ${saida ? "wpp-bolha-saida" : "wpp-bolha-entrada"}">
      ${!saida || souAlheio ? `<div class="texto-suave" style="font-size:11px; font-weight:700; margin-bottom:2px;">${escapeHtml(nomeAutor)}</div>` : ""}
      <div class="wpp-bolha-texto">${escapeHtml(m.texto || "")}</div>
      <div class="wpp-bolha-rodape"><span class="wpp-bolha-hora">${fmtHoraCurta(m.criado_em)}</span></div>
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
    const fechada = conversa.status === "fechada";
    return `
      <div class="wpp-chat-cabecalho">
        <button type="button" class="botao-icone wpp-botao-voltar" data-acao="voltar-lista-interno" title="Voltar">←</button>
        <div class="wpp-avatar" style="background:${corAvatar(outroNome)};">${escapeHtml(iniciaisContato(outroNome))}</div>
        <div style="flex:1; min-width:0;">
          <div class="wpp-chat-nome">${escapeHtml(outroNome)}${souAlheio ? "" : ` <button type="button" class="botao-icone" style="width:20px; height:20px; font-size:11px; vertical-align:middle;" data-acao="abrir-apelido-interno" data-conversa-id="${conversa.id}" data-apelido="${escapeHtml(outroNome)}" title="Definir apelido (só você vê)">✏️</button>`}</div>
          <div class="texto-suave wpp-chat-telefone">${souAlheio ? "👁️ supervisionando — a leitura não marca a mensagem como vista pra eles" : ""}${conversa.setor_destino ? `${souAlheio ? " · " : ""}🏷️ ${escapeHtml(conversa.setor_destino)}` : (souAlheio ? "" : "Chat interno")}</div>
        </div>
        <div class="wpp-chat-acoes">
          <button type="button" class="botao secundario pequeno" data-acao="abrir-encaminhar-interno" data-id="${conversa.id}">Encaminhar</button>
          ${fechada
            ? `<button type="button" class="botao secundario pequeno" data-acao="reabrir-interno" data-id="${conversa.id}">Reabrir</button>`
            : `<button type="button" class="botao secundario pequeno" data-acao="fechar-interno" data-id="${conversa.id}">Encerrar atendimento</button>`}
        </div>
      </div>
      ${fechada ? `<p class="wpp-conversa-fechada-aviso">Esta conversa está fechada. Responder ou reabrir a torna ativa de novo.</p>` : ""}
      <div class="wpp-mensagens" data-wpp-mensagens-interno>${mensagens.map((m) => htmlBolhaInterna(m, conversa)).join("")}</div>
      <form class="wpp-chat-input" data-form="enviar-mensagem-interna" data-conversa-id="${conversa.id}">
        <textarea name="texto" class="wpp-textarea" placeholder="Digite uma mensagem…" rows="1" required></textarea>
        <button type="submit" class="botao wpp-botao-enviar" title="Enviar">➤</button>
      </form>`;
  }

  async function renderChatInterno(conversaId) {
    app.innerHTML = '<div class="carregando-inicial">Carregando…</div>';
    const usuario = state.usuarioAtual;
    const escopo = state.chatInternoEscopo;
    const conversas = await chamarApi(`/chat-interno/conversas${_queryChatInterno()}`);

    let conversaAtual = null, mensagens = [];
    if (conversaId) {
      conversaAtual = conversas.find((c) => c.id === conversaId) || null;
      if (!conversaAtual) {
        // Pode ser uma conversa de outro escopo acessada direto pelo link
        // (ex.: aba "Minhas" selecionada mas o link é de uma encerrada) —
        // busca nos outros escopos antes de desistir.
        for (const outroEscopo of ["minhas", "encerradas", "todas"]) {
          if (outroEscopo === escopo) continue;
          if (outroEscopo === "todas" && !usuario.admin) continue;
          const q = outroEscopo === "encerradas" ? "?encerradas=1" : outroEscopo === "todas" ? "?todas=1" : "";
          const outras = await chamarApi(`/chat-interno/conversas${q}`);
          conversaAtual = outras.find((c) => c.id === conversaId) || null;
          if (conversaAtual) break;
        }
      }
      if (conversaAtual) {
        mensagens = await chamarApi(`/chat-interno/conversas/${conversaId}/mensagens`);
        // Só zera não-lida de quem a mensagem é DE VERDADE — um admin
        // espiando (na aba "Todas") uma conversa que não é dele não deve
        // mexer no contador de ninguém, mesma régua da supervisão em
        // Conversas (WhatsApp).
        if (conversaAtual.criado_por_id === usuario.id) conversaAtual.nao_lidas_criador = 0;
        else if (conversaAtual.participante_id === usuario.id) conversaAtual.nao_lidas_participante = 0;
      }
    }

    const abas = [{ chave: "minhas", label: "Minhas" }, { chave: "encerradas", label: "Encerradas" }];
    if (usuario.admin) abas.push({ chave: "todas", label: "Todas" });

    renderShell(
      `<div class="wpp-cabecalho-tela">
         <h2 style="margin:0;">Chat interno</h2>
         <button type="button" class="botao pequeno" data-acao="abrir-nova-conversa-interna">+ Nova conversa</button>
       </div>
       <p class="dica" style="margin-top:-8px;">Privado — só quem participa da conversa (e admins) consegue ver.</p>
       <div class="wpp-abas">
         ${abas.map((a) => `<button type="button" class="wpp-aba ${escopo === a.chave ? "ativa" : ""}" data-acao="chat-interno-trocar-escopo" data-escopo="${a.chave}">${a.label}</button>`).join("")}
       </div>
       <div class="wpp-layout ${conversaId ? "wpp-conversa-aberta" : ""}">
         <div class="wpp-painel-lista">
           <div class="wpp-lista-conversas" data-wpp-lista-interno>${htmlListaConversasInternas(conversas, conversaId)}</div>
         </div>
         <div class="wpp-painel-chat">${htmlChatInterno(conversaAtual, mensagens)}</div>
       </div>`,
      "chat-interno"
    );

    const painelMensagens = document.querySelector("[data-wpp-mensagens-interno]");
    if (painelMensagens) painelMensagens.scrollTop = painelMensagens.scrollHeight;
    iniciarPollingChatInterno(conversaId);
  }

  function modalNovaConversaInterna(usuarios, setores) {
    const eu = state.usuarioAtual.id;
    const disponiveis = usuarios.filter((u) => u.ativo && u.id !== eu);
    abrirModal(`
      <h3 style="margin-top:0;">Nova conversa interna</h3>
      <form data-form="iniciar-conversa-interna">
        <div class="campo"><label>Setor</label>
          <select name="setor_filtro" data-acao-change="filtrar-participantes-interno">
            <option value="">Todos os setores</option>
            ${setores.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
          </select>
        </div>
        <div class="campo"><label>Falar com</label>
          <select name="participante_id" required data-lista-participantes>
            <option value="">Selecione…</option>
            ${disponiveis.map((u) => `<option value="${u.id}" data-setor="${escapeHtml(u.setor || "")}">${u.online ? "🟢" : "🔴"} ${escapeHtml(u.nome)}${u.setor ? " — " + escapeHtml(u.setor) : ""}${u.admin ? " (Admin)" : ""}</option>`).join("")}
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
      .map((u) => `<option value="${u.id}">${u.online ? "🟢" : "🔴"} ${escapeHtml(u.nome)}${u.setor ? " — " + escapeHtml(u.setor) : ""}</option>`).join("");
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

  function htmlListaContatosModal(contatos) {
    if (!contatos.length) return '<p class="texto-suave">Nenhum contato ainda — importe um arquivo acima, ou eles aparecem aqui sozinhos assim que alguém escrever pela primeira vez.</p>';
    return contatos.map((c) => `
      <div class="wpp-contato-linha">
        ${htmlAvatarContato(c.foto_url, c.nome, c.telefone, 32)}
        <div style="flex:1; min-width:0;"><strong>${escapeHtml(c.nome || c.telefone)}</strong>${c.nome ? `<div class="texto-suave">${escapeHtml(c.telefone)}</div>` : ""}</div>
        <button type="button" class="botao secundario pequeno" data-acao="iniciar-conversa-contato" data-telefone="${escapeHtml(c.telefone)}" data-nome="${escapeHtml(c.nome || "")}">Conversar</button>
      </div>`).join("");
  }

  async function modalContatos() {
    const contatos = await chamarApi("/whatsapp/contatos");
    abrirModal(`
      <h3 style="margin-top:0;">Contatos</h3>
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
      <p class="texto-suave">Essa negociação resultou em venda? Isso alimenta a taxa de conversão no Dashboard.</p>
      <div class="rodape-modal" style="justify-content:space-between;">
        <button type="button" class="botao secundario" data-acao="fechar-modal">Cancelar</button>
        <div style="display:flex; gap:8px;">
          <button type="button" class="botao secundario" data-acao="fechar-conversa-com-resultado" data-id="${conversaId}">Encerrar sem marcar</button>
          <button type="button" class="botao perigo" data-acao="fechar-conversa-com-resultado" data-id="${conversaId}" data-resultado="perdido">Não convertido</button>
          <button type="button" class="botao" data-acao="fechar-conversa-com-resultado" data-id="${conversaId}" data-resultado="venda">✅ Venda fechada</button>
        </div>
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

  function modalTags(conversaId, todasTags, marcadas) {
    abrirModal(`
      <h3 style="margin-top:0;">Etiquetas</h3>
      <form data-form="definir-tags-conversa" data-conversa-id="${conversaId}">
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
         <div class="wpp-qrcode-wrap">
           <img class="wpp-qrcode" src="data:image/png;base64,${config.qrcode_base64}" alt="QR Code de pareamento do WhatsApp">
           <p class="texto-suave">Abra o WhatsApp no celular → Aparelhos conectados → Conectar um aparelho → escaneie.</p>
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
    app.innerHTML = '<div class="carregando-inicial">Carregando…</div>';
    const [{ config, webhookUrl }, setoresDetalhado, backups] = await Promise.all([
      buscarConfigECriarWebhookUrl(),
      chamarApi("/usuarios/setores/detalhado"),
      chamarApi("/sistema/backups"),
    ]);
    const setoresAtuais = setoresDetalhado.map((s) => s.nome);

    renderShell(
      `<h2>Configuração</h2>
       <div class="cartao">
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
         <h3 style="margin-top:0;">Setores</h3>
         <p class="dica">Pra onde o cliente é direcionado no menu automático do WhatsApp, e o que cada atendente escolhe como área dele. Crie, renomeie ou exclua livremente — a ordem abaixo é a mesma ordem dos números que o cliente digita no menu.</p>
         <ul style="list-style:none; padding:0; margin:0 0 14px; display:flex; flex-direction:column; gap:8px;">
           ${setoresDetalhado.map((s, i) => `
             <li style="display:flex; align-items:center; gap:8px;">
               <span class="texto-suave" style="min-width:20px;">${i + 1}.</span>
               <input value="${escapeHtml(s.nome)}" data-acao-change="renomear-setor" data-setor-id="${s.id}" style="flex:1;">
               <button type="button" class="botao-icone" data-acao="excluir-setor" data-id="${s.id}" data-nome="${escapeHtml(s.nome)}" title="Excluir setor">🗑️</button>
             </li>`).join("")}
         </ul>
         <form data-form="criar-setor" style="display:flex; gap:8px;">
           <input name="nome" placeholder="Nome do novo setor" required style="flex:1;">
           <button type="submit" class="botao secundario">Adicionar setor</button>
         </form>
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
       </div>`,
      "configuracao"
    );

    if (config.status_conexao === "aguardando_qrcode") iniciarPollingStatusWhatsapp();
    else pararPollingStatusWhatsapp();
  }

  // Atualiza SÓ o cartão de status/QR Code no lugar, sem redesenhar a
  // página inteira — um re-render completo a cada 4s (o intervalo do
  // polling abaixo) jogava a rolagem de volta pro topo bem na hora de
  // escanear o QR Code, derrubando ele da tela repetidamente.
  async function atualizarSecaoConexaoNoDom() {
    const container = document.querySelector("[data-wpp-secao-conexao]");
    if (!container) { pararPollingStatusWhatsapp(); return; }
    await chamarApi("/whatsapp/status"); // consulta de verdade a Evolution API e atualiza o banco
    const { config, webhookUrl } = await buscarConfigECriarWebhookUrl();
    container.innerHTML = htmlSecaoConexao(config, webhookUrl);
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
    app.innerHTML = '<div class="carregando-inicial">Carregando…</div>';
    const usuario = state.usuarioAtual;
    const verTodos = usuario.admin && state.agendamentosTodos;
    const agendadas = await chamarApi(`/whatsapp/agendadas${verTodos ? "?todos=1" : ""}`);

    const linhas = agendadas.map((a) => `
      <tr>
        <td>${fmtData(a.agendado_para)}</td>
        <td><a href="#/whatsapp/${a.conversa_id}">${escapeHtml(a.contato_nome || a.telefone)}</a></td>
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
    app.innerHTML = '<div class="carregando-inicial">Carregando…</div>';
    const usuario = state.usuarioAtual;
    const verTodos = usuario.admin && state.lembretesTodos;
    const lembretes = await chamarApi(`/whatsapp/lembretes${verTodos ? "?todos=1" : ""}`);

    const agora = new Date();
    const linhas = lembretes.map((l) => {
      const vencido = new Date(l.lembrar_em.endsWith("Z") ? l.lembrar_em : l.lembrar_em + "Z") <= agora;
      return `<tr class="${vencido ? "linha-alerta" : ""}">
        <td>${fmtData(l.lembrar_em)}${vencido ? ' <span class="selo bloqueado">Vencido</span>' : ""}</td>
        <td><a href="#/whatsapp/${l.conversa_id}">${escapeHtml(l.contato_nome || l.telefone)}</a></td>
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
         </table>` : `<p class="texto-suave">Nenhum lembrete pendente.</p>`}
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
    if (v < 60) return `${v}min`;
    const h = Math.floor(v / 60);
    const m = Math.round(v % 60);
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
    app.innerHTML = '<div class="carregando-inicial">Carregando…</div>';
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
        <td>${fmtMinutos(u.tempo_medio_atendimento_min)}</td>
        <td>${u.respostas_demoradas > 0
              ? `<span class="selo bloqueado">${u.respostas_demoradas}</span><span class="texto-suave"> de ${u.total_respostas}</span>${u.pior_demora_min ? `<div class="texto-suave">pior: ${fmtMinutos(u.pior_demora_min)}</div>` : ""}`
              : (u.total_respostas ? '<span class="selo ativo">0</span>' : "—")}</td>
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
         <p class="dica">Tempo de 1ª resposta: da chegada da conversa até a primeira resposta. Tempo de resposta: média entre cada mensagem do cliente e a resposta seguinte. Tempo de atendimento: duração média das conversas já fechadas. Avaliação: nota que o próprio cliente deu ao final do atendimento.</p>
         <table>
           <thead><tr><th>Usuário</th><th>Conversas</th><th>Não lidas</th><th>Msgs enviadas</th><th>1ª resposta</th><th>Resposta média</th><th>Atendimento</th><th title="Respostas que passaram do limite de ${t.limite_demora_min} min">Demoras</th><th title="Conversas paradas agora, cliente esperando">Paradas agora</th><th>Avaliação</th></tr></thead>
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
    app.innerHTML = '<div class="carregando-inicial">Carregando…</div>';
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
    app.innerHTML = '<div class="carregando-inicial">Carregando…</div>';
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
  async function renderUsuarios() {
    app.innerHTML = '<div class="carregando-inicial">Carregando…</div>';
    const [usuarios, setores] = await Promise.all([chamarApi("/usuarios"), chamarApi("/usuarios/setores")]);
    const linhas = usuarios.map((u) => `
      <tr>
        <td style="position:relative;">${htmlAvatar(u, 28)}<span class="wpp-online-bolinha ${u.online ? "wpp-online-sim" : "wpp-online-nao"}" title="${u.online ? "Online agora" : "Offline"}"></span></td>
        <td>${escapeHtml(u.nome)}</td>
        <td class="texto-suave">${escapeHtml(u.email)}</td>
        <td class="texto-suave">${escapeHtml(u.setor || "—")}</td>
        <td>${u.admin ? '<span class="selo ativo">Admin</span>' : '<span class="selo inativo">Padrão</span>'}</td>
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
        <div class="campo" data-campo-setor>
          <label>Setor</label>
          <select name="setor" required>
            <option value="">Selecione…</option>
            ${setores.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
          </select>
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
        <div class="campo" data-campo-setor style="${u.admin ? "display:none;" : ""}">
          <label>Setor</label>
          <select name="setor" ${u.admin ? "" : "required"}>
            <option value="">Selecione…</option>
            ${setores.map((s) => `<option value="${escapeHtml(s)}" ${u.setor === s ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}
          </select>
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
      case "alternar-menu-mobile":
        document.querySelector(".barra-lateral").classList.toggle("aberta");
        document.querySelector(".fundo-menu-mobile").classList.toggle("visivel");
        return;
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
          opt.hidden = !!setor && opt.dataset.setor !== setor;
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
      case "trocar-escopo-conversas": {
        state.escopoConversas = alvo.dataset.escopo;
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
          if (erro.codigo === "ja_atribuida") { definirFlash("erro", "Essa conversa já foi assumida por outra pessoa."); return renderWhatsapp(null); }
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
        const select = campo.querySelector("select");
        const ehAdmin = alvo.checked;
        campo.style.display = ehAdmin ? "none" : "";
        select.required = !ehAdmin;
        return;
      }
      case "enviar-foto-perfil": {
        const arquivo = alvo.files[0];
        if (!arquivo) return;
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
      case "filtrar-atividades": {
        state.filtroAtividadesUsuarioId = alvo.value || null;
        return renderAtividades();
      }
      case "limpar-busca-conversas": {
        state.buscaConversas = null;
        return renderWhatsapp(null);
      }
      case "abrir-nova-conversa": modalNovaConversa(); return;
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
      case "atualizar-foto-contato": {
        const id = Number(alvo.dataset.id);
        const resp = await chamarApi(`/whatsapp/conversas/${id}/atualizar-foto-contato`, { method: "POST" });
        definirFlash("ok", resp.foto_url ? "Foto atualizada." : "Esse contato não tem foto de perfil pública no momento.");
        return montarRota();
      }
      case "fechar-conversa": modalFecharConversa(Number(alvo.dataset.id)); return;
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
        const arquivo = alvo.files[0];
        if (!arquivo) return;
        if (arquivo.size > 35 * 1024 * 1024) { definirFlash("erro", "Arquivo maior que 35MB."); return renderWhatsapp(Number(alvo.dataset.conversaId)); }
        const conversaId = Number(alvo.dataset.conversaId);
        const formData = new FormData();
        formData.append("arquivo", arquivo);
        alvo.disabled = true;
        try {
          await fetch(`${API}/whatsapp/conversas/${conversaId}/anexo`, {
            method: "POST",
            headers: { Authorization: "Bearer " + state.accessToken },
            body: formData,
          }).then(async (resp) => {
            if (!resp.ok) {
              const corpo = await resp.json().catch(() => ({}));
              throw Object.assign(new Error(corpo.mensagem || `Erro ${resp.status}`), { status: resp.status });
            }
          });
        } finally {
          alvo.disabled = false;
        }
        return renderWhatsapp(conversaId);
      }
      case "alternar-gravacao-audio": {
        const conversaId = Number(alvo.dataset.id);
        if (_gravador && _gravador.state === "recording") {
          _gravador.stop(); // o resto acontece em onstop, registrado no início da gravação
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
          _atualizarBotaoGravacao(alvo, false);
          const blob = new Blob(_gravadorChunks, { type: "audio/webm" });
          if (blob.size < 800) { definirFlash("erro", "Gravação muito curta — tente de novo."); return; }
          const formData = new FormData();
          formData.append("arquivo", blob, "audio.webm");
          formData.append("tipo", "audio");
          definirFlash("ok", "Enviando áudio…");
          montarRota();
          try {
            await fetch(`${API}/whatsapp/conversas/${conversaId}/anexo`, {
              method: "POST",
              headers: { Authorization: "Bearer " + state.accessToken },
              body: formData,
            }).then(async (resp) => {
              if (!resp.ok) { const corpo = await resp.json().catch(() => ({})); throw new Error(corpo.mensagem || `Erro ${resp.status}`); }
            });
            definirFlash("ok", "Áudio enviado.");
          } catch (e) {
            definirFlash("erro", "Erro ao enviar áudio: " + e.message);
          }
          return renderWhatsapp(conversaId);
        };
        _gravador.start();
        _atualizarBotaoGravacao(alvo, true, 0);
        const inicioGravacao = Date.now();
        _gravadorTimer = setInterval(() => _atualizarBotaoGravacao(alvo, true, Date.now() - inicioGravacao), 500);
        return;
      }
      case "alternar-emoji": {
        const painel = alvo.parentElement.querySelector("[data-wpp-emoji-painel]");
        painel.hidden = !painel.hidden;
        return;
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
      case "abrir-tags-conversa": {
        const conversaId = Number(alvo.dataset.id);
        const marcadas = JSON.parse(alvo.dataset.tags || "[]");
        const todasTags = await chamarApi("/whatsapp/tags");
        modalTags(conversaId, todasTags, marcadas);
        return;
      }
      case "criar-tag-inline": {
        const form = alvo.closest("form");
        const nomeInput = form.querySelector('[name="nova_tag_nome"]');
        const nome = nomeInput.value.trim();
        if (!nome) return;
        const cor = form.querySelector('[name="nova_tag_cor"]').value;
        const nova = await chamarApi("/whatsapp/tags", { method: "POST", body: { nome, cor } });
        const marcadas = [...form.querySelectorAll('input[name="tag_ids"]:checked')].map((i) => Number(i.value));
        marcadas.push(nova.id);
        const conversaId = Number(form.dataset.conversaId);
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
        const resp = await chamarApi("/auth/login", { method: "POST", semAuth: true, body: { email, senha } });
        if (resp.requer_2fa) {
          state._aguardando2fa = true;
          state._loginPendente = { email, senha, lembrar: !!dados.get("lembrar") };
          return renderLogin();
        }
        return _finalizarLogin(resp, email, !!dados.get("lembrar"));
      }
      case "login-2fa": {
        const { email, senha, lembrar } = state._loginPendente || {};
        const resp = await chamarApi("/auth/login", {
          method: "POST", semAuth: true,
          body: { email, senha, codigo_2fa: dados.get("codigo_2fa") },
        });
        return _finalizarLogin(resp, email, lembrar);
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
      case "definir-tags-conversa": {
        const conversaId = Number(form.dataset.conversaId);
        const tagIds = dados.getAll("tag_ids").map(Number);
        await chamarApi(`/whatsapp/conversas/${conversaId}/tags`, { method: "PUT", body: { tag_ids: tagIds } });
        fecharModais();
        definirFlash("ok", "Etiquetas atualizadas.");
        return renderWhatsapp(conversaId);
      }
      case "criar-nota": {
        const conversaId = Number(form.dataset.conversaId);
        await chamarApi(`/whatsapp/conversas/${conversaId}/notas`, { method: "POST", body: { texto: dados.get("texto") } });
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
        const texto = (dados.get("texto") || "").trim();
        if (!texto) return;
        const conversaId = Number(form.dataset.conversaId);
        const textarea = form.querySelector("textarea");
        // Limpa e devolve o foco JÁ — não espera a resposta do servidor
        // pra parecer instantâneo (a mensagem sempre fica registrada do
        // lado do servidor mesmo se o envio real ao WhatsApp falhar, ver
        // routes/whatsapp.py::enviar_mensagem).
        form.reset();
        textarea.focus();
        await chamarApi(`/whatsapp/conversas/${conversaId}/mensagens`, { method: "POST", body: { texto } });
        // Atualização leve — só a lista de mensagens e a prévia na lista
        // de conversas, sem reconstruir a tela inteira (cabeçalho,
        // respostas prontas, notas, agendadas...) que é o que deixava
        // lento.
        await Promise.all([atualizarMensagensNoDom(conversaId), atualizarListaConversasNoDom()]);
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
        const texto = (dados.get("texto") || "").trim();
        if (!texto) return;
        const conversaId = Number(form.dataset.conversaId);
        const textarea = form.querySelector("textarea");
        form.reset();
        textarea.focus();
        await chamarApi(`/chat-interno/conversas/${conversaId}/mensagens`, { method: "POST", body: { texto } });
        await Promise.all([atualizarMensagensInternasNoDom(conversaId), atualizarListaConversasInternasNoDom()]);
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
            if (arquivo.size > 35 * 1024 * 1024) { definirFlash("erro", "Arquivo maior que 35MB."); return; }
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
      case "iniciar-conversa": {
        const resp = await chamarApi("/whatsapp/conversas", {
          method: "POST",
          body: { telefone: dados.get("telefone"), nome: dados.get("nome") || undefined, texto: dados.get("texto") },
        });
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
            setor: dados.get("setor") || undefined,
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
            setor: dados.get("setor") || undefined,
            offline_forcado: !!dados.get("offline_forcado"),
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
  montarRota();
})();
