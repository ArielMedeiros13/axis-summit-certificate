/**
 * Module: Credentialing and QR attendance backend.
 * What it does: Exposes the Apps Script API for monitor login, attendee search, daily check-in, activity synchronization, QR token validation, and activity-level attendance confirmation.
 * Key design decisions: Keeps operational data in a small number of purpose-specific sheets, uses `LockService` for write contention, and derives QR activity IDs and tokens deterministically from schedule records.
 * System connections: Serves the frontends under `web/credentialing` and `web/qr`; shares the same spreadsheet model later consumed by `axis-certificados.gs`.
 */

// AXIS Summit 2026 - Backend operacional de credenciamento
// Cole em um único projeto Apps Script.
// Você pode manter seu bloco AXIS_EVENTS atual neste mesmo projeto.
// Se AXIS_EVENTS não existir no GAS, o admin-qr enviará os eventos no sync.

var CONFIG = {
  SPREADSHEET_ID: 'REPLACE_WITH_YOUR_SPREADSHEET_ID',
  TOKEN_SECRET: 'REPLACE_WITH_YOUR_LONG_UNIQUE_TOKEN_SECRET',
  APP_VERSION: '2026.03.09.final',
  DIAS_VALIDOS: ['2026-03-10', '2026-03-11'],
  MAX_RESULTADOS: 30
};

var SHEETS = {
  MONITORES: 'Monitores',
  PUBLICO: 'Publico',
  LOGS: 'Logs',
  POSTERIOR: 'Posterior',
  SPEAKERS: 'Speakers',
  ATIVIDADES: 'Atividades',
  CHECKINS_ATIVIDADE: 'CheckinsAtividade'
};

var HEADERS = {};
HEADERS[SHEETS.MONITORES] = ['nome', 'email', 'cpf', 'senha_hash', 'ativo', 'perfil', 'observacoes'];
HEADERS[SHEETS.PUBLICO] = ['nome', 'email', 'telefone', 'categoria', 'origem', 'updated_at'];
HEADERS[SHEETS.LOGS] = ['timestamp', 'dia_evento', 'nome_participante', 'email_participante', 'telefone_participante', 'categoria', 'monitor_nome', 'monitor_email', 'origem'];
HEADERS[SHEETS.POSTERIOR] = ['timestamp', 'nome', 'cpf', 'email', 'telefone', 'monitor_nome', 'monitor_email', 'origem'];
HEADERS[SHEETS.SPEAKERS] = ['nome', 'email', 'cpf', 'origem', 'credencial', 'ativo', 'updated_at'];
HEADERS[SHEETS.ATIVIDADES] = ['atividade_id', 'dia', 'horario', 'horario_fim', 'titulo', 'tipo', 'palco', 'eixo', 'elegivel_qr', 'token', 'updated_at', 'ativo'];
HEADERS[SHEETS.CHECKINS_ATIVIDADE] = ['timestamp', 'atividade_id', 'dia', 'horario', 'titulo', 'tipo', 'palco', 'nome', 'email', 'telefone', 'status', 'origem', 'token_recebido', 'user_agent', 'ip_hint'];

function doGet(e) {
  return handleRequest_('GET', e);
}

function doPost(e) {
  return handleRequest_('POST', e);
}

