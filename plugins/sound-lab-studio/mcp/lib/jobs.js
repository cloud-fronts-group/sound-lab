'use strict';
// Background job queue: jobs hold items; items run with per-job and global concurrency limits.
// Jobs persist to <dataDir>/jobs/<id>.json so status survives MCP server restarts (running work is marked "interrupted").
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);

class JobManager {
  /**
   * @param {{dataDir: string, maxConcurrency: number, handlers: Record<string, (item:any, ctx:any)=>Promise<any>>, log?: (s:string)=>void}} opts
   */
  constructor(opts) {
    this.dir = path.join(opts.dataDir, 'jobs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.max = Math.max(1, opts.maxConcurrency || 2);
    this.handlers = opts.handlers;
    this.log = opts.log || (() => {});
    /** @type {Map<string, any>} */ this.jobs = new Map();
    this.running = 0;
    this.controllers = new Map(); // itemKey → AbortController
    this.waiters = new Map();     // jobId → [resolve]
    this.saveTimers = new Map();
    this.loadPersisted();
  }

  loadPersisted() {
    for (const f of fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (!TERMINAL.has(job.status)) {
          job.status = 'interrupted';
          for (const it of job.items) { if (it.status === 'running' || it.status === 'queued') { it.status = 'interrupted'; it.progress = 0; } }
          job.finishedAt = job.finishedAt || new Date().toISOString();
          job.note = 'The MCP server stopped while this job was active. Use resume_job to re-run unfinished items.';
          this.persist(job, true);
        }
        this.jobs.set(job.id, job);
      } catch { /* ignore corrupt */ }
    }
  }

  persist(job, now = false) {
    const write = () => { this.saveTimers.delete(job.id); fs.writeFileSync(path.join(this.dir, `${job.id}.json`), JSON.stringify(job, null, 2)); };
    if (now) { clearTimeout(this.saveTimers.get(job.id)); write(); return; }
    if (!this.saveTimers.has(job.id)) { this.saveTimers.set(job.id, setTimeout(write, 750)); }
  }

