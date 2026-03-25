/**
 * Module: Certificate issuance and validation backend.
 * What it does: Handles certificate issuance, reissue, lookup, public validation, manual participant recovery, and audit logging for the AXIS Summit attendance base.
 * Key design decisions: Resolves eligibility from multiple attendance sheets, generates deterministic certificate keys, rate-limits public actions, and preserves reissue history instead of creating duplicate records.
 * System connections: Serves the frontends under `web/certificates` and reads from the spreadsheet structures populated by the credentialing and QR flows.
 */

/**
 * AXIS Summit 2026 - Certificates backend.
 * Backend Apps Script - v2026.03.17.v13
 *
 * Portfolio notes:
 * - Legacy duplicate backend sections were consolidated into one file.
 * - Security hardening from the production flow was preserved.
 * - Speaker issuance remains a priority path before the general-public rules.
 * - The `Speakers` sheet is the canonical source for speaker identity and activity metadata.
 * - Older certificate records are enriched on read and on reissue.
 */

function getCertSalt_() {
  var salt = PropertiesService.getScriptProperties().getProperty('CERT_SALT');
  if (!salt || salt.trim() === '') {
    throw new Error(
      'CERT_SALT nÃ£o configurado. Configure via Project Settings > Script Properties. ' +
      'Adicione a chave CERT_SALT com um valor longo e aleatÃ³rio antes de usar o sistema.'
    );
  }
  return salt.trim();
}

var CERT_CONFIG = {
  SPREADSHEET_ID:       (typeof CONFIG !== 'undefined' && CONFIG.SPREADSHEET_ID) || 'REPLACE_WITH_YOUR_SPREADSHEET_ID',
  SHEET_CERTIFICADOS:   'Certificados',
  SHEET_AUDITORIA:      'AuditoriaCertificados',
  SHEET_SPEAKERS:       'Speakers',
  SHEET_LOGS_SPEAKERS:  'LogsSpeakers',
  SHEET_SPECIAL_CERTS:  'atelie-rodada',
  SHEET_POSTERIOR:      'Posterior',
  SHEET_PUBLICO:        'Publico',
  SHEET_PUBLICO_ALT:    'PÃºblico',
  EVENT_NAME:           'AXIS Summit',
  EVENT_YEAR:           '2026',
  EVENT_SLOGAN:         'A Cultura Vira o Jogo!',
  GUDI_SLOGAN:          'Viva O Bom da Vida!',
  EVENT_DATE_LABEL:     '10 e 11 de marÃ§o de 2026',
  EVENT_HOURS_LABEL:    'das 9h Ã s 19h',
  EVENT_LOCAL:          'Famecos â€“ PUCRS, Porto Alegre, RS',
  ALLOWED_DAYS:         ['10', '11'],
  SPECIAL_CERT_DAY:     '11',
  STATUS_ACTIVE:        'active',
  MANUAL_REVIEW_EMAIL:  'certificates@example.com',
  PRIORITY_SHEETS:      ['Logs', 'LogsSpeakers', 'Posterior', 'PÃºblico', 'Publico', 'PrÃ©via CPF', 'PrÃ©via_CPF', 'Speakers', 'Monitores'],
  SKIP_SHEETS:          ['Certificados', 'AuditoriaCertificados', 'Atividades', 'CheckinsAtividade'],
  RATE_LIMIT_EMIT:      10,
  RATE_LIMIT_VALIDATE:  30,
  RATE_LIMIT_BUSCAR:    10,
  RATE_LIMIT_MANUAL:    3
};

var CERT_HEADERS = [
  'certificate_key', 'validation_code', 'participant_key',
  'participant_name', 'cpf_normalized', 'email_normalized',
  'dias_key', 'dias_label', 'participant_source_id',
  'issued_at_iso', 'last_reissued_at_iso', 'issue_count',
  'status', 'pdf_url', 'meta_json'
];

var SHEET_COL_OVERRIDES = {
  'Logs':         { nome: 'nome_participante', email: 'email_participante', dia: 'dia_evento' },
  'LogsSpeakers': { nome: 'nome_speaker', email: 'email_speaker', cpf: 'cpf_speaker', dia: 'dia_evento' },
  'Posterior':    { nome: 'nome', email: 'email', cpf: 'cpf', dia: 'timestamp' },
  'Monitores':    { nome: 'nome', email: 'email', cpf: 'cpf' },
  'Speakers':     { nome: 'nome', email: 'email', cpf: 'cpf' },
  'PÃºblico':      { nome: 'nome', email: 'email' },
  'Publico':      { nome: 'nome', email: 'email' },
  'PrÃ©via CPF':   { nome: 'nome_publico', email: 'email_publico', cpf: 'cpf_encontrado' },
  'PrÃ©via_CPF':   { nome: 'nome_publico', email: 'email_publico', cpf: 'cpf_encontrado' }
};

var COL_VARIANTS = {
  nome:   ['nome_participante', 'nome_speaker', 'nome_publico', 'nome', 'name', 'participant_name', 'nome_completo', 'full_name'],
  email:  ['email_participante', 'email_speaker', 'email_publico', 'email', 'e-mail', 'mail'],
  cpf:    ['cpf_speaker', 'cpf_encontrado', 'cpf_normalizado', 'cpf', 'documento', 'document'],
  dia:    ['dia_evento', 'data_evento', 'dia', 'data', 'timestamp', 'dia_checkin'],
  status: ['status', 'presenca', 'presente', 'checkin', 'participou']
};

var SPEAKERS_COLS = {
  nome:       0,
  email:      1,
  cpf:        2,
  origem:     3,
  credencial: 4,
  ativo:      5
};

var LOGS_SPEAKERS_COLS = {
  dia:    1,
  nome:   2,
  origem: 7
};

var EDITORIAL_LOWERCASE_WORDS = {
  a: true, as: true, o: true, os: true,
  de: true, da: true, das: true, do: true, dos: true,
  e: true, em: true,
  na: true, nas: true, no: true, nos: true,
  para: true, por: true
};

var EDITORIAL_SPECIAL_WORDS = {
  api: 'API',
  app: 'App',
  axis: 'AXIS',
  cpf: 'CPF',
  gudi: 'Gudi',
  ia: 'IA',
  lancamento: 'LanÃ§amento',
  pucrs: 'PUCRS',
  qr: 'QR',
  rs: 'RS',
  rh: 'RH',
  ti: 'TI',
  ui: 'UI',
  ux: 'UX'
};

function sanitizeTextField_(value, maxLen) {
  var text = String(value || '')
    .replace(/[\u0000-\u001F\u007F<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (maxLen && text.length > maxLen) return text.slice(0, maxLen);
  return text;
}

function normalizeValidationCode_(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 16);
}

function isValidationCodeFormat_(code) {
  return /^AXIS-[A-F0-9]{7}-[A-F0-9]{3}$/.test(String(code || ''));
}

function doPost(e) {
  try {
    var requestBody = e && e.postData && e.postData.contents;
    var request = {};
    if (requestBody) {
      try {
        request = JSON.parse(requestBody);
      } catch (err) {
        throw new Error('JSON invÃ¡lido: ' + err.message);
      }
    }

    var action = String(request.action || '').trim();
    var payload = request.payload || {};

    if (payload._trap && String(payload._trap).trim() !== '') {
      return jsonOutput_({ ok: false, error: 'RequisiÃ§Ã£o invÃ¡lida.', code: 'HONEYPOT_TRIGGERED' });
    }

    if (!action) throw new Error('Campo "action" Ã© obrigatÃ³rio.');
    ensureCertificatesSheet_();

    switch (action) {
      case 'healthcheck':                   return jsonOutput_(handleHealthcheck_());
      case 'cadastrarParticipanteManual':   return jsonOutput_(handleManualParticipantUpsert_(payload));
      case 'emitirCertificado':             return jsonOutput_(handleEmitCertificate_(payload));
      case 'buscarCertificado':             return jsonOutput_(handleFindCertificate_(payload));
      case 'reemitirCertificado':           return jsonOutput_(handleEmitCertificate_(payload));
      case 'validarCertificado':            return jsonOutput_(handleValidateCertificate_(payload));
      case 'solicitarAvaliacaoCertificado': return jsonOutput_(handleManualReview_(payload));
      default:                              return jsonOutput_({ ok: false, error: 'AÃ§Ã£o invÃ¡lida: ' + action });
    }
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    try { logCertificateAudit_('error', { scope: 'doPost', message: msg }); } catch (_) {}
    return jsonOutput_({ ok: false, error: 'Erro interno.', code: 'INTERNAL_ERROR' });
  }
}

function doGet(e) {
  try {
    var action = String((e && e.parameter && e.parameter.action) || '').trim();
    ensureCertificatesSheet_();
    if (action === 'validarCertificado') {
      return jsonOutput_(handleValidateCertificate_({
        validationCode: String((e.parameter && e.parameter.validationCode) || '').trim()
      }));
    }
    return jsonOutput_({
      ok: true,
      service: 'AXIS Summit 2026 â€” Certificados API',
      version: '2026.03.17.v13',
      actions: ['cadastrarParticipanteManual', 'emitirCertificado', 'buscarCertificado', 'reemitirCertificado', 'validarCertificado', 'solicitarAvaliacaoCertificado']
    });
  } catch (err) {
    try { logCertificateAudit_('error', { scope: 'doGet', message: err && err.message ? err.message : String(err) }); } catch (_) {}
    return jsonOutput_({ ok: false, error: 'Erro interno no GET.', code: 'INTERNAL_ERROR' });
  }
}

function _buildRateLimitSeed_(action, payload) {
  var parts = [String(action || 'unknown')];
  var safePayload = payload || {};

  function pushIf(label, value) {
    if (value) parts.push(label + ':' + value);
  }

  var normEmail = normalizeEmail_(safePayload.email || safePayload.email_normalized || '');
  var normCpf = normalizeCpf_(safePayload.cpf || safePayload.document || safePayload.cpf_normalized || '');
  var normCode = normalizeValidationCode_(safePayload.validationCode || safePayload.validation_code || '');
  var normName = normalizeName_(safePayload.nome || safePayload.name || '');
  var normDays = normalizeDays_(safePayload.dias || safePayload.days || safePayload.dias_key || []);
  var diasKey = normDays.length ? normDays.join('-') : '';

  pushIf('email', normEmail);
  pushIf('cpf', normCpf);
  pushIf('code', normCode);
  pushIf('nome', normName ? normName.slice(0, 60) : '');
  pushIf('dias', diasKey);

  if (String(action) === 'manual') {
    pushIf('manualCpf', normCpf);
    pushIf('manualEmail', normEmail);
  }

  return parts.join('|');
}

function _makeRateLimitKey_(action, payload) {
  var seed = _buildRateLimitSeed_(action, payload);
  try {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed);
    var hex = bytes.map(function(b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    }).join('');
    return 'rl:' + action + ':' + hex.slice(0, 24);
  } catch (_) {
    return 'rl:' + action + ':fallback';
  }
}

function _checkRateLimit_(action, payload, maxPerMinute) {
  try {
    var cache = CacheService.getScriptCache();
    var key = _makeRateLimitKey_(action, payload || {});
    var count = parseInt(cache.get(key) || '0', 10);
    if (count >= maxPerMinute) return false;
    cache.put(key, String(count + 1), 60);
    return true;
  } catch (_) {
    return true;
  }
}

function handleEmitCertificate_(payload) {
  if (!_checkRateLimit_('emit', payload, CERT_CONFIG.RATE_LIMIT_EMIT)) {
    return { ok: false, error: 'Muitas tentativas. Aguarde um momento e tente novamente.', code: 'RATE_LIMITED' };
  }

  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    lock.waitLock(10000);
    locked = true;
    return handleEmitCertificate_Inner_(payload);
  } catch (lockErr) {
    if (!locked) {
      return { ok: false, error: 'OperaÃ§Ã£o em andamento. Aguarde alguns segundos e tente novamente.', code: 'LOCK_TIMEOUT' };
    }
    throw lockErr;
  } finally {
    if (locked) {
      try { lock.releaseLock(); } catch (_) {}
    }
  }
}

function handleEmitCertificate_Inner_(payload) {
  var normalized = normalizeCertificateRequest_(payload);
  var speakerProfile = resolveSpeakerProfile_(normalized);
  var specialProfile = speakerProfile ? null : findSpecialCertificateParticipant_(normalized);
  var effectiveDays = speakerProfile
    ? CERT_CONFIG.ALLOWED_DAYS.slice()
    : (specialProfile ? [CERT_CONFIG.SPECIAL_CERT_DAY] : normalized.days.slice());
  var presenceMatch = null;

  if (!speakerProfile && !specialProfile && !effectiveDays.length) {
    throw new Error('Selecione ao menos um dia.');
  }

  if (speakerProfile) {
    presenceMatch = buildSpeakerPresenceMatch_(normalized, speakerProfile, effectiveDays);
  } else if (specialProfile) {
    presenceMatch = buildSpecialPresenceMatch_(normalized, specialProfile, effectiveDays);
  } else {
    presenceMatch = findParticipantInPresenceBase_(normalized);
  }

  if (!presenceMatch || !presenceMatch.ok) {
    return {
      ok: false,
      error: 'Participante nÃ£o localizado na base de presenÃ§a. Verifique nome, e-mail e dias selecionados.',
      code: 'PARTICIPANT_NOT_FOUND',
      hint: 'Use exatamente o nome e e-mail cadastrados no evento.'
    };
  }

  var resolvedCpf = resolveCertificateCpf_(normalized, presenceMatch, speakerProfile);
  var resolvedEmail = speakerProfile
    ? (speakerProfile.emailNormalized || normalized.emailNormalized || '')
    : specialProfile
      ? (specialProfile.emailNormalized || normalized.emailNormalized || '')
    : (normalized.emailNormalized || presenceMatch.emailNormalized || '');
  var resolvedName = speakerProfile
    ? (speakerProfile.participantName || normalized.name)
    : specialProfile
      ? (specialProfile.participantName || normalized.name)
    : (presenceMatch.participantName || normalized.name);

  if (presenceMatch.ambiguous && !normalized.cpfNormalized) {
    return {
      ok: false,
      code: 'IDENTITY_CONFIRMATION_REQUIRED',
      requiresCpf: true,
      participantFound: true,
      error: 'Encontramos mais de um registro compatÃ­vel com os dados informados.',
      hint: 'Informe seu CPF para confirmar sua identidade e concluir a emissÃ£o.',
      participant: {
        participantName: resolvedName,
        dias: effectiveDays
      }
    };
  }

  var participantKeys = buildParticipantKeyCandidates_(resolvedCpf, resolvedEmail);
  if (!participantKeys.length) {
    return {
      ok: false,
      code: 'IDENTITY_CONFIRMATION_REQUIRED',
      requiresCpf: true,
      participantFound: true,
      error: 'NÃ£o foi possÃ­vel confirmar sua identidade apenas com os dados informados.',
      hint: 'Informe seu CPF para concluir a emissÃ£o.',
      participant: {
        participantName: resolvedName,
        dias: effectiveDays
      }
    };
  }

  var diasKey = buildDiasKey_(effectiveDays);
  var diasLabel = speakerProfile ? CERT_CONFIG.EVENT_DATE_LABEL : buildDiasLabel_(effectiveDays);
  var nowIso = new Date().toISOString();

  var existing = findExistingCertificateByCandidates_(participantKeys, diasKey);
  if (!existing && speakerProfile) {
    existing = findSpeakerCertificateByIdentity_(resolvedCpf, resolvedEmail);
  }
  if (!existing && specialProfile) {
    existing = findSpecialCertificateByIdentity_(resolvedCpf, resolvedEmail, specialProfile.certificateType);
  }

  var metaBase = buildCertificateMeta_(effectiveDays, speakerProfile, specialProfile, null, nowIso);

  if (existing) {
    var patch = {
      participant_name:      resolvedName,
      cpf_normalized:        resolvedCpf,
      email_normalized:      resolvedEmail,
      dias_label:            diasLabel,
      participant_source_id: presenceMatch.participantSourceId || '',
      meta_json:             JSON.stringify(buildCertificateMeta_(effectiveDays, speakerProfile, specialProfile, safeParseJson_(existing.record.meta_json, {}), nowIso))
    };

    updateCertificateReissue_(existing.rowIndex, existing.record, nowIso, patch);
    logCertificateAudit_('reissue', { validation_code: existing.record.validation_code });

    var updatedRecord = mergeRecordWithPatch_(existing.record, patch, nowIso);
    return {
      ok: true,
      mode: 'existing',
      message: 'Certificado localizado! Mesmo cÃ³digo reutilizado.',
      certificate: buildCertificateResponse_(updatedRecord)
    };
  }

  var participantKey = participantKeys[0];
  var certificateKey = buildCertificateKey_(participantKey, diasKey);
  var validationCode = generateValidationCode_(certificateKey);

  var row = {
    certificate_key:       certificateKey,
    validation_code:       validationCode,
    participant_key:       participantKey,
    participant_name:      resolvedName,
    cpf_normalized:        resolvedCpf,
    email_normalized:      resolvedEmail,
    dias_key:              diasKey,
    dias_label:            diasLabel,
    participant_source_id: presenceMatch.participantSourceId || '',
    issued_at_iso:         nowIso,
    last_reissued_at_iso:  nowIso,
    issue_count:           1,
    status:                CERT_CONFIG.STATUS_ACTIVE,
    pdf_url:               '',
    meta_json:             JSON.stringify(metaBase)
  };

  appendCertificateRow_(row);
  logCertificateAudit_('issue', { validation_code: row.validation_code });
  return {
    ok: true,
    mode: 'created',
    message: 'Certificado emitido com sucesso.',
    certificate: buildCertificateResponse_(row)
  };
}

