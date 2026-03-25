/*
 * Module: Monitor portal controller.
 * What it does: Handles monitor authentication, participant search, speaker credentialing, late registration, stats refresh, and hourly flow visualization.
 * Key design decisions: Keeps the UI stateful but lightweight, persists the operator session in local storage, and treats duplicate check-ins as explicit operational feedback instead of generic failures.
 * System connections: Runs inside `monitores.html`, calls `AxisApi`, and drives writes and reads against `apps-script/axis-credenciamento.gs`.
 */

'use strict';
// ============================================================
// AXIS Summit 2026 — monitores.js
// Portal de monitores: login, busca público, busca speakers,
// check-in diário público, check-in diário speakers,
// cadastro posterior, estatísticas e gráfico de fluxo.
// Regra: nunca remover funções. Apenas adicionar/corrigir.
// ============================================================

// ── ELEMENTOS ────────────────────────────────────────────────
var el = {
  // Login
  screenLogin:    document.getElementById('screenLogin'),
  screenApp:      document.getElementById('screenApp'),
  loginCpf:       document.getElementById('loginCpf'),
  loginSenha:     document.getElementById('loginSenha'),
  loginBtn:       document.getElementById('loginBtn'),
  loginFeedback:  document.getElementById('loginFeedback'),
  logoutBtn:      document.getElementById('logoutBtn'),
  topbarName:     document.getElementById('topbarName'),

  // Dia / refresh
  diaEvento:      document.getElementById('diaEvento'),
  refreshBtn:     document.getElementById('refreshBtn'),

  // Stats
  statTotal:      document.getElementById('statTotal'),
  statSpeakers:   document.getElementById('statSpeakers'),
  statHora:       document.getElementById('statHora'),

  // Abas
  tabs:           document.querySelectorAll('.tab'),
  tabPanels:      document.querySelectorAll('.tab-panel'),

  // Aba público
  buscaPublico:       document.getElementById('buscaPublico'),
  buscaPublicoBtn:    document.getElementById('buscaPublicoBtn'),
  buscaPublicoFb:     document.getElementById('buscaPublicoFeedback'),
  resultadosPublico:  document.getElementById('resultadosPublico'),

  // Aba speakers
  buscaSpeaker:      document.getElementById('buscaSpeaker'),
  buscaSpeakerBtn:   document.getElementById('buscaSpeakerBtn'),
  buscaSpeakerFb:    document.getElementById('buscaSpeakerFeedback'),
  resultadosSpeakers:document.getElementById('resultadosSpeakers'),

  // Aba posterior
  cadNome:      document.getElementById('cadNome'),
  cadCpf:       document.getElementById('cadCpf'),
  cadEmail:     document.getElementById('cadEmail'),
  cadTelefone:  document.getElementById('cadTelefone'),
  cadBtn:       document.getElementById('cadBtn'),
  cadFeedback:  document.getElementById('cadFeedback'),

  // Gráfico
  barChart: document.getElementById('barChart')
};

// ── ESTADO ────────────────────────────────────────────────────
var state = {
  monitor:  null,   // { nome, email, perfil }
  statsMap: {}      // dia → { total, total_speakers, por_hora }
};

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  hydrateSession();
  bindLogin();
  bindApp();
});

// ── SESSION ───────────────────────────────────────────────────
function hydrateSession() {
  try {
    var raw = localStorage.getItem('axis_monitor_v3');
    if (!raw) return;
    state.monitor = JSON.parse(raw);
    afterLogin();
  } catch (_) {
    localStorage.removeItem('axis_monitor_v3');
  }
}

// ── LOGIN ─────────────────────────────────────────────────────
function bindLogin() {
  el.loginBtn.addEventListener('click', handleLogin);
  el.loginCpf.addEventListener('keydown', function (e) { if (e.key === 'Enter') el.loginSenha.focus(); });
  el.loginSenha.addEventListener('keydown', function (e) { if (e.key === 'Enter') handleLogin(); });
}

