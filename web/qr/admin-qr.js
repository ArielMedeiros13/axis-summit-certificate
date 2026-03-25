/*
 * Module: QR admin panel controller.
 * What it does: Synchronizes schedule data into the operational backend, renders per-activity QR codes, and exports posters or direct links for event staff.
 * Key design decisions: Keeps schedule filtering client-side, derives activity IDs deterministically, and supports both individual and bulk poster export to reduce last-mile operations work.
 * System connections: Runs inside `admin-qr.html`, consumes `window.AXIS_EVENTS`, and depends on `AxisCommon` plus the credentialing Apps Script API.
 */

'use strict';
// ============================================================
// AXIS Summit 2026 — admin-qr.js
// Painel de gestão de QR codes por atividade.
// URL base do checkin: relativa ao servidor atual.
// Regra: nunca remover funções. Apenas adicionar/corrigir.
// ============================================================

// Filtra atividades elegíveis da programação estática
var eligibleEvents = (window.AXIS_EVENTS || []).filter(function (ev) {
  return AxisCommon.isEligibleActivity(ev);
});

var dom = {
  filtroDia:      document.getElementById('filtroDia'),
  filtroTipo:     document.getElementById('filtroTipo'),
  filtroPalco:    document.getElementById('filtroPalco'),
  filtroTexto:    document.getElementById('filtroTexto'),
  syncBtn:        document.getElementById('syncBtn'),
  copyVisibleBtn: document.getElementById('copyVisibleBtn'),
  downloadAllPostersBtn: document.getElementById('downloadAllPostersBtn'),
  summaryTitle:   document.getElementById('summaryTitle'),
  summaryHint:    document.getElementById('summaryHint'),
  globalFeedback: document.getElementById('globalFeedback'),
  grid:           document.getElementById('grid'),
  posterModal:    document.getElementById('posterModal'),
  posterCanvas:   document.getElementById('posterCanvas'),
  posterClose:    document.getElementById('posterClose'),
  posterDownload: document.getElementById('posterDownload')
};

var apiMap    = {}; // atividade_id → objeto da API
var countsMap = {}; // atividade_id → total de confirmações
var posterInfo = null; // info do poster atual no modal

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  syncBulkPosterButtonLabel();
  buildFilters();
  bindEvents();
  loadApiData();
});

function buildFilters() {
  unique(eligibleEvents.map(function (ev) { return AxisCommon.safeType(ev.tipo); }))
    .sort()
    .forEach(function (tipo) {
      dom.filtroTipo.insertAdjacentHTML('beforeend',
        '<option value="' + esc(tipo) + '">' + esc(tipo) + '</option>');
    });

  unique(eligibleEvents.map(function (ev) { return ev.stage || 'Sem palco'; }))
    .sort()
    .forEach(function (palco) {
      dom.filtroPalco.insertAdjacentHTML('beforeend',
        '<option value="' + esc(palco) + '">' + esc(palco) + '</option>');
    });
}

function bindEvents() {
  ['input', 'change'].forEach(function (evt) {
    dom.filtroDia.addEventListener(evt, render);
    dom.filtroTipo.addEventListener(evt, render);
    dom.filtroPalco.addEventListener(evt, render);
    dom.filtroTexto.addEventListener(evt, render);
  });
  dom.syncBtn.addEventListener('click', syncProgramacao);
  dom.copyVisibleBtn.addEventListener('click', copyVisibleLinks);
  if (dom.downloadAllPostersBtn) dom.downloadAllPostersBtn.addEventListener('click', downloadAllPosters);
  dom.posterClose.addEventListener('click', closePosterModal);
  dom.posterDownload.addEventListener('click', downloadPoster);
  dom.posterModal.addEventListener('click', function (e) {
    if (e.target === dom.posterModal) closePosterModal();
  });
}

// ── SINCRONIZAÇÃO ─────────────────────────────────────────────
async function syncProgramacao() {
  setBtn(dom.syncBtn, true, 'Sincronizando...');
  hideFeedback();
  try {
    var res = await AxisApi.call({
      action: 'sincronizarAtividades',
      events: eligibleEvents
    });
    if (!res.ok) throw new Error(res.message || 'Falha ao sincronizar.');
    showFeedback(
      '✓ Sincronizado: ' + (res.ativos || 0) + ' atividade(s) ativa(s) · ' +
      (res.speakers_total || 0) + ' speaker(s) registrado(s).',
      'success'
    );
    await loadApiData();
  } catch (err) {
    showFeedback(diagnosticarErro(err), 'error');
  } finally {
    setBtn(dom.syncBtn, false, 'Sincronizar');
  }
}

