'use strict';
// Overrides, errors, retries and timeouts against a stand-in for ClickUp (no network).
const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const { EventEmitter } = require('events');

process.env.CLICKUP_TOKENS = '{"111":"tok-a"}';
const modPath = require.resolve('../clickup-stdio.js');
const { retryDelayMs, toolResult, setRequester, multipartBody } = require(modPath);

// A stand-in ClickUp: answer(method, path, body) returns the JSON body, or throws an error with
// .status for a ClickUp error. Records every request.
function fakeClickUp(answer) {
  const calls = [];
  setRequester(async (method, path, body) => {
    calls.push({ method, path, body });
    return answer(method, path, body);
  });
  return calls;
}
const parse = r => JSON.parse(r.content[0].text);
const tasks = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `t${from + i}`, name: `task ${from + i}`, status: { status: 'open' }, priority: null, list: { id: 'L', name: 'list' } }));

test('a 429 waits until X-RateLimit-Reset, else Retry-After (seconds or a date), else a whole window', () => {
  const now = 1_000_000_000_000;
  assert.strictEqual(retryDelayMs({ 'x-ratelimit-reset': String(now / 1000 + 10) }, now), 11000);
  assert.strictEqual(retryDelayMs({ 'retry-after': '3' }, now), 4000);
  assert.strictEqual(retryDelayMs({ 'retry-after': new Date(now + 5000).toUTCString() }, now), 6000);
  assert.strictEqual(retryDelayMs({}, now), 61000);
  assert.strictEqual(retryDelayMs({ 'x-ratelimit-reset': String(now / 1000 + 3600) }, now), 61000, 'capped at one window');
  assert.strictEqual(retryDelayMs({ 'x-ratelimit-reset': String(now / 1000 - 5) }, now), 1000, 'a reset in the past retries soon');
});

test('filter_tasks returns every page until ClickUp says last_page or a page is short', async () => {
  const calls = fakeClickUp((m, path) => {
    const page = Number(new URL(path, 'https://x').searchParams.get('page'));
    if (page < 2) return { tasks: tasks(100, page * 100), last_page: false };
    return { tasks: tasks(30, 200), last_page: true };
  });
  const out = parse(await toolResult('clickup_filter_tasks', { team_id: '111', folder_ids: ['F1'] }));
  assert.strictEqual(out.length, 230);
  assert.deepStrictEqual(out[0], { id: 't0', name: 'task 0', status: 'open', priority: null, list: { id: 'L', name: 'list' } });
  assert.deepStrictEqual(calls.map(c => new URL(c.path, 'https://x').searchParams.get('page')), ['0', '1', '2']);
  assert.match(calls[0].path, /project_ids%5B%5D=F1/);
});

test('filter_tasks stops at a full page marked last_page, and raw returns ClickUp\'s task objects', async () => {
  const calls = fakeClickUp(() => ({ tasks: tasks(100), last_page: true }));
  const out = parse(await toolResult('clickup_filter_tasks', { team_id: '111', raw: true }));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(out.length, 100);
  assert.deepStrictEqual(out[0].status, { status: 'open' });
});

test('get_hierarchy with neither team_id nor space_id says so, before any request', async () => {
  const calls = fakeClickUp(() => ({}));
  const r = await toolResult('clickup_get_hierarchy', {});
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /give team_id or space_id/);
  assert.strictEqual(calls.length, 0);
});

test('get_hierarchy reads spaces, folders and folderless lists through the generated tools', async () => {
  const calls = fakeClickUp((m, path) => {
    if (path.startsWith('/api/v2/team/111/space')) return { spaces: [{ id: 'S1', name: 'space' }] };
    if (path.startsWith('/api/v2/space/S1/folder')) return { folders: [{ id: 'F1', name: 'folder', lists: [{ id: 'L1', name: 'in folder' }] }] };
    if (path.startsWith('/api/v2/space/S1/list')) return { lists: [{ id: 'L2', name: 'folderless' }] };
    throw new Error(`unexpected ${path}`);
  });
  const out = parse(await toolResult('clickup_get_hierarchy', { team_id: '111' }));
  assert.deepStrictEqual(out, [{ id: 'S1', name: 'space', type: 'space', folders: [{ id: 'F1', name: 'folder', lists: [{ id: 'L1', name: 'in folder' }] }], lists: [{ id: 'L2', name: 'folderless' }] }]);
  assert.deepStrictEqual(calls.map(c => c.path), ['/api/v2/team/111/space', '/api/v2/space/S1/folder', '/api/v2/space/S1/list']);
});

test('a ClickUp error comes back as a tool result with isError and ClickUp\'s message', async () => {
  fakeClickUp(() => { const e = new Error('ClickUp 400: {"err":"Status does not exist","ECODE":"ITEM_114"}'); e.status = 400; throw e; });
  const r = await toolResult('clickup_update_task', { task_id: 'abc', status: 'nope' });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /ITEM_114/);
});

