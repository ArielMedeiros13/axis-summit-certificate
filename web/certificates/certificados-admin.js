/*
 * Module: Manual certificate-admin controller.
 * What it does: Captures manual participant entries for public and speaker certificate flows and writes them into the backend-supported data model.
 * Key design decisions: Keeps manual entry separate from the public issuer, validates the minimum identity fields on the client, and generates a deep link back into the standard issuance page.
 * System connections: Runs in `certificados-admin.html` and submits to `apps-script/axis-certificados.gs`.
 */

'use strict';

var AXIS_CERT_ADMIN_API_URL = (function () {
  if (typeof window !== 'undefined' && window.AXIS_CERT_API_URL_OVERRIDE) {
    return window.AXIS_CERT_API_URL_OVERRIDE;
  }
  return 'https://script.google.com/macros/s/YOUR_CERTIFICATES_WEB_APP_ID/exec';
}());

var adminDom = {
  form: document.getElementById('manualAdminForm'),
  speakerFields: document.getElementById('speakerFields'),
  publicFields: document.getElementById('publicFields'),
  cpf: document.getElementById('cpf'),
  resetBtn: document.getElementById('resetBtn'),
  saveBtn: document.getElementById('saveBtn'),
  saveBtnText: document.getElementById('saveBtnText'),
  saveSpinner: document.getElementById('saveSpinner'),
  feedback: document.getElementById('feedback'),
  resultCard: document.getElementById('resultCard')
};

document.addEventListener('DOMContentLoaded', function () {
  if (!adminDom.form) return;
  bindAdminEvents_();
  syncAdminTypeState_();
});

function bindAdminEvents_() {
  adminDom.form.addEventListener('submit', handleAdminSubmit_);
  adminDom.resetBtn.addEventListener('click', resetAdminForm_);
  adminDom.cpf.addEventListener('input', function (event) {
    event.target.value = formatCpf_(event.target.value);
  });

  adminDom.form.querySelectorAll('input[name="participantType"]').forEach(function (input) {
    input.addEventListener('change', syncAdminTypeState_);
  });
}

function syncAdminTypeState_() {
  var participantType = getSelectedParticipantType_();
  var isSpeaker = participantType === 'speaker';

  adminDom.speakerFields.classList.toggle('is-hidden', !isSpeaker);
  adminDom.speakerFields.setAttribute('aria-hidden', isSpeaker ? 'false' : 'true');
  adminDom.publicFields.classList.toggle('is-hidden', isSpeaker);
  adminDom.publicFields.setAttribute('aria-hidden', isSpeaker ? 'true' : 'false');
}

async function handleAdminSubmit_(event) {
  event.preventDefault();
  hideAdminFeedback_();
  hideAdminResult_();

  var payload;
  try {
    payload = collectAdminPayload_();
  } catch (err) {
    showAdminFeedback_(err.message, 'error');
    return;
  }

  setAdminLoading_(true);

  try {
    var response = await postAdminAction_('cadastrarParticipanteManual', payload);
    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'Não foi possível salvar o participante.');
    }

    showAdminFeedback_(response.message || 'Cadastro salvo com sucesso.', 'success');
    renderAdminResult_(response, payload);
  } catch (err) {
    showAdminFeedback_(err.message || 'Erro inesperado ao salvar participante.', 'error');
  } finally {
    setAdminLoading_(false);
  }
}

function collectAdminPayload_() {
  var participantType = getSelectedParticipantType_();
  var nome = String(document.getElementById('nome').value || '').trim();
  var cpf = String(adminDom.cpf.value || '').replace(/\D/g, '');
  var email = String(document.getElementById('email').value || '').trim().toLowerCase();
  var dias = getSelectedDays_();
  var atividade = String(document.getElementById('atividade').value || '').trim();
  var cargo = String(document.getElementById('cargo').value || '').trim();

  if (!participantType) throw new Error('Selecione o tipo do participante.');
  if (nome.length < 3) throw new Error('Informe um nome válido.');
  if (cpf.length !== 11) throw new Error('Informe um CPF válido com 11 dígitos.');
  if (!email || email.indexOf('@') === -1) throw new Error('Informe um e-mail válido.');
  if (participantType === 'publico' && !dias.length) {
    throw new Error('Selecione pelo menos um dia para público geral.');
  }

  return {
    participantType: participantType,
    nome: nome,
    cpf: cpf,
    email: email,
    dias: dias,
    atividade: atividade,
    cargo: cargo
  };
}

