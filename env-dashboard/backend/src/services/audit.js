'use strict';

const operations = require('../db/operations');

async function record(event) {
  return operations.addAudit({
    ...event,
    actor: event.actor || 'system',
    timestamp: event.timestamp || new Date().toISOString(),
  });
}

async function recordFromRequest(req, event) {
  return record({ ...event, actor: req?.user?.username || event.actor || 'system' });
}

module.exports = { record, recordFromRequest };