function syncBulkPosterButtonLabel() {
  if (!dom.downloadAllPostersBtn) return;
  dom.downloadAllPostersBtn.textContent = window.JSZip
    ? 'Baixar pôsteres (.zip)'
    : 'Baixar pôsteres';
}

// ── CARREGAR DADOS DA API ─────────────────────────────────────
async function loadApiData() {
  apiMap    = {};
  countsMap = {};
  dom.summaryTitle.textContent = 'Consultando API...';
  dom.summaryHint.textContent  = '';

  try {
    var list = await AxisApi.call({ action: 'listarAtividadesQr' });

    if (!list.ok) {
      throw new Error(
        'listarAtividadesQr falhou: ' + (list.message || JSON.stringify(list))
      );
    }

    var atividades = list.atividades || [];

    if (!atividades.length) {
      showFeedback(
        'Nenhuma atividade com token encontrada na API. Clique em "Sincronizar" para registrá-las.',
        'info'
      );
    }

    atividades.forEach(function (item) {
      apiMap[item.atividade_id] = item;
    });

    var counts = await AxisApi.call({ action: 'statsAtividadeLote' });
    if (counts.ok) countsMap = counts.mapa || {};

  } catch (err) {
    showFeedback(diagnosticarErro(err), 'error');
  }

  render();
}

// ── FILTRO ────────────────────────────────────────────────────
function getFiltered() {
  var q = AxisCommon.normalize(dom.filtroTexto.value);
  return eligibleEvents.filter(function (ev) {
    if (dom.filtroDia.value    && ev.day !== dom.filtroDia.value) return false;
    if (dom.filtroTipo.value   && AxisCommon.safeType(ev.tipo) !== dom.filtroTipo.value) return false;
    if (dom.filtroPalco.value  && (ev.stage || 'Sem palco') !== dom.filtroPalco.value) return false;
    if (q && AxisCommon.normalize(ev.titulo).indexOf(q) === -1) return false;
    return true;
  });
}

// ── RENDER ────────────────────────────────────────────────────
function render() {
  var list = getFiltered();
  dom.grid.innerHTML = '';

  var comToken = 0, semSync = 0;
  list.forEach(function (ev) {
    var id      = AxisCommon.buildActivityId(ev);
    var apiItem = apiMap[id] || null;
    if (!apiItem)           semSync++;
    else if (apiItem.token) comToken++;
  });

  dom.summaryTitle.textContent = list.length + ' atividade(s) elegível(is)';
  dom.summaryHint.textContent  =
    comToken + ' com token válido · ' + semSync + ' ainda não sincronizada(s)';

  list.forEach(function (ev) {
    var id           = AxisCommon.buildActivityId(ev);
    var apiItem      = apiMap[id] || null;
    var token        = apiItem && apiItem.token ? apiItem.token : '';
    var url          = token ? buildCheckinUrl(id, token) : '';
    var confirmacoes = countsMap[id] || 0;

    var article = document.createElement('article');
    article.className = 'act-card';

    article.innerHTML =
      '<div class="act-head">' +
        '<img src="../assets/axis-mark-placeholder.svg" alt="AXIS" />' +
        '<span class="act-badge">' + esc(AxisCommon.safeType(ev.tipo)) + '</span>' +
      '</div>' +
      '<div class="act-body">' +
        '<h3 class="act-title">' + esc(ev.titulo) + '</h3>' +
        '<div class="act-meta">' +
          '<span class="chip">' + esc(AxisCommon.fmtDay(ev.day)) + '</span>' +
          '<span class="chip">' + esc(AxisCommon.fmtTime(ev.start, ev.end)) + '</span>' +
          '<span class="chip">' + esc(ev.stage || 'Sem palco') + '</span>' +
        '</div>' +
        '<div class="act-status">' + buildStatus(apiItem, token) + '</div>' +
        '<div class="qr-panel">' +
          '<div class="qr-box" id="qrbox_' + escAttr(id) + '">' +
            (url ? '' : '<span class="qr-placeholder">Sincronize para gerar o QR</span>') +
          '</div>' +
          '<div class="qr-stack">' +
            '<div class="url-box" id="urlbox_' + escAttr(id) + '">' +
              (url ? esc(url) : '— Sincronize para obter o link.') +
            '</div>' +
            '<div class="counter">' +
              '<span>Confirmações</span><strong>' + confirmacoes + '</strong>' +
            '</div>' +
            '<div class="act-actions">' +
              '<button class="btn btn-ghost" data-copy="' + escAttr(url) + '">Copiar link</button>' +
              '<button class="btn btn-ghost" data-open="' + escAttr(url) + '">Abrir</button>' +
              '<button class="btn btn-primary" data-poster="' + escAttr(id) + '"' +
                ' data-titulo="' + escAttr(ev.titulo) + '"' +
                ' data-dia="' + escAttr(AxisCommon.fmtDay(ev.day)) + '"' +
                ' data-horario="' + escAttr(AxisCommon.fmtTime(ev.start, ev.end)) + '"' +
                ' data-palco="' + escAttr(ev.stage || 'Sem palco') + '"' +
                ' data-tipo="' + escAttr(AxisCommon.safeType(ev.tipo)) + '"' +
                ' data-url="' + escAttr(url) + '"' +
              '>Poster AXIS</button>' +
              '<button class="btn btn-ghost" data-download="' + escAttr(id) + '">Baixar QR</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    dom.grid.appendChild(article);

    if (url) drawQr(id, url);
  });

  // Bind botões
  dom.grid.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () { copyText(btn.getAttribute('data-copy')); });
  });
  dom.grid.querySelectorAll('[data-open]').forEach(function (btn) {
    btn.addEventListener('click', function () { openTarget(btn.getAttribute('data-open')); });
  });
  dom.grid.querySelectorAll('[data-download]').forEach(function (btn) {
    btn.addEventListener('click', function () { downloadQr(btn.getAttribute('data-download')); });
  });
  dom.grid.querySelectorAll('[data-poster]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      openPosterModal({
        id:      btn.getAttribute('data-poster'),
        titulo:  btn.getAttribute('data-titulo'),
        dia:     btn.getAttribute('data-dia'),
        horario: btn.getAttribute('data-horario'),
        palco:   btn.getAttribute('data-palco'),
        tipo:    btn.getAttribute('data-tipo'),
        url:     btn.getAttribute('data-url')
      });
    });
  });
}