function handleFindCertificate_(payload) {
  if (!_checkRateLimit_('buscar', payload, CERT_CONFIG.RATE_LIMIT_BUSCAR)) {
    return { ok: false, error: 'Muitas tentativas. Aguarde um momento.', code: 'RATE_LIMITED' };
  }

  var cpfNormalized = normalizeCpf_(payload.cpf || payload.document || '');
  var validationCode = normalizeValidationCode_(payload.validationCode || payload.validation_code || '');

  if (!cpfNormalized && !validationCode) {
    return {
      ok: false,
      error: 'Para buscar um certificado, informe o CPF ou o cÃ³digo de validaÃ§Ã£o.',
      code: 'INSUFFICIENT_LOOKUP_CREDENTIALS',
      hint: 'Informe o CPF usado no cadastro ou o cÃ³digo de validaÃ§Ã£o impresso no certificado.'
    };
  }

  if (validationCode) {
    if (!isValidationCodeFormat_(validationCode)) {
      return { ok: false, error: 'CÃ³digo de validaÃ§Ã£o invÃ¡lido.', code: 'INVALID_VALIDATION_CODE' };
    }
    var byCode = findCertificateByCode_(validationCode);
    if (!byCode) return { ok: false, error: 'Certificado nÃ£o encontrado.', code: 'CERTIFICATE_NOT_FOUND' };
    return { ok: true, certificate: buildCertificateResponse_(byCode.record) };
  }

  var normalized = normalizeLookupRequest_(payload);
  var speakerExisting = findSpeakerCertificateByIdentity_(cpfNormalized, normalized.emailNormalized);
  if (speakerExisting) {
    return { ok: true, certificate: buildCertificateResponse_(speakerExisting.record) };
  }

  var specialExisting = findSpecialCertificateByIdentity_(cpfNormalized, normalized.emailNormalized);
  if (specialExisting) {
    return { ok: true, certificate: buildCertificateResponse_(specialExisting.record) };
  }

  if (!normalized.days.length) {
    return { ok: false, error: 'Selecione ao menos um dia para localizar o certificado.', code: 'INVALID_DAYS' };
  }

  var diasKey = buildDiasKey_(normalized.days);
  var candidateKeys = buildParticipantKeyCandidates_(cpfNormalized, normalized.emailNormalized);
  var existing = findExistingCertificateByCandidates_(candidateKeys, diasKey);
  if (!existing) return { ok: false, error: 'Certificado nÃ£o encontrado.', code: 'CERTIFICATE_NOT_FOUND' };
  return { ok: true, certificate: buildCertificateResponse_(existing.record) };
}

function handleValidateCertificate_(payload) {
  if (!_checkRateLimit_('validate', payload, CERT_CONFIG.RATE_LIMIT_VALIDATE)) {
    return { ok: false, error: 'Muitas tentativas de validaÃ§Ã£o. Aguarde um momento.', code: 'RATE_LIMITED' };
  }

  var code = normalizeValidationCode_(payload.validationCode || payload.validation_code || '');
  if (!code) return { ok: false, error: 'CÃ³digo nÃ£o informado.', code: 'MISSING_VALIDATION_CODE' };
  if (!isValidationCodeFormat_(code)) {
    return { ok: false, valid: false, error: 'CÃ³digo invÃ¡lido.', code: 'INVALID_VALIDATION_CODE' };
  }

  var existing = findCertificateByCode_(code);
  if (!existing) return { ok: false, valid: false, error: 'CÃ³digo nÃ£o encontrado.', code: 'VALIDATION_CODE_NOT_FOUND' };

  if (existing.record.status !== CERT_CONFIG.STATUS_ACTIVE) {
    return { ok: true, valid: false, message: 'Certificado inativo ou revogado.' };
  }

  return {
    ok: true,
    valid: true,
    message: 'Certificado vÃ¡lido.',
    certificate: buildPublicValidationResponse_(existing.record)
  };
}

function handleManualReview_(payload) {
  if (!_checkRateLimit_('manual', payload, CERT_CONFIG.RATE_LIMIT_MANUAL)) {
    return { ok: false, error: 'Muitas solicitaÃ§Ãµes. Aguarde alguns minutos antes de tentar novamente.', code: 'RATE_LIMITED' };
  }

  var nome = String(payload.nome || '').trim();
  var email = String(payload.email || '').trim().toLowerCase();
  var cpf = normalizeCpf_(String(payload.cpf || ''));
  var dias = normalizeDays_(payload.dias || payload.days || []);
  var obsRaw = String(payload.observacao || payload.obs || '').trim().slice(0, 500);
  var obs = obsRaw.replace(/[\u0000-\u001F<>]/g, ' ').replace(/\s+/g, ' ').trim();

  if (nome.length < 3) return { ok: false, error: 'Nome invÃ¡lido.', code: 'INVALID_NAME' };
  if (!email || !email.includes('@')) return { ok: false, error: 'E-mail invÃ¡lido.', code: 'INVALID_EMAIL' };
  if (!cpf) return { ok: false, error: 'CPF invÃ¡lido (11 dÃ­gitos).', code: 'INVALID_CPF' };
  if (dias.length === 0) return { ok: false, error: 'Selecione ao menos um dia.', code: 'INVALID_DAYS' };

  var cpfHash = hashForAudit_(cpf);
  if (isManualReviewRateLimited_(cpfHash) || hasRecentManualReview_(cpfHash)) {
    return {
      ok: false,
      error: 'JÃ¡ existe uma solicitaÃ§Ã£o recente para este CPF. Aguarde o retorno por e-mail em atÃ© 2 dias Ãºteis.',
      code: 'DUPLICATE_REVIEW_REQUEST'
    };
  }

  var cpfFmt = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  var diasStr = dias.map(function(d) {
    return d === '10' ? '10/03/2026' : '11/03/2026';
  }).join(' e ');
  var nowIso = new Date().toISOString();

  var subject = '[AXIS Summit 2026] SolicitaÃ§Ã£o de certificado â€” ' + nome;
  var body =
    'SOLICITAÃ‡ÃƒO DE AVALIAÃ‡ÃƒO MANUAL DE CERTIFICADO\n' +
    '================================================\n\n' +
    'Nome:       ' + nome + '\n' +
    'E-mail:     ' + email + '\n' +
    'CPF:        ' + cpfFmt + '\n' +
    'Dias:       ' + diasStr + '\n' +
    'ObservaÃ§Ã£o: ' + (obs || '(nÃ£o informada)') + '\n\n' +
    '---\nEnviado em ' + nowIso + ' via formulÃ¡rio intrasite AXIS Summit 2026';

  var sent = false;
  try {
    MailApp.sendEmail({ to: CERT_CONFIG.MANUAL_REVIEW_EMAIL, subject: subject, body: body, replyTo: email });
    sent = true;
  } catch (_) {}

  if (!sent) {
    try {
      GmailApp.sendEmail(CERT_CONFIG.MANUAL_REVIEW_EMAIL, subject, body, { replyTo: email });
      sent = true;
    } catch (err2) {
      logCertificateAudit_('manual_review_mail_error', { nome: nome, email: email, error: err2.message });
      return { ok: false, error: 'Falha ao enviar. Contate diretamente ' + CERT_CONFIG.MANUAL_REVIEW_EMAIL, code: 'MAIL_ERROR' };
    }
  }

  markManualReviewRequest_(cpfHash);
  logCertificateAudit_('manual_review', {
    nome_hash: hashForAudit_(nome),
    email_hash: hashForAudit_(email),
    cpf_hash: cpfHash,
    dias: dias,
    ts: nowIso
  });
  return { ok: true, message: 'SolicitaÃ§Ã£o enviada. Retorno em atÃ© 2 dias Ãºteis no e-mail ' + email + '.' };
}

function hasRecentManualReview_(cpfHash) {
  try {
    var sheet = getSpreadsheet_().getSheetByName(CERT_CONFIG.SHEET_AUDITORIA);
    if (!sheet || sheet.getLastRow() < 2) return false;
    var cutoff = new Date(Date.now() - 86400000).toISOString();
    var lastRow = sheet.getLastRow();
    var startRow = Math.max(2, lastRow - 1500);
    var numRows = lastRow - startRow + 1;
    var data = sheet.getRange(startRow, 1, numRows, 3).getValues();
    return data.some(function(row) {
      var ts = String(row[0] || '');
      var t = String(row[1] || '');
      var d = safeParseJson_(row[2], {});
      return t === 'manual_review' && d.cpf_hash === cpfHash && ts >= cutoff;
    });
  } catch (_) {
    return false;
  }
}

function isManualReviewRateLimited_(cpfHash) {
  try {
    return CacheService.getScriptCache().get('mr:' + cpfHash) === '1';
  } catch (_) {
    return false;
  }
}

function markManualReviewRequest_(cpfHash) {
  try {
    CacheService.getScriptCache().put('mr:' + cpfHash, '1', 86400);
  } catch (_) {}
}

function handleHealthcheck_() {
  var ss = getSpreadsheet_();
  return {
    ok: true,
    message: 'API funcionando',
    timestamp: new Date().toISOString(),
    version: '2026-03-17.v13',
    sheets: ss.getSheets().map(function(s) { return s.getName(); })
  };
}

function handleManualParticipantUpsert_(payload) {
  if (!_checkRateLimit_('manual_admin', payload, 20)) {
    return { ok: false, error: 'Muitas tentativas. Aguarde um momento.', code: 'RATE_LIMITED' };
  }

  var lock = LockService.getScriptLock();
  var locked = false;

  try {
    lock.waitLock(10000);
    locked = true;

    var normalized = normalizeManualParticipantPayload_(payload);
    if (normalized.participantType === 'speaker') {
      return upsertManualSpeaker_(normalized);
    }
    return upsertManualPublicParticipant_(normalized);
  } catch (lockErr) {
    if (!locked) {
      return { ok: false, error: 'OperaÃ§Ã£o em andamento. Aguarde alguns segundos e tente novamente.', code: 'LOCK_TIMEOUT' };
    }
    throw lockErr;
  } finally {
    if (locked) {
      try { lock.releaseLock(); } catch (_) {}
    }
  }
}

function normalizeManualParticipantPayload_(payload) {
  var participantType = String(payload.participantType || payload.type || '').trim().toLowerCase();
  var nome = normalizeEditorialCase_(normalizeName_(payload.nome || payload.name || ''));
  var cpfNormalized = normalizeCpf_(payload.cpf || payload.document || '');
  var emailNormalized = normalizeEmail_(payload.email || '');
  var dias = normalizeDays_(payload.dias || payload.days || []);
  var atividade = normalizeEditorialCase_(normalizeName_(payload.atividade || payload.panelName || payload.activity || ''));
  var cargo = normalizeEditorialCase_(normalizeName_(payload.cargo || payload.jobTitle || payload.role || ''));

  if (participantType !== 'speaker' && participantType !== 'publico' && participantType !== 'public') {
    throw new Error('Tipo invÃ¡lido. Use "speaker" ou "publico".');
  }
  if (!nome || nome.length < 3) throw new Error('Nome invÃ¡lido.');
  if (!cpfNormalized) throw new Error('CPF invÃ¡lido (11 dÃ­gitos).');
  if (!emailNormalized || emailNormalized.indexOf('@') === -1) throw new Error('E-mail invÃ¡lido.');

  participantType = participantType === 'public' ? 'publico' : participantType;

  if (participantType === 'publico' && !dias.length) {
    throw new Error('Selecione ao menos um dia para pÃºblico geral.');
  }

  return {
    participantType: participantType,
    nome: nome,
    cpfNormalized: cpfNormalized,
    emailNormalized: emailNormalized,
    dias: dias,
    atividade: atividade,
    cargo: cargo
  };
}

function upsertManualSpeaker_(normalized) {
  var sheet = ensureSpeakersSheet_();
  var nowIso = new Date().toISOString();
  var rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues()
    : [];
  var targetRow = 0;
  var i;

  for (i = 0; i < rows.length; i++) {
    var rowName = _normalizarNome_(rows[i][0] || '');
    var rowEmail = normalizeEmail_(rows[i][1] || '');
    var rowCpf = normalizeCpf_(rows[i][2] || '');

    if ((rowCpf && rowCpf === normalized.cpfNormalized) ||
        (rowEmail && rowEmail === normalized.emailNormalized) ||
        (rowName && rowName === _normalizarNome_(normalized.nome))) {
      targetRow = i + 2;
      break;
    }
  }

  var rowValues = [[
    normalized.nome,
    normalized.emailNormalized,
    normalized.cpfNormalized,
    buildManualSpeakerOrigin_(normalized),
    'speaker',
    'TRUE',
    nowIso
  ]];

  if (targetRow) {
    sheet.getRange(targetRow, 1, 1, 7).setValues(rowValues);
  } else {
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, 7).setValues(rowValues);
    targetRow = sheet.getLastRow();
  }

  logCertificateAudit_('manual_admin_register', {
    participant_type: 'speaker',
    cpf_hash: hashForAudit_(normalized.cpfNormalized),
    email_hash: hashForAudit_(normalized.emailNormalized),
    source_sheet: sheet.getName(),
    target_row: targetRow,
    atividade: normalized.atividade || '',
    cargo: normalized.cargo || ''
  });

  return {
    ok: true,
    message: 'Speaker salvo com sucesso.',
    participantType: 'speaker',
    savedTo: [sheet.getName()],
    participant: {
      nome: normalized.nome,
      cpfNormalized: normalized.cpfNormalized,
      emailNormalized: normalized.emailNormalized,
      atividade: normalized.atividade || '',
      cargo: normalized.cargo || '',
      participantSourceId: sheet.getName() + '_row' + targetRow
    }
  };
}

