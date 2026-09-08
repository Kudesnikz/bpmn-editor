import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { JsonWorkerPool } from '../src/server/json-bpmn/worker-pool.js';

describe('isolated JSON workers', () => {
  it('runs descriptors and diagram reads in the actual worker runtime', async () => {
    const pool = new JsonWorkerPool();
    try {
      const types = await pool.run({ kind: 'types', types: ['bpmn:Task'] });
      expect(types.types).toHaveLength(1);
      const result = await pool.run({ kind: 'read', xml: await readFile('diagrams/shop.bpmn', 'utf8'), revision: 'rev', options: { scope: 'summary' }, maxBytes: 2097152 });
      expect(result.revision).toBe('rev');
      expect(JSON.stringify(result)).not.toContain('<?xml');
    } finally { await pool.close(); }
  });

  it('bounds queue length and rejects work after shutdown', async () => {
    const pool = new JsonWorkerPool(15000, 1);
    const job = { kind: 'types' as const, types: ['bpmn:Task'] };
    const first = pool.run(job);
    const second = pool.run(job);
    await expect(pool.run(job)).rejects.toMatchObject({ code: 'JSON_QUEUE_FULL' });
    await Promise.all([first, second]);
    await pool.close();
    await expect(pool.run(job)).rejects.toMatchObject({ code: 'SERVER_STOPPING' });
  });

  it('terminates overdue computation without leaving the worker slot occupied', async () => {
    const pool = new JsonWorkerPool(1);
    try {
      await expect(pool.run({ kind: 'types', types: ['bpmn:Task'] })).rejects.toMatchObject({ code: 'JSON_PROCESSING_TIMEOUT' });
      await expect(pool.run({ kind: 'types', types: ['bpmn:Task'] })).rejects.toMatchObject({ code: 'JSON_PROCESSING_TIMEOUT' });
    } finally { await pool.close(); }
  });
});
