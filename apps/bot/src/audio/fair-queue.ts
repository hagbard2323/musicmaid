import type { QueueEntry } from "./model.js";

export type FairQueue = { queue: QueueEntry[]; rotation: string[] };

/** Keep each requester's own order, while new requesters join behind waiting turns. */
export function scheduleFairQueue(entries: readonly QueueEntry[], waiting: readonly string[] = []): FairQueue {
  const buckets = new Map<string, QueueEntry[]>();
  for (const entry of entries) {
    const owner = entry.request.requestedBy;
    const bucket = buckets.get(owner) ?? [];
    bucket.push(entry); buckets.set(owner, bucket);
  }
  const rotation = [...new Set([...waiting, ...buckets.keys()])].filter(owner => buckets.has(owner));
  const queue: QueueEntry[] = [];
  for (let round = 0; queue.length < entries.length; round++) {
    for (const owner of rotation) {
      const entry = buckets.get(owner)![round];
      if (entry) queue.push(entry);
    }
  }
  return { queue, rotation };
}

/** Consuming one scheduled track rotates that requester, never a whole playlist. */
export function takeFairQueue(entries: readonly QueueEntry[], waiting: readonly string[] = []): FairQueue & { entry?: QueueEntry } {
  const scheduled = scheduleFairQueue(entries, waiting);
  const [entry, ...queue] = scheduled.queue;
  if (!entry) return { queue: [], rotation: [] };
  const remaining = new Set(queue.map(item => item.request.requestedBy));
  const owner = entry.request.requestedBy;
  const rotation = scheduled.rotation.filter(requester => requester !== owner && remaining.has(requester));
  if (remaining.has(owner)) rotation.push(owner);
  return { entry, queue, rotation };
}