function handleRequest_(method, e) {
  try {
    ensureSheets_();

    var payload = method === 'POST' ? parseBody_(e) : (e && e.parameter ? e.parameter : {});
    var action = clean_(payload.action || 'healthcheck');

    switch (action) {
      case 'healthcheck':
        return json_(healthcheck_());

      case 'diagnostico':
        return json_(diagnosticoSistema_());

      case 'diagnosticoAtividades':
        return json_(diagnosticoAtividades_());

      case 'login':
        return json_(loginMonitor_(payload.cpf, payload.senha));

      case 'buscarParticipantes':
        return json_(buscarParticipantes_(payload.termo));

      case 'registrarCheckin':
        return json_(registrarCheckinGeral_(
          payload.dia_evento,
          payload.nome_participante,
          payload.email_participante,
          payload.telefone_participante,
          payload.categoria,
          payload.monitor_nome,
          payload.monitor_email
        ));

      case 'cadastrarParticipante':
        return json_(cadastrarParticipantePosterior_(
          payload.nome,
          payload.cpf,
          payload.email,
          payload.telefone,
          payload.monitor_nome,
          payload.monitor_email,
          payload.origem || 'painel_monitores'
        ));

      case 'obterEstatisticas':
        return json_(obterEstatisticas_(payload.dia_evento));

      case 'contarCheckins':
        return json_(contarCheckins_(payload.dia_evento));

      case 'sincronizarAtividades':
        return json_(sincronizarAtividades_(payload.events));

      case 'listarAtividadesQr':
        return json_(listarAtividadesQr_());

      case 'validarTokenAtividade':
        return json_(validarTokenAtividade_(payload.atividade_id, payload.token));

      case 'confirmarCheckinAtividade':
        return json_(confirmarCheckinAtividade_(
          payload.atividade_id,
          payload.token,
          payload.nome,
          payload.email,
          payload.telefone,
          payload.origem || 'qr_publico',
          payload.user_agent || '',
          payload.ip_hint || ''
        ));

      case 'statsAtividadeLote':
        return json_(statsAtividadeLote_());

      default:
        return json_(fail_('Action desconhecida.', {
          action_recebida: action,
          actions_validas: [
            'healthcheck', 'diagnostico', 'diagnosticoAtividades', 'login',
            'buscarParticipantes', 'registrarCheckin', 'cadastrarParticipante',
            'obterEstatisticas', 'contarCheckins', 'sincronizarAtividades',
            'listarAtividadesQr', 'validarTokenAtividade',
            'confirmarCheckinAtividade', 'statsAtividadeLote'
          ]
        }));
    }
  } catch (err) {
    Logger.log('ERRO handleRequest_: ' + err.message + '\n' + err.stack);
    return json_(fail_('Erro interno no backend.', {
      error: String(err.message || err)
    }));
  }
}

function healthcheck_() {
  var diag = diagnosticoSistema_();
  return ok_({
    app: 'AXIS Summit Credenciamento',
    version: CONFIG.APP_VERSION,
    spreadsheet_id: CONFIG.SPREADSHEET_ID,
    sheets_ok: diag.sheets_ok,
    atividades_ok: diag.atividades_rows >= 0,
    token_secret_ok: diag.token_secret_ok
  });
}

function diagnosticoSistema_() {
  var ss = getSpreadsheet_();
  var atividades = getRowsSafe_(SHEETS.ATIVIDADES);
  var abas = ss.getSheets().map(function (s) {
    return {
      nome: s.getName(),
      linhas: s.getLastRow(),
      colunas: s.getLastColumn()
    };
  });

  return ok_({
    version: CONFIG.APP_VERSION,
    spreadsheet_id: CONFIG.SPREADSHEET_ID,
    token_secret_ok: !!clean_(CONFIG.TOKEN_SECRET),
    sheets_ok: true,
    atividades_rows: atividades.length,
    publico_rows: getPublicoRows_().length,
    speakers_rows: getRowsSafe_(SHEETS.SPEAKERS).length,
    abas: abas
  });
}

function diagnosticoAtividades_() {
  var atividades = getRowsSafe_(SHEETS.ATIVIDADES);
  var semToken = [];
  var inativas = [];
  var inelegiveis = [];

  atividades.forEach(function (r) {
    if (String(r.ativo).toUpperCase() !== 'TRUE') inativas.push(clean_(r.atividade_id));
    if (String(r.elegivel_qr).toUpperCase() !== 'TRUE') inelegiveis.push(clean_(r.atividade_id));
    if (String(r.elegivel_qr).toUpperCase() === 'TRUE' && !clean_(r.token)) semToken.push(clean_(r.atividade_id));
  });

  return ok_({
    total: atividades.length,
    elegiveis: atividades.filter(function (r) { return String(r.elegivel_qr).toUpperCase() === 'TRUE'; }).length,
    sem_token: semToken.length,
    inativas: inativas.length,
    inelegiveis: inelegiveis.length,
    exemplos_sem_token: semToken.slice(0, 10)
  });
}

