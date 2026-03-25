/*
 * Module: Certificate issuer and PDF renderer.
 * What it does: Calls the certificate backend, resolves special-case issuance states, renders certificate previews, generates validation QR codes, and exports the final PDF.
 * Key design decisions: Keeps identity confirmation and certificate-type selection in the browser, escapes all returned content before rendering, and mirrors the final on-screen layout into the PDF export path.
 * System connections: Runs in `certificados.html`, calls `apps-script/axis-certificados.gs`, and links every issued certificate to `certificados-validator-v3.html`.
 */

/* ============================================================
   AXIS Summit 2026 — Sistema de Certificados
   certificados-v3.js — v2026.03.17.v11

   ENDPOINT: YOUR_CERTIFICATES_WEB_APP_ID

   MUDANÇAS v11:
   - Barra de logos institucional adicionada: preview HTML + PDF via addImage/clip.
   - Suporte a certificateType === 'speaker': texto, badge e metas condicionais.
   - PDF: title label, body copy e meta strip variam por tipo.
   - _loadImage helper carrega imagem como base64 para uso no jsPDF.
   - MAIN_H reduzido de 148→140 para acomodar rodapé de logos (35mm).

   SEGURANÇA v10 (mantida):
   - Honeypot: campo _trap enviado junto ao payload; backend rejeita se preenchido.
   - CPF continua no certificado final (PDF + preview). Nunca exposto na validação pública.
   - Todos os dados da API são escapados antes de qualquer innerHTML.
   - `buildCertificateResponse_` do backend não retorna mais emailNormalized nem
     campos internos. O frontend não tenta exibir e-mail na tela.
   - SRI não é adicionável via JS — instruções no HTML de deploy.

   BUGS CORRIGIDOS v8–v9 (mantidos):
   - CPF não aparecia mesmo com backend devolvendo valor (porém inválido)
   - Endpoint atualizado para deploy de produção v7 do backend.
   ============================================================ */

'use strict';

var AXIS_CERT_API_URL = (function () {
  var fromGlobal = typeof window !== 'undefined' && window.AXIS_CERT_API_URL_OVERRIDE;
  if (fromGlobal) return fromGlobal;
  return 'https://script.google.com/macros/s/YOUR_CERTIFICATES_WEB_APP_ID/exec';
}());

var AXIS_CERT_VALIDATOR_URL = (function () {
  var fromGlobal = typeof window !== 'undefined' && window.AXIS_CERT_VALIDATOR_URL_OVERRIDE;
  if (fromGlobal) return fromGlobal;
  return './certificados-validator-v3.html';
}());

/* ============================================================
   API CLIENT
   ============================================================ */

class AxisCertificatesAPI {
  constructor(baseUrl) {
    this.baseUrl = baseUrl || AXIS_CERT_API_URL;
  }

  async _post(action, payload) {
    // Honeypot: campo _trap sempre vazio em requests legítimos.
    // Bots que preenchem campos hidden são rejeitados pelo backend.
    const safePayload = Object.assign({ _trap: '' }, payload || {});
    const body = JSON.stringify({ action, payload: safePayload });
    let response;
    try {
      response = await fetch(this.baseUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'text/plain' },
        body
      });
    } catch (networkErr) {
      throw new Error('Falha de conexão com o servidor. Verifique sua internet e tente novamente. (' + networkErr.message + ')');
    }
    let text;
    try { text = await response.text(); }
    catch (e) { throw new Error('Erro ao ler resposta do servidor: ' + e.message); }
    let data;
    try { data = JSON.parse(text); }
    catch (_) {
      console.error('[AXIS CERT] Resposta não-JSON:', text.substring(0, 300));
      throw new Error('Resposta inválida do servidor. Tente novamente em instantes.');
    }
    return data;
  }

  emitirCertificado(payload)             { return this._post('emitirCertificado',             payload); }
  validarCertificado(payload)            { return this._post('validarCertificado',            typeof payload === 'string' ? { validationCode: payload } : payload); }
  buscarCertificado(payload)             { return this._post('buscarCertificado',             payload); }
  reemitirCertificado(payload)           { return this._post('reemitirCertificado',           payload); }
  solicitarAvaliacaoCertificado(payload) { return this._post('solicitarAvaliacaoCertificado', payload); }
  healthcheck()                          { return this._post('healthcheck', {}); }
}

window.AxisCertificatesAPI = AxisCertificatesAPI;

/* ============================================================
   HELPERS
   ============================================================ */

function _fmtCpf(cpf) {
  const d = String(cpf || '').replace(/\D/g, '');
  if (d.length !== 11) return '';
  return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

function _safeName(value) {
  const v = String(value || '').trim();
  return /^\d+$/.test(v) ? '' : v;
}

function _safeDiasLabel(cert) {
  const candidates = [cert.diasLabel, cert.eventDateLabel, '10 e 11 de março de 2026'];
  for (const c of candidates) {
    if (c && /março/i.test(c)) return c;
  }
  return '10 e 11 de março de 2026';
}

/**
 * _properCase: capitaliza cada palavra se o nome estiver todo em minúsculas.
 * Preserva a caixa original quando o nome já contiver letras maiúsculas.
 */
function _properCase(str) {
  const s = String(str || '').trim();
  if (!s) return s;
  if (/[A-ZÁÀÃÂÉÈÊÍÌÎÓÒÕÔÚÙÛÇ]/.test(s)) return s;
  return s.replace(/(?:^|\s)\S/g, c => c.toUpperCase());
}

/**
 * _preferFormName: retorna true quando o nome do formulário é mais
 * completo que o retorno do backend.
 */
function _preferFormName(backendName, formName) {
  if (!formName || !String(formName).trim()) return false;
  const b = String(backendName || '').trim().toLowerCase();
  const f = String(formName).trim().toLowerCase();
  if (!b) return true;
  const bWords = b.split(/\s+/).length;
  const fWords = f.split(/\s+/).length;
  if (fWords > bWords) return true;
  if (f.startsWith(b) && b !== f) return true;
  return false;
}

function _resolveLogosBarAsset() {
  if (typeof window !== 'undefined' && window.AXIS_LOGOS_BAR_URL) return window.AXIS_LOGOS_BAR_URL;
  try {
    return new URL('../assets/logos-strip-placeholder.svg', window.location.href).href;
  } catch (_) {
    return '../assets/logos-strip-placeholder.svg';
  }
}

function _normalizeValidationCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 16);
}

function _isValidationCodeFormat(value) {
  return /^AXIS-[A-F0-9]{7}-[A-F0-9]{3}$/.test(_normalizeValidationCode(value));
}

function _safeUrlPrefill(value, maxLen) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen || 160);
}

function _buildValidationUrl(validationCode) {
  const normalizedCode = _normalizeValidationCode(validationCode);
  if (!normalizedCode) {
    throw new Error('Código de validação ausente no certificado.');
  }
  if (!_isValidationCodeFormat(normalizedCode)) {
    throw new Error('Código de validação inválido no certificado.');
  }
  return AXIS_CERT_VALIDATOR_URL + '?code=' + encodeURIComponent(normalizedCode);
}

function _normalizeCertificateType(type) {
  const raw = String(type || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'participant' || raw === 'public' || raw === 'publico' || raw === 'publico_geral') return 'publico_geral';
  return raw;
}

function _normalizeCertificatePayload(response) {
  const cert = Object.assign({}, response || {}, (response && response.certificate) || {});
  const hasSpeakerFields = !!(
    cert.participantRole ||
    cert.participantRoleLabel ||
    cert.participantJobTitle ||
    cert.panelName
  );

  if (!cert.certificateType && hasSpeakerFields) {
    cert.certificateType = 'speaker';
  }

  cert.certificateType = _normalizeCertificateType(cert.certificateType) || (hasSpeakerFields ? 'speaker' : 'publico_geral');

  cert.validationCode = _normalizeValidationCode(
    cert.validationCode || cert.validation_code || cert.code || ''
  );

  return cert;
}