// ── STATUS ────────────────────────────────────────────────────
function buildStatus(apiItem, token) {
  if (!apiItem)  return '<span class="s-warn">⚠ Não sincronizada — clique em Sincronizar</span>';
  if (!token)    return '<span class="s-err">✗ Sem token — execute Sincronizar novamente</span>';
  return '<span class="s-ok">✓ Token válido disponível</span>';
}

// ── QR CODE ───────────────────────────────────────────────────
function drawQr(id, url) {
  var holder = document.getElementById('qrbox_' + id);
  if (!holder) return;
  holder.innerHTML = '';
  try {
    new QRCode(holder, {
      text:         url,
      width:        136,
      height:       136,
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch (e) {
    holder.innerHTML = '<span class="qr-placeholder">Erro ao gerar QR</span>';
  }
}

// ── URL DE CHECK-IN ───────────────────────────────────────────
// Usa URL relativa para ser agnóstico ao domínio
function buildCheckinUrl(id, token) {
  var base = window.location.href.replace(/[^\/]*$/, '');
  return base + 'checkin-atividade.html?id=' + encodeURIComponent(id) + '&token=' + encodeURIComponent(token);
}

// ── POSTER AXIS (Canvas) ──────────────────────────────────────
function openPosterModal(info) {
  posterInfo = info;
  dom.posterModal.classList.remove('hidden');
  renderPoster(info);
}

function closePosterModal() {
  dom.posterModal.classList.add('hidden');
  posterInfo = null;
}

async function downloadPoster() {
  if (!posterInfo) return;
  dom.posterDownload.disabled = true;
  dom.posterDownload.textContent = 'Gerando PNG...';
  try {
    await renderPosterToCanvas(posterInfo, dom.posterCanvas);
    triggerDownload(
      dom.posterCanvas.toDataURL('image/png'),
      'poster-axis-' + AxisCommon.slug(posterInfo.titulo).slice(0, 48) + '.png'
    );
  } catch (err) {
    showFeedback('Não foi possível gerar o pôster para download.', 'error');
  } finally {
    dom.posterDownload.disabled = false;
    dom.posterDownload.textContent = '⬇ Baixar imagem PNG';
  }
}

function renderPoster(info) {
  return renderPosterToCanvas(info, dom.posterCanvas);
}

async function renderPosterToCanvas(info, canvas) {
  var ctx = canvas.getContext('2d');
  var W = 700, H = 1020;
  canvas.width = W; canvas.height = H;

  var bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0b1020');
  bg.addColorStop(.55, '#0a1120');
  bg.addColorStop(1, '#060a14');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  var orangeGlow = ctx.createRadialGradient(W * .88, 24, 0, W * .88, 24, 520);
  orangeGlow.addColorStop(0, 'rgba(244,124,32,.30)');
  orangeGlow.addColorStop(.35, 'rgba(244,124,32,.10)');
  orangeGlow.addColorStop(1, 'transparent');
  ctx.fillStyle = orangeGlow;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#ffffff';
  fillArcRibbon(ctx, W * .95, H * .28, 560, 74, -1.10, 1.04);
  ctx.globalAlpha = 0.08;
  fillArcRibbon(ctx, W * .92, H * .28, 640, 96, -1.10, 1.06);
  ctx.restore();

  ctx.strokeStyle = 'rgba(244,124,32,.55)';
  ctx.lineWidth = 2.5;
  roundRect(ctx, 18, 18, W - 36, H - 36, 26);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  roundRect(ctx, 30, 30, W - 60, H - 60, 22);
  ctx.stroke();

  ctx.fillStyle = '#f47c20';
  ctx.font = '800 56px Syne, Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('AXIS', 54, 92);

  ctx.fillStyle = 'rgba(255,255,255,.38)';
  ctx.font = '600 18px DM Sans, Arial, sans-serif';
  ctx.fillText('Summit de Inovação Sustentável das Artes', 54, 120);

  ctx.strokeStyle = 'rgba(244,124,32,.22)';
  ctx.beginPath();
  ctx.moveTo(54, 144);
  ctx.lineTo(W - 54, 144);
  ctx.stroke();

  drawBadge(ctx, 54, 160, 190, 38, (info.tipo || 'ATIVIDADE').toUpperCase());

  ctx.fillStyle = '#f4f6fb';
  ctx.font = '800 28px Syne, Arial, sans-serif';
  ctx.textAlign = 'left';
  var titleLines = wrapText(ctx, String(info.titulo || ''), W - 108, '800 28px Syne, Arial, sans-serif');
  var titleY = 228;
  titleLines.slice(0, 3).forEach(function(line) {
    ctx.fillText(line, 54, titleY);
    titleY += 38;
  });

  var metaY = Math.max(titleY + 28, 356);
  drawMetaRow(ctx, '📅', info.dia, 54, metaY);
  drawMetaRow(ctx, '🕐', info.horario, 54, metaY + 52);
  drawMetaRow(ctx, '📍', info.palco, 54, metaY + 104);

  var qrSize = 286;
  var qrX = Math.round((W - qrSize) / 2);
  var qrY = metaY + 180;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, qrX - 18, qrY - 18, qrSize + 36, qrSize + 36, 24);
  ctx.fill();
  ctx.restore();

  if (info.url) {
    try {
      var qrSource = await createQrSource(info.url, qrSize);
      if (qrSource) ctx.drawImage(qrSource, qrX, qrY, qrSize, qrSize);
    } catch (_) {}
  }

  if (!info.url) {
    ctx.fillStyle = '#7c849f';
    ctx.font = '600 15px DM Sans, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('QR indisponível. Sincronize a atividade primeiro.', W / 2, qrY + qrSize / 2 + 8);
  }

  drawPosterFooter(ctx, W, H, info);
  return canvas;
}

function drawPosterFooter(ctx, W, H, info) {
  ctx.fillStyle = 'rgba(255,255,255,.50)';
  ctx.font = '600 15px DM Sans, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Aponte a câmera do celular para o QR e confirme sua presença', W / 2, H - 100);

  ctx.fillStyle = 'rgba(255,255,255,.18)';
  roundRect(ctx, 138, H - 82, W - 276, 34, 999);
  ctx.fill();

  ctx.fillStyle = '#f3a55f';
  ctx.font = '800 13px Syne, Arial, sans-serif';
  ctx.fillText('portfolio.example  •  10 and 11 March 2026  •  Porto Alegre', W / 2, H - 60);

  ctx.fillStyle = 'rgba(255,255,255,.28)';
  ctx.font = '500 12px DM Sans, Arial, sans-serif';
  ctx.fillText('Poster gerado automaticamente para ' + String(info.titulo || 'atividade'), W / 2, H - 26);
}
// ── UTILITÁRIOS CANVAS ────────────────────────────────────────
function drawBadge(ctx, x, y, w, h, text) {
  ctx.fillStyle = 'rgba(244,124,32,.14)';
  roundRect(ctx, x, y, w, h, 999);
  ctx.fill();
  ctx.strokeStyle = 'rgba(244,124,32,.30)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 999);
  ctx.stroke();
  ctx.fillStyle = '#ffd2a6';
  ctx.font = '800 13px Syne, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, x + w / 2, y + 24);
}

function drawMetaRow(ctx, icon, text, x, y) {
  var label = icon + '  ' + String(text || '—');
  ctx.font = '600 16px DM Sans, Arial, sans-serif';
  var w = Math.min(420, Math.max(180, ctx.measureText(label).width + 30));
  ctx.fillStyle = 'rgba(255,255,255,.07)';
  roundRect(ctx, x, y - 22, w, 36, 999);
  ctx.fill();
  ctx.fillStyle = '#aeb8d3';
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 14, y + 2);
}