async function handleLogin() {
  hideFb(el.loginFeedback);
  var cpf   = el.loginCpf.value.trim();
  var senha = el.loginSenha.value;

  if (!cpf || !senha) {
    return showFb(el.loginFeedback, 'Informe CPF e senha.', 'error');
  }

  setBtn(el.loginBtn, true, 'Verificando...');

  try {
    var res = await AxisApi.call({ action: 'login', cpf: cpf, senha: senha });
    if (!res.ok) return showFb(el.loginFeedback, res.message || 'CPF ou senha inválidos.', 'error');

    state.monitor = res.monitor;
    localStorage.setItem('axis_monitor_v3', JSON.stringify(state.monitor));
    afterLogin();
  } catch (err) {
    showFb(el.loginFeedback, diagnosticarErro(err), 'error');
  } finally {
    setBtn(el.loginBtn, false, 'Entrar');
  }
}

function afterLogin() {
  el.screenLogin.classList.add('hidden');
  el.screenApp.classList.remove('hidden');
  el.topbarName.textContent = state.monitor.nome;
  refreshDashboard();
}

function handleLogout() {
  localStorage.removeItem('axis_monitor_v3');
  state.monitor = null;
  el.screenApp.classList.add('hidden');
  el.screenLogin.classList.remove('hidden');
  el.loginSenha.value = '';
  hideFb(el.loginFeedback);
}

// ── APP ───────────────────────────────────────────────────────
function bindApp() {
  el.logoutBtn.addEventListener('click', handleLogout);
  el.refreshBtn.addEventListener('click', refreshDashboard);
  el.diaEvento.addEventListener('change', refreshDashboard);

  // Abas
  el.tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var target = tab.getAttribute('data-tab');
      el.tabs.forEach(function (t) { t.classList.remove('active'); });
      el.tabPanels.forEach(function (p) {
        p.classList.toggle('hidden', p.id !== target);
        p.classList.toggle('active', p.id === target);
      });
      tab.classList.add('active');
    });
  });

  // Público
  el.buscaPublicoBtn.addEventListener('click', handleBuscaPublico);
  el.buscaPublico.addEventListener('keydown', function (e) { if (e.key === 'Enter') handleBuscaPublico(); });

  // Speakers
  el.buscaSpeakerBtn.addEventListener('click', handleBuscaSpeaker);
  el.buscaSpeaker.addEventListener('keydown', function (e) { if (e.key === 'Enter') handleBuscaSpeaker(); });

  // Posterior
  el.cadBtn.addEventListener('click', handleCadastroPosterior);
}

// ── DASHBOARD ─────────────────────────────────────────────────
// Hora local em Brasilia (UTC-3), independente do fuso do dispositivo
function horaBrasilia_() {
  var n = new Date();
  return new Date(n.getTime() + (n.getTimezoneOffset() + (-3 * 60)) * 60000);
}