function _getCertificateKindInfo(cert) {
  const type = _normalizeCertificateType((cert && cert.certificateType) || 'publico_geral') || 'publico_geral';
  const isSpeaker = type === 'speaker';
  const isRodada = type === 'rodada_negocios';
  const isAtelie = type === 'atelie';
  const specialLabel = isRodada
    ? String(cert.specialLabel || cert.activityLabel || 'Rodada de Negócios').trim()
    : isAtelie
      ? String(cert.specialLabel || cert.activityLabel || 'Ateliê').trim()
      : '';
  const projectName = String((cert && cert.projectName) || '').trim();

  return {
    type,
    isSpeaker,
    isRodada,
    isAtelie,
    specialLabel,
    projectName,
    badgeLabel: isSpeaker
      ? 'Certificado de Palestrante'
      : isRodada
        ? 'Certificado de Rodada de Negócios'
        : isAtelie
          ? 'Certificado de Ateliê'
          : 'Certificado de Participação',
    titleLabel: isSpeaker
      ? 'CERTIFICADO DE PALESTRANTE'
      : isRodada
        ? 'CERTIFICADO DE RODADA DE NEGÓCIOS'
        : isAtelie
          ? 'CERTIFICADO DE ATELIÊ'
          : 'CERTIFICADO DE PARTICIPAÇÃO',
    verticalLabel: isSpeaker
      ? 'AXIS SUMMIT · CERTIFICADO DE PALESTRANTE 2026'
      : isRodada
        ? 'AXIS SUMMIT · CERTIFICADO DE RODADA DE NEGÓCIOS 2026'
        : isAtelie
          ? 'AXIS SUMMIT · CERTIFICADO DE ATELIÊ 2026'
          : 'AXIS SUMMIT · CERTIFICADO OFICIAL 2026'
  };
}

/* ============================================================
   PDF GENERATOR — AXIS Summit 2026
   Estratégia: html2canvas captura o .cert-poster já renderizado
   na tela (preview) e o insere no PDF — fidelidade pixel-perfect
   ao preview, barra de logos incluída.
   Fallback vetorial usado apenas se html2canvas não estiver disponível.
   ============================================================ */

class AxisCertificatePDF {

  static get PX_TO_MM() {
    return 25.4 / 96;
  }

