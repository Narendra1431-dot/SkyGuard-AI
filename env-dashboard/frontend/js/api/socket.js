// Single shared Socket.io connection. Emits "connected"/"disconnected" events.

class SocketManager {
  constructor() {
    this.socket = null;
    this.handlers = new Map(); // event -> [fn]
    this.state = 'disconnected';
    this.seenEventIds = new Set();
    this.lastSeq = 0;
  }

  connect() {
    if (this.socket) return this.socket;
    if (typeof io !== 'function') {
      console.warn('socket.io client not loaded yet');
      return null;
    }
    const socketUrl = (typeof window !== 'undefined' && window.SKYGUARD_SOCKET_URL)
      || (typeof window !== 'undefined' && window.SKYGUARD_API_BASE)
      || 'http://localhost:4000';
    this.socket = io(socketUrl, { transports: ['websocket', 'polling'], reconnection: true, query: { since: this.lastSeq } });
    this.socket.on('connect', () => {
      this.setState('connected');
      try { this.socket.emit('client:hello', { since: this.lastSeq }); } catch (_) {}
    });
    this.socket.on('disconnect', () => this.setState('disconnected'));
    this.socket.on('reconnect_attempt', () => this.setState('connecting'));
    this.socket.on('connect_error', () => this.setState('disconnected'));
    for (const evt of ['sensor:update','station:status','station:added','anomaly:new','alert:new','alert:update','dashboard:update','quality:update','maintenance:update','system:update','report:new','investigation:created','investigation:updated','reading.created','anomaly.created','alert.created','quality.updated','maintenance.updated','provider.updated','event:replay','timeline:new']) {
      this.socket.on(evt, (payload) => this.dispatch(evt, payload));
    }
    return this.socket;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    window.dispatchEvent(new CustomEvent('skyguard:connection', { detail: s }));
  }

  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, []);
    this.handlers.get(evt).push(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) {
    const arr = this.handlers.get(evt) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatch(evt, payload) {
    if (payload && typeof payload === 'object' && payload.id) {
      if (this.seenEventIds.has(payload.id)) return;
      this.seenEventIds.add(payload.id);
      if (this.seenEventIds.size > 500) {
        const first = this.seenEventIds.values().next().value;
        this.seenEventIds.delete(first);
      }
    }
    if (payload && typeof payload.seq === 'number' && payload.seq > this.lastSeq) {
      this.lastSeq = payload.seq;
    }
    const arr = this.handlers.get(evt) || [];
    for (const fn of arr) { try { fn(payload); } catch (e) { console.error('socket handler error', e); } }
    window.dispatchEvent(new CustomEvent(`skyguard:event:${evt}`, { detail: payload }));
  }

  disconnect() {
    if (this.socket) { this.socket.disconnect(); this.socket = null; }
    this.handlers.clear();
    this.setState('disconnected');
  }
}

export const socketMgr = new SocketManager();
window.SkyGuardSocket = socketMgr;
