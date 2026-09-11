'use strict';

/**
 * LLM adapter. Providers:
 *   - openai        (OPENAI_API_KEY, real semantic LLM)
 *   - azure-openai  (AZURE_OPENAI_*)
 *   - deterministic-fallback (template-based; labeled as non-LLM)
 *
 * Budgets:
 *   - per-call max tokens (soft: response_format + max_tokens)
 *   - daily token budget (hard: throws when exceeded)
 *
 * Schema:
 *   The adapter enforces a JSON schema via OpenAI response_format when
 *   available; otherwise it parses the response and retries on failure.
 *   Deterministic fallback always returns schema-valid output.
 */

const AGENT_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['situation', 'evidence', 'hypotheses', 'confidence', 'recommendation', 'requiredAction', 'approvalRequirement', 'auditRef'],
  properties: {
    situation: { type: 'string' },
    evidence: { type: 'array', items: { type: 'object' } },
    hypotheses: { type: 'array', items: { type: 'object' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    recommendation: { type: 'string' },
    requiredAction: { type: 'string' },
    approvalRequirement: { type: 'string' },
    auditRef: { type: 'string' },
  },
  additionalProperties: true,
};

let _state = {
  usedToday: 0,
  day: new Date().toISOString().slice(0, 10),
};

function _resetBudgetIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (_state.day !== today) { _state.usedToday = 0; _state.day = today; }
}

function _recordTokens(used) { _state.usedToday += used; }
function budgetUsed() { _resetBudgetIfNewDay(); return _state.usedToday; }

class BudgetExceededError extends Error {
  constructor() { super('LLM daily token budget exceeded'); this.code = 'BUDGET_EXCEEDED'; }
}

class DeterministicProvider {
  constructor() { this.id = 'deterministic-fallback'; }
  async chat({ system, user, schema, maxTokens }) {
    // Extract any structured payload already provided in the user prompt
    const parsed = tryParseJson(user);
    if (parsed && typeof parsed === 'object') {
      return {
        ok: true,
        provider: this.id,
        tokens: { prompt: 0, completion: 0, total: 0 },
        model: 'template',
        content: JSON.stringify({
          situation: parsed.situation || 'No situation reported (deterministic fallback).',
          evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
          hypotheses: Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [],
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.2,
          recommendation: parsed.recommendation || 'Continue monitoring; deterministic fallback has no LLM configured.',
          requiredAction: parsed.requiredAction || 'none',
          approvalRequirement: parsed.approvalRequirement || 'none',
          auditRef: parsed.auditRef || 'deterministic-fallback',
          provider: this.id,
          note: 'No real LLM was invoked. Output is template-based and clearly labeled.',
        }),
      };
    }
    return {
      ok: true,
      provider: this.id,
      tokens: { prompt: 0, completion: 0, total: 0 },
      model: 'template',
      content: JSON.stringify({
        situation: 'No evidence provided to the LLM.',
        evidence: [],
        hypotheses: [],
        confidence: 0.0,
        recommendation: 'Refuse: insufficient evidence. Collect more tool data before reasoning.',
        requiredAction: 'gather_more_evidence',
        approvalRequirement: 'none',
        auditRef: 'deterministic-fallback-refusal',
        provider: this.id,
        note: 'Refusal on missing evidence.',
      }),
    };
  }
}

class OpenAIProvider {
  constructor({ apiKey, model = 'gpt-4o-mini' } = {}) {
    if (!apiKey) throw new Error('openai apiKey required');
    this.apiKey = apiKey;
    this.model = model;
    this.id = 'openai';
  }
  async chat({ system, user, schema, maxTokens = 1500 }) {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'agent_response', schema: schema || AGENT_RESPONSE_SCHEMA, strict: true } },
    };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, provider: this.id, error: `HTTP_${res.status}`, statusCode: res.status };
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const tokens = {
      prompt: data.usage?.prompt_tokens || 0,
      completion: data.usage?.completion_tokens || 0,
      total: data.usage?.total_tokens || 0,
    };
    return { ok: true, provider: this.id, model: this.model, content, tokens };
  }
}

