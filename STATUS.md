# Status — printer-emulator

IPP Everywhere / AirPrint printer emulator. Binary IPP (RFC 8010) over HTTP +
IPPS/TLS, discoverable via mDNS. Last updated **2026-06-25**.

## Done

**IPP codec**: binary encode/decode (RFC 8010) incl. `rangeOfInteger`,
subscription/event delimiter tags (0x06/0x07).

**Operations** (`src/ipp/operations/`): Get-Printer-Attributes, Validate-Job,
Print-Job, Create-Job, Send-Document, Close-Job, Cancel-Job, Cancel-My-Jobs,
Get-Jobs, Get-Job-Attributes, Hold-Job, Release-Job, Restart-Job, Purge-Jobs,
Pause-Printer, Resume-Printer, Identify-Printer, Set-Printer-Attributes,
Set-Job-Attributes, **Print-URI**, **Send-URI** (local-only), and the
subscription set (Create/Get/Renew/Cancel-Subscription, Get-Subscriptions,
Get-Subscription-Attributes, Get-Notifications/ippget pull delivery). All
`ipptool`-validated.

**Transport**: plaintext IPP (HTTP), IPPS (TLS via openssl self-signed cert in
gitignored `.certs/`), mDNS `_ipp._tcp` + `_ipps._tcp` (bonjour-service) —
discoverable by `ippfind` / `dns-sd`. Default demo port 6310 (set `PORT`).

**Documents / raster**: PWG/URF (built-in PackBits decoder) + PDF/PostScript
(shells to system `gs`) → per-page PNG. 16-bit color depth. ICC matrix-shaper
color transform (AdobeRGB→sRGB). Job-template attributes that actually affect
output: print-color-mode, orientation, page-ranges, number-up, print-quality,
sides.

**Supply gauge**: `marker-levels` + the parallel marker-* attributes
(marker-names/types/colors/low-levels/high-levels/units/message) — a CMYK ink
gauge advertised in printer-description, filtered by `requested-attributes`.
Validated on the live wire with `ipptool` Get-Printer-Attributes.

**Print-URI / Send-URI security**: strictly **local-only**, SSRF-guarded —
`file://` (local host only) + `http://{localhost,127.0.0.1,::1}` allowlist by
parsed-hostname string-equality (no DNS bypass), no redirect-following, 20 MB
cap. Everything else → `client-error-uri-scheme-not-supported`. Verified on the
live wire with `ipptool` incl. cloud-metadata / userinfo-spoof / suffix-spoof /
https-localhost probes.

**Tests**: 276 passed / 1 skipped (pre-existing OpenSSL-gated IPPS test).
`tsc --noEmit` clean.

## Left (real gaps, prioritized)

1. **Push notifications** (`notify-recipient-uri`) — currently pull-only
   (`ippget`). Push would be another outbound feature, same local-only scoping
   as Print-URI (`subscription-attrs.ts:108` marks push pull-unsupported).
3. **Admin operations** — Restart-Printer, Shutdown-Printer,
   Enable/Disable-Printer, Pause-Printer-After-Current-Job,
   Get-Printer-Supported-Values.
4. **Compressed document-format** — `gzip`/`deflate` (`compression`
   operation attribute) decoding on Print-Job/Send-Document.

## Net-new breadth (bigger, optional)

IPP Fax-Out, IPP System Service, IPP-3D.

## Validation discipline

Every operation/wire feature is exercised against real `ipptool` / `ippfind` /
`dns-sd` before being called done — unit tests are necessary but not
sufficient. See the sibling `shipping-printer-emulator` STATUS and the project
memory for the shared toolchain and the "distinguish a wire bug from a client
quirk by reading raw bytes" rule.