function fillArcRibbon(ctx, cx, cy, r, thickness, startAngle, endAngle) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle, false);
  ctx.arc(cx, cy, Math.max(0, r - thickness), endAngle, startAngle, true);
  ctx.closePath();
  ctx.fill();
}

function createQrSource(url, size) {
  return new Promise(function(resolve, reject) {
    var tempDiv = document.createElement('div');
    tempDiv.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:' + size + 'px;height:' + size + 'px;';
    document.body.appendChild(tempDiv);
    try {
      new QRCode(tempDiv, { text: url, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
      setTimeout(function() {
        try {
          var qrCanvas = tempDiv.querySelector('canvas');
          var qrImg = tempDiv.querySelector('img');
          if (qrCanvas) {
            document.body.removeChild(tempDiv);
            return resolve(qrCanvas);
          }
          if (qrImg && qrImg.src) {
            var img = new Image();
            img.onload = function() {
              try { document.body.removeChild(tempDiv); } catch (_) {}
              resolve(img);
            };
            img.onerror = function(err) {
              try { document.body.removeChild(tempDiv); } catch (_) {}
              reject(err || new Error('Falha ao carregar QR.'));
            };
            img.src = qrImg.src;
            return;
          }
          try { document.body.removeChild(tempDiv); } catch (_) {}
          reject(new Error('QR não gerado.'));
        } catch (err) {
          try { document.body.removeChild(tempDiv); } catch (_) {}
          reject(err);
        }
      }, 280);
    } catch (err) {
      try { document.body.removeChild(tempDiv); } catch (_) {}
      reject(err);
    }
  });
}

function wrapText(ctx, text, maxWidth, font) {
  ctx.font    = font;
  var words   = text.split(' ');
  var lines   = [], current = '';
  words.forEach(function (word) {
    var test = current ? current + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current); current = word;
    } else { current = test; }
  });
  if (current) lines.push(current);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── DOWNLOAD QR BRUTO ─────────────────────────────────────────
function downloadQr(id) {
  var holder = document.getElementById('qrbox_' + id);
  if (!holder) return showFeedback('QR não encontrado.', 'error');
  var canvas = holder.querySelector('canvas');
  var img    = holder.querySelector('img');
  var href   = '';
  if (canvas)   href = canvas.toDataURL('image/png');
  else if (img) href = img.src;
  if (!href) return showFeedback('QR sem imagem disponível. Verifique se o token existe.', 'error');
  var a       = document.createElement('a');
  a.href      = href;
  a.download  = 'qr_axis_' + id.slice(0, 50) + '.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function downloadAllPosters() {
  var cards = Array.from(dom.grid.querySelectorAll('[data-poster]')).map(function(btn) {
    return {
      id: btn.getAttribute('data-poster'),
      titulo: btn.getAttribute('data-titulo'),
      dia: btn.getAttribute('data-dia'),
      horario: btn.getAttribute('data-horario'),
      palco: btn.getAttribute('data-palco'),
      tipo: btn.getAttribute('data-tipo'),
      url: btn.getAttribute('data-url')
    };
  }).filter(function(item) { return !!item.url; });

  if (!cards.length) {
    return showFeedback('Nenhum pôster disponível para baixar. Sincronize as atividades primeiro.', 'error');
  }

  var btn = dom.downloadAllPostersBtn;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Gerando .zip...';
  }

  try {
    if (window.JSZip) {
      var zip = new JSZip();
      var offCanvas = document.createElement('canvas');
      for (var i = 0; i < cards.length; i++) {
        if (btn) btn.textContent = 'Gerando ' + (i + 1) + '/' + cards.length + '...';
        await renderPosterToCanvas(cards[i], offCanvas);
        var dataUrl = offCanvas.toDataURL('image/png');
        zip.file(
          String(i + 1).padStart(2, '0') + '-' + AxisCommon.slug(cards[i].titulo).slice(0, 54) + '.png',
          dataUrl.split(',')[1],
          { base64: true }
        );
      }
      var blob = await zip.generateAsync({ type: 'blob' });
      var blobUrl = URL.createObjectURL(blob);
      triggerDownload(blobUrl, 'posters-axis-' + cards.length + '.zip', true);
      showFeedback('✓ Arquivo .zip com ' + cards.length + ' pôster(es) gerado com sucesso.', 'success');
    } else {
      for (var j = 0; j < cards.length; j++) {
        if (btn) btn.textContent = 'Baixando ' + (j + 1) + '/' + cards.length + '...';
        await renderPosterToCanvas(cards[j], dom.posterCanvas);
        triggerDownload(dom.posterCanvas.toDataURL('image/png'), 'poster-axis-' + AxisCommon.slug(cards[j].titulo).slice(0, 48) + '.png');
        await delay(180);
      }
      showFeedback('Baixei os pôsteres em sequência. Se o navegador bloquear pop-ups, tente novamente.', 'success');
    }
  } catch (err) {
    showFeedback('Não foi possível gerar o pacote de pôsteres. Tente novamente.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      syncBulkPosterButtonLabel();
    }
    if (posterInfo) renderPoster(posterInfo);
  }
}

