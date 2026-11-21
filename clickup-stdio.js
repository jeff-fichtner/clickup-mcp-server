#!/usr/bin/env node
// Self-hosted ClickUp MCP server (stdio, zero-dependency — Node built-ins only).
// Tokens: one per workspace, as JSON {"<team_id>":"pk_…"} in the macOS Keychain service
// `clickup_tokens` (or env CLICKUP_TOKENS). ClickUp personal tokens reach only the workspace
// they were generated in, so each call is routed to its workspace's token.
// Paces to ClickUp's ~100 req/min limit and retries on 429 (no daily cap).
// Every operation in ClickUp's public API is a tool: tools.generated.json is built from the
// published specs (scripts/generate-tools.js); a few tools add behaviour on top (OVERRIDES).
// Register with Claude Code:
//   claude mcp add --scope user clickup -- node /path/to/clickup-mcp-server/clickup-stdio.js
// @ts-check
'use strict';
const fs = require('fs');
const nodePath = require('path');
const https = require('https');
const { execSync } = require('child_process');
const readline = require('readline');

/** @typedef {import('./scripts/generate-tools.js').Tool} GeneratedTool */
/** @typedef {import('./scripts/generate-tools.js').Variant} Variant */
/** @typedef {import('./scripts/generate-tools.js').Schema} Schema */
/** @typedef {import('./scripts/generate-tools.js').InputSchema} InputSchema */
/**
 * A tool's arguments: JSON from the MCP client, in the shape its input schema describes. Their
 * values are ClickUp's to judge, so they are not typed here.
 * @typedef {Record<string, any>} Args
 */
/**
 * A ClickUp response body: JSON whose shape is ClickUp's.
 * @typedef {any} ClickUpJson
 */
/**
 * A request error, with ClickUp's HTTP status and ECODE when ClickUp answered.
 * @typedef {Error & { status?: number, ecode?: string }} ApiError
 */
/**
 * A file upload, ready to send.
 * @typedef {{ data: Buffer, contentType: string }} Upload
 */
/**
 * What one HTTP request sends: nothing, a JSON value, or an upload. A body passed whole is
 * whatever the caller gave, a bare string or number included.
 * @typedef {Upload | Record<string, unknown> | unknown[] | string | number | boolean | null} SendBody
 */
/**
 * The function that sends one HTTP request to ClickUp and resolves to its JSON body.
 * @typedef {(method: string, path: string, body: SendBody, attempt: number, token: string) => Promise<ClickUpJson>} Requester
 */
/**
 * A tool as tools/list serves it.
 * @typedef {{ name: string, description: string, inputSchema: InputSchema }} ListedTool
 */

/**
 * A thrown value's message, or the value itself when it has none.
 * @param {unknown} e
 * @returns {string}
 */
const errorText = e => String((e && typeof e === 'object' && 'message' in e && e.message) || e);
/**
 * A map's own entry for a key, never one inherited from Object.prototype: a tool named
 * `toString` or `__proto__` is unknown, not a call into the prototype.
 * @template T
 * @param {Record<string, T>} map
 * @param {string} key
 * @returns {T | undefined}
 */
const own = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);

const KEYCHAIN_SERVICE = 'clickup_tokens';
const TOKENS_HELP = `Keychain service '${KEYCHAIN_SERVICE}' or env CLICKUP_TOKENS, holding JSON {"<team_id>":"<token>", …}`;

// Parses the workspace→token map. Structural problems are errors; the token values themselves
// are not second-guessed (a wrong one fails at ClickUp with a 401 that names it).
/**
 * @param {string} raw
 * @param {string} source where `raw` came from, for the error message
 * @returns {Record<string, string>} workspace id → token
 */
