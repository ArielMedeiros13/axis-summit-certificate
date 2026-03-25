/*
 * Module: Shared front-end utility layer for attendance and QR flows.
 * What it does: Normalizes strings, derives activity identifiers, formats schedule metadata, and extracts speaker records from schedule payloads.
 * Key design decisions: Keeps all deterministic ID and normalization logic in one place so admin QR generation and backend synchronization stay aligned.
 * System connections: Imported by `admin-qr.js` and `checkin-atividade.js`; mirrors the identifier logic used in `apps-script/axis-credenciamento.gs`.
 */

(function (window) {
  'use strict';

  function clean(str) {
    return String(str == null ? '' : str)
      .replace(/[<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function digits(str) {
    return String(str == null ? '' : str).replace(/\D/g, '');
  }

  function normalize(str) {
    return clean(str)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function slug(str) {
    var base = normalize(str).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base || 'item';
  }

  function safeType(tipo) {
    return clean(tipo) || 'ATIVIDADE';
  }

  function isEligibleActivity(evento) {
    if (!evento || !clean(evento.titulo)) return false;
    return safeType(evento.tipo) !== 'CREDENCIAMENTO';
  }

  function buildActivityId(evento) {
    var day = clean(evento.day || '2026-03-10');
    var start = clean(evento.start || '00:00').replace(':', '');
    var stage = slug(evento.stage || 'sem-palco').slice(0, 28);
    var title = slug(evento.titulo || 'atividade').slice(0, 52);
    return [day, start, stage, title].join('__');
  }

  function fmtDay(day) {
    if (day === '2026-03-10') return '10 de março';
    if (day === '2026-03-11') return '11 de março';
    return clean(day);
  }

  function fmtTime(start, end) {
    var s = clean(start);
    var e = clean(end);
    return e ? (s + '–' + e) : s;
  }

  function collectSpeakers(events) {
    var map = {};
    (events || []).forEach(function (ev) {
      if (ev && ev.mediator && clean(ev.mediator.name)) {
        var key = normalize(ev.mediator.name);
        if (!map[key]) map[key] = { nome: clean(ev.mediator.name), email: '', cpf: '', origem: 'programacao', credencial: 'speaker', ativo: true };
      }
      (ev && ev.participants || []).forEach(function (p) {
        if (!p || !clean(p.name)) return;
        var key = normalize(p.name);
        if (!map[key]) map[key] = { nome: clean(p.name), email: '', cpf: '', origem: 'programacao', credencial: 'speaker', ativo: true };
      });
    });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }

  window.AxisCommon = {
    clean: clean,
    digits: digits,
    normalize: normalize,
    slug: slug,
    safeType: safeType,
    isEligibleActivity: isEligibleActivity,
    buildActivityId: buildActivityId,
    fmtDay: fmtDay,
    fmtTime: fmtTime,
    collectSpeakers: collectSpeakers
  };
})(window);
