/** Owns one asynchronous operation deadline, including setup. It cannot preempt
 * synchronous JavaScript or physically stop noncooperative injected work. */
export class OperationDeadline {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly endAt: number;
  private readonly abort: () => void;
  readonly signal: AbortSignal;
  constructor(timeoutMs: number, private readonly caller?: AbortSignal, private readonly timeoutCode = 'operation_timeout', abortCode = 'operation_aborted') {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid_operation_timeout');
    this.signal = this.controller.signal;
    this.endAt = performance.now() + timeoutMs;
    this.abort = () => this.controller.abort(new Error(abortCode));
    caller?.addEventListener('abort', this.abort, { once: true });
    if (caller?.aborted) this.abort();
    this.timer = setTimeout(() => this.controller.abort(new Error(timeoutCode)), Math.min(timeoutMs, 2_147_000_000));
  }
  remainingMs(): number { return Math.max(0, this.endAt - performance.now()); }
  run<T>(operation: () => Promise<T>, disposeLate?: (value: T) => Promise<unknown>): Promise<T> {
    if (this.remainingMs() <= 0) this.controller.abort(new Error(this.timeoutCode));
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => { this.signal.removeEventListener('abort', abort); reject(this.signal.reason); };
      this.signal.addEventListener('abort', abort, { once: true });
      let pending: Promise<T>;
      try { pending = Promise.resolve(operation()); } catch (error) { pending = Promise.reject(error); }
      void pending.then(value => {
        this.signal.removeEventListener('abort', abort);
        if (this.remainingMs() <= 0) this.controller.abort(new Error(this.timeoutCode));
        if (this.signal.aborted) {
          if (disposeLate) void Promise.resolve().then(() => disposeLate(value)).catch(() => {});
          reject(this.signal.reason);
        } else resolve(value);
      }, error => { this.signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  cancel(code = 'operation_cancelled'): void { this.controller.abort(new Error(code)); }
  dispose(): void { clearTimeout(this.timer); this.caller?.removeEventListener('abort', this.abort); this.controller.abort(new Error('operation_finished')); }
}

/** Cleanup gets only the remaining operation budget (minimum 1ms to attempt it).
 * A noncooperative close may outlive this wrapper; late rejection stays handled. */
export async function closeWithin(operation: () => Promise<unknown>, remainingMs: number, code: string): Promise<void> {
  const deadline = new OperationDeadline(Math.max(1, remainingMs), undefined, code);
  try { await deadline.run(operation); } finally { deadline.dispose(); }
}
