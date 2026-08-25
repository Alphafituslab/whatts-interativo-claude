# ============================================================
#  Seja Alpha - cria o atalho da area de trabalho
#
#  Nao instala programa nenhum e nao precisa de administrador:
#  so cria um atalho que abre o sistema em modo aplicativo
#  (janela limpa, sem barra de endereco nem abas), com a logo da
#  empresa como icone.
#
#  A logo e baixada do proprio sistema, entao quando a empresa
#  trocar a logo la, basta rodar isto de novo pra atualizar.
# ============================================================

$ErrorActionPreference = 'Stop'
$SISTEMA_URL = 'https://whatts.alphafitus.com.br'
$ICONE_URL   = "$SISTEMA_URL/static/img/whatts_inbox.ico"
$NOME_ATALHO = 'Seja Alpha'

function Escrever($texto, $cor = 'White') { Write-Host $texto -ForegroundColor $cor }

Escrever ''
Escrever '  ============================================' Cyan
Escrever '   Seja Alpha - instalando o atalho' Cyan
Escrever '  ============================================' Cyan
Escrever ''

# --- 1. Achar um navegador que suporte modo aplicativo -------
# Chrome e Edge aceitam --app=URL, que abre sem barra de endereco.
# Edge existe em todo Windows 10/11, entao serve de reserva.
$candidatos = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$navegador = $candidatos | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $navegador) {
    Escrever '  [X] Nao encontrei Chrome nem Edge neste computador.' Red
    Escrever '      Instale o Google Chrome e rode este arquivo de novo.' Red
    Escrever ''
    Read-Host '  Pressione Enter para fechar'
    exit 1
}
$nomeNavegador = if ($navegador -like '*chrome.exe') { 'Google Chrome' } else { 'Microsoft Edge' }
Escrever "  [1/5] Navegador encontrado: $nomeNavegador" Green

# --- 2. Baixar a logo pra usar de icone ----------------------
$pastaIcone = Join-Path $env:LOCALAPPDATA 'WhattsInbox'
$caminhoIcone = Join-Path $pastaIcone 'whatts_inbox.ico'
if (-not (Test-Path $pastaIcone)) { New-Item -ItemType Directory -Path $pastaIcone -Force | Out-Null }

$temIcone = $false
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $ICONE_URL -OutFile $caminhoIcone -UseBasicParsing -TimeoutSec 30
    # Um .ico valido tem pelo menos alguns KB; se vier vazio ou uma
    # pagina de erro HTML, melhor usar o icone do navegador do que
    # deixar um atalho com icone quebrado.
    if ((Get-Item $caminhoIcone).Length -gt 1000) {
        $temIcone = $true
        Escrever '  [2/5] Logo da empresa baixada' Green
    }
} catch {
    # sem internet ou servidor fora do ar: segue sem icone proprio
}
if (-not $temIcone) {
    Escrever '  [2/5] Nao consegui baixar a logo - usando o icone padrao' Yellow
}

# --- 3. Criar o atalho na area de trabalho -------------------
$areaTrabalho = [Environment]::GetFolderPath('Desktop')
$caminhoAtalho = Join-Path $areaTrabalho "$NOME_ATALHO.lnk"

$shell = New-Object -ComObject WScript.Shell
$atalho = $shell.CreateShortcut($caminhoAtalho)
$atalho.TargetPath  = $navegador
$atalho.Arguments   = "--app=$SISTEMA_URL"
$atalho.Description = 'Seja Alpha - atendimento de WhatsApp'
if ($temIcone) { $atalho.IconLocation = "$caminhoIcone,0" }
$atalho.Save()

Escrever '  [3/5] Atalho criado na area de trabalho' Green

# --- 4. Deixar os icones da area de trabalho grandes ---------
# O tamanho dos icones da area de trabalho e uma preferencia do Windows,
# por usuario - nenhum atalho consegue mandar nisso sozinho. Mas o
# instalador pode ajustar a preferencia, e assim toda maquina onde ele
# rodar ja fica com o icone grande, sem ninguem ter que configurar.
#
# 32 = pequenos (padrao), 48 = medios, 96 = grandes, 256 = extra
# grandes. Usamos 96, que e o "Icones grandes" do menu Exibir: da pra
# ver bem e ainda cabe bastante coisa na tela.
$TAMANHO_ICONE = 96
try {
    $chaves = @(
        'HKCU:\Software\Microsoft\Windows\Shell\Bags\1\Desktop',
        'HKCU:\Software\Microsoft\Windows\Shell\Bags\1\DesktopNew'
    )
    # So o IconSize, de proposito. Mexer tambem em Mode/LogicalViewMode/
    # FFlags e o que costuma baguncar a area de trabalho de quem ja
    # tinha um arranjo proprio - e nao e preciso: o tamanho sozinho ja
    # faz o efeito.
    foreach ($chave in $chaves) {
        if (-not (Test-Path $chave)) { New-Item -Path $chave -Force | Out-Null }
        New-ItemProperty -Path $chave -Name 'IconSize' -Value $TAMANHO_ICONE -PropertyType DWord -Force | Out-Null
    }
    Escrever '  [4/5] Icones da area de trabalho ajustados para grandes' Green
} catch {
    Escrever '  [4/5] Nao consegui ajustar o tamanho dos icones (siga o aviso no final)' Yellow
}

# --- 5. Forcar o Windows a reler o icone ---------------------
# O Windows guarda os icones num cache proprio. Quem ja tinha o atalho
# continuaria vendo o icone antigo mesmo com o arquivo novo no lugar.
# Limpar o cache e reiniciar o Explorer evita ter que reiniciar o
# computador so por causa disso - e e o que faz o tamanho novo dos
# icones valer na hora.
Escrever ''
Escrever '  A area de trabalho precisa ser recarregada para o icone' Yellow
Escrever '  novo e o tamanho maior aparecerem. Isso fecha as janelas' Yellow
Escrever '  de pastas que estiverem abertas (nada de programa fecha).' Yellow
$resposta = Read-Host '  Recarregar agora? (S/n)'
if ($resposta -eq 'n' -or $resposta -eq 'N') {
    Escrever '  [5/5] Tudo bem - o icone entra no proximo logon' DarkGray
} else {
    try {
        ie4uinit.exe -show 2>$null
        Start-Sleep -Milliseconds 400
        Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
        if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
        Escrever '  [5/5] Area de trabalho recarregada' Green
    } catch {
        # em algumas versoes do Windows um destes comandos nao existe;
        # sem problema, o icone e o tamanho entram no proximo logon
    }
}
Escrever ''
Escrever '  ============================================' Cyan
Escrever '   Pronto!' Green
Escrever ''
Escrever "   Procure o atalho '$NOME_ATALHO' na sua" White
Escrever '   area de trabalho e clique duas vezes.' White
Escrever ''
Escrever '   Os icones da area de trabalho ja ficaram grandes.' DarkGray
Escrever '   Para mudar depois: botao direito num espaco vazio' DarkGray
Escrever '   da area de trabalho, Exibir, e escolha o tamanho.' DarkGray
Escrever ''
Escrever '   Se o icone ainda aparecer como o do navegador,' DarkGray
Escrever '   faca logoff e login que ele troca.' DarkGray
Escrever '  ============================================' Cyan
Escrever ''
Read-Host '  Pressione Enter para fechar'
