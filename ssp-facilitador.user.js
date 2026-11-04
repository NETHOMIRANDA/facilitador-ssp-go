// ==UserScript==
// @name         Facilitador de Atendimento SSP-GO (Móvel / Policial Militar)
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Agiliza o preenchimento de atendimentos e registro de RAI no celular para Policiais Militares (SSP-GO).
// @author       PMGO / SSP-GO Helper
// @match        *://atendimento.ssp.go.gov.br/*
// @match        https://atendimento.ssp.go.gov.br/#/atendimento*
// @updateURL    https://raw.githubusercontent.com/NETHOMIRANDA/facilitador-ssp-go/master/ssp-facilitador.user.js
// @downloadURL  https://raw.githubusercontent.com/NETHOMIRANDA/facilitador-ssp-go/master/ssp-facilitador.user.js
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // Evita múltiplas inicializações
    if (window.__SSP_FACILITADOR_INICIADO__) return;
    window.__SSP_FACILITADOR_INICIADO__ = true;

    console.log("🚀 [SSP-GO Facilitador] Iniciando extensão móvel...");

    /* ==========================================================================
       UTILITÁRIOS E SINCRONIZAÇÃO ANGULARJS
       ========================================================================== */

    function esperar(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Seta valor em input e garante disparo de eventos nativos e do AngularJS
     */
    function preencherInput(elemento, valor) {
        if (!elemento) return false;
        elemento.focus();
        elemento.value = valor;
        elemento.dispatchEvent(new Event('input', { bubbles: true }));
        elemento.dispatchEvent(new Event('change', { bubbles: true }));
        elemento.dispatchEvent(new Event('blur', { bubbles: true }));

        try {
            if (window.angular) {
                const ngEl = window.angular.element(elemento);
                const ngModel = ngEl.controller ? ngEl.controller('ngModel') : null;
                if (ngModel) {
                    ngModel.$setViewValue(valor);
                    ngModel.$render();
                }
                const scope = ngEl.scope ? ngEl.scope() : null;
                if (scope && !scope.$$phase) {
                    scope.$apply();
                }
            }
        } catch (e) {
            console.warn('[SSP Facilitador] Aviso ao sincronizar Angular:', e);
        }
        return true;
    }

    /**
     * Clica em elemento com suporte a foco e eventos de mouse/toque
     */
    function clicarElemento(el) {
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        el.click();
        return true;
    }

    /**
     * Formata data e hora atual no padrão brasileiro (DD/MM/AAAA HH:mm)
     */
    function obterDataHoraAtualFormatada() {
        const agora = new Date();
        const dia = String(agora.getDate()).padStart(2, '0');
        const mes = String(agora.getMonth() + 1).padStart(2, '0');
        const ano = agora.getFullYear();
        const horas = String(agora.getHours()).padStart(2, '0');
        const minutos = String(agora.getMinutes()).padStart(2, '0');
        return `${dia}/${mes}/${ano} ${horas}:${minutos}`;
    }

    /**
     * Busca seletor robusto com fallback
     */
    function buscarElemento(seletorPrincipal, alternativas = []) {
        let el = document.querySelector(seletorPrincipal);
        if (el) return el;
        for (const alt of alternativas) {
            el = document.querySelector(alt);
            if (el) return el;
        }
        return null;
    }

    /* ==========================================================================
       ARMAZENAMENTO LOCAL (NÚMERO DA VIATURA / PM)
       ========================================================================== */
    const CHAVE_TEL_LOCAL = 'ssp_pm_telefone_trabalho';

    function salvarTelefoneTrabalho(num) {
        localStorage.setItem(CHAVE_TEL_LOCAL, num);
    }

    function obterTelefoneTrabalho() {
        return localStorage.getItem(CHAVE_TEL_LOCAL) || '';
    }

    /* ==========================================================================
       LISTA COMPLETA DE NATUREZAS (COLETA DO SISTEMA + CACHE LOCAL)
       ========================================================================== */
    const CHAVE_NAT_CACHE = 'ssp_naturezas_cache_v1';
    const SUGESTOES_FIXAS = ['PATRULHAMENTO', 'PONTO DE ESTACIONAMENTO'];
    let listaNaturezasCompleta = [];
    let coletandoEmAndamento = false;

    // Impede corrida simultanea: so UM varredura/carregamento por vez
    async function garantirListaCarregada() {
        if (listaNaturezasCompleta.length) return true;
        if (coletandoEmAndamento) return false;
        coletandoEmAndamento = true;
        try {
            listaNaturezasCompleta = await coletarTodasNaturezas();
        } finally {
            coletandoEmAndamento = false;
        }
        return listaNaturezasCompleta.length > 0;
    }

    // Tira acentos e padroniza (ex: "TRAfego" == "TRAFEGO") pra busca instantanea
    function normalizar(t) {
        return (t || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    }

    /**
     * Abre o dropdown do sistema (ui-select) e devolve as opcoes renderizadas
     */
    async function abrirDropdownSistema(aq) {
        const container = buscarElemento(aq, ['#selectNaturezasOcorrencia .ui-select-match']);
        if (!container) return null;

        // ja aberto? nao re-click (fecharia)
        const jaAberto = document.querySelectorAll('#selectNaturezasOcorrencia .ui-select-choices-row, .ui-select-choices-group li');
        if (!jaAberto || jaAberto.length === 0) {
            clicarElemento(container);
            await esperar(600);
        }
        return document.querySelectorAll('#selectNaturezasOcorrencia .ui-select-choices-row, .ui-select-choices-group li, .ui-select-choices-row, .ui-select-choices-group li');
    }

    /**
     * Fecha o dropdown do sistema (Escape no input)
     */
    function fecharDropdownSistema(inputSistema) {
        if (!inputSistema) return;
        inputSistema.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        inputSistema.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
        inputSistema.blur();
    }

    /**
     * Coleta TODAS as naturezas existentes no sistema (com cache em localStorage).
     * Estrategia em 2 tempos:
     *  1) abre o dropdown vazio e coleta (se o sistema permitir).
     *  2) o campo do sistema (ui-select) as vezes SÓ revela opções depois de digitar
     *     (placeholder: digite para pesquisar...). Entao faz varredura A-Z: digita cada
     *     letra, junta tudo que aparecer, e no fim monta a lista completa.
     */
    async function coletarTodasNaturezas(forcar = false) {
        if (!forcar) {
            const salvas = localStorage.getItem(CHAVE_NAT_CACHE);
            if (salvas) {
                try {
                    const arr = JSON.parse(salvas);
                    if (Array.isArray(arr) && arr.length) return arr;
                } catch (e) { /* cache corrompido - recolhe */ }
            }
        }

        const inputSistema = buscarElemento(
            "#selectNaturezasOcorrencia input.ui-select-search",
            ["#selectNaturezasOcorrencia input"]
        );
        if (!inputSistema) return [];

        if (inputSistema.closest('.ui-select-container')) {
            inputSistema.closest('.ui-select-container').classList.add('ui-select-multiple');
        }

        // TEMPO 1: coleta com campo vazio (quando o sistema lista tudo de cara)
        preencherInput(inputSistema, '');
        let rows = await abrirDropdownSistema("#selectNaturezasOcorrencia");
        const lista = [];
        const juntar = (rs) => {
            rs.forEach(r => {
                const t = r.textContent.trim();
                if (t && !lista.includes(t) && !/^DIGITE PARA PESQUISAR/i.test(t)) lista.push(t);
            });
        };
        juntar(rows || []);

        // TEMPO 2: varredura A-Z (caso o dropdown so mostre opcoes apos digitar)
        if (lista.length < 5) {
            const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
            for (const letra of LETRAS) {
                preencherInput(inputSistema, letra);
                await esperar(250);
                const rs = document.querySelectorAll('#selectNaturezasOcorrencia .ui-select-choices-row, .ui-select-choices-group li');
                juntar(rs || []);
            }
            // volta o campo ao estado limpo e fecha o dropdown
            preencherInput(inputSistema, '');
            fecharDropdownSistema(inputSistema);
        }

        if (lista.length) {
            localStorage.setItem(CHAVE_NAT_CACHE, JSON.stringify(lista));
            listaNaturezasCompleta = lista;
            console.log('[SSP Facilitador] Naturezas coletadas do sistema:', lista.length);
        }
        return lista;
    }

    /**
     * Pinta a lista de sugestoes na gaveta (fixas no topo + filtro instantaneo)
     */
    function pintarNaturezas(filtro) {
        const cont = document.getElementById('ssp-resultado-naturezas');
        if (!cont) return;
        const norm = normalizar(filtro);

        // Campo vazio = opcoes OCULTAS (igual ao placeholder do sistema:
        // digite para pesquisar e depois clique em adicionar natureza)
        if (!norm) {
            cont.innerHTML = '';
            cont.style.display = 'none';
            return;
        }

        cont.innerHTML = '';
        cont.style.display = 'block';

        // sugestoes fixas primeiro (o que o PM mais usa), depois a lista completa
        const fonte = [...SUGESTOES_FIXAS, ...listaNaturezasCompleta];
        const combinadas = fonte.filter(l => normalizar(l).includes(norm));
        // dedupe preservando ordem
        const itens = combinadas.filter((v, i, a) => a.indexOf(v) === i).slice(0, 80);

        if (!itens.length) {
            cont.innerHTML = '<div style="padding:10px; color:#94a3b8; font-size:12px; text-align:center;">Nenhuma natureza encontrada — tente outro termo.</div>';
            return;
        }

        itens.forEach(t => {
            const item = document.createElement('div');
            const fixa = SUGESTOES_FIXAS.includes(t.toUpperCase());
            item.style.cssText = 'padding: 8px 10px; border-bottom: 1px solid #1e293b; color: #f8fafc; font-size: 13px; cursor: pointer; display:flex; align-items:center; gap:6px;' +
                (fixa ? 'font-weight:bold; color:#facc15;' : '');
            item.innerHTML = (fixa ? '⭐ ' : '• ') + t;
            item.onclick = async () => {
                cont.style.display = 'none';
                await selecionarNaturezaNoSistema(t);
            };
            cont.appendChild(item);
        });
    }

    /**
     * Seleciona uma natureza no sistema por TEXTO (cascata de taticas):
     * 1. procura na lista ja aberta | 2. digita no campo | 3. avisa se falhar
     * Depois: CONSUMADO + confirmar (aposSelecionarNatureza)
     */
    async function selecionarNaturezaNoSistema(texto) {
        let alvo = null;

        const rows = await abrirDropdownSistema("#selectNaturezasOcorrencia");
        if (rows && rows.length) {
            // 1. comparacao exata
            rows.forEach(r => { if (!alvo && r.textContent.trim() === texto) alvo = r; });
            // 2. similaridade (sem acento)
            if (!alvo) {
                const norm = normalizar(texto);
                rows.forEach(r => { if (!alvo && normalizar(r.textContent).includes(norm)) alvo = r; });
            }
        }

        // 3. fallback - digita no campo do sistema e pega a primeira opcao
        if (!alvo) {
            await planoB(texto);
            await esperar(300);
            alvo = document.querySelector(
                '#selectNaturezasOcorrencia .ui-select-choices-row, ' +
                '#selectNaturezasOcorrencia .ui-select-choices-row-inner, ' +
                '#selectNaturezasOcorrencia .ui-select-choices li'
            );
            if (!alvo) {
                alvo = [...document.querySelectorAll('.ui-select-choices-row, .ui-select-choices-row-inner, .ui-select-choices li')]
                    .filter(r => r.offsetParent !== null)[0] || null;
            }
        }

        if (alvo) {
            clicarElemento(alvo);
            await aposSelecionarNatureza();
        } else {
            mostrarToast('⚠️ Natureza não encontrada no sistema. Tente digitar direto.');
        }
    }

    /* ==========================================================================
       CONSTRUÇÃO DA INTERFACE MÓVEL (GAVETA / BOTTOM-SHEET TOUCH)
       ========================================================================== */

    function criarInterface() {
        if (document.getElementById('ssp-btn-flutuante')) return;

        // Estilos CSS embutidos
        const style = document.createElement('style');
        style.textContent = `
            #ssp-btn-flutuante {
                position: fixed;
                bottom: 25px;
                right: 20px;
                z-index: 9999999;
                background: linear-gradient(135deg, #1e3a8a, #0f172a);
                color: #ffffff;
                border: 2px solid #eab308;
                border-radius: 50px;
                padding: 14px 22px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 15px;
                font-weight: bold;
                display: flex;
                align-items: center;
                gap: 8px;
                box-shadow: 0 10px 25px rgba(0,0,0,0.5);
                cursor: pointer;
                user-select: none;
                transition: transform 0.2s, box-shadow 0.2s;
            }
            #ssp-btn-flutuante:active {
                transform: scale(0.95);
            }
            #ssp-painel-drawer {
                position: fixed;
                bottom: 0;
                left: 0;
                width: 100%;
                max-height: 90vh;
                background: #0f172a;
                color: #f8fafc;
                z-index: 10000000;
                border-top-left-radius: 20px;
                border-top-right-radius: 20px;
                box-shadow: 0 -5px 30px rgba(0,0,0,0.7);
                border-top: 3px solid #eab308;
                display: none;
                flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                box-sizing: border-box;
                overflow: hidden;
            }
            .ssp-drawer-header {
                padding: 14px 18px;
                background: #1e293b;
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-bottom: 1px solid #334155;
            }
            .ssp-drawer-header h3 {
                margin: 0;
                font-size: 17px;
                color: #facc15;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .ssp-btn-fechar {
                background: #334155;
                color: #ffffff;
                border: none;
                font-size: 16px;
                font-weight: bold;
                border-radius: 50%;
                width: 34px;
                height: 34px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
            }
            .ssp-drawer-conteudo {
                padding: 16px;
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
                display: flex;
                flex-direction: column;
                gap: 14px;
            }
            .ssp-card {
                background: #1e293b;
                border-radius: 10px;
                padding: 12px;
                border: 1px solid #334155;
            }
            .ssp-card-titulo {
                font-size: 13px;
                font-weight: bold;
                color: #38bdf8;
                text-transform: uppercase;
                margin-bottom: 8px;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .ssp-input, .ssp-textarea {
                width: 100%;
                background: #0f172a;
                border: 1px solid #475569;
                color: #f8fafc;
                padding: 10px 12px;
                border-radius: 8px;
                font-size: 14px;
                box-sizing: border-box;
                outline: none;
            }
            .ssp-input:focus, .ssp-textarea:focus {
                border-color: #38bdf8;
                box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
            }
            .ssp-btn-acao {
                width: 100%;
                padding: 12px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: bold;
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                transition: opacity 0.2s;
            }
            .ssp-btn-acao:active {
                opacity: 0.8;
            }
            .ssp-btn-azul {
                background: #0284c7;
                color: white;
            }
            .ssp-btn-verde {
                background: #16a34a;
                color: white;
            }
            .ssp-btn-amarelo {
                background: #eab308;
                color: #0f172a;
            }
            .ssp-status-gps {
                font-size: 12px;
                color: #94a3b8;
                margin-top: 6px;
                line-height: 1.4;
            }
            .ssp-chips-container {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-top: 8px;
            }
            .ssp-chip {
                background: #334155;
                color: #e2e8f0;
                padding: 6px 10px;
                border-radius: 16px;
                font-size: 11px;
                cursor: pointer;
                border: 1px solid #475569;
            }
            .ssp-chip:active {
                background: #0284c7;
                color: #ffffff;
            }
            .ssp-badge-sucesso {
                background: #064e3b;
                border: 1px solid #059669;
                color: #6ee7b7;
                padding: 12px;
                border-radius: 8px;
                font-size: 13px;
                text-align: center;
            }
        `;
        document.head.appendChild(style);

        // Botão flutuante principal
        const btnFlutuante = document.createElement('div');
        btnFlutuante.id = 'ssp-btn-flutuante';
        btnFlutuante.innerHTML = `<span>👮‍♂️</span> <span>Registro Rápido</span>`;
        document.body.appendChild(btnFlutuante);

        // Gaveta inferior (Mobile Drawer)
        const drawer = document.createElement('div');
        drawer.id = 'ssp-painel-drawer';
        drawer.innerHTML = `
            <div class="ssp-drawer-header">
                <h3><span>🛡️</span> Atendimento SSP-GO (Móvel)</h3>
                <button id="ssp-btn-fechar" class="ssp-btn-fechar">✕</button>
            </div>

            <div class="ssp-drawer-conteudo">

                <!-- BOTAO DE PREENCHIMENTO COMPLETO EM UM TOQUE -->
                <button id="ssp-btn-tudo-em-um" class="ssp-btn-acao ssp-btn-amarelo" style="font-size: 15px; padding: 14px;">
                    ⚡ PREENCHER TUDO EM 1 TOQUE
                </button>

                <!-- CARD 1: NATUREZA DA OCORRÊNCIA -->
                <div class="ssp-card">
                    <div class="ssp-card-titulo">1. Natureza da Ocorrência</div>
                    <input type="text" id="ssp-input-natureza" class="ssp-input" placeholder="Digite para buscar (ex: FURTO, AMEAÇA, ROUBO)..." autocomplete="off">
                    <div class="ssp-chips-container" id="ssp-chips-naturezas">
                        <span class="ssp-chip" data-natureza="PATRULHAMENTO" style="border-color:#eab308; color:#facc15;">⭐ Patrulhamento</span>
                        <span class="ssp-chip" data-natureza="PONTO DE ESTACIONAMENTO" style="border-color:#eab308; color:#facc15;">⭐ Ponto de Estacionamento</span>
                        <span class="ssp-chip" data-natureza="AMEAÇA">Ameaça</span>
                        <span class="ssp-chip" data-natureza="FURTO">Furto</span>
                        <span class="ssp-chip" data-natureza="ROUBO">Roubo</span>
                        <span class="ssp-chip" data-natureza="VIOLÊNCIA DOMÉSTICA">Viol. Doméstica</span>
                        <span class="ssp-chip" data-natureza="ACIDENTE DE TRÂNSITO">Acidente Trânsito</span>
                        <span class="ssp-chip" data-natureza="DESINTELIGÊNCIA">Desinteligência</span>
                    </div>
                    <div id="ssp-resultado-naturezas" style="margin-top:8px; display:none; max-height:180px; overflow-y:auto; background:#0f172a; border-radius:6px; border:1px solid #334155;"></div>
                    <div style="margin-top:8px; font-size:11px; color:#94a3b8;">
                        🔍 Toque no campo para a <b>lista completa</b> de naturezas aparecer (fica copiada no celular). Digite pra filtrar na hora. Selecionou = <b>CONSUMADO</b> + confirma automático.
                    </div>
                </div>

                <!-- CARD 2: TELEFONE DA EQUIPE / PM -->
                <div class="ssp-card">
                    <div class="ssp-card-titulo">2. Telefone da Viatura / PM</div>
                    <div style="display:flex; gap:8px;">
                        <input type="tel" id="ssp-input-telefone" class="ssp-input" placeholder="Ex: (62) 99999-9999" value="${obterTelefoneTrabalho()}">
                        <button id="ssp-btn-salvar-tel" class="ssp-btn-acao ssp-btn-azul" style="width: auto; padding: 0 14px; font-size:12px;">Salvar</button>
                    </div>
                    <div style="margin-top:4px; font-size:11px; color:#94a3b8;">
                        Fica salvo no celular. Preenche automaticamente nos próximos atendimentos.
                    </div>
                </div>

                <!-- CARD 3: LOCALIZAÇÃO / GPS DO CELULAR -->
                <div class="ssp-card">
                    <div class="ssp-card-titulo">3. Localização por GPS do Celular</div>
                    <button id="ssp-btn-capturar-gps" class="ssp-btn-acao ssp-btn-azul">
                        📍 Capturar Local Atual pelo GPS
                    </button>
                    <div id="ssp-status-gps" class="ssp-status-gps">
                        Toque no botão para preencher Município, Logradouro e Ambiente (Via Pública).
                    </div>
                </div>

                <!-- CARD 4: RELATO DO ATENDIMENTO COM MICROFONE (VOZ) -->
                <div class="ssp-card">
                    <div class="ssp-card-titulo">4. Relato Policial</div>
                    <textarea id="ssp-textarea-relato" class="ssp-textarea" rows="4" placeholder="Digite o relato ou use o microfone para falar..."></textarea>

                    <div style="display:flex; gap:8px; margin-top:8px;">
                        <button id="ssp-btn-voz" class="ssp-btn-acao ssp-btn-azul" style="flex:1;">
                            🎤 Falar Relato (Ditado)
                        </button>
                        <button id="ssp-btn-inserir-relato" class="ssp-btn-acao ssp-btn-verde" style="flex:1;">
                            ✍️ Inserir no Campo
                        </button>
                    </div>

                    <div class="ssp-chips-container" style="margin-top:8px;">
                        <span class="ssp-chip" data-modelo="Equipe acionada via COPOM para averiguar a ocorrência no local indicado.">Via COPOM</span>
                        <span class="ssp-chip" data-modelo="Em patrulhamento preventivo, a equipe visualizou a situação e procedeu com a abordagem.">Patrulhamento</span>
                        <span class="ssp-chip" data-modelo="Feita a abordagem e checagem de praxe, nada de ilícito foi encontrado. Orientadas as partes no local.">Nada Ilícito</span>
                    </div>
                </div>

                <!-- CARD 5: REGISTRAR E GERAR RAI -->
                <div class="ssp-card" style="border: 2px solid #16a34a; background: #064e3b22;">
                    <div class="ssp-card-titulo" style="color:#4ade80;">5. Finalização e Registro</div>
                    <button id="ssp-btn-registrar-rai" class="ssp-btn-acao ssp-btn-verde" style="font-size:16px; padding:15px;">
                        🚀 REGISTRAR RAI NO SISTEMA
                    </button>
                    <div id="ssp-card-resultado-rai" style="margin-top:10px; display:none;"></div>
                </div>

            </div>
        `;
        document.body.appendChild(drawer);

        // Eventos de Abertura e Fechamento
        btnFlutuante.onclick = () => {
            drawer.style.display = 'flex';
        };
        document.getElementById('ssp-btn-fechar').onclick = () => {
            drawer.style.display = 'none';
        };

        // Salvar telefone
        document.getElementById('ssp-btn-salvar-tel').onclick = () => {
            const tel = document.getElementById('ssp-input-telefone').value.trim();
            salvarTelefoneTrabalho(tel);
            aplicarTelefoneNaPagina(tel);
            mostrarToast('Telefone salvo com sucesso!');
        };

        // Busca rápida de natureza - FILTRO LOCAL INSTANTÂNEO
        const inputNat = document.getElementById('ssp-input-natureza');
        inputNat.addEventListener('input', async (e) => {
            const texto = e.target.value;

            // Lista local pronta? Filtra na hora (instantâneo).
            if (listaNaturezasCompleta.length) {
                pintarNaturezas(texto);
                return;
            }

            // Sem lista local: tenta carregar (cache → varredura A-Z). Só UMA por vez.
            const ok = await garantirListaCarregada();
            if (ok) {
                pintarNaturezas(texto);
                return;
            }

            // Plano B: digita no campo do sistema e ESPELHA as opções que surgirem
            // (comportamento original da v1.0 que funcionava no celular)
            const n = await planoB(texto);
            if (!n) {
                const cont = document.getElementById('ssp-resultado-naturezas');
                if (cont) {
                    cont.style.display = 'block';
                    cont.innerHTML = '<div style="padding:10px; color:#fca5a5; font-size:12px;">⚠️ O sistema não revelou opções ainda. Abra o modal "Adicionar Natureza" lá no sistema (toque no campo de natureza da página), depois volte e digite aqui de novo.</div>';
                }
            }
        });

        // Toque/clique no campo: carrega a LISTA COMPLETA em segundo plano (cache primeiro).
        // Lista fica OCULTA - aparece apenas quando comecar a digitar.
        inputNat.addEventListener('focus', async () => {
            if (!listaNaturezasCompleta.length) {
                mostrarToast('🔄 Carregando lista completa de naturezas...');
                const ok = await garantirListaCarregada();
                if (ok) {
                    mostrarToast('✅ Lista pronta! Comece a digitar para filtrar.');
                } else {
                    mostrarToast('⚠️ Abra o campo de natureza no sistema 1x pra copiar a lista.');
                }
            }
            if (inputNat.value.trim() && listaNaturezasCompleta.length) {
                pintarNaturezas(inputNat.value);
            }
        });

        // Chips de naturezas rápidas (agora usam selecao por TEXTO com fallback)
        document.querySelectorAll('#ssp-chips-naturezas .ssp-chip').forEach(chip => {
            chip.onclick = () => {
                const nat = chip.getAttribute('data-natureza');
                inputNat.value = nat;
                selecionarNaturezaNoSistema(nat);
            };
        });

        // Chips de modelos de relato
        document.querySelectorAll('[data-modelo]').forEach(chip => {
            chip.onclick = () => {
                const textarea = document.getElementById('ssp-textarea-relato');
                const textoAtual = textarea.value.trim();
                const novoTexto = chip.getAttribute('data-modelo');
                textarea.value = textoAtual ? `${textoAtual}\n${novoTexto}` : novoTexto;
                aplicarRelatoNaPagina(textarea.value);
            };
        });

        // GPS
        document.getElementById('ssp-btn-capturar-gps').onclick = () => {
            capturarGpsEPreencher();
        };

        // Voz (Ditado)
        document.getElementById('ssp-btn-voz').onclick = () => {
            iniciarDitadoVoz();
        };

        // Inserir Relato
        document.getElementById('ssp-btn-inserir-relato').onclick = () => {
            const texto = document.getElementById('ssp-textarea-relato').value;
            aplicarRelatoNaPagina(texto);
            mostrarToast('Relato inserido no atendimento!');
        };

        // Botão Tudo em Um
        document.getElementById('ssp-btn-tudo-em-um').onclick = async () => {
            executarFluxoCompleto();
        };

        // Registrar RAI
        document.getElementById('ssp-btn-registrar-rai').onclick = async () => {
            acionarRegistroRAI();
        };
    }

    /* ==========================================================================
       ETAPA 1: NATUREZA DA OCORRÊNCIA (BUSCA, CONSUMADO E CONFIRMAR)
       ========================================================================== */

    async function filtrarNaturezaNoSistema(texto) {
        if (!texto) return;

        // Seletor indicado pelo usuário:
        // document.querySelector("#selectNaturezasOcorrencia > input.form-control.ui-select-search...")
        const inputSistema = buscarElemento(
            "#selectNaturezasOcorrencia input.ui-select-search",
            ["#selectNaturezasOcorrencia input", ".naturezasOcorrencia input.ui-select-search"]
        );

        if (!inputSistema) {
            console.warn("[SSP Facilitador] Campo de busca de natureza não encontrado na tela.");
            return;
        }

        // Foca e digita no campo do sistema para ativar o filtro do ui-select
        preencherInput(inputSistema, texto);

        // Espera renderização das opções no dropdown
        await esperar(400);

        // Espelha as opções abertas pelo ui-select na gaveta (plano B da v1.0)
        espelharOpcoesDoSistema();
    }

    /**
     * PLANO B (restaurado da v1.0): enquanto a lista completa não estiver no cache,
     * digita-te no campo do sistema e as opções que o ui-select revelar são ESPELHADAS
     * na gaveta (#ssp-resultado-naturezas). Tocar numa opção espeilhada seleciona a
     * natureza no sistema normalmente — e o texto entra no cache local.
     */
    function espelharOpcoesDoSistema() {
        const cont = document.getElementById('ssp-resultado-naturezas');
        if (!cont) return 0;

        const inputNat = document.getElementById('ssp-input-natureza');
        const filtro = inputNat ? normalizar(inputNat.value) : '';

        // Varredura larga: cada variacao do ui-select renderiza as opcoes com classe diferente
        let rows = document.querySelectorAll(
            '#selectNaturezasOcorrencia .ui-select-choices-row, ' +
            '#selectNaturezasOcorrencia .ui-select-choices-row-inner, ' +
            '#selectNaturezasOcorrencia .ui-select-choices li, ' +
            '#selectNaturezasOcorrencia .ui-select-choices-group li'
        );

        // Fallback: container sem o id esperado? Pega as linhas VISIVEIS de qq dropdown ui-select
        if (!rows || !rows.length) {
            rows = [...document.querySelectorAll('.ui-select-choices-row, .ui-select-choices-row-inner, .ui-select-choices li')]
                .filter(r => r.offsetParent !== null); // só as que estão renderizadas na tela
        }
        if (!rows || !rows.length) return 0;

        const achadas = [];
        rows.forEach(r => {
            const t = (r.textContent || '').replace(/\s+/g, ' ').trim();
            // coincide exatamente, sem acento, ou contém (se houver filtro digitado)
            const norm = normalizar(t);
            const batiz = !filtro || norm === filtro || norm.includes(filtro);
            if (t && t.length >= 2 && !/^DIGITE PARA PESQUISAR/i.test(t) && batiz) achadas.push(t);
        });

        if (!achadas.length) return 0;

        cont.innerHTML = '';
        cont.style.display = 'block';

        // deixa os chips fixos no topo se baterem com o filtro
        const fixoBatendo = SUGESTOES_FIXAS.filter(f => !filtro || normalizar(f).includes(filtro));
        const unicas = [...fixoBatendo, ...achadas].filter((v, i, a) => a.indexOf(v) === i).slice(0, 80);

        unicas.forEach(txt => {
            const div = document.createElement('div');
            div.className = 'ssp-natureza-item';
            div.textContent = (SUGESTOES_FIXAS.includes(txt) ? '⭐ ' : '') + txt;
            div.onclick = () => {
                if (inputNat) inputNat.value = txt;
                selecionarNaturezaNoSistema(txt);
            };
            cont.appendChild(div);
        });

        // alimenta o cache local com o que o sistema revelou
        try {
            const salvas = JSON.parse(localStorage.getItem(CHAVE_NAT_CACHE) || '[]');
            const nova = [...salvas, ...achadas].filter((v, i, a) => a.indexOf(v) === i);
            if (nova.length > salvas.length) {
                localStorage.setItem(CHAVE_NAT_CACHE, JSON.stringify(nova));
                listaNaturezasCompleta = nova;
            }
        } catch (e) { /* cache invalido: ignora */ }

        console.log('[SSP Facilitador] Espelhadas do sistema:', achadas.length);
        return achadas.length;
    }

    /**
     * PLANO B completo: garante o dropdown do sistema aberto (o input de busca
     * às vezes só nasce depois de abrir), digita o filtro lá, e espelha as opções
     * na gaveta com RE-TENTATIVA (a filtragem do sistema é lenta no celular).
     */
    async function planoB(texto) {
        if (!texto) return 0;

        // 1. abre o campo do sistema se o input de busca ainda não existir
        let inputSistema = buscarElemento(
            "#selectNaturezasOcorrencia input.ui-select-search",
            ["#selectNaturezasOcorrencia input"]
        );
        if (!inputSistema) {
            const match = document.querySelector('#selectNaturezasOcorrencia .ui-select-match');
            if (match) {
                clicarElemento(match);
                await esperar(700);
            }
            inputSistema = buscarElemento(
                "#selectNaturezasOcorrencia input.ui-select-search",
                ["#selectNaturezasOcorrencia input"]
            );
            if (!inputSistema) {
                console.warn('[SSP Facilitador] planoB: campo de natureza não encontrado — abra o modal Adicionar Natureza no sistema.');
                return 0;
            }
        }

        // 2. digita o filtro no campo do sistema
        preencherInput(inputSistema, texto);

        // 3. espelha com re-tentativa (as opções podem demorar a renderizar)
        let n = 0;
        for (const pausa of [400, 600, 1200]) {
            await esperar(pausa);
            n = espelharOpcoesDoSistema();
            if (n > 0) break;
        }
        return n;
    }

    /**
     * Após escolher a natureza:
     * - Seleciona "CONSUMADO" no modal
     * - Clica no botão de adicionar/confirmar
     */
    async function aposSelecionarNatureza() {
        await esperar(500);

        // Campo indicado pelo usuário:
        // document.querySelector("#modalAddNatureza > div > div > div.modal-body_ > div.row.naturezasOcorrencia > div.box-consumacao > div.col-md-2 > select")
        const selectConsumacao = buscarElemento(
            "#modalAddNatureza .box-consumacao select",
            [
                "#modalAddNatureza > div > div > div.modal-body_ > div.row.naturezasOcorrencia > div.box-consumacao > div.col-md-2 > select",
                ".box-consumacao select",
                "#modalAddNatureza select"
            ]
        );

        if (selectConsumacao) {
            // Procura a option "CONSUMADO"
            let achou = false;
            for (let i = 0; i < selectConsumacao.options.length; i++) {
                const opt = selectConsumacao.options[i];
                if (opt.text.toUpperCase().includes('CONSUMADO') || opt.value.toUpperCase().includes('CONSUMADO')) {
                    selectConsumacao.selectedIndex = i;
                    selectConsumacao.value = opt.value;
                    achou = true;
                    break;
                }
            }

            selectConsumacao.dispatchEvent(new Event('change', { bubbles: true }));
            selectConsumacao.dispatchEvent(new Event('input', { bubbles: true }));
            console.log("[SSP Facilitador] Consumação marcada como CONSUMADO:", achou);
        }

        await esperar(300);

        // Botão indicado pelo usuário:
        // document.querySelector("#modalAddNatureza > div > div > div.modal-body_ > div.row.naturezasOcorrencia > div.col-md-3 > button")
        const btnAdicionarNatureza = buscarElemento(
            "#modalAddNatureza .row.naturezasOcorrencia .col-md-3 > button",
            [
                "#modalAddNatureza .row.naturezasOcorrencia button",
                "#modalAddNatureza button.btn-success",
                "#modalAddNatureza button[ng-click*='adicionar' i]"
            ]
        );

        if (btnAdicionarNatureza) {
            clicarElemento(btnAdicionarNatureza);
            console.log("[SSP Facilitador] Botão de adicionar natureza acionado com sucesso.");
            mostrarToast("Natureza configurada como CONSUMADO e adicionada!");
        }
    }

    /* ==========================================================================
       ETAPA 2: TELEFONE DA EQUIPE / PM
       ========================================================================== */

    function aplicarTelefoneNaPagina(numero) {
        if (!numero) return;

        // Seletor indicado pelo usuário:
        // document.querySelector("#viewAtendimento > ng-include > div > fieldset > div:nth-child(3) > div > div.col-md-2.telefoneOcorrencia > input")
        const inputTel = buscarElemento(
            "#viewAtendimento .telefoneOcorrencia input",
            [
                ".telefoneOcorrencia input",
                "input[name*='telefone' i]",
                "input[placeholder*='telefone' i]"
            ]
        );

        if (inputTel) {
            preencherInput(inputTel, numero);
            console.log("[SSP Facilitador] Telefone preenchido no sistema:", numero);
        }
    }

    /* ==========================================================================
       ETAPA 3: SOLICITANTE ANÔNIMO
       ========================================================================== */

    function marcarSolicitanteAnonimo() {
        // Seletor indicado pelo usuário:
        // document.querySelector("#input-ocorrencia-nomeSolicitante")
        // document.querySelector("#solicitante_anonimo")
        const iconeAnonimo = buscarElemento(
            "#solicitante_anonimo",
            [
                "input#solicitante_anonimo",
                "[ng-click*='anonimo' i]",
                "label[for='solicitante_anonimo']"
            ]
        );

        if (iconeAnonimo) {
            clicarElemento(iconeAnonimo);
            console.log("[SSP Facilitador] Ícone de solicitante anônimo acionado.");
            return true;
        }
        return false;
    }

    /* ==========================================================================
       ETAPA 4: DATA E HORA DO FATO (MOMENTO EXATO)
       ========================================================================== */

    function preencherDataHoraExata() {
        // Seletor indicado pelo usuário:
        // document.querySelector("#viewAtendimento > ng-include > div > fieldset > div:nth-child(3) > div > div.headerDadosAtendimento > div.col-md-2.dataFato > datetimepicker > input")
        const inputDataHora = buscarElemento(
            "#viewAtendimento .dataFato datetimepicker input",
            [
                ".dataFato datetimepicker input",
                ".dataFato input",
                "datetimepicker input"
            ]
        );

        const dataHora = obterDataHoraAtualFormatada();

        if (inputDataHora) {
            preencherInput(inputDataHora, dataHora);
            console.log("[SSP Facilitador] Data e Hora do Fato preenchidas:", dataHora);
            return true;
        }
        return false;
    }

    /* ==========================================================================
       ETAPA 5: LOCALIZAÇÃO GPS DO CELULAR (MUNICÍPIO, RUA E AMBIENTE)
       ========================================================================== */

    async function capturarGpsEPreencher() {
        const statusDiv = document.getElementById('ssp-status-gps');
        statusDiv.innerHTML = "⏳ Solicitando sinal de GPS do celular...";

        if (!navigator.geolocation) {
            statusDiv.innerHTML = "❌ Geolocalização não é suportada neste navegador.";
            return;
        }

        navigator.geolocation.getCurrentPosition(
            async (posicao) => {
                const lat = posicao.coords.latitude;
                const lon = posicao.coords.longitude;
                statusDiv.innerHTML = `📍 GPS Obtido: (${lat.toFixed(5)}, ${lon.toFixed(5)}). Buscando endereço...`;

                try {
                    // Geocodificação reversa gratuita via OpenStreetMap Nominatim
                    const resposta = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`, {
                        headers: { 'Accept': 'application/json' }
                    });
                    const dados = await resposta.json();
                    const end = dados.address || {};

                    const cidade = end.city || end.town || end.municipality || end.village || 'GOIÂNIA';
                    const bairro = end.suburb || end.neighbourhood || end.residential || '';
                    const rua = end.road || end.pedestrian || end.street || end.footway || 'VIA PÚBLICA';

                    statusDiv.innerHTML = `✅ <b>Local detectado:</b> ${rua}, ${bairro} - ${cidade}`;

                    // 1. Campo Município / Bairro indicado pelo usuário:
                    // document.querySelector("#viewAtendimento > ng-include > div > fieldset > fieldset > div:nth-child(2) > div:nth-child(7) > div > input.form-control.ui-select-search...")
                    const inputMunicipio = buscarElemento(
                        "#viewAtendimento fieldset fieldset div:nth-child(2) > div:nth-child(7) input.ui-select-search",
                        [
                            "#viewAtendimento fieldset fieldset input.ui-select-search",
                            "input.ui-select-search[placeholder*='município' i]",
                            "input.ui-select-search[placeholder*='bairro' i]"
                        ]
                    );
                    if (inputMunicipio) {
                        preencherInput(inputMunicipio, cidade);
                        await esperar(400);
                        const opcaoMun = document.querySelector('.ui-select-choices-row');
                        if (opcaoMun) clicarElemento(opcaoMun);
                    }

                    // 2. Campo Rua / Logradouro indicado pelo usuário:
                    // document.querySelector("#viewAtendimento > ng-include > div > fieldset > fieldset > div:nth-child(3) > div:nth-child(2) > div.col-md-2 > input")
                    const inputRua = buscarElemento(
                        "#viewAtendimento fieldset fieldset div:nth-child(3) > div:nth-child(2) .col-md-2 > input",
                        [
                            "#viewAtendimento fieldset fieldset div:nth-child(3) > div:nth-child(2) input",
                            "input[placeholder*='logradouro' i]",
                            "input[placeholder*='rua' i]"
                        ]
                    );
                    if (inputRua) {
                        preencherInput(inputRua, rua);
                    }

                    // 3. Campo Ambiente Local da Ocorrência indicado pelo usuário:
                    // document.querySelector("#viewAtendimento > ng-include > div > fieldset > div.row.ambientelocalocorrencia > div:nth-child(2) > select")
                    const selectAmbiente = buscarElemento(
                        "#viewAtendimento .ambientelocalocorrencia select",
                        [
                            "#viewAtendimento > ng-include > div > fieldset > div.row.ambientelocalocorrencia > div:nth-child(2) > select",
                            ".ambientelocalocorrencia select",
                            "select[name*='ambiente' i]"
                        ]
                    );
                    if (selectAmbiente) {
                        // Marca 'VIA PÚBLICA'
                        for (let i = 0; i < selectAmbiente.options.length; i++) {
                            const txt = selectAmbiente.options[i].text.toUpperCase();
                            if (txt.includes('VIA PÚBLICA') || txt.includes('LOGRADOURO')) {
                                selectAmbiente.selectedIndex = i;
                                selectAmbiente.value = selectAmbiente.options[i].value;
                                selectAmbiente.dispatchEvent(new Event('change', { bubbles: true }));
                                break;
                            }
                        }
                    }

                    mostrarToast('Localização e endereço preenchidos via GPS!');

                } catch (err) {
                    console.error('[SSP Facilitador] Erro na geocodificação reversa:', err);
                    statusDiv.innerHTML = `⚠️ GPS obtido (${lat.toFixed(4)}, ${lon.toFixed(4)}), mas falhou a consulta do nome da rua.`;
                }
            },
            (erro) => {
                console.warn('[SSP Facilitador] Falha no GPS:', erro.message);
                statusDiv.innerHTML = `❌ Erro no GPS: ${erro.message}. Verifique a permissão de localização do celular.`;
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    }

    /* ==========================================================================
       ETAPA 6: PESSOAS / ENVOLVIDOS (CLIQUE AUTOMÁTICO NA PESSOA E CONFIRMAR)
       ========================================================================== */

    async function preencherPessoaDesidentificada() {
        // Sequência indicada pelo usuário:
        // 1. document.querySelector("#_pessoas_ > a:nth-child(1)")
        // 2. document.querySelector("#collapse1 > div > div > div:nth-child(2) > div:nth-child(2) > label:nth-child(7) > input")
        // 3. document.querySelector("#modalPessoa > div > div > div:nth-child(3) > button.btn.btn-success")

        const linkPessoas = buscarElemento(
            "#_pessoas_ > a:nth-child(1)",
            ["#_pessoas_ a", "a[href*='pessoas' i]"]
        );

        if (linkPessoas) {
            clicarElemento(linkPessoas);
            console.log("[SSP Facilitador] Link Pessoas clicado.");
            await esperar(600);
        }

        const radioPessoa = buscarElemento(
            "#collapse1 > div > div > div:nth-child(2) > div:nth-child(2) > label:nth-child(7) > input",
            [
                "#collapse1 label:nth-child(7) input",
                "#collapse1 input[type='radio']:nth-child(7)",
                "#collapse1 input[type='radio']"
            ]
        );

        if (radioPessoa) {
            radioPessoa.checked = true;
            radioPessoa.dispatchEvent(new Event('change', { bubbles: true }));
            clicarElemento(radioPessoa);
            console.log("[SSP Facilitador] Opção de pessoa selecionada.");
            await esperar(500);
        }

        const btnConfirmarPessoa = buscarElemento(
            "#modalPessoa > div > div > div:nth-child(3) > button.btn.btn-success",
            [
                "#modalPessoa button.btn-success",
                "#modalPessoa button[type='submit']",
                "#modalPessoa button[ng-click*='salvar' i]"
            ]
        );

        if (btnConfirmarPessoa) {
            clicarElemento(btnConfirmarPessoa);
            console.log("[SSP Facilitador] Modal de pessoa confirmada com sucesso.");
            return true;
        }
        return false;
    }

    /* ==========================================================================
       ETAPA 7: RELATO DO ATENDIMENTO (TEXTAREA E DITADO POR VOZ)
       ========================================================================== */

    function aplicarRelatoNaPagina(texto) {
        if (!texto) return;

        // Seletor indicado pelo usuário:
        // document.querySelector("#relato_atendimento > div > textarea")
        const textarea = buscarElemento(
            "#relato_atendimento > div > textarea",
            [
                "#relato_atendimento textarea",
                "textarea[name*='relato' i]",
                "textarea"
            ]
        );

        if (textarea) {
            preencherInput(textarea, texto);
            console.log("[SSP Facilitador] Relato aplicado com sucesso.");
            return true;
        }
        return false;
    }

    // Ditado por voz no celular usando Web Speech API nativa
    let reconhecimentoVoz = null;
    function iniciarDitadoVoz() {
        const btnVoz = document.getElementById('ssp-btn-voz');
        const textarea = document.getElementById('ssp-textarea-relato');

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            mostrarToast("Reconhecimento de voz não suportado neste navegador.");
            return;
        }

        if (reconhecimentoVoz) {
            reconhecimentoVoz.stop();
            reconhecimentoVoz = null;
            btnVoz.innerHTML = '🎤 Falar Relato (Ditado)';
            btnVoz.classList.remove('ssp-btn-amarelo');
            btnVoz.classList.add('ssp-btn-azul');
            return;
        }

        reconhecimentoVoz = new SpeechRecognition();
        reconhecimentoVoz.lang = 'pt-BR';
        reconhecimentoVoz.continuous = true;
        reconhecimentoVoz.interimResults = true;

        btnVoz.innerHTML = '🔴 Ouvindo... (Toque p/ parar)';
        btnVoz.classList.remove('ssp-btn-azul');
        btnVoz.classList.add('ssp-btn-amarelo');

        reconhecimentoVoz.onresult = (evento) => {
            let resultadoFinal = '';
            for (let i = evento.resultIndex; i < evento.results.length; ++i) {
                if (evento.results[i].isFinal) {
                    resultadoFinal += evento.results[i][0].transcript + ' ';
                }
            }
            if (resultadoFinal) {
                const atual = textarea.value;
                textarea.value = atual ? `${atual} ${resultadoFinal.trim()}` : resultadoFinal.trim();
                aplicarRelatoNaPagina(textarea.value);
            }
        };

        reconhecimentoVoz.onerror = (e) => {
            console.warn('[SSP Facilitador] Erro na gravação de voz:', e.error);
            btnVoz.innerHTML = '🎤 Falar Relato (Ditado)';
            btnVoz.classList.remove('ssp-btn-amarelo');
            btnVoz.classList.add('ssp-btn-azul');
            reconhecimentoVoz = null;
        };

        reconhecimentoVoz.onend = () => {
            btnVoz.innerHTML = '🎤 Falar Relato (Ditado)';
            btnVoz.classList.remove('ssp-btn-amarelo');
            btnVoz.classList.add('ssp-btn-azul');
            reconhecimentoVoz = null;
        };

        reconhecimentoVoz.start();
    }

    /* ==========================================================================
       ETAPA 8: EXECUTAR FLUXO COMPLETO EM UM TOQUE
       ========================================================================== */

    async function executarFluxoCompleto() {
        mostrarToast("Executando preenchimento automático...");

        // 1. Data e Hora
        preencherDataHoraExata();
        await esperar(200);

        // 2. Solicitante Anônimo
        marcarSolicitanteAnonimo();
        await esperar(200);

        // 3. Telefone da viatura/PM
        const tel = obterTelefoneTrabalho() || document.getElementById('ssp-input-telefone').value;
        if (tel) {
            aplicarTelefoneNaPagina(tel);
        }
        await esperar(200);

        // 4. GPS
        capturarGpsEPreencher();

        // 5. Pessoas
        await preencherPessoaDesidentificada();

        // 6. Relato (se houver texto na gaveta)
        const relato = document.getElementById('ssp-textarea-relato').value;
        if (relato) {
            aplicarRelatoNaPagina(relato);
        }

        mostrarToast("Campos preenchidos! Selecione a Natureza para concluir.");
    }

    /* ==========================================================================
       ETAPA 9: REGISTRAR RAI NO SISTEMA E CAPTURAR NÚMERO GERADO
       ========================================================================== */

    async function acionarRegistroRAI() {
        const resultadoDiv = document.getElementById('ssp-card-resultado-rai');
        resultadoDiv.style.display = 'block';
        resultadoDiv.innerHTML = `
            <div style="background:#1e293b; padding:12px; border-radius:8px; border:1px solid #38bdf8; text-align:center;">
                <div style="font-size:14px; font-weight:bold; color:#38bdf8; margin-bottom:6px;">
                    ⏳ Salvando atendimento e gerando RAI...
                </div>
                <div style="font-size:12px; color:#cbd5e1;">
                    Aguardando confirmação do servidor da SSP-GO.
                </div>
            </div>
        `;

        // Localiza o botão oficial de registrar/salvar do sistema
        const btnSalvar = buscarElemento(
            "#btnSalvarAtendimento",
            [
                "button[ng-click*='salvar' i]",
                "button[ng-click*='registrar' i]",
                "#btnRegistrar",
                "button.btn-success[type='submit']",
                "button.btn-primary[type='submit']"
            ]
        );

        if (!btnSalvar) {
            resultadoDiv.innerHTML = `
                <div style="background:#7f1d1d; color:#fecaca; padding:10px; border-radius:6px; font-size:12px;">
                    ⚠️ Botão de salvar não foi localizado automaticamente. Por favor, clique no botão "Salvar/Registrar" na página do sistema.
                </div>
            `;
            return;
        }

        // Aciona o clique no botão oficial de salvar do SSP-GO
        clicarElemento(btnSalvar);
        console.log("[SSP Facilitador] Botão oficial de salvar acionado.");

        // Monitora o DOM por até 25 segundos para capturar o RAI gerado
        let tempoEspera = 0;
        const intervalo = setInterval(() => {
            tempoEspera += 500;

            // Busca elementos com texto de RAI ou alerta de sucesso
            const textos = document.body.innerText;
            const matchRAI = textos.match(/RAI(?:\s*N[ºo°]?\s*|\s*:\s*|\s+)(\d{6,14})/i) ||
                             textos.match(/ATENDIMENTO(?:\s*N[ºo°]?\s*|\s*:\s*|\s+)(\d{6,14})/i);

            if (matchRAI) {
                clearInterval(intervalo);
                const numeroRAI = matchRAI[1] || matchRAI[0];
                exibirSucessoRAI(numeroRAI);
                return;
            }

            // Verifica modal ou alerta de sucesso
            const alertaSucesso = document.querySelector('.alert-success, .toast-success, .modal-title');
            if (alertaSucesso && alertaSucesso.textContent.toLowerCase().includes('sucesso')) {
                clearInterval(intervalo);
                exibirSucessoRAI(alertaSucesso.textContent.trim());
                return;
            }

            if (tempoEspera > 25000) {
                clearInterval(intervalo);
                resultadoDiv.innerHTML = `
                    <div style="background:#334155; color:#f8fafc; padding:12px; border-radius:8px; font-size:12px;">
                        ℹ️ Comando de salvamento enviado. Verifique a confirmação na tela do sistema.
                    </div>
                `;
            }
        }, 500);
    }

    function exibirSucessoRAI(numeroRAI) {
        const resultadoDiv = document.getElementById('ssp-card-resultado-rai');
        resultadoDiv.style.display = 'block';
        resultadoDiv.innerHTML = `
            <div class="ssp-badge-sucesso">
                <div style="font-size:16px; font-weight:bold; margin-bottom:4px;">✅ RAI REGISTRADO COM SUCESSO!</div>
                <div style="font-size:20px; font-weight:bold; color:#facc15; margin:8px 0; letter-spacing:1px;" id="ssp-num-rai-texto">${numeroRAI}</div>
                <button id="ssp-btn-copiar-rai" class="ssp-btn-acao ssp-btn-amarelo" style="padding:8px; font-size:13px; margin-top:8px;">
                    📋 Copiar Número do RAI
                </button>
            </div>
        `;

        document.getElementById('ssp-btn-copiar-rai').onclick = () => {
            navigator.clipboard.writeText(numeroRAI);
            mostrarToast("Número do RAI copiado!");
        };

        // Feedback sonoro/vibração no celular se suportado
        if (navigator.vibrate) {
            navigator.vibrate([100, 50, 100]);
        }
    }

    /* ==========================================================================
       TOAST / NOTIFICAÇÃO RÁPIDA NA TELA DO CELULAR
       ========================================================================== */

    function mostrarToast(mensagem) {
        let toast = document.getElementById('ssp-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'ssp-toast';
            toast.style.cssText = `
                position: fixed;
                top: 20px;
                left: 50%;
                transform: translateX(-50%);
                background: #0f172a;
                color: #f8fafc;
                border: 2px solid #eab308;
                padding: 10px 18px;
                border-radius: 30px;
                font-family: sans-serif;
                font-size: 13px;
                font-weight: bold;
                z-index: 100000000;
                box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                display: none;
                text-align: center;
                pointer-events: none;
            `;
            document.body.appendChild(toast);
        }
        toast.textContent = mensagem;
        toast.style.display = 'block';
        clearTimeout(window.__sspToastTimeout);
        window.__sspToastTimeout = setTimeout(() => {
            toast.style.display = 'none';
        }, 3200);
    }

    /* ==========================================================================
       INICIALIZAÇÃO AUTOMÁTICA
       ========================================================================== */

    function inicializar() {
        criarInterface();
        console.log("👮‍♂️ [SSP-GO Facilitador] Interface móvel carregada e pronta para uso.");
    }

    // Inicializa quando a página estiver pronta
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inicializar);
    } else {
        inicializar();
    }

    // Monitora mudanças de rota SPA no AngularJS (URL hash)
    window.addEventListener('hashchange', () => {
        setTimeout(inicializar, 800);
    });

})();
