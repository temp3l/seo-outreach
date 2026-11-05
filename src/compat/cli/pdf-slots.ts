/** The multi-site launcher brokers browser permits over each worker's dedicated
 * IPC channel. Independent single-site invocations keep their existing behavior. */
export const PDF_SCHEDULER_ENV = 'WEBCRAWL_PDF_SCHEDULER';
export const PDF_REQUEST = 'webcrawl:pdf:request';
export const PDF_GRANTED = 'webcrawl:pdf:granted';
export const PDF_RELEASE = 'webcrawl:pdf:release';
export const WORKER_STOP_GRACE_MS = 5_000;

let sequence = 0;

/** A managed CLI worker must not outlive its launcher between PDF phases.
 * SIGTERM allows active browser cleanup; SIGKILL also bounds uncooperative work
 * after the owner has disappeared and can no longer enforce its own deadline. */
export function watchSchedulerLifetime(): () => void {
  if (process.env[PDF_SCHEDULER_ENV] !== '1') return () => {};
  if (!process.send || !process.connected) throw new Error('pdf_scheduler_disconnected');
  const disconnected = () => {
    const timer = setTimeout(() => process.kill(process.pid, 'SIGKILL'), WORKER_STOP_GRACE_MS);
    timer.unref();
    process.kill(process.pid, 'SIGTERM');
  };
  process.once('disconnect', disconnected);
  // Once disconnection starts termination, its force-stop timer deliberately
  // survives cleanup if outstanding operations keep the worker alive.
  return () => { process.off('disconnect', disconnected); };
}

export async function withPdfSlot<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  if (process.env[PDF_SCHEDULER_ENV] !== '1') return operation(controller.signal);
  if (!process.send || !process.connected) throw new Error('pdf_scheduler_disconnected');
  const id = ++sequence;
  let granted = false;
  let rejectWaiting: (error: Error) => void = () => {};
  const disconnected = () => {
    const error = new Error('pdf_scheduler_disconnected');
    controller.abort(error);
    rejectWaiting(error);
  };
  const interrupted = () => {
    const error = new Error('pdf_scheduler_aborted');
    controller.abort(error);
    rejectWaiting(error);
  };
  let onMessage: (message: unknown) => void = () => {};
  process.once('disconnect', disconnected);
  process.once('SIGTERM', interrupted);
  try {
    await new Promise<void>((resolve, reject) => {
      rejectWaiting = reject;
      onMessage = message => {
        if (message && typeof message === 'object' && 'type' in message && 'id' in message && message.type === PDF_GRANTED && message.id === id) {
          granted = true;
          resolve();
        }
      };
      process.on('message', onMessage);
      process.send!({ type: PDF_REQUEST, id }, undefined, undefined, (error: Error | null) => { if (error) reject(error); });
    });
    process.off('message', onMessage);
    return await operation(controller.signal);
  } finally {
    process.off('message', onMessage);
    process.off('disconnect', disconnected);
    process.off('SIGTERM', interrupted);
    if (granted && process.connected) {
      // A broken channel must not mask a render error. The launcher also frees
      // permits when a worker exits, including after a broken connection.
      try { process.send!({ type: PDF_RELEASE, id }, undefined, undefined, () => {}); } catch { /* channel closed */ }
    }
  }
}
