'use strict';
// node --test  (built-in runner; no dependencies)
// Drives the server as an MCP client does: JSON-RPC lines on stdin, one answer per line on stdout.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'clickup-stdio.js');

// Sends the lines, closes stdin, and resolves to every message the server wrote back. No call
// here reaches ClickUp, so the token is never used.
function exchange(lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CLICKUP_TOKENS: '{"111":"tok-a"}' } });
    let out = '';
    let err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, err, messages: out.split('\n').filter(Boolean).map(l => JSON.parse(l)) }));
    child.stdin.end(lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  });
}

test('a line that is JSON but not an object is skipped, and the server keeps answering', async () => {
  const r = await exchange(['null', '5', '"text"', { jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.strictEqual(r.err, '');
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.messages, [{ jsonrpc: '2.0', id: 1, result: {} }]);
});

test('a tool named after an Object.prototype member is an unknown tool', async () => {
  const r = await exchange(['toString', 'constructor', '__proto__', 'hasOwnProperty'].map((name, i) => (
    { jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: {} } })));
  assert.deepStrictEqual(r.messages.map(m => m.error && m.error.message), ['Unknown tool toString', 'Unknown tool constructor', 'Unknown tool __proto__', 'Unknown tool hasOwnProperty']);
  for (const m of r.messages) assert.strictEqual(m.error.code, -32602);
});

test('tools/list serves every tool, the hierarchy included', async () => {
  const r = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const names = r.messages[0].result.tools.map(t => t.name);
  assert.ok(names.includes('clickup_get_hierarchy'));
  assert.ok(names.includes('clickup_create_task'));
});