function loginMonitor_(cpf, senha) {
  var cpfN = digits_(cpf);
  var senhaN = String(senha || '');
  if (cpfN.length !== 11 || senhaN.length < 4) {
    return fail_('CPF ou senha inválidos.');
  }

  var rows = getRowsSafe_(SHEETS.MONITORES);
  var hash = sha256_(senhaN);

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (digits_(row.cpf) !== cpfN) continue;
    if (String(row.ativo).toUpperCase() !== 'TRUE') return fail_('Monitor inativo.');
    if (clean_(row.senha_hash) !== hash) return fail_('CPF ou senha inválidos.');

    return ok_({
      monitor: {
        nome: clean_(row.nome),
        email: clean_(row.email).toLowerCase(),
        perfil: clean_(row.perfil) || 'monitor'
      }
    });
  }

  return fail_('CPF ou senha inválidos.');
}

function buscarParticipantes_(termo) {
  var q = normalize_(termo);
  if (q.length < 2) return fail_('Informe ao menos 2 caracteres.');

  var resultados = [];
  var seen = {};

  function pushItem_(nome, email, telefone, categoria, origemLabel) {
    var nomeN = clean_(nome);
    var emailN = clean_(email).toLowerCase();
    var telN = clean_(telefone);
    var key = [nomeN, emailN, categoria].join('|');
    if (!nomeN && !emailN) return;
    if (seen[key]) return;
    seen[key] = true;
    resultados.push({
      nome: nomeN,
      email: emailN,
      telefone: telN,
      categoria: categoria || 'publico',
      origem_label: origemLabel || 'Base geral'
    });
  }

  getPublicoRows_().forEach(function (r) {
    if (resultados.length >= CONFIG.MAX_RESULTADOS) return;
    var nome = clean_(r.nome);
    var email = clean_(r.email).toLowerCase();
    if (normalize_(nome).indexOf(q) !== -1 || normalize_(email).indexOf(q) !== -1) {
      pushItem_(nome, email, r.telefone, clean_(r.categoria) || 'publico', 'Base público');
    }
  });

  getRowsSafe_(SHEETS.SPEAKERS).forEach(function (r) {
    if (resultados.length >= CONFIG.MAX_RESULTADOS) return;
    var nome = clean_(r.nome);
    var email = clean_(r.email).toLowerCase();
    if (normalize_(nome).indexOf(q) !== -1 || normalize_(email).indexOf(q) !== -1) {
      pushItem_(nome, email, '', 'speaker', 'Speakers / programação');
    }
  });

  getRowsSafe_(SHEETS.POSTERIOR).forEach(function (r) {
    if (resultados.length >= CONFIG.MAX_RESULTADOS) return;
    var nome = clean_(r.nome);
    var email = clean_(r.email).toLowerCase();
    if (normalize_(nome).indexOf(q) !== -1 || normalize_(email).indexOf(q) !== -1) {
      pushItem_(nome, email, r.telefone, 'publico', 'Cadastro posterior');
    }
  });

  return ok_({
    resultados: resultados,
    total: resultados.length
  });
}

