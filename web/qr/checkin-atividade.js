/*
 * Module: Public QR check-in controller.
 * What it does: Validates the incoming activity token, hydrates the session header, and submits attendee presence for the selected activity.
 * Key design decisions: Uses explicit loading, invalid, form, and success states so the attendee always knows whether the QR or submission was accepted.
 * System connections: Runs in `checkin-atividade.html`, relies on `AxisApi` and `AxisCommon`, and writes attendance via `confirmarCheckinAtividade_` in `apps-script/axis-credenciamento.gs`.
 */

'use strict';
// ============================================================
// AXIS Summit 2026 — checkin-atividade.js
// Página pública de confirmação de presença via QR.
// ============================================================

var params = new URLSearchParams(window.location.search);

var dom = {
  activityTitle: document.getElementById('activityTitle'),
  activityMeta:  document.getElementById('activityMeta'),
  stateLoading:  document.getElementById('stateLoading'),
  stateInvalid:  document.getElementById('stateInvalid'),
  stateForm:     document.getElementById('stateForm'),
  stateSuccess:  document.getElementById('stateSuccess'),
  invalidMsg:    document.getElementById('invalidMsg'),
  successMsg:    document.getElementById('successMsg'),
  fNome:         document.getElementById('fNome'),
  fEmail:        document.getElementById('fEmail'),
  fTelefone:     document.getElementById('fTelefone'),
  submitBtn:     document.getElementById('submitBtn'),
  formFeedback:  document.getElementById('formFeedback')
};

var currentActivity = null;
var currentToken    = '';

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  dom.submitBtn.addEventListener('click', handleSubmit);

  var id    = params.get('id')    || '';
  var token = params.get('token') || '';
  currentToken = token;

  if (!id || !token) {
    return showInvalid('Link incompleto. Abra o QR oficial da atividade.');
  }

  try {
    var res = await AxisApi.call({
      action:       'validarTokenAtividade',
      atividade_id: id,
      token:        token
    });

    if (!res.ok || !res.atividade) {
      var msgs = {
        atividade_nao_encontrada: 'Atividade não encontrada. O QR pode estar desatualizado.',
        atividade_inativa:        'Esta atividade não está mais ativa.',
        atividade_inelegivel:     'Esta atividade não aceita check-in via QR.',
        atividade_sem_token:      'Atividade sem token registrado. Contate o organizador.',
        token_invalido:           'QR inválido ou expirado. Solicite um novo ao monitor.',
        link_incompleto:          'Link incompleto. Use o QR oficial da atividade.'
      };
      var code = res && res.code ? res.code : '';
      return showInvalid(msgs[code] || res.message || 'QR inválido.');
    }

    currentActivity = res.atividade;
    hydrateHeader(currentActivity);
    show(dom.stateForm);

  } catch (err) {
    showInvalid('Não foi possível validar o QR agora. Verifique sua conexão e tente novamente.');
  }
}

// ── PREENCHER CABEÇALHO ───────────────────────────────────────
function hydrateHeader(activity) {
  dom.activityTitle.textContent = activity.titulo;
  dom.activityMeta.innerHTML =
    '<span>' + esc(AxisCommon.fmtDay(activity.dia)) + '</span>' +
    '<span>' + esc(AxisCommon.fmtTime(activity.horario, activity.horario_fim)) + '</span>' +
    '<span>' + esc(activity.palco || 'Sem palco') + '</span>' +
    '<span>' + esc(activity.tipo  || 'ATIVIDADE') + '</span>';
}

// ── SUBMIT ────────────────────────────────────────────────────
async function handleSubmit() {
  hideFeedback();

  if (!currentActivity) return showInvalid('Atividade indisponível.');

  var nome     = dom.fNome.value.trim();
  var email    = dom.fEmail.value.trim();
  var telefone = dom.fTelefone.value.trim();

  // Validação local
  if (nome.length < 3) {
    return showFeedback('Informe seu nome completo (mínimo 3 caracteres).', 'error');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return showFeedback('Informe um e-mail válido.', 'error');
  }

  setLoading(true);

  try {
    var res = await AxisApi.call({
      action:       'confirmarCheckinAtividade',
      atividade_id: currentActivity.atividade_id,
      token:        currentToken,
      nome:         nome,
      email:        email,
      telefone:     telefone,
      origem:       'qr_publico',
      user_agent:   navigator.userAgent,
      ip_hint:      ''
    });

    if (!res.ok) {
      return showFeedback(res.message || 'Não foi possível confirmar agora. Tente novamente.', 'error');
    }

    // Duplicata: também é "sucesso" — já estava registrado
    if (res.duplicated) {
      dom.successMsg.textContent = 'Sua presença nesta atividade já estava registrada. Tudo certo!';
      show(dom.stateSuccess);
      return;
    }

    dom.successMsg.textContent = res.message || 'Presença confirmada em "' + currentActivity.titulo + '".';
    show(dom.stateSuccess);

  } catch (err) {
    showFeedback(
      'Falha de conexão. Verifique sua internet e tente novamente.',
      'error'
    );
  } finally {
    setLoading(false);
  }
}

// ── HELPERS DE ESTADO ─────────────────────────────────────────
function show(target) {
  [dom.stateLoading, dom.stateInvalid, dom.stateForm, dom.stateSuccess].forEach(function (el) {
    el.classList.add('hidden');
  });
  target.classList.remove('hidden');
}

function showInvalid(msg) {
  dom.invalidMsg.textContent = msg;
  show(dom.stateInvalid);
}

function showFeedback(msg, type) {
  dom.formFeedback.textContent = msg;
  dom.formFeedback.className   = 'feedback ' + (type || 'error');
}

function hideFeedback() {
  dom.formFeedback.textContent = '';
  dom.formFeedback.className   = 'feedback hidden';
}

function setLoading(loading) {
  dom.submitBtn.disabled    = loading;
  dom.submitBtn.textContent = loading ? 'Confirmando...' : 'Confirmar presença';
}

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
