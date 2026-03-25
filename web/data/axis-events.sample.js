/*
 * Module: Redacted schedule dataset used by the QR admin panel.
 * What it does: Provides a publishable sample of the event-program sync input without exposing the real event roster.
 * Key design decisions: The structure matches the production schedule payload shape, but names, titles, and descriptions are anonymized.
 * System connections: Loaded by `web/qr/admin-qr.html`, consumed by `web/qr/admin-qr.js`, and synchronized into `apps-script/axis-credenciamento.gs`.
 */

window.AXIS_EVENTS = [
  {
    day: '2026-03-10',
    start: '09:00',
    end: '10:00',
    stage: 'Main Stage',
    eixo: 'Strategic Partnerships',
    tipo: 'CEREMONY',
    titulo: 'Opening Session: Culture as Infrastructure',
    sinopse: 'Opening keynote block used here as a representative schedule item for QR synchronization.',
    libras: true,
    mediator: { name: 'Host Speaker', inst: 'Event Host' },
    participants: [
      { name: 'Guest Speaker A', inst: 'Partner Organization' },
      { name: 'Guest Speaker B', inst: 'Public Agency' }
    ]
  },
  {
    day: '2026-03-10',
    start: '14:00',
    end: '15:30',
    stage: 'Workshop Room',
    eixo: 'Creative Technology',
    tipo: 'WORKSHOP',
    titulo: 'AI Workflow Lab for Cultural Producers',
    sinopse: 'Representative workshop used to drive speaker sync and activity-level QR generation.',
    libras: false,
    mediator: { name: 'Workshop Lead', inst: 'Innovation Studio' },
    participants: [
      { name: 'Facilitator One', inst: 'Innovation Studio' },
      { name: 'Facilitator Two', inst: 'University Lab' }
    ]
  },
  {
    day: '2026-03-11',
    start: '09:30',
    end: '10:15',
    stage: 'Main Stage',
    eixo: 'Audience Development',
    tipo: 'PANEL',
    titulo: 'Building Sustainable Cultural Audiences',
    sinopse: 'Representative panel showing the schedule shape used for admin QR poster generation.',
    libras: true,
    mediator: { name: 'Moderator', inst: 'Media Network' },
    participants: [
      { name: 'Panelist One', inst: 'Arts Center' },
      { name: 'Panelist Two', inst: 'Public Theater' }
    ]
  },
  {
    day: '2026-03-11',
    start: '14:00',
    end: '16:00',
    stage: 'Innovation Lab',
    eixo: 'Business Development',
    tipo: 'WORKSHOP',
    titulo: 'Creative Business Roundtable',
    sinopse: 'Representative business-round session used to preserve the multi-flow certificate logic.',
    libras: false,
    mediator: { name: 'Roundtable Host', inst: 'Business Program' },
    participants: []
  }
];
