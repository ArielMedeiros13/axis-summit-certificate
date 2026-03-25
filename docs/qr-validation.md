# QR Validation

## Problem

The summit needed a way to confirm attendance at individual sessions without relying on paper lists, manual counting, or a dedicated mobile app. The flow had to be fast for attendees, manageable for staff, and resistant to duplicate or invalid submissions.

## Approach

Each eligible activity is synchronized into the operational spreadsheet with a deterministic activity ID and an HMAC-SHA256 signed token. The admin QR panel generates posters, direct links, and raw QR images. The public check-in page validates the token server-side before accepting attendee details. The backend stores confirmed attendance with per-activity, per-email duplicate detection under `LockService`.

## Implementation Notes

### Activity sync — `axis-credenciamento.gs`

- **`sincronizarAtividades_()`**: receives schedule data (from `AXIS_EVENTS` global or the request payload), filters out `CREDENCIAMENTO` type entries via `isEligibleActivity_()`, and builds deterministic IDs with `buildActivityId_()` → `day__startTime__stage-slug__title-slug`.
- **Token generation**: `buildActivityToken_()` computes `Utilities.computeHmacSha256Signature(atividadeId, CONFIG.TOKEN_SECRET)` and takes the first 40 hex characters as the activity token.
- **Speaker extraction**: `sincronizarSpeakersData_()` runs during the same sync, collecting mediators and participants from the schedule and upserting them into the `Speakers` sheet with deduplication by normalized name.
- **Soft deactivation**: activities present in the previous sync but absent in the new one are marked `ativo: FALSE` instead of deleted, preserving historical check-in references.

### Admin panel — `web/qr/admin-qr.html` + `admin-qr.js`

- **Client-side filtering**: the panel loads all eligible events from `window.AXIS_EVENTS`, builds day/type/stage filter dropdowns dynamically, and renders a card grid. Filters apply instantly without backend calls.
- **Sync button**: sends the full `AXIS_EVENTS` array to `sincronizarAtividades`, then refreshes the API-side activity list and confirmation counts via `listarAtividadesQr` and `statsAtividadeLote`.
- **Poster export**: each activity card can generate a Canvas-based poster with the QR code, activity title, time, and stage — downloadable as PNG for physical signage. Bulk export downloads all visible posters.
- **Direct links**: each card exposes a copy-to-clipboard link pointing to `checkin-atividade.html?id=...&token=...`.

### Public check-in — `web/qr/checkin-atividade.html` + `checkin-atividade.js`

- **Token validation first**: on page load, `init()` extracts `id` and `token` from URL params and calls `validarTokenAtividade`. If the token is invalid, expired, or the activity is inactive/ineligible, the page shows an explicit error message without exposing the form.
- **State machine UI**: four mutually exclusive states — `loading`, `invalid`, `form`, `success` — so the attendee always knows what happened.
- **Attendance submission**: `confirmarCheckinAtividade_()` in the backend re-validates the token, acquires a `LockService` lock, checks `CheckinsAtividade` for an existing row with the same `atividade_id + email`, and appends only if no duplicate exists. Duplicate submissions return a success-like response with `duplicated: true`.
- **Metadata capture**: each check-in row stores `user_agent` and `ip_hint` alongside the activity and attendee fields for audit purposes.

### Shared utilities — `web/shared/axis-common.js`

- Mirrors the backend's `buildActivityId()`, `slug()`, `normalize()`, and `isEligibleActivity()` functions so the admin panel can derive activity IDs client-side before sync.
- `collectSpeakers()` extracts speaker records from the schedule payload for display purposes.

## Result

The event team gained a lightweight QR attendance workflow that was fast enough for live use, simple to distribute on printed posters, and strong enough to prevent duplicate confirmations, reject stale QR links, and give operations real-time confirmation counts — all without a dedicated mobile app or server.
