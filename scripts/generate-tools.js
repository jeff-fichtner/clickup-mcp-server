#!/usr/bin/env node
// Builds tools.generated.json from ClickUp's published OpenAPI specs, one tool per operation
// (names in ../names.js). Run after refreshing spec/:
//   curl -s https://developer.clickup.com/openapi/clickup-api-v2-reference.json -o spec/clickup-api-v2.json
//   curl -s https://developer.clickup.com/openapi/ClickUp_PUBLIC_API_V3.yaml -o spec/clickup-api-v3.json
//   node scripts/generate-tools.js
// (The v3 ".yaml" is served as JSON.) Fails on an operation with no name, on a name clash, and on
// an argument that means two different things in one tool.
'use strict';
const fs = require('fs');
const path = require('path');
const { NAMES, EXCLUDED } = require('../names.js');

const ROOT = path.join(__dirname, '..');
const SPECS = ['spec/clickup-api-v2.json', 'spec/clickup-api-v3.json'];
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const TEAM_PARAMS = new Set(['team_id', 'team_Id', 'workspace_id']);
const OPTIONAL_TEAM = 'Optional workspace id; skips finding which workspace owns the object';
const MAX_DEPTH = 6;
// Not deletes by method or name, and still destroy data: a merge deletes the source tasks; a
// replace overwrites every estimate on the task.
const DESTRUCTIVE = new Set(['mergeTasks', 'replaceTimeEstimatesByUser']);

// Where the published spec is wrong, as observed against the live API. Keyed by operationId, then
// argument; each value replaces that argument's schema, and `optional: true` un-requires it.
const SPEC_FIXES = {
  // The spec requires both; a dependency is removed by naming one side of it.
  DeleteDependency: {
    depends_on: { type: 'string', description: 'The task this one waits on. Give this or dependency_of.', optional: true },
    dependency_of: { type: 'string', description: 'The task waiting on this one. Give this or depends_on.', optional: true },
  },
  // The spec's enum says "attachments"; ClickUp answers 404 to it and serves task attachments
  // under "tasks" (observed 2026-10-25).
  getParentEntityAttachments: { entity_type: { type: 'string', enum: ['tasks', 'custom_fields'], description: '`tasks` for a task (entity_id is the task id), `custom_fields` for a File custom field' } },
  postEntityAttachment: { entity_type: { type: 'string', enum: ['tasks', 'custom_fields'], description: '`tasks` for a task (entity_id is the task id), `custom_fields` for a File custom field' } },
  // Emoji names as ClickUp spells them: "+1" works, "👍", "thumbs_up" and ":thumbsup:" are refused.
  createChatReaction: { reaction: { type: 'string', description: 'Emoji name as ClickUp spells it, e.g. "+1" (not the emoji itself)' } },
  deleteChatReaction: { reaction: { type: 'string', description: 'Emoji name as ClickUp spells it, e.g. "+1" (not the emoji itself)' } },
};

const trim = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
};