function registrarCheckinGeral_(diaEvento, nome, email, telefone, categoria, monitorNome, monitorEmail) {
  var dia = clean_(diaEvento);
  var nomeN = clean_(nome).slice(0, 200);
  var emailN = clean_(email).toLowerCase().slice(0, 200);
  var telefoneN = clean_(telefone).slice(0, 20);
  var categoriaN = clean_(categoria || 'publico') || 'publico';
  var monitorNomeN = clean_(monitorNome).slice(0, 200);
  var monitorEmailN = clean_(monitorEmail).toLowerCase().slice(0, 200);

  if (CONFIG.DIAS_VALIDOS.indexOf(dia) === -1) return fail_('Dia inválido.');
  if (!nomeN || !isEmail_(emailN)) return fail_('Nome e e-mail do participante são obrigatórios.');
  if (!monitorNomeN || !isEmail_(monitorEmailN)) return fail_('Dados do monitor inválidos.');

  return withLock_(function () {
    var rows = getRowsSafe_(SHEETS.LOGS);
    for (var i = 0; i < rows.length; i++) {
      if (clean_(rows[i].dia_evento) === dia && clean_(rows[i].email_participante).toLowerCase() === emailN) {
        return fail_('Participante já credenciado neste dia.', { duplicated: true });
      }
    }

    appendRow_(SHEETS.LOGS, [
      new Date(), dia, nomeN, emailN, telefoneN,
      categoriaN, monitorNomeN, monitorEmailN, 'painel_monitores'
    ]);

    return ok_({
      message: categoriaN === 'speaker'
        ? 'Check-in de speaker realizado com sucesso.'
        : 'Check-in realizado com sucesso.'
    });
  });
}

function cadastrarParticipantePosterior_(nome, cpf, email, telefone, monitorNome, monitorEmail, origem) {
  var nomeN = clean_(nome).slice(0, 200);
  var cpfN = digits_(cpf).slice(0, 11);
  var emailN = clean_(email).toLowerCase().slice(0, 200);
  var telefoneN = clean_(telefone).slice(0, 20);
  var monitorNomeN = clean_(monitorNome).slice(0, 200);
  var monitorEmailN = clean_(monitorEmail).toLowerCase().slice(0, 200);

  if (!nomeN) return fail_('Informe o nome.');
  if (emailN && !isEmail_(emailN)) return fail_('E-mail inválido.');
  if (!monitorNomeN || !isEmail_(monitorEmailN)) return fail_('Dados do monitor inválidos.');

  return withLock_(function () {
    appendRow_(SHEETS.POSTERIOR, [
      new Date(), nomeN, cpfN, emailN, telefoneN, monitorNomeN, monitorEmailN, clean_(origem || 'painel_monitores')
    ]);

    upsertPublico_(nomeN, emailN, telefoneN, 'publico', 'cadastro_posterior');

    return ok_({
      message: 'Cadastro posterior salvo com sucesso.'
    });
  });
}

function obterEstatisticas_(diaEvento) {
  var dia = clean_(diaEvento);
  if (CONFIG.DIAS_VALIDOS.indexOf(dia) === -1) return fail_('Dia inválido.');

  var logs = getRowsSafe_(SHEETS.LOGS);
  var total = 0;
  var porHora = {};

  logs.forEach(function (r) {
    if (clean_(r.dia_evento) !== dia) return;
    total += 1;
    var h = hourFrom_(r.timestamp);
    if (h >= 0) porHora[String(h)] = (porHora[String(h)] || 0) + 1;
  });

  return ok_({
    total: total,
    por_hora: porHora
  });
}

function contarCheckins_(diaEvento) {
  var stats = obterEstatisticas_(diaEvento);
  if (!stats.ok) return stats;
  return ok_({ total: stats.total });
}

