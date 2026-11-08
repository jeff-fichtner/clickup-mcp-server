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
'use strict';
const fs = require('fs');
const nodePath = require('path');
const https = require('https');
const { execSync } = require('child_process');
const readline = require('readline');

const KEYCHAIN_SERVICE = 'clickup_tokens';
const TOKENS_HELP = `Keychain service '${KEYCHAIN_SERVICE}' or env CLICKUP_TOKENS, holding JSON {"<team_id>":"<token>", …}`;

// Parses the workspace→token map. Structural problems are errors; the token values themselves
// are not second-guessed (a wrong one fails at ClickUp with a 401 that names it).
function parseTokens(raw, source) {
  let map;
  try { map = JSON.parse(raw); } catch { throw new Error(`${source} is not JSON. Expected ${TOKENS_HELP}`); }
  if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length === 0) {
    throw new Error(`${source} holds no workspace tokens. Expected ${TOKENS_HELP}`);
  }
  const out = {};
  for (const [team, token] of Object.entries(map)) {
    if (!/^\d+$/.test(team)) throw new Error(`${source}: key "${team}" is not a workspace id (team_id)`);
    if (typeof token !== 'string' || !token.trim()) throw new Error(`${source}: workspace ${team} has no token`);
    out[team] = token.trim();
  }
  return out;
}
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
// Loaded once; a missing or malformed map is reported on every call (and at startup on stderr)
// rather than letting calls go out with no token.
let TOKENS = null, TOKENS_ERROR = null;
function tokens() {
  if (!TOKENS && !TOKENS_ERROR) { try { TOKENS = loadTokens(); } catch (e) { TOKENS_ERROR = e.message; } }
  if (TOKENS_ERROR) throw new Error(TOKENS_ERROR);
  return TOKENS;
}