function upsertManualPublicParticipant_(normalized) {
  var publicSheet = ensurePublicSheet_();
  var posteriorSheet = ensurePosteriorSheet_();
  var savedPosteriorRows = [];

  upsertManualPublicBase_(publicSheet, normalized);
  normalized.dias.forEach(function(day) {
    savedPosteriorRows.push(upsertManualPosteriorByDay_(posteriorSheet, normalized, day));
  });

  logCertificateAudit_('manual_admin_register', {
    participant_type: 'publico',
    cpf_hash: hashForAudit_(normalized.cpfNormalized),
    email_hash: hashForAudit_(normalized.emailNormalized),
    dias: normalized.dias,
    public_sheet: publicSheet.getName(),
    posterior_rows: savedPosteriorRows
  });

  return {
    ok: true,
    message: 'Participante salvo com sucesso.',
    participantType: 'publico',
    savedTo: [publicSheet.getName(), posteriorSheet.getName()],
    participant: {
      nome: normalized.nome,
      cpfNormalized: normalized.cpfNormalized,
      emailNormalized: normalized.emailNormalized,
      dias: normalized.dias,
      participantSourceIds: savedPosteriorRows.map(function(rowNumber) {
        return posteriorSheet.getName() + '_row' + rowNumber;
      })
    }
  };
}

function upsertManualPublicBase_(sheet, normalized) {
  var rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues()
    : [];
  var targetRow = 0;
  var nowIso = new Date().toISOString();
  var i;

  for (i = 0; i < rows.length; i++) {
    var rowEmail = normalizeEmail_(rows[i][1] || '');
    var rowName = _normalizarNome_(rows[i][0] || '');
    if ((rowEmail && rowEmail === normalized.emailNormalized) ||
        (rowName && rowName === _normalizarNome_(normalized.nome))) {
      targetRow = i + 2;
      break;
    }
  }

  var values = [[
    normalized.nome,
    normalized.emailNormalized,
    '',
    'publico',
    'cert_admin_manual',
    nowIso
  ]];

  if (targetRow) {
    sheet.getRange(targetRow, 1, 1, 6).setValues(values);
    return targetRow;
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, 1, 6).setValues(values);
  return sheet.getLastRow();
}

function upsertManualPosteriorByDay_(sheet, normalized, day) {
  var rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues()
    : [];
  var targetRow = 0;
  var targetDate = buildManualPosteriorDate_(day);
  var targetKey = buildManualPosteriorDayKey_(targetDate);
  var i;

  for (i = 0; i < rows.length; i++) {
    var rowDateKey = buildManualPosteriorDayKey_(rows[i][0]);
    var rowCpf = normalizeCpf_(rows[i][2] || '');
    var rowEmail = normalizeEmail_(rows[i][3] || '');

    if (rowDateKey !== targetKey) continue;
    if ((rowCpf && rowCpf === normalized.cpfNormalized) ||
        (rowEmail && rowEmail === normalized.emailNormalized)) {
      targetRow = i + 2;
      break;
    }
  }

  var values = [[
    targetDate,
    normalized.nome,
    normalized.cpfNormalized,
    normalized.emailNormalized,
    '',
    'Painel Certificados',
    CERT_CONFIG.MANUAL_REVIEW_EMAIL,
    'cert_admin_manual_day_' + day
  ]];

  if (targetRow) {
    sheet.getRange(targetRow, 1, 1, 8).setValues(values);
    return targetRow;
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, 1, 8).setValues(values);
  return sheet.getLastRow();
}

function buildManualSpeakerOrigin_(normalized) {
  return [
    'palestrante',
    CERT_CONFIG.EVENT_DATE_LABEL,
    CERT_CONFIG.EVENT_HOURS_LABEL,
    CERT_CONFIG.EVENT_LOCAL,
    normalized.atividade || '',
    normalized.cargo || ''
  ].join('|');
}

function buildManualPosteriorDate_(day) {
  var d = parseInt(day, 10);
  return new Date(Date.UTC(2026, 2, d, 12, 0, 0));
}

function buildManualPosteriorDayKey_(value) {
  if (value instanceof Date) {
    return value.getUTCFullYear() + '-' + (value.getUTCMonth() + 1) + '-' + value.getUTCDate();
  }

  var parsed = new Date(value);
  if (!isNaN(parsed.getTime())) {
    return parsed.getUTCFullYear() + '-' + (parsed.getUTCMonth() + 1) + '-' + parsed.getUTCDate();
  }

  return String(value || '');
}

function normalizeCertificateRequest_(payload) {
  var name = normalizeName_(payload.name || payload.nome || '');
  var cpfNormalized = normalizeCpf_(payload.cpf || payload.document || '');
  var emailNormalized = normalizeEmail_(payload.email || '');
  var days = normalizeDays_(payload.days || payload.dias || []);

  if (!name) throw new Error('Nome nÃ£o informado.');
  if (!cpfNormalized && !emailNormalized) throw new Error('Informe CPF ou e-mail.');

  return {
    name: name,
    cpfNormalized: cpfNormalized,
    emailNormalized: emailNormalized,
    days: days
  };
}

function normalizeLookupRequest_(payload) {
  var name = normalizeName_(payload.name || payload.nome || '');
  var cpfNormalized = normalizeCpf_(payload.cpf || payload.document || '');
  var emailNormalized = normalizeEmail_(payload.email || '');
  var days = normalizeDays_(payload.days || payload.dias || []);

  if (!cpfNormalized && !emailNormalized) throw new Error('Informe CPF ou e-mail para busca.');

  return {
    name: name,
    cpfNormalized: cpfNormalized,
    emailNormalized: emailNormalized,
    days: days
  };
}

function normalizeCpf_(value) {
  var raw = value;
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'number') {
    raw = Math.round(raw).toString();
  } else {
    raw = String(raw).trim();
    if (/e[\+\-]?\d+/i.test(raw)) {
      var num = Number(raw);
      if (!isNaN(num) && isFinite(num)) raw = Math.round(num).toString();
    }
  }

  var digits = String(raw || '').replace(/\D+/g, '');
  if (digits.length !== 11) return '';
  if (/^(\d)\1+$/.test(digits)) return '';

  var sum1 = 0;
  var i;
  for (i = 0; i < 9; i++) sum1 += parseInt(digits[i], 10) * (10 - i);
  var r1 = (sum1 * 10) % 11;
  if (r1 === 10 || r1 === 11) r1 = 0;
  if (r1 !== parseInt(digits[9], 10)) return '';

  var sum2 = 0;
  for (i = 0; i < 10; i++) sum2 += parseInt(digits[i], 10) * (11 - i);
  var r2 = (sum2 * 10) % 11;
  if (r2 === 10 || r2 === 11) r2 = 0;
  if (r2 !== parseInt(digits[10], 10)) return '';

  return digits;
}

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeName_(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function editorialWordKey_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[Ã¡Ã Ã£Ã¢Ã¤]/g, 'a')
    .replace(/[Ã©Ã¨ÃªÃ«]/g, 'e')
    .replace(/[Ã­Ã¬Ã®Ã¯]/g, 'i')
    .replace(/[Ã³Ã²ÃµÃ´Ã¶]/g, 'o')
    .replace(/[ÃºÃ¹Ã»Ã¼]/g, 'u')
    .replace(/Ã§/g, 'c')
    .replace(/[^a-z0-9]/g, '');
}

