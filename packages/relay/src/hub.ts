import { randomBytes } from 'node:crypto';
import type { RelayChange } from './events.js';

export interface RelayEvent extends RelayChange {
  /** `<boot>-<sequence>`. A watch sends it back in `Last-Event-ID` to get the events that it missed. */
  id: string;
  at: string;
}

export interface Subscriber {
  /** True if the subscriber can read the repository. */
  reads(repo: string): boolean;
  send(event: RelayEvent): void;
}

/**
 * Keeps the last events in memory and sends each new event to the subscribers that can read its
 * repository. A restart loses the kept events: a watch that resumes after a restart gets a reset.
 */
export class Hub {
  private readonly boot = randomBytes(4).toString('hex');
  private sequence = 0;
  private readonly kept: RelayEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();

  constructor(
    private readonly capacity = 10_000,
    private readonly now = () => new Date(),
  ) {}

  publish(change: RelayChange): RelayEvent {
    const event = { id: `${this.boot}-${++this.sequence}`, at: this.now().toISOString(), ...change };
    this.kept.push(event);
    if (this.kept.length > this.capacity) this.kept.shift();
    for (const subscriber of this.subscribers) {
      if (!subscriber.reads(event.repo)) continue;
      // A stream that fails must not stop the delivery to the others, or the answer to GitHub.
      try {
        subscriber.send(event);
      } catch (error) {
        console.error(error);
      }
    }
    return event;
  }

  /**
   * Adds a subscriber. With `lastEventId`, returns the kept events after it that the subscriber can
   * read, or `reset` if the hub does not keep that event any more: the watch must then read all.
   */
  subscribe(subscriber: Subscriber, lastEventId?: string): { missed: RelayEvent[] } | 'reset' {
    this.subscribers.add(subscriber);
    if (!lastEventId) return { missed: [] };
    const [boot, sequence] = lastEventId.split('-');
    const after = Number(sequence);
    const oldest = this.kept[0] ? Number(this.kept[0].id.split('-')[1]) : this.sequence + 1;
    if (boot !== this.boot || !Number.isInteger(after) || after > this.sequence || after < oldest - 1) return 'reset';
    const missed = this.kept.filter((event) => Number(event.id.split('-')[1]) > after);
    return { missed: missed.filter((event) => subscriber.reads(event.repo)) };
  }

  unsubscribe(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
  }

  get size(): number {
    return this.subscribers.size;
  }
}