// ---- rate limiter: <= 90 requests / rolling 60s, serialized ----
const MAX_PER_MIN = 90;
let times = [];
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
// A body is JSON, or { data: Buffer, contentType } for an upload.
function rawRequest(method, path, body, attempt, token) {
  return new Promise((resolve, reject) => {
    const upload = body && Buffer.isBuffer(body.data);
    const data = upload ? body.data : body ? JSON.stringify(body) : null;
    const headers = { Authorization: token, 'Content-Type': upload ? body.contentType : 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(
      { hostname: 'api.clickup.com', path, method, headers },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          // Decoded once, whole: a UTF-8 character split across two chunks would be garbled
          // by decoding each chunk on its own.
          const buf = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 429 && attempt < 5) {
            const ra = parseInt(res.headers['retry-after'] || '5', 10);
            return setTimeout(() => rawRequest(method, path, body, attempt + 1, token).then(resolve, reject), (ra + 1) * 1000);
          }
          // ClickUp sometimes emits RAW control chars inside string values (task
          // descriptions pasted from other tools), which is invalid JSON and makes strict
          // parsers throw. Escaped sequences are backslash+letter, not control bytes, so
          // stripping U+0000..U+001F only removes the illegal bytes and insignificant
          // whitespace between tokens. Parse failure now surfaces loudly instead of
          // silently handing the caller {raw:...} it will not understand.
          // Some writes (move folder) answer 200 with an empty body: that is success, not bad JSON.
          let json;
          if (!buf.trim()) json = {};
          else try { json = JSON.parse(buf); }
          catch {
            try { json = JSON.parse(buf.replace(/[\u0000-\u001F]/g, '')); }
            catch (e2) { return reject(new Error(`ClickUp ${res.statusCode}: unparseable JSON (${e2.message})`)); }
          }
          if (res.statusCode >= 400) {
            const err = new Error(`ClickUp ${res.statusCode}: ${buf}`);
            err.status = res.statusCode; err.ecode = json && json.ECODE;
            reject(err);
          } else resolve(json);
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function api(method, path, body, token) { await throttle(); return rawRequest(method, path, body, 0, token); }

// ---- routing: every call goes out with the token of the workspace it belongs to ----
// ClickUp answers a token used outside its workspace with 401 OAUTH_023 ("Team(s) not
// authorized"), and an id no workspace has with 401 OAUTH_027 ("Team not authorized"). Only
// those two mean "try the next workspace"; anything else (a revoked token is OAUTH_025) is real.
const isScopeMiss = e => !!e && e.status === 401 && (e.ecode === 'OAUTH_023' || e.ecode === 'OAUTH_027');
function tokenForTeam(team_id) {
  const all = tokens();
  const token = all[String(team_id)];
  if (!token) throw new Error(`No ClickUp token for workspace ${team_id}. Configured workspaces: ${Object.keys(all).join(', ')}`);
  return token;
}
const viaTeam = (team_id, method, path, body) => api(method, path, body, tokenForTeam(team_id));
// Calls addressed by an object id (task, list, folder, space): use the caller's team_id when
// given, else the workspace this object was last found in, else ask each workspace in turn.
// A wrong-workspace attempt is refused before it does anything, so trying a write is safe.
const ownerOf = new Map();
// key null: the call names no object (the authorized user, bulk reads by task id), so the
// answering workspace is not remembered for later calls.
async function viaObject(key, team_id, method, path, body) {
  if (team_id) return viaTeam(team_id, method, path, body);
  if (ownerOf.has(key)) return viaTeam(ownerOf.get(key), method, path, body);
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
const GENERATED = JSON.parse(fs.readFileSync(nodePath.join(__dirname, 'tools.generated.json'), 'utf8'));
const BY_NAME = new Map(GENERATED.map(t => [t.name, t]));

// A tool covering two operations (a list in a folder or in a space) runs the one whose path the
// arguments fill. Exactly one must fit: none or both is the caller's mistake, said plainly.
const given = v => v !== undefined && v !== null && v !== '';
function pickVariant(tool, args) {
  if (tool.variants.length === 1) return tool.variants[0];
  const fits = tool.variants.filter(v => v.pathParams.every(p => given(args[p])));
  const parents = tool.variants.map(v => v.pathParams.find(p => !tool.variants.every(w => w.pathParams.includes(p))));
  if (fits.length === 1) return fits[0];
  throw new Error(`${tool.name}: give exactly one of ${parents.join(', ')}`);
}
function queryString(variant, args) {
  const p = [];
  const add = (k, v) => p.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  for (const q of variant.query) {
    const v = args[q.wire];
    // team_id in a query only qualifies custom_task_ids, except on the few endpoints that require it.
    if (q.wire === 'team_id' && !q.required && !args.custom_task_ids) continue;
    if (v === undefined || v === null) {
      if (q.required) throw new Error(`Missing required query parameter: ${q.wire}`);
      continue;
    }
    if (q.style === 'json') add(q.wire, typeof v === 'string' ? v : JSON.stringify(v));
    else if (q.style === 'brackets') [].concat(v).forEach(x => add(`${q.wire}[]`, x));
    else if (q.style === 'repeat') [].concat(v).forEach(x => add(q.wire, x));
    else add(q.wire, v);
  }
  return p.length ? `?${p.join('&')}` : '';
}
function multipartBody(field, filePath, fields, filename) {
  const boundary = `----clickup-mcp-${Date.now().toString(16)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  // CR, LF and quotes would end the header line or the quoted value and let a name add headers.
  const name = (filename || nodePath.basename(filePath)).replace(/["\r\n]/g, '');
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name.replace(/"/g, '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(fs.readFileSync(filePath));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { data: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
// The HTTP request a tool call makes, without sending it (unit-tested).
function buildRequest(tool, args) {
  const v = pickVariant(tool, args);
  for (const p of v.pathParams) {
    if (!given(args[p])) throw new Error(`${tool.name}: missing ${p}`);
  }
  const path = v.path.replace(/\{([^}]+)\}/g, (_, p) => encodeURIComponent(String(args[p]))) + queryString(v, args);
  let body = null;
  if (v.body.kind === 'json' && v.body.raw) body = args.body;
  else if (v.body.kind === 'json') {
    body = {};
    for (const k of v.body.props) if (args[k] !== undefined) body[k] = args[k];
  } else if (v.body.kind === 'multipart') {
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
async function sendRequest(req) {
  const body = req.body && req.body.multipart ? multipartBody(req.body.field, req.body.filePath, req.body.fields, req.body.filename) : req.body;
  if (req.route.key) return viaObject(req.route.key, req.route.team, req.method, req.path, body);
  if (req.route.team) return viaTeam(req.route.team, req.method, req.path, body);
  // No workspace in the path or the call (the authorized user): any token answers for its owner.
  return viaObject(null, undefined, req.method, req.path, body);
}
const call = (name, args) => sendRequest(buildRequest(BY_NAME.get(name), args));

// ---- overrides: tools that do more than their one request ----
const dueMs = d => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T12:00:00').getTime() : d);
const PRIORITY = { urgent: 1, high: 2, normal: 3, low: 4 };
// create_task / update_task accept the shorthands they always have (markdown_description, priority
// by word, due_date as YYYY-MM-DD) next to every field ClickUp takes.
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
const renameSpaceBody = (space, name) => ({
  name, color: space.color, private: space.private, admin_can_manage: space.admin_can_manage,
  multiple_assignees: space.multiple_assignees, features: space.features,
});
const SPACE_FIELDS = ['name', 'color', 'private', 'admin_can_manage', 'multiple_assignees', 'features'];
const pick = (a, keys) => Object.fromEntries(keys.filter(k => a[k] !== undefined).map(k => [k, a[k]]));
const folderSummary = f => ({ id: f.id, name: f.name, space: f.space && { id: f.space.id, name: f.space.name }, lists: (f.lists || []).map(l => ({ id: l.id, name: l.name })) });
const taskSummary = t => ({ id: t.id, name: t.name, status: t.status && t.status.status, archived: t.archived, parent: t.parent, list: t.list && { id: t.list.id, name: t.list.name } });

const OVERRIDES = {
  async clickup_list_workspaces() {
    // Each token sees its own workspace; the union is every workspace this server can reach.
    const seen = new Map();
    for (const token of Object.values(tokens())) {
      const r = await api('GET', '/api/v2/team', null, token);
      for (const t of r.teams || []) seen.set(t.id, { id: t.id, name: t.name });
    }
    return [...seen.values()];
  },
  async clickup_get_hierarchy({ team_id, space_id }) {
    const spaces = space_id ? [await viaObject(`space:${space_id}`, team_id, 'GET', `/api/v2/space/${space_id}`)]
                            : ((await viaTeam(team_id, 'GET', `/api/v2/team/${team_id}/space`)).spaces || []);
    const out = [];
    for (const sp of spaces) {
      const key = `space:${sp.id}`;
      const folders = (await viaObject(key, team_id, 'GET', `/api/v2/space/${sp.id}/folder`)).folders || [];
      const folderless = (await viaObject(key, team_id, 'GET', `/api/v2/space/${sp.id}/list`)).lists || [];
      out.push({
        id: sp.id, name: sp.name, type: 'space',
        folders: folders.map(f => ({ id: f.id, name: f.name, lists: (f.lists || []).map(l => ({ id: l.id, name: l.name })) })),
        lists: folderless.map(l => ({ id: l.id, name: l.name })),
      });
    }
    return out;
  },
  async clickup_filter_tasks(a) {
    // ClickUp's API still calls folders "projects"; folder_ids is the name this tool always took.
    const project_ids = a.project_ids || a.folder_ids;
    const r = await call('clickup_filter_tasks', { ...a, project_ids, subtasks: a.subtasks !== undefined ? a.subtasks : true });
    if (a.raw) return r;
    return (r.tasks || []).map(t => ({ id: t.id, name: t.name, status: t.status && t.status.status, priority: t.priority && t.priority.priority, due_date: t.due_date, list: t.list && { id: t.list.id, name: t.list.name } }));
  },
  async clickup_list_tasks(a) {
    // Tasks of ONE list, with archived support and full pagination. The team-level
    // filter_tasks cannot see tasks that live in an ARCHIVED list; this can.
    const out = [];
    for (let page = 0; ; page++) {
      const r = await call('clickup_list_tasks', { ...a, include_closed: a.include_closed !== false, subtasks: a.subtasks !== undefined ? a.subtasks : true, archived: !!a.archived, page });
      const ts = r.tasks || [];
      for (const t of ts) out.push(a.raw ? t : taskSummary(t));
      if (ts.length < 100) break;
    }
    return out;
  },
  async clickup_create_task(a) { return call('clickup_create_task', taskArgs(a)); },
  async clickup_update_task(a) {
    const args = taskArgs(a);
    // priority: null clears it; the word map above leaves null alone.
    return call('clickup_update_task', args);
  },
  async clickup_move_task(a) {
    // Real move: v3 reassigns the task's HOME list. (v2 genuinely cannot do this — its
    // POST /list/{id}/task/{id} is "add to an ADDITIONAL list" and leaves the original
    // home list in place, which looks like a move and isn't. That was the old bug here.)
    // status_mappings is only needed when the task's current status doesn't exist in the
    // destination list; lists sharing a space-level status set need none.
    await call('clickup_move_task', { ...a, move_custom_fields: a.move_custom_fields !== false });
    // v3 returns no useful body; read back so the caller sees the truth, not our assumption.
    const t = await viaTeam(a.team_id, 'GET', `/api/v2/task/${a.task_id}`);
    return { id: t.id, name: t.name, status: t.status && t.status.status, list: t.list && { id: t.list.id, name: t.list.name }, archived: t.archived };
  },
  async clickup_get_list(a) {
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
    return folderSummary(await viaObject(`folder:${a.folder_id}`, a.team_id, 'GET', `/api/v2/folder/${a.folder_id}`));
  },
  async clickup_create_space(a) {
    // With like_space_id, starts from that space's settings and applies the given fields on top.
    // Statuses are never copied: the API gives a new space ClickUp's default statuses.
    let body = pick(a, SPACE_FIELDS);
    if (a.like_space_id) {
      const like = await viaObject(`space:${a.like_space_id}`, a.team_id, 'GET', `/api/v2/space/${a.like_space_id}`);
      body = { ...renameSpaceBody(like, a.name), ...body };
    }
    const s = await viaTeam(a.team_id, 'POST', `/api/v2/team/${a.team_id}/space`, body);
    return { id: s.id, name: s.name, statuses: (s.statuses || []).map(x => ({ status: x.status, type: x.type })) };
  },
  async clickup_update_space(a) {
    const key = `space:${a.space_id}`;
    const space = await viaObject(key, a.team_id, 'GET', `/api/v2/space/${a.space_id}`);
    const body = { ...renameSpaceBody(space, space.name), ...pick(a, SPACE_FIELDS) };
    const s = await viaObject(key, a.team_id, 'PUT', `/api/v2/space/${a.space_id}`, body);
    return { id: s.id, name: s.name };
  },
};

// Schema changes for the overrides: shorthands they accept, fields they fill themselves.
const RAW = { type: 'boolean', description: "Return ClickUp's full response instead of the summary" };
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
  clickup_filter_tasks: s => {
    s.properties.raw = RAW;
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

const TOOLS = GENERATED.map(t => {
  const tool = { name: t.name, description: t.description, inputSchema: JSON.parse(JSON.stringify(t.inputSchema)) };
  if (SCHEMA_PATCHES[t.name]) SCHEMA_PATCHES[t.name](tool.inputSchema, tool);
  return tool;
});
TOOLS.push({ name: 'clickup_get_hierarchy', description: 'Spaces + folders + lists for a team (team_id) or a single space (space_id).', inputSchema: { type: 'object', properties: { team_id: { type: 'string' }, space_id: { type: 'string' } }, required: [] } });

async function runTool(name, args) {
  if (OVERRIDES[name]) return OVERRIDES[name](args);
  const req = buildRequest(BY_NAME.get(name), args);
  const r = await sendRequest(req);
  // Writes that answer with an empty body (deletes, adds, moves) say so; an empty read stays empty.
  const empty = r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 0;
  return empty && req.method !== 'GET' ? { ok: true } : r;
}

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

// ---- tools/call runs STRICTLY ONE AT A TIME ----
// readline fires a fresh async handler per line and never awaits the previous one, so
// pipelined calls used to interleave. That cost nothing in throughput (throttle() already
// serialises every HTTP request) and cost correctness twice: a multi-step tool such as
// move_task (PUT home_list, then read back) could have another call land between its two
// steps, and a caller's write + read-back of the same object could resolve out of order and
// report a successful rename as failed.
// Protocol methods (initialize / tools/list / ping) are deliberately NOT queued — they touch
// no API, and making a health-check wait behind a long tool backlog is how clients time out.
let callQueue = Promise.resolve();
function enqueueCall(id, params) {
  callQueue = callQueue.then(async () => {
    const name = params && params.name;
    if (!OVERRIDES[name] && !BY_NAME.has(name)) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool ${name}` } });
    try {
      const result = await runTool(name, (params && params.arguments) || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    } catch (e) {
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32000, message: String((e && e.message) || e) } });
    }
  });
  // A rejection here would poison the chain and silently wedge every later call; the inner
  // try/catch should prevent it, so this is a belt-and-braces reset rather than a handler.
  callQueue = callQueue.catch(() => {});
}

if (require.main === module) {
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
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
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32000, message: String((e && e.message) || e) } });
  }
});
try { tokens(); } catch (e) { process.stderr.write(`ERROR: ${e.message}\n`); }
}

module.exports = { parseTokens, isScopeMiss, renameSpaceBody, buildRequest, multipartBody, taskArgs, TOOLS, BY_NAME };