function getSelectedParticipantType_() {
  var checked = adminDom.form.querySelector('input[name="participantType"]:checked');
  return checked ? checked.value : '';
}

function getSelectedDays_() {
  return Array.prototype.slice.call(
    adminDom.form.querySelectorAll('input[name="dias"]:checked')
  ).map(function (input) {
    return input.value;
  });
}

async function postAdminAction_(action, payload) {
  var response;

  try {
    response = await fetch(AXIS_CERT_ADMIN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        action: action,
        payload: Object.assign({ _trap: '' }, payload || {})
      })
    });
  } catch (networkErr) {
    throw new Error('Falha de conexão com o backend de certificados. ' + networkErr.message);
  }

  var text = await response.text();

  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('O backend respondeu em formato inválido.');
  }
}

function renderAdminResult_(response, payload) {
  var participant = response.participant || {};
  var isSpeaker = response.participantType === 'speaker';
  var savedTo = Array.isArray(response.savedTo) && response.savedTo.length
    ? response.savedTo.join(', ')
    : 'base atual';
  var daysLabel = payload.dias && payload.dias.length ? payload.dias.join(' e ') + ' de março' : '10 e 11 de março';
  var emissionUrl = buildEmissionUrl_(payload);

  adminDom.resultCard.innerHTML = [
    '<h2>Cadastro pronto para emissão</h2>',
    '<p><strong>' + escapeHtml_(participant.nome || payload.nome) + '</strong> foi registrado como <strong>' + escapeHtml_(isSpeaker ? 'speaker' : 'público geral') + '</strong> nas abas <strong>' + escapeHtml_(savedTo) + '</strong>.</p>',
    '<div class="result-card__meta">',
    isSpeaker && participant.atividade ? '<span class="result-card__pill">Atividade: ' + escapeHtml_(participant.atividade) + '</span>' : '',
    isSpeaker && participant.cargo ? '<span class="result-card__pill">Função/cargo: ' + escapeHtml_(participant.cargo) + '</span>' : '',
    !isSpeaker ? '<span class="result-card__pill">Dias: ' + escapeHtml_(daysLabel) + '</span>' : '',
    '</div>',
    '<p>Você já pode abrir o emissor normal com os dados preenchidos para validar a emissão desse cadastro.</p>',
    '<a class="result-card__link" href="' + escapeAttr_(emissionUrl) + '" target="_blank" rel="noopener noreferrer">Abrir emissão normal</a>'
  ].join('');

  adminDom.resultCard.classList.remove('is-hidden');
}

function buildEmissionUrl_(payload) {
  var url = new URL('certificados.html', window.location.href);
  url.searchParams.set('nome', payload.nome);
  url.searchParams.set('email', payload.email);

  (payload.dias && payload.dias.length ? payload.dias : ['10', '11']).forEach(function (day) {
    url.searchParams.append('dias', day);
  });

  return url.toString();
}

function resetAdminForm_() {
  adminDom.form.reset();
  adminDom.cpf.value = '';
  hideAdminFeedback_();
  hideAdminResult_();
  syncAdminTypeState_();
}

function setAdminLoading_(isLoading) {
  adminDom.saveBtn.disabled = isLoading;
  adminDom.resetBtn.disabled = isLoading;
  adminDom.saveBtnText.textContent = isLoading ? 'Salvando...' : 'Salvar participante';
  adminDom.saveSpinner.classList.toggle('is-hidden', !isLoading);
}

function showAdminFeedback_(message, tone) {
  adminDom.feedback.textContent = message;
  adminDom.feedback.dataset.tone = tone || 'success';
  adminDom.feedback.classList.remove('is-hidden');
}

function hideAdminFeedback_() {
  adminDom.feedback.textContent = '';
  adminDom.feedback.removeAttribute('data-tone');
  adminDom.feedback.classList.add('is-hidden');
}

function hideAdminResult_() {
  adminDom.resultCard.innerHTML = '';
  adminDom.resultCard.classList.add('is-hidden');
}

function formatCpf_(value) {
  var digits = String(value || '').replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return digits.replace(/(\d{3})(\d+)/, '$1.$2');
  if (digits.length <= 9) return digits.replace(/(\d{3})(\d{3})(\d+)/, '$1.$2.$3');
  return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2}).*/, '$1.$2.$3-$4');
}

function escapeHtml_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr_(value) {
  return escapeHtml_(value);
}