  static _loadImage(url) {
    // Tenta via fetch com CORS explícito, depois Image+canvas como fallback.
    return new Promise(resolve => {
      fetch(url, { mode: 'cors', credentials: 'omit' })
        .then(r => r.ok ? r.blob() : Promise.reject('not-ok'))
        .then(blob => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        })
        .catch(() => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width  = img.naturalWidth  || img.width;
              canvas.height = img.naturalHeight || img.height;
              canvas.getContext('2d').drawImage(img, 0, 0);
              resolve(canvas.toDataURL('image/png'));
            } catch(_) { resolve(null); }
          };
          img.onerror = () => resolve(null);
          img.src = url;
        });
    });
  }

  static _trimTransparentDataURL(dataURL, padding = 0) {
    return new Promise(resolve => {
      if (!dataURL) { resolve(null); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const srcCanvas = document.createElement('canvas');
          const srcW = img.naturalWidth || img.width;
          const srcH = img.naturalHeight || img.height;
          srcCanvas.width = srcW;
          srcCanvas.height = srcH;
          const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
          if (!srcCtx) { resolve(null); return; }
          srcCtx.drawImage(img, 0, 0);

          const pixels = srcCtx.getImageData(0, 0, srcW, srcH).data;
          let minX = srcW;
          let minY = srcH;
          let maxX = -1;
          let maxY = -1;

          for (let y = 0; y < srcH; y += 1) {
            for (let x = 0; x < srcW; x += 1) {
              const alpha = pixels[(y * srcW + x) * 4 + 3];
              if (alpha <= 10) continue;
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }

          if (maxX < 0 || maxY < 0) {
            resolve({ dataURL, width: srcW, height: srcH });
            return;
          }

          minX = Math.max(0, minX - padding);
          minY = Math.max(0, minY - padding);
          maxX = Math.min(srcW - 1, maxX + padding);
          maxY = Math.min(srcH - 1, maxY + padding);

          const cropW = Math.max(1, maxX - minX + 1);
          const cropH = Math.max(1, maxY - minY + 1);
          const cropCanvas = document.createElement('canvas');
          cropCanvas.width = cropW;
          cropCanvas.height = cropH;
          const cropCtx = cropCanvas.getContext('2d');
          if (!cropCtx) { resolve(null); return; }
          cropCtx.drawImage(srcCanvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
          resolve({ dataURL: cropCanvas.toDataURL('image/png'), width: cropW, height: cropH });
        } catch (_) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = dataURL;
    });
  }

  static _makeQR(url) {
    return new Promise(resolve => {
      try {
        const qrValue = String(url || '').trim();
        if (!qrValue) { resolve(null); return; }
        if (typeof QRCode === 'undefined') { resolve(null); return; }
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:400px;height:400px;';
        document.body.appendChild(host);
        new QRCode(host, { text: qrValue, width: 400, height: 400, colorDark: '#0e0e10', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H });
        setTimeout(() => {
          const canvas = host.querySelector('canvas');
          const img    = host.querySelector('img');
          let src = null;
          if (canvas) { src = canvas.toDataURL('image/png'); }
          else if (img && img.src && img.src.startsWith('data:')) { src = img.src; }
          else if (img && img.src) {
            try { const oc=document.createElement('canvas'); oc.width=400; oc.height=400; oc.getContext('2d').drawImage(img,0,0,400,400); src=oc.toDataURL('image/png'); } catch(_){}
          }
          document.body.removeChild(host);
          resolve(src);
        }, 300);
      } catch(e) { resolve(null); }
    });
  }

  /**
   * _capturePreview
   * Captura o .cert-poster do DOM com html2canvas.
   * 
   * ESTRATÉGIA DE DIMENSÕES:
   * 1. Aplica classe --capturing (largura fixa 620px, padding fixo 2.2rem)
   * 2. Mede scrollHeight do poster APÓS repaint — inclui logos-bar
   * 3. Passa width/height explícitos ao html2canvas baseados no scrollHeight real
   * 4. Remove overflow e ajusta margens no clone para captura completa
   * 
   * Retorna { dataURL, width, height } ou null.
   */
  static async _capturePreview() {
    const sourcePoster = document.querySelector('.cert-poster');
    if (!sourcePoster) return null;

    const stage = document.createElement('div');
    stage.setAttribute('aria-hidden', 'true');
    stage.style.cssText = [
      'position:fixed',
      'left:-10000px',
      'top:0',
      'width:620px',
      'padding:0',
      'margin:0',
      'opacity:1',
      'pointer-events:none',
      'z-index:-1',
      'background:transparent',
      'overflow:visible'
    ].join(';');

    const poster = sourcePoster.cloneNode(true);
    poster.classList.add('cert-poster--capturing');
    stage.appendChild(poster);
    document.body.appendChild(stage);

    let result = null;
    try {
      const sourceCanvases = Array.from(sourcePoster.querySelectorAll('canvas'));
      const clonedCanvases = Array.from(poster.querySelectorAll('canvas'));
      clonedCanvases.forEach((canvas, index) => {
        const src = sourceCanvases[index];
        if (!src) return;
        try {
          canvas.width = src.width;
          canvas.height = src.height;
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.drawImage(src, 0, 0);
        } catch (_) {}
      });

      await Promise.all(Array.from(poster.querySelectorAll('img')).map(img =>
        new Promise(res => {
          if (img.complete && img.naturalWidth > 0) { res(); return; }
          const done = () => res();
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
          setTimeout(done, 3000);
        })
      ));

      await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));

      const rect = poster.getBoundingClientRect();
      const captureW = Math.ceil(Math.max(rect.width, poster.scrollWidth, poster.offsetWidth));
      const captureH = Math.ceil(Math.max(rect.height, poster.scrollHeight, poster.offsetHeight));

      const canvas = await window.html2canvas(poster, {
        scale:           Math.max(2, Math.min(3, window.devicePixelRatio || 1)),
        useCORS:         true,
        allowTaint:      false,
        backgroundColor: '#060910',
        logging:         false,
        removeContainer: true,
        imageTimeout:    10000,
        width:           captureW,
        height:          captureH,
        scrollX:         0,
        scrollY:         0,
        windowWidth:     captureW,
        windowHeight:    captureH
      });

      result = {
        dataURL: canvas.toDataURL('image/png', 1),
        width:   captureW,
        height:  captureH
      };
    } finally {
      if (stage.parentNode) stage.parentNode.removeChild(stage);
    }

    return result;
  }

  static async generate(cert) {
    const jspdf = window.jspdf;
    if (!jspdf) throw new Error('Biblioteca jsPDF não carregada. Recarregue a página.');
    const { jsPDF } = jspdf;

    const participantName = _properCase(_safeName(cert.participantName) || cert.participantName || '');
    const safeName = (participantName || 'certificado')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-]/g, '').toLowerCase().slice(0, 60);

    // PDF final obrigatório em A4 horizontal.
    // O preview continua independente, mas a exportação usa composição vetorial.
    await AxisCertificatePDF._generateVectorial(cert, jsPDF, safeName);
  }

  /**
   * _generateVectorial: método vetorial original — mantido como fallback.
   * Usado apenas quando html2canvas não está disponível.
   */
  static async _generateVectorial(cert, jsPDF, safeName) {
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = 297, H = 210;

    const kindInfo    = _getCertificateKindInfo(cert);
    const isSpeaker   = kindInfo.isSpeaker;
    const isRodada    = kindInfo.isRodada;
    const isAtelie    = kindInfo.isAtelie;
    const specialLabel = kindInfo.specialLabel;
    const projectName  = kindInfo.projectName;
    const speakerRole = String(cert.participantRole || cert.participantRoleLabel || cert.role || cert.funcao || 'Palestrante').trim();
    const panelName   = String(cert.panelName || cert.mesa || cert.nomeMesa || '').trim();

    const LOGO_BAR_ASSET = _resolveLogosBarAsset();
    const logoBarRawDataURL = await AxisCertificatePDF._loadImage(LOGO_BAR_ASSET);
    if (!logoBarRawDataURL) {
      throw new Error('A barra de logos institucional não pôde ser carregada.');
    }

    const logoBarImage = await AxisCertificatePDF._trimTransparentDataURL(logoBarRawDataURL, 0);
    if (!logoBarImage || !logoBarImage.dataURL || !logoBarImage.width || !logoBarImage.height) {
      throw new Error('A barra de logos institucional não pode ser composta no PDF.');
    }

    const fill   = c => pdf.setFillColor(c[0],c[1],c[2]);
    const stroke = c => pdf.setDrawColor(c[0],c[1],c[2]);
    const color  = c => pdf.setTextColor(c[0],c[1],c[2]);
    const lw     = v => pdf.setLineWidth(v);
    const f      = (fm,st,sz) => { pdf.setFont(fm,st); pdf.setFontSize(sz); };
    const polygon = (pts,col,alpha=1) => {
      pdf.saveGraphicsState();
      pdf.setGState(new pdf.GState({ opacity: alpha }));
      fill(col);
      const rel = [];
      for (let i=1;i<pts.length;i++) rel.push([pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]]);
      pdf.lines(rel, pts[0][0], pts[0][1], [1,1], 'F', true);
      pdf.restoreGraphicsState();
    };

    const CANVAS   = [  6,   8,  14];
    const GRAPHITE = [ 15,  18,  30];
    const PAPER    = [248, 244, 233];
    const INK      = [ 27,  20,  12];
    const SABLE    = [107,  92,  76];
    const LIME     = [197, 236,  52];
    const LIME_MUT = [152, 192,  40];
    const ORANGE   = [255, 122,  46];
    const CORAL    = [255, 151,  86];
    const ICE      = [249, 248, 244];
    const RULE_MID = [195, 182, 165];

    const participantName = _properCase(_safeName(cert.participantName) || cert.participantName || '');
    const cpfFormatted    = _fmtCpf(cert.cpfNormalized || '');
    const diasLabel       = _safeDiasLabel(cert);
    const eventName       = cert.eventName  || 'AXIS Summit';
    const eventYear       = cert.eventYear  || '2026';
    const validCode       = _normalizeValidationCode(cert.validationCode);
    if (!validCode) throw new Error('Código de validação ausente no certificado.');
    const emissaoStr      = cert.issuedAt
      ? new Date(cert.issuedAt).toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' })
      : new Date().toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });

    const bodyText = isSpeaker
      ? `participou como ${speakerRole}${panelName ? ` na atividade "${panelName}"` : ''} do ${eventName} ${eventYear}, realizado em Porto Alegre, RS.`
      : isRodada
        ? `participou da ${specialLabel} do ${eventName} ${eventYear}, realizada em Porto Alegre, RS, apresentando o projeto ${projectName}.`
        : isAtelie
          ? `participou do ${specialLabel} do ${eventName} ${eventYear}, realizado em Porto Alegre, RS.`
      : `participou presencialmente do ${eventName} ${eventYear}, realizado nos dias ${diasLabel}, em Porto Alegre, RS.`;

    const validatorURL = _buildValidationUrl(validCode);
    const qrDataURL    = await AxisCertificatePDF._makeQR(validatorURL);
    if (!qrDataURL) {
      throw new Error('Não foi possível gerar um QR code real e escaneável para este certificado.');
    }

    /* 1. FUNDO */
    fill(CANVAS); pdf.rect(0,0,W,H,'F');
    polygon([[-20,60],[120,-5],[170,70],[30,180]],[40,52,18],0.75);
    polygon([[60,-30],[220,10],[180,140],[20,110]],[26,22,45],0.55);
    polygon([[220,-20],[330,40],[280,190],[200,140]],[32,47,26],0.65);

    /* 2. HEADER */
    fill(ORANGE); pdf.rect(0,0,W,3,'F');
    color(ICE); f('helvetica','bold',13.5);
    pdf.text(`${eventName.toUpperCase()} ${eventYear}`, 18, 16);
    color(LIME); f('helvetica','bold',6.2);
    pdf.text('A CULTURA VIRA O JOGO!', 18, 22.5, { charSpace: 0.35 });
    color([180,174,160]); f('helvetica','normal',6.5);
    pdf.text('10 e 11 de março · Famecos – PUCRS · Porto Alegre, RS', W-18, 16, { align:'right' });

    /* 3. PAINEL PRINCIPAL */
    const MAIN_X=20, MAIN_Y=32, MAIN_W=189, MAIN_H=122;
    fill(PAPER); pdf.roundedRect(MAIN_X,MAIN_Y,MAIN_W,MAIN_H,16,16,'F');
    polygon([[MAIN_X+MAIN_W-38,MAIN_Y],[MAIN_X+MAIN_W+4,MAIN_Y-10],[MAIN_X+MAIN_W+4,MAIN_Y+46]],CANVAS,1);
    fill(ORANGE); pdf.rect(MAIN_X-6,MAIN_Y+18,4,MAIN_H-34,'F');

    let cursor = MAIN_Y + 20;
    color([115,98,80]); f('helvetica','bold',6.5);
    pdf.text(kindInfo.titleLabel, MAIN_X+12, cursor, { charSpace:0.5 });

    cursor += 9.5;
    color([128,102,80]); f('helvetica','italic',8);
    pdf.text('Certificamos que', MAIN_X+12, cursor);

    cursor += 15;
    let nameSize = 38;
    f('helvetica','bold',nameSize);
    while (nameSize > 12 && pdf.getTextWidth(participantName) > MAIN_W-28) { nameSize -= 0.4; pdf.setFontSize(nameSize); }
    color(INK); pdf.text(participantName, MAIN_X+12, cursor);
    stroke(ORANGE); lw(1.8);
    const nameWidth = Math.min(pdf.getTextWidth(participantName), MAIN_W-28);
    pdf.line(MAIN_X+12, cursor+2.5, MAIN_X+12+nameWidth, cursor+2.5);

    if (cpfFormatted) {
      cursor += 8.5;
      color([135,114,94]); f('helvetica','normal',7.2);
      pdf.text(`CPF: ${cpfFormatted}`, MAIN_X+12, cursor);
    }

    cursor += cpfFormatted ? 10 : 11;
    color(SABLE); f('helvetica','normal',8);
    const bodyLines = pdf.splitTextToSize(bodyText, MAIN_W-26);
    pdf.text(bodyLines, MAIN_X+12, cursor, { lineHeightFactor: 1.45 });
    cursor += bodyLines.length * 8 * 0.352778 * 1.45 + 7;

    const STRIP_X1 = MAIN_X + 12;
    const STRIP_X2 = MAIN_X + MAIN_W - 12;
    const STRIP_W  = STRIP_X2 - STRIP_X1;
    const STRIP_Y  = cursor;

    stroke(ORANGE); lw(0.4);
    pdf.line(STRIP_X1, STRIP_Y, STRIP_X2, STRIP_Y);

    const metaEntries = isSpeaker
      ? [
          { label: 'EVENTO',     value: `${eventName} ${eventYear}` },
          { label: 'FUNÇÃO',     value: speakerRole },
          { label: 'ATIVIDADE',  value: panelName || '—' },
          { label: 'EMITIDO EM', value: emissaoStr }
        ]
      : isRodada
        ? [
            { label: 'EVENTO',      value: `${eventName} ${eventYear}` },
            { label: 'MODALIDADE',  value: specialLabel },
            { label: 'PROJETO',     value: projectName || '—' },
            { label: 'EMITIDO EM',  value: emissaoStr }
          ]
        : isAtelie
          ? [
              { label: 'EVENTO',      value: `${eventName} ${eventYear}` },
              { label: 'MODALIDADE',  value: specialLabel },
              { label: 'LOCAL',       value: 'Porto Alegre, RS' },
              { label: 'EMITIDO EM',  value: emissaoStr }
            ]
      : [
          { label: 'EVENTO',     value: `${eventName} ${eventYear}` },
          { label: 'PERÍODO',    value: diasLabel },
          { label: 'LOCAL',      value: 'Famecos – PUCRS, Porto Alegre' },
          { label: 'EMITIDO EM', value: emissaoStr }
        ];
    const COL_W   = STRIP_W / 4;
    const COL_PAD = 5;

    metaEntries.forEach((item, idx) => {
      const colX = STRIP_X1 + idx * COL_W;
      if (idx > 0) { stroke(RULE_MID); lw(0.2); pdf.line(colX, STRIP_Y + 3, colX, STRIP_Y + 24); }
      const textX = colX + (idx === 0 ? 0 : COL_PAD);
      color([148,130,110]); f('helvetica','bold',4.8);
      pdf.text(item.label, textX, STRIP_Y + 8, { charSpace: 0.3 });
      color(INK); f('helvetica','bold',7.5);
      const maxW = COL_W - (idx === 0 ? COL_PAD : COL_PAD * 2);
      pdf.text(pdf.splitTextToSize(item.value, maxW).slice(0,2), textX, STRIP_Y + 15, { lineHeightFactor: 1.3 });
    });

    stroke(RULE_MID); lw(0.2);
    pdf.line(STRIP_X1, STRIP_Y + 27, STRIP_X2, STRIP_Y + 27);

    /* 4. COLUNA DE AUTENTICAÇÃO */
    const AUTH_X  = MAIN_X + MAIN_W + 10;
    const AUTH_Y  = MAIN_Y - 4;
    const AUTH_W  = W - AUTH_X - 15;
    const AUTH_H  = MAIN_H + 4;

    fill(GRAPHITE); pdf.roundedRect(AUTH_X,AUTH_Y,AUTH_W,AUTH_H,13,13,'F');
    fill(ORANGE); pdf.roundedRect(AUTH_X,AUTH_Y,AUTH_W,7,13,13,'F');
    fill(ORANGE); pdf.rect(AUTH_X,AUTH_Y+3,AUTH_W,4,'F');

    const AUTH_CENTER = AUTH_X + AUTH_W/2;
    color(LIME); f('helvetica','bold',5.5);
    pdf.text('AUTENTICAÇÃO DIGITAL', AUTH_CENTER, AUTH_Y+14, { align:'center', charSpace:0.45 });

    const QR_S=46, QR_X=AUTH_CENTER-QR_S/2, QR_Y=AUTH_Y+19;
    fill(ICE); pdf.roundedRect(QR_X-3,QR_Y-3,QR_S+6,QR_S+6,5,5,'F');
    stroke(ORANGE); lw(0.55); pdf.roundedRect(QR_X-3,QR_Y-3,QR_S+6,QR_S+6,5,5);
    pdf.addImage(qrDataURL,'PNG',QR_X,QR_Y,QR_S,QR_S);

    color([162,158,174]); f('helvetica','normal',4.6);
    pdf.text('Escaneie para verificar', AUTH_CENTER, QR_Y+QR_S+7, { align:'center' });

    const CODE_BOX_Y = QR_Y+QR_S+14;
    fill([10,12,26]); pdf.roundedRect(AUTH_X+6,CODE_BOX_Y,AUTH_W-12,22,5,5,'F');
    color(LIME_MUT); f('helvetica','bold',4.2);
    pdf.text('CÓDIGO DE VALIDAÇÃO', AUTH_CENTER, CODE_BOX_Y+6, { align:'center', charSpace:0.4 });
    let codeSize=10; f('courier','bold',codeSize);
    while (codeSize>6 && pdf.getTextWidth(validCode)>AUTH_W-20) { codeSize-=0.4; pdf.setFontSize(codeSize); }
    color(CORAL); pdf.text(validCode, AUTH_CENTER, CODE_BOX_Y+14.5, { align:'center', charSpace:0.35 });

    const URL_Y = CODE_BOX_Y+28;
    color([148,146,162]); f('helvetica','bold',4);
    pdf.text('VALIDAÇÃO ONLINE', AUTH_CENTER, URL_Y, { align:'center', charSpace:0.35 });
    color([210,208,222]); f('helvetica','normal',4.5);
    pdf.text('portfolio.example/certificates/validate', AUTH_CENTER, URL_Y+6.5, { align:'center' });

    /* 5. BARRA DE LOGOS */
    const FOOTER_TOTAL_H = 55;
    const LOGO_BAR_H     = 46;
    const LOGO_STRIP_Y   = H - FOOTER_TOTAL_H;

    fill([11,13,20]); pdf.rect(0, LOGO_STRIP_Y, W, FOOTER_TOTAL_H, 'F');

    const maxLogoW = W - 18;
    const maxLogoH = LOGO_BAR_H;
    const logoRatio = logoBarImage.width / logoBarImage.height;
    let scaledW = maxLogoW;
    let scaledH = scaledW / logoRatio;
    if (scaledH > maxLogoH) {
      scaledH = maxLogoH;
      scaledW = scaledH * logoRatio;
    }
    const imgX = (W - scaledW) / 2;
    const imgY = LOGO_STRIP_Y + ((LOGO_BAR_H - scaledH) / 2);
    pdf.addImage(logoBarImage.dataURL, 'PNG', imgX, imgY, scaledW, scaledH);

    stroke(ORANGE); lw(0.25);
    pdf.line(14, LOGO_STRIP_Y + LOGO_BAR_H + 3, W - 14, LOGO_STRIP_Y + LOGO_BAR_H + 3);
    color(ORANGE); f('helvetica','bold',4.8);
    const footerSuffix = isSpeaker ? '' : (isRodada || isAtelie ? `  ·  ${specialLabel}` : `  ·  ${diasLabel}`);
    pdf.text(`${eventName} ${eventYear}${footerSuffix}`, 16, H - 4);
    color([84,80,72]); f('helvetica','normal',3.5);
    pdf.text('official certificate · portfolio.example', W - 15, H - 4, { align:'right' });

    pdf.save(`certificado-axis-2026-${safeName}.pdf`);
  }
}