function parseTokens(raw, source) {
  /** @type {unknown} */
  let map;
  try { map = JSON.parse(raw); } catch { throw new Error(`${source} is not JSON. Expected ${TOKENS_HELP}`); }
  if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length === 0) {
    throw new Error(`${source} holds no workspace tokens. Expected ${TOKENS_HELP}`);
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [team, token] of Object.entries(map)) {
    if (!/^\d+$/.test(team)) throw new Error(`${source}: key "${team}" is not a workspace id (team_id)`);
    if (typeof token !== 'string' || !token.trim()) throw new Error(`${source}: workspace ${team} has no token`);
    out[team] = token.trim();
  }
  return out;
}
/** @returns {Record<string, string>} */
function loadTokens() {
  if (process.env.CLICKUP_TOKENS) return parseTokens(process.env.CLICKUP_TOKENS, 'env CLICKUP_TOKENS');
  let raw;
  try {
    raw = execSync(`security find-generic-password -s ${KEYCHAIN_SERVICE} -w`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error(`No ClickUp tokens found. Set ${TOKENS_HELP}`);
  }
  return parseTokens(raw, `Keychain service '${KEYCHAIN_SERVICE}'`);
}
// Loaded on first use and kept once it loads. Until then every call tries again and fails with
// the reason, so a keychain that was locked at startup works as soon as it is unlocked, and no
// call goes out without a token.
/** @type {Record<string, string> | null} */
let TOKENS = null;
/** @returns {Record<string, string>} */
function tokens() {
  if (!TOKENS) TOKENS = loadTokens();
  return TOKENS;
}

// ---- rate limiter: <= 90 requests / rolling 60s, serialized ----
const MAX_PER_MIN = 90;
/** @type {number[]} */
let times = [];
/** @type {Promise<void>} */
let chain = Promise.resolve();
function throttle() {
  chain = chain.then(async () => {
    const now = Date.now();
    times = times.filter(t => now - t < 60000);
    if (times.length >= MAX_PER_MIN) {
      await new Promise(r => setTimeout(r, 60000 - (now - times[0]) + 50));
    }
    times.push(Date.now());
  });
  return chain;
}
// How long to wait after a 429. ClickUp sends X-RateLimit-Reset (Unix seconds when the window
// reopens); Retry-After may be seconds or an HTTP date. With neither, wait out a whole window.
const RATE_WINDOW_MS = 60000;
/**
 * @param {import('http').IncomingHttpHeaders} headers the 429 response's headers
 * @param {number} [now]
 * @returns {number}
 */
function retryDelayMs(headers, now = Date.now()) {
  const until = (/** @type {number} */ ms) => Math.min(Math.max(ms - now, 0), RATE_WINDOW_MS) + 1000;
  const reset = Number(headers['x-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) return until(reset * 1000);
  const ra = headers['retry-after'];
  if (ra !== undefined && ra !== '') {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return until(now + secs * 1000);
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return until(at);
  }
  return RATE_WINDOW_MS + 1000;
}
// A request with no answer for this long fails, so one stalled connection cannot hold up every
// call queued behind it.
const REQUEST_TIMEOUT_MS = 60000;
/**
 * @param {SendBody} body
 * @returns {body is Upload}
 */
const isUpload = body => !!body && typeof body === 'object' && !Array.isArray(body) && Buffer.isBuffer(body.data);
// A body is JSON, or { data: Buffer, contentType } for an upload.
/** @type {Requester} */
function rawRequest(method, path, body, attempt, token) {
  return new Promise((resolve, reject) => {
    const upload = isUpload(body) ? body : null;
    const data = upload ? upload.data : body ? JSON.stringify(body) : null;
    /** @type {Record<string, string | number>} */
    const headers = { Authorization: token, 'Content-Type': upload ? upload.contentType : 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(
      { hostname: 'api.clickup.com', path, method, headers },
      res => {
        // Always set on a response to a request this client made.
        const status = /** @type {number} */ (res.statusCode);
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          // Decoded once, whole: a UTF-8 character split across two chunks would be garbled
          // by decoding each chunk on its own.
          const buf = Buffer.concat(chunks).toString('utf8');
          if (status === 429 && attempt < 5) {
            const retry = () => throttle().then(() => rawRequest(method, path, body, attempt + 1, token));
            return setTimeout(() => retry().then(resolve, reject), retryDelayMs(res.headers));
          }
          // ClickUp sometimes emits RAW control chars inside string values (task
          // descriptions pasted from other tools), which is invalid JSON and makes strict
          // parsers throw. Escaped sequences are backslash+letter, not control bytes, so
          // stripping U+0000..U+001F only removes the illegal bytes and insignificant
          // whitespace between tokens. A body that still does not parse is an error, not
          // something handed to the caller.
          // Some writes (move folder) answer 200 with an empty body: that is success, not bad JSON.
          /** @type {ClickUpJson} */
          let json;
          if (!buf.trim()) json = {};
          else try { json = JSON.parse(buf); }
          catch {
            try { json = JSON.parse(buf.replace(/[\u0000-\u001F]/g, '')); }
            catch (e2) { return reject(new Error(`ClickUp ${status}: unparseable JSON (${errorText(e2)})`)); }
          }
          if (status >= 400) {
            /** @type {ApiError} */
            const err = new Error(`ClickUp ${status}: ${buf}`);
            err.status = status; err.ecode = json && json.ECODE;
            reject(err);
          } else resolve(json);
        });
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`ClickUp did not answer ${method} ${path.split('?')[0]} within ${REQUEST_TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
// The function that sends one HTTP request; tests replace it with a stand-in for ClickUp.
/** @type {Requester} */
let requester = rawRequest;
/** @param {Requester | null | undefined} fn a stand-in for ClickUp, or nothing to restore the real one */
function setRequester(fn) { requester = fn || rawRequest; }
/**
 * @param {string} method
 * @param {string} path
 * @param {SendBody} body
 * @param {string} token
 * @returns {Promise<ClickUpJson>}
 */
async function api(method, path, body, token) { await throttle(); return requester(method, path, body, 0, token); }

// ---- routing: every call goes out with the token of the workspace it belongs to ----
// ClickUp answers a token used outside its workspace with 401 OAUTH_023 ("Team(s) not
// authorized"), and an id no workspace has with 401 OAUTH_027 ("Team not authorized"). Only
// those two mean "try the next workspace"; anything else (a revoked token is OAUTH_025) is real.
/**
 * @param {unknown} e
 * @returns {boolean}
 */
const isScopeMiss = e => {
  const err = /** @type {ApiError | null | undefined} */ (e);
  return !!err && err.status === 401 && (err.ecode === 'OAUTH_023' || err.ecode === 'OAUTH_027');
};
/**
 * @param {string | number} team_id
 * @returns {string}
 */
function tokenForTeam(team_id) {
  const all = tokens();
  const token = all[String(team_id)];
  if (!token) throw new Error(`No ClickUp token for workspace ${team_id}. Configured workspaces: ${Object.keys(all).join(', ')}`);
  return token;
}
/**
 * @param {string | number} team_id
 * @param {string} method
 * @param {string} path
 * @param {SendBody} body
 * @returns {Promise<ClickUpJson>}
 */
const viaTeam = (team_id, method, path, body) => api(method, path, body, tokenForTeam(team_id));
// Calls addressed by an object id (task, list, folder, space): use the caller's team_id when
// given, else the workspace this object was last found in, else ask each workspace in turn.
// A wrong-workspace attempt is refused before it does anything, so trying a write is safe.
/** @type {Map<string, string>} object key (`task:abc`) → workspace id */
const ownerOf = new Map();
// key null: the call names no object (the authorized user, bulk reads by task id), so the
// answering workspace is not remembered for later calls.
/**
 * @param {string | null} key
 * @param {string | number | undefined} team_id
 * @param {string} method
 * @param {string} path
 * @param {SendBody} body
 * @returns {Promise<ClickUpJson>}
 */
async function viaObject(key, team_id, method, path, body) {
  if (team_id) return viaTeam(team_id, method, path, body);
  const owner = key ? ownerOf.get(key) : undefined;
  if (owner) return viaTeam(owner, method, path, body);
  /** @type {string[]} */
  const tried = [];
  for (const [team, token] of Object.entries(tokens())) {
    try {
      const r = await api(method, path, body, token);
      if (key) ownerOf.set(key, team);
      return r;
    } catch (e) {
      if (!isScopeMiss(e)) throw e;
      tried.push(team);
    }
  }
  throw new Error(`No configured workspace reaches ${key || path} (tried ${tried.join(', ')}). It may not exist, or its workspace has no token.`);
}
// ---- generated tools: one per operation in ClickUp's public API ----
/** @type {GeneratedTool[]} */
const GENERATED = JSON.parse(fs.readFileSync(nodePath.join(__dirname, 'tools.generated.json'), 'utf8'));
const BY_NAME = new Map(GENERATED.map(t => [t.name, t]));
/**
 * @param {string} name
 * @returns {GeneratedTool}
 */
function generatedTool(name) {
  const tool = BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  return tool;
}

// A tool covering two operations (a list in a folder or in a space) runs the one whose path the
// arguments fill. Exactly one must fit: none or both is the caller's mistake, said plainly.
/**
 * @param {unknown} v
 * @returns {boolean}
 */
const given = v => v !== undefined && v !== null && v !== '';
/**
 * @param {GeneratedTool} tool
 * @param {Args} args
 * @returns {Variant}
 */
function pickVariant(tool, args) {
  if (tool.variants.length === 1) return tool.variants[0];
  const fits = tool.variants.filter(v => v.pathParams.every(p => given(args[p])));
  const parents = tool.variants.map(v => v.pathParams.find(p => !tool.variants.every(w => w.pathParams.includes(p))));
  if (fits.length === 1) return fits[0];
  throw new Error(`${tool.name}: give exactly one of ${parents.join(', ')}`);
}
/**
 * @param {Variant} variant
 * @param {Args} args
 * @returns {string}
 */
function queryString(variant, args) {
  /** @type {string[]} */
  const p = [];
  /** @type {(k: string, v: string | number | boolean) => void} */
  const add = (k, v) => p.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  /** @type {(v: unknown) => any[]} */
  const many = v => (Array.isArray(v) ? v : [v]);
  for (const q of variant.query) {
    const v = args[q.wire];
    // team_id in a query only qualifies custom_task_ids, except on the few endpoints that require it.
    if (q.wire === 'team_id' && !q.required && !args.custom_task_ids) continue;
    if (v === undefined || v === null) {
      if (q.required) throw new Error(`Missing required query parameter: ${q.wire}`);
      continue;
    }
    if (q.style === 'json') add(q.wire, typeof v === 'string' ? v : JSON.stringify(v));
    else if (q.style === 'brackets') many(v).forEach(x => add(`${q.wire}[]`, x));
    else if (q.style === 'repeat') many(v).forEach(x => add(q.wire, x));
    else add(q.wire, v);
  }
  return p.length ? `?${p.join('&')}` : '';
}
/**
 * @param {string} field the form field that carries the file
 * @param {string} filePath
 * @param {Record<string, unknown>} fields the text fields beside the file
 * @param {string} [filename] the name ClickUp gives the file; the local name when not given
 * @returns {Upload}
 */
function multipartBody(field, filePath, fields, filename) {
  const boundary = `----clickup-mcp-${Date.now().toString(16)}`;
  /** @type {Buffer[]} */
  const parts = [];
  // CR and LF would end a line early and let a value add headers or parts; quotes would end the
  // quoted filename.
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    const text = (typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/[\r\n]/g, '');
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${text}\r\n`));
  }
  const name = (filename || nodePath.basename(filePath)).replace(/["\r\n]/g, '');
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(fs.readFileSync(filePath));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { data: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
/**
 * A file to upload, named but not yet read.
 * @typedef {{ multipart: true, field: string, filePath: string, fields: Record<string, unknown>, filename?: string }} UploadRef
 */
/**
 * Which token a request goes out with: an object key routes by the object's workspace, a team by
 * that workspace, neither by any token.
 * @typedef {{ key?: string, team?: string }} Route
 */
/**
 * @typedef {object} BuiltRequest
 * @property {string} method
 * @property {string} path with its query string
 * @property {SendBody | UploadRef} body
 * @property {Route} route
 */
/**
 * @param {SendBody | UploadRef} body
 * @returns {body is UploadRef}
 */
const isUploadRef = body => !!body && typeof body === 'object' && 'multipart' in body && !!body.multipart;
// The HTTP request a tool call makes, without sending it (unit-tested).
/**
 * @param {GeneratedTool} tool
 * @param {Args} args
 * @returns {BuiltRequest}
 */
function buildRequest(tool, args) {
  const v = pickVariant(tool, args);
  for (const p of v.pathParams) {
    if (!given(args[p])) throw new Error(`${tool.name}: missing ${p}`);
  }
  const path = v.path.replace(/\{([^}]+)\}/g, (_, p) => encodeURIComponent(String(args[p]))) + queryString(v, args);
  /** @type {BuiltRequest['body']} */
  let body = null;
  if (v.body.kind === 'json' && v.body.raw) body = args.body;
  else if (v.body.kind === 'json') {
    /** @type {Record<string, unknown>} */
    const json = {};
    for (const k of v.body.props) if (args[k] !== undefined) json[k] = args[k];
    body = json;
  } else if (v.body.kind === 'multipart') {
    /** @type {Record<string, unknown>} */
    const fields = {};
    for (const k of v.body.props) fields[k] = args[k];
    body = { multipart: true, field: v.body.field, filePath: args.file_path, fields, filename: args.filename };
  }
  // Route by workspace when the path names it, else by the first object it names.
  const objParam = v.pathParams.find(p => p !== 'team_id');
  const route = v.pathParams.includes('team_id') ? { team: args.team_id }
    : objParam ? { key: `${objParam.replace(/_id$/, '')}:${args[objParam]}`, team: args.team_id }
    : { team: args.team_id };
  return { method: v.method, path, body, route };
}
/**
 * @param {BuiltRequest} req
 * @returns {Promise<ClickUpJson>}
 */
async function sendRequest(req) {
  const body = isUploadRef(req.body) ? multipartBody(req.body.field, req.body.filePath, req.body.fields, req.body.filename) : req.body;
  if (req.route.key) return viaObject(req.route.key, req.route.team, req.method, req.path, body);
  if (req.route.team) return viaTeam(req.route.team, req.method, req.path, body);
  // No workspace in the path or the call (the authorized user): any token answers for its owner.
  return viaObject(null, undefined, req.method, req.path, body);
}
/**
 * One generated tool's request, sent.
 * @param {string} name
 * @param {Args} args
 * @returns {Promise<ClickUpJson>}
 */
const call = (name, args) => sendRequest(buildRequest(generatedTool(name), args));

// ---- overrides: tools that do more than their one request ----
/**
 * @param {unknown} d YYYY-MM-DD (noon local time), or anything else to pass through as given
 * @returns {unknown}
 */
const dueMs = d => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T12:00:00').getTime() : d);
/** @type {Record<string, number>} */
const PRIORITY = { urgent: 1, high: 2, normal: 3, low: 4 };
// create_task / update_task accept shorthands that callers rely on (markdown_description, priority
// by word, due_date as YYYY-MM-DD) next to every field ClickUp takes. priority: null clears it.
/**
 * @param {Args} a
 * @returns {Args}
 */
function taskArgs(a) {
  const out = { ...a };
  if (a.markdown_description !== undefined) out.markdown_content = a.markdown_description;
  if (a.priority !== undefined && a.priority !== null) {
    const p = typeof a.priority === 'string' ? (PRIORITY[a.priority.toLowerCase()] || Number(a.priority)) : a.priority;
    if (![1, 2, 3, 4].includes(p)) throw new Error(`priority must be urgent, high, normal, low or 1-4 (got ${JSON.stringify(a.priority)})`);
    out.priority = p;
  }
  if (a.due_date !== undefined) out.due_date = dueMs(a.due_date);
  if (a.start_date !== undefined) out.start_date = dueMs(a.start_date);
  return out;
}
// PUT /space/{id} takes the whole space, not a patch: every setting is sent back as read, so a
// rename changes the name and nothing else.
const SPACE_FIELDS = ['name', 'color', 'private', 'admin_can_manage', 'multiple_assignees', 'features'];
/**
 * @param {Record<string, unknown>} a
 * @param {string[]} keys
 * @returns {Record<string, unknown>} the keys `a` has a value for
 */
const pick = (a, keys) => Object.fromEntries(keys.filter(k => a[k] !== undefined).map(k => [k, a[k]]));
/**
 * @param {ClickUpJson} space a space as ClickUp returns it
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
const renameSpaceBody = (space, name) => ({ ...pick(space, SPACE_FIELDS), name });
// The parts of ClickUp's objects that the overrides read.
/** @typedef {{ id: string, name: string }} Named */
/** @typedef {Named & { space?: Named, lists?: Named[] }} Folder */
/** @typedef {Named & { statuses?: { id: string, status: string, type: string }[], task_count?: number }} List */
/**
 * @typedef {Named & { status?: { status: string }, priority?: { priority: string } | null,
 *   due_date?: string | null, archived?: boolean, parent?: string | null, list?: Named }} Task
 */
/** @param {Folder} f */
const folderSummary = f => ({ id: f.id, name: f.name, space: f.space && { id: f.space.id, name: f.space.name }, lists: (f.lists || []).map(l => ({ id: l.id, name: l.name })) });
/** @param {Task} t */
const taskSummary = t => ({ id: t.id, name: t.name, status: t.status && t.status.status, archived: t.archived, parent: t.parent, list: t.list && { id: t.list.id, name: t.list.name } });

/** @type {Record<string, (a: Args) => Promise<unknown>>} */
const OVERRIDES = {
  async clickup_list_workspaces() {
    // Each token sees its own workspace; the union is every workspace this server can reach.
    /** @type {Map<string, Named>} */
    const seen = new Map();
    for (const token of Object.values(tokens())) {
      const r = await api('GET', '/api/v2/team', null, token);
      /** @type {Named[]} */
      const teams = r.teams || [];
      for (const t of teams) seen.set(t.id, { id: t.id, name: t.name });
    }
    return [...seen.values()];
  },
  async clickup_get_hierarchy({ team_id, space_id }) {
    if (!given(team_id) && !given(space_id)) throw new Error('clickup_get_hierarchy: give team_id or space_id');
    /** @type {Named[]} */
    const spaces = given(space_id) ? [await call('clickup_get_space', { space_id, team_id })]
                                   : ((await call('clickup_list_spaces', { team_id })).spaces || []);
    const out = [];
    for (const sp of spaces) {
      /** @type {Folder[]} */
      const folders = (await call('clickup_list_folders', { space_id: sp.id, team_id })).folders || [];
      /** @type {Named[]} */
      const folderless = (await call('clickup_list_folderless_lists', { space_id: sp.id, team_id })).lists || [];
      out.push({
        id: sp.id, name: sp.name, type: 'space',
        folders: folders.map(f => ({ id: f.id, name: f.name, lists: (f.lists || []).map(l => ({ id: l.id, name: l.name })) })),
        lists: folderless.map(l => ({ id: l.id, name: l.name })),
      });
    }
    return out;
  },
  async clickup_filter_tasks(a) {
    // Every matching task across all pages. ClickUp's API calls folders "projects"; this tool
    // takes folder_ids and sends them as project_ids.
    const project_ids = a.project_ids || a.folder_ids;
    const out = [];
    for (let page = 0; ; page++) {
      const r = await call('clickup_filter_tasks', { ...a, project_ids, subtasks: a.subtasks !== undefined ? a.subtasks : true, page });
      /** @type {Task[]} */
      const ts = r.tasks || [];
      for (const t of ts) out.push(a.raw ? t : { id: t.id, name: t.name, status: t.status && t.status.status, priority: t.priority && t.priority.priority, due_date: t.due_date, list: t.list && { id: t.list.id, name: t.list.name } });
      if (r.last_page === true || ts.length < 100) break;
    }
    return out;
  },
  async clickup_list_tasks(a) {
    // Tasks of ONE list, with archived support and full pagination. The team-level
    // filter_tasks cannot see tasks that live in an ARCHIVED list; this can.
    const out = [];
    for (let page = 0; ; page++) {
      const r = await call('clickup_list_tasks', { ...a, include_closed: a.include_closed !== false, subtasks: a.subtasks !== undefined ? a.subtasks : true, archived: !!a.archived, page });
      /** @type {Task[]} */
      const ts = r.tasks || [];
      for (const t of ts) out.push(a.raw ? t : taskSummary(t));
      if (ts.length < 100) break;
    }
    return out;
  },
  async clickup_create_task(a) { return call('clickup_create_task', taskArgs(a)); },
  async clickup_update_task(a) { return call('clickup_update_task', taskArgs(a)); },
  async clickup_move_task(a) {
    // Real move: v3 reassigns the task's HOME list. v2 cannot: its POST /list/{id}/task/{id}
    // adds the task to an ADDITIONAL list and leaves the home list in place.
    // status_mappings is only needed when the task's current status doesn't exist in the
    // destination list; lists sharing a space-level status set need none.
    await call('clickup_move_task', { ...a, move_custom_fields: a.move_custom_fields !== false });
    // v3 returns no useful body; read back so the caller sees the truth, not our assumption.
    /** @type {Task} */
    const t = await call('clickup_get_task', { task_id: a.task_id, team_id: a.team_id });
    return { id: t.id, name: t.name, status: t.status && t.status.status, list: t.list && { id: t.list.id, name: t.list.name }, archived: t.archived };
  },
  async clickup_get_list(a) {
    /** @type {List} */
    const l = await call('clickup_get_list', a);
    if (a.raw) return l;
    return { id: l.id, name: l.name, task_count: l.task_count, statuses: (l.statuses || []).map(s => ({ id: s.id, status: s.status, type: s.type })) };
  },
  async clickup_update_list(a) {
    // ClickUp requires name on every update; a description-only change keeps the current name.
    const name = a.name !== undefined ? a.name : (await call('clickup_get_list', a)).name;
    return call('clickup_update_list', { ...a, name });
  },
  async clickup_delete_list(a) {
    await call('clickup_delete_list', a);
    return { deleted: a.list_id };
  },
  async clickup_add_tag_to_task(a) {
    await call('clickup_add_tag_to_task', a);
    return { task_id: a.task_id, tag_name: a.tag_name, added: true };
  },
  async clickup_remove_tag_from_task(a) {
    await call('clickup_remove_tag_from_task', a);
    return { task_id: a.task_id, tag_name: a.tag_name, removed: true };
  },
  async clickup_move_folder(a) {
    // Moves the folder with its lists and tasks to the top level of another space. ClickUp
    // answers with an empty body, so read back where the folder actually is.
    await call('clickup_move_folder', a);
    return folderSummary(await call('clickup_get_folder', { folder_id: a.folder_id, team_id: a.team_id }));
  },
  async clickup_create_space(a) {
    // With like_space_id, starts from that space's settings and applies the given fields on top.
    // Statuses are never copied: the API gives a new space ClickUp's default statuses.
    let body = pick(a, SPACE_FIELDS);
    if (a.like_space_id) {
      const like = await call('clickup_get_space', { space_id: a.like_space_id, team_id: a.team_id });
      body = { ...renameSpaceBody(like, a.name), ...body };
    }
    // Sent directly: the spec's create body lists only some of the settings ClickUp accepts.
    /** @type {Named & { statuses?: { status: string, type: string }[] }} */
    const s = await viaTeam(a.team_id, 'POST', `/api/v2/team/${encodeURIComponent(a.team_id)}/space`, body);
    return { id: s.id, name: s.name, statuses: (s.statuses || []).map(x => ({ status: x.status, type: x.type })) };
  },
  async clickup_update_space(a) {
    const space = await call('clickup_get_space', { space_id: a.space_id, team_id: a.team_id });
    const body = { ...renameSpaceBody(space, space.name), ...pick(a, SPACE_FIELDS) };
    const s = await call('clickup_update_space', { space_id: a.space_id, team_id: a.team_id, ...body });
    return { id: s.id, name: s.name };
  },
};

// Schema changes for the overrides: shorthands they accept, fields they fill themselves.
/** @type {Schema} */
const RAW = { type: 'boolean', description: "Return ClickUp's full response instead of the summary" };
/** @type {Record<string, (s: InputSchema, t: ListedTool) => void>} */
const SCHEMA_PATCHES = {
  clickup_create_task: s => {
    s.properties.markdown_description = { type: 'string', description: 'Markdown description (sent as markdown_content)' };
    s.properties.priority = { description: 'urgent | high | normal | low, or 1-4' };
    s.properties.due_date = { description: 'YYYY-MM-DD, or Unix ms' };
  },
  clickup_update_task: s => {
    s.properties.markdown_description = { type: 'string', description: 'Markdown description (sent as markdown_content)' };
    s.properties.priority = { description: 'urgent | high | normal | low, 1-4, or null to clear' };
    s.properties.due_date = { description: 'YYYY-MM-DD, or Unix ms' };
  },
  clickup_filter_tasks: (s, t) => {
    t.description = 'Tasks across a workspace matching the filters, every page. Archived tasks are never included (use clickup_list_tasks for an archived list); closed tasks only with include_closed.';
    delete s.properties.page;
    s.properties.raw = { type: 'boolean', description: "Return ClickUp's full task objects instead of summaries" };
    s.properties.folder_ids = { type: 'array', items: { type: 'string' }, description: 'Folder ids (sent as project_ids)' };
  },
  clickup_update_list: s => { s.required = ['list_id']; },
  clickup_list_tasks: s => { s.properties.raw = RAW; delete s.properties.page; },
  clickup_get_list: s => { s.properties.raw = RAW; },
  clickup_move_task: (s, t) => { t.description = 'Move a task to a new HOME list (a real move - removes it from its current list). Pass status_mappings only if the current status does not exist in the destination list. Returns the task as it is after the move.'; },
  clickup_move_folder: (s, t) => { t.description = 'Move a folder, with its lists and tasks, to the top level of another space (space_id). Folder and list ids are kept. Returns where the folder is after the move.'; },
  clickup_create_space: (s, t) => {
    t.description = 'Create a space. With like_space_id it copies that space\'s settings (except colour) and applies any fields given on top. Statuses are never copied: a new space gets "to do" and "complete".';
    s.properties.like_space_id = { type: 'string', description: 'Space whose settings to copy' };
    s.required = ['team_id', 'name'];
  },
  clickup_update_space: (s, t) => {
    t.description = 'Change a space\'s settings (name, color, private, multiple_assignees, features). Fields not given are read first and sent back unchanged.';
    s.required = ['space_id'];
  },
};

/** @type {ListedTool[]} */
const TOOLS = GENERATED.map(t => {
  /** @type {ListedTool} */
  const tool = { name: t.name, description: t.description, inputSchema: JSON.parse(JSON.stringify(t.inputSchema)) };
  const patch = own(SCHEMA_PATCHES, t.name);
  if (patch) patch(tool.inputSchema, tool);
  return tool;
});
TOOLS.push({ name: 'clickup_get_hierarchy', description: 'Spaces + folders + lists for a team (team_id) or a single space (space_id).', inputSchema: { type: 'object', properties: { team_id: { type: 'string' }, space_id: { type: 'string' } }, required: [] } });
// The hierarchy needs team_id or space_id; JSON Schema's required cannot say "one of", so the
// tool checks it and names both.

/**
 * @param {string} name
 * @param {Args} args
 * @returns {Promise<unknown>}
 */
async function runTool(name, args) {
  const override = own(OVERRIDES, name);
  if (override) return override(args);
  const req = buildRequest(generatedTool(name), args);
  const r = await sendRequest(req);
  // Writes that answer with an empty body (deletes, adds, moves) say so; an empty read stays empty.
  const empty = r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 0;
  return empty && req.method !== 'GET' ? { ok: true } : r;
}

/** @param {object} o a JSON-RPC message */
function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

// ---- tools/call runs STRICTLY ONE AT A TIME ----
// readline fires a fresh async handler per line and never awaits the previous one, so without
// this queue pipelined calls would interleave. Running them in order costs no throughput
// (throttle() serialises every HTTP request anyway) and keeps two things correct: a multi-step
// tool such as move_task (PUT home_list, then read back) has no other call land between its
// steps, and a caller's write and read-back of the same object resolve in the order sent.
// Protocol methods (initialize / tools/list / ping) are deliberately NOT queued — they touch
// no API, and making a health-check wait behind a long tool backlog is how clients time out.
// A tool that fails answers with isError and ClickUp's message as its content, as MCP specifies
// for tool errors, so the model sees what went wrong and can correct the call.
/**
 * @param {string} name
 * @param {Args} args
 * @returns {Promise<{ content: { type: 'text', text: string }[], isError?: true }>}
 */
async function toolResult(name, args) {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await runTool(name, args)) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: errorText(e) }], isError: true };
  }
}
/** @type {Promise<void>} */
let callQueue = Promise.resolve();
/**
 * @param {unknown} id the JSON-RPC request id, echoed back
 * @param {{ name?: string, arguments?: Args } | undefined} params
 */
function enqueueCall(id, params) {
  callQueue = callQueue.then(async () => {
    const name = params && params.name;
    if (typeof name !== 'string' || (!own(OVERRIDES, name) && !BY_NAME.has(name))) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${name}` } });
    send({ jsonrpc: '2.0', id, result: await toolResult(name, (params && params.arguments) || {}) });
  });
  // A rejection here would poison the chain and silently wedge every later call; the inner
  // try/catch should prevent it, so this is a belt-and-braces reset rather than a handler.
  callQueue = callQueue.catch(() => {});
}

if (require.main === module) {
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  line = line.trim(); if (!line) return;
  /** @type {unknown} */
  let msg; try { msg = JSON.parse(line); } catch { return; }
  // A line that parses to something other than an object (`null`, `5`) is not a message.
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = /** @type {{ id?: unknown, method?: string, params?: any }} */ (msg);
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'clickup-selfhosted', version: '1.0.0' } } });
    } else if (method === 'notifications/initialized') {
      /* no reply */
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      enqueueCall(id, params);
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32000, message: errorText(e) } });
  }
});
try { tokens(); } catch (e) { process.stderr.write(`ERROR: ${errorText(e)}\n`); }
}

module.exports = { parseTokens, isScopeMiss, renameSpaceBody, buildRequest, multipartBody, taskArgs, retryDelayMs, toolResult, setRequester, TOOLS, BY_NAME };
