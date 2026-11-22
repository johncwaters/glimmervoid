const MCP_CREDENTIAL_ENV = 'GLIMMERVOID_MCP_TOKEN';
const KIMI_MCP_CONFIG_NAME = 'mcp.json';
const KIMI_MCP_BASE_NAME = '.glimmervoid-mcp-base.json';
const KIMI_PACK_SERVERS_NAME = '.glimmervoid-pack-servers.json';
const PACK_SECRET_ENV_PREFIX = 'GLIMMERVOID_PACK_';
const PACK_URL_FLAG = 'pack-url';
const PACK_SECRET_ENV_FLAG = 'pack-secret-env';

function packSecretEnvName(secret: string): string {
  return `${PACK_SECRET_ENV_PREFIX}${secret}`;
}

export {
  KIMI_MCP_BASE_NAME,
  KIMI_MCP_CONFIG_NAME,
  KIMI_PACK_SERVERS_NAME,
  MCP_CREDENTIAL_ENV,
  PACK_SECRET_ENV_FLAG,
  PACK_SECRET_ENV_PREFIX,
  PACK_URL_FLAG,
  packSecretEnvName,
};
