/*
 * Module: Shared credentialing API client.
 * What it does: Wraps the monitor, QR, and attendance frontend calls to the Apps Script credentialing backend.
 * Key design decisions: Uses a single POST transport, aggressive timeout handling, and explicit JSON validation so operational screens fail loudly instead of silently degrading.
 * System connections: Imported by the monitor portal, QR admin panel, and public activity check-in flow; targets `apps-script/axis-credenciamento.gs`.
 */

(function (window) {
  'use strict';

  // URL CORRETA do Web App — atualizar aqui sempre que reimplantar
  var CONFIG = {
    API_URL: 'https://script.google.com/macros/s/YOUR_CREDENTIALING_WEB_APP_ID/exec',
    VERSION: '2026.03.09.1313'
  };

  async function callApi(payload, options) {
    options = options || {};
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, options.timeout || 18000);

    try {
      var response = await fetch(CONFIG.API_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body:    JSON.stringify(payload || {}),
        signal:  controller.signal,
        cache:   'no-store'
      });

      var text = await response.text();
      var data = null;

      try {
        data = JSON.parse(text);
      } catch (_) {
        // Diagnóstico útil: exibe os primeiros 300 chars do retorno no erro
        var preview = text.slice(0, 300).replace(/</g,'<').replace(/>/g,'>');
        throw new Error(
          'A API não devolveu JSON válido. ' +
          'Verifique se o deploy está atualizado e publicado como "Qualquer pessoa".\n' +
          'Conteúdo recebido: ' + preview
        );
      }

      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Tempo de resposta excedido. Internet instável, API lenta ou Web App indisponível.');
      }
      var raw = String(err && err.message ? err.message : err || '');
      if (err instanceof TypeError || /Failed to fetch/i.test(raw)) {
        throw new Error(
          'Não foi possível alcançar a API do AXIS. Verifique: 1) se o novo deploy foi publicado como App da Web, 2) se o acesso está em "Qualquer pessoa, incluindo anônimos", 3) se o arquivo axis-api.js atualizado foi enviado ao servidor e 4) se o navegador não está usando cache antigo.'
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  function setApiUrl(url) {
    CONFIG.API_URL = String(url || '').trim();
  }

  window.AxisApi = {
    call:      callApi,
    setApiUrl: setApiUrl,
    config:    CONFIG
  };

})(window);
