import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const env = (k, d) => process.env[k] ?? d;
const required = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var ${k}`);
  return v;
};

const cfg = () => ({
  webhookUrl: required('WEBHOOK_URL'),
  developerToken: required('GOOGLE_ADS_DEVELOPER_TOKEN'),
  clientId: required('GOOGLE_ADS_CLIENT_ID'),
  clientSecret: required('GOOGLE_ADS_CLIENT_SECRET'),
  refreshToken: required('GOOGLE_ADS_REFRESH_TOKEN'),
  customerId: required('GOOGLE_ADS_CUSTOMER_ID').replace(/-/g, ''),
  loginCustomerId: env('GOOGLE_ADS_LOGIN_CUSTOMER_ID', '').replace(/-/g, ''),
  apiVersion: env('GOOGLE_ADS_API_VERSION', 'v22'),
  companyName: env('COMPANY_NAME', ''),
  intervalMs: Number(env('POLL_INTERVAL_MINUTES', '15')) * 60_000,
  lookbackHours: Number(env('LOOKBACK_HOURS', '48')),
  stateFile: env('STATE_FILE', './data/state.json'),
});

// ---- Google auth -----------------------------------------------------------

let tokenCache = { value: null, expiresAt: 0 };

async function accessToken(c) {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.value;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`OAuth token refresh failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  tokenCache = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return tokenCache.value;
}

// ---- Google Ads query ------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
// Google Ads datetime filter format: 'YYYY-MM-DD HH:MM:SS' (account time zone).
// We use a generous UTC-based lookback and rely on id de-duplication, so zone skew is harmless.
const gaqlTime = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
  `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

export function buildQuery(since) {
  return `
    SELECT
      local_services_lead.id,
      local_services_lead.resource_name,
      local_services_lead.category_id,
      local_services_lead.service_id,
      local_services_lead.lead_type,
      local_services_lead.lead_status,
      local_services_lead.creation_date_time,
      local_services_lead.locale,
      local_services_lead.note.description,
      local_services_lead.contact_details.consumer_name,
      local_services_lead.contact_details.phone_number,
      local_services_lead.contact_details.email
    FROM local_services_lead
    WHERE local_services_lead.creation_date_time >= '${gaqlTime(since)}'
    ORDER BY local_services_lead.creation_date_time ASC`;
}

async function fetchLeads(c, since) {
  const url = `https://googleads.googleapis.com/${c.apiVersion}/customers/${c.customerId}/googleAds:searchStream`;
  const headers = {
    authorization: `Bearer ${await accessToken(c)}`,
    'developer-token': c.developerToken,
    'content-type': 'application/json',
  };
  if (c.loginCustomerId) headers['login-customer-id'] = c.loginCustomerId;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query: buildQuery(since) }) });
  if (!res.ok) throw new Error(`Google Ads query failed: ${res.status} ${await res.text()}`);
  const batches = await res.json();
  return batches.flatMap((b) => b.results ?? []).map((r) => r.localServicesLead);
}

// ---- Mapping ---------------------------------------------------------------

export function toWebhookPayload(lead, companyName = '') {
  const cd = lead.contactDetails ?? {};
  const full = (cd.consumerName ?? '').trim();
  const [firstName = '', ...rest] = full.split(/\s+/).filter(Boolean);
  const notes = [
    lead.note?.description,
    `Lead type: ${lead.leadType ?? ''}`,
    `Status: ${lead.leadStatus ?? ''}`,
    `Category: ${lead.categoryId ?? ''}`,
    `Service: ${lead.serviceId ?? ''}`,
    `Created: ${lead.creationDateTime ?? ''}`,
    `Google lead ID: ${lead.id}`,
  ]
    .filter(Boolean)
    .join(' | ');
  return {
    leadId: String(lead.id),
    phone: cd.phoneNumber ?? '',
    email: cd.email ?? '',
    firstName,
    lastName: rest.join(' '),
    companyName,
    // The LSA API does not expose consumer address fields; kept for webhook schema compatibility.
    address: '',
    city: '',
    state: '',
    postalCode: '',
    notes,
  };
}

// ---- State (de-duplication) ------------------------------------------------

async function loadState(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { sent: {} };
    throw e;
  }
}

async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2));
}

// ---- Poll cycle ------------------------------------------------------------

async function postWithRetry(url, payload, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
      lastErr = new Error(`Webhook responded ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  throw lastErr;
}

export async function pollOnce(c = cfg()) {
  const state = await loadState(c.stateFile);
  const since = new Date(Date.now() - c.lookbackHours * 3_600_000);
  const leads = await fetchLeads(c, since);
  let sent = 0;
  for (const lead of leads) {
    const id = String(lead.id);
    if (state.sent[id]) continue;
    try {
      await postWithRetry(c.webhookUrl, toWebhookPayload(lead, c.companyName));
      state.sent[id] = new Date().toISOString();
      await saveState(c.stateFile, state); // persist per lead so a crash never causes a re-post
      sent++;
    } catch (e) {
      console.error(`[${new Date().toISOString()}] failed to post lead ${id}: ${e.message}`);
    }
  }
  // Prune ids older than the lookback window; they can no longer be returned by the query.
  const cutoff = Date.now() - (c.lookbackHours + 24) * 3_600_000;
  for (const [id, ts] of Object.entries(state.sent)) if (Date.parse(ts) < cutoff) delete state.sent[id];
  await saveState(c.stateFile, state);
  console.log(`[${new Date().toISOString()}] fetched ${leads.length} lead(s), posted ${sent} new`);
}

// ---- Entry point -----------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = cfg();
  const run = () => pollOnce(c).catch((e) => console.error(`[${new Date().toISOString()}] poll failed: ${e.message}`));
  if (process.argv.includes('--once')) {
    await run();
  } else {
    console.log(`Polling every ${c.intervalMs / 60_000} minutes`);
    await run();
    setInterval(run, c.intervalMs);
  }
}