window.AxisCertificatePDF = AxisCertificatePDF;


/* ============================================================
   FORMULÁRIO DE SOLICITAÇÃO MANUAL (fallback intrasite)

   ENVIA VIA FETCH para o backend (action: solicitarAvaliacaoCertificado).
   Zero mailto. Zero redirecionamento para cliente de e-mail externo.
   O backend envia o e-mail server-side via MailApp/GmailApp.
   Honeypot: campo _trap é enviado vazio; o backend rejeita se vier preenchido.
   ============================================================ */

class ManualReviewForm {
  constructor(container, prefill) {
    this.container = container;
    this.prefill   = prefill || {};
    this.api       = new AxisCertificatesAPI();
    this._render();
  }

  _render() {
    if (!this.container) return;
    const p = this.prefill;

    // Honeypot: visualmente oculto, enviado vazio por usuários legítimos
    this.container.innerHTML = `
      <div class="manual-review-form">
        <div class="manual-review-form__header">
          <span class="manual-review-form__badge">Solicitação de Avaliação</span>
          <h3 class="manual-review-form__title">Não encontrou seu certificado?</h3>
          <p class="manual-review-form__desc">
            Preencha o formulário abaixo. Nossa equipe analisará manualmente sua participação
            e retornará por e-mail em até 2 dias úteis.
          </p>
        </div>
        <div class="manual-review-form__body">
          <!-- Honeypot: oculto de usuários, detecta bots -->
          <input type="text" name="_trap" id="mr_trap" tabindex="-1" autocomplete="off"
            aria-hidden="true"
            style="position:absolute;opacity:0;height:0;width:0;pointer-events:none;overflow:hidden"/>
          <div class="form-group">
            <label for="mr_nome">Nome completo <span class="required">*</span></label>
            <input type="text" id="mr_nome" placeholder="Seu nome como cadastrado no evento"
              value="${this._esc(p.nome || '')}" required/>
          </div>
          <div class="form-group">
            <label for="mr_email">E-mail <span class="required">*</span></label>
            <input type="email" id="mr_email" placeholder="Seu e-mail de cadastro"
              value="${this._esc(p.email || '')}" required/>
          </div>
          <div class="form-group">
            <label for="mr_cpf">CPF <span class="required">*</span></label>
            <input type="text" id="mr_cpf" placeholder="000.000.000-00" maxlength="14"
              value="${this._esc(p.cpf ? _fmtCpf(p.cpf) : '')}" required/>
          </div>
          <div class="form-group">
            <label>Dias de participação <span class="required">*</span></label>
            <div class="checkbox-group">
              <label class="checkbox-label" for="mr_dia10">
                <input type="checkbox" id="mr_dia10" name="mr_dias" value="10"
                  ${(p.dias||[]).includes('10') ? 'checked' : ''}/>
                <span class="checkmark"></span>
                10 de março de 2026
                <span class="checkbox-label-day">Ter</span>
              </label>
              <label class="checkbox-label" for="mr_dia11">
                <input type="checkbox" id="mr_dia11" name="mr_dias" value="11"
                  ${(p.dias||[]).includes('11') ? 'checked' : ''}/>
                <span class="checkmark"></span>
                11 de março de 2026
                <span class="checkbox-label-day">Qua</span>
              </label>
            </div>
          </div>
          <div class="form-group">
            <label for="mr_obs">Observação / motivo</label>
            <textarea id="mr_obs" placeholder="Descreva brevemente como participou, ou qualquer divergência no cadastro..." rows="3" style="resize:vertical;padding:12px 16px;border-radius:12px;border:1px solid var(--line-med);background:rgba(255,255,255,0.032);color:var(--text);font-size:0.92rem;font-weight:700;font-family:inherit;outline:none;transition:border-color .13s,box-shadow .13s;width:100%;box-sizing:border-box;" maxlength="500"></textarea>
          </div>
          <div id="mr_message" class="message" role="alert" style="display:none"></div>
          <button type="button" id="mr_submit" class="btn-axis" style="margin-top:0.5rem">
            <span id="mr_submit_text">Enviar solicitação</span>
            <div class="loading-spinner" id="mr_spinner" style="display:none"></div>
          </button>
          <p style="font-size:0.7rem;color:var(--muted-3);margin-top:0.75rem;text-align:center;line-height:1.5">
            Os dados serão enviados para análise por <strong style="color:var(--muted-2)">certificates@example.com</strong>.
          </p>
        </div>
      </div>
    `;

    const cpfInput = this.container.querySelector('#mr_cpf');
    if (cpfInput) {
      cpfInput.addEventListener('input', e => {
        let v = e.target.value.replace(/\D/g,'').slice(0,11);
        v = v.replace(/(\d{3})(\d)/,'$1.$2').replace(/(\d{3}\.\d{3})(\d)/,'$1.$2').replace(/(\d{3}\.\d{3}\.\d{3})(\d)/,'$1-$2');
        e.target.value = v;
      });
    }

    const btn = this.container.querySelector('#mr_submit');
    if (btn) btn.addEventListener('click', () => this._submit());
  }