test('move_task reads the task back by its encoded id', async () => {
  const calls = fakeClickUp((m, path) => (m === 'GET' ? { id: 'a b', name: 'n', status: { status: 'open' }, list: { id: 'L9', name: 'dest' }, archived: false } : {}));
  const out = parse(await toolResult('clickup_move_task', { team_id: '111', task_id: 'a b', list_id: 'L9' }));
  assert.deepStrictEqual(out, { id: 'a b', name: 'n', status: 'open', list: { id: 'L9', name: 'dest' }, archived: false });
  assert.strictEqual(calls[1].path.split('?')[0], '/api/v2/task/a%20b');
});

test('update_space sends every setting back with only the given ones changed', async () => {
  const space = { id: 'S1', name: 'old', color: '#111', private: false, admin_can_manage: true, multiple_assignees: true, features: { tags: { enabled: true } }, statuses: [] };
  const calls = fakeClickUp(m => (m === 'GET' ? space : { id: 'S1', name: 'new' }));
  const out = parse(await toolResult('clickup_update_space', { space_id: 'S1', name: 'new' }));
  assert.deepStrictEqual(out, { id: 'S1', name: 'new' });
  assert.strictEqual(calls[1].method, 'PUT');
  assert.strictEqual(calls[1].path, '/api/v2/space/S1');
  assert.deepStrictEqual(calls[1].body, { name: 'new', color: '#111', private: false, admin_can_manage: true, multiple_assignees: true, features: { tags: { enabled: true } } });
});

test('multipart text fields lose CR and LF, objects go as JSON, null is left out', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-')), 'a.txt');
  fs.writeFileSync(f, 'x');
  const body = multipartBody('attachment', f, { filename: 'a\r\n--evil', meta: { k: 1 }, gone: null }, 'a"b\r\n.txt').data.toString();
  assert.match(body, /name="filename"\r\n\r\na--evil\r\n/);
  assert.match(body, /name="meta"\r\n\r\n\{"k":1\}\r\n/);
  assert.doesNotMatch(body, /name="gone"/);
  assert.match(body, /filename="ab\.txt"/);
});

// Replaces https.request for one test: respond(req) is called on end() and returns
// { status, headers, body } or 'hang' (never answers).
function fakeHttps(respond) {
  const original = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.opts = opts;
    req.write = () => {};
    req.setTimeout = (ms, fn) => { req.timeoutMs = ms; req.onTimeout = fn; };
    req.destroy = err => setImmediate(() => req.emit('error', err));
    req.end = () => setImmediate(() => {
      const r = respond(req);
      if (r === 'hang') return req.onTimeout();
      const res = new EventEmitter();
      res.statusCode = r.status; res.headers = r.headers || {};
      cb(res);
      res.emit('data', Buffer.from(JSON.stringify(r.body)));
      res.emit('end');
    });
    return req;
  };
  setRequester(null);
  return () => { https.request = original; };
}

test('a request ClickUp never answers fails with a timeout instead of holding up the queue', async () => {
  let seen;
  const restore = fakeHttps(req => { seen = req; return 'hang'; });
  try {
    const r = await toolResult('clickup_get_task', { task_id: 'T1', team_id: '111' });
    assert.strictEqual(seen.timeoutMs, 60000);
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /did not answer GET \/api\/v2\/task\/T1 within 60s/);
  } finally { restore(); }
});

test('a 429 is retried after the reset ClickUp gives, then succeeds', async () => {
  let n = 0;
  const restore = fakeHttps(() => (++n === 1
    ? { status: 429, headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)) }, body: { err: 'Rate limit' } }
    : { status: 200, body: { id: 'T1', name: 'ok' } }));
  try {
    const started = Date.now();
    const r = await toolResult('clickup_get_task', { task_id: 'T1', team_id: '111' });
    assert.strictEqual(r.isError, undefined);
    assert.deepStrictEqual(parse(r), { id: 'T1', name: 'ok' });
    assert.strictEqual(n, 2);
    assert.ok(Date.now() - started >= 900, 'waited before retrying');
  } finally { restore(); }
});

test('tokens that fail to load are tried again on the next call', async () => {
  delete require.cache[modPath];
  process.env.CLICKUP_TOKENS = 'not json';
  const fresh = require(modPath);
  fresh.setRequester(async () => ({ id: 'T1' }));
  const first = await fresh.toolResult('clickup_get_task', { task_id: 'T1', team_id: '111' });
  assert.strictEqual(first.isError, true);
  assert.match(first.content[0].text, /is not JSON/);
  process.env.CLICKUP_TOKENS = '{"111":"tok-a"}';
  const second = await fresh.toolResult('clickup_get_task', { task_id: 'T1', team_id: '111' });
  assert.strictEqual(second.isError, undefined);
  assert.deepStrictEqual(parse(second), { id: 'T1' });
});