function sincronizarAtividades_(eventsPayload) {
  var sourceEvents = getProgramacaoEvents_(eventsPayload);
  if (!sourceEvents.length) {
    return fail_('Nenhuma atividade de programação disponível para sincronizar.');
  }

  return withLock_(function () {
    var existentes = mapById_(getRowsSafe_(SHEETS.ATIVIDADES), 'atividade_id');
    var novos = {};
    var agora = new Date();
    var speakersSync = sincronizarSpeakersData_(sourceEvents, agora);

    sourceEvents.forEach(function (ev) {
      if (!isEligibleActivity_(ev)) return;

      var atividadeId = buildActivityId_(ev);
      var token = buildActivityToken_(atividadeId);
      var antigo = existentes[atividadeId] || {};

      novos[atividadeId] = {
        atividade_id: atividadeId,
        dia: clean_(ev.day),
        horario: clean_(ev.start),
        horario_fim: clean_(ev.end),
        titulo: clean_(ev.titulo),
        tipo: safeType_(ev.tipo),
        palco: clean_(ev.stage),
        eixo: clean_(ev.eixo),
        elegivel_qr: 'TRUE',
        token: token,
        updated_at: agora,
        ativo: 'TRUE'
      };
    });

    Object.keys(existentes).forEach(function (id) {
      if (!novos[id]) {
        var antigo = existentes[id];
        novos[id] = {
          atividade_id: clean_(antigo.atividade_id),
          dia: clean_(antigo.dia),
          horario: clean_(antigo.horario),
          horario_fim: clean_(antigo.horario_fim),
          titulo: clean_(antigo.titulo),
          tipo: clean_(antigo.tipo),
          palco: clean_(antigo.palco),
          eixo: clean_(antigo.eixo),
          elegivel_qr: clean_(antigo.elegivel_qr) || 'TRUE',
          token: clean_(antigo.token),
          updated_at: agora,
          ativo: 'FALSE'
        };
      }
    });

    writeRowsFromObjects_(SHEETS.ATIVIDADES, Object.keys(novos).sort().map(function (id) { return novos[id]; }));

    return ok_({
      total: Object.keys(novos).length,
      ativos: Object.keys(novos).filter(function (id) { return novos[id].ativo === 'TRUE'; }).length,
      speakers_total: speakersSync.ativos
    });
  });
}

function listarAtividadesQr_() {
  var rows = getRowsSafe_(SHEETS.ATIVIDADES);
  var atividades = rows
    .filter(function (r) {
      return String(r.ativo).toUpperCase() === 'TRUE' &&
             String(r.elegivel_qr).toUpperCase() === 'TRUE';
    })
    .map(function (r) {
      return {
        atividade_id: clean_(r.atividade_id),
        dia: clean_(r.dia),
        horario: clean_(r.horario),
        horario_fim: clean_(r.horario_fim),
        titulo: clean_(r.titulo),
        tipo: clean_(r.tipo),
        palco: clean_(r.palco),
        eixo: clean_(r.eixo),
        token: clean_(r.token),
        updated_at: r.updated_at
      };
    });

  return ok_({
    atividades: atividades,
    total: atividades.length
  });
}

function validarTokenAtividade_(atividadeId, token) {
  var id = clean_(atividadeId);
  var tokenN = clean_(token);

  if (!id || !tokenN) return fail_('Link incompleto.');

  var atividade = findAtividade_(id);
  if (!atividade) return fail_('Atividade não encontrada.', { code: 'atividade_nao_encontrada' });
  if (String(atividade.ativo).toUpperCase() !== 'TRUE') return fail_('Atividade inativa.', { code: 'atividade_inativa' });
  if (String(atividade.elegivel_qr).toUpperCase() !== 'TRUE') return fail_('Atividade inelegível para QR.', { code: 'atividade_inelegivel' });
  if (!clean_(atividade.token)) return fail_('Atividade sem token na base.', { code: 'atividade_sem_token' });
  if (tokenN !== clean_(atividade.token)) return fail_('QR inválido.', { code: 'token_invalido' });

  return ok_({
    atividade: {
      atividade_id: clean_(atividade.atividade_id),
      dia: clean_(atividade.dia),
      horario: clean_(atividade.horario),
      horario_fim: clean_(atividade.horario_fim),
      titulo: clean_(atividade.titulo),
      tipo: clean_(atividade.tipo),
      palco: clean_(atividade.palco),
      eixo: clean_(atividade.eixo)
    }
  });
}