function triggerDownload(href, filename, revoke) {
  var a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(function() { URL.revokeObjectURL(href); }, 800);
}

function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ── COPY / OPEN ───────────────────────────────────────────────
function copyVisibleLinks() {
  var links = Array.from(dom.grid.querySelectorAll('.url-box'))
    .map(function (el) { return el.textContent.trim(); })
    .filter(function (t) { return t.indexOf('http') === 0; });
  if (!links.length) return showFeedback('Nenhum link disponível para copiar. Sincronize primeiro.', 'error');
  copyText(links.join('\n'));
}

function copyText(text) {
  if (!text || text.indexOf('http') !== 0)
    return showFeedback('Link indisponível para cópia.', 'error');
  navigator.clipboard.writeText(text)
    .then(function ()  { showFeedback('✓ Link(s) copiado(s).', 'success'); })
    .catch(function () { showFeedback('Não foi possível copiar. Tente manualmente.', 'error'); });
}

function openTarget(url) {
  if (!url || url.indexOf('http') !== 0)
    return showFeedback('Link inválido ou indisponível. Sincronize primeiro.', 'error');
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ── DIAGNÓSTICO DE ERROS ──────────────────────────────────────
function diagnosticarErro(err) {
  var msg = String(err && err.message ? err.message : err);
  if (msg.indexOf('JSON') !== -1 || msg.indexOf('HTML') !== -1)
    return 'A API retornou resposta inválida (possível HTML de erro). ' +
           'Verifique se o deploy está atualizado e publicado como "Qualquer pessoa, incluindo anônimos".';
  if (msg.indexOf('Action desconhecida') !== -1)
    return 'Action não reconhecida pelo backend. O .gs do Apps Script precisa ser atualizado e reimplantado.';
  if (msg.indexOf('excedido') !== -1 || msg.indexOf('Abort') !== -1)
    return 'Tempo de resposta excedido. Internet instável — tente novamente em alguns segundos.';
  if (msg.indexOf('ocupado') !== -1)
    return 'Sistema ocupado (lock de concorrência). Aguarde 5 segundos e tente novamente.';
  return msg || 'Erro desconhecido. Abra o console do navegador para detalhes.';
}

// ── HELPERS ───────────────────────────────────────────────────
function showFeedback(msg, type) {
  dom.globalFeedback.textContent = msg;
  dom.globalFeedback.className   = 'feedback ' + (type || 'error');
}
function hideFeedback() {
  dom.globalFeedback.textContent = '';
  dom.globalFeedback.className   = 'feedback hidden';
}
function setBtn(btn, loading, label) {
  btn.disabled    = loading;
  btn.textContent = label;
}
function unique(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}
function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(text) {
  return esc(text).replace(/'/g,'&#39;');
}