function normalizeEditorialWord_(word, isSegmentStart) {
  var original = String(word || '');
  if (!original) return '';
  if (/^\d+$/.test(original)) return original;

  var key = editorialWordKey_(original);
  if (!key) return original;
  if (EDITORIAL_SPECIAL_WORDS[key]) return EDITORIAL_SPECIAL_WORDS[key];
  if (!isSegmentStart && EDITORIAL_LOWERCASE_WORDS[key]) return key;

  var lower = original.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function normalizeEditorialCase_(value) {
  var text = normalizeName_(value || '');
  if (!text) return '';

  var parts = text.split(/(\s+|\|+|\/+|[-â€“â€”]+|Â·|\(|\)|:|,|;)/);
  var out = [];
  var isSegmentStart = true;
  var i;

  for (i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (!part) continue;

    if (/^\s+$/.test(part)) {
      out.push(part);
      continue;
    }

    if (/^(\|+|\/+|[-â€“â€”]+|Â·|\(|\)|:|,|;)$/.test(part)) {
      out.push(part);
      isSegmentStart = true;
      continue;
    }

    out.push(normalizeEditorialWord_(part, isSegmentStart));
    isSegmentStart = false;
  }

  return out.join('');
}

function normalizeDays_(daysInput) {
  var arr = Array.isArray(daysInput) ? daysInput : [daysInput];
  var normalized = [];

  arr.forEach(function(day) {
    var v = String(day || '').trim();
    if (!v) return;

    if (CERT_CONFIG.ALLOWED_DAYS.indexOf(v) !== -1) {
      if (normalized.indexOf(v) === -1) normalized.push(v);
      return;
    }

    var m1 = v.match(/2026-03-(\d{1,2})/);
    if (m1) {
      var d1 = String(parseInt(m1[1], 10));
      if (CERT_CONFIG.ALLOWED_DAYS.indexOf(d1) !== -1 && normalized.indexOf(d1) === -1) normalized.push(d1);
      return;
    }

    var m2 = v.match(/^(\d{1,2})\/03\/2026/);
    if (m2) {
      var d2 = String(parseInt(m2[1], 10));
      if (CERT_CONFIG.ALLOWED_DAYS.indexOf(d2) !== -1 && normalized.indexOf(d2) === -1) normalized.push(d2);
      return;
    }

    var n = parseInt(v, 10);
    if (!isNaN(n)) {
      var dn = String(n);
      if (CERT_CONFIG.ALLOWED_DAYS.indexOf(dn) !== -1 && normalized.indexOf(dn) === -1) normalized.push(dn);
    }
  });

  normalized.sort();
  return normalized;
}

function resolveCertificateCpf_(normalized, presenceMatch, speakerProfile) {
  if (normalized && normalized.cpfNormalized) return normalized.cpfNormalized;
  if (speakerProfile && speakerProfile.cpfNormalized) return speakerProfile.cpfNormalized;
  if (presenceMatch && presenceMatch.cpfNormalized) return presenceMatch.cpfNormalized;
  return '';
}

function resolveSpeakerProfile_(context) {
  try {
    var ss = getSpreadsheet_();
    var normalizedName = _normalizarNome_(context && context.name);
    var normalizedCpf = normalizeCpf_(context && context.cpfNormalized);
    var normalizedEmail = normalizeEmail_(context && context.emailNormalized);

    var speakerSheet = ss.getSheetByName(CERT_CONFIG.SHEET_SPEAKERS);
    if (speakerSheet) {
      var fromSpeakers = findSpeakerInSheet_(speakerSheet, normalizedName, normalizedCpf, normalizedEmail);
      if (fromSpeakers) return fromSpeakers;
    }

    var logsSheet = ss.getSheetByName(CERT_CONFIG.SHEET_LOGS_SPEAKERS);
    if (logsSheet) {
      var fromLogs = findSpeakerInLogsSheet_(logsSheet, normalizedName, normalizedCpf, normalizedEmail);
      if (fromLogs) return fromLogs;
    }
  } catch (err) {
    Logger.log('[CERT] Speaker lookup falhou: ' + err.message);
  }

  return null;
}

function findSpeakerInSheet_(sheet, normalizedName, normalizedCpf, normalizedEmail) {
  var rows = sheet.getDataRange().getValues();
  if (!rows || rows.length < 2) return null;

  var i;
  for (i = 1; i < rows.length; i++) {
    var row = rows[i];
    var rowName = _normalizarNome_(row[SPEAKERS_COLS.nome] || '');
    var rowEmail = normalizeEmail_(row[SPEAKERS_COLS.email] || '');
    var rowCpf = normalizeCpf_(row[SPEAKERS_COLS.cpf] || '');
    var credencial = String(row[SPEAKERS_COLS.credencial] || '').trim().toLowerCase();
    var ativo = String(row[SPEAKERS_COLS.ativo] || '').trim().toLowerCase();

    if (!rowName) continue;
    if (ativo && ativo !== '1' && ativo !== 'true' && ativo !== 'ativo') continue;
    if (!isSpeakerCredential_(credencial)) continue;

    var matched = false;
    if (normalizedCpf && rowCpf && normalizedCpf === rowCpf) {
      matched = true;
    } else if (normalizedEmail && rowEmail && normalizedEmail === rowEmail) {
      matched = true;
    } else if (normalizedName && rowName === normalizedName) {
      matched = true;
    }

    if (!matched) continue;

    var origin = parseSpeakerOrigin_(row[SPEAKERS_COLS.origem] || '');
    var canonicalName = normalizeEditorialCase_(normalizeName_(row[SPEAKERS_COLS.nome] || ''));
    var safeRoleLabel = normalizeSpeakerRoleLabel_(origin.role);
    var jobTitle = normalizeEditorialCase_(normalizeName_(origin.jobTitle || ''));
    var panelName = normalizeEditorialCase_(normalizeName_(origin.panelName || ''));

    return {
      isSpeaker: true,
      participantName: canonicalName || normalizeEditorialCase_(normalizeName_(normalizedName || '')),
      emailNormalized: rowEmail || normalizedEmail || '',
      cpfNormalized: rowCpf || normalizedCpf || '',
      roleRaw: origin.role || '',
      roleLabel: safeRoleLabel,
      participantRole: composeSpeakerRole_(safeRoleLabel, jobTitle),
      panelName: panelName,
      jobTitle: jobTitle,
      sourceSheet: sheet.getName(),
      participantSourceId: sheet.getName() + '_row' + (i + 1),
      eventDate: origin.eventDate || '',
      eventTime: origin.eventTime || '',
      eventLocation: origin.eventLocation || ''
    };
  }

  return null;
}

function findSpeakerInLogsSheet_(sheet, normalizedName, normalizedCpf, normalizedEmail) {
  var rows = sheet.getDataRange().getValues();
  if (!rows || rows.length < 2) return null;

  var i;
  for (i = rows.length - 1; i >= 1; i--) {
    var row = rows[i];
    var rowName = _normalizarNome_(row[LOGS_SPEAKERS_COLS.nome] || '');
    if (!rowName) continue;

    var rowCpf = normalizeCpf_(row[4] || '');
    var rowEmail = normalizeEmail_(row[3] || '');

    var matched = false;
    if (normalizedCpf && rowCpf && normalizedCpf === rowCpf) {
      matched = true;
    } else if (normalizedEmail && rowEmail && normalizedEmail === rowEmail) {
      matched = true;
    } else if (normalizedName && rowName === normalizedName) {
      matched = true;
    }

    if (!matched) continue;

    return {
      isSpeaker: true,
      participantName: normalizeEditorialCase_(normalizeName_(row[LOGS_SPEAKERS_COLS.nome] || '')),
      emailNormalized: rowEmail || normalizedEmail || '',
      cpfNormalized: rowCpf || normalizedCpf || '',
      roleRaw: 'participante',
      roleLabel: 'Palestrante',
      participantRole: 'Palestrante',
      panelName: '',
      jobTitle: '',
      sourceSheet: sheet.getName(),
      participantSourceId: sheet.getName() + '_row' + (i + 1),
      eventDate: '',
      eventTime: '',
      eventLocation: ''
    };
  }

  return null;
}

function isSpeakerCredential_(value) {
  var raw = String(value || '').trim().toLowerCase();
  if (!raw) return false;
  return raw.indexOf('speaker') !== -1 ||
         raw.indexOf('palestr') !== -1 ||
         raw.indexOf('mediador') !== -1 ||
         raw.indexOf('debatedor') !== -1;
}

function parseSpeakerOrigin_(originRaw) {
  var origin = String(originRaw || '').trim();
  if (!origin) {
    return {
      role: 'participante',
      eventDate: '',
      eventTime: '',
      eventLocation: '',
      panelName: '',
      jobTitle: ''
    };
  }

  var parts = origin.split('|').map(function(part) {
    return String(part || '').trim();
  }).filter(function(part) {
    return !!part;
  });

  var role = parts[0] || 'participante';
  var eventDate = parts.length > 1 ? parts[1] : '';
  var eventTime = parts.length > 2 ? parts[2] : '';
  var eventLocation = parts.length > 3 ? parts[3] : '';
  var panelName = '';
  var jobTitle = '';

  if (parts.length >= 6) {
    panelName = parts.slice(4, parts.length - 1).join(' | ');
    jobTitle = parts[parts.length - 1] || '';
  } else if (parts.length === 5) {
    panelName = parts[4] || '';
  } else if (parts.length > 1) {
    panelName = parts[parts.length - 1] || '';
  }

  return {
    role: role,
    eventDate: eventDate,
    eventTime: eventTime,
    eventLocation: eventLocation,
    panelName: panelName,
    jobTitle: jobTitle
  };
}

function normalizeSpeakerRoleLabel_(value) {
  var raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'participante') return 'Palestrante';
  if (raw === 'mediador' || raw === 'mediadora') return 'Mediador(a)';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function composeSpeakerRole_(roleLabel, jobTitle) {
  var base = normalizeSpeakerRoleLabel_(roleLabel);
  var cargo = normalizeEditorialCase_(normalizeName_(jobTitle || ''));
  return cargo ? base + ' Â· ' + cargo : base;
}

function buildSpeakerMeta_(speakerProfile) {
  if (!speakerProfile || !speakerProfile.isSpeaker) return null;
  return {
    isSpeaker: true,
    participantName: speakerProfile.participantName || '',
    role: speakerProfile.participantRole || speakerProfile.roleLabel || 'Palestrante',
    roleLabel: speakerProfile.roleLabel || 'Palestrante',
    panelName: speakerProfile.panelName || '',
    jobTitle: speakerProfile.jobTitle || '',
    sourceSheet: speakerProfile.sourceSheet || '',
    participantSourceId: speakerProfile.participantSourceId || '',
    eventDate: speakerProfile.eventDate || '',
    eventTime: speakerProfile.eventTime || '',
    eventLocation: speakerProfile.eventLocation || ''
  };
}

function getSpecialCertificateTypeLabel_(certificateType) {
  if (certificateType === 'rodada_negocios') return 'Rodada de NegÃ³cios';
  if (certificateType === 'atelie') return 'AteliÃª';
  return 'Certificado Especial';
}

function inferSpecialCertificateTypeFromRow_(rowNumber) {
  if (rowNumber >= 1 && rowNumber <= 15) return 'rodada_negocios';
  if (rowNumber >= 17) return 'atelie';
  return '';
}

function normalizeSpecialProjectName_(value) {
  var text = normalizeName_(value || '');
  if (!text) return '';
  return sanitizeTextField_(normalizeEditorialCase_(text), 180);
}

function buildSpecialMeta_(specialProfile) {
  if (!specialProfile || !specialProfile.isSpecial) return null;
  return {
    isSpecial: true,
    certificateType: specialProfile.certificateType || '',
    specialLabel: specialProfile.specialLabel || getSpecialCertificateTypeLabel_(specialProfile.certificateType),
    activityLabel: specialProfile.activityLabel || getSpecialCertificateTypeLabel_(specialProfile.certificateType),
    participantName: specialProfile.participantName || '',
    projectName: normalizeSpecialProjectName_(specialProfile.projectName || ''),
    sourceSheet: specialProfile.sourceSheet || '',
    participantSourceId: specialProfile.participantSourceId || ''
  };
}

function buildCertificateMeta_(rawDays, speakerProfile, specialProfile, existingMeta, lastReissueAt) {
  var meta = existingMeta || {};
  meta.event_name = CERT_CONFIG.EVENT_NAME;
  meta.event_year = CERT_CONFIG.EVENT_YEAR;
  meta.raw_days = normalizeDays_(rawDays || []);
  if (speakerProfile && speakerProfile.isSpeaker) {
    meta.speaker = buildSpeakerMeta_(speakerProfile);
  } else if (meta.speaker) {
    delete meta.speaker;
  }
  if (specialProfile && specialProfile.isSpecial) {
    meta.special = buildSpecialMeta_(specialProfile);
  } else if (meta.special) {
    delete meta.special;
  }
  if (lastReissueAt) meta.last_reissue_at = lastReissueAt;
  return meta;
}

function buildSpeakerPresenceMatch_(normalized, speakerProfile, effectiveDays) {
  return {
    ok: true,
    participantName: speakerProfile.participantName || normalized.name,
    participantSourceId: speakerProfile.participantSourceId || '',
    sourceSheet: speakerProfile.sourceSheet || CERT_CONFIG.SHEET_SPEAKERS,
    matchType: 'speaker_profile',
    score: 999,
    cpfNormalized: speakerProfile.cpfNormalized || normalized.cpfNormalized || '',
    emailNormalized: speakerProfile.emailNormalized || normalized.emailNormalized || '',
    effectiveDays: normalizeDays_(effectiveDays || [])
  };
}

function buildSpecialPresenceMatch_(normalized, specialProfile, effectiveDays) {
  return {
    ok: true,
    isSpecial: true,
    certificateType: specialProfile.certificateType || '',
    specialLabel: specialProfile.specialLabel || getSpecialCertificateTypeLabel_(specialProfile.certificateType),
    activityLabel: specialProfile.activityLabel || getSpecialCertificateTypeLabel_(specialProfile.certificateType),
    projectName: specialProfile.projectName || '',
    participantName: specialProfile.participantName || normalized.name,
    participantSourceId: specialProfile.participantSourceId || '',
    sourceSheet: specialProfile.sourceSheet || CERT_CONFIG.SHEET_SPECIAL_CERTS,
    matchType: 'special_profile',
    score: specialProfile.score || 999,
    cpfNormalized: specialProfile.cpfNormalized || normalized.cpfNormalized || '',
    emailNormalized: specialProfile.emailNormalized || normalized.emailNormalized || '',
    effectiveDays: normalizeDays_(effectiveDays || [CERT_CONFIG.SPECIAL_CERT_DAY])
  };
}

function resolveSpeakerProfileFromRecord_(record) {
  if (!record) return null;

  var meta = safeParseJson_(record.meta_json, {});
  var metaSpeaker = meta && meta.speaker && meta.speaker.isSpeaker ? meta.speaker : null;
  var lookup = resolveSpeakerProfile_({
    name: record.participant_name || '',
    cpfNormalized: record.cpf_normalized || '',
    emailNormalized: record.email_normalized || ''
  });

  if (lookup) return lookup;

  if (metaSpeaker) {
    var roleLabel = normalizeSpeakerRoleLabel_(metaSpeaker.roleLabel || metaSpeaker.role || '');
    var jobTitle = normalizeEditorialCase_(normalizeName_(metaSpeaker.jobTitle || ''));
    return {
      isSpeaker: true,
      participantName: normalizeEditorialCase_(normalizeName_(metaSpeaker.participantName || record.participant_name || '')),
      emailNormalized: normalizeEmail_(record.email_normalized || ''),
      cpfNormalized: normalizeCpf_(record.cpf_normalized || ''),
      roleRaw: metaSpeaker.role || '',
      roleLabel: roleLabel,
      participantRole: composeSpeakerRole_(roleLabel, jobTitle),
      panelName: normalizeEditorialCase_(normalizeName_(metaSpeaker.panelName || '')),
      jobTitle: jobTitle,
      sourceSheet: metaSpeaker.sourceSheet || '',
      participantSourceId: metaSpeaker.participantSourceId || String(record.participant_source_id || ''),
      eventDate: metaSpeaker.eventDate || '',
      eventTime: metaSpeaker.eventTime || '',
      eventLocation: metaSpeaker.eventLocation || ''
    };
  }

  return null;
}

function findSpecialCertificateParticipant_(normalized) {
  try {
    var sheet = getSpreadsheet_().getSheetByName(CERT_CONFIG.SHEET_SPECIAL_CERTS);
    if (!sheet) return null;

    var lastRow = sheet.getLastRow();
    var lastCol = Math.max(7, sheet.getLastColumn());
    if (lastRow < 1 || lastCol < 7) return null;

    var data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    var bestMatch = null;
    var bestScore = 0;
    var bestMatchCount = 0;
    var bestKeys = {};
    var i;

    for (i = 0; i < data.length; i++) {
      var rowNumber = i + 1;
      var certificateType = inferSpecialCertificateTypeFromRow_(rowNumber);
      if (!certificateType) continue;

      var row = data[i];
      var rowNameRaw = normalizeName_(row[0] || '');
      var projectRaw = normalizeName_(row[1] || '');
      var rowEmail = normalizeEmail_(row[3] || '');
      var rowCpf = normalizeCpf_(row[6] || '');
      var score = 0;
      var identityKey = '';

      if (!rowNameRaw && !rowEmail && !rowCpf) continue;
      if (normalized.cpfNormalized && rowCpf && rowCpf === normalized.cpfNormalized) score += 10;
      if (normalized.emailNormalized && rowEmail && rowEmail === normalized.emailNormalized) score += 8;
      if (score === 0) continue;

      if (normalized.name && rowNameRaw) {
        var reqLow = normalized.name.toLowerCase();
        var rowLow = rowNameRaw.toLowerCase();
        if (reqLow === rowLow) score += 4;
        else if (reqLow.split(' ')[0] && rowLow.indexOf(reqLow.split(' ')[0]) !== -1) score += 1;
      }

      identityKey = rowEmail
        ? 'email:' + rowEmail
        : (rowCpf ? 'cpf:' + rowCpf : sheet.getName() + '_row' + rowNumber);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          ok: true,
          isSpecial: true,
          certificateType: certificateType,
          specialLabel: getSpecialCertificateTypeLabel_(certificateType),
          activityLabel: getSpecialCertificateTypeLabel_(certificateType),
          projectName: certificateType === 'rodada_negocios' ? normalizeSpecialProjectName_(projectRaw) : '',
          participantName: normalizeEditorialCase_(rowNameRaw || normalized.name || ''),
          participantSourceId: sheet.getName() + '_row' + rowNumber,
          sourceSheet: sheet.getName(),
          score: score,
          cpfNormalized: rowCpf || '',
          emailNormalized: rowEmail || normalized.emailNormalized || '',
          matchIdentityKey: identityKey,
          effectiveDays: [CERT_CONFIG.SPECIAL_CERT_DAY]
        };
        bestMatchCount = 1;
        bestKeys = {};
        bestKeys[identityKey] = true;
      } else if (score === bestScore && score >= 8 && !bestKeys[identityKey]) {
        bestMatchCount += 1;
        bestKeys[identityKey] = true;
      }
    }

    if (bestScore >= 8 && bestMatch) {
      if (bestMatchCount > 1 && !normalized.cpfNormalized) {
        bestMatch.ambiguous = true;
        bestMatch.ambiguousCount = bestMatchCount;
      }
      return bestMatch;
    }
  } catch (err) {
    Logger.log('[CERT] Special lookup falhou: ' + err.message);
  }

  return null;
}

function resolveSpecialProfileFromRecord_(record) {
  if (!record) return null;

  var meta = safeParseJson_(record.meta_json, {});
  var metaSpecial = meta && meta.special && meta.special.isSpecial ? meta.special : null;

  if (metaSpecial) {
    var certificateType = String(metaSpecial.certificateType || '').trim();
    return {
      ok: true,
      isSpecial: true,
      certificateType: certificateType,
      specialLabel: metaSpecial.specialLabel || getSpecialCertificateTypeLabel_(certificateType),
      activityLabel: metaSpecial.activityLabel || metaSpecial.specialLabel || getSpecialCertificateTypeLabel_(certificateType),
      projectName: normalizeSpecialProjectName_(metaSpecial.projectName || ''),
      participantName: sanitizeTextField_(metaSpecial.participantName || record.participant_name || '', 140),
      emailNormalized: normalizeEmail_(record.email_normalized || ''),
      cpfNormalized: normalizeCpf_(record.cpf_normalized || ''),
      sourceSheet: metaSpecial.sourceSheet || '',
      participantSourceId: metaSpecial.participantSourceId || String(record.participant_source_id || ''),
      effectiveDays: [CERT_CONFIG.SPECIAL_CERT_DAY]
    };
  }

  return null;
}

function buildParticipantKeyCandidates_(resolvedCpf, resolvedEmail) {
  var keys = [];
  if (resolvedCpf) keys.push('cpf:' + resolvedCpf);
  if (resolvedEmail) keys.push('email:' + resolvedEmail);
  return uniqueNonEmptyStrings_(keys);
}

function buildDiasKey_(days) {
  return normalizeDays_(days).join('-');
}

function buildDiasLabel_(days) {
  var n = normalizeDays_(days);
  if (!n.length) return CERT_CONFIG.EVENT_DATE_LABEL;
  if (n.length === 2 && n[0] === '10' && n[1] === '11') return '10 e 11 de marÃ§o de 2026';
  if (n[0] === '10') return '10 de marÃ§o de 2026';
  if (n[0] === '11') return '11 de marÃ§o de 2026';
  return CERT_CONFIG.EVENT_DATE_LABEL;
}

function buildCertificateKey_(participantKey, diasKey) {
  return ['AXIS2026', participantKey, diasKey].join('|');
}

function generateValidationCode_(certificateKey) {
  var raw = certificateKey + '|' + getCertSalt_();
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw);
  var hex = bytesToHex_(digest).toUpperCase();
  return 'AXIS-' + hex.slice(0, 7) + '-' + hex.slice(7, 10);
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(CERT_CONFIG.SPREADSHEET_ID);
}

function ensureSheetWithHeaders_(sheetName, headers) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  var firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (!String(firstRow[0] || '').trim()) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensurePosteriorSheet_() {
  return ensureSheetWithHeaders_(CERT_CONFIG.SHEET_POSTERIOR, [
    'timestamp', 'nome', 'cpf', 'email', 'telefone', 'monitor_nome', 'monitor_email', 'origem'
  ]);
}

function ensureSpeakersSheet_() {
  return ensureSheetWithHeaders_(CERT_CONFIG.SHEET_SPEAKERS, [
    'nome', 'email', 'cpf', 'origem', 'credencial', 'ativo', 'updated_at'
  ]);
}

function ensurePublicSheet_() {
  var ss = getSpreadsheet_();
  var preferred = ss.getSheetByName(CERT_CONFIG.SHEET_PUBLICO) || ss.getSheetByName(CERT_CONFIG.SHEET_PUBLICO_ALT);
  if (preferred) {
    return ensureSheetWithHeaders_(preferred.getName(), [
      'nome', 'email', 'telefone', 'categoria', 'origem', 'updated_at'
    ]);
  }
  return ensureSheetWithHeaders_(CERT_CONFIG.SHEET_PUBLICO, [
    'nome', 'email', 'telefone', 'categoria', 'origem', 'updated_at'
  ]);
}

function ensureCertificatesSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(CERT_CONFIG.SHEET_CERTIFICADOS);
  if (!sheet) {
    sheet = ss.insertSheet(CERT_CONFIG.SHEET_CERTIFICADOS);
    sheet.getRange(1, 1, 1, CERT_HEADERS.length).setValues([CERT_HEADERS]);
    sheet.setFrozenRows(1);
  } else {
    var h = sheet.getRange(1, 1, 1, CERT_HEADERS.length).getValues()[0];
    if (!h[0]) {
      sheet.getRange(1, 1, 1, CERT_HEADERS.length).setValues([CERT_HEADERS]);
      sheet.setFrozenRows(1);
    }
  }
}

function getCertificatesSheet_() {
  ensureCertificatesSheet_();
  return getSpreadsheet_().getSheetByName(CERT_CONFIG.SHEET_CERTIFICADOS);
}

function appendCertificateRow_(rowObj) {
  var sheet = getCertificatesSheet_();
  sheet.appendRow(CERT_HEADERS.map(function(h) {
    return rowObj[h] != null ? rowObj[h] : '';
  }));
}

function readAllCertificates_() {
  var sheet = getCertificatesSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  return sheet.getRange(2, 1, lastRow - 1, CERT_HEADERS.length).getValues().map(function(row, idx) {
    var obj = {};
    CERT_HEADERS.forEach(function(h, i) { obj[h] = row[i]; });
    obj.__rowIndex = idx + 2;
    return obj;
  });
}

function findCertificateByKey_(key) {
  var all = readAllCertificates_();
  var i;
  for (i = 0; i < all.length; i++) {
    if (String(all[i].certificate_key) === String(key)) {
      return { rowIndex: all[i].__rowIndex, record: all[i] };
    }
  }
  return null;
}

function findCertificateByCode_(code) {
  var all = readAllCertificates_();
  var i;
  for (i = 0; i < all.length; i++) {
    if (String(all[i].validation_code).toUpperCase() === String(code).toUpperCase()) {
      return { rowIndex: all[i].__rowIndex, record: all[i] };
    }
  }
  return null;
}

function findExistingCertificateByCandidates_(participantKeys, diasKey) {
  if (!participantKeys || !participantKeys.length) return null;
  var i;
  for (i = 0; i < participantKeys.length; i++) {
    var found = findCertificateByKey_(buildCertificateKey_(participantKeys[i], diasKey));
    if (found) return found;
  }
  return null;
}

function findSpeakerCertificateByIdentity_(resolvedCpf, resolvedEmail) {
  var all = readAllCertificates_();
  var i;
  for (i = all.length - 1; i >= 0; i--) {
    var record = all[i];
    var rowCpf = normalizeCpf_(record.cpf_normalized || '');
    var rowEmail = normalizeEmail_(record.email_normalized || '');
    var idMatch = false;

    if (resolvedCpf && rowCpf && resolvedCpf === rowCpf) {
      idMatch = true;
    } else if (!resolvedCpf && resolvedEmail && rowEmail && resolvedEmail === rowEmail) {
      idMatch = true;
    } else if (resolvedCpf && resolvedEmail && rowEmail && resolvedEmail === rowEmail) {
      idMatch = true;
    }

    if (!idMatch) continue;
    if (resolveSpeakerProfileFromRecord_(record)) {
      return { rowIndex: record.__rowIndex, record: record };
    }
  }
  return null;
}

function findSpecialCertificateByIdentity_(resolvedCpf, resolvedEmail, expectedType) {
  var all = readAllCertificates_();
  var i;
  for (i = all.length - 1; i >= 0; i--) {
    var record = all[i];
    var rowCpf = normalizeCpf_(record.cpf_normalized || '');
    var rowEmail = normalizeEmail_(record.email_normalized || '');
    var idMatch = false;

    if (resolvedCpf && rowCpf && resolvedCpf === rowCpf) {
      idMatch = true;
    } else if (!resolvedCpf && resolvedEmail && rowEmail && resolvedEmail === rowEmail) {
      idMatch = true;
    } else if (resolvedCpf && resolvedEmail && rowEmail && resolvedEmail === rowEmail) {
      idMatch = true;
    }

    if (!idMatch) continue;

    var specialProfile = resolveSpecialProfileFromRecord_(record);
    if (!specialProfile || !specialProfile.isSpecial) continue;
    if (expectedType && specialProfile.certificateType !== expectedType) continue;

    return { rowIndex: record.__rowIndex, record: record };
  }
  return null;
}

function updateCertificateReissue_(rowIndex, record, nowIso, patch) {
  var sheet = getCertificatesSheet_();
  var idxMap = buildHeaderIndexMap_(CERT_HEADERS);
  var issueCount = Number(record.issue_count || 0) + 1;
  var metaObj = patch && patch.meta_json
    ? safeParseJson_(patch.meta_json, {})
    : safeParseJson_(record.meta_json, {});

  patch = patch || {};

  sheet.getRange(rowIndex, idxMap.last_reissued_at_iso).setValue(nowIso);
  sheet.getRange(rowIndex, idxMap.issue_count).setValue(issueCount);

  if (patch.participant_name && !/^\d+$/.test(String(patch.participant_name).trim())) {
    sheet.getRange(rowIndex, idxMap.participant_name).setValue(patch.participant_name);
  }
  if (patch.cpf_normalized) sheet.getRange(rowIndex, idxMap.cpf_normalized).setValue(patch.cpf_normalized);
  if (patch.email_normalized) sheet.getRange(rowIndex, idxMap.email_normalized).setValue(patch.email_normalized);
  if (patch.participant_source_id) sheet.getRange(rowIndex, idxMap.participant_source_id).setValue(patch.participant_source_id);

  if (patch.dias_label) {
    var safeLabel = /marÃ§o/i.test(patch.dias_label) ? patch.dias_label : CERT_CONFIG.EVENT_DATE_LABEL;
    sheet.getRange(rowIndex, idxMap.dias_label).setValue(safeLabel);
  }

  metaObj.last_reissue_at = nowIso;
  sheet.getRange(rowIndex, idxMap.meta_json).setValue(JSON.stringify(metaObj));
}

function mergeRecordWithPatch_(record, patch, nowIso) {
  var merged = {};
  CERT_HEADERS.forEach(function(h) {
    merged[h] = record[h] != null ? record[h] : '';
  });

  if (patch.participant_name && !/^\d+$/.test(String(patch.participant_name).trim())) {
    merged.participant_name = patch.participant_name;
  }
  if (patch.cpf_normalized) merged.cpf_normalized = patch.cpf_normalized;
  if (patch.email_normalized) merged.email_normalized = patch.email_normalized;
  if (patch.participant_source_id) merged.participant_source_id = patch.participant_source_id;
  if (patch.dias_label) merged.dias_label = /marÃ§o/i.test(patch.dias_label) ? patch.dias_label : CERT_CONFIG.EVENT_DATE_LABEL;
  if (patch.meta_json) merged.meta_json = patch.meta_json;

  merged.last_reissued_at_iso = nowIso;
  merged.issue_count = Number(record.issue_count || 0) + 1;
  return merged;
}

function findParticipantInPresenceBase_(normalized) {
  var ss = getSpreadsheet_();
  var allSheets = ss.getSheets();
  var prioMap = {};
  CERT_CONFIG.PRIORITY_SHEETS.forEach(function(name, i) { prioMap[name] = i; });

  var buckets = new Array(CERT_CONFIG.PRIORITY_SHEETS.length);
  var otherSheets = [];

  allSheets.forEach(function(sheet) {
    var name = sheet.getName();
    if (CERT_CONFIG.SKIP_SHEETS.indexOf(name) !== -1) return;

    if (prioMap[name] !== undefined) {
      if (!buckets[prioMap[name]]) buckets[prioMap[name]] = sheet;
      return;
    }

    var nameLow = name.toLowerCase();
    var placed = false;
    var i;
    for (i = 0; i < CERT_CONFIG.PRIORITY_SHEETS.length; i++) {
      if (nameLow.indexOf(CERT_CONFIG.PRIORITY_SHEETS[i].toLowerCase()) !== -1) {
        if (!buckets[i]) buckets[i] = sheet;
        placed = true;
        break;
      }
    }
    if (!placed) otherSheets.push(sheet);
  });

  var ordered = buckets.filter(Boolean).concat(otherSheets);
  var bestScore = 0;
  var bestMatches = [];
  var i;

  function hasSameIdentity_(candidate, matches) {
    var key = String((candidate && candidate.matchIdentityKey) || '');
    var mi;
    if (!key) return false;
    for (mi = 0; mi < matches.length; mi++) {
      if (String((matches[mi] && matches[mi].matchIdentityKey) || '') === key) return true;
    }
    return false;
  }

  for (i = 0; i < ordered.length; i++) {
    var result = searchSheetForParticipant_(ordered[i], normalized);
    if (!result || !result.ok) continue;

    Logger.log('[CERT] Match em "' + ordered[i].getName() + '" score=' + result.score);

    if (result.score > bestScore) {
      bestScore = result.score;
      bestMatches = [result];
      continue;
    }

    if (result.score === bestScore && !hasSameIdentity_(result, bestMatches)) {
      bestMatches.push(result);
    }
  }

  if (bestScore >= 11 && bestMatches.length) {
    if (bestMatches.length === 1) return bestMatches[0];
    bestMatches[0].ambiguous = true;
    bestMatches[0].ambiguousCount = bestMatches.length;
    return bestMatches[0];
  }

  return { ok: false };
}

function searchSheetForParticipant_(sheet, normalized) {
  try {
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return { ok: false };

    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var colMap = buildColMapForSheet_(sheet.getName(), headers);
    if (colMap.email === -1 && colMap.cpf === -1) return { ok: false };

    var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    var bestMatch = null;
    var bestScore = 0;
    var bestMatchCount = 0;
    var bestMatchKeys = {};
    var i;

    for (i = 0; i < data.length; i++) {
      var row = data[i];
      var rowEmail = colMap.email >= 0 ? normalizeEmail_(row[colMap.email] || '') : '';
      var rowCpf = colMap.cpf >= 0 ? normalizeCpf_(row[colMap.cpf] || '') : '';
      var rowNome = colMap.nome >= 0 ? normalizeName_(row[colMap.nome] || '') : '';
      var score = 0;
      var identityKey = '';

      if (normalized.cpfNormalized && rowCpf && rowCpf === normalized.cpfNormalized) score += 10;
      if (normalized.emailNormalized && rowEmail && rowEmail === normalized.emailNormalized) score += 8;
      if (score === 0) continue;

      if (normalized.name && rowNome) {
        var reqLow = normalized.name.toLowerCase();
        var rowLow = rowNome.toLowerCase();
        if (reqLow === rowLow) score += 4;
        else if (reqLow.split(' ')[0] && rowLow.indexOf(reqLow.split(' ')[0]) !== -1) score += 1;
      }

      if (colMap.dia >= 0 && normalized.days && normalized.days.length > 0) {
        score += matchsDayInCell_(row[colMap.dia], normalized.days) ? 3 : -8;
      }

      identityKey = rowEmail
        ? 'email:' + rowEmail
        : (rowCpf ? 'cpf:' + rowCpf : sheet.getName() + '_row' + (i + 2));

      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          ok: true,
          participantName: rowNome || normalized.name,
          participantSourceId: sheet.getName() + '_row' + (i + 2),
          matchType: (rowCpf === normalized.cpfNormalized ? 'cpf' : 'email') + '_score' + score,
          sourceSheet: sheet.getName(),
          score: score,
          cpfNormalized: rowCpf || '',
          emailNormalized: rowEmail || normalized.emailNormalized || '',
          matchIdentityKey: identityKey
        };
        bestMatchCount = 1;
        bestMatchKeys = {};
        bestMatchKeys[identityKey] = true;
      } else if (score === bestScore && score >= 11 && !bestMatchKeys[identityKey]) {
        bestMatchCount += 1;
        bestMatchKeys[identityKey] = true;
      }
    }

    if (bestScore >= 11 && bestMatch) {
      if (bestMatchCount > 1) {
        bestMatch.ambiguous = true;
        bestMatch.ambiguousCount = bestMatchCount;
      }
      return bestMatch;
    }
  } catch (err) {
    Logger.log('[CERT] Erro em "' + sheet.getName() + '": ' + err.message);
  }

  return { ok: false };
}

function buildColMapForSheet_(sheetName, headers) {
  var colMap = { nome: -1, email: -1, cpf: -1, dia: -1, status: -1 };
  var hIdx = {};

  headers.forEach(function(h, i) {
    var raw = String(h || '').trim();
    var norm = raw.toLowerCase()
      .replace(/[Ã¡Ã Ã£Ã¢Ã¤]/g, 'a').replace(/[Ã©Ã¨ÃªÃ«]/g, 'e')
      .replace(/[Ã­Ã¬Ã®Ã¯]/g, 'i').replace(/[Ã³Ã²ÃµÃ´Ã¶]/g, 'o')
      .replace(/[ÃºÃ¹Ã»Ã¼]/g, 'u').replace(/Ã§/g, 'c')
      .replace(/\s+/g, '_');
    if (raw) hIdx[raw] = i;
    if (norm) hIdx[norm] = i;
  });

  var override = SHEET_COL_OVERRIDES[sheetName];
  if (override) {
    ['nome', 'email', 'cpf', 'dia', 'status'].forEach(function(field) {
      if (override[field] === undefined) return;
      var t = override[field];
      var tn = t.toLowerCase().replace(/[Ã¡Ã Ã£Ã¢]/g, 'a').replace(/Ã§/g, 'c').replace(/\s+/g, '_');
      if (hIdx[t] !== undefined) colMap[field] = hIdx[t];
      else if (hIdx[tn] !== undefined) colMap[field] = hIdx[tn];
    });
    return colMap;
  }

  Object.keys(COL_VARIANTS).forEach(function(field) {
    if (colMap[field] !== -1) return;
    var variants = COL_VARIANTS[field];
    var v;
    for (v = 0; v < variants.length; v++) {
      var vn = variants[v].toLowerCase().replace(/\s+/g, '_');
      if (hIdx[vn] !== undefined) {
        colMap[field] = hIdx[vn];
        return;
      }
    }
    for (v = 0; v < variants.length; v++) {
      var partial = variants[v].toLowerCase().replace(/\s+/g, '_');
      if (partial.length < 4) continue;
      for (var key in hIdx) {
        if (key.indexOf(partial) !== -1) {
          colMap[field] = hIdx[key];
          return;
        }
      }
    }
  });

  return colMap;
}

function matchsDayInCell_(cellValue, days) {
  if (cellValue === null || cellValue === undefined || cellValue === '') return false;

  if (cellValue instanceof Date) {
    if (cellValue.getFullYear() === 2026 && cellValue.getMonth() === 2) {
      return days.indexOf(String(cellValue.getDate())) !== -1;
    }
    return false;
  }

  var str = String(cellValue).trim();
  var m1 = str.match(/2026-03-(\d{1,2})/);
  if (m1) return days.indexOf(String(parseInt(m1[1], 10))) !== -1;

  var m2 = str.match(/^(\d{1,2})\/03\/2026/);
  if (m2) return days.indexOf(String(parseInt(m2[1], 10))) !== -1;

  var di;
  for (di = 0; di < days.length; di++) {
    if (str === days[di] || str === '0' + days[di]) return true;
  }

  return false;
}

