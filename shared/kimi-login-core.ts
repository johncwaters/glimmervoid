const KIMI_PROVIDER_TABLE = '[providers."managed:kimi-code"]';
const KIMI_PROVIDER_OAUTH_TABLE = '[providers."managed:kimi-code".oauth]';
const KIMI_DEFAULT_OAUTH_HOST = 'https://auth.kimi.com';
const KIMI_DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1';
const KIMI_DEFAULT_CREDENTIALS_NAME = 'kimi-code';
const KIMI_CREDENTIALS_FOLDER_NAME = 'credentials';
const KIMI_OAUTH_KEY_PREFIX = 'oauth/';
const KIMI_FILE_STORAGE = 'file';
const KIMI_PROVIDER_MENTION = 'managed:kimi-code';

const TOML_TRAILING_COMMENT = /\s*#[^"']*$/;
const TOML_STRING_ASSIGNMENT = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/;

interface KimiLoginSource {
  tokenFileSegments: readonly string[];
  credentialsName: string;
  oauthHost: string;
  baseUrl: string;
}

type KimiLoginResolution = KimiLoginSource | { refusal: string };

function providerStringsByTable(configText: string): Map<string, Map<string, string>> {
  const stringsByTable = new Map<string, Map<string, string>>();
  let currentTable = '';
  for (const line of configText.split(/\r?\n/)) {
    if (line.trimStart().startsWith('[')) {
      currentTable = line.replace(TOML_TRAILING_COMMENT, '').replaceAll(/\s+/g, '');
      continue;
    }
    const assignment = TOML_STRING_ASSIGNMENT.exec(line);
    if (!assignment) continue;
    const tableStrings = stringsByTable.get(currentTable) ?? new Map<string, string>();
    tableStrings.set(assignment[1], assignment[2] ?? assignment[3] ?? '');
    stringsByTable.set(currentTable, tableStrings);
  }
  return stringsByTable;
}

function tokenStorageName(oauthKey: string): string | null {
  const name = oauthKey.startsWith(KIMI_OAUTH_KEY_PREFIX) ? oauthKey.slice(KIMI_OAUTH_KEY_PREFIX.length) : oauthKey;
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name.startsWith('.')) return null;
  return name;
}

function loginSourceWith(credentialsName: string, oauthHost: string, baseUrl: string): KimiLoginSource {
  return { tokenFileSegments: [KIMI_CREDENTIALS_FOLDER_NAME, `${credentialsName}.json`], credentialsName, oauthHost, baseUrl };
}

function kimiLoginSource(configText: string | null, env: Readonly<Record<string, string | undefined>> = {}): KimiLoginResolution {
  const stringsByTable = configText === null ? new Map<string, Map<string, string>>() : providerStringsByTable(configText);
  const baseUrl = env.KIMI_CODE_BASE_URL?.trim() || stringsByTable.get(KIMI_PROVIDER_TABLE)?.get('base_url') || KIMI_DEFAULT_BASE_URL;
  const oauth = stringsByTable.get(KIMI_PROVIDER_OAUTH_TABLE);
  if (oauth === undefined && configText?.includes(KIMI_PROVIDER_MENTION) && /\boauth\b/.test(configText)) return { refusal: 'its Kimi Code config writes the managed:kimi-code oauth login in a form Glimmervoid does not read; keep it as the [providers."managed:kimi-code".oauth] table Kimi Code writes' };
  if (oauth === undefined) return loginSourceWith(KIMI_DEFAULT_CREDENTIALS_NAME, KIMI_DEFAULT_OAUTH_HOST, baseUrl);
  if ((oauth.get('storage') ?? KIMI_FILE_STORAGE) !== KIMI_FILE_STORAGE) return { refusal: 'Kimi Code keeps its login in the system keyring, and the sandbox places only a login kept in a file' };
  const oauthKey = oauth.get('key');
  const credentialsName = oauthKey === undefined ? KIMI_DEFAULT_CREDENTIALS_NAME : tokenStorageName(oauthKey);
  if (credentialsName === null) return { refusal: 'its Kimi Code oauth key does not name a login file' };
  return loginSourceWith(credentialsName, oauth.get('oauth_host') ?? KIMI_DEFAULT_OAUTH_HOST, baseUrl);
}

export { kimiLoginSource };
