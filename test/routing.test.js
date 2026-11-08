'use strict';
// node --test  (built-in runner; no dependencies)
const test = require('node:test');
const assert = require('node:assert');
const { parseTokens, isScopeMiss } = require('../clickup-stdio.js');

test('parses a workspace -> token map and trims values', () => {
  assert.deepStrictEqual(parseTokens('{"123":" tok-a ","456":"tok-b"}', 'src'), { 123: 'tok-a', 456: 'tok-b' });
});
test('refuses input that is not JSON, naming the source', () => {
  assert.throws(() => parseTokens('tok-a', 'env X'), /env X is not JSON/);
});
test('refuses an empty map or a non-object', () => {
  assert.throws(() => parseTokens('{}', 'src'), /no workspace tokens/);
  assert.throws(() => parseTokens('["tok-a"]', 'src'), /no workspace tokens/);
});
test('refuses a key that is not a workspace id', () => {
  assert.throws(() => parseTokens('{"snackbyte":"tok-a"}', 'src'), /"snackbyte" is not a workspace id/);
});
test('refuses a workspace with an empty token', () => {
  assert.throws(() => parseTokens('{"123":"  "}', 'src'), /workspace 123 has no token/);
});
test('only OAUTH_023 / OAUTH_027 401s mean "wrong workspace, try the next"', () => {
  assert.strictEqual(isScopeMiss({ status: 401, ecode: 'OAUTH_023' }), true);
  assert.strictEqual(isScopeMiss({ status: 401, ecode: 'OAUTH_027' }), true);
  assert.strictEqual(isScopeMiss({ status: 401, ecode: 'OAUTH_025' }), false); // revoked token: real error
  assert.strictEqual(isScopeMiss({ status: 404, ecode: 'OAUTH_023' }), false);
  assert.strictEqual(isScopeMiss({ status: 500 }), false);
  assert.strictEqual(isScopeMiss(undefined), false);
});

const { renameSpaceBody } = require('../clickup-stdio.js');
test('a space rename sends every setting back as read, with only the name changed', () => {
  const features = { due_dates: { enabled: true, start_date: false, remap_due_dates: true, remap_closed_due_date: false }, tags: { enabled: true } };
  const space = { id: '9', name: 'platforms', color: '#7B68EE', private: false, admin_can_manage: true, multiple_assignees: true, features, statuses: [{ status: 'backlog' }] };
  assert.deepStrictEqual(renameSpaceBody(space, 'builders'), { name: 'builders', color: '#7B68EE', private: false, admin_can_manage: true, multiple_assignees: true, features });
});
