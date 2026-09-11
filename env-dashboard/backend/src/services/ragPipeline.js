'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let knowledge = null;
try { knowledge = require('./knowledge'); } catch (_) {}

const embeddings = require('./rag/embeddings');

const RETRIEVAL_THRESHOLD = 0.3;
const MAX_CHUNK_LENGTH = 1000;
const RERANK_TOP_K = 5;
const VECTOR_WEIGHT = 0.7;
const BM25_WEIGHT = 0.3;

class RAGPipeline {
  constructor(opts = {}) {
    this.documents = new Map();
    this.chunks = [];
    this.index = new Map();
    this.conflicts = [];
    this.embeddingsByChunk = new Map();
    this.embeddingBackend = opts.embeddingBackend || embeddings.createBackend(opts);
    this.mode = this._detectMode();
    this._indexPath = opts.indexPath || path.join(__dirname, '..', '..', 'knowledge', 'embeddings.json');
    this._embeddingModel = opts.ollamaEmbeddingModel || 'mxbai-embed-large';
    this._embeddingVersion = '1.0';
    this._loadIndex();
  }

  _detectMode() {
    if (this.embeddingBackend instanceof embeddings.OpenAIEmbeddings) return 'semantic';
    if (this.embeddingBackend instanceof embeddings.OllamaEmbeddings) return 'semantic';
    return 'degraded';
  }

  _loadIndex() {
    try {
      if (!fs.existsSync(this._indexPath)) return;
      const data = JSON.parse(fs.readFileSync(this._indexPath, 'utf8'));
      if (data.embeddingModel !== this._embeddingModel) return;
      if (data.embeddingVersion !== this._embeddingVersion) return;
      for (const [chunkId, emb] of (data.embeddings || [])) {
        if (emb) this.embeddingsByChunk.set(chunkId, emb);
      }
    } catch (e) {
      // corrupted index - will re-index on next ingest
    }
  }

  _saveIndex() {
    try {
      const embeddings = [...this.embeddingsByChunk.entries()].filter(([, v]) => v !== null);
      const data = {
        embeddingModel: this._embeddingModel,
        embeddingVersion: this._embeddingVersion,
        dimension: this.embeddingBackend.dimension || null,
        savedAt: new Date().toISOString(),
        embeddings,
      };
      fs.mkdirSync(path.dirname(this._indexPath), { recursive: true });
      fs.writeFileSync(this._indexPath, JSON.stringify(data));
    } catch (e) {
      // persist failure is non-fatal
    }
  }

  setEmbeddingBackend(backend) {
    this.embeddingBackend = backend;
    this.mode = this._detectMode();
  }

  getStatus() {
    return {
      mode: this.mode,
      embeddingBackend: this.embeddingBackend.id,
      embeddingModel: this._embeddingModel,
      embeddingDimension: this.embeddingBackend.dimension || null,
      semanticQuality: this.mode === 'semantic' ? 'high' : 'low',
      documents: this.documents.size,
      chunks: this.chunks.length,
      ready: [...this.documents.values()].filter((d) => d.status === 'READY').length,
      failed: [...this.documents.values()].filter((d) => d.status === 'FAILED').length,
      processing: [...this.documents.values()].filter((d) => d.status === 'PROCESSING').length,
    };
  }

  async ingestDocument({ name, content, source = 'local_upload', version = null, date = null, category = 'SYSTEM', station = null, sensorType = null, parameter = null, priority = null }) {
    if (!name || typeof content !== 'string' || !content.trim()) {
      throw new Error('name and non-empty content are required');
    }
    const id = `DOC-${crypto.createHash('sha1').update(`${name}:${content}`).digest('hex').slice(0, 12)}`;
    const fileName = `${id}.md`;
    const doc = {
      id, name, fileName, source, version, date, station, sensorType, parameter, category, priority,
      status: 'PROCESSING', createdAt: new Date().toISOString(), chunkCount: 0,
    };
    try {
      const docsDir = knowledge ? knowledge.DOCS_DIR : path.join(__dirname, '..', '..', 'knowledge', 'documents');
      fs.mkdirSync(docsDir, { recursive: true });
      fs.writeFileSync(path.join(docsDir, fileName), content);
      doc.status = 'PROCESSING';
      const result = await this.parseAndIndex(doc, content);
      doc.status = result.status;
      doc.chunkCount = result.chunkCount;
      doc.indexedAt = new Date().toISOString();
      if (result.status === 'FAILED') doc.error = result.error;
    } catch (error) {
      doc.status = 'FAILED';
      doc.error = error.message;
    }
    this.documents.set(id, doc);
    if (knowledge && knowledge.ingest) {
      try { knowledge.ingest({ name, content, source, version, date, category, station, sensorType, parameter, priority }); } catch (_) {}
    }
    return { ...doc };
  }