function pointer(doc, ref) {
  if (!ref.startsWith('#/')) throw new Error(`external $ref not supported: ${ref}`);
  return ref.slice(2).split('/').reduce((o, k) => o[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
}

// A JSON schema a model can fill in: $refs resolved, allOf merged, anyOf/oneOf of objects merged
// into one object (SetCustomFieldValue takes one of several shapes of `value`), examples dropped.
function simplify(doc, schema, depth = 0, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return {};
  if (schema.$ref) {
    if (seen.has(schema.$ref) || depth > MAX_DEPTH) return { type: 'object' };
    return simplify(doc, pointer(doc, schema.$ref), depth, new Set([...seen, schema.$ref]));
  }
  if (depth > MAX_DEPTH) return schema.type ? { type: schema.type } : {};
  if (schema.allOf) {
    const parts = schema.allOf.map(s => simplify(doc, s, depth, seen));
    return mergeObjects(parts, schema.description, true);
  }
  const alts = schema.anyOf || schema.oneOf;
  if (alts) {
    const parts = alts.map(s => simplify(doc, s, depth, seen));
    if (parts.every(p => p.type === 'object')) return mergeObjects(parts, schema.description, false);
    const types = [...new Set(parts.map(p => p.type).filter(Boolean))];
    const out = types.length === 1 ? { type: types[0] } : {};
    if (schema.description) out.description = trim(schema.description, 200);
    return out;
  }
  const out = {};
  let type = Array.isArray(schema.type) ? schema.type.find(t => t !== 'null') : schema.type;
  if (!type && schema.properties) type = 'object';
  if (type) out.type = type === 'integer' || type === 'number' ? 'number' : type;
  if (schema.description) out.description = trim(schema.description, 200);
  if (schema.enum) out.enum = schema.enum.filter(v => v !== null);
  if (type === 'array') out.items = simplify(doc, schema.items || {}, depth + 1, seen);
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = simplify(doc, v, depth + 1, seen);
    if (schema.required && schema.required.length) out.required = schema.required.filter(r => r in out.properties);
  }
  return out;
}
function mergeObjects(parts, description, keepRequired) {
  const out = { type: 'object', properties: {} };
  const required = [];
  for (const p of parts) {
    for (const [k, v] of Object.entries(p.properties || {})) {
      const prev = out.properties[k];
      // The same field typed differently across alternatives: say nothing rather than one wrong type.
      out.properties[k] = prev && JSON.stringify(prev) !== JSON.stringify(v) ? (v.description ? { description: v.description } : {}) : v;
    }
    if (keepRequired) required.push(...(p.required || []));
  }
  if (!keepRequired) {
    const common = parts.map(p => new Set(p.required || []));
    required.push(...[...(common[0] || [])].filter(r => common.every(s => s.has(r))));
  }
  if (required.length) out.required = [...new Set(required)];
  if (description) out.description = trim(description, 200);
  return out;
}

function describe(op, method) {
  const first = trim(String(op.description || '').replace(/\\\s/g, ' ').split(/(?<=\.)\s/)[0], 220);
  let d = trim(op.summary || op.operationId, 120);
  if (first && first.toLowerCase() !== d.toLowerCase()) d += `. ${first}`;
  if (method === 'delete' || /^(Remove|Delete)/i.test(op.operationId) || DESTRUCTIVE.has(op.operationId)) d += ' Irreversible: confirm the exact id with the user first.';
  if (/^Invite/.test(op.operationId)) d += ' Sends an invitation email.';
  return d;
}

function variantOf(doc, method, rawPath, op) {
  const params = op.parameters || [];
  const pathParams = [];
  const apiPath = rawPath.replace(/\{([^}]+)\}/g, (_, p) => {
    const arg = TEAM_PARAMS.has(p) ? 'team_id' : p;
    pathParams.push(arg);
    return `{${arg}}`;
  });
  const props = {};
  const required = new Set(pathParams);
  for (const p of params.filter(p => p.in === 'path')) {
    const arg = TEAM_PARAMS.has(p.name) ? 'team_id' : p.name;
    // Ids are strings here whatever the spec says (ClickUp ids overflow JSON numbers); enums stay.
    const sch = simplify(doc, p.schema || {});
    props[arg] = sch.enum ? { type: 'string', enum: sch.enum } : { type: 'string' };
    if (p.description) props[arg].description = trim(p.description, 200);
  }
  for (const a of pathParams) if (!props[a]) props[a] = { type: 'string' };
  const query = [];
  for (const p of params.filter(p => p.in === 'query')) {
    const wire = p.name.replace(/\[\]$/, '');
    let schema = simplify(doc, p.schema || {});
    const desc = String(p.description || '');
    // How ClickUp wants each array on the wire, read from the spec's own examples: `name=[{…}]` is
    // one JSON value, `name=a&name=b` repeats the bare name, and anything else takes `name[]=`.
    let style = 'plain';
    if (new RegExp(`${wire}=\\[\\{`).test(desc)) style = 'json';
    else if (new RegExp(`${wire}=[^&\`\\s]*&${wire}=`).test(desc)) style = 'repeat';
    else if (schema.type === 'array' || p.name.endsWith('[]')) style = 'brackets';
    if (style === 'json') schema = { type: 'array', items: { type: 'object' } };
    if (style !== 'plain' && schema.type !== 'array') schema = { type: 'array', items: schema.type ? { type: schema.type } : { type: 'string' } };
    // "team_id is a required query parameter" is said in prose, not in `required`.
    const isRequired = !!p.required || /required query parameter/i.test(desc);
    query.push({ wire, style, required: isRequired });
    if (wire === 'team_id' && props.team_id) continue;
    props[wire] = schema;
    if (desc && !props[wire].description) props[wire].description = trim(desc.replace(/\\\s/g, ' '), 200);
    if (isRequired) required.add(wire);
  }
  let body = { kind: 'none', props: [] };
  const content = op.requestBody && (op.requestBody.content || (op.requestBody.$ref && pointer(doc, op.requestBody.$ref).content));
  if (content && content['multipart/form-data']) {
    // The file part is `attachment` (v2 names it; v3's schema lists only its text fields).
    const s = simplify(doc, content['multipart/form-data'].schema);
    body = { kind: 'multipart', field: 'attachment', props: Object.keys(s.properties || {}).filter(k => k !== 'attachment') };
    props.file_path = { type: 'string', description: 'Local path of the file to upload' };
    props.filename = { type: 'string', description: 'Name to give the file in ClickUp; default the local name' };
    required.add('file_path');
  } else if (content && content['application/json']) {
    const s = simplify(doc, content['application/json'].schema);
    if (s.type === 'object' || s.properties) {
      body = { kind: 'json', props: Object.keys(s.properties || {}) };
      for (const [k, v] of Object.entries(s.properties || {})) {
        if (props[k] && k !== 'team_id') throw new Error(`${op.operationId}: body field "${k}" clashes with a path or query parameter`);
        if (k === 'team_id' && props.team_id) continue;
        props[k] = v;
      }
      for (const r of s.required || []) required.add(r);
    } else {
      // A body that is not an object (an array, a bare value) is passed whole.
      body = { kind: 'json', raw: true, props: [] };
      props.body = { ...s, description: 'The request body' };
      required.add('body');
    }
  }
  for (const [k, v] of Object.entries(SPEC_FIXES[op.operationId] || {})) {
    if (!props[k]) throw new Error(`SPEC_FIXES: ${op.operationId} has no argument ${k}`);
    const { optional, ...schema } = v;
    props[k] = schema;
    if (optional) {
      required.delete(k);
      for (const q of query) if (q.wire === k) q.required = false;
    }
  }
  return { operationId: op.operationId, method: method.toUpperCase(), path: apiPath, pathParams, query, body, props, required: [...required] };
}

