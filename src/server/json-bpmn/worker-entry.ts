import { parentPort, workerData } from 'node:worker_threads';
import { AppError } from '../errors.js';
import { executeJsonJob } from './jobs.js';

try {
  const result = await executeJsonJob(workerData);
  parentPort!.postMessage({ ok: true, result });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: error instanceof AppError
    ? { status: error.status, code: error.code, message: error.message, details: error.details }
    : { status: 500, code: 'JSON_PROCESSING_FAILED', message: 'BPMN JSON processing failed' } });
} finally {
  parentPort!.close();
}