  async _submit() {
    const nome      = (this.container.querySelector('#mr_nome')?.value  || '').trim();
    const email     = (this.container.querySelector('#mr_email')?.value || '').trim();
    const cpfRaw    = (this.container.querySelector('#mr_cpf')?.value   || '').replace(/\D/g,'');
    const dias      = Array.from(this.container.querySelectorAll('input[name="mr_dias"]:checked')).map(c => c.value);
    const obs       = (this.container.querySelector('#mr_obs')?.value   || '').trim().slice(0, 500);
    const trapVal   = (this.container.querySelector('#mr_trap')?.value  || '').trim();
    const msgEl     = this.container.querySelector('#mr_message');
    const btn       = this.container.querySelector('#mr_submit');
    const sp        = this.container.querySelector('#mr_submit_text');
    const spinner   = this.container.querySelector('#mr_spinner');

    const showMsg = (msg, type) => {
      if (!msgEl) return;
      msgEl.textContent = msg;
      msgEl.className   = 'message message--' + type;
      msgEl.style.display = 'block';
      msgEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    if (nome.length < 3)               { showMsg('Informe seu nome completo.', 'error'); return; }
    if (!email || !email.includes('@')) { showMsg('Informe um e-mail válido.', 'error'); return; }
    if (cpfRaw.length !== 11)           { showMsg('Informe um CPF válido com 11 dígitos.', 'error'); return; }
    if (dias.length === 0)              { showMsg('Selecione pelo menos um dia.', 'error'); return; }

    if (btn)     btn.disabled = true;
    if (sp)      sp.textContent = 'Enviando...';
    if (spinner) spinner.style.display = 'inline-block';
    showMsg('Enviando sua solicitação...', 'info');

    try {
      const response = await this.api.solicitarAvaliacaoCertificado({
        nome:       nome,
        email:      email,
        cpf:        cpfRaw,
        dias:       dias,
        observacao: obs,
        _trap:      trapVal  // honeypot: enviado conforme capturado (vazio para usuários legítimos)
      });

      if (response && response.ok) {
        if (btn)     btn.disabled = true;
        if (spinner) spinner.style.display = 'none';
        if (sp)      sp.textContent = 'Solicitação enviada ✓';
        showMsg(response.message || 'Solicitação enviada! Retorno em até 2 dias úteis.', 'success');
      } else {
        const errMsg = (response && response.error) || 'Erro ao enviar. Tente novamente.';
        showMsg(errMsg, 'error');
        if (btn)     btn.disabled = false;
        if (sp)      sp.textContent = 'Enviar solicitação';
        if (spinner) spinner.style.display = 'none';
      }
    } catch (err) {
      showMsg('Erro de conexão: ' + (err.message || 'Tente novamente.'), 'error');
      if (btn)     btn.disabled = false;
      if (sp)      sp.textContent = 'Enviar solicitação';
      if (spinner) spinner.style.display = 'none';
    }
  }

  _esc(str) {
    return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
}

window.ManualReviewForm = ManualReviewForm;


/* ============================================================
   CONTROLLER — PÁGINA DE EMISSÃO
   ============================================================ */

class CertificateController {
  constructor() {
    this.api                = new AxisCertificatesAPI();
    this.form               = document.getElementById('certificateForm');
    this.nomeInput          = document.getElementById('nome');
    this.emailInput         = document.getElementById('email');
    this.emitBtn            = document.getElementById('emitBtn');
    this.messageDiv         = document.getElementById('resultMessage');
    this.resultDiv          = document.getElementById('certResult');
    this.infoDiv            = document.getElementById('certInfo');
    this.downloadBtn        = document.getElementById('downloadBtn');
    this.validateBtn        = document.getElementById('validateBtn');
    this.currentCertificate = null;
    this._pendingPayload    = null;
    this._cpfFieldInjected  = false;
    this._typeSelectorId    = 'certificateTypeSelector';
    this._init();
  }

  _init() {
    if (this.form) {
      this.form.addEventListener('submit', e => { e.preventDefault(); e.stopPropagation(); this._handleSubmit(); });
    }
    if (this.downloadBtn) this.downloadBtn.addEventListener('click', () => this.downloadPDF());
    if (this.validateBtn) this.validateBtn.addEventListener('click', () => this._openValidator());
    if (this.form) {
      const clearSelection = event => {
        if (event?.target?.id === 'formTrap') return;
        this._removeCertificateTypeSelector();
      };
      this.form.addEventListener('input', clearSelection);
      this.form.addEventListener('change', clearSelection);
    }
    // Máscara CPF no campo principal
    const cpfMainInput = document.getElementById('cpf');
    if (cpfMainInput) {
      cpfMainInput.addEventListener('input', e => {
        let v = e.target.value.replace(/\D/g,'').slice(0,11);
        v = v.replace(/(\d{3})(\d)/,'$1.$2').replace(/(\d{3}\.\d{3})(\d)/,'$1.$2').replace(/(\d{3}\.\d{3}\.\d{3})(\d)/,'$1-$2');
        e.target.value = v;
      });
    }
    this._processURLParams();
  }

  _processURLParams() {
    try {
      const params = new URLSearchParams(window.location.search);
      const nome   = _safeUrlPrefill(params.get('nome'), 140);
      const email  = _safeUrlPrefill(params.get('email'), 160);
      const dias   = params.getAll('dias').map(v => String(v || '').trim()).filter(v => v === '10' || v === '11');
      let hasData  = false;
      if (nome  && this.nomeInput)  { this.nomeInput.value  = nome; hasData=true; }
      if (email && this.emailInput) { this.emailInput.value = email; hasData=true; }
      if (dias.length > 0) { dias.forEach(d => { const cb=document.getElementById('dia'+d); if(cb){cb.checked=true;hasData=true;} }); }
      if (hasData && nome && email && dias.length > 0) setTimeout(() => this._handleSubmit(), 800);
      else if (hasData) this._showMessage('Dados pré-preenchidos. Clique em "Emitir Certificado".', 'info');
    } catch(_) {}
  }

  async _handleSubmit() {
    const formData = this._getFormData();
    if (!formData) return;
    this._pendingPayload = { ...formData };
    this._setLoading(true);
    this._hideMessage();
    this._removeCpfField();
    this._removeCertificateTypeSelector();
    try {
      const response = await this.api.emitirCertificado(formData);
      if (response && response.selectionRequired) {
        this._handleSelectionRequired(response, formData);
      } else if (response && response.ok) {
        this._handleSuccess(response);
      } else if (response && response.requiresCpf) {
        this._handleRequiresCpf(response, formData);
      } else {
        const errMsg = (response && response.error) || 'Erro desconhecido na API.';
        const hint   = response && response.hint ? ' ' + response.hint : '';
        this._showMessage(errMsg + hint, 'error');
        if (response && (response.code === 'PARTICIPANT_NOT_FOUND' || response.code === 'EMISSION_ERROR')) {
          this._showManualReviewForm({ nome: formData.nome, email: formData.email, dias: formData.dias });
        }
      }
    } catch (err) {
      this._showMessage(err.message || 'Erro inesperado. Tente novamente.', 'error');
      this._showManualReviewForm({ nome: formData?.nome, email: formData?.email, dias: formData?.dias });
    } finally {
      this._setLoading(false);
    }
  }

  _handleRequiresCpf(response, originalPayload) {
    this._pendingPayload = { ...originalPayload };
    this._removeCertificateTypeSelector();
    const errMsg = (response && response.error) || 'Precisamos do seu CPF apenas para confirmar sua identidade neste caso.';
    const hint   = response && response.hint ? ' ' + response.hint : '';
    this._showMessage(errMsg + hint, 'info');
    this._injectCpfField();
  }

  _injectCpfField() {
    if (this._cpfFieldInjected) return;
    this._cpfFieldInjected = true;

    const wrapper = document.createElement('div');
    wrapper.id    = 'cpfRequired';
    wrapper.style.cssText = 'margin-top:1.25rem';
    wrapper.innerHTML = `
      <div class="form-group">
        <label for="cpfRequired_input">CPF</label>
        <input type="text" id="cpfRequired_input" placeholder="000.000.000-00" maxlength="14"
          autocomplete="off" style="font-variant-numeric:tabular-nums"/>
        <span class="form-hint">Só precisamos do CPF neste caso para confirmar sua identidade.</span>
      </div>
      <button type="button" id="cpfRequired_btn" class="btn-axis" style="margin-top:0.85rem;width:100%">
        <span id="cpfRequired_text">Confirmar e Emitir Certificado</span>
        <div class="loading-spinner" id="cpfRequired_spinner" style="display:none"></div>
      </button>
    `;

    const formEl = this.form;
    if (formEl && formEl.parentNode) formEl.parentNode.insertBefore(wrapper, formEl.nextSibling);

    const cpfInp = wrapper.querySelector('#cpfRequired_input');
    if (cpfInp) {
      cpfInp.focus();
      cpfInp.addEventListener('input', e => {
        let v = e.target.value.replace(/\D/g,'').slice(0,11);
        v = v.replace(/(\d{3})(\d)/,'$1.$2').replace(/(\d{3}\.\d{3})(\d)/,'$1.$2').replace(/(\d{3}\.\d{3}\.\d{3})(\d)/,'$1-$2');
        e.target.value = v;
      });
    }

    const cpfBtn = wrapper.querySelector('#cpfRequired_btn');
    if (cpfBtn) cpfBtn.addEventListener('click', () => this._submitWithCpf());
  }

  async _submitWithCpf() {
    const cpfInp = document.getElementById('cpfRequired_input');
    const cpfRaw = (cpfInp?.value || '').replace(/\D/g,'');
    if (cpfRaw.length !== 11) { this._showMessage('CPF inválido. Informe os 11 dígitos corretamente.', 'error'); return; }
    if (!this._pendingPayload) { this._showMessage('Dados perdidos. Recarregue e tente novamente.', 'error'); return; }

    const payload = { ...this._pendingPayload, cpf: cpfRaw };
    const btn     = document.getElementById('cpfRequired_btn');
    const sp      = document.getElementById('cpfRequired_text');
    const spinner = document.getElementById('cpfRequired_spinner');

    if (btn)    btn.disabled = true;
    if (spinner) spinner.style.display = 'inline-block';
    if (sp)     sp.textContent = 'Processando...';
    this._hideMessage();

    try {
      const response = await this.api.emitirCertificado(payload);
      if (response && response.selectionRequired) {
        this._removeCpfField();
        this._handleSelectionRequired(response, payload);
      } else if (response && response.ok) {
        this._removeCpfField();
        this._handleSuccess(response);
      } else if (response && response.requiresCpf) {
        this._showMessage('CPF não reconhecido. Verifique os dígitos e tente novamente.', 'error');
      } else {
        const errMsg = (response && response.error) || 'Erro ao emitir certificado.';
        this._showMessage(errMsg, 'error');
        if (response && response.code === 'PARTICIPANT_NOT_FOUND') {
          this._showManualReviewForm({ nome: payload.nome, email: payload.email, cpf: cpfRaw, dias: payload.dias });
        }
      }
    } catch(err) {
      this._showMessage(err.message || 'Erro inesperado.', 'error');
    } finally {
      if (btn)    btn.disabled = false;
      if (spinner) spinner.style.display = 'none';
      if (sp)     sp.textContent = 'Confirmar e Emitir Certificado';
    }
  }

  _removeCpfField() {
    const el = document.getElementById('cpfRequired');
    if (el) el.remove();
    this._cpfFieldInjected = false;
  }

  _handleSelectionRequired(response, originalPayload) {
    this._pendingPayload = { ...originalPayload };
    this._renderCertificateTypeSelector(response);
    this._showMessage('Escolha qual certificado deseja emitir.', 'info');
  }

  _renderCertificateTypeSelector(response) {
    this._removeCertificateTypeSelector();
    if (!this.form?.parentNode) return;

    const options = Array.isArray(response?.certificateOptions)
      ? response.certificateOptions
      : [];
    if (!options.length) return;

    const wrapper = document.createElement('div');
    wrapper.id = this._typeSelectorId;
    wrapper.style.cssText = 'margin-top:1.25rem;padding:1rem 1rem 1.1rem;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(9,12,18,.55)';
    wrapper.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;flex-wrap:wrap">
        <div>
          <div style="font-size:.82rem;letter-spacing:.08em;text-transform:uppercase;opacity:.7">Tipo de certificado</div>
          <div style="font-size:1rem;font-weight:700;margin-top:.2rem">Selecione uma opção permitida para você</div>
        </div>
        <div style="font-size:.85rem;opacity:.7">${this._escape(response?.participant?.participantName || '')}</div>
      </div>
      <div style="display:grid;gap:.75rem;margin-top:1rem">
        ${options.map((option, index) => `
          <label style="display:block;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:.9rem 1rem;cursor:pointer;background:rgba(255,255,255,.02)">
            <input type="radio" name="certificateTypeOption" value="${this._escape(option.certificateType)}" ${index === 0 ? 'checked' : ''} style="margin-right:.6rem"/>
            <strong>${this._escape(option.label || option.certificateType)}</strong>
            ${option.projectName ? `<div style="margin-top:.35rem;font-size:.88rem;opacity:.76">Projeto: ${this._escape(option.projectName)}</div>` : ''}
          </label>
        `).join('')}
      </div>
      <button type="button" id="confirmCertificateTypeBtn" class="btn-axis" style="margin-top:1rem;width:100%">
        <span>Continuar com o certificado escolhido</span>
        <div class="loading-spinner" style="display:none"></div>
      </button>
    `;

    this.form.parentNode.insertBefore(wrapper, this.form.nextSibling);
    const confirmBtn = wrapper.querySelector('#confirmCertificateTypeBtn');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => this._submitSelectedCertificateType(confirmBtn));
    }
  }

  _removeCertificateTypeSelector() {
    const el = document.getElementById(this._typeSelectorId);
    if (el) el.remove();
  }

  async _submitSelectedCertificateType(buttonEl) {
    if (!this._pendingPayload) {
      this._showMessage('Dados perdidos. Recarregue e tente novamente.', 'error');
      return;
    }

    const selector = document.getElementById(this._typeSelectorId);
    const selected = selector?.querySelector('input[name=\"certificateTypeOption\"]:checked');
    const requestedCertificateType = _normalizeCertificateType(selected?.value || '');
    if (!requestedCertificateType) {
      this._showMessage('Escolha um tipo de certificado para continuar.', 'error');
      return;
    }

    const spinner = buttonEl?.querySelector('.loading-spinner');
    const text = buttonEl?.querySelector('span');
    if (buttonEl) buttonEl.disabled = true;
    if (spinner) spinner.style.display = 'inline-block';
    if (text) text.textContent = 'Processando...';
    this._hideMessage();

    try {
      const response = await this.api.emitirCertificado({
        ...this._pendingPayload,
        requestedCertificateType
      });
      if (response && response.selectionRequired) {
        this._handleSelectionRequired(response, {
          ...this._pendingPayload,
          requestedCertificateType
        });
      } else if (response && response.ok) {
        this._handleSuccess(response);
      } else if (response && response.requiresCpf) {
        this._handleRequiresCpf(response, {
          ...this._pendingPayload,
          requestedCertificateType
        });
      } else {
        const errMsg = (response && response.error) || 'Erro ao emitir certificado.';
        this._showMessage(errMsg, 'error');
      }
    } catch (err) {
      this._showMessage(err.message || 'Erro inesperado.', 'error');
    } finally {
      if (buttonEl) buttonEl.disabled = false;
      if (spinner) spinner.style.display = 'none';
      if (text) text.textContent = 'Continuar com o certificado escolhido';
    }
  }

  _showManualReviewForm(prefill) {
    if (document.getElementById('manualReviewSection')) return;
    const section = document.createElement('div');
    section.id    = 'manualReviewSection';
    section.style.cssText = 'margin-top:2rem';
    const panelBody = document.querySelector('.cert-panel-body');
    if (panelBody) panelBody.appendChild(section);
    else if (this.form?.parentNode) this.form.parentNode.appendChild(section);
    new ManualReviewForm(section, prefill || {});
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  _getFormData() {
    const nome      = this.nomeInput?.value?.trim()  || '';
    const email     = this.emailInput?.value?.trim() || '';
    const cpfInput  = document.getElementById('cpf');
    const cpfRaw    = cpfInput ? cpfInput.value.replace(/\D/g,'') : '';
    const trapInput = document.getElementById('formTrap');
    const trapVal   = trapInput ? String(trapInput.value || '').trim() : '';
    const diasArray = Array.from(document.querySelectorAll('input[name="dias"]:checked')).map(cb => cb.value);
    if (nome.length < 3)               { this._showMessage('Informe seu nome completo.', 'error'); return null; }
    if (!email || !email.includes('@')) { this._showMessage('Informe um e-mail válido.', 'error'); return null; }
    if (cpfRaw && cpfRaw.length !== 11) { this._showMessage('Se informar CPF, preencha os 11 dígitos.', 'error'); return null; }

    const fd = { nome, name: nome, email: email.toLowerCase(), dias: diasArray, days: diasArray, _trap: trapVal };
    if (cpfRaw.length === 11) fd.cpf = cpfRaw;
    return fd;
  }

  _handleSuccess(response) {
    const cert = _normalizeCertificatePayload(response);

    this.currentCertificate   = cert;
    this._removeCertificateTypeSelector();
    this._displayCertificate();
    this._showMessage(
      response.mode === 'existing' ? 'Certificado localizado. Código reutilizado. 📋' : 'Certificado emitido com sucesso! 🎉',
      'success'
    );
    const mr = document.getElementById('manualReviewSection');
    if (mr) mr.remove();
    setTimeout(() => this.downloadPDF(), 800);
    if (this.resultDiv) this.resultDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  _displayCertificate() {
    if (!this.infoDiv || !this.currentCertificate) return;
    const cert = this.currentCertificate;
    const kindInfo = _getCertificateKindInfo(cert);

    const participantName = _properCase(_safeName(cert.participantName) || cert.participantName || '');
    const cpfFmt          = _fmtCpf(cert.cpfNormalized || '');
    const diasLabel       = _safeDiasLabel(cert);
    const eventName       = cert.eventName  || 'AXIS Summit';
    const eventYear       = cert.eventYear  || '2026';
    const localStr        = cert.eventLocal || 'Famecos – PUCRS · Porto Alegre, RS';
    const validCode       = _normalizeValidationCode(cert.validationCode);
    if (!validCode) throw new Error('Código de validação ausente no certificado.');

    const isSpeaker   = kindInfo.isSpeaker;
    const isRodada    = kindInfo.isRodada;
    const isAtelie    = kindInfo.isAtelie;
    const speakerRole = this._escape(String(cert.participantRole || cert.participantRoleLabel || cert.role || cert.funcao || 'Palestrante').trim());
    const panelName   = this._escape(String(cert.panelName || cert.mesa || cert.nomeMesa || '').trim());
    const specialLabelEsc = this._escape(kindInfo.specialLabel);
    const projectNameEsc = this._escape(kindInfo.projectName);

    const emissao = cert.issuedAt
      ? new Date(cert.issuedAt).toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' })
      : '—';

    const validatorURL = _buildValidationUrl(validCode);

    const eventNameEsc = this._escape(eventName);
    const eventYearEsc = this._escape(eventYear);
    const diasLabelEsc = this._escape(diasLabel);

    /* Badge e corpo — condicional por tipo */
    const badgeLabel = kindInfo.badgeLabel;
    const bodyCopy   = isSpeaker
      ? `participou como <strong>${speakerRole}</strong>${panelName ? ` na atividade <strong>"${panelName}"</strong>` : ''} do <strong>${eventNameEsc} ${eventYearEsc}</strong>, realizado em Porto Alegre, RS.`
      : isRodada
        ? `participou da <strong>${specialLabelEsc}</strong> do <strong>${eventNameEsc} ${eventYearEsc}</strong>, realizada em Porto Alegre, RS, apresentando o projeto <strong>${projectNameEsc}</strong>.`
        : isAtelie
          ? `participou do <strong>${specialLabelEsc}</strong> do <strong>${eventNameEsc} ${eventYearEsc}</strong>, realizado em Porto Alegre, RS.`
      : `participou presencialmente do <strong>${eventNameEsc} ${eventYearEsc}</strong>, realizado nos dias <strong>${diasLabelEsc}</strong>, no campus da PUCRS, em Porto Alegre.`;

    /* Metas — speaker mostra função e atividade; especiais destacam modalidade/projeto */
    const metaBlock = isSpeaker ? `
      <div class="cert-poster__meta-item">
        <span>Evento</span>
        <strong>${eventNameEsc} ${eventYearEsc}</strong>
      </div>
      <div class="cert-poster__meta-item">
        <span>Função</span>
        <strong>${speakerRole}</strong>
      </div>
      ${panelName ? `<div class="cert-poster__meta-item">
        <span>Atividade</span>
        <strong>${panelName}</strong>
      </div>` : ''}
      <div class="cert-poster__meta-item">
        <span>Emitido em</span>
        <strong>${this._escape(emissao)}</strong>
      </div>` : isRodada ? `
      <div class="cert-poster__meta-item">
        <span>Evento</span>
        <strong>${eventNameEsc} ${eventYearEsc}</strong>
      </div>
      <div class="cert-poster__meta-item">
        <span>Modalidade</span>
        <strong>${specialLabelEsc}</strong>
      </div>
      <div class="cert-poster__meta-item">
        <span>Projeto</span>
        <strong>${projectNameEsc || '—'}</strong>
      </div>
      <div class="cert-poster__meta-item">
        <span>Emitido em</span>
        <strong>${this._escape(emissao)}</strong>
      </div>` : isAtelie ? `
      <div class="cert-poster__meta-item">
        <span>Evento</span>
        <strong>${eventNameEsc} ${eventYearEsc}</strong>
      </div>
      <div class="cert-poster__meta-item">
        <span>Modalidade</span>
        <strong>${specialLabelEsc}</strong>
      </div>
      <div class="cert-poster__meta-item">
        <span>Local</span>
        <strong>Porto Alegre, RS</strong>
      </div>
      <div class="cert-poster__meta-item">
        <span>Emitido em</span>
        <strong>${this._escape(emissao)}</strong>
      </div>` : `
      <div class="cert-poster__meta-item">
        <span>Evento</span>
        <strong>${eventNameEsc} ${eventYearEsc}</strong>
      </div>
      <div class="cert-poster__meta-item">
        <span>Período</span>
        <strong>${diasLabelEsc}</strong>
      </div>
      <div class="cert-poster__meta-item">
        <span>Local</span>
        <strong>${this._escape(localStr)}</strong>
      </div>
      <div class="cert-poster__meta-item">
        <span>Emitido em</span>
        <strong>${this._escape(emissao)}</strong>
      </div>`;

    /* Caminho do asset de logos — pode ser sobrescrito via window.AXIS_LOGOS_BAR_URL */
    const logosBarSrc = _resolveLogosBarAsset();

    this.infoDiv.innerHTML = `
      <article class="cert-poster${isSpeaker ? ' cert-poster--speaker' : ''}">
        <span class="cert-poster__vertical">${this._escape(kindInfo.verticalLabel)}</span>
        <div class="cert-poster__layout">
          <section class="cert-poster__main">
            <div class="cert-poster__header">
              <div class="cert-poster__axis">
                ${eventNameEsc}<span>${eventYearEsc}</span>
              </div>
              <div class="cert-poster__badge-wrap">
                <div class="cert-poster__badge${isSpeaker ? ' cert-poster__badge--speaker' : ''}">${this._escape(badgeLabel)}</div>
              </div>
            </div>
            <p class="cert-poster__intro">Certificamos que</p>
            <h2 class="cert-poster__name">${this._escape(participantName)}</h2>
            ${cpfFmt ? `<p class="cert-poster__cpf">CPF: ${this._escape(cpfFmt)}</p>` : ''}
            <p class="cert-poster__body">${bodyCopy}</p>
            <div class="cert-poster__meta">
              ${metaBlock}
            </div>
            <p class="cert-poster__institutional">
              Gudi · Secretaria da Cultura · Governo do Estado do RS
            </p>
          </section>

          <aside class="cert-auth">
            <p class="cert-auth__eyebrow">Autenticação digital</p>
            <div class="cert-auth__qr" id="certQrPreview"><div></div></div>
            <p class="cert-auth__qr-hint">Escaneie para verificar</p>
            <p class="cert-auth__code-label">Código de validação</p>
            <div class="cert-auth__code">${this._escape(validCode)}</div>
            <div class="cert-auth__url">
              <span>Validação online</span>
              <a href="${this._escape(validatorURL)}" target="_blank" rel="noopener">
                portfolio.example/certificates/validate
              </a>
            </div>
          </aside>
        </div>

        <!-- Barra de logos institucional — aparece no preview e reflete o PDF -->
        <div class="cert-poster__logos-bar">
          <img
            src="${this._escape(logosBarSrc)}"
            alt="Parceiros e apoio institucional — AXIS Summit 2026"
            loading="eager"
            decoding="async"
          />
        </div>
      </article>
    `;

    const qrHost = document.getElementById('certQrPreview')?.querySelector('div');
    if (qrHost) this._renderPreviewQR(qrHost, validatorURL);
    if (this.resultDiv) this.resultDiv.classList.add('show');
  }

  _renderPreviewQR(container, value) {
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    const qrValue = String(value || '').trim();
    if (!qrValue) {
      throw new Error('URL de validação ausente para o QR code.');
    }

    try {
      if (typeof QRCode === 'undefined') {
        throw new Error('Biblioteca de QR code não carregada.');
      }
      new QRCode(container, { text: qrValue, width: 240, height: 240, colorDark: '#08090f', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H });
      if (!container.querySelector('canvas') && !container.querySelector('img')) {
        throw new Error('Falha ao renderizar o QR code.');
      }
    } catch(err) {
      while (container.firstChild) container.removeChild(container.firstChild);
      throw err;
    }
  }

  async downloadPDF() {
    if (!this.currentCertificate) { this._showMessage('Nenhum certificado para baixar.', 'error'); return; }
    try {
      this._showMessage('Gerando PDF em A4 horizontal…', 'info');
      await AxisCertificatePDF.generate(this.currentCertificate);
      this._showMessage('PDF baixado com sucesso! 📥', 'success');
    } catch(err) {
      this._showMessage('Erro ao gerar PDF: ' + err.message, 'error');
    }
  }

  _openValidator() {
    const code = _normalizeValidationCode(this.currentCertificate?.validationCode || '');
    if (!_isValidationCodeFormat(code)) {
      this._showMessage('Código de validação inválido no certificado atual.', 'error');
      return;
    }
    window.open(_buildValidationUrl(code), '_blank');
  }

  _setLoading(loading) {
    if (!this.emitBtn) return;
    const spinner = this.emitBtn.querySelector('.loading-spinner');
    const text    = this.emitBtn.querySelector('span');
    this.emitBtn.disabled = loading;
    if (spinner) spinner.style.display = loading ? 'inline-block' : 'none';
    if (text)    text.textContent      = loading ? 'Processando...' : 'Emitir Certificado';
  }

  _showMessage(msg, type) {
    if (!this.messageDiv) return;
    this.messageDiv.textContent   = msg;
    this.messageDiv.className     = 'message message--' + (type||'info');
    this.messageDiv.style.display = 'block';
    if (type === 'success') { clearTimeout(this._msgTimer); this._msgTimer = setTimeout(() => this._hideMessage(), 12000); }
  }

  _hideMessage() { if (this.messageDiv) this.messageDiv.style.display = 'none'; }

  _escape(str) {
    return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
}

/* ── Inicialização ── */
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('certificateForm')) return;
  if (window.certificateController) return;
  try {
    window.certificateController = new CertificateController();
  } catch(err) {
    console.error('[AXIS CERT] Falha na inicialização:', err);
    const d = document.getElementById('resultMessage');
    if (d) { d.textContent='Erro ao carregar sistema. Recarregue a página.'; d.className='message message--error'; d.style.display='block'; }
  }
});

/* ── Debug ── */
window.axisTestApi = async function() {
  console.log('[AXIS CERT] Testando API em:', AXIS_CERT_API_URL);
  try { const r=await new AxisCertificatesAPI().healthcheck(); console.log('[AXIS CERT] Healthcheck:', r); return r; }
  catch(e) { console.error('[AXIS CERT] Falha:', e.message); return null; }
};




