'use strict';
require('dotenv').config();

const env = process.env;
const isProd = (env.NODE_ENV || '').toLowerCase() === 'production';
const pgEnabled = (env.PG_ENABLED || '').toLowerCase() === 'true';
const demoMode = (env.DEMO_MODE || '').toLowerCase() === 'true';

const KNOWN_DEFAULT_SECRETS = new Set([
  'change-me-to-a-long-random-string-please',
  'admin123!change',
  'admin123!Change',
  'skyguard-local-password',
  'd0af01651ecf7fc17525d0c69fc30f52ec1aaead625b5acb39eabbe84a582736',
]);

function isWeakSecret(value) {
  if (!value || typeof value !== 'string') return true;
  if (KNOWN_DEFAULT_SECRETS.has(value)) return true;
  if (value.length < 16) return true;
  return false;
}

if (isProd && process.env.SKYGUARD_ALLOW_CONFIG_FAIL !== '1') {
  if (isWeakSecret(env.JWT_SECRET)) {
    console.error('FATAL: JWT_SECRET is weak or uses known default. Set a strong 32+ char random value.');
    process.exit(2);
  }
  if (!env.ADMIN_USERNAME || (env.ADMIN_USERNAME || '').toLowerCase() === 'admin') {
    console.error('FATAL: ADMIN_USERNAME must be set to a non-default value.');
    process.exit(2);
  }
  if (isWeakSecret(env.ADMIN_PASSWORD)) {
    console.error('FATAL: ADMIN_PASSWORD is weak. Set a strong password >= 12 chars.');
    process.exit(2);
  }
}

module.exports = {
  port: parseInt(env.PORT || '4000', 10),
  corsOrigin: env.CORS_ORIGIN || (isProd ? 'https://skyguard-ai-software.netlify.app' : '*'),
  isProduction: isProd,
  nodeEnv: env.NODE_ENV || 'development',
  demoMode,

  influx: {
    url: env.INFLUX_URL || 'http://localhost:8086',
    token: env.INFLUX_TOKEN || '',
    org: env.INFLUX_ORG || 'skyguard',
    bucket: env.INFLUX_BUCKET || 'env_data',
    enabled: (env.USE_INFLUXDB || 'false').toLowerCase() === 'true',
  },

  pg: {
    enabled: pgEnabled,
    host: env.PG_HOST || 'localhost',
    port: parseInt(env.PG_PORT || '5432', 10),
    user: env.PG_USER || 'skyguard',
    password: env.PG_PASSWORD || 'ChangeMeToSecurePGPass123!',
    database: env.PG_DATABASE || 'skyguard',
  },

  auth: {
    jwtSecret: env.JWT_SECRET || 'change-me-to-a-long-random-string-please',
    expiresHours: parseInt(env.JWT_EXPIRES_HOURS || '12', 10),
    adminUsername: env.ADMIN_USERNAME,
    adminPassword: env.ADMIN_PASSWORD,
  },

  sim: {
    tickMs: parseInt(env.TICK_MS || '2500', 10),
    stationCount: parseInt(env.STATION_COUNT || '5', 10),
  },

  provider: {
    mode: env.PROVIDER_MODE || 'open-meteo',
    timeoutMs: parseInt(env.PROVIDER_TIMEOUT_MS || '4000', 10),
    retry: parseInt(env.PROVIDER_RETRY || '1', 10),
    maxStaleSeconds: parseInt(env.PROVIDER_MAX_STALE_SECONDS || '1800', 10),
    failover: (env.PROVIDER_FAILOVER || 'true').toLowerCase() === 'true',
    openWeatherApiKey: env.OPENWEATHER_API_KEY || null,
  },

  llm: {
    provider: env.LLM_PROVIDER || 'deterministic-fallback',
    openaiApiKey: env.OPENAI_API_KEY || null,
    openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
    azureOpenaiEndpoint: env.AZURE_OPENAI_ENDPOINT || null,
    azureOpenaiKey: env.AZURE_OPENAI_KEY || null,
    azureOpenaiDeployment: env.AZURE_OPENAI_DEPLOYMENT || null,
    azureOpenaiApiVersion: env.AZURE_OPENAI_API_VERSION || '2024-06-01',
    ollamaBaseUrl: env.OLLAMA_BASE_URL || 'http://localhost:11434',
    ollamaModel: env.OLLAMA_MODEL || 'qwen2.5:7b',
    dailyTokenBudget: parseInt(env.LLM_DAILY_TOKEN_BUDGET || '200000', 10),
    maxTokensPerCall: parseInt(env.LLM_MAX_TOKENS_PER_CALL || '1500', 10),
  },

  rag: {
    embeddingBackend: env.EMBEDDING_BACKEND || 'local-hash',
    openaiEmbeddings: (env.OPENAI_EMBEDDINGS || 'false').toLowerCase() === 'true',
    hfEmbeddings: (env.HF_EMBEDDINGS || 'false').toLowerCase() === 'true',
    hfModel: env.HF_EMBEDDINGS_MODEL || 'Xenova/all-MiniLM-L6-v2',
    ollamaEmbeddings: (env.OLLAMA_EMBEDDINGS || 'false').toLowerCase() === 'true',
    ollamaEmbeddingModel: env.OLLAMA_EMBEDDING_MODEL || 'mxbai-embed-large',
  },

  egress: {
    webhookAllowlist: (env.WEBHOOK_EGRESS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
    blockPrivateNetworks: (env.WEBHOOK_BLOCK_PRIVATE || 'true').toLowerCase() === 'true',
  },

  alerting: {
    rateLimitPerMinute: parseInt(env.ALERT_RATE_LIMIT_PER_MIN || '10', 10),
  },
};