async function refreshDashboard() {
  setBtn(el.refreshBtn, true, '...');
  var debugEl = document.getElementById('axisDebug');
  try {
    var dia = el.diaEvento.value;

    // Tenta obter estatísticas normalmente
    var res = await AxisApi.call({ action: 'obterEstatisticas', dia_evento: dia });

    if (debugEl) debugEl.textContent = 'dia=' + dia + ' res=' + JSON.stringify(res);

    if (!res || !res.ok) {
      el.statTotal.textContent    = '—';
      el.statSpeakers.textContent = '—';
      el.statHora.textContent     = '—';
      return;
    }

    // Se o backend corrigido ainda não foi aplicado, total virá 0
    // mesmo havendo logs. Detectamos isso e buscamos via contarCheckins
    // com fallback para healthcheck (que retorna logs_rows totais).
    if (res.total === 0) {
      var hc = await AxisApi.call({ action: 'healthcheck' });
      if (hc && hc.ok && hc.logs_rows > 0) {
        if (debugEl) debugEl.textContent +=
          ' | AVISO: backend retornou total=0 mas healthcheck mostra ' +
          hc.logs_rows + ' logs. Aplique o backend.gs corrigido no GAS (Ctrl+S, sem novo deploy).';
      }
    }

    state.statsMap[dia] = res;
    el.statTotal.textContent    = String(res.total != null ? res.total : 0);
    el.statSpeakers.textContent = String(res.total_speakers != null ? res.total_speakers : 0);

    var horaKey = String(horaBrasilia_().getHours());
    el.statHora.textContent = String(
      (res.por_hora && res.por_hora[horaKey] != null) ? res.por_hora[horaKey] : 0
    );

    renderChart(res.por_hora || {});
  } catch (err) {
    el.statTotal.textContent    = '—';
    el.statSpeakers.textContent = '—';
    el.statHora.textContent     = '—';
    if (debugEl) debugEl.textContent = 'ERRO: ' + String(err && err.message ? err.message : err);
  } finally {
    setBtn(el.refreshBtn, false, '↺ Atualizar');
  }
}

// ── BUSCA PÚBLICO ─────────────────────────────────────────────
async function handleBuscaPublico() {
  var termo = el.buscaPublico.value.trim();
  hideFb(el.buscaPublicoFb);
  el.resultadosPublico.innerHTML = '';

  if (termo.length < 2) {
    return showFb(el.buscaPublicoFb, 'Digite ao menos 2 caracteres para buscar.', 'error');
  }

  setBtn(el.buscaPublicoBtn, true, 'Buscando...');

  try {
    var res = await AxisApi.call({ action: 'buscarParticipantes', termo: termo });

    if (!res.ok) {
      return showFb(el.buscaPublicoFb, res.message || 'Falha na busca.', 'error');
    }

    var lista = res.resultados || [];

    if (!lista.length) {
      return showFb(
        el.buscaPublicoFb,
        'Nenhum participante encontrado para "' + esc(termo) + '".\n' +
        'Se a pessoa não está na base, use a aba "Cadastro posterior".',
        'warn'
      );
    }

    lista.forEach(function (item) {
      el.resultadosPublico.appendChild(buildResultCard(item, 'publico'));
    });

  } catch (err) {
    showFb(el.buscaPublicoFb, diagnosticarErro(err), 'error');
  } finally {
    setBtn(el.buscaPublicoBtn, false, 'Buscar');
  }
}

// ── BUSCA SPEAKERS ────────────────────────────────────────────
async function handleBuscaSpeaker() {
  var termo = el.buscaSpeaker.value.trim();
  hideFb(el.buscaSpeakerFb);
  el.resultadosSpeakers.innerHTML = '';

  if (termo.length < 2) {
    return showFb(el.buscaSpeakerFb, 'Digite ao menos 2 caracteres para buscar.', 'error');
  }

  setBtn(el.buscaSpeakerBtn, true, 'Buscando...');

  try {
    var res = await AxisApi.call({ action: 'buscarSpeakers', termo: termo });

    if (!res.ok) {
      return showFb(el.buscaSpeakerFb, res.message || 'Falha na busca.', 'error');
    }

    var lista = res.resultados || [];

    if (!lista.length) {
      return showFb(
        el.buscaSpeakerFb,
        'Nenhum speaker encontrado para "' + esc(termo) + '".\n' +
        'Verifique se a programação foi sincronizada no Painel QR.',
        'warn'
      );
    }

    lista.forEach(function (item) {
      el.resultadosSpeakers.appendChild(buildResultCard(item, 'speaker'));
    });

  } catch (err) {
    showFb(el.buscaSpeakerFb, diagnosticarErro(err), 'error');
  } finally {
    setBtn(el.buscaSpeakerBtn, false, 'Buscar');
  }
}

