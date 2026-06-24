/**
 * IPP / AirPrint Printer Emulator
 *
 * CLI entry point. Run the emulated printer and a client in the same process
 * for a demo, or run either side on its own.
 *
 * Usage:
 *   npx tsx src/index.ts              # Run demo (printer + client + scenarios)
 *   npx tsx src/index.ts emulator     # Start the IPP printer only
 *   npx tsx src/index.ts client       # Run client verbs against a printer
 *   npx tsx src/index.ts scenario     # Run the scenarios
 *
 * Port note: DEFAULT_PORT is 631 (the IANA IPP port used by CUPS/AirPrint),
 * but binding it needs privileges. The demo defaults to DEMO_PORT (6310) to
 * avoid sudo; override either with the PORT env var.
 *
 * Raster output: pass `--raster-out <prefix>` (or set `RASTER_OUT=<prefix>`) to
 * have completed PWG/URF jobs decode + write one PNG per page as
 * `<prefix>-job<id>-p<n>.png`. Off by default (no output side effects).
 *
 * IPPS (IPP over TLS): pass `--tls` (or set `IPPS=1`) on the `emulator`
 * subcommand to ALSO serve `ipps://…/ipp/print` over HTTPS and advertise
 * `_ipps._tcp` for AirPrint. The TLS port defaults to DEFAULT_TLS_PORT (6311);
 * override with `TLS_PORT`. A self-signed cert is auto-generated under `.certs/`
 * via the system openssl binary on first use (reused thereafter). Off by
 * default; if openssl is unavailable, the emulator runs plaintext-only.
 */

import { IppPrinter } from './printer/ipp-printer.js';
import { IppClient } from './host/ipp-client.js';
import { ScenarioRunner } from './host/scenarios/scenario-runner.js';
import { airprintDiscoveryScenario } from './host/scenarios/airprint-discovery.scenario.js';
import { printPdfScenario } from './host/scenarios/print-pdf.scenario.js';
import { DEFAULT_PORT, DEMO_PORT, DEFAULT_TLS_PORT } from './ipp/constants.js';
import { Logger } from './logging/logger.js';

const logger = new Logger('MAIN', 'info');

function resolvePort(fallback: number): number {
  return parseInt(process.env.PORT ?? String(fallback), 10);
}

/**
 * Resolve the opt-in raster output prefix from `--raster-out <prefix>` (CLI) or
 * the `RASTER_OUT` env var (CLI wins). Returns undefined when neither is set,
 * keeping PNG rendering off by default. When enabled, completed PWG/URF jobs
 * write one PNG per page as `<prefix>-job<id>-p<n>.png`.
 */
function resolveRasterOut(): string | undefined {
  const flagIndex = process.argv.indexOf('--raster-out');
  if (flagIndex !== -1) {
    const value = process.argv[flagIndex + 1];
    if (value && !value.startsWith('--')) return value;
  }
  return process.env.RASTER_OUT || undefined;
}

/**
 * Resolve opt-in IPPS (IPP over TLS) from the `--tls` flag or `IPPS=1` env.
 * Off by default. When on, the emulator also serves HTTPS on the TLS port
 * (`TLS_PORT`, default DEFAULT_TLS_PORT) and advertises `_ipps._tcp`.
 */
function resolveTls(): boolean {
  if (process.argv.includes('--tls')) return true;
  return process.env.IPPS === '1';
}

/** Resolve the TLS/IPPS port from `TLS_PORT`, defaulting to DEFAULT_TLS_PORT. */
function resolveTlsPort(): number {
  return parseInt(process.env.TLS_PORT ?? String(DEFAULT_TLS_PORT), 10);
}

async function runDemo(): Promise<void> {
  logger.section('IPP / AirPrint Printer Emulator Demo');

  const port = resolvePort(DEMO_PORT);

  // Start the emulated IPP printer. mDNS advertising is disabled for the
  // in-process demo so it doesn't leave a multicast socket open and hang exit.
  const printer = new IppPrinter({
    port,
    logLevel: 'info',
    advertise: false,
    rasterOut: resolveRasterOut(),
  });
  await printer.start();

  // Give the server a moment to be ready.
  await new Promise((r) => setTimeout(r, 100));

  // Build a client pointed at it.
  const client = new IppClient({
    printerUri: `ipp://127.0.0.1:${port}/ipp/print`,
    logLevel: 'info',
  });

  const runner = new ScenarioRunner(client);

  const result1 = await runner.run(airprintDiscoveryScenario);
  logger.info(`AirPrint Discovery: ${result1.success ? 'PASSED' : 'FAILED'}`, {
    steps: `${result1.stepsCompleted}/${result1.totalSteps}`,
  });

  const result2 = await runner.run(printPdfScenario);
  logger.info(`Print PDF: ${result2.success ? 'PASSED' : 'FAILED'}`, {
    steps: `${result2.stepsCompleted}/${result2.totalSteps}`,
  });

  await printer.stop();
  logger.section('Demo Complete');

  const allPassed = [result1, result2].every((r) => r.success);
  process.exit(allPassed ? 0 : 1);
}

async function startEmulator(): Promise<void> {
  const port = resolvePort(DEFAULT_PORT);
  const rasterOut = resolveRasterOut();
  const tls = resolveTls();
  const tlsPort = resolveTlsPort();
  const printer = new IppPrinter({
    port,
    logLevel: 'debug',
    rasterOut,
    tls,
    tlsPort,
  });
  await printer.start();

  if (rasterOut) {
    logger.info('Raster PNG output enabled', { prefix: rasterOut });
  }
  if (tls) {
    logger.info('IPPS (IPP over TLS) enabled', { tlsPort });
  }
  logger.info('IPP printer running. Press Ctrl+C to stop.');

  process.on('SIGINT', async () => {
    await printer.stop();
    process.exit(0);
  });
}

async function startClient(): Promise<void> {
  const port = resolvePort(DEFAULT_PORT);
  const host = process.env.PRINTER_HOST ?? '127.0.0.1';
  const printerUri = `ipp://${host}:${port}/ipp/print`;

  const client = new IppClient({ printerUri, logLevel: 'debug' });

  try {
    logger.info('Querying printer attributes...', { printerUri });
    const res = await client.getPrinterAttributes();
    logger.info(
      `Printer responded: status=0x${res.operationIdOrStatusCode.toString(16).padStart(4, '0')}`
    );
  } catch (err) {
    logger.error(`Failed to reach printer: ${(err as Error).message}`);
    process.exit(1);
  }
}

const command = process.argv[2];

switch (command) {
  case 'emulator':
    startEmulator().catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
    break;

  case 'client':
    startClient().catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
    break;

  case 'scenario':
    runDemo().catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
    break;

  default:
    runDemo().catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
    break;
}