function confirmarCheckinAtividade_(atividadeId, token, nome, email, telefone, origem, userAgent, ipHint) {
  var valid = validarTokenAtividade_(atividadeId, token);
  if (!valid.ok) return valid;

  var atividade = findAtividade_(clean_(atividadeId));
  var nomeN = clean_(nome).slice(0, 200);
  var emailN = clean_(email).toLowerCase().slice(0, 200);
  var telefoneN = clean_(telefone).slice(0, 20);
  var origemN = clean_(origem || 'qr_publico').slice(0, 40);

  if (nomeN.length < 3) return fail_('Informe seu nome completo.');
  if (!isEmail_(emailN)) return fail_('Informe um e-mail válido.');

  return withLock_(function () {
    var rows = getRowsSafe_(SHEETS.CHECKINS_ATIVIDADE);

    for (var i = 0; i < rows.length; i++) {
      if (clean_(rows[i].atividade_id) === atividade.atividade_id &&
          clean_(rows[i].email).toLowerCase() === emailN) {
        return ok_({
          duplicated: true,
          message: 'Sua presença nesta atividade já havia sido registrada.'
        });
      }
    }

    appendRow_(SHEETS.CHECKINS_ATIVIDADE, [
      new Date(),
      atividade.atividade_id,
      atividade.dia,
      atividade.horario,
      atividade.titulo,
      atividade.tipo,
      atividade.palco,
      nomeN,
      emailN,
      telefoneN,
      'CONFIRMADO',
      origemN,
      clean_(token),
      clean_(userAgent),
      clean_(ipHint)
    ]);

    return ok_({
      message: 'Presença confirmada em "' + atividade.titulo + '".'
    });
  });
}

function statsAtividadeLote_() {
  var rows = getRowsSafe_(SHEETS.CHECKINS_ATIVIDADE);
  var mapa = {};
  rows.forEach(function (r) {
    var id = clean_(r.atividade_id);
    if (!id) return;
    mapa[id] = (mapa[id] || 0) + 1;
  });
  return ok_({ mapa: mapa });
}

function getProgramacaoEvents_(eventsPayload) {
  if (eventsPayload && eventsPayload.length) return eventsPayload;
  if (typeof AXIS_EVENTS !== 'undefined' && AXIS_EVENTS && AXIS_EVENTS.length) return AXIS_EVENTS;
  return [];
}

function sincronizarSpeakersData_(sourceEvents, agora) {
  var existentes = getRowsSafe_(SHEETS.SPEAKERS);
  var existentesMap = mapSpeakersByKey_(existentes);
  var speakersAtuais = collectSpeakersFromEvents_(sourceEvents);
  var finalMap = {};

  Object.keys(speakersAtuais).forEach(function (key) {
    var speakerAtual = speakersAtuais[key];
    var speakerAnterior = existentesMap[key] || {};
    finalMap[key] = {
      nome: speakerAtual.nome,
      email: clean_(speakerAtual.email || speakerAnterior.email).toLowerCase(),
      cpf: digits_(speakerAtual.cpf || speakerAnterior.cpf).slice(0, 11),
      origem: speakerAtual.origem,
      credencial: clean_(speakerAnterior.credencial || speakerAtual.credencial || 'speaker') || 'speaker',
      ativo: 'TRUE',
      updated_at: agora
    };
  });

  Object.keys(existentesMap).forEach(function (key) {
    if (finalMap[key]) return;
    var anterior = existentesMap[key];
    finalMap[key] = {
      nome: clean_(anterior.nome),
      email: clean_(anterior.email).toLowerCase(),
      cpf: digits_(anterior.cpf).slice(0, 11),
      origem: clean_(anterior.origem),
      credencial: clean_(anterior.credencial) || 'speaker',
      ativo: 'FALSE',
      updated_at: agora
    };
  });

  writeRowsFromObjects_(
    SHEETS.SPEAKERS,
    Object.keys(finalMap)
      .sort(function (a, b) { return a.localeCompare(b); })
      .map(function (key) { return finalMap[key]; })
  );

  return {
    total: Object.keys(finalMap).length,
    ativos: Object.keys(speakersAtuais).length
  };
}

function collectSpeakersFromEvents_(events) {
  var speakers = {};

  (events || []).forEach(function (ev) {
    if (!isEligibleActivity_(ev)) return;

    addSpeakerCandidate_(speakers, ev && ev.mediator, ev);

    (ev && ev.participants || []).forEach(function (participant) {
      addSpeakerCandidate_(speakers, participant, ev);
    });
  });

  return speakers;
}

