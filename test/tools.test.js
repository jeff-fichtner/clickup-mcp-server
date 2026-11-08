'use strict';
// node --test  (built-in runner; no dependencies)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generate } = require('../scripts/generate-tools.js');
const { NAMES, EXCLUDED } = require('../names.js');
const { buildRequest, multipartBody, taskArgs, TOOLS, BY_NAME } = require('../clickup-stdio.js');

const tool = name => BY_NAME.get(name);

test('every operation in both specs is a tool or excluded with a reason', () => {
  const ops = [];
  for (const f of ['clickup-api-v2.json', 'clickup-api-v3.json']) {
    const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', f), 'utf8'));
    for (const p of Object.values(doc.paths)) for (const m of ['get', 'post', 'put', 'patch', 'delete']) if (p[m]) ops.push(p[m].operationId);
  }
  assert.strictEqual(ops.length, 173);
  for (const id of ops) assert.ok(NAMES[id] || EXCLUDED[id], `${id} has no tool`);
  const covered = TOOLS.flatMap(t => (BY_NAME.get(t.name) || { variants: [] }).variants.map(v => v.operationId));
  assert.strictEqual(covered.length, 172);
});
test('tools.generated.json is what the generator makes from spec/ (regenerate after editing names.js)', () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools.generated.json'), 'utf8'));
  assert.deepStrictEqual(onDisk, JSON.parse(JSON.stringify(generate())));
});
test('tool names are unique and every path parameter is required', () => {
  const names = TOOLS.map(t => t.name);
  assert.strictEqual(new Set(names).size, names.length);
  for (const t of TOOLS) {
    const g = BY_NAME.get(t.name);
    if (!g || g.variants.length > 1) continue;
    for (const p of g.variants[0].pathParams) assert.ok(t.inputSchema.required.includes(p), `${t.name} does not require ${p}`);
  }
});
test('deletes and removals warn to confirm the id first', () => {
  for (const t of TOOLS) if (/^clickup_(delete|remove)_/.test(t.name)) assert.match(t.description, /confirm the exact id/, t.name);
});
test('the 16 tools of v0.3 keep their names', () => {
  const v03 = 'list_workspaces get_hierarchy filter_tasks list_tasks get_task create_task update_task create_folder update_folder create_list get_list update_list delete_list move_task add_tag_to_task remove_tag_from_task';
  for (const n of v03.split(' ')) assert.ok(TOOLS.some(t => t.name === `clickup_${n}`), n);
});

