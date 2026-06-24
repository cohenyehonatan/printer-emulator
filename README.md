# printer-emulator

An **IPP (Internet Printing Protocol) printer emulator** — the protocol behind
CUPS, IPP Everywhere, and AirPrint. It runs an HTTP server, decodes binary IPP
requests, dispatches IPP operations against an in-memory printer object + job
queue, and replies with binary IPP responses.

This is the print-system-level analog of the sibling `pectab-printer-emulator`:
the "protocol" here is IPP-over-HTTP and the "device" is an RFC 8011 printer
object with a job lifecycle, instead of an AEA ATB host↔printer exchange.

## Architecture (layers)

```
transport/   IPP-over-HTTP (node http) + thin client POST helper + mDNS stub
   │  POST application/ipp
   ▼
printer/     IppPrinter orchestrator: identity, job queue, printer-state
   │  decode -> dispatch -> encode
   ▼
ipp/         binary codec (decoder/encoder), attribute/message model,
   │         operation dispatcher + per-operation handlers
   ▼
documents/   document model + format sniffing (PDF/PS/PWG/URF/PCL)
```

- **transport/http-server.ts** routes `POST` with `Content-Type: application/ipp`
  to the printer, which decodes, dispatches, encodes, and writes the binary
  response back.
- **ipp/dispatcher.ts** maps the request's operation-id to a handler; unknown
  operations return `server-error-operation-not-supported`.
- **printer/state-machine.ts** drives the **job** lifecycle with the same
  table-driven enforcement pattern as the pectab device state machine.

## Operation dispatch flow

```
HTTP POST (application/ipp)
  -> IppHttpServer collects body
  -> IppPrinter.handleRequest: decode() Buffer -> IppMessage
  -> dispatch(operation-id) -> handler(request, ctx)
       ctx = { identity, job queue, live printer-state }
  -> handler returns IppResponse
  -> encode() IppMessage -> Buffer
  -> HTTP 200 application/ipp
```

## Binary IPP message anatomy (RFC 8010, brief)

```
version-major(1) version-minor(1)        # 0x02 0x00 for IPP 2.0
operation-id | status-code(2)            # request vs response
request-id(4)
[ delimiter-tag(1)                       # 0x01 op, 0x02 job, 0x04 printer ...
    { value-tag(1)                       # 0x21 integer, 0x44 keyword, 0x45 uri ...
      name-length(2) name
      value-length(2) value }*           # name-length=0 => additional 1setOf value
]*
end-of-attributes-tag(0x03)
[ document-data ]                        # trailing bytes (e.g. the PDF to print)
```

## Port / privilege note

`DEFAULT_PORT` is **631** — the IANA IPP port used by CUPS and AirPrint — but
binding it requires elevated privileges on most systems. The demo and scenarios
default to **6310** (`DEMO_PORT`) so they run without `sudo`. Override either
side with the `PORT` env var:

```bash
PORT=631 sudo npm run start:emulator   # real IPP port, needs privileges
npm run start:emulator                 # defaults to 631; set PORT to change
```

## Getting started

```bash
npm install
npm test        # vitest: codec round-trip, decoder, formats, buffer reader
```

## CLI subcommands

```bash
npx tsx src/index.ts            # demo: start printer + run scenarios in-process
npx tsx src/index.ts emulator   # start the IPP printer only  (npm run start:emulator)
npx tsx src/index.ts client     # query a printer's attributes (npm run start:client)
npx tsx src/index.ts scenario   # run the scenarios
```

## Status / TODO

**Fully implemented**
- Binary IPP codec — `encode`/`decode` genuinely round-trip (incl. 1setOf
  multi-values and trailing document data); proven by `test/ipp/codec.test.ts`.
- `Get-Printer-Attributes` — returns IPP Everywhere attribute set + live state.
- `Print-Job` — sniffs document-format, enqueues a Job, runs the emulated print
  (pending → processing → completed), returns job-id/job-uri/job-state.
- `Validate-Job` — returns `successful-ok`.
- Job state machine — table-driven RFC 8011 lifecycle (cancel/abort paths).
- Document format detection — PDF, PostScript, PWG-raster, URF, PCL.
- IPP-over-HTTP server + client transport on port 631 (override via `PORT`).

**Stubbed / partial** (all return valid IPP responses; none throw)
- `Get-Jobs` — lists the queue but ignores `limit` / `which-jobs` filters.
- `Cancel-Job` — looks up + cancels by job-id; doesn't distinguish
  already-completed (`client-error-not-possible`).
- mDNS / AirPrint advertising (`transport/mdns.ts`) — records params + logs;
  no real `_ipp._tcp` multicast responder.
- Real document rendering/rasterization — documents are accepted and measured,
  not rendered (`documents/document.ts` `PassthroughHandler`).
- Unknown operations — answered with `server-error-operation-not-supported`.
```