  create(kind, title, items, opts = {}) {
    const id = `${kind}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
    const job = {
      id, kind, title, status: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      concurrency: Math.max(1, Math.min(opts.concurrency || this.max, 32)), runner: opts.runner || 'local', options: opts.options || {},
      items: items.map((it, i) => ({ index: i, status: 'queued', progress: 0, ...it })),
    };
    this.jobs.set(id, job);
    this.persist(job, true);
    setImmediate(() => this.pump());
    return job;
  }

  get(id) {
    const j = this.jobs.get(id);
    if (!j) { throw new Error(`No job "${id}". Use list_jobs to see job ids.`); }
    return j;
  }

  list({ status, limit = 20 } = {}) {
    return [...this.jobs.values()]
      .filter(j => !status || j.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(j => this.summary(j));
  }

  summary(job) {
    const counts = {};
    for (const it of job.items) { counts[it.status] = (counts[it.status] || 0) + 1; }
    const progress = job.items.length ? job.items.reduce((a, it) => a + (it.status === 'done' ? 1 : it.progress || 0), 0) / job.items.length : 1;
    return { id: job.id, kind: job.kind, title: job.title, status: job.status, progress: Math.round(progress * 1000) / 10, counts, runner: job.runner, createdAt: job.createdAt, finishedAt: job.finishedAt, note: job.note };
  }

  detail(id, { includeLog = false, maxItems = 200 } = {}) {
    const job = this.get(id);
    return {
      ...this.summary(job),
      items: job.items.slice(0, maxItems).map(it => {
        const o = { index: it.index, status: it.status, progress: Math.round((it.progress || 0) * 1000) / 10 };
        for (const k of ['input', 'output', 'outputs', 'error', 'result', 'command']) { if (it[k] !== undefined) { o[k] = it[k]; } }
        if (includeLog && it.log) { o.log = it.log; }
        return o;
      }),
      truncated: job.items.length > maxItems ? job.items.length - maxItems : 0,
    };
  }

  cancel(id) {
    const job = this.get(id);
    let n = 0;
    for (const it of job.items) {
      if (it.status === 'queued') { it.status = 'cancelled'; n++; }
      if (it.status === 'running') { this.controllers.get(`${id}:${it.index}`)?.abort(); n++; }
    }
    this.refreshStatus(job);
    return { id, cancelledItems: n, status: job.status };
  }

  resume(id) {
    const job = this.get(id);
    let n = 0;
    for (const it of job.items) {
      if (['failed', 'cancelled', 'interrupted'].includes(it.status)) { it.status = 'queued'; it.progress = 0; delete it.error; n++; }
    }
    if (n) { job.status = 'queued'; job.finishedAt = null; delete job.note; this.persist(job, true); setImmediate(() => this.pump()); }
    return { id, requeued: n, status: job.status };
  }

  /** Resolve when the job reaches a terminal state, or after timeoutMs. */
  wait(id, timeoutMs) {
    const job = this.get(id);
    if (TERMINAL.has(job.status)) { return Promise.resolve(this.detail(id)); }
    return new Promise(resolve => {
      const done = () => { clearTimeout(t); resolve(this.detail(id)); };
      const t = setTimeout(() => { const arr = this.waiters.get(id) || []; this.waiters.set(id, arr.filter(f => f !== done)); resolve({ ...this.detail(id), waitTimedOut: true }); }, timeoutMs);
      this.waiters.set(id, [...(this.waiters.get(id) || []), done]);
    });
  }

  refreshStatus(job) {
    const st = job.items.map(i => i.status);
    let status;
    if (st.some(s => s === 'running')) { status = 'running'; }
    else if (st.some(s => s === 'queued')) { status = job.startedAt ? 'running' : 'queued'; }
    else if (st.every(s => s === 'done')) { status = 'done'; }
    else if (st.some(s => s === 'interrupted')) { status = 'interrupted'; }
    else if (st.some(s => s === 'done') || st.some(s => s === 'failed')) { status = st.some(s => s === 'failed') ? 'failed' : 'cancelled'; }
    else { status = st.includes('cancelled') ? 'cancelled' : 'failed'; }
    if (status === 'failed' && st.some(s => s === 'done')) { job.partial = true; }
    job.status = status;
    if (TERMINAL.has(status)) {
      job.finishedAt = job.finishedAt || new Date().toISOString();
      this.persist(job, true);
      for (const w of this.waiters.get(job.id) || []) { w(); }
      this.waiters.delete(job.id);
    } else { this.persist(job); }
  }

  pump() {
    for (const job of [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (TERMINAL.has(job.status)) { continue; }
      let active = job.items.filter(i => i.status === 'running').length;
      for (const it of job.items) {
        if (this.running >= this.max) { return; }
        if (active >= job.concurrency) { break; }
        if (it.status !== 'queued') { continue; }
        active++; this.running++;
        this.runItem(job, it);
      }
    }
  }

  async runItem(job, it) {
    const key = `${job.id}:${it.index}`;
    const ac = new AbortController();
    this.controllers.set(key, ac);
    it.status = 'running'; it.startedAt = new Date().toISOString(); it.progress = 0;
    job.startedAt = job.startedAt || it.startedAt;
    if (job.status === 'queued') { job.status = 'running'; }
    this.persist(job);
    const logLines = [];
    const ctx = {
      signal: ac.signal, job,
      onProgress: f => { it.progress = Math.max(0, Math.min(1, f)); this.persist(job); },
      onLog: l => { logLines.push(l); if (logLines.length > 40) { logLines.shift(); } },
      setCommand: c => { it.command = c; },
    };
    try {
      const handler = this.handlers[it.type || job.kind];
      if (!handler) { throw new Error(`No handler for item type ${it.type || job.kind}`); }
      const result = await handler(it, ctx);
      if (ac.signal.aborted) { throw new Error('Cancelled'); }
      it.status = 'done'; it.progress = 1;
      if (result !== undefined) { it.result = result; }
    } catch (e) {
      it.status = this.shuttingDown ? 'interrupted' : ac.signal.aborted || e.message === 'Cancelled' ? 'cancelled' : 'failed';
      if (it.status === 'failed') { it.error = e.message; this.log(`[${job.id}#${it.index}] ${e.message}`); }
    } finally {
      it.finishedAt = new Date().toISOString();
      if (logLines.length) { it.log = logLines.slice(-20).join('\n'); }
      this.controllers.delete(key);
      this.running--;
      this.refreshStatus(job);
      setImmediate(() => this.pump());
    }
  }

  /** Abort everything (server shutdown). Items become "interrupted" on next start via persisted state. */
  shutdown() {
    this.shuttingDown = true;
    for (const job of this.jobs.values()) {
      if (TERMINAL.has(job.status)) { continue; }
      for (const it of job.items) { if (it.status === 'running' || it.status === 'queued') { it.status = 'interrupted'; } }
      job.status = 'interrupted';
      job.note = 'The MCP server stopped while this job was active. Use resume_job to re-run unfinished items.';
      this.persist(job, true);
    }
    for (const ac of this.controllers.values()) { ac.abort(); }
  }
}

module.exports = { JobManager, TERMINAL };
