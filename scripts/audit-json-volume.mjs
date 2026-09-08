// Run with a read-only volume mounted at /input in a disposable production image.
// Outputs IDs/codes only, never model XML, names, descriptions or credentials.
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { JsonWorkerPool } from '/app/dist/server/json-bpmn/worker-pool.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const initialIndex = await readFile('/input/index.json', 'utf8');
const catalog = JSON.parse(initialIndex);
if (catalog.schemaVersion !== 2 || !Array.isArray(catalog.diagrams)) throw new Error('Expected catalog v2');
const pool = new JsonWorkerPool();
const rows = [];
const selected = new Set(process.argv.slice(2).filter(value => !value.startsWith('--')));
try {
  for (const entry of catalog.diagrams) {
    if (selected.size && !selected.has(entry.id)) continue;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id)) throw new Error('Unsafe diagram ID');
    const filename = `/input/${entry.id}.bpmn`;
    const started = Date.now();
    try {
      const size = (await stat(filename)).size;
      if (size > 2097152) { rows.push({ id: entry.id, compatible: false, code: 'XML_TOO_LARGE' }); continue; }
      const xml = await readFile(filename, 'utf8');
      const prepared = await pool.run({ kind: 'prepare', xml, layoutMode: 'provided', maxBytes: 2097152 });
      const unchanged = hash(await readFile(filename, 'utf8')) === hash(xml);
      rows.push({ id: entry.id, bytes: size, compatible: prepared.validation.valid, unchangedDuringAudit: unchanged, errorCodes: [...new Set(prepared.validation.errors.map(error => error.code))], warnings: prepared.validation.warnings.length, durationMs: Date.now() - started });
    } catch (error) {
      rows.push({ id: entry.id, compatible: false, code: error.code || 'AUDIT_FAILED', message: error.code ? error.message : 'Audit failed', details: error.code ? error.details : undefined, durationMs: Date.now() - started });
    }
  }
  console.log(JSON.stringify({ count: rows.length, compatible: rows.filter(row => row.compatible).length, catalogUnchangedDuringAudit: hash(initialIndex) === hash(await readFile('/input/index.json', 'utf8')), allReadModelsUnchangedDuringAudit: rows.every(row => row.unchangedDuringAudit === true), rows: process.argv.includes('--summary') ? rows.filter(row => !row.compatible) : rows }, null, 2));
} finally { await pool.close(); }