// ── CARD DE RESULTADO ─────────────────────────────────────────
function buildResultCard(item, tipo) {
  var isSpeaker = tipo === 'speaker' || item.categoria === 'speaker';
  var card = document.createElement('div');
  card.className = 'result-card' + (isSpeaker ? ' is-speaker' : '');

  var metaHtml = '';
  if (item.email)        metaHtml += '<span class="chip">' + esc(item.email) + '</span>';
  if (item.telefone)     metaHtml += '<span class="chip">' + esc(item.telefone) + '</span>';
  if (isSpeaker)         metaHtml += '<span class="chip speaker">🎤 Speaker</span>';
  if (item.origem_label) metaHtml += '<span class="chip">' + esc(item.origem_label) + '</span>';

  var btnLabel = isSpeaker ? 'Fazer check-in de speaker' : 'Fazer check-in do dia';
  var btnClass = isSpeaker ? 'btn btn-primary full' : 'btn btn-primary full';

  card.innerHTML =
    '<div class="result-name">' + esc(item.nome || 'Sem nome') + '</div>' +
    '<div class="result-meta">' + metaHtml + '</div>' +
    '<div class="result-actions">' +
      '<button class="' + btnClass + '" data-action="checkin">' + btnLabel + '</button>' +
    '</div>' +
    '<div class="result-fb feedback hidden"></div>';

  card.querySelector('[data-action="checkin"]').addEventListener('click', function () {
    if (isSpeaker) {
      registrarCheckinSpeaker(item, card);
    } else {
      registrarCheckinPublico(item, card);
    }
  });

  return card;
}

// ── CHECK-IN PÚBLICO ──────────────────────────────────────────
async function registrarCheckinPublico(item, card) {
  var fb  = card.querySelector('.result-fb');
  var btn = card.querySelector('[data-action="checkin"]');
  hideFb(fb);
  setBtn(btn, true, 'Credenciando...');

  try {
    var res = await AxisApi.call({
      action:                 'registrarCheckin',
      dia_evento:             el.diaEvento.value,
      nome_participante:      item.nome,
      email_participante:     item.email,
      telefone_participante:  item.telefone || '',
      categoria:              item.categoria || 'publico',
      monitor_nome:           state.monitor.nome,
      monitor_email:          state.monitor.email
    });

    if (!res.ok) {
      var msg = res.duplicated
        ? '⚠ ' + item.nome + ' já foi credenciado hoje.'
        : (res.message || 'Não foi possível registrar.');
      showFb(fb, msg, res.duplicated ? 'warn' : 'error');
      setBtn(btn, false, 'Fazer check-in do dia');
      return;
    }

    showFb(fb, '✓ Check-in realizado — ' + item.nome, 'success');
    btn.textContent = '✓ Credenciado';
    btn.disabled    = true;
    refreshDashboard();

  } catch (err) {
    showFb(fb, diagnosticarErro(err), 'error');
    setBtn(btn, false, 'Fazer check-in do dia');
  }
}

// ── CHECK-IN SPEAKER ──────────────────────────────────────────
async function registrarCheckinSpeaker(item, card) {
  var fb  = card.querySelector('.result-fb');
  var btn = card.querySelector('[data-action="checkin"]');
  hideFb(fb);
  setBtn(btn, true, 'Credenciando speaker...');

  try {
    var res = await AxisApi.call({
      action:         'registrarCheckinSpeaker',
      dia_evento:     el.diaEvento.value,
      nome_speaker:   item.nome,
      email_speaker:  item.email  || '',
      cpf_speaker:    item.cpf    || '',
      monitor_nome:   state.monitor.nome,
      monitor_email:  state.monitor.email
    });

    if (!res.ok) {
      var msg = res.duplicated
        ? '⚠ ' + item.nome + ' já foi credenciado como speaker hoje.'
        : (res.message || 'Não foi possível registrar.');
      showFb(fb, msg, res.duplicated ? 'warn' : 'error');
      setBtn(btn, false, 'Fazer check-in de speaker');
      return;
    }

    showFb(fb, '✓ Check-in de speaker realizado — ' + item.nome, 'success');
    btn.textContent = '✓ Speaker credenciado';
    btn.disabled    = true;
    refreshDashboard();

  } catch (err) {
    showFb(fb, diagnosticarErro(err), 'error');
    setBtn(btn, false, 'Fazer check-in de speaker');
  }
}

