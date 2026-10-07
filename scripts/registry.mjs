import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const root = new URL('../', import.meta.url);
const registry = 'https://registry.modelcontextprotocol.io/v0.1';
const readJSON = async (path) => JSON.parse(await readFile(path, 'utf8'));

export function assertPackageMatches(server, pkg) {
  assert.equal(server.name, pkg.mcpName, 'server.name must match package.json mcpName');
  assert.equal(server.version, pkg.version, 'Run npm run registry:sync after changing the package version');
  assert.equal(server.packages.length, 1, 'Expected one npm package');
  assert.equal(server.packages[0].identifier, pkg.name, 'Registry package name mismatch');
  assert.equal(server.packages[0].version, pkg.version, 'Registry package version mismatch');
}

export function validateSchema(server, schema) {
  // The upstream draft-07 schema includes annotation keywords that Ajv strict
  // mode does not recognize. Formats and all schema constraints still apply.
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(server)) throw new Error(ajv.errorsText(validate.errors, { separator: '\n' }));
}

async function get(url, fetcher) {
  return fetcher(url, { signal: AbortSignal.timeout(30_000) });
}

export async function checkPublication(server, fetcher = fetch) {
  const item = server.packages[0];
  const npm = await get(`https://registry.npmjs.org/${encodeURIComponent(item.identifier)}/${encodeURIComponent(item.version)}`, fetcher);
  if (!npm.ok) throw new Error(`npm lookup failed: HTTP ${npm.status}. Publish the package before the registry entry.`);
  const published = await npm.json();
  assert.equal(published.name, item.identifier, 'Published npm package name mismatch');
  assert.equal(published.version, item.version, 'Published npm version mismatch');
  assert.equal(published.mcpName, server.name, 'Published npm package must contain the matching mcpName');

  const response = await get(`${registry}/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`, fetcher);
  // Only a confirmed 404 means this version is missing. Auth, rate limit,
  // network and server failures must never be mistaken for a new version.
  if (response.status === 404) return true;
  if (!response.ok) throw new Error(`MCP Registry lookup failed: HTTP ${response.status}`);
  const entry = await response.json();
  assert.equal(entry.server?.name, server.name, 'Unexpected registry server');
  assert.equal(entry.server?.version, server.version, 'Unexpected registry version');
  return false;
}

async function main() {
  const [command, schemaPath] = process.argv.slice(2);
  const serverPath = new URL('server.json', root);
  const server = await readJSON(serverPath);
  const pkg = await readJSON(new URL('package.json', root));
  if (command === 'sync') {
    server.version = pkg.version;
    server.packages[0].version = pkg.version;
    await writeFile(serverPath, JSON.stringify(server, null, 2) + '\n');
    console.log(`Synchronized registry version ${pkg.version}`);
    return;
  }
  assertPackageMatches(server, pkg);
  if (command === 'validate') {
    let schema;
    if (schemaPath) schema = await readJSON(schemaPath);
    else {
      const response = await get(server.$schema, fetch);
      if (!response.ok) throw new Error(`Schema download failed: HTTP ${response.status}`);
      schema = await response.json();
    }
    validateSchema(server, schema);
    console.log(`Valid: ${server.name}@${server.version} against ${server.$schema}`);
  } else if (command === 'check') {
    const publish = await checkPublication(server);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
    console.log(publish ? 'Package verified; registry version is missing.' : 'Registry version already exists; skipping. Bump the version to change metadata.');
  } else throw new Error('Usage: node scripts/registry.mjs validate [schema.json] | sync | check');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
