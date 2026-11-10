/**
 * Unbounded single-consumer async queue. Producers (the SDK stream loop and
 * permission callbacks) push; the run's event iterator pulls.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  /** Ends iteration after already-queued items are consumed. */
  close(): void {
    this.closed = true;
    if (this.waiter && this.items.length === 0) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: () => {
        this.closed = true;
        this.items.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
