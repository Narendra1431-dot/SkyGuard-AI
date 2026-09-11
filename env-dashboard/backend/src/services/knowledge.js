'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..', 'knowledge');
const DOCS_DIR = path.join(ROOT, 'documents');
const META_FILE = path.join(ROOT, 'documents.json');
const STATUSES = ['QUEUED', 'PROCESSING', 'READY', 'FAILED'];

const state = { documents: new Map(), chunks: [] };
let initialized = false;

function ensureLoaded() {
  if (initialized) return;
  initialized = true;
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  let metadata = [];
  try { metadata = JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch (_) { metadata = []; }
  if (!metadata.length) {
    for (const fileName of fs.readdirSync(DOCS_DIR).filter((name) => name.endsWith('.md'))) {
      const id = `DOC-${crypto.createHash('sha1').update(fileName).digest('hex').slice(0, 12)}`;
      metadata.push({ id, name: fileName.replace(/\.md$/, ''), fileName, source: 'bundled_project_documentation', category: 'SYSTEM', status: 'READY', createdAt: new Date().toISOString() });
    }
  }
  for (const doc of metadata) state.documents.set(doc.id, doc);
  for (const doc of state.documents.values()) if (doc.status === 'READY') indexDocument(doc);
}

function tokens(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
}

function saveMetadata() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify([...state.documents.values()], null, 2));
}

function indexDocument(doc) {
  state.chunks = state.chunks.filter((chunk) => chunk.documentId !== doc.id);
  const text = fs.readFileSync(path.join(DOCS_DIR, doc.fileName), 'utf8');
  const sections = text.split(/\n(?=#{1,6}\s)/g).filter(Boolean);
  const sourceSections = sections.length ? sections : [text];
  sourceSections.forEach((content, index) => {
    const heading = content.match(/^#{1,6}\s+(.+)$/m);
    state.chunks.push({
      id: `${doc.id}:chunk-${index + 1}`,
      documentId: doc.id,
      documentName: doc.name,
      section: heading ? heading[1].trim() : 'Document',
      source: doc.source,
      version: doc.version || null,
      date: doc.date || null,
      category: doc.category || 'SYSTEM',
      content: content.trim(),
      terms: tokens(content),
    });
  });
}

function ingest({ name, content, source = 'local_upload', version = null, date = null, category = 'SYSTEM', station = null, sensorType = null, parameter = null, priority = null }) {
  ensureLoaded();
  if (!name || typeof content !== 'string' || !content.trim()) throw new Error('name and non-empty content are required');
  const id = `DOC-${crypto.createHash('sha1').update(`${name}:${content}`).digest('hex').slice(0, 12)}`;
  const fileName = `${id}.md`;
  const doc = { id, name, fileName, source, version, date, station, sensorType, parameter, category, priority, status: 'PROCESSING', createdAt: new Date().toISOString(), chunkCount: 0 };
  fs.writeFileSync(path.join(DOCS_DIR, fileName), content);
  state.documents.set(id, doc);
  try {
    indexDocument(doc);
    doc.chunkCount = state.chunks.filter((chunk) => chunk.documentId === id).length;
    doc.status = 'READY';
    doc.indexedAt = new Date().toISOString();
  } catch (error) {
    doc.status = 'FAILED';
    doc.error = error.message;
  }
  saveMetadata();
  return { ...doc };
}

function search(query, { topK = 5, category, stationId, parameter } = {}) {
  ensureLoaded();
  const queryTerms = new Set(tokens(query));
  if (!queryTerms.size) return { query, results: [], retrievedAt: new Date().toISOString(), available: state.chunks.length > 0 };
  const results = state.chunks.map((chunk) => {
    if (category && chunk.category !== category) return null;
    if (stationId && chunk.station && chunk.station !== stationId) return null;
    if (parameter && chunk.parameter && chunk.parameter !== parameter) return null;
    const unique = new Set(chunk.terms);
    const matches = [...queryTerms].filter((term) => unique.has(term)).length;
    const relevance = matches / queryTerms.size;
    return relevance > 0 ? { ...chunk, relevance: +relevance.toFixed(2) } : null;
  }).filter(Boolean).sort((a, b) => b.relevance - a.relevance).slice(0, Math.min(Number(topK) || 5, 20));
  return {
    query,
    retrievedAt: new Date().toISOString(),
    available: state.chunks.length > 0,
    results: results.map(({ terms, ...result }) => result),
  };
}

function list() { ensureLoaded(); return [...state.documents.values()].map((doc) => ({ ...doc })); }
function stats() { ensureLoaded(); return { documents: state.documents.size, chunks: state.chunks.length, ready: [...state.documents.values()].filter((doc) => doc.status === 'READY').length, failed: [...state.documents.values()].filter((doc) => doc.status === 'FAILED').length }; }
function reset() { state.documents.clear(); state.chunks = []; initialized = true; saveMetadata(); }

module.exports = { ROOT, DOCS_DIR, STATUSES, ingest, search, list, stats, reset };
