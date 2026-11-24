const ROW_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 45_000;

function requiredSetting(name) {
  const value = (process.env[name] ?? '').trim();
  if (value === '') throw new Error(`${name} is not set; fill it in the posthog-community pack settings`);
  return value;
}

export function sinceIso() {
  const since = process.env.GLIMMERVOID_SINCE ?? '';
  if (Number.isNaN(Date.parse(since))) throw new Error('GLIMMERVOID_SINCE is not a timestamp');
  return new Date(since).toISOString();
}

export async function runHogQL(query, values) {
  const host = (process.env.POSTHOG_HOST ?? '').trim().replace(/\/+$/, '') || 'https://us.posthog.com';
  if (!host.startsWith('https://')) throw new Error('POSTHOG_HOST must start with https://');
  const projectId = requiredSetting('POSTHOG_PROJECT_ID');
  if (!/^\d{1,12}$/.test(projectId)) throw new Error('POSTHOG_PROJECT_ID is a project number such as 2');
  const response = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${requiredSetting('POSTHOG_PERSONAL_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: `${query} LIMIT ${ROW_LIMIT}`, values } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`PostHog answered HTTP ${response.status} ${response.statusText}`);
  const body = await response.json();
  const columns = Array.isArray(body.columns) ? body.columns : [];
  const rows = Array.isArray(body.results) ? body.results : [];
  return rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, Array.isArray(row) ? row[index] : undefined])));
}

export function printItems(items) {
  process.stdout.write(`${JSON.stringify({ items })}\n`);
}

export function runSource(readItems) {
  readItems().then(printItems, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
