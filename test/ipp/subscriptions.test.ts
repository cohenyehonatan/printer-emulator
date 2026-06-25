import { describe, it, expect } from 'vitest';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import { AddressInfo } from 'net';
import {
  OperationIds,
  StatusCodes,
  JobStates,
  PrinterStates,
  DelimiterTags,
  NotifyEvents,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  IPP_VERSION_MAJOR,
  IPP_VERSION_MINOR,
} from '../../src/ipp/constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  integerAttr,
  keywordAttr,
  uriAttr,
  mimeMediaTypeAttr,
  findAttr,
  firstNumber,
  firstString,
  allStrings,
  type IppAttribute,
} from '../../src/ipp/attribute.js';
import {
  operationGroup,
  subscriptionGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
  type IppAttributeGroup,
} from '../../src/ipp/message.js';
import { encode } from '../../src/ipp/encoder.js';
import { decode } from '../../src/ipp/decoder.js';
import { IppPrinter } from '../../src/printer/ipp-printer.js';

/**
 * Drive a request straight through IppPrinter.handleRequest (decode → dispatch →
 * encode) without start()ing the HTTP server or mDNS — exercises the real
 * subscription-manager + lifecycle-event wiring fully in-process.
 */
function makePrinter(): IppPrinter {
  return new IppPrinter({ port: 0, advertise: false, logLevel: 'error' });
}

function request(
  operationId: number,
  extraOpAttrs: IppAttribute[] = [],
  extraGroups: IppAttributeGroup[] = [],
  data?: Buffer
): IppRequest {
  return {
    versionMajor: IPP_VERSION_MAJOR,
    versionMinor: IPP_VERSION_MINOR,
    operationIdOrStatusCode: operationId,
    requestId: 1,
    groups: [
      operationGroup([
        charsetAttr('attributes-charset', DEFAULT_CHARSET),
        naturalLanguageAttr(
          'attributes-natural-language',
          DEFAULT_NATURAL_LANGUAGE
        ),
        ...extraOpAttrs,
      ]),
      ...extraGroups,
    ],
    data,
  };
}

function send(printer: IppPrinter, req: IppRequest): IppResponse {
  return decode(printer.handleRequest(encode(req)));
}

function printerAttrsOf(res: IppResponse): IppAttribute[] {
  return getGroupAttributes(res, DelimiterTags.PRINTER_ATTRIBUTES);
}

function subscriptionGroupsOf(res: IppResponse): IppAttributeGroup[] {
  return res.groups.filter(
    (g) => g.tag === DelimiterTags.SUBSCRIPTION_ATTRIBUTES
  );
}

function eventGroupsOf(res: IppResponse): IppAttributeGroup[] {
  return res.groups.filter(
    (g) => g.tag === DelimiterTags.EVENT_NOTIFICATION_ATTRIBUTES
  );
}

const PDF = Buffer.from('%PDF-1.4');

/** Create a printer-wide subscription and return its notify-subscription-id. */
function subscribe(printer: IppPrinter, events: string[]): number {
  const res = send(
    printer,
    request(
      OperationIds.CREATE_PRINTER_SUBSCRIPTIONS,
      [],
      [
        subscriptionGroup([
          keywordAttr('notify-events', ...events),
          keywordAttr('notify-pull-method', 'ippget'),
        ]),
      ]
    )
  );
  expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
  const subId = firstNumber(
    findAttr(subscriptionGroupsOf(res)[0]!.attributes, 'notify-subscription-id')
  );
  expect(subId).toBeDefined();
  return subId!;
}