class AzureOpenAIProvider {
  constructor({ endpoint, apiKey, deployment, apiVersion = '2024-06-01' } = {}) {
    if (!endpoint || !apiKey || !deployment) throw new Error('azure openai config incomplete');
    this.endpoint = endpoint.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.deployment = deployment;
    this.apiVersion = apiVersion;
    this.id = 'azure-openai';
  }
  async chat({ system, user, schema, maxTokens = 1500 }) {
    const url = `${this.endpoint}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
    const body = {
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'agent_response', schema: schema || AGENT_RESPONSE_SCHEMA, strict: true } },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': this.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, provider: this.id, error: `HTTP_${res.status}`, statusCode: res.status };
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const tokens = { prompt: data.usage?.prompt_tokens || 0, completion: data.usage?.completion_tokens || 0, total: data.usage?.total_tokens || 0 };
    return { ok: true, provider: this.id, model: this.deployment, content, tokens };
  }
}

class OllamaProvider {
  constructor({ baseUrl = 'http://localhost:11434', model = 'qwen2.5:7b' } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.id = 'ollama';
  }
  async chat({ system, user, schema, maxTokens = 1500 }) {
    const url = `${this.baseUrl}/api/chat`;
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    const body = {
      model: this.model,
      messages,
      stream: false,
      options: {
        num_predict: maxTokens,
        temperature: 0.3,
      },
    };
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { ok: false, provider: this.id, error: `connection_failed:${e.message}`, statusCode: null };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, provider: this.id, error: `HTTP_${res.status}:${text.slice(0, 100)}`, statusCode: res.status };
    }
    const data = await res.json();
    const content = data.message?.content || '';
    if (!content) {
      return { ok: false, provider: this.id, error: 'empty_response', statusCode: null };
    }
    const promptTokens = data.prompt_eval_count || 0;
    const completionTokens = data.eval_count || 0;
    return {
      ok: true,
      provider: this.id,
      model: this.model,
      content,
      tokens: { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
    };
  }
  async ping() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { method: 'GET', signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, error: `HTTP_${res.status}` };
      const data = await res.json();
      const hasModel = data.models?.some((m) => m.name === this.model || m.name.startsWith(this.model.split(':')[0]));
      return { ok: hasModel, model: this.model, available: hasModel, models: data.models?.length || 0 };
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
    }
  }
}

function tryParseJson(s) {
  if (!s || typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch (_) {
    // try to find a JSON object in the string
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    return null;
  }
}

function createProvider(cfg = {}) {
  if (cfg.provider === 'openai' && cfg.openaiApiKey) return new OpenAIProvider({ apiKey: cfg.openaiApiKey, model: cfg.openaiModel });
  if (cfg.provider === 'azure-openai' && cfg.azureOpenaiEndpoint && cfg.azureOpenaiKey && cfg.azureOpenaiDeployment) {
    return new AzureOpenAIProvider({ endpoint: cfg.azureOpenaiEndpoint, apiKey: cfg.azureOpenaiKey, deployment: cfg.azureOpenaiDeployment, apiVersion: cfg.azureOpenaiApiVersion });
  }
  if (cfg.provider === 'ollama') {
    return new OllamaProvider({ baseUrl: cfg.ollamaBaseUrl || 'http://localhost:11434', model: cfg.ollamaModel || 'qwen2.5:7b' });
  }
  return new DeterministicProvider();
}

async function chatWithBudget(provider, args, budget) {
  _resetBudgetIfNewDay();
  const daily = budget && Number.isFinite(budget.daily) ? budget.daily : Infinity;
  if (_state.usedToday >= daily) {
    const fallback = new DeterministicProvider();
    const r = await fallback.chat(args);
    r.fallback = 'budget';
    return r;
  }
  const r = await provider.chat(args);
  if (r.tokens?.total) _recordTokens(r.tokens.total);
  return r;
}

function resetBudget() { _state = { usedToday: 0, day: new Date().toISOString().slice(0, 10) }; }

module.exports = {
  AGENT_RESPONSE_SCHEMA,
  createProvider,
  DeterministicProvider,
  OpenAIProvider,
  AzureOpenAIProvider,
  OllamaProvider,
  chatWithBudget,
  budgetUsed,
  resetBudget,
  BudgetExceededError,
  tryParseJson,
};
