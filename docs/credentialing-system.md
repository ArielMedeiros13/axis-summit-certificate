# Credentialing System

## Problem

On-site staff needed a monitor-facing check-in interface that could authenticate operators, search participants quickly, support speaker-specific handling, register late attendees, and keep dashboard counts current during live event operations — all without a dedicated backend server.

## Approach

The credentialing system uses a dedicated monitor portal backed by a single Apps Script deployment and Google Sheets. Monitors authenticate with SHA-256 hashed credentials stored in the `Monitores` sheet, search a merged participant base, register day-specific check-ins under `LockService` protection, and create late entries that are immediately mirrored into the searchable attendee dataset.

## Implementation Notes

### Backend — `apps-script/axis-credenciamento.gs`

- **Sheet auto-provisioning**: `ensureSheets_()` creates and orders all seven operational sheets (`Monitores`, `Publico`, `Logs`, `Posterior`, `Speakers`, `Atividades`, `CheckinsAtividade`) with frozen header rows on first request.
- **Monitor login**: `loginMonitor_()` validates CPF (11 digits) and SHA-256 hashed password against the `Monitores` sheet. Inactive monitors are rejected.
- **Participant search**: `buscarParticipantes_()` normalizes the query (NFD accent stripping, lowercase), then searches `Publico`, `Speakers`, and `Posterior` in sequence, capping results at `MAX_RESULTADOS` (30) and deduplicating by `nome|email|categoria`.
- **Check-in with duplicate protection**: `registrarCheckinGeral_()` acquires a `LockService` script lock, scans `Logs` for an existing row matching `dia_evento + email_participante`, and appends only if no duplicate exists.
- **Late registration**: `cadastrarParticipantePosterior_()` appends to `Posterior` and calls `upsertPublico_()` to mirror the new entry into the searchable `Publico` sheet — both within a single lock.
- **Statistics**: `obterEstatisticas_()` groups log rows by `dia_evento` and hour, returning a `por_hora` map for the hourly flow chart.

### Frontend — `web/credentialing/monitores.html` + `monitores.js`

- **Session persistence**: the monitor session is stored in `localStorage` and rehydrated on page load, so refreshing doesn't require re-authentication.
- **Tabbed interface**: three operational tabs — public search, speaker search, and late registration — each with independent search/submit flows.
- **Hourly bar chart**: `obterEstatisticas` response drives a CSS-based bar chart showing check-in throughput by hour for the selected event day.
- **Speaker check-in**: uses the same `registrarCheckin` action with `categoria: 'speaker'`, so speaker attendance flows into the same `Logs` sheet consumed by the certificate backend.

### Shared client — `web/shared/axis-api.js`

- Single `fetch` POST transport with 18-second `AbortController` timeout.
- Explicit JSON validation — non-JSON responses surface a diagnostic error with the first 300 characters of the response body.
- `setApiUrl()` allows runtime URL override without redeploying the frontend.

## Result

The monitor team ran credentialing from a lightweight browser interface, recovered missing attendees without leaving the system, and maintained a consistent participant base for downstream certificate generation — all from a single Google Sheets datastore with no dedicated server.