function addSpeakerCandidate_(map, person, eventInfo) {
  if (!person) return;

  var nome = clean_(person.name || person.nome);
  if (!nome) return;

  var key = normalize_(nome);
  var origemAtual = buildSpeakerOrigin_(eventInfo);
  var email = clean_(person.email || person.mail || '').toLowerCase();
  var cpf = digits_(person.cpf || '').slice(0, 11);

  if (!map[key]) {
    map[key] = {
      nome: nome,
      email: email,
      cpf: cpf,
      origem: '',
      credencial: 'speaker',
      origemMap: {}
    };
  }

  if (!map[key].email && email) map[key].email = email;
  if (!map[key].cpf && cpf) map[key].cpf = cpf;
  if (origemAtual) map[key].origemMap[origemAtual] = true;
  map[key].origem = Object.keys(map[key].origemMap).sort().join(' | ').slice(0, 500);
}

function buildSpeakerOrigin_(eventInfo) {
  var titulo = clean_(eventInfo && eventInfo.titulo);
  var dia = clean_(eventInfo && eventInfo.day);
  var horario = clean_(eventInfo && eventInfo.start);
  var palco = clean_(eventInfo && eventInfo.stage);
  return [titulo, dia, horario, palco].filter(Boolean).join(' • ').slice(0, 500);
}

function mapSpeakersByKey_(rows) {
  var map = {};
  (rows || []).forEach(function (row) {
    var key = normalize_(row.nome);
    if (!key) return;
    map[key] = row;
  });
  return map;
}

function ensureSheets_() {
  var ss = getSpreadsheet_();
  var order = [
    SHEETS.MONITORES,
    SHEETS.PUBLICO,
    SHEETS.LOGS,
    SHEETS.POSTERIOR,
    SHEETS.SPEAKERS,
    SHEETS.ATIVIDADES,
    SHEETS.CHECKINS_ATIVIDADE
  ];

  order.forEach(function (name, idx) {
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    var target = HEADERS[name];
    var current = [];

    if (sheet.getLastRow() >= 1 && sheet.getLastColumn() >= 1) {
      current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), target.length)).getValues()[0]
        .map(function (x) { return String(x || '').trim(); });
    }

    var needsHeader = target.some(function (h, i) { return current[i] !== h; });
    if (needsHeader) {
      sheet.getRange(1, 1, 1, target.length).setValues([target]);
      sheet.setFrozenRows(1);
    }

    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(idx + 1);
  });
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

function getSheet_(name) {
  var s = getSpreadsheet_().getSheetByName(name);
  if (!s) throw new Error('Aba não encontrada: ' + name);
  return s;
}

function getRowsSafe_(name) {
  try {
    return getRows_(name);
  } catch (err) {
    Logger.log('Falha ao ler aba ' + name + ': ' + err.message);
    return [];
  }
}

function getRows_(name) {
  var sheet = getSheet_(name);
  if (sheet.getLastRow() < 2) return [];
  var data = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  var headers = data[0];
  var out = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var hasData = row.some(function (cell) { return cell !== '' && cell !== null; });
    if (!hasData) continue;

    var obj = {};
    headers.forEach(function (h, idx) {
      obj[String(h).trim()] = row[idx];
    });
    out.push(obj);
  }

  return out;
}

function writeRowsFromObjects_(sheetName, objects) {
  var sheet = getSheet_(sheetName);
  var headers = HEADERS[sheetName];
  var values = [headers];

  objects.forEach(function (obj) {
    values.push(headers.map(function (h) { return obj[h] == null ? '' : obj[h]; }));
  });

  sheet.clearContents();
  sheet.getRange(1, 1, values.length, headers.length).setValues(values);
  sheet.setFrozenRows(1);
}

function appendRow_(sheetName, row) {
  getSheet_(sheetName).appendRow(row);
}

function findAtividade_(atividadeId) {
  var rows = getRowsSafe_(SHEETS.ATIVIDADES);
  for (var i = 0; i < rows.length; i++) {
    if (clean_(rows[i].atividade_id) === clean_(atividadeId)) return rows[i];
  }
  return null;
}

