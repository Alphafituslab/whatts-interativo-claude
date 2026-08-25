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
          case "_sem_acesso_conversas": break; // nunca casa; só pra deixar o switch legível
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
    { rota: "#/whatsapp", chave: "whatsapp", label: "Conversas", icone: "💬", exigeConversas: true },
    { rota: "#/chat-interno", chave: "chat-interno", label: "Chat interno", icone: "🗨️" },
    { rota: "#/agendamentos", chave: "agendamentos", label: "Agendamentos", icone: "🕒" },
    { rota: "#/lembretes", chave: "lembretes", label: "Lembretes", icone: "🔔" },
    { rota: "#/dashboard", chave: "dashboard", label: "Dashboard", icone: "📊", admin: true },
    { rota: "#/atividades", chave: "atividades", label: "Atividades", icone: "📋", admin: true },
    { rota: "#/seguranca", chave: "seguranca", label: "Segurança", icone: "🔒" },
    { rota: "#/configuracao", chave: "configuracao", label: "Configuração", icone: "⚙️", admin: true },
    { rota: "#/usuarios", chave: "usuarios", label: "Usuários", icone: "👥", admin: true },
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

  function renderShell(conteudoHtml, paginaAtiva) {
    const usuario = state.usuarioAtual;
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
         </button>`;

    const flashHtml = state.flash
      ? `<p class="${state.flash.tipo === "erro" ? "mensagem-erro" : "mensagem-ok"}">${escapeHtml(state.flash.texto)}</p>`
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
            ${usuario && usuario.admin ? `
              <button class="botao secundario pequeno" style="width:100%; margin-top:10px;" data-acao="instalar-app">📲 Instalar no aparelho</button>
              <a class="botao secundario pequeno" href="/downloads/" target="_blank" rel="noopener" style="display:block; text-align:center; text-decoration:none; margin-top:8px;">⬇ Instalar em outra máquina</a>` : ""}
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
    if (comNome.size > 35 * 1024 * 1024) {
      definirFlash("erro", "A imagem colada é maior que 35MB.");
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
    const item = e.target.closest("[data-wpp-conversa-id]");
    if (!item) return;
    e.preventDefault();
    const id = item.dataset.wppConversaId;
    const arquivada = item.dataset.wppArquivada === "1";
    const marcadas = JSON.parse(item.dataset.wppTags || "[]");
    const etiquetas = await obterEtiquetas();
    abrirMenuContexto(e.clientX, e.clientY, [
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
    const botaoEditar = nomeEl.querySelector('[data-acao="renomear-contato"], [data-acao="abrir-apelido-interno"]');
    if (!botaoEditar) return;
    e.preventDefault();
    const botaoTags = document.querySelector('[data-acao="abrir-tags-conversa"], [data-acao="abrir-tags-interna"]');
    if (!botaoTags) { botaoEditar.click(); return; }
    const interna = botaoTags.dataset.acao === "abrir-tags-interna"
      || botaoTags.getAttribute("data-acao") === "abrir-tags-interna";
    const id = botaoTags.dataset.id;
    const marcadas = JSON.parse(botaoTags.dataset.tags || "[]");
    const etiquetas = await obterEtiquetas();
    abrirMenuContexto(e.clientX, e.clientY, [
      { acao: interna ? "abrir-apelido-interno-menu" : "renomear-contato-menu", id,
        rotulo: interna ? "✏️ Editar como você chama esta pessoa" : "✏️ Editar nome do contato" },
      ..._itensEtiquetaMenu(id, marcadas, etiquetas, interna),
    ]);
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
    const teclas = (e) => {
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
    timerStatusGlobal = setInterval(() => { atualizarBolinhaStatusGlobal(); verificarVersaoServidor(); atualizarBadgeSla(); }, 20000);
    // Mais rápido que o resto — é o que avisa "chegou mensagem nova",
    // roda em qualquer tela (não só Conversas/Chat interno), pra piscar
    // o menu lateral mesmo se a pessoa estiver, por exemplo, no Dashboard.
    timerBadgesNaoLidos = setInterval(atualizarBadgesNaoLidos, 4000);
    // Follow-up muda em dias, não em segundos — 60s já é de sobra e
    // evita consulta pesada a cada 4s.
    atualizarContadorFollowup();
    setInterval(atualizarContadorFollowup, 60000);
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
      const [itens, agendadas, lembretes] = await Promise.all([
        chamarApi("/followup"),
        chamarApi("/whatsapp/agendadas").catch(() => []),
        chamarApi("/whatsapp/lembretes").catch(() => []),
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

      alvo.innerHTML = `
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
        if (badge) badge.textContent = `v${_versaoCurta(resp.versao)}`;
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
    const chips = etiquetas.map((t) => {
      const ativa = String(state.tagFiltroInterno) === String(t.id);
      return `<button type="button" class="wpp-tag-filtro ${ativa ? "ativa" : ""}"
                data-acao="filtrar-por-etiqueta-interno" data-id="${t.id}"
                style="--cor-etiqueta:${escapeHtml(t.cor || "#6b7280")};"
                title="${ativa ? "Clique de novo pra tirar o filtro" : `Ver só as conversas com a etiqueta ${escapeHtml(t.nome)}`}">
        ${escapeHtml(t.nome)}
      </button>`;
    }).join("");
    return `<div class="wpp-tags-filtro">
      ${chips}
      ${state.tagFiltroInterno ? `<button type="button" class="wpp-tag-filtro-limpar" data-acao="filtrar-por-etiqueta-interno" data-id="">✕ limpar</button>` : ""}
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
    const painel = document.querySelector("[data-wpp-mensagens-interno]");
    if (!painel) return;
    const conversas = await chamarApi(`/chat-interno/conversas${_queryChatInterno()}`);
    const conversa = conversas.find((c) => c.id === conversaId);
    if (!conversa) return;
    const mensagens = await chamarApi(`/chat-interno/conversas/${conversaId}/mensagens`);
    // Compara o HTML pronto: pega mensagem nova, mensagem apagada E o
    // ✓✓ do outro lado (que não cria mensagem nenhuma, e por isso
    // aparecia só na mensagem seguinte quando a checagem era só a
    // contagem).
    const estavaNoFim = painel.scrollTop + painel.clientHeight >= painel.scrollHeight - 40;
    const mudou = _sincronizarLista(painel, mensagens, (m) => m.id, (m) => htmlBolhaInterna(m, conversa));
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
      const naFila = !c.atribuida_usuario_id;
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
    }
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
        <audio controls preload="metadata" src="${urlImagemSegura(m.midia_url)}"></audio>
        <a class="wpp-bolha-baixar wpp-bolha-baixar-audio" href="${urlImagemSegura(m.midia_url)}" download title="Baixar áudio">⬇</a>
      </div>
      ${htmlTranscricao(m)}`;
    const rotulo = { documento: "📄 Documento" }[m.tipo] || "📎 Anexo";
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

  function htmlBolha(m) {
    const saida = m.direcao === "saida";
    const iconeStatus = { pendente: "🕓", enviada: "✓", entregue: "✓✓", lida: "✓✓", falhou: "⚠️", recebida: "" }[m.status] || "";
    return `<div class="wpp-bolha ${saida ? "wpp-bolha-saida" : "wpp-bolha-entrada"} ${m.status === "falhou" ? "wpp-bolha-falhou" : ""} ${m.excluida_em ? "wpp-bolha-apagada" : ""}" data-wpp-bolha-id="${m.id}">
      ${!saida && (m.autor_nome || m.autor_telefone)
        ? `<div class="wpp-bolha-autor" title="${escapeHtml(m.autor_telefone || "")}">${escapeHtml(m.autor_nome || m.autor_telefone)}</div>`
        : ""}
      ${htmlSeloApagada(m)}
      ${htmlCitacao(m)}
      ${htmlAnexoBolha(m)}
      ${m.texto ? `<div class="wpp-bolha-texto">${escapeHtml(m.texto)}</div>` : ""}
      ${m.reacao ? `<span class="wpp-reacao" title="O cliente reagiu a esta mensagem${m.reacao_em ? " em " + fmtData(m.reacao_em) : ""}">${escapeHtml(m.reacao)}</span>` : ""}
      <div class="wpp-bolha-rodape">
        ${!m.excluida_em ? `<button type="button" class="wpp-bolha-excluir" data-acao="abrir-reacao" data-id="${m.id}" title="Reagir a esta mensagem">😊</button>` : ""}
        ${!m.excluida_em ? `<button type="button" class="wpp-bolha-excluir" data-acao="citar-mensagem" data-id="${m.id}" data-interna="0" title="Responder citando esta mensagem">↩️</button>` : ""}
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

  function htmlChat(conversa, mensagens, agendadas, respostasProntas, notas, emojisSalvos, figurinhas) {
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
          <button type="button" class="botao-icone ${conversa.proximo_contato_em ? "wpp-icone-preenchido" : ""}" data-acao="abrir-agendar-contato" data-id="${conversa.id}" title="${conversa.proximo_contato_em ? "Próximo contato marcado pra " + fmtData(conversa.proximo_contato_em) : "Agendar próximo contato (o sistema para de cobrar até a data)"}">📞</button>
          ${conversa.sem_pendencia_em ? `<button type="button" class="botao secundario pequeno botao-sem-pendencia-ligado" data-acao="sem-pendencia" data-id="${conversa.id}" data-desmarcar="1" title="Esta conversa está marcada como resolvida e fora do alerta de atraso. Clique pra voltar a cobrar resposta.">✓ Sem pendência</button>`
            : `<button type="button" class="botao secundario pequeno" data-acao="sem-pendencia" data-id="${conversa.id}" title="Vi e não precisa responder — tira do alerta de atraso sem mandar mensagem">✓ Não precisa responder</button>`}
          <button type="button" class="botao secundario pequeno" data-acao="abrir-encaminhar" data-id="${conversa.id}">Encaminhar</button>
          ${fechada
            ? `<button type="button" class="botao secundario pequeno" data-acao="reabrir-conversa" data-id="${conversa.id}">Reabrir</button>`
            : `<button type="button" class="botao secundario pequeno" data-acao="fechar-conversa" data-id="${conversa.id}">Encerrar atendimento</button>`}
          <button type="button" class="botao-icone" data-acao="${conversa.arquivada ? "desarquivar-conversa" : "arquivar-conversa"}" data-id="${conversa.id}" title="${conversa.arquivada ? "Desarquivar" : "Arquivar"}">${conversa.arquivada ? "📤" : "🗄️"}</button>
          <button type="button" class="botao-icone" data-acao="excluir-conversa" data-id="${conversa.id}" title="Excluir conversa">🗑️</button>
        </div>
      </div>
      <div class="wpp-tags-linha">
        ${(conversa.tags || []).map((t) => `<span class="wpp-tag-chip" style="background:${t.cor};">${escapeHtml(t.nome)}<button type="button" class="wpp-tag-tirar" data-acao="tirar-etiqueta" data-id="${conversa.id}" data-tag="${t.id}" data-interna="0" title="Tirar a etiqueta ${escapeHtml(t.nome)} desta conversa">✕</button></span>`).join("")}
        <button type="button" class="wpp-tag-adicionar ${(conversa.tags || []).length ? "" : "wpp-tag-adicionar-vazio"}" data-acao="abrir-tags-conversa" data-id="${conversa.id}" data-tags='${escapeHtml(JSON.stringify((conversa.tags || []).map((t) => t.id)))}' title="Marcar este cliente com uma etiqueta sua — só você vê, e depois dá pra filtrar a lista por ela">${(conversa.tags || []).length ? "+ etiqueta" : "🏷️ Etiquetar cliente"}</button>
      </div>
      ${htmlNotas(conversa.id, notas || [])}
      ${conversa.sugerir_encerrar ? `
        <div class="wpp-lembrar-encerrar">
          <span>Este atendimento está parado há mais de ${conversa.horas_sugerir_encerrar || 24}h. Se já terminou, encerre — assim o cliente passa pelo menu de novo quando voltar.</span>
          <button type="button" class="botao pequeno" data-acao="fechar-conversa" data-id="${conversa.id}">Encerrar atendimento</button>
        </div>` : ""}
      ${fechada ? `<p class="wpp-conversa-fechada-aviso">Esta conversa está fechada${conversa.aguardando_avaliacao ? " — aguardando avaliação do cliente" : ""}. Responder ou reabrir a torna ativa de novo.</p>` : ""}
      <div class="wpp-mensagens" data-wpp-mensagens>${mensagens.map(htmlBolha).join("")}</div>
      ${htmlAgendadas(agendadas)}
      <div data-wpp-citando></div>
      <form class="wpp-chat-input" data-form="enviar-mensagem" data-conversa-id="${conversa.id}">
        <input type="file" class="wpp-input-arquivo-oculto" data-acao-change="anexar-arquivo" data-conversa-id="${conversa.id}" hidden>
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
        <textarea name="texto" class="wpp-textarea" placeholder="Digite uma mensagem…" rows="1"></textarea>
        <button type="button" class="botao-icone" data-acao="alternar-gravacao-audio" data-id="${conversa.id}" title="Gravar áudio">🎙️</button>
        <button type="button" class="botao-icone" data-acao="gravar-video" data-id="${conversa.id}" title="Gravar vídeo pela câmera">🎥</button>
        <button type="button" class="botao-icone" data-acao="abrir-agendar" data-id="${conversa.id}" title="Agendar envio">🕒</button>
        <button type="submit" class="botao wpp-botao-enviar" title="Enviar">➤</button>
      </form>`;
  }

  function htmlAbasConversas() {
    const usuario = state.usuarioAtual;
    const abas = [
      { chave: "minhas", label: "Minhas", dica: "Conversas em andamento — você já respondeu, aguardando o cliente" },
      { chave: "fila", label: "Fila", dica: "Clientes que ainda são de ninguém, esperando alguém assumir — do seu setor, mais os que não escolheram setor e já esperaram demais" },
      { chave: "sem_menu", label: "Sem escolha", dica: "Clientes que escreveram e não escolheram nenhum número do menu. Passados alguns minutos, eles também entram na Fila de todos, até alguém assumir." },
    ];
    if (usuario.admin) abas.push({ chave: "todas", label: "Todas" });
    abas.push({ chave: "arquivadas", label: "Arquivadas" });
    // O número em cada aba evita ter que clicar pra descobrir se caiu
    // alguém. Fila e "Sem escolha" piscam quando têm gente esperando:
    // ali o tempo conta, e ninguém está olhando pra aba o tempo todo.
    const cont = state.contagemAbas || {};
    return `<div class="wpp-abas">${abas.map((a) => {
      const n = cont[a.chave];
      const urgente = (a.chave === "fila" || a.chave === "sem_menu") && n > 0;
      const naoLidas = a.chave === "minhas" && cont.minhas_nao_lidas > 0;
      const selo = (n === null || n === undefined || n === 0)
        ? ""
        : `<span class="wpp-aba-contador ${urgente ? "wpp-aba-contador-urgente piscando" : ""} ${naoLidas ? "wpp-aba-contador-novas" : ""}">${n > 99 ? "99+" : n}</span>`;
      return `<button type="button" class="wpp-aba ${state.escopoConversas === a.chave ? "ativa" : ""}" data-acao="trocar-escopo-conversas" data-escopo="${a.chave}"${a.dica ? ` title="${escapeHtml(a.dica)}"` : ""}>${a.label}${selo}</button>`;
    }).join("")}</div>`;
  }

  // Barra de etiquetas: clicar filtra a lista, clicar de novo tira o
  // filtro. Fica escondida se a empresa ainda não criou nenhuma — sem
  // etiqueta cadastrada a barra seria só um espaço vazio ocupando lugar.
  function htmlFiltroEtiquetas(etiquetas, contagem) {
    if (!etiquetas || !etiquetas.length) return "";
    const chips = etiquetas.map((t) => {
      const total = (contagem || {})[String(t.id)] || 0;
      const ativa = String(state.tagFiltro) === String(t.id);
      return `<button type="button" class="wpp-tag-filtro ${ativa ? "ativa" : ""}"
                data-acao="filtrar-por-etiqueta" data-id="${t.id}"
                style="--cor-etiqueta:${escapeHtml(t.cor || "#6b7280")};"
                title="${ativa ? "Clique de novo pra tirar o filtro" : `Ver só as conversas com a etiqueta ${escapeHtml(t.nome)}`}">
        ${escapeHtml(t.nome)}${total ? ` <span class="wpp-tag-filtro-n">${total}</span>` : ""}
      </button>`;
    }).join("");
    return `<div class="wpp-tags-filtro">
      ${chips}
      ${state.tagFiltro ? `<button type="button" class="wpp-tag-filtro-limpar" data-acao="filtrar-por-etiqueta" data-id="">✕ limpar</button>` : ""}
    </div>`;
  }

  function _queryConversas() {
    const arquivadas = state.escopoConversas === "arquivadas";
    // "sem_menu" vai direto pro servidor, que já sabe filtrar.
    const escopoQuery = arquivadas ? (state.usuarioAtual.admin ? "todas" : "minhas") : state.escopoConversas;
    const etiqueta = state.tagFiltro ? `&tag_id=${state.tagFiltro}` : "";
    return `escopo=${escopoQuery}${arquivadas ? "&arquivadas=1" : ""}${etiqueta}`;
  }

  async function renderWhatsapp(conversaId) {
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
    let conversas;
    let contatosSemConversa = [];
    if (state.buscaConversas) {
      // A busca de conversas parte das CONVERSAS, então um contato salvo
      // que nunca escreveu não apareceria nunca. Procura na agenda
      // também e mostra à parte, com botão pra iniciar a conversa.
      const [achadas, contatos] = await Promise.all([
        chamarApi(`/whatsapp/conversas/buscar?q=${encodeURIComponent(state.buscaConversas)}`),
        chamarApi(`/whatsapp/contatos?q=${encodeURIComponent(state.buscaConversas)}`).catch(() => []),
      ]);
      conversas = achadas;
      const telefonesComConversa = new Set(achadas.map((c) => c.telefone));
      contatosSemConversa = contatos.filter((c) => !telefonesComConversa.has(c.telefone));
    } else {
      conversas = await chamarApi(`/whatsapp/conversas?${_queryConversas()}`);
    }

    // Etiquetas e a contagem de cada uma alimentam a barra de filtro.
    // Falhar aqui não pode derrubar a tela de conversas inteira.
    const [etiquetas, contagemEtiquetas, contagemAbas] = await Promise.all([
      chamarApi("/whatsapp/tags").catch(() => []),
      chamarApi("/whatsapp/tags/contagem").catch(() => ({})),
      chamarApi("/whatsapp/contagem-abas").catch(() => ({})),
    ]);
    state.contagemAbas = contagemAbas;

    let conversaAtual = null, mensagens = [], agendadas = [], respostasProntas = [], notas = [];
    let emojisSalvos = [], figurinhas = [];
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
        [mensagens, agendadas, respostasProntas, notas, emojisSalvos, figurinhas] = await Promise.all([
          chamarApi(`/whatsapp/conversas/${conversaId}/mensagens`),
          chamarApi(`/whatsapp/conversas/${conversaId}/agendadas`),
          obterRespostasProntas(),
          chamarApi(`/whatsapp/conversas/${conversaId}/notas`),
          obterEmojisSalvos(),
          obterFigurinhas(),
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
             <input type="search" name="q" class="wpp-busca-input" placeholder="Buscar por nome, telefone ou mensagem…" autocomplete="off" value="${escapeHtml(state.buscaConversas || "")}">
             <button type="submit" class="botao-icone" title="Buscar">🔍</button>
             <button type="button" class="botao-icone" data-acao="abrir-contatos" title="Ver todos os contatos salvos">📇</button>
             ${state.buscaConversas ? `<button type="button" class="botao-icone" data-acao="limpar-busca-conversas" title="Limpar busca">✕</button>` : ""}
           </form>
           ${state.buscaConversas ? `<p class="texto-suave" style="padding:0 4px 8px;">Resultados para "${escapeHtml(state.buscaConversas)}"</p>` : htmlAbasConversas() + htmlFiltroEtiquetas(etiquetas, contagemEtiquetas)}
           <div class="wpp-lista-conversas" data-wpp-lista>${htmlListaConversas(conversas, conversaId)}${htmlContatosDaBusca(contatosSemConversa)}</div>
         </div>
         <div class="wpp-painel-chat">${htmlChat(conversaAtual, mensagens, agendadas, respostasProntas, notas, emojisSalvos, figurinhas)}</div>
       </div>`,
      "whatsapp"
    );

    const painelMensagens = document.querySelector("[data-wpp-mensagens]");
    if (painelMensagens) painelMensagens.scrollTop = painelMensagens.scrollHeight;
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
    if (state.buscaConversas) return; // não sobrescreve um resultado de busca ativo
    const conversas = await chamarApi(`/whatsapp/conversas?${_queryConversas()}`);
    const conversaAtivaId = Number(location.hash.split("/")[2]) || null;
    if (!conversas.length) { _pintarSeMudou(lista, htmlListaConversas(conversas, conversaAtivaId)); return; }
    lista._htmlPintado = null;
    _sincronizarLista(lista, conversas, (c) => c.id, (c) => htmlItemConversa(c, conversaAtivaId));
  }

  async function atualizarMensagensNoDom(conversaId) {
    const painel = document.querySelector("[data-wpp-mensagens]");
    if (!painel) return;
    const mensagens = await chamarApi(`/whatsapp/conversas/${conversaId}/mensagens`);
    const estavaNoFim = painel.scrollTop + painel.clientHeight >= painel.scrollHeight - 40;
    const mudou = _sincronizarLista(painel, mensagens, (m) => m.id, htmlBolha);
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
      ${ehCliente ? `<p class="dica"><strong>Atenção:</strong> a correção vale aqui dentro do sistema. No celular do cliente a mensagem continua como foi enviada — o WhatsApp não permite reescrever o que já chegou. Para o cliente ver o texto certo, apague e mande de novo.</p>` : `<p class="dica">A mensagem passa a mostrar "editada", pra outra pessoa saber que o texto mudou.</p>`}
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
      const outraFoto = souCriador ? c.participante_foto : (souAlheio ? c.participante_foto : c.criado_por_foto);
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
          ${c.setor_destino || c.status === "fechada" ? `<div class="wpp-conversa-dono">${c.setor_destino ? `🏷️ ${escapeHtml(c.setor_destino)}` : ""}${c.status === "fechada" ? ' · <span class="selo inativo">Fechada</span>' : ""}</div>` : ""}
          ${(c.tags || []).length ? `<div class="wpp-tags-linha wpp-tags-linha-lista">${c.tags.map((t) => `<span class="wpp-tag-chip" style="background:${t.cor};">${escapeHtml(t.nome)}</span>`).join("")}</div>` : ""}
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
    if (!vistoOutro) return `<span class="wpp-bolha-status" title="Enviada">✓</span>`;
    const lida = new Date(vistoOutro) >= new Date(m.criado_em);
    return lida
      ? `<span class="wpp-bolha-status wpp-status-lida" title="Visualizada em ${fmtData(vistoOutro)}">✓✓</span>`
      : `<span class="wpp-bolha-status" title="Enviada — ainda não visualizada">✓</span>`;
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
      ${!saida || souAlheio ? `<div class="texto-suave" style="font-size:11px; font-weight:700; margin-bottom:2px;">${escapeHtml(nomeAutor)}</div>` : ""}
      ${htmlSeloApagada(m)}
      ${htmlCitacao(m)}
      ${htmlAnexoBolha(m)}
      ${m.texto ? `<div class="wpp-bolha-texto">${escapeHtml(m.texto)}</div>` : ""}
      <div class="wpp-bolha-rodape">
        ${!m.excluida_em ? `<button type="button" class="wpp-bolha-excluir" data-acao="citar-mensagem" data-id="${m.id}" data-interna="1" title="Responder citando esta mensagem">↩️</button>` : ""}
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
    const fechada = conversa.status === "fechada";
    return `
      <div class="wpp-chat-cabecalho">
        <button type="button" class="botao-icone wpp-botao-voltar" data-acao="voltar-lista-interno" title="Voltar">←</button>
        <span style="position:relative; flex-shrink:0;">
          ${htmlAvatarContato(souCriador ? conversa.participante_foto : conversa.criado_por_foto, outroNome, outroNome, 36)}
          <span class="wpp-online-bolinha ${(souCriador ? conversa.participante_online : conversa.criado_por_online) ? "wpp-online-sim" : "wpp-online-nao"}"></span>
        </span>
        <div style="flex:1; min-width:0;">
          <div class="wpp-chat-nome">${escapeHtml(outroNome)}${souAlheio ? "" : ` <button type="button" class="botao-icone" style="width:20px; height:20px; font-size:11px; vertical-align:middle;" data-acao="abrir-apelido-interno" data-conversa-id="${conversa.id}" data-apelido="${escapeHtml(outroNome)}" title="Definir apelido (só você vê)">✏️</button>`}</div>
          <div class="texto-suave wpp-chat-telefone">
            ${htmlSeloPresenca(souCriador ? conversa.participante_online : conversa.criado_por_online, souCriador ? conversa.participante_ausente : conversa.criado_por_ausente, souCriador ? conversa.participante_ausente_motivo : conversa.criado_por_ausente_motivo)}
            ${souAlheio ? " · 👁️ supervisionando — a leitura não marca a mensagem como vista pra eles" : ""}${conversa.setor_destino ? ` · 🏷️ ${escapeHtml(conversa.setor_destino)}` : ""}
          </div>
        </div>
        <div class="wpp-chat-acoes">
          <button type="button" class="botao-icone" data-acao="abrir-lembrete-interno" data-id="${conversa.id}" title="Criar lembrete (avisa só você)">🔔</button>
          <button type="button" class="botao-icone" data-acao="abrir-agendar-interno" data-id="${conversa.id}" title="Agendar mensagem pro colega">🕒</button>
          <button type="button" class="botao secundario pequeno" data-acao="abrir-encaminhar-interno" data-id="${conversa.id}">Encaminhar</button>
          ${fechada
            ? `<button type="button" class="botao secundario pequeno" data-acao="reabrir-interno" data-id="${conversa.id}">Reabrir</button>`
            : `<button type="button" class="botao secundario pequeno" data-acao="fechar-interno" data-id="${conversa.id}">Encerrar atendimento</button>`}
        </div>
      </div>
      <div class="wpp-tags-linha">
        ${(conversa.tags || []).map((t) => `<span class="wpp-tag-chip" style="background:${t.cor};">${escapeHtml(t.nome)}<button type="button" class="wpp-tag-tirar" data-acao="tirar-etiqueta" data-id="${conversa.id}" data-tag="${t.id}" data-interna="1" title="Tirar a etiqueta ${escapeHtml(t.nome)} desta conversa">✕</button></span>`).join("")}
        <button type="button" class="wpp-tag-adicionar ${(conversa.tags || []).length ? "" : "wpp-tag-adicionar-vazio"}" data-acao="abrir-tags-interna" data-id="${conversa.id}" data-tags='${escapeHtml(JSON.stringify((conversa.tags || []).map((t) => t.id)))}' title="Etiquetar esta conversa — só você vê, e depois dá pra filtrar a lista por ela">${(conversa.tags || []).length ? "+ etiqueta" : "🏷️ Etiquetar conversa"}</button>
      </div>
      ${fechada ? `<p class="wpp-conversa-fechada-aviso">Esta conversa está fechada. Responder ou reabrir a torna ativa de novo.</p>` : ""}
      <div class="wpp-mensagens" data-wpp-mensagens-interno>${mensagens.map((m) => htmlBolhaInterna(m, conversa)).join("")}</div>
      <div data-wpp-citando></div>
      <form class="wpp-chat-input" data-form="enviar-mensagem-interna" data-conversa-id="${conversa.id}">
        <input type="file" class="wpp-input-arquivo-oculto" data-acao-change="anexar-arquivo-interno" data-conversa-id="${conversa.id}" hidden>
        <button type="button" class="botao-icone" data-acao="abrir-seletor-arquivo" title="Anexar imagem, vídeo ou documento">📎</button>
        <div class="wpp-emoji-envolucro">
          <button type="button" class="botao-icone" data-acao="alternar-emoji" title="Emoji">😀</button>
          <div class="wpp-emoji-painel" data-wpp-emoji-painel hidden>${EMOJIS_COMUNS.map((e) => `<button type="button" class="wpp-emoji-item" data-acao="inserir-emoji" data-emoji="${e}">${e}</button>`).join("")}</div>
        </div>
        <textarea name="texto" class="wpp-textarea" placeholder="Digite uma mensagem…" rows="1"></textarea>
        <button type="button" class="botao-icone" data-acao="alternar-gravacao-audio-interno" data-id="${conversa.id}" title="Gravar áudio">🎙️</button>
        <button type="button" class="botao-icone" data-acao="gravar-video-interno" data-id="${conversa.id}" title="Gravar vídeo pela câmera">🎥</button>
        <button type="submit" class="botao wpp-botao-enviar" title="Enviar">➤</button>
      </form>`;
  }

  // Trocar de conversa/tela descarta a citação pendente — citar algo numa
  // conversa e mandar em outra seria confuso (e o servidor recusaria).
  function _limparCitacaoSeTrocou(chave) {
    if (state._citandoDe !== chave) { state.citando = null; state._citandoDe = chave; }
  }

  async function renderChatInterno(conversaId) {
    _limparCitacaoSeTrocou(`interno:${conversaId}`);
    _carregandoSeTrocouDeTela("chat-interno");
    const etiquetas = await obterEtiquetas();
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
           ${htmlFiltroEtiquetasInterno(etiquetas)}
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

  // Todos os setores da pessoa, pra rótulo e filtro. Uma pessoa pode
  // atender mais de um (ex.: Televendas e Financeiro), e olhar só o
  // principal a faria sumir da lista ao filtrar pelo segundo.
  function _setoresDoColega(u) {
    if (u.setores && u.setores.length) return u.setores;
    return u.setor ? [u.setor] : [];
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
    _carregandoSeTrocouDeTela("configuracao");
    const etiquetas = await chamarApi("/whatsapp/tags").catch(() => []);
    // Backup é do banco inteiro (todas as empresas), então só quem opera
    // a plataforma tem acesso — o servidor barra de qualquer jeito, aqui
    // é só pra não mostrar uma seção que daria erro ao usar.
    const ehSuperAdmin = !!state.usuarioAtual.super_admin;
    const [{ config, webhookUrl }, setoresDetalhado, backups] = await Promise.all([
      buscarConfigECriarWebhookUrl(),
      chamarApi("/usuarios/setores/detalhado"),
      ehSuperAdmin ? chamarApi("/sistema/backups") : Promise.resolve([]),
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

       ${!ehSuperAdmin ? "" : `
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
           <p class="dica">Lembretes são criados <strong>dentro da conversa</strong>: abra o cliente em <a href="#/whatsapp">Conversas</a> e clique no 🔔 no topo. Serve pra você não esquecer de algo — só você é avisado.</p>`}
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
  async function renderUsuarios() {
    _carregandoSeTrocouDeTela("usuarios");
    const [usuarios, setores] = await Promise.all([chamarApi("/usuarios"), chamarApi("/usuarios/setores")]);
    const linhas = usuarios.map((u) => `
      <tr>
        <td style="position:relative;"><button type="button" class="wpp-avatar-botao" data-acao="abrir-seletor-foto-usuario" data-id="${u.id}" title="Trocar a foto de ${escapeHtml(u.nome)}">${htmlAvatar(u, 28)}</button><span class="wpp-online-bolinha ${u.online ? "wpp-online-sim" : "wpp-online-nao"}" title="${u.online ? "Online agora" : "Offline"}"></span></td>
        <td>${escapeHtml(u.nome)}</td>
        <td class="texto-suave">${escapeHtml(u.email)}</td>
        <td class="texto-suave">${(u.setores && u.setores.length) ? u.setores.map((s) => escapeHtml(s)).join(", ") : escapeHtml(u.setor || "—")}${u.acesso_conversas === false ? ' <span class="selo inativo" title="Não vê as conversas de clientes">só chat interno</span>' : ""}</td>
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
      case "instalar-app": {
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
          const passoApple = `
            <div class="escolha-item" style="cursor:default; align-items:flex-start;">
              <span class="escolha-texto"><strong>🍎 iPhone e iPad (Safari)</strong>
                <span class="escolha-ajuda">1. Toque no botão <strong>Compartilhar</strong> (o quadrado com a seta pra cima, embaixo).<br>
                2. Role a lista e escolha <strong>Adicionar à Tela de Início</strong>.<br>
                3. Toque em <strong>Adicionar</strong>.<br>
                <em>Só funciona pelo Safari — pelo Chrome do iPhone essa opção não existe.</em></span></span>
            </div>`;
          const passoAndroid = `
            <div class="escolha-item" style="cursor:default; align-items:flex-start;">
              <span class="escolha-texto"><strong>🤖 Android (Chrome)</strong>
                <span class="escolha-ajuda">1. Toque em <strong>⋮</strong> no canto superior direito.<br>
                2. Escolha <strong>Instalar app</strong> (ou "Adicionar à tela inicial").<br>
                3. Confirme.</span></span>
            </div>`;
          return abrirModal(`
            <h3 style="margin-top:0;">📲 Instalar no aparelho</h3>
            ${jaInstalado
              ? `<p class="dica">Você já está usando o app instalado — não precisa instalar de novo.</p>`
              : `<p class="dica">Este navegador não ofereceu o atalho automático, então é pelo menu dele. Leva uns 10 segundos:</p>`}
            <div class="escolha-lista">
              ${ehApple ? passoApple + passoAndroid : passoAndroid + passoApple}
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
        const bolha = alvo.closest(".wpp-bolha");
        const jaTem = bolha && bolha.querySelector(".wpp-reacao");
        document.querySelectorAll(".wpp-reacao-painel").forEach((p) => p.remove());
        const painel = document.createElement("div");
        painel.className = "wpp-reacao-painel";
        painel.innerHTML = rapidas.map((e) =>
          `<button type="button" class="wpp-reacao-opcao" data-acao="reagir" data-id="${id}" data-emoji="${e}">${e}</button>`
        ).join("") + (jaTem
          ? `<button type="button" class="wpp-reacao-opcao wpp-reacao-tirar" data-acao="reagir" data-id="${id}" data-emoji="" title="Tirar a reação">✕</button>`
          : "");
        alvo.parentElement.appendChild(painel);
        setTimeout(() => document.addEventListener("click", function fechar(ev) {
          if (painel.contains(ev.target)) return;
          painel.remove();
          document.removeEventListener("click", fechar);
        }), 0);
        return;
      }
      case "reagir": {
        const conversaId = Number(location.hash.split("/")[2]);
        const id = Number(alvo.dataset.id);
        document.querySelectorAll(".wpp-reacao-painel").forEach((p) => p.remove());
        const r = await chamarApi(`/whatsapp/conversas/${conversaId}/mensagens/${id}/reagir`, {
          method: "POST", body: { emoji: alvo.dataset.emoji },
        });
        if (!r.enviada_ao_cliente && alvo.dataset.emoji) {
          definirFlash("erro", "A reação ficou registrada aqui, mas o WhatsApp não aceitou enviá-la ao cliente.");
        }
        return atualizarMensagensNoDom(conversaId);
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
        // Redesenha pra transcrição aparecer embaixo do áudio — e ela já
        // vem junto das mensagens daqui pra frente, sem pedir de novo.
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
      case "filtrar-atividades": {
        state.filtroAtividadesUsuarioId = alvo.value || null;
        return renderAtividades();
      }
      case "limpar-busca-conversas": {
        state.buscaConversas = null;
        return renderWhatsapp(null);
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
          await chamarApi(`/whatsapp/conversas/${conversaId}/mensagens/${id}`, { method: "PUT", body: { texto } });
          fecharModais();
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
        const arquivo = alvo.files[0];
        if (!arquivo) return;
        const conversaId = Number(alvo.dataset.conversaId);
        if (arquivo.size > 35 * 1024 * 1024) { definirFlash("erro", "Arquivo maior que 35MB."); return renderChatInterno(conversaId); }
        alvo.disabled = true;
        try {
          await _subirAnexo(`${API}/chat-interno/conversas/${conversaId}/anexo`, arquivo);
        } finally {
          alvo.disabled = false;
        }
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
      case "abrir-agendar-contato": {
        modalAgendarContato(Number(alvo.dataset.id));
        return;
      }
      case "abrir-adiar": {
        modalAdiar(Number(alvo.dataset.id));
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
        form.reset();
        textarea.focus();
        const citada = state.citando && !state.citando.interna ? state.citando.id : null;
        state.citando = null;
        _desenharBarraCitacao();
        await chamarApi(`/whatsapp/conversas/${conversaId}/mensagens`, { method: "POST", body: { texto, responde_a: citada } });
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
        // Se está gravando, a seta encerra e manda o áudio — não o texto.
        if (_pararEEnviarAudio()) return;
        const texto = (dados.get("texto") || "").trim();
        if (!texto) return;
        const conversaId = Number(form.dataset.conversaId);
        const textarea = form.querySelector("textarea");
        form.reset();
        textarea.focus();
        // Pega e já limpa a citação: se o envio falhar, a pessoa reescreve
        // e cita de novo — pior seria a citação ficar grudada e a próxima
        // mensagem sair respondendo algo que ela nem quis citar.
        const citada = state.citando && state.citando.interna ? state.citando.id : null;
        state.citando = null;
        _desenharBarraCitacao();
        await chamarApi(`/chat-interno/conversas/${conversaId}/mensagens`, { method: "POST", body: { texto, responde_a: citada } });
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
