'use strict';

const crypto = require('crypto');

/**
 * Embedding backends. The default `local-hash` is a deterministic
 * bag-of-tokens embedding suitable only for hash collisions; it is
 * explicitly labeled as low semantic quality. `openai` and `hf` are
 * real semantic embedding backends; the system exposes the active
 * backend and the semantic quality on the retrieval response.
 */

const DIM = 384;

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

function localHashEmbedding(text) {
  const vec = new Array(DIM).fill(0);
  for (const tok of tokenize(text)) {
    const h = crypto.createHash('sha1').update(tok).digest();
    const idx = h.readUInt16BE(0) % DIM;
    const sign = (h[2] & 1) ? 1 : -1;
    vec[idx] += sign;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1));
}

function bm25Score(query, doc) {
  const qTerms = tokenize(query);
  const dTerms = tokenize(doc);
  if (!qTerms.length || !dTerms.length) return 0;
  const k1 = 1.5, b = 0.75;
  const dl = dTerms.length;
  const avgdl = 120;
  let score = 0;
  for (const qt of qTerms) {
    let tf = 0;
    for (const t of dTerms) if (t === qt) tf++;
    if (!tf) continue;
    const idf = Math.log(1 + 1);
    score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
  }
  return score / qTerms.length;
}

class OpenAIEmbeddings {
  constructor({ apiKey, model = 'text-embedding-3-small' } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.id = 'openai';
    this.dimension = 1536;
  }
  async embed(text) {
    if (!this.apiKey) throw new Error('openai apiKey not configured');
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) throw new Error(`openai embeddings ${res.status}`);
    const body = await res.json();
    return body.data[0].embedding;
  }
  async embedBatch(texts) {
    if (!this.apiKey) throw new Error('openai apiKey not configured');
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`openai embeddings ${res.status}`);
    const body = await res.json();
    return body.data.map((d) => d.embedding);
  }
}

class HFEmbeddings {
  constructor() {
    this.id = 'hf';
    this.dimension = 384;
  }
  async embed() { throw new Error('hf embeddings not available in this build'); }
  async embedBatch() { throw new Error('hf embeddings not available in this build'); }
}

class OllamaEmbeddings {
  constructor({ baseUrl = 'http://localhost:11434', model = 'mxbai-embed-large' } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.id = 'ollama';
    this.dimension = null;
  }

  async embed(text) {
    const url = `${this.baseUrl}/api/embeddings`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`ollama embeddings ${res.status}: ${errText.slice(0, 100)}`);
    }
    const body = await res.json();
    if (this.dimension === null && body.embedding) {
      this.dimension = body.embedding.length;
    }
    return body.embedding;
  }

  async embedBatch(texts) {
    const url = `${this.baseUrl}/api/embeddings`;
    const results = [];
    for (const text of texts) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`ollama embeddings ${res.status}: ${errText.slice(0, 100)}`);
      }
      const body = await res.json();
      results.push(body.embedding);
    }
    if (this.dimension === null && results.length > 0) {
      this.dimension = results[0].length;
    }
    return results;
  }

  async ping() {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { method: 'GET' });
      if (!res.ok) return { ok: false, error: `HTTP_${res.status}` };
      const data = await res.json();
      const hasModel = data.models?.some((m) => m.name === this.model || m.name.startsWith(this.model.split(':')[0]));
      return { ok: hasModel, model: this.model, available: hasModel, models: data.models?.length || 0 };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

class LocalHashEmbeddings {
  constructor() {
    this.id = 'local-hash';
    this.dimension = DIM;
  }
  async embed(text) { return localHashEmbedding(text); }
  async embedBatch(texts) { return texts.map((t) => localHashEmbedding(t)); }
}

function createBackend(cfg = {}) {
  if (cfg.openaiApiKey) return new OpenAIEmbeddings({ apiKey: cfg.openaiApiKey });
  if (cfg.ollamaEmbeddings === true || cfg.embeddingBackend === 'ollama') {
    return new OllamaEmbeddings({ baseUrl: cfg.ollamaBaseUrl || 'http://localhost:11434', model: cfg.ollamaEmbeddingModel || 'mxbai-embed-large' });
  }
  return new LocalHashEmbeddings();
}

module.exports = {
  createBackend,
  LocalHashEmbeddings,
  OpenAIEmbeddings,
  OllamaEmbeddings,
  HFEmbeddings,
  cosine,
  bm25Score,
  tokenize,
  localHashEmbedding,
  DIM,
};