function getPublicoRows_() {
  var semAcento = getSpreadsheet_().getSheetByName('Publico');
  var comAcento = getSpreadsheet_().getSheetByName('Público');

  if (semAcento && semAcento.getLastRow() > 1) return getRows_('Publico');
  if (comAcento && comAcento.getLastRow() > 1) return getRows_('Público');
  if (semAcento) return getRowsSafe_('Publico');
  if (comAcento) return getRowsSafe_('Público');
  return [];
}

function upsertPublico_(nome, email, telefone, categoria, origem) {
  if (!nome && !email) return;

  var sheet = getSheet_(SHEETS.PUBLICO);
  var rows = getRowsSafe_(SHEETS.PUBLICO);
  var emailN = clean_(email).toLowerCase();
  var nomeN = clean_(nome);

  for (var i = 0; i < rows.length; i++) {
    if (emailN && clean_(rows[i].email).toLowerCase() === emailN) {
      var line = i + 2;
      sheet.getRange(line, 1, 1, HEADERS[SHEETS.PUBLICO].length).setValues([[
        nomeN || clean_(rows[i].nome),
        emailN,
        clean_(telefone) || clean_(rows[i].telefone),
        clean_(categoria) || clean_(rows[i].categoria) || 'publico',
        clean_(origem) || clean_(rows[i].origem) || 'sistema',
        new Date()
      ]]);
      return;
    }
  }

  appendRow_(SHEETS.PUBLICO, [
    nomeN, emailN, clean_(telefone),
    clean_(categoria) || 'publico',
    clean_(origem) || 'sistema',
    new Date()
  ]);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    return fn();
  } catch (err) {
    return fail_('Sistema ocupado. Tente novamente em instantes.', { error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function buildActivityId_(ev) {
  return [
    clean_(ev.day || '2026-03-10'),
    clean_(ev.start || '00:00').replace(':', ''),
    slug_(ev.stage || 'sem-palco').slice(0, 28),
    slug_(ev.titulo || 'atividade').slice(0, 52)
  ].join('__');
}

function buildActivityToken_(atividadeId) {
  var sig = Utilities.computeHmacSha256Signature(
    clean_(atividadeId),
    CONFIG.TOKEN_SECRET,
    Utilities.Charset.UTF_8
  );
  return bytesToHex_(sig).slice(0, 40);
}

function isEligibleActivity_(ev) {
  return !!(ev && clean_(ev.titulo) && safeType_(ev.tipo) !== 'CREDENCIAMENTO');
}

function safeType_(tipo) {
  return clean_(tipo) || 'ATIVIDADE';
}

function mapById_(rows, field) {
  var map = {};
  rows.forEach(function (r) {
    var id = clean_(r[field]);
    if (id) map[id] = r;
  });
  return map;
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    throw new Error('Body JSON inválido.');
  }
}

function ok_(obj) {
  obj = obj || {};
  obj.ok = true;
  obj.version = CONFIG.APP_VERSION;
  return obj;
}

function fail_(message, extra) {
  var out = { ok: false, message: message, version: CONFIG.APP_VERSION };
  if (extra) {
    Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
  }
  return out;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function clean_(str) {
  return String(str == null ? '' : str)
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function digits_(str) {
  return String(str == null ? '' : str).replace(/\D/g, '');
}

function normalize_(str) {
  return clean_(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function slug_(str) {
  return normalize_(str).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function isEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

function sha256_(txt) {
  return bytesToHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(txt || ''),
    Utilities.Charset.UTF_8
  ));
}

function bytesToHex_(bytes) {
  return bytes.map(function (b) {
    var h = (b & 0xFF).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('');
}

function hourFrom_(ts) {
  var d = ts instanceof Date ? ts : new Date(ts);
  return isNaN(d.getTime()) ? -1 : d.getHours();
}

// Utilitário opcional para gerar hash de senha de monitor no editor
function gerarHashSenha(senha) {
  Logger.log(sha256_(senha));
}