function generate() {
  const byName = new Map();
  const seenOps = new Set();
  for (const file of SPECS) {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const [rawPath, ops] of Object.entries(doc.paths)) {
      for (const method of METHODS) {
        const op = ops[method];
        if (!op) continue;
        const id = op.operationId;
        if (seenOps.has(id)) throw new Error(`operationId ${id} appears twice`);
        seenOps.add(id);
        if (EXCLUDED[id]) continue;
        const name = NAMES[id];
        if (!name) throw new Error(`No tool name for ${id} (${method.toUpperCase()} ${rawPath}): add it to names.js`);
        if (!byName.has(name)) byName.set(name, { name, descriptions: [], variants: [] });
        const t = byName.get(name);
        t.descriptions.push(describe(op, method));
        t.variants.push(variantOf(doc, method, rawPath.startsWith('/api/') ? rawPath : `/api${rawPath}`, op));
      }
    }
  }
  for (const id of [...Object.keys(NAMES), ...Object.keys(EXCLUDED)]) {
    if (!seenOps.has(id)) throw new Error(`names.js names ${id}, which is not in the specs`);
  }
  const tools = [];
  for (const t of byName.values()) {
    const props = {};
    for (const v of t.variants) Object.assign(props, v.props);
    let required = t.variants[0].required.filter(r => t.variants.every(v => v.required.includes(r)));
    let description = t.descriptions[0];
    if (t.variants.length > 1) {
      const parents = t.variants.map(v => v.pathParams.find(p => !t.variants.every(w => w.pathParams.includes(p))));
      description += ` Give ${parents.join(' or ')}.`;
    }
    const inTeamPath = t.variants.every(v => v.pathParams.includes('team_id'));
    if (!inTeamPath && !props.team_id) props.team_id = { type: 'string', description: OPTIONAL_TEAM };
    // Optional unless the path holds it, or the endpoint wants it in the query (/group).
    const teamInQuery = t.variants.every(v => v.query.some(q => q.wire === 'team_id' && q.required));
    if (!inTeamPath && !teamInQuery) required = required.filter(r => r !== 'team_id');
    tools.push({
      name: t.name,
      description,
      variants: t.variants.map(({ props: _p, required: _r, ...v }) => v),
      inputSchema: { type: 'object', properties: props, required },
    });
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

if (require.main === module) {
  const tools = generate();
  fs.writeFileSync(path.join(ROOT, 'tools.generated.json'), JSON.stringify(tools, null, 1) + '\n');
  console.log(`tools.generated.json: ${tools.length} tools, ${tools.reduce((n, t) => n + t.variants.length, 0)} operations`);
}
module.exports = { generate, simplify };