function buildCertificateResponse_(record) {
  var rawName = sanitizeTextField_(record.participant_name || '', 140);
  var safeName = /^\d+$/.test(rawName.trim()) ? '' : rawName;
  var rawLabel = sanitizeTextField_(record.dias_label || '', 80);
  var safeLabel = /marÃ§o/i.test(rawLabel) ? rawLabel : CERT_CONFIG.EVENT_DATE_LABEL;
  var safeCpf = normalizeCpf_(record.cpf_normalized || '');
  var speakerProfile = resolveSpeakerProfileFromRecord_(record);
  var specialProfile = resolveSpecialProfileFromRecord_(record);

  var response = {
    validationCode:  normalizeValidationCode_(record.validation_code || ''),
    participantName: safeName,
    cpfNormalized:   safeCpf,
    diasKey:         record.dias_key || '',
    diasLabel:       safeLabel,
    eventName:       CERT_CONFIG.EVENT_NAME,
    eventYear:       CERT_CONFIG.EVENT_YEAR,
    eventSlogan:     CERT_CONFIG.EVENT_SLOGAN,
    eventDateLabel:  CERT_CONFIG.EVENT_DATE_LABEL,
    eventHoursLabel: CERT_CONFIG.EVENT_HOURS_LABEL,
    eventLocal:      CERT_CONFIG.EVENT_LOCAL,
    issuedAt:        record.issued_at_iso || '',
    lastReissuedAt:  record.last_reissued_at_iso || '',
    issueCount:      Number(record.issue_count || 0),
    status:          record.status || '',
    pdfUrl:          record.pdf_url || '',
    certificateType: 'participant'
  };

  if (speakerProfile && speakerProfile.isSpeaker) {
    response.certificateType = 'speaker';
    response.participantName = sanitizeTextField_(speakerProfile.participantName || response.participantName, 140);
    response.participantRole = sanitizeTextField_(speakerProfile.participantRole || 'Palestrante', 120);
    response.participantRoleLabel = sanitizeTextField_(speakerProfile.roleLabel || 'Palestrante', 80);
    response.participantJobTitle = sanitizeTextField_(speakerProfile.jobTitle || '', 120);
    response.panelName = sanitizeTextField_(speakerProfile.panelName || '', 160);
  } else if (specialProfile && specialProfile.isSpecial) {
    response.certificateType = specialProfile.certificateType || 'participant';
    response.participantName = sanitizeTextField_(specialProfile.participantName || response.participantName, 140);
    response.specialLabel = sanitizeTextField_(specialProfile.specialLabel || getSpecialCertificateTypeLabel_(specialProfile.certificateType), 80);
    response.activityLabel = sanitizeTextField_(specialProfile.activityLabel || response.specialLabel, 80);
    if (specialProfile.projectName) {
      response.projectName = sanitizeTextField_(specialProfile.projectName || '', 180);
    }
  }

  return response;
}