describe('Create-Printer-Subscriptions (0x0016) + Get-Subscriptions (0x0019)', () => {
  it('creates a subscription returning notify-subscription-id + granted lease', () => {
    const printer = makePrinter();
    const res = send(
      printer,
      request(
        OperationIds.CREATE_PRINTER_SUBSCRIPTIONS,
        [],
        [
          subscriptionGroup([
            keywordAttr('notify-events', NotifyEvents.JOB_COMPLETED),
            keywordAttr('notify-pull-method', 'ippget'),
            integerAttr('notify-lease-duration', 120),
          ]),
        ]
      )
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    const sub = subscriptionGroupsOf(res)[0]!.attributes;
    expect(firstNumber(findAttr(sub, 'notify-subscription-id'))).toBe(1);
    expect(firstNumber(findAttr(sub, 'notify-lease-duration'))).toBe(120);
    expect(firstString(findAttr(sub, 'notify-pull-method'))).toBe('ippget');
  });

  it('Get-Subscriptions lists it; Get-Subscription-Attributes returns its events', () => {
    const printer = makePrinter();
    const subId = subscribe(printer, [NotifyEvents.JOB_COMPLETED]);

    const list = send(printer, request(OperationIds.GET_SUBSCRIPTIONS));
    expect(list.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    const groups = subscriptionGroupsOf(list);
    expect(groups.length).toBe(1);
    expect(
      firstNumber(findAttr(groups[0]!.attributes, 'notify-subscription-id'))
    ).toBe(subId);

    const ga = send(
      printer,
      request(OperationIds.GET_SUBSCRIPTION_ATTRIBUTES, [
        integerAttr('notify-subscription-id', subId),
      ])
    );
    expect(ga.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(
      allStrings(findAttr(subscriptionGroupsOf(ga)[0]!.attributes, 'notify-events'))
    ).toEqual([NotifyEvents.JOB_COMPLETED]);
  });

  it('rejects a non-ippget pull method (push) without creating a subscription', () => {
    const printer = makePrinter();
    const res = send(
      printer,
      request(
        OperationIds.CREATE_PRINTER_SUBSCRIPTIONS,
        [],
        [
          subscriptionGroup([
            keywordAttr('notify-events', NotifyEvents.JOB_COMPLETED),
            keywordAttr('notify-pull-method', 'not-a-method'),
          ]),
        ]
      )
    );
    expect(res.operationIdOrStatusCode).toBe(
      StatusCodes.CLIENT_ERROR_ATTRIBUTES_NOT_SUPPORTED
    );
    const list = send(printer, request(OperationIds.GET_SUBSCRIPTIONS));
    expect(subscriptionGroupsOf(list).length).toBe(0);
  });
});

describe('Get-Notifications (0x001C) — ippget pull, drain-on-read', () => {
  it('a Print-Job queues a job-completed event with the right job-id/state + sequence', () => {
    const printer = makePrinter();
    const subId = subscribe(printer, [NotifyEvents.JOB_COMPLETED]);

    const printed = send(
      printer,
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        [],
        PDF
      )
    );
    const jobId = firstNumber(
      findAttr(
        getGroupAttributes(printed, DelimiterTags.JOB_ATTRIBUTES),
        'job-id'
      )
    )!;

    const notif = send(
      printer,
      request(OperationIds.GET_NOTIFICATIONS, [
        integerAttr('notify-subscription-id', subId),
      ])
    );
    expect(notif.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    const events = eventGroupsOf(notif);
    expect(events.length).toBe(1);
    const ev = events[0]!.attributes;
    expect(firstString(findAttr(ev, 'notify-subscribed-event'))).toBe(
      NotifyEvents.JOB_COMPLETED
    );
    expect(firstNumber(findAttr(ev, 'job-id'))).toBe(jobId);
    expect(firstNumber(findAttr(ev, 'job-state'))).toBe(JobStates.COMPLETED);
    expect(firstNumber(findAttr(ev, 'notify-sequence-number'))).toBe(1);
    expect(firstNumber(findAttr(ev, 'notify-subscription-id'))).toBe(subId);
    expect(firstNumber(findAttr(ev, 'printer-up-time'))).toBeGreaterThanOrEqual(
      0
    );
  });

  it('a second Get-Notifications returns no new events (queue drained)', () => {
    const printer = makePrinter();
    const subId = subscribe(printer, [NotifyEvents.JOB_COMPLETED]);
    send(
      printer,
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        [],
        PDF
      )
    );

    const first = send(
      printer,
      request(OperationIds.GET_NOTIFICATIONS, [
        integerAttr('notify-subscription-id', subId),
      ])
    );
    expect(eventGroupsOf(first).length).toBe(1);

    const second = send(
      printer,
      request(OperationIds.GET_NOTIFICATIONS, [
        integerAttr('notify-subscription-id', subId),
      ])
    );
    expect(second.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(eventGroupsOf(second).length).toBe(0);
  });

  it('printer-state-changed subscription sees Pause-Printer (state stopped)', () => {
    const printer = makePrinter();
    const subId = subscribe(printer, [NotifyEvents.PRINTER_STATE_CHANGED]);

    send(printer, request(OperationIds.PAUSE_PRINTER));

    const notif = send(
      printer,
      request(OperationIds.GET_NOTIFICATIONS, [
        integerAttr('notify-subscription-id', subId),
      ])
    );
    const events = eventGroupsOf(notif);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[0]!.attributes;
    expect(firstString(findAttr(ev, 'notify-subscribed-event'))).toBe(
      NotifyEvents.PRINTER_STATE_CHANGED
    );
    expect(firstNumber(findAttr(ev, 'printer-state'))).toBe(
      PrinterStates.STOPPED
    );
  });

  it('unknown subscription id → not-found', () => {
    const printer = makePrinter();
    const notif = send(
      printer,
      request(OperationIds.GET_NOTIFICATIONS, [
        integerAttr('notify-subscription-id', 999),
      ])
    );
    expect(notif.operationIdOrStatusCode).toBe(StatusCodes.CLIENT_ERROR_NOT_FOUND);
  });
});

describe('Cancel-Subscription (0x001B)', () => {
  it('removes the subscription; a subsequent Get-Subscription-Attributes → not-found', () => {
    const printer = makePrinter();
    const subId = subscribe(printer, [NotifyEvents.JOB_COMPLETED]);

    const cancel = send(
      printer,
      request(OperationIds.CANCEL_SUBSCRIPTION, [
        integerAttr('notify-subscription-id', subId),
      ])
    );
    expect(cancel.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    const ga = send(
      printer,
      request(OperationIds.GET_SUBSCRIPTION_ATTRIBUTES, [
        integerAttr('notify-subscription-id', subId),
      ])
    );
    expect(ga.operationIdOrStatusCode).toBe(StatusCodes.CLIENT_ERROR_NOT_FOUND);
  });

  it('unknown id → not-found', () => {
    const printer = makePrinter();
    const res = send(
      printer,
      request(OperationIds.CANCEL_SUBSCRIPTION, [
        integerAttr('notify-subscription-id', 4242),
      ])
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.CLIENT_ERROR_NOT_FOUND);
  });
});

describe('Renew-Subscription (0x001A)', () => {
  it('extends the lease and returns the granted duration', () => {
    const printer = makePrinter();
    const subId = subscribe(printer, [NotifyEvents.JOB_COMPLETED]);
    const res = send(
      printer,
      request(
        OperationIds.RENEW_SUBSCRIPTION,
        [integerAttr('notify-subscription-id', subId)],
        [subscriptionGroup([integerAttr('notify-lease-duration', 600)])]
      )
    );
    expect(res.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
    expect(
      firstNumber(
        findAttr(
          subscriptionGroupsOf(res)[0]!.attributes,
          'notify-lease-duration'
        )
      )
    ).toBe(600);
  });
});

describe('printer-attributes advertise notify-* capabilities', () => {
  it('advertises notify-events-supported + notify-pull-method-supported=ippget', () => {
    const printer = makePrinter();
    const attrs = send(
      printer,
      request(OperationIds.GET_PRINTER_ATTRIBUTES, [
        keywordAttr('requested-attributes', 'all'),
      ])
    );
    const pa = printerAttrsOf(attrs);
    const supported = allStrings(findAttr(pa, 'notify-events-supported'));
    expect(supported).toContain(NotifyEvents.JOB_COMPLETED);
    expect(supported).toContain(NotifyEvents.PRINTER_STATE_CHANGED);
    expect(
      allStrings(findAttr(pa, 'notify-pull-method-supported'))
    ).toEqual(['ippget']);
    expect(firstNumber(findAttr(pa, 'printer-up-time'))).toBeGreaterThanOrEqual(
      0
    );
  });
});

describe('Codec: subscription (0x06) / event-notification (0x07) groups round-trip', () => {
  it('encodes then decodes a subscription + event-notification group', () => {
    const msg: IppResponse = {
      versionMajor: IPP_VERSION_MAJOR,
      versionMinor: IPP_VERSION_MINOR,
      operationIdOrStatusCode: StatusCodes.SUCCESSFUL_OK,
      requestId: 7,
      groups: [
        operationGroup([
          charsetAttr('attributes-charset', DEFAULT_CHARSET),
          naturalLanguageAttr(
            'attributes-natural-language',
            DEFAULT_NATURAL_LANGUAGE
          ),
        ]),
        subscriptionGroup([
          integerAttr('notify-subscription-id', 3),
          keywordAttr('notify-events', NotifyEvents.JOB_COMPLETED),
        ]),
        {
          tag: DelimiterTags.EVENT_NOTIFICATION_ATTRIBUTES,
          attributes: [
            integerAttr('notify-subscription-id', 3),
            integerAttr('notify-sequence-number', 1),
            keywordAttr('notify-subscribed-event', NotifyEvents.JOB_COMPLETED),
            integerAttr('job-id', 5),
          ],
        },
      ],
    };

    const decoded = decode(encode(msg));
    const subs = decoded.groups.filter(
      (g) => g.tag === DelimiterTags.SUBSCRIPTION_ATTRIBUTES
    );
    const events = decoded.groups.filter(
      (g) => g.tag === DelimiterTags.EVENT_NOTIFICATION_ATTRIBUTES
    );
    expect(subs.length).toBe(1);
    expect(events.length).toBe(1);
    expect(
      firstNumber(findAttr(subs[0]!.attributes, 'notify-subscription-id'))
    ).toBe(3);
    expect(
      firstNumber(findAttr(events[0]!.attributes, 'notify-sequence-number'))
    ).toBe(1);
    expect(firstNumber(findAttr(events[0]!.attributes, 'job-id'))).toBe(5);
  });
});

/**
 * Spin up a real local HTTP receiver that records the first POST and resolves a
 * promise with its decoded IPP body. Listens on 127.0.0.1 (a loopback literal).
 */
async function startReceiver(): Promise<{
  url: string;
  captured: Promise<{ contentType: string | undefined; body: Buffer }>;
  close: () => Promise<void>;
}> {
  let resolveCaptured!: (c: {
    contentType: string | undefined;
    body: Buffer;
  }) => void;
  const captured = new Promise<{
    contentType: string | undefined;
    body: Buffer;
  }>((r) => (resolveCaptured = r));

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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('Create-Printer-Subscriptions — PUSH (notify-recipient-uri)', () => {
  it('accepts a LOCAL recipient + POSTs the event-notification when an event fires', async () => {
    const recv = await startReceiver();
    try {
      const printer = makePrinter();

      // Create a PUSH subscription pointing at the local receiver.
      const created = send(
        printer,
        request(
          OperationIds.CREATE_PRINTER_SUBSCRIPTIONS,
          [],
          [
            subscriptionGroup([
              keywordAttr('notify-events', NotifyEvents.JOB_COMPLETED),
              uriAttr('notify-recipient-uri', recv.url),
            ]),
          ]
        )
      );
      expect(created.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
      const subAttrs = subscriptionGroupsOf(created)[0]!.attributes;
      const subId = firstNumber(findAttr(subAttrs, 'notify-subscription-id'))!;
      // The create response reports the recipient URI (push), not a pull method.
      expect(firstString(findAttr(subAttrs, 'notify-recipient-uri'))).toBe(
        recv.url
      );

      // Fire an event: a Print-Job drives the job to completed → job-completed.
      send(
        printer,
        request(
          OperationIds.PRINT_JOB,
          [mimeMediaTypeAttr('document-format', 'application/pdf')],
          [],
          PDF
        )
      );

      // The receiver must get an application/ipp Send-Notifications POST.
      const got = await recv.captured;
      expect(got.contentType).toBe('application/ipp');
      const msg = decode(got.body);
      const ev = msg.groups.filter(
        (g) => g.tag === DelimiterTags.EVENT_NOTIFICATION_ATTRIBUTES
      );
      expect(ev.length).toBeGreaterThanOrEqual(1);
      const a = ev[0]!.attributes;
      expect(firstNumber(findAttr(a, 'notify-subscription-id'))).toBe(subId);
      expect(firstString(findAttr(a, 'notify-subscribed-event'))).toBe(
        NotifyEvents.JOB_COMPLETED
      );
      expect(firstNumber(findAttr(a, 'job-state'))).toBe(JobStates.COMPLETED);
    } finally {
      await recv.close();
    }
  });

  it('refuses an EXTERNAL recipient URI with uri-scheme-not-supported (no subscription)', () => {
    const printer = makePrinter();
    for (const bad of [
      'http://evil.example.com/hook',
      'https://localhost/hook',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost.evil/hook',
      'http://localhost@evil/hook',
    ]) {
      const res = send(
        printer,
        request(
          OperationIds.CREATE_PRINTER_SUBSCRIPTIONS,
          [],
          [
            subscriptionGroup([
              keywordAttr('notify-events', NotifyEvents.JOB_COMPLETED),
              uriAttr('notify-recipient-uri', bad),
            ]),
          ]
        )
      );
      expect(res.operationIdOrStatusCode).toBe(
        StatusCodes.CLIENT_ERROR_URI_SCHEME_NOT_SUPPORTED
      );
    }
    // None of the refused requests created a subscription.
    const list = send(printer, request(OperationIds.GET_SUBSCRIPTIONS));
    expect(subscriptionGroupsOf(list).length).toBe(0);
  });

  it('a push delivery to a dead recipient does not crash job processing', () => {
    const printer = makePrinter();
    // Loopback port 1 has no listener: the POST will be refused. The create is
    // accepted (the URI is local), and the subsequent Print-Job must still run
    // to completion without throwing.
    const created = send(
      printer,
      request(
        OperationIds.CREATE_PRINTER_SUBSCRIPTIONS,
        [],
        [
          subscriptionGroup([
            keywordAttr('notify-events', NotifyEvents.JOB_COMPLETED),
            uriAttr('notify-recipient-uri', 'http://127.0.0.1:1/dead'),
          ]),
        ]
      )
    );
    expect(created.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);

    const printed = send(
      printer,
      request(
        OperationIds.PRINT_JOB,
        [mimeMediaTypeAttr('document-format', 'application/pdf')],
        [],
        PDF
      )
    );
    expect(printed.operationIdOrStatusCode).toBe(StatusCodes.SUCCESSFUL_OK);
  });
});
