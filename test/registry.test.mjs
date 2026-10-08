import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertPackageMatches, checkPublication, validateSchema } from '../scripts/registry.mjs';

const server = JSON.parse(await readFile(new URL('../server.json', import.meta.url)));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const npm = { name: pkg.name, version: pkg.version, mcpName: pkg.mcpName };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const replies = (...responses) => async () => {
  assert.ok(responses.length, 'Unexpected HTTP request');
  const next = responses.shift();
  if (next instanceof Error) throw next;
  return next;
};

test('registry manifest agrees with the released package identity and version', () => {
  assertPackageMatches(server, pkg);
  assert.throws(() => assertPackageMatches({ ...server, version: '0.0.0' }, pkg));
  assert.throws(() => assertPackageMatches({ ...server, name: 'io.github.other/mcp' }, pkg));
});

test('publish only after npm ownership is verified and registry returns 404', async () => {
  assert.equal(await checkPublication(server, replies(response(npm), response({}, 404))), true);
});

test('rerunning a published version skips registry publishing', async () => {
  assert.equal(await checkPublication(server, replies(response(npm), response({ server }))), false);
});

test('unpublished npm package or ownership mismatch prevents registry publication', async () => {
  await assert.rejects(checkPublication(server, replies(response({}, 404))), /npm lookup failed/);
  await assert.rejects(checkPublication(server, replies(response({ ...npm, mcpName: 'wrong' }))), /mcpName/);
});

test('registry errors cannot masquerade as an unpublished version', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(checkPublication(server, replies(response(npm), response({}, status))), /lookup failed/);
  }
  await assert.rejects(checkPublication(server, replies(response(npm), new Error('network failed'))), /network failed/);
  await assert.rejects(checkPublication(server, replies(response(npm), response({}))), /Unexpected registry/);
});

test('schema validator rejects invalid types and formats', () => {
  const schema = { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' } } };
  validateSchema({ url: 'https://mcp.spicrawl.com/mcp' }, schema);
  assert.throws(() => validateSchema({}, schema));
  assert.throws(() => validateSchema({ url: 42 }, schema));
  assert.throws(() => validateSchema({ url: 'not a URL' }, schema));
});