  async parseAndIndex(doc, content) {
    const sections = content.split(/\n(?=#{1,6}\s)/g).filter(Boolean);
    const sourceSections = sections.length ? sections : [content];
    const newChunks = [];
    for (const chunkContent of sourceSections) {
      const heading = chunkContent.match(/^#{1,6}\s+(.+)$/m);
      const chunk = {
        id: `${doc.id}:chunk-${newChunks.length + 1}`,
        documentId: doc.id,
        documentName: doc.name,
        section: heading ? heading[1].trim() : 'Document',
        source: doc.source,
        version: doc.version || null,
        date: doc.date || null,
        category: doc.category || 'SYSTEM',
        content: chunkContent.trim().slice(0, MAX_CHUNK_LENGTH),
        terms: this.tokenize(chunkContent.trim()),
      };
      newChunks.push(chunk);
      this.chunks.push(chunk);
      this.updateIndex(chunk);
      try {
        const emb = await this.embeddingBackend.embed(chunk.content);
        this.embeddingsByChunk.set(chunk.id, emb);
      } catch (e) {
        this.embeddingsByChunk.set(chunk.id, null);
      }
    }
    this._saveIndex();
    return { status: 'READY', chunkCount: newChunks.length };
  }

  tokenize(text) {
    return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  }

  updateIndex(chunk) {
    for (const term of chunk.terms) {
      if (!this.index.has(term)) this.index.set(term, new Set());
      this.index.get(term).add(chunk.id);
    }
  }

  async retrieve(query, { topK = 5, category, stationId, parameter } = {}) {
    const queryTerms = this.tokenize(query);
    if (!queryTerms.length) {
      return { query, results: [], retrievedAt: new Date().toISOString(), available: this.chunks.length > 0, mode: this.mode, embeddingBackend: this.embeddingBackend.id, semanticQuality: this.mode === 'semantic' ? 'high' : 'low', reason: 'empty_query' };
    }
    const candidateChunks = new Set();
    for (const term of queryTerms) {
      const chunkIds = this.index.get(term);
      if (chunkIds) for (const id of chunkIds) candidateChunks.add(id);
    }
    if (candidateChunks.size === 0) {
      return {
        query, results: [], retrievedAt: new Date().toISOString(),
        available: this.chunks.length > 0,
        mode: this.mode, embeddingBackend: this.embeddingBackend.id,
        semanticQuality: this.mode === 'semantic' ? 'high' : 'low',
        reason: 'no_match',
        totalCandidates: 0,
        threshold: RETRIEVAL_THRESHOLD,
      };
    }

    const queryEmbedding = await this.safeEmbedQuery(query);
    const results = [];
    for (const chunkId of candidateChunks) {
      const chunk = this.chunks.find((c) => c.id === chunkId);
      if (!chunk) continue;
      if (category && chunk.category !== category) continue;
      if (stationId && chunk.station && chunk.station !== stationId) continue;
      if (parameter && chunk.parameter && chunk.parameter !== parameter) continue;
      const uniqueTerms = new Set(chunk.terms);
      const matches = [...queryTerms].filter((term) => uniqueTerms.has(term)).length;
      const lexical = matches / queryTerms.length;
      let combined = lexical;
      if (queryEmbedding && this.embeddingsByChunk.get(chunk.id)) {
        const vec = embeddings.cosine(queryEmbedding, this.embeddingsByChunk.get(chunk.id));
        combined = VECTOR_WEIGHT * vec + BM25_WEIGHT * lexical;
      } else {
        // no embedding available — pure lexical with provenance
        combined = lexical;
      }
      if (combined > 0) {
        results.push({ ...chunk, relevance: +combined.toFixed(4), score_lexical: +lexical.toFixed(4), score_vector: queryEmbedding && this.embeddingsByChunk.get(chunk.id) ? +embeddings.cosine(queryEmbedding, this.embeddingsByChunk.get(chunk.id)).toFixed(4) : null });
      }
    }

    results.sort((a, b) => b.relevance - a.relevance);
    const filtered = results
      .filter((r) => r.relevance > 0 && (r.relevance >= RETRIEVAL_THRESHOLD || queryTerms.length === 1))
      .slice(0, Math.min(topK, RERANK_TOP_K));

    return {
      query,
      retrievedAt: new Date().toISOString(),
      available: this.chunks.length > 0,
      mode: this.mode,
      embeddingBackend: this.embeddingBackend.id,
      semanticQuality: this.mode === 'semantic' ? 'high' : 'low',
      results: filtered.map(({ terms, ...result }) => result),
      totalCandidates: results.length,
      threshold: RETRIEVAL_THRESHOLD,
    };
  }

  async safeEmbedQuery(query) {
    try { return await this.embeddingBackend.embed(query); } catch (_) { return null; }
  }

  async rerank(results, query) {
    const queryTerms = this.tokenize(query);
    return results.map((result) => {
      const terms = this.tokenize(result.content || result.section || '');
      const exactMatches = queryTerms.filter((t) => terms.includes(t)).length;
      const boostedRelevance = result.relevance + (exactMatches * 0.1);
      return { ...result, rerankedRelevance: +boostedRelevance.toFixed(2) };
    }).sort((a, b) => b.rerankedRelevance - a.rerankedRelevance);
  }

  detectConflicts(documentId) {
    const docChunks = this.chunks.filter((c) => c.documentId === documentId);
    const conflicts = [];
    for (let i = 0; i < docChunks.length; i++) {
      for (let j = i + 1; j < docChunks.length; j++) {
        if (this.hasContradiction(docChunks[i].content, docChunks[j].content)) {
          conflicts.push({
            id: `CONF-${Date.now()}-${i}-${j}`,
            documentId,
            chunk1: docChunks[i].id,
            chunk2: docChunks[j].id,
            section1: docChunks[i].section,
            section2: docChunks[j].section,
            detectedAt: new Date().toISOString(),
          });
        }
      }
    }
    this.conflicts.push(...conflicts);
    return conflicts;
  }

  hasContradiction(text1, text2) {
    const negationPatterns = ['not', 'never', 'must not', 'should not', 'do not', 'cannot'];
    for (const pattern of negationPatterns) {
      if (text1.includes(pattern) && !text2.includes(pattern)) return true;
      if (text2.includes(pattern) && !text1.includes(pattern)) return true;
    }
    return false;
  }

  getDocument(id) {
    return this.documents.get(id) || null;
  }

  getAllDocuments() {
    return [...this.documents.values()].map((d) => ({ ...d }));
  }

  getStats() {
    return {
      ...this.getStatus(),
      conflicts: this.conflicts.length,
      indexTerms: this.index.size,
    };
  }

  async reindex() {
    this.chunks = [];
    this.index.clear();
    this.embeddingsByChunk.clear();
    for (const doc of this.documents.values()) {
      if (doc.status === 'READY' || doc.status === 'PROCESSING') {
        try {
          const content = fs.readFileSync(path.join(knowledge.DOCS_DIR, doc.fileName), 'utf8');
          const result = await this.parseAndIndex(doc, content);
          doc.chunkCount = result.chunkCount;
          doc.status = 'READY';
          doc.indexedAt = new Date().toISOString();
        } catch (e) {
          doc.status = 'FAILED';
          doc.error = e.message;
        }
      }
    }
    this._saveIndex();
    return this.getStats();
  }
}

module.exports = { RAGPipeline, RETRIEVAL_THRESHOLD, VECTOR_WEIGHT, BM25_WEIGHT };
