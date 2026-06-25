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

**Admin operations** (RFC 3998): Enable-Printer / Disable-Printer (gates new
jobs with `server-error-not-accepting-jobs` 0x0506), Pause-Printer-After-
Current-Job, Hold-New-Jobs / Release-Held-New-Jobs, Restart-Printer — all mutate
real `printer-is-accepting-jobs` / `printer-state-reasons` and are advertised in
operations-supported. Validated with `ipptool` (Disable → Print-Job rejected →
Enable → accepted).

**Document compression**: `gzip` / `deflate` (the `compression` operation
attribute, RFC 8011 §5.2.3) decoded before format-sniff/raster on Print-Job /
Send-Document / Print-URI; `compression-supported = none,gzip,deflate`
advertised; unknown method → `client-error-compression-not-supported` (0x040E),
corrupt stream → `client-error-document-format-error` (0x040A). Validated with
`ipptool COMPRESSION gzip`.

**Supply gauge**: `marker-levels` + the parallel marker-* attributes
(marker-names/types/colors/low-levels/high-levels/units/message) — a CMYK ink
gauge advertised in printer-description, filtered by `requested-attributes`.
Validated on the live wire with `ipptool` Get-Printer-Attributes.

**Push notifications**: subscriptions with `notify-recipient-uri` get events
delivered by HTTP POST (Send-Notifications, op 0x1d; event-notification group
per RFC 3996 §10) — strictly **local-only** via the same shared SSRF guard as
Print-URI. External/https/spoof/cloud-metadata recipient URIs are refused at
create time with `client-error-uri-scheme-not-supported`. Delivery is
fire-and-forget (never blocks/crashes job processing); the pull (`ippget`) path
is unchanged. Validated end-to-end with `ipptool` + a real local receiver.

**Print-URI / Send-URI security**: strictly **local-only**, SSRF-guarded —
(shared guard now in `transport/local-only.ts`) —
`file://` (local host only) + `http://{localhost,127.0.0.1,::1}` allowlist by
parsed-hostname string-equality (no DNS bypass), no redirect-following, 20 MB
cap. Everything else → `client-error-uri-scheme-not-supported`. Verified on the
live wire with `ipptool` incl. cloud-metadata / userinfo-spoof / suffix-spoof /
https-localhost probes.

**Tests**: 295 passed / 1 skipped (pre-existing OpenSSL-gated IPPS test).
`tsc --noEmit` clean.

## Left (real gaps, prioritized)

1. **More admin ops** — Shutdown/Startup-Printer, Deactivate/Activate-Printer
   (the RFC 3998 set beyond the six already implemented).

## Net-new breadth (bigger, optional)

IPP Fax-Out, IPP System Service, IPP-3D.

## Validation discipline

Every operation/wire feature is exercised against real `ipptool` / `ippfind` /
`dns-sd` before being called done — unit tests are necessary but not
sufficient. See the sibling `shipping-printer-emulator` STATUS and the project
memory for the shared toolchain and the "distinguish a wire bug from a client
quirk by reading raw bytes" rule.
