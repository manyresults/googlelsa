# googlelsa

Polls Google Ads **Local Services Ads** leads every 15 minutes and POSTs each new lead as JSON to a webhook (e.g. a Zapier catch hook feeding LeadConnector).

## Setup
1. `cp .env.example .env` and fill in the values (`WEBHOOK_URL` = your Zapier webhook URL).
2. `npm start` (long-running, polls every `POLL_INTERVAL_MINUTES`) or `npm run once` (single poll, for cron).
3. `npm test`

Requires Node 18+, no dependencies. Auth uses an OAuth refresh token + Google Ads developer token.

## Payload
```json
{ "leadId": "", "phone": "", "email": "", "firstName": "", "lastName": "",
  "companyName": "", "address": "", "city": "", "state": "", "postalCode": "", "notes": "" }
```
- The Local Services Ads API only exposes consumer name, phone and email (plus lead type/status, category, service, message). `address`, `city`, `state`, `postalCode` are always sent empty. Lead details go into `notes`.
- Phone-call leads typically have no name or email, only a phone number. When the name is missing it defaults to "Potential Customer" (Google's own label). Otherwise the name is split into first/last.

## De-duplication
Posted lead IDs are saved in `STATE_FILE` before moving on. Each poll queries the last `LOOKBACK_HOURS` (48) and skips IDs already sent. Failed POSTs (3 tries with backoff) are retried on the next poll.

## Hosting
Needs a persistent disk for `STATE_FILE` — use a VM, Railway/Fly/Render with a volume, or cron + `npm run once`. Vercel/serverless filesystems are ephemeral and would re-post leads.
