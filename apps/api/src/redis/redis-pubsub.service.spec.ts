import { describe, expect, it } from '@jest/globals';
import { RedisPubSubService } from './redis-pubsub.service';

describe('RedisPubSubService (In-memory fallback)', () => {
  it('dispatches published messages to subscribers', async () => {
    const pubsub = new RedisPubSubService(null, null);
    const received: string[] = [];

    const unsubscribe = await pubsub.subscribe<string>(
      'test-channel',
      (msg) => {
        received.push(msg);
      },
    );

    await pubsub.publish('test-channel', 'hello world');
    expect(received).toEqual(['hello world']);

    unsubscribe();
    await pubsub.publish('test-channel', 'hello again');
    expect(received).toEqual(['hello world']);
  });
});