function buildPublicValidationResponse_(record) {
  var rawName = sanitizeTextField_(record.participant_name || '', 140);
  var safeName = /^\d+$/.test(rawName.trim()) ? '' : rawName;
  var rawLabel = sanitizeTextField_(record.dias_label || '', 80);
  var safeLabel = /marÃ§o/i.test(rawLabel) ? rawLabel : CERT_CONFIG.EVENT_DATE_LABEL;
  var speakerProfile = resolveSpeakerProfileFromRecord_(record);
  var specialProfile = resolveSpecialProfileFromRecord_(record);

  if (speakerProfile && speakerProfile.isSpeaker) {
    safeName = sanitizeTextField_(speakerProfile.participantName || safeName, 140);
  } else if (specialProfile && specialProfile.isSpecial) {
    safeName = sanitizeTextField_(specialProfile.participantName || safeName, 140);
  }

  var response = {
    validationCode: normalizeValidationCode_(record.validation_code || ''),
    participantName: safeName,
    diasLabel: safeLabel,
    eventName: CERT_CONFIG.EVENT_NAME,
    eventYear: CERT_CONFIG.EVENT_YEAR,
    issuedAt: record.issued_at_iso || '',
    issueCount: Number(record.issue_count || 0),
    status: record.status || ''
  };

  if (specialProfile && specialProfile.isSpecial) {
    response.certificateType = specialProfile.certificateType || 'participant';
    response.specialLabel = sanitizeTextField_(specialProfile.specialLabel || getSpecialCertificateTypeLabel_(specialProfile.certificateType), 80);
    if (specialProfile.projectName) {
      response.projectName = sanitizeTextField_(specialProfile.projectName || '', 180);
    }
  }

  return response;
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function logCertificateAudit_(type, data) {
  try {
    var ss = getSpreadsheet_();
    var sheet = ss.getSheetByName(CERT_CONFIG.SHEET_AUDITORIA);
    if (!sheet) {
      sheet = ss.insertSheet(CERT_CONFIG.SHEET_AUDITORIA);
      sheet.appendRow(['timestamp_iso', 'type', 'data_json']);
      sheet.setFrozenRows(1);
    }

    var safeData = {};
    if (data) {
      Object.keys(data).forEach(function(k) {
        if (k === 'certificate_key' || k === 'participant_key') return;
        safeData[k] = data[k];
      });
    }

    sheet.appendRow([new Date().toISOString(), type, JSON.stringify(safeData)]);
  } catch (err) {
    Logger.log('Auditoria falhou: ' + err);
  }
}

function bytesToHex_(bytes) {
  return bytes.map(function(b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function buildHeaderIndexMap_(headers) {
  var map = {};
  headers.forEach(function(h, idx) { map[h] = idx + 1; });
  return map;
}

function uniqueNonEmptyStrings_(arr) {
  var out = [];
  var seen = {};
  (arr || []).forEach(function(item) {
    var v = String(item || '').trim();
    if (!v || seen[v]) return;
    seen[v] = true;
    out.push(v);
  });
  return out;
}

function safeParseJson_(value, fallback) {
  try {
    return value ? JSON.parse(value) : (fallback || {});
  } catch (_) {
    return fallback || {};
  }
}

function hashForAudit_(value) {
  try {
    var bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      String(value || '') + '|AXIS2026_LOG'
    );
    return bytesToHex_(bytes).slice(0, 12);
  } catch (_) {
    return 'hash_error';
  }
}

function _normalizarNome_(nome) {
  if (!nome) return '';
  return String(nome)
    .toLowerCase()
    .replace(/[Ã¡Ã Ã£Ã¢Ã¤]/g, 'a')
    .replace(/[Ã©Ã¨ÃªÃ«]/g, 'e')
    .replace(/[Ã­Ã¬Ã®Ã¯]/g, 'i')
    .replace(/[Ã³Ã²ÃµÃ´Ã¶]/g, 'o')
    .replace(/[ÃºÃ¹Ã»Ã¼]/g, 'u')
    .replace(/Ã§/g, 'c')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

var CERTIFICATE_TYPE_ORDER = ['publico_geral', 'speaker', 'rodada_negocios', 'atelie'];

function normalizeCertificateType_(value) {
  var raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'participant' || raw === 'public' || raw === 'publico' || raw === 'publico_geral') {
    return 'publico_geral';
  }
  if (raw === 'speaker' || raw === 'rodada_negocios' || raw === 'atelie') return raw;
  return raw;
}

function isSpecialCertificateType_(certificateType) {
  var normalizedType = normalizeCertificateType_(certificateType);
  return normalizedType === 'rodada_negocios' || normalizedType === 'atelie';
}

function getCertificateTypeLabel_(certificateType) {
  var normalizedType = normalizeCertificateType_(certificateType);
  if (normalizedType === 'publico_geral') return 'P\u00fablico Geral';
  if (normalizedType === 'speaker') return 'Speaker';
  if (normalizedType === 'rodada_negocios') return 'Rodada de Neg\u00f3cios';
  if (normalizedType === 'atelie') return 'Ateli\u00ea';
  return 'Certificado';
}

function getSpecialCertificateTypeLabel_(certificateType) {
  var normalizedType = normalizeCertificateType_(certificateType);
  if (normalizedType === 'rodada_negocios') return 'Rodada de Neg\u00f3cios';
  if (normalizedType === 'atelie') return 'Ateli\u00ea';
  return 'Certificado Especial';
}

function isSpecialCertificateHeaderRow_(row) {
  var a = normalizeName_(row && row[0] || '').toLowerCase();
  var d = normalizeName_(row && row[3] || '').toLowerCase();
  var g = normalizeName_(row && row[6] || '').toLowerCase();
  return (a === 'nome' || a === 'nome completo') &&
         (d === 'email' || d === 'e-mail') &&
         g === 'cpf';
}

function inferSpecialCertificateTypeFromRow_(rowNumber, row) {
  if (!row || isSpecialCertificateHeaderRow_(row)) return '';
  if (rowNumber === 16) return '';
  if (rowNumber >= 1 && rowNumber <= 15) return 'rodada_negocios';
  if (rowNumber >= 17) return 'atelie';
  return '';
}

function slugifyCertificateContext_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[Ã¡Ã Ã£Ã¢Ã¤]/g, 'a')
    .replace(/[Ã©Ã¨ÃªÃ«]/g, 'e')
    .replace(/[Ã­Ã¬Ã®Ã¯]/g, 'i')
    .replace(/[Ã³Ã²ÃµÃ´Ã¶]/g, 'o')
    .replace(/[ÃºÃ¹Ã»Ã¼]/g, 'u')
    .replace(/Ã§/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function buildCertificateContextKey_(certificateType, effectiveDays, specialProfile) {
  var normalizedType = normalizeCertificateType_(certificateType);
  if (normalizedType === 'speaker') return 'dias:' + buildDiasKey_(CERT_CONFIG.ALLOWED_DAYS);
  if (normalizedType === 'rodada_negocios') {
    var projectSlug = slugifyCertificateContext_(specialProfile && specialProfile.projectName || '');
    return projectSlug ? 'project:' + projectSlug : 'dias:' + buildDiasKey_([CERT_CONFIG.SPECIAL_CERT_DAY]);
  }
  if (normalizedType === 'atelie') return 'dias:' + buildDiasKey_([CERT_CONFIG.SPECIAL_CERT_DAY]);
  return 'dias:' + buildDiasKey_(effectiveDays && effectiveDays.length ? effectiveDays : CERT_CONFIG.ALLOWED_DAYS.slice());
}

function buildCertificateKey_(participantKey, certificateTypeOrDiasKey, contextKey) {
  if (contextKey === undefined || contextKey === null || contextKey === '') {
    return ['AXIS2026', participantKey, certificateTypeOrDiasKey].join('|');
  }
  return ['AXIS2026', participantKey, normalizeCertificateType_(certificateTypeOrDiasKey), contextKey].join('|');
}

function buildCertificateOptions_(eligibility) {
  return (eligibility && eligibility.eligibleCertificateTypes || []).map(function(certificateType) {
    var profile = eligibility.profilesByType[certificateType] || {};
    var option = {
      certificateType: certificateType,
      label: getCertificateTypeLabel_(certificateType)
    };
    if (certificateType === 'rodada_negocios' && profile.projectName) {
      option.projectName = sanitizeTextField_(profile.projectName || '', 180);
    }
    return option;
  });
}

function findSpecialCertificateParticipant_(normalized) {
  var lookup = resolveSpecialCertificateProfiles_(normalized);
  if (!lookup || !lookup.profilesByType) return null;
  return lookup.profilesByType.rodada_negocios || lookup.profilesByType.atelie || null;
}

function resolveSpecialCertificateProfiles_(normalized) {
  var result = {
    profilesByType: {},
    ambiguous: false
  };

  try {
    var sheet = getSpreadsheet_().getSheetByName(CERT_CONFIG.SHEET_SPECIAL_CERTS);
    if (!sheet) return result;

    var lastRow = sheet.getLastRow();
    var lastCol = Math.max(7, sheet.getLastColumn());
    if (lastRow < 1 || lastCol < 7) return result;

    var data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    var buckets = {
      rodada_negocios: { bestMatch: null, bestScore: 0, bestCount: 0, bestKeys: {} },
      atelie:          { bestMatch: null, bestScore: 0, bestCount: 0, bestKeys: {} }
    };
    var i;

    for (i = 0; i < data.length; i++) {
      var rowNumber = i + 1;
      var row = data[i];
      var certificateType = inferSpecialCertificateTypeFromRow_(rowNumber, row);
      if (!certificateType) continue;

      var rowNameRaw = normalizeName_(row[0] || '');
      var projectRaw = normalizeName_(row[1] || '');
      var rowEmail = normalizeEmail_(row[3] || '');
      var rowCpf = normalizeCpf_(row[6] || '');
      if (!rowNameRaw && !rowEmail && !rowCpf) continue;

      var score = 0;
      if (normalized.cpfNormalized && rowCpf && rowCpf === normalized.cpfNormalized) score += 10;
      if (normalized.emailNormalized && rowEmail && rowEmail === normalized.emailNormalized) score += 8;
      if (score === 0) continue;

      if (normalized.name && rowNameRaw) {
        var reqLow = normalized.name.toLowerCase();
        var rowLow = rowNameRaw.toLowerCase();
        if (reqLow === rowLow) score += 4;
        else if (reqLow.split(' ')[0] && rowLow.indexOf(reqLow.split(' ')[0]) !== -1) score += 1;
      }

      var identityKey = rowEmail
        ? 'email:' + rowEmail
        : (rowCpf ? 'cpf:' + rowCpf : sheet.getName() + '_row' + rowNumber);
      var bucket = buckets[certificateType];

      if (score > bucket.bestScore) {
        bucket.bestScore = score;
        bucket.bestMatch = {
          ok: true,
          isSpecial: true,
          certificateType: certificateType,
          specialLabel: getSpecialCertificateTypeLabel_(certificateType),
          activityLabel: getSpecialCertificateTypeLabel_(certificateType),
          projectName: certificateType === 'rodada_negocios' ? normalizeSpecialProjectName_(projectRaw) : '',
          participantName: normalizeEditorialCase_(rowNameRaw || normalized.name || ''),
          participantSourceId: sheet.getName() + '_row' + rowNumber,
          sourceSheet: sheet.getName(),
          score: score,
          cpfNormalized: rowCpf || '',
          emailNormalized: rowEmail || normalized.emailNormalized || '',
          matchIdentityKey: identityKey,
          effectiveDays: [CERT_CONFIG.SPECIAL_CERT_DAY]
        };
        bucket.bestCount = 1;
        bucket.bestKeys = {};
        bucket.bestKeys[identityKey] = true;
      } else if (score === bucket.bestScore && score >= 8 && !bucket.bestKeys[identityKey]) {
        bucket.bestCount += 1;
        bucket.bestKeys[identityKey] = true;
      }
    }

    Object.keys(buckets).forEach(function(certificateType) {
      var bucket = buckets[certificateType];
      if (bucket.bestScore < 8 || !bucket.bestMatch) return;
      if (bucket.bestCount > 1 && !normalized.cpfNormalized) {
        bucket.bestMatch.ambiguous = true;
        bucket.bestMatch.ambiguousCount = bucket.bestCount;
        result.ambiguous = true;
      }
      result.profilesByType[certificateType] = bucket.bestMatch;
    });
  } catch (err) {
    Logger.log('[CERT] Special lookup falhou: ' + err.message);
  }

  return result;
}

function resolveCertificateEligibility_(normalized) {
  var presenceMatch = findParticipantInPresenceBase_(normalized);
  var speakerProfile = resolveSpeakerProfile_(normalized);
  var specialLookup = resolveSpecialCertificateProfiles_(normalized);
  var specialProfiles = specialLookup.profilesByType || {};
  var hasSpecial = Object.keys(specialProfiles).length > 0;
  var hasPresence = presenceMatch && presenceMatch.ok;
  var participantName = normalized.name || '';
  var resolvedCpf = normalized.cpfNormalized || '';
  var resolvedEmail = normalized.emailNormalized || '';
  var defaultDays = normalized.days && normalized.days.length ? normalized.days.slice() : CERT_CONFIG.ALLOWED_DAYS.slice();

  function hydrateIdentity(profile) {
    if (!profile) return;
    participantName = sanitizeTextField_(profile.participantName || participantName, 140) || participantName;
    resolvedCpf = resolvedCpf || normalizeCpf_(profile.cpfNormalized || '');
    resolvedEmail = resolvedEmail || normalizeEmail_(profile.emailNormalized || '');
  }

  if (hasPresence) hydrateIdentity(presenceMatch);
  if (speakerProfile) hydrateIdentity(speakerProfile);
  if (specialProfiles.rodada_negocios) hydrateIdentity(specialProfiles.rodada_negocios);
  if (specialProfiles.atelie) hydrateIdentity(specialProfiles.atelie);

  if (!hasPresence && !speakerProfile && !hasSpecial) {
    return { ok: false };
  }

  if ((hasPresence && presenceMatch.ambiguous && !normalized.cpfNormalized) || specialLookup.ambiguous) {
    return {
      ok: true,
      requiresCpf: true,
      participantName: participantName || normalized.name,
      defaultDays: defaultDays,
      error: 'Encontramos mais de um registro compativel com os dados informados.',
      hint: 'Informe seu CPF para confirmar sua identidade e concluir a emissao.'
    };
  }

  var eligibleCertificateTypes = [];
  var profilesByType = {};
  var eligibilitySources = {};
  var publicGeneralSource = hasPresence
    ? presenceMatch
    : (speakerProfile || specialProfiles.rodada_negocios || specialProfiles.atelie || null);
  var publicGeneralDays = hasPresence && normalized.days && normalized.days.length
    ? normalized.days.slice()
    : CERT_CONFIG.ALLOWED_DAYS.slice();
  var publicGeneralName = sanitizeTextField_((publicGeneralSource && publicGeneralSource.participantName) || participantName || normalized.name, 140);
  var publicGeneralCpf = normalizeCpf_((publicGeneralSource && publicGeneralSource.cpfNormalized) || resolvedCpf || '');
  var publicGeneralEmail = normalizeEmail_((publicGeneralSource && publicGeneralSource.emailNormalized) || resolvedEmail || '');
  var publicGeneralSourceId = publicGeneralSource && publicGeneralSource.participantSourceId ? publicGeneralSource.participantSourceId : '';
  var publicGeneralContextKey = buildCertificateContextKey_('publico_geral', publicGeneralDays, null);
  var publicGeneralDiasKey = buildDiasKey_(publicGeneralDays);

  if (hasPresence || speakerProfile || hasSpecial) {
    eligibleCertificateTypes.push('publico_geral');
    profilesByType.publico_geral = {
      certificateType: 'publico_geral',
      participantName: publicGeneralName || normalized.name,
      cpfNormalized: publicGeneralCpf,
      emailNormalized: publicGeneralEmail,
      participantSourceId: publicGeneralSourceId,
      effectiveDays: publicGeneralDays,
      diasKey: publicGeneralDiasKey,
      legacyDiasKey: publicGeneralDiasKey,
      diasLabel: buildDiasLabel_(publicGeneralDays),
      contextKey: publicGeneralContextKey,
      speakerProfile: null,
      specialProfile: null
    };
    eligibilitySources.publico_geral = uniqueNonEmptyStrings_([
      hasPresence ? String(presenceMatch.sourceSheet || '') : '',
      speakerProfile ? String(speakerProfile.sourceSheet || '') : '',
      specialProfiles.rodada_negocios ? String(specialProfiles.rodada_negocios.sourceSheet || '') : '',
      specialProfiles.atelie ? String(specialProfiles.atelie.sourceSheet || '') : ''
    ]);
  }

  if (speakerProfile && speakerProfile.isSpeaker) {
    eligibleCertificateTypes.push('speaker');
    profilesByType.speaker = {
      certificateType: 'speaker',
      participantName: sanitizeTextField_(speakerProfile.participantName || participantName || normalized.name, 140),
      cpfNormalized: normalizeCpf_(speakerProfile.cpfNormalized || resolvedCpf || ''),
      emailNormalized: normalizeEmail_(speakerProfile.emailNormalized || resolvedEmail || ''),
      participantSourceId: speakerProfile.participantSourceId || '',
      effectiveDays: CERT_CONFIG.ALLOWED_DAYS.slice(),
      diasKey: buildDiasKey_(CERT_CONFIG.ALLOWED_DAYS),
      legacyDiasKey: buildDiasKey_(CERT_CONFIG.ALLOWED_DAYS),
      diasLabel: CERT_CONFIG.EVENT_DATE_LABEL,
      contextKey: buildCertificateContextKey_('speaker', CERT_CONFIG.ALLOWED_DAYS, null),
      speakerProfile: speakerProfile,
      specialProfile: null
    };
    eligibilitySources.speaker = uniqueNonEmptyStrings_([speakerProfile.sourceSheet || '']);
  }

  ['rodada_negocios', 'atelie'].forEach(function(certificateType) {
    var specialProfile = specialProfiles[certificateType];
    if (!specialProfile || !specialProfile.isSpecial) return;
    eligibleCertificateTypes.push(certificateType);
    profilesByType[certificateType] = {
      certificateType: certificateType,
      participantName: sanitizeTextField_(specialProfile.participantName || participantName || normalized.name, 140),
      cpfNormalized: normalizeCpf_(specialProfile.cpfNormalized || resolvedCpf || ''),
      emailNormalized: normalizeEmail_(specialProfile.emailNormalized || resolvedEmail || ''),
      participantSourceId: specialProfile.participantSourceId || '',
      effectiveDays: [CERT_CONFIG.SPECIAL_CERT_DAY],
      diasKey: buildDiasKey_([CERT_CONFIG.SPECIAL_CERT_DAY]),
      legacyDiasKey: buildDiasKey_([CERT_CONFIG.SPECIAL_CERT_DAY]),
      diasLabel: buildDiasLabel_([CERT_CONFIG.SPECIAL_CERT_DAY]),
      contextKey: buildCertificateContextKey_(certificateType, [CERT_CONFIG.SPECIAL_CERT_DAY], specialProfile),
      speakerProfile: null,
      specialProfile: specialProfile,
      projectName: specialProfile.projectName || ''
    };
    eligibilitySources[certificateType] = uniqueNonEmptyStrings_([specialProfile.sourceSheet || '']);
  });

  eligibleCertificateTypes = CERTIFICATE_TYPE_ORDER.filter(function(certificateType) {
    return eligibleCertificateTypes.indexOf(certificateType) !== -1;
  });

  return {
    ok: eligibleCertificateTypes.length > 0,
    eligibleCertificateTypes: eligibleCertificateTypes,
    defaultCertificateType: eligibleCertificateTypes[0] || '',
    profilesByType: profilesByType,
    eligibilitySources: eligibilitySources,
    participantName: participantName || normalized.name,
    cpfNormalized: resolvedCpf,
    emailNormalized: resolvedEmail,
    defaultDays: defaultDays
  };
}

function buildCertificateMeta_(issueProfile, eligibility, existingMeta, lastReissueAt) {
  var meta = existingMeta || {};
  meta.event_name = CERT_CONFIG.EVENT_NAME;
  meta.event_year = CERT_CONFIG.EVENT_YEAR;
  meta.raw_days = normalizeDays_(issueProfile && issueProfile.effectiveDays || []);
  meta.issuedCertificateType = normalizeCertificateType_(issueProfile && issueProfile.certificateType || '');
  meta.eligibleCertificateTypes = (eligibility && eligibility.eligibleCertificateTypes || []).slice();
  meta.eligibilitySources = eligibility && eligibility.eligibilitySources ? eligibility.eligibilitySources : {};
  meta.certificateContextKey = issueProfile && issueProfile.contextKey ? issueProfile.contextKey : '';

  if (issueProfile && issueProfile.certificateType === 'speaker' && issueProfile.speakerProfile) {
    meta.speaker = buildSpeakerMeta_(issueProfile.speakerProfile);
  } else if (meta.speaker) {
    delete meta.speaker;
  }

  if (issueProfile && isSpecialCertificateType_(issueProfile.certificateType) && issueProfile.specialProfile) {
    meta.special = buildSpecialMeta_(issueProfile.specialProfile);
  } else if (meta.special) {
    delete meta.special;
  }

  if (lastReissueAt) meta.last_reissue_at = lastReissueAt;
  return meta;
}

function resolveSpeakerProfileFromRecordLegacy_(record) {
  if (!record) return null;

  var meta = safeParseJson_(record.meta_json, {});
  var metaSpeaker = meta && meta.speaker && meta.speaker.isSpeaker ? meta.speaker : null;
  var lookup = resolveSpeakerProfile_({
    name: record.participant_name || '',
    cpfNormalized: record.cpf_normalized || '',
    emailNormalized: record.email_normalized || ''
  });

  if (lookup) return lookup;

  if (metaSpeaker) {
    var roleLabel = normalizeSpeakerRoleLabel_(metaSpeaker.roleLabel || metaSpeaker.role || '');
    var jobTitle = normalizeEditorialCase_(normalizeName_(metaSpeaker.jobTitle || ''));
    return {
      isSpeaker: true,
      participantName: normalizeEditorialCase_(normalizeName_(metaSpeaker.participantName || record.participant_name || '')),
      emailNormalized: normalizeEmail_(record.email_normalized || ''),
      cpfNormalized: normalizeCpf_(record.cpf_normalized || ''),
      roleRaw: metaSpeaker.role || '',
      roleLabel: roleLabel,
      participantRole: composeSpeakerRole_(roleLabel, jobTitle),
      panelName: normalizeEditorialCase_(normalizeName_(metaSpeaker.panelName || '')),
      jobTitle: jobTitle,
      sourceSheet: metaSpeaker.sourceSheet || '',
      participantSourceId: metaSpeaker.participantSourceId || String(record.participant_source_id || ''),
      eventDate: metaSpeaker.eventDate || '',
      eventTime: metaSpeaker.eventTime || '',
      eventLocation: metaSpeaker.eventLocation || ''
    };
  }

  return null;
}

function resolveSpecialProfileFromRecordLegacy_(record) {
  if (!record) return null;

  var meta = safeParseJson_(record.meta_json, {});
  var metaSpecial = meta && meta.special && meta.special.isSpecial ? meta.special : null;
  if (!metaSpecial) return null;

  var certificateType = normalizeCertificateType_(metaSpecial.certificateType || '');
  return {
    ok: true,
    isSpecial: true,
    certificateType: certificateType,
    specialLabel: metaSpecial.specialLabel || getSpecialCertificateTypeLabel_(certificateType),
    activityLabel: metaSpecial.activityLabel || metaSpecial.specialLabel || getSpecialCertificateTypeLabel_(certificateType),
    projectName: normalizeSpecialProjectName_(metaSpecial.projectName || ''),
    participantName: sanitizeTextField_(metaSpecial.participantName || record.participant_name || '', 140),
    emailNormalized: normalizeEmail_(record.email_normalized || ''),
    cpfNormalized: normalizeCpf_(record.cpf_normalized || ''),
    sourceSheet: metaSpecial.sourceSheet || '',
    participantSourceId: metaSpecial.participantSourceId || String(record.participant_source_id || ''),
    effectiveDays: [CERT_CONFIG.SPECIAL_CERT_DAY]
  };
}

function getIssuedCertificateTypeFromRecord_(record, metaObj) {
  var meta = metaObj || safeParseJson_(record && record.meta_json || '', {});
  var explicitType = normalizeCertificateType_(meta && meta.issuedCertificateType || '');
  if (explicitType) return explicitType;

  var legacySpeaker = resolveSpeakerProfileFromRecordLegacy_(record);
  if (legacySpeaker && legacySpeaker.isSpeaker) return 'speaker';

  var legacySpecial = resolveSpecialProfileFromRecordLegacy_(record);
  if (legacySpecial && legacySpecial.isSpecial) return legacySpecial.certificateType || 'publico_geral';

  return 'publico_geral';
}

function resolveSpeakerProfileFromRecord_(record) {
  if (getIssuedCertificateTypeFromRecord_(record) !== 'speaker') return null;
  return resolveSpeakerProfileFromRecordLegacy_(record);
}

function resolveSpecialProfileFromRecord_(record) {
  var issuedType = getIssuedCertificateTypeFromRecord_(record);
  if (!isSpecialCertificateType_(issuedType)) return null;

  var legacySpecial = resolveSpecialProfileFromRecordLegacy_(record);
  if (legacySpecial && legacySpecial.isSpecial) return legacySpecial;

  return {
    ok: true,
    isSpecial: true,
    certificateType: issuedType,
    specialLabel: getSpecialCertificateTypeLabel_(issuedType),
    activityLabel: getSpecialCertificateTypeLabel_(issuedType),
    projectName: '',
    participantName: sanitizeTextField_(record && record.participant_name || '', 140),
    emailNormalized: normalizeEmail_(record && record.email_normalized || ''),
    cpfNormalized: normalizeCpf_(record && record.cpf_normalized || ''),
    sourceSheet: '',
    participantSourceId: String(record && record.participant_source_id || ''),
    effectiveDays: [CERT_CONFIG.SPECIAL_CERT_DAY]
  };
}

function findExistingCertificateByCandidates_(participantKeys, certificateTypeOrDiasKey, contextKey, legacyDiasKey) {
  if (!participantKeys || !participantKeys.length) return null;

  var i;
  if (contextKey !== undefined) {
    for (i = 0; i < participantKeys.length; i++) {
      var current = findCertificateByKey_(buildCertificateKey_(participantKeys[i], certificateTypeOrDiasKey, contextKey));
      if (current) return current;
    }

    if (normalizeCertificateType_(certificateTypeOrDiasKey) === 'publico_geral' && legacyDiasKey) {
      for (i = 0; i < participantKeys.length; i++) {
        var legacy = findCertificateByKey_(buildCertificateKey_(participantKeys[i], legacyDiasKey));
        if (legacy) return legacy;
      }
    }
    return null;
  }

  for (i = 0; i < participantKeys.length; i++) {
    var found = findCertificateByKey_(buildCertificateKey_(participantKeys[i], certificateTypeOrDiasKey));
    if (found) return found;
  }
  return null;
}

function findCertificateByIdentityAndType_(resolvedCpf, resolvedEmail, expectedType) {
  var all = readAllCertificates_();
  var normalizedExpectedType = normalizeCertificateType_(expectedType || '');
  var i;

  for (i = all.length - 1; i >= 0; i--) {
    var record = all[i];
    var rowCpf = normalizeCpf_(record.cpf_normalized || '');
    var rowEmail = normalizeEmail_(record.email_normalized || '');
    var idMatch = false;

    if (resolvedCpf && rowCpf && resolvedCpf === rowCpf) {
      idMatch = true;
    } else if (!resolvedCpf && resolvedEmail && rowEmail && resolvedEmail === rowEmail) {
      idMatch = true;
    } else if (resolvedCpf && resolvedEmail && rowEmail && resolvedEmail === rowEmail) {
      idMatch = true;
    }

    if (!idMatch) continue;
    if (normalizedExpectedType && getIssuedCertificateTypeFromRecord_(record) !== normalizedExpectedType) continue;
    return { rowIndex: record.__rowIndex, record: record };
  }

  return null;
}

function findSpeakerCertificateByIdentity_(resolvedCpf, resolvedEmail) {
  return findCertificateByIdentityAndType_(resolvedCpf, resolvedEmail, 'speaker');
}

function findSpecialCertificateByIdentity_(resolvedCpf, resolvedEmail, expectedType) {
  if (expectedType) {
    var typedMatch = findCertificateByIdentityAndType_(resolvedCpf, resolvedEmail, expectedType);
    if (!typedMatch) return null;
    if (getIssuedCertificateTypeFromRecord_(typedMatch.record) !== normalizeCertificateType_(expectedType)) {
      return null;
    }
    return typedMatch;
  }

  var all = readAllCertificates_();
  var i;
  for (i = all.length - 1; i >= 0; i--) {
    var record = all[i];
    var rowCpf = normalizeCpf_(record.cpf_normalized || '');
    var rowEmail = normalizeEmail_(record.email_normalized || '');
    var idMatch = false;

    if (resolvedCpf && rowCpf && resolvedCpf === rowCpf) {
      idMatch = true;
    } else if (!resolvedCpf && resolvedEmail && rowEmail && resolvedEmail === rowEmail) {
      idMatch = true;
    } else if (resolvedCpf && resolvedEmail && rowEmail && resolvedEmail === rowEmail) {
      idMatch = true;
    }

    if (!idMatch) continue;
    if (!isSpecialCertificateType_(getIssuedCertificateTypeFromRecord_(record))) continue;
    return { rowIndex: record.__rowIndex, record: record };
  }

  return null;
}

function handleEmitCertificate_Inner_(payload) {
  var normalized = normalizeCertificateRequest_(payload);
  var eligibility = resolveCertificateEligibility_(normalized);

  if (!eligibility || !eligibility.ok || !eligibility.eligibleCertificateTypes.length) {
    return {
      ok: false,
      error: 'Participante nao localizado na base de presenca. Verifique nome, e-mail e dias selecionados.',
      code: 'PARTICIPANT_NOT_FOUND',
      hint: 'Use exatamente o nome e e-mail cadastrados no evento.'
    };
  }

  if (eligibility.requiresCpf) {
    return {
      ok: false,
      code: 'IDENTITY_CONFIRMATION_REQUIRED',
      requiresCpf: true,
      participantFound: true,
      error: eligibility.error || 'Encontramos mais de um registro compativel com os dados informados.',
      hint: eligibility.hint || 'Informe seu CPF para confirmar sua identidade e concluir a emissao.',
      participant: {
        participantName: eligibility.participantName || normalized.name,
        dias: eligibility.defaultDays || normalized.days || []
      }
    };
  }

  var requestedCertificateType = normalizeCertificateType_(
    payload.requestedCertificateType || payload.certificateType || payload.type || ''
  );
  if (!requestedCertificateType) {
    if (eligibility.eligibleCertificateTypes.length === 1) {
      requestedCertificateType = eligibility.defaultCertificateType;
    } else {
      return {
        ok: true,
        selectionRequired: true,
        code: 'CERTIFICATE_TYPE_SELECTION_REQUIRED',
        eligibleCertificateTypes: eligibility.eligibleCertificateTypes.slice(),
        certificateOptions: buildCertificateOptions_(eligibility),
        participant: {
          participantName: eligibility.participantName || normalized.name,
          dias: eligibility.defaultDays || normalized.days || []
        }
      };
    }
  }

  if (eligibility.eligibleCertificateTypes.indexOf(requestedCertificateType) === -1) {
    return {
      ok: false,
      error: 'O tipo de certificado solicitado nao esta disponivel para este participante.',
      code: 'REQUESTED_CERTIFICATE_TYPE_NOT_ALLOWED',
      eligibleCertificateTypes: eligibility.eligibleCertificateTypes.slice()
    };
  }

  var issueProfile = eligibility.profilesByType[requestedCertificateType];
  if (!issueProfile) {
    return {
      ok: false,
      error: 'Nao foi possivel preparar a emissao do certificado solicitado.',
      code: 'EMISSION_ERROR'
    };
  }

  var resolvedCpf = issueProfile.cpfNormalized || eligibility.cpfNormalized || '';
  var resolvedEmail = issueProfile.emailNormalized || eligibility.emailNormalized || '';
  var resolvedName = issueProfile.participantName || eligibility.participantName || normalized.name;
  var participantKeys = buildParticipantKeyCandidates_(resolvedCpf, resolvedEmail);
  if (!participantKeys.length) {
    return {
      ok: false,
      code: 'IDENTITY_CONFIRMATION_REQUIRED',
      requiresCpf: true,
      participantFound: true,
      error: 'Nao foi possivel confirmar sua identidade apenas com os dados informados.',
      hint: 'Informe seu CPF para concluir a emissao.',
      participant: {
        participantName: resolvedName,
        dias: issueProfile.effectiveDays || eligibility.defaultDays || []
      }
    };
  }

  var nowIso = new Date().toISOString();
  var existing = findExistingCertificateByCandidates_(
    participantKeys,
    issueProfile.certificateType,
    issueProfile.contextKey,
    issueProfile.legacyDiasKey
  );
  if (!existing && issueProfile.certificateType === 'speaker') {
    existing = findSpeakerCertificateByIdentity_(resolvedCpf, resolvedEmail);
  }
  if (!existing && isSpecialCertificateType_(issueProfile.certificateType)) {
    existing = findSpecialCertificateByIdentity_(resolvedCpf, resolvedEmail, issueProfile.certificateType);
  }

  var metaBase = buildCertificateMeta_(issueProfile, eligibility, null, nowIso);
  if (existing) {
    var patch = {
      participant_name: resolvedName,
      cpf_normalized: resolvedCpf,
      email_normalized: resolvedEmail,
      dias_label: issueProfile.diasLabel,
      participant_source_id: issueProfile.participantSourceId || '',
      meta_json: JSON.stringify(buildCertificateMeta_(issueProfile, eligibility, safeParseJson_(existing.record.meta_json, {}), nowIso))
    };

    updateCertificateReissue_(existing.rowIndex, existing.record, nowIso, patch);
    logCertificateAudit_('reissue', { validation_code: existing.record.validation_code });

    return {
      ok: true,
      mode: 'existing',
      message: 'Certificado localizado! Mesmo codigo reutilizado.',
      eligibleCertificateTypes: eligibility.eligibleCertificateTypes.slice(),
      certificate: buildCertificateResponse_(mergeRecordWithPatch_(existing.record, patch, nowIso))
    };
  }

  var participantKey = participantKeys[0];
  var certificateKey = buildCertificateKey_(participantKey, issueProfile.certificateType, issueProfile.contextKey);
  var validationCode = generateValidationCode_(certificateKey);
  var row = {
    certificate_key: certificateKey,
    validation_code: validationCode,
    participant_key: participantKey,
    participant_name: resolvedName,
    cpf_normalized: resolvedCpf,
    email_normalized: resolvedEmail,
    dias_key: issueProfile.diasKey,
    dias_label: issueProfile.diasLabel,
    participant_source_id: issueProfile.participantSourceId || '',
    issued_at_iso: nowIso,
    last_reissued_at_iso: nowIso,
    issue_count: 1,
    status: CERT_CONFIG.STATUS_ACTIVE,
    pdf_url: '',
    meta_json: JSON.stringify(metaBase)
  };

  appendCertificateRow_(row);
  logCertificateAudit_('issue', { validation_code: row.validation_code });
  return {
    ok: true,
    mode: 'created',
    message: 'Certificado emitido com sucesso.',
    eligibleCertificateTypes: eligibility.eligibleCertificateTypes.slice(),
    certificate: buildCertificateResponse_(row)
  };
}

function handleFindCertificate_(payload) {
  if (!_checkRateLimit_('buscar', payload, CERT_CONFIG.RATE_LIMIT_BUSCAR)) {
    return { ok: false, error: 'Muitas tentativas. Aguarde um momento.', code: 'RATE_LIMITED' };
  }

  var cpfNormalized = normalizeCpf_(payload.cpf || payload.document || '');
  var validationCode = normalizeValidationCode_(payload.validationCode || payload.validation_code || '');
  if (!cpfNormalized && !validationCode) {
    return {
      ok: false,
      error: 'Para buscar um certificado, informe o CPF ou o codigo de validacao.',
      code: 'INSUFFICIENT_LOOKUP_CREDENTIALS',
      hint: 'Informe o CPF usado no cadastro ou o codigo impresso no certificado.'
    };
  }

  if (validationCode) {
    if (!isValidationCodeFormat_(validationCode)) {
      return { ok: false, error: 'Codigo de validacao invalido.', code: 'INVALID_VALIDATION_CODE' };
    }
    var byCode = findCertificateByCode_(validationCode);
    if (!byCode) return { ok: false, error: 'Certificado nao encontrado.', code: 'CERTIFICATE_NOT_FOUND' };
    return { ok: true, certificate: buildCertificateResponse_(byCode.record) };
  }

  var normalized = normalizeLookupRequest_(payload);
  var requestedCertificateType = normalizeCertificateType_(
    payload.requestedCertificateType || payload.certificateType || payload.type || ''
  );

  if (requestedCertificateType === 'speaker') {
    var speakerExistingByType = findSpeakerCertificateByIdentity_(cpfNormalized, normalized.emailNormalized);
    return speakerExistingByType
      ? { ok: true, certificate: buildCertificateResponse_(speakerExistingByType.record) }
      : { ok: false, error: 'Certificado nao encontrado.', code: 'CERTIFICATE_NOT_FOUND' };
  }

  if (isSpecialCertificateType_(requestedCertificateType)) {
    var specialExistingByType = findSpecialCertificateByIdentity_(cpfNormalized, normalized.emailNormalized, requestedCertificateType);
    return specialExistingByType
      ? { ok: true, certificate: buildCertificateResponse_(specialExistingByType.record) }
      : { ok: false, error: 'Certificado nao encontrado.', code: 'CERTIFICATE_NOT_FOUND' };
  }

  if (!requestedCertificateType) {
    var speakerExisting = findSpeakerCertificateByIdentity_(cpfNormalized, normalized.emailNormalized);
    if (speakerExisting) return { ok: true, certificate: buildCertificateResponse_(speakerExisting.record) };

    var specialExisting = findSpecialCertificateByIdentity_(cpfNormalized, normalized.emailNormalized);
    if (specialExisting) return { ok: true, certificate: buildCertificateResponse_(specialExisting.record) };
  }

  if (!normalized.days.length) {
    return { ok: false, error: 'Selecione ao menos um dia para localizar o certificado.', code: 'INVALID_DAYS' };
  }

  var diasKey = buildDiasKey_(normalized.days);
  var candidateKeys = buildParticipantKeyCandidates_(cpfNormalized, normalized.emailNormalized);
  var existing = findExistingCertificateByCandidates_(candidateKeys, 'publico_geral', 'dias:' + diasKey, diasKey);
  if (!existing) return { ok: false, error: 'Certificado nao encontrado.', code: 'CERTIFICATE_NOT_FOUND' };
  return { ok: true, certificate: buildCertificateResponse_(existing.record) };
}

function buildCertificateResponse_(record) {
  var rawName = sanitizeTextField_(record.participant_name || '', 140);
  var safeName = /^\d+$/.test(rawName.trim()) ? '' : rawName;
  var rawLabel = sanitizeTextField_(record.dias_label || '', 80);
  var safeLabel = /mar/i.test(rawLabel) ? rawLabel : CERT_CONFIG.EVENT_DATE_LABEL;
  var safeCpf = normalizeCpf_(record.cpf_normalized || '');
  var meta = safeParseJson_(record.meta_json, {});
  var certificateType = getIssuedCertificateTypeFromRecord_(record, meta);
  var response = {
    validationCode: normalizeValidationCode_(record.validation_code || ''),
    participantName: safeName,
    cpfNormalized: safeCpf,
    diasKey: record.dias_key || '',
    diasLabel: safeLabel,
    eventName: CERT_CONFIG.EVENT_NAME,
    eventYear: CERT_CONFIG.EVENT_YEAR,
    eventSlogan: CERT_CONFIG.EVENT_SLOGAN,
    eventDateLabel: CERT_CONFIG.EVENT_DATE_LABEL,
    eventHoursLabel: CERT_CONFIG.EVENT_HOURS_LABEL,
    eventLocal: CERT_CONFIG.EVENT_LOCAL,
    issuedAt: record.issued_at_iso || '',
    lastReissuedAt: record.last_reissued_at_iso || '',
    issueCount: Number(record.issue_count || 0),
    status: record.status || '',
    pdfUrl: record.pdf_url || '',
    certificateType: certificateType
  };

  if (Array.isArray(meta.eligibleCertificateTypes)) {
    response.eligibleCertificateTypes = meta.eligibleCertificateTypes.map(normalizeCertificateType_).filter(Boolean);
  }

  if (certificateType === 'speaker') {
    var speakerProfile = resolveSpeakerProfileFromRecord_(record);
    if (speakerProfile && speakerProfile.isSpeaker) {
      response.participantName = sanitizeTextField_(speakerProfile.participantName || response.participantName, 140);
      response.participantRole = sanitizeTextField_(speakerProfile.participantRole || 'Palestrante', 120);
      response.participantRoleLabel = sanitizeTextField_(speakerProfile.roleLabel || 'Palestrante', 80);
      response.participantJobTitle = sanitizeTextField_(speakerProfile.jobTitle || '', 120);
      response.panelName = sanitizeTextField_(speakerProfile.panelName || '', 160);
    }
  } else if (isSpecialCertificateType_(certificateType)) {
    var specialProfile = resolveSpecialProfileFromRecord_(record);
    if (specialProfile && specialProfile.isSpecial) {
      response.participantName = sanitizeTextField_(specialProfile.participantName || response.participantName, 140);
      response.specialLabel = sanitizeTextField_(specialProfile.specialLabel || getSpecialCertificateTypeLabel_(certificateType), 80);
      response.activityLabel = sanitizeTextField_(specialProfile.activityLabel || response.specialLabel, 80);
      if (specialProfile.projectName) response.projectName = sanitizeTextField_(specialProfile.projectName || '', 180);
    }
  }

  return response;
}

function buildPublicValidationResponse_(record) {
  var rawName = sanitizeTextField_(record.participant_name || '', 140);
  var safeName = /^\d+$/.test(rawName.trim()) ? '' : rawName;
  var rawLabel = sanitizeTextField_(record.dias_label || '', 80);
  var safeLabel = /mar/i.test(rawLabel) ? rawLabel : CERT_CONFIG.EVENT_DATE_LABEL;
  var certificateType = getIssuedCertificateTypeFromRecord_(record);
  var response = {
    validationCode: normalizeValidationCode_(record.validation_code || ''),
    participantName: safeName,
    diasLabel: safeLabel,
    eventName: CERT_CONFIG.EVENT_NAME,
    eventYear: CERT_CONFIG.EVENT_YEAR,
    issuedAt: record.issued_at_iso || '',
    issueCount: Number(record.issue_count || 0),
    status: record.status || '',
    certificateType: certificateType
  };

  if (certificateType === 'speaker') {
    var speakerProfile = resolveSpeakerProfileFromRecord_(record);
    if (speakerProfile && speakerProfile.isSpeaker) {
      response.participantName = sanitizeTextField_(speakerProfile.participantName || safeName, 140);
    }
    return response;
  }

  if (isSpecialCertificateType_(certificateType)) {
    var specialProfile = resolveSpecialProfileFromRecord_(record);
    if (specialProfile && specialProfile.isSpecial) {
      response.participantName = sanitizeTextField_(specialProfile.participantName || safeName, 140);
      response.specialLabel = sanitizeTextField_(specialProfile.specialLabel || getSpecialCertificateTypeLabel_(certificateType), 80);
      if (specialProfile.projectName) response.projectName = sanitizeTextField_(specialProfile.projectName || '', 180);
    }
  }

  return response;
}

