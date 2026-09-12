'use strict';

class DeterministicProvider {
  constructor() { this.id = 'deterministic-fallback'; }
  async chat({ system, user, schema, maxTokens }) {
    const parsed = this._parseJson(user);
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

  _parseJson(s) {
    if (!s || typeof s !== 'string') return null;
    try { return JSON.parse(s); }
    catch (_) {
      const m = s.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
      return null;
    }
  }
}

function createProvider(cfg = {}) {
  if (cfg.provider === 'openai' && cfg.openaiApiKey) {
    return new OpenAIProvider({ apiKey: cfg.openaiApiKey, model: cfg.openaiModel });
  }
  if (cfg.provider === 'azure-openai' && cfg.azureOpenaiEndpoint && cfg.azureOpenaiKey && cfg.azureOpenaiDeployment) {
    return new AzureOpenAIProvider({ endpoint: cfg.azureOpenaiEndpoint, apiKey: cfg.azureOpenaiKey, deployment: cfg.azureOpenaiDeployment, apiVersion: cfg.azureOpenaiApiVersion });
  }
  if (cfg.provider === 'ollama') {
    return new OllamaProvider({ baseUrl: cfg.ollamaBaseUrl || 'http://localhost:11434', model: cfg.ollamaModel || 'qwen2.5:7b' });
  }
  return new DeterministicProvider();
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
      response_format: { type: 'json_schema', json_schema: { name: 'agent_response', schema: schema || this._defaultSchema(), strict: true } },
    };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, provider: this.id, error: `HTTP_${res.status}`, statusCode: res.status };
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const tokens = { prompt: data.usage?.prompt_tokens || 0, completion: data.usage?.completion_tokens || 0, total: data.usage?.total_tokens || 0 };
    return { ok: true, provider: this.id, model: this.model, content, tokens };
  }

  _defaultSchema() {
    return {
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
      response_format: { type: 'json_schema', json_schema: { name: 'agent_response', schema: schema || this._defaultSchema(), strict: true } },
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

  _defaultSchema() {
    return {
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
  try { return JSON.parse(s); }
  catch (_) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    return null;
  }
}

let budgetUsedValue = 0;

function resetBudget() {
  budgetUsedValue = 0;
}

function budgetUsed() {
  return budgetUsedValue;
}

module.exports = {
  DeterministicProvider,
  OpenAIProvider,
  AzureOpenAIProvider,
  OllamaProvider,
  createProvider,
  tryParseJson,
  resetBudget,
  budgetUsed,
};