// ── CADASTRO POSTERIOR ────────────────────────────────────────
async function handleCadastroPosterior() {
  hideFb(el.cadFeedback);

  var nome     = el.cadNome.value.trim();
  var cpf      = el.cadCpf.value.trim();
  var email    = el.cadEmail.value.trim();
  var telefone = el.cadTelefone.value.trim();

  if (!nome) return showFb(el.cadFeedback, 'Informe o nome.', 'error');

  setBtn(el.cadBtn, true, 'Salvando...');

  try {
    var res = await AxisApi.call({
      action:        'cadastrarParticipante',
      nome:          nome,
      cpf:           cpf,
      email:         email,
      telefone:      telefone,
      monitor_nome:  state.monitor.nome,
      monitor_email: state.monitor.email,
      origem:        'painel_monitores'
    });

    if (!res.ok) return showFb(el.cadFeedback, res.message || 'Falha ao salvar.', 'error');

    showFb(el.cadFeedback, '✓ ' + (res.message || 'Cadastro salvo com sucesso.'), 'success');
    el.cadNome.value     = '';
    el.cadCpf.value      = '';
    el.cadEmail.value    = '';
    el.cadTelefone.value = '';
    refreshDashboard();

  } catch (err) {
    showFb(el.cadFeedback, diagnosticarErro(err), 'error');
  } finally {
    setBtn(el.cadBtn, false, 'Salvar e credenciar');
  }
}

// ── GRÁFICO ───────────────────────────────────────────────────
function renderChart(data) {
  el.barChart.innerHTML = '';
  var horaAtual = horaBrasilia_().getHours();
  var max = 1;
  for (var h = 7; h <= 22; h++) {
    var v = Number(data[String(h)] || 0);
    if (v > max) max = v;
  }
  for (var h = 7; h <= 22; h++) {
    var value = Number(data[String(h)] || 0);
    var pct   = Math.max(6, (value / max) * 100);
    var col   = document.createElement('div');
    col.className = 'bar';
    col.innerHTML =
      '<div class="bar-count">' + (value || '') + '</div>' +
      '<div class="bar-fill' + (h === horaAtual ? ' now' : '') + (value === 0 ? ' zero' : '') + '" style="height:' + pct + 'px"></div>' +
      '<div class="bar-label">' + String(h).padStart(2,'0') + 'h</div>';
    el.barChart.appendChild(col);
  }
}

// ── HELPERS UI ────────────────────────────────────────────────
function showFb(el, msg, type) {
  el.textContent = msg;
  el.className   = 'feedback ' + (type || 'error');
}
function hideFb(el) {
  el.textContent = '';
  el.className   = 'feedback hidden';
}
function setBtn(btn, loading, label) {
  btn.disabled    = loading;
  btn.textContent = label;
}
function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function diagnosticarErro(err) {
  var msg = String(err && err.message ? err.message : err);
  if (msg.indexOf('JSON') !== -1 || msg.indexOf('HTML') !== -1)
    return 'A API retornou resposta inválida. Verifique se o deploy está atualizado e publicado.';
  if (msg.indexOf('excedido') !== -1 || msg.indexOf('Abort') !== -1)
    return 'Tempo limite excedido. Internet instável — tente novamente.';
  if (msg.indexOf('ocupado') !== -1)
    return 'Sistema ocupado. Aguarde alguns segundos e tente novamente.';
  return msg || 'Erro desconhecido.';
}