test('path parameters are filled and encoded; routing follows the first object in the path', () => {
  const r = buildRequest(tool('clickup_delete_space_tag'), { space_id: '9', tag_name: 'needs review' });
  assert.strictEqual(r.method, 'DELETE');
  assert.strictEqual(r.path, '/api/v2/space/9/tag/needs%20review');
  assert.deepStrictEqual(r.route, { key: 'space:9', team: undefined });
});
test('a workspace in the path routes by workspace, for v2 and v3 alike', () => {
  assert.deepStrictEqual(buildRequest(tool('clickup_list_goals'), { team_id: '5' }).route, { team: '5' });
  const doc = buildRequest(tool('clickup_get_doc'), { team_id: '5', doc_id: 'd1' });
  assert.strictEqual(doc.path, '/api/v3/workspaces/5/docs/d1');
  assert.deepStrictEqual(doc.route, { team: '5' });
});
test('a missing path parameter fails before any request', () => {
  assert.throws(() => buildRequest(tool('clickup_get_task'), {}), /missing task_id/);
});
test('a tool over two operations runs the one its arguments fill, and refuses none or both', () => {
  assert.strictEqual(buildRequest(tool('clickup_create_list'), { folder_id: '1', name: 'x' }).path, '/api/v2/folder/1/list');
  assert.strictEqual(buildRequest(tool('clickup_create_list'), { space_id: '2', name: 'x' }).path, '/api/v2/space/2/list');
  assert.throws(() => buildRequest(tool('clickup_create_list'), { name: 'x' }), /exactly one of folder_id, space_id/);
  assert.throws(() => buildRequest(tool('clickup_create_list'), { folder_id: '1', space_id: '2', name: 'x' }), /exactly one/);
});
test('query arrays go out the way ClickUp reads them', () => {
  const tasks = buildRequest(tool('clickup_list_tasks'), {
    list_id: '1', statuses: ['in review', 'testing'], include_closed: true,
    custom_fields: [{ field_id: 'f', operator: '=', value: '1' }],
  });
  assert.strictEqual(tasks.path, '/api/v2/list/1/task?statuses%5B%5D=in%20review&statuses%5B%5D=testing&include_closed=true&custom_fields=%5B%7B%22field_id%22%3A%22f%22%2C%22operator%22%3A%22%3D%22%2C%22value%22%3A%221%22%7D%5D');
  const bulk = buildRequest(tool('clickup_get_bulk_time_in_status'), { task_ids: ['a', 'b'] });
  assert.strictEqual(bulk.path, '/api/v2/task/bulk_time_in_status/task_ids?task_ids=a&task_ids=b');
});
test('team_id goes in the query only with custom_task_ids, or where the endpoint requires it', () => {
  assert.strictEqual(buildRequest(tool('clickup_get_task'), { task_id: 't', team_id: '5' }).path, '/api/v2/task/t');
  assert.strictEqual(buildRequest(tool('clickup_get_task'), { task_id: 'DEV-1', team_id: '5', custom_task_ids: true }).path, '/api/v2/task/DEV-1?custom_task_ids=true&team_id=5');
  assert.strictEqual(buildRequest(tool('clickup_list_user_groups'), { team_id: '5' }).path, '/api/v2/group?team_id=5');
  assert.throws(() => buildRequest(tool('clickup_list_user_groups'), {}), /Missing required query parameter: team_id/);
});
test('a JSON body carries only the fields given', () => {
  const r = buildRequest(tool('clickup_create_checklist_item'), { checklist_id: 'c', name: 'step', assignee: undefined });
  assert.deepStrictEqual(r.body, { name: 'step' });
  assert.strictEqual(buildRequest(tool('clickup_get_task'), { task_id: 't' }).body, null);
});
test('an upload is multipart with the file under "attachment"', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cu-')), 'note.txt');
  fs.writeFileSync(file, 'hello');
  const r = buildRequest(tool('clickup_create_task_attachment'), { task_id: 't', file_path: file });
  assert.strictEqual(r.path, '/api/v2/task/t/attachment');
  const m = multipartBody(r.body.field, r.body.filePath, r.body.fields, r.body.filename);
  const text = m.data.toString();
  assert.match(m.contentType, /^multipart\/form-data; boundary=/);
  assert.match(text, /name="attachment"; filename="note.txt"/);
  assert.match(text, /\r\n\r\nhello\r\n--/);
  const v3 = buildRequest(tool('clickup_create_attachment'), { team_id: '5', entity_type: 'tasks', entity_id: 't', file_path: file, filename: 'renamed.txt' });
  const m3 = multipartBody(v3.body.field, v3.body.filePath, v3.body.fields, v3.body.filename).data.toString();
  assert.match(m3, /name="filename"\r\n\r\nrenamed.txt/);
  assert.match(m3, /name="attachment"; filename="renamed.txt"/);
});
test('task shorthands: markdown_description, priority by word, due_date as a day', () => {
  const a = taskArgs({ name: 'x', markdown_description: '# hi', priority: 'high', due_date: '2026-10-25' });
  assert.strictEqual(a.markdown_content, '# hi');
  assert.strictEqual(a.priority, 2);
  assert.strictEqual(a.due_date, new Date('2026-10-25T12:00:00').getTime());
  assert.strictEqual(taskArgs({ priority: null }).priority, null);
  assert.strictEqual(taskArgs({ due_date: 1761400000000 }).due_date, 1761400000000);
  const body = buildRequest(tool('clickup_create_task'), { list_id: 'l', ...a }).body;
  assert.strictEqual(body.markdown_content, '# hi');
  assert.ok(!('markdown_description' in body));
});
test('a dependency is removed by naming either side of it', () => {
  assert.strictEqual(buildRequest(tool('clickup_delete_dependency'), { task_id: 'a', depends_on: 'b' }).path, '/api/v2/task/a/dependency?depends_on=b');
  assert.strictEqual(buildRequest(tool('clickup_delete_dependency'), { task_id: 'a', dependency_of: 'c' }).path, '/api/v2/task/a/dependency?dependency_of=c');
});
test('a folder move sends the destination space, and a position only when given', () => {
  assert.deepStrictEqual(buildRequest(tool('clickup_move_folder'), { folder_id: '1', space_id: '2' }).body, { space_id: '2' });
  assert.deepStrictEqual(buildRequest(tool('clickup_move_folder'), { folder_id: '1', space_id: '2', position: 0 }).body, { space_id: '2', position: 0 });
});
test('priority: words in any case and 1-4 as number or string; anything else is refused', () => {
  assert.strictEqual(taskArgs({ priority: 'High' }).priority, 2);
  assert.strictEqual(taskArgs({ priority: '3' }).priority, 3);
  assert.strictEqual(taskArgs({ priority: 4 }).priority, 4);
  assert.throws(() => taskArgs({ priority: 'asap' }), /priority must be urgent, high, normal, low or 1-4/);
  assert.throws(() => taskArgs({ priority: 7 }), /priority must be/);
});
test('team_id is required in the schema wherever the server requires it', () => {
  for (const t of TOOLS) {
    const g = BY_NAME.get(t.name);
    if (!g) continue;
    const needed = g.variants.every(v => v.pathParams.includes('team_id') || v.query.some(q => q.wire === 'team_id' && q.required));
    if (needed) assert.ok(t.inputSchema.required.includes('team_id'), t.name);
  }
  assert.deepStrictEqual(TOOLS.find(t => t.name === 'clickup_list_user_groups').inputSchema.required, ['team_id']);
});
test('the parent named in a two-operation error is the one that differs', () => {
  assert.throws(() => buildRequest(tool('clickup_create_list_from_template'), { template_id: 't', name: 'x' }), /exactly one of folder_id, space_id/);
});
test('null counts as not given, alike for choosing an operation and for filling it', () => {
  assert.strictEqual(buildRequest(tool('clickup_create_list'), { folder_id: null, space_id: '2', name: 'x' }).path, '/api/v2/space/2/list');
  assert.throws(() => buildRequest(tool('clickup_create_list'), { folder_id: null, name: 'x' }), /exactly one of folder_id, space_id/);
});
test('an upload is named by filename (v2 too), with CR, LF and quotes stripped', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cu-')), 'x.bin');
  fs.writeFileSync(file, 'data');
  const r = buildRequest(tool('clickup_create_task_attachment'), { task_id: 't', file_path: file, filename: 'report".pdf\r\nX-Injected: 1' });
  const text = multipartBody(r.body.field, r.body.filePath, r.body.fields, r.body.filename).data.toString();
  assert.match(text, /name="attachment"; filename="report.pdfX-Injected: 1"\r\nContent-Type: application\/octet-stream/);
  assert.ok(!/\r\nX-Injected/.test(text));
});
test('merge and replace-estimates warn like deletes do', () => {
  for (const n of ['clickup_merge_tasks', 'clickup_replace_time_estimates_by_user']) assert.match(TOOLS.find(t => t.name === n).description, /confirm the exact id/, n);
});
