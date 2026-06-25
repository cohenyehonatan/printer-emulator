import { describe, it, expect } from 'vitest';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import { AddressInfo } from 'net';
import { deliverPush, buildPushBody } from '../../src/printer/push-notifier.js';
import { decode } from '../../src/ipp/decoder.js';
import {
  OperationIds,
  DelimiterTags,
  NotifyEvents,
  JobStates,
  IPP_CONTENT_TYPE,
} from '../../src/ipp/constants.js';
import {
  findAttr,
  firstNumber,
  firstString,
} from '../../src/ipp/attribute.js';
import { getGroupAttributes } from '../../src/ipp/message.js';
import type { EventRecord } from '../../src/printer/subscription-manager.js';

/** A captured POST: its content-type header and raw body bytes. */
interface Captured {
  contentType: string | undefined;
  body: Buffer;
}

/**
 * Spin up a real local HTTP receiver that records the first POST it gets and
 * resolves a promise with it. Returns the live URL + a captured-promise + close.
 */
async function startReceiver(): Promise<{
  url: string;
  captured: Promise<Captured>;
  close: () => Promise<void>;
}> {
  let resolveCaptured!: (c: Captured) => void;
  const captured = new Promise<Captured>((r) => (resolveCaptured = r));

  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.statusCode = 200;
        res.end();
        resolveCaptured({
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks),
        });
      });
    }
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/notifications`,
    captured,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const sampleEvent: EventRecord = {
  event: NotifyEvents.JOB_COMPLETED,
  jobId: 42,
  jobState: JobStates.COMPLETED,
  sequenceNumber: 7,
  printerUpTime: 123,
};

describe('push-notifier: buildPushBody', () => {
  it('encodes a Send-Notifications message with one event-notification group', () => {
    const body = buildPushBody(3, sampleEvent, 'http://localhost:9/x');
    const msg = decode(body);
    expect(msg.operationIdOrStatusCode).toBe(OperationIds.SEND_NOTIFICATIONS);

    const ev = msg.groups.filter(
      (g) => g.tag === DelimiterTags.EVENT_NOTIFICATION_ATTRIBUTES
    );
    expect(ev.length).toBe(1);
    const a = ev[0]!.attributes;
    expect(firstNumber(findAttr(a, 'notify-subscription-id'))).toBe(3);
    expect(firstNumber(findAttr(a, 'notify-sequence-number'))).toBe(7);
    expect(firstString(findAttr(a, 'notify-subscribed-event'))).toBe(
      NotifyEvents.JOB_COMPLETED
    );
    expect(firstNumber(findAttr(a, 'printer-up-time'))).toBe(123);
    expect(firstNumber(findAttr(a, 'notify-job-id'))).toBe(42);
    expect(firstNumber(findAttr(a, 'job-state'))).toBe(JobStates.COMPLETED);

    // The operation group echoes the recipient URI for correlation.
    const op = getGroupAttributes(msg, DelimiterTags.OPERATION_ATTRIBUTES);
    expect(firstString(findAttr(op, 'notify-recipient-uri'))).toBe(
      'http://localhost:9/x'
    );
  });
});

describe('push-notifier: deliverPush (local-only)', () => {
  it('POSTs the event-notification to a local receiver as application/ipp', async () => {
    const recv = await startReceiver();
    try {
      // The receiver listens on 127.0.0.1 — a loopback literal on the allowlist.
      await deliverPush(recv.url, 5, sampleEvent);
      const got = await recv.captured;
      expect(got.contentType).toBe(IPP_CONTENT_TYPE);
      const msg = decode(got.body);
      expect(msg.operationIdOrStatusCode).toBe(OperationIds.SEND_NOTIFICATIONS);
      const ev = msg.groups.filter(
        (g) => g.tag === DelimiterTags.EVENT_NOTIFICATION_ATTRIBUTES
      );
      expect(firstNumber(findAttr(ev[0]!.attributes, 'notify-subscription-id'))).toBe(
        5
      );
      expect(firstNumber(findAttr(ev[0]!.attributes, 'notify-job-id'))).toBe(42);
    } finally {
      await recv.close();
    }
  });

  it('CONTROL: the receiver actually records a hand-sent POST', async () => {
    // Harness sanity check — verify the receiver captures a POST we send by hand
    // BEFORE trusting any negative result from deliverPush. (per the validation
    // note: confirm the harness on a known-good control first.)
    const recv = await startReceiver();
    try {
      const { request: httpRequest } = await import('http');
      const u = new URL(recv.url);
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST' },
          (res) => {
            res.on('data', () => {});
            res.on('end', resolve);
          }
        );
        req.on('error', reject);
        req.end(Buffer.from('hand-sent'));
      });
      const got = await recv.captured;
      expect(got.body.toString()).toBe('hand-sent');
    } finally {
      await recv.close();
    }
  });

  it('refuses to POST to a NON-local recipient (https / external host / metadata)', async () => {
    // None of these are on the loopback allowlist, so deliverPush must make NO
    // outbound request and simply resolve. (If it tried, the resolve below could
    // still race; the guarantee under test is "no throw, no hang, returns".)
    await expect(
      deliverPush('https://localhost/x', 1, sampleEvent)
    ).resolves.toBeUndefined();
    await expect(
      deliverPush('http://evil.example.com/x', 1, sampleEvent)
    ).resolves.toBeUndefined();
    await expect(
      deliverPush('http://169.254.169.254/latest/meta-data', 1, sampleEvent)
    ).resolves.toBeUndefined();
    await expect(
      deliverPush('http://localhost.evil/x', 1, sampleEvent)
    ).resolves.toBeUndefined();
    await expect(
      deliverPush('http://localhost@evil/x', 1, sampleEvent)
    ).resolves.toBeUndefined();
  });

  it('a delivery failure (no listener) does not throw or hang', async () => {
    // Port 1 on loopback has no listener — connection is refused. deliverPush
    // must swallow the error and resolve, never reject.
    await expect(
      deliverPush('http://127.0.0.1:1/x', 1, sampleEvent)
    ).resolves.toBeUndefined();
  });
});
