# Certificate Generation

## Problem

The event needed a certificate flow that could issue valid documents based on real attendance data while handling multiple participant categories (public, speaker, atelier, business-round), ambiguous identities across overlapping data sources, manual exceptions, and reissue requests — without creating duplicate records or breaking validation codes.

## Approach

The certificate backend resolves participant eligibility from multiple spreadsheet-backed attendance sources, normalizes identity fields (name, email, CPF with mod-11 check-digit validation), and builds a deterministic certificate key for each valid attendance context. The public issuer UI submits minimum participant data, escalates to CPF confirmation when identity is ambiguous, and generates a branded PDF only after the backend returns a validated record and validation code.

## Implementation Notes

### Backend — `apps-script/axis-certificados.gs`

- **Routing**: a single `doPost()` dispatches to `emitirCertificado`, `reemitirCertificado`, `buscarCertificado`, `validarCertificado`, `solicitarAvaliacaoCertificado`, and `cadastrarParticipanteManual` based on the `action` field. `doGet()` supports `validarCertificado` for direct URL validation.
- **Participant resolution priority**: `handleEmitCertificate_Inner_()` resolves eligibility in order — speaker profile first (`resolveSpeakerProfile_()` across `Speakers` and `LogsSpeakers` sheets), then special certificate list (`findSpecialCertificateParticipant_()`), then general presence base (`findParticipantInPresenceBase_()` across `Logs`, `Publico`, `Posterior`, `Prévia CPF`).
- **Deterministic keys**: `buildCertificateKey_(participantKey, diasKey)` produces a unique key per identity + attendance context. `generateValidationCode_(certificateKey)` produces codes in the format `AXIS-[7hex]-[3hex]`, verified by `isValidationCodeFormat_()`.
- **Safe reissue**: if a matching certificate already exists, the system calls `updateCertificateReissue_()` to increment `issue_count`, update `last_reissued_at_iso`, enrich metadata, and return the same validation code.
- **Identity step-up**: when multiple records match the same name/email combination, the backend returns `IDENTITY_CONFIRMATION_REQUIRED` with `requiresCpf: true`. The frontend then reveals the CPF field and resubmits.
- **Rate limiting**: `_checkRateLimit_()` hashes `action + normalized identity fields` with SHA-256 and stores counts in `CacheService` with 60-second TTL. Per-action budgets: 10 emissions, 30 validations, 10 lookups, 3 manual reviews.
- **Concurrency**: `handleEmitCertificate_()` and `handleManualParticipantUpsert_()` acquire `LockService.getScriptLock()` with a 10-second timeout before any write.
- **Manual review fallback**: `handleManualReview_()` validates input, checks for recent duplicate requests (audit log scan + CacheService flag), and sends a structured email via `MailApp`/`GmailApp` to `CERT_CONFIG.MANUAL_REVIEW_EMAIL`.
- **Manual admin upsert**: `handleManualParticipantUpsert_()` normalizes input, routes to `upsertManualSpeaker_()` or `upsertManualPublicParticipant_()`, and writes into `Speakers`/`Publico`/`Posterior` sheets with upsert-by-CPF-or-email logic.
- **Editorial case normalization**: `normalizeEditorialCase_()` applies Portuguese-aware title casing with segment-boundary detection, lowercase preposition/article handling, and acronym preservation (`EDITORIAL_SPECIAL_WORDS`).
- **CPF validation**: `normalizeCpf_()` handles numeric types, scientific notation strings, strips non-digits, rejects all-same-digit sequences, and validates both mod-11 check digits.
- **Honeypot**: every request includes a `_trap` field; the backend rejects any non-empty value immediately.
- **Audit trail**: `logCertificateAudit_()` appends timestamped entries to `AuditoriaCertificados` for every issuance, reissue, validation, manual review, and error.

### Frontend — `web/certificates/certificados.html` + `certificados-v3.js`

- **API client class**: `AxisCertificatesAPI` wraps all six backend actions with `fetch` POST transport and explicit JSON parsing with error diagnostics.
- **Issuance flow**: form submission calls `emitirCertificado`. On success, the response populates a branded certificate preview in HTML. On `IDENTITY_CONFIRMATION_REQUIRED`, a CPF input appears and the form resubmits with the added field.
- **Certificate preview**: the poster is a two-column grid — main content panel (paper aesthetic with clip-path corner fold) and auth column (QR code + validation code + verification URL). Speaker certificates get visual differentiation: warm gradient background, orange border, distinct badge.
- **QR embedding**: `QRCode.js` renders a validation URL into the auth column, linking directly to `certificados-validator-v3.html?code=AXIS-XXXXXXX-XXX`.
- **PDF export**: `html2canvas` captures the certificate poster at a fixed 620px width (`.cert-poster--capturing` class), then `jsPDF` places the image on an A4 landscape page with the institutional logos bar.
- **Manual review form**: if issuance fails, a fallback form collects name, email, CPF, days, and an observation field, then calls `solicitarAvaliacaoCertificado` to trigger an email to the review team.

### Validator — `web/certificates/certificados-validator-v3.html`

- Accepts a validation code via URL parameter or manual input.
- Calls `validarCertificado` and displays the participant name, days, and issuance date if the code is valid and the certificate is active.

### Admin — `web/certificates/certificados-admin.html` + `certificados-admin.js`

- Provides a form to manually upsert speakers (with activity name and job title) or public participants (with day selection) directly into the shared data model.
- Uses `cadastrarParticipanteManual` action, which writes into the same sheets the issuance backend reads from.

## Result

The team issued production-ready certificates from live attendance data, supported special-case participants (speakers, atelier, business rounds) without branching the system, and kept public validation and reissue behavior consistent across all certificate types — all from a single Google Sheets datastore with full audit traceability.
