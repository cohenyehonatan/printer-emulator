/**
 * Scenario runner.
 *
 * Executes a Scenario's steps in order against an IppClient, stopping at the
 * first failure and reporting how many steps completed. Mirrors pectab's
 * ScenarioRunner contract (run() -> ScenarioResult) so the CLI demo can report
 * pass/fail and step progress uniformly.
 */

import { Logger } from '../../logging/logger.js';
import type { IppClient } from '../ipp-client.js';
import type { Scenario, ScenarioResult } from './scenario.js';

export class ScenarioRunner {
  private readonly logger = new Logger('SCENARIO', 'info');

  constructor(private readonly client: IppClient) {}

  async run(scenario: Scenario): Promise<ScenarioResult> {
    this.logger.section(scenario.name);
    let stepsCompleted = 0;

    for (const step of scenario.steps) {
      try {
        await step.run(this.client);
        stepsCompleted++;
        this.logger.info(`✓ ${step.name}`);
      } catch (err) {
        this.logger.error(`✗ ${step.name}: ${(err as Error).message}`);
        return {
          name: scenario.name,
          success: false,
          stepsCompleted,
          totalSteps: scenario.steps.length,
          error: (err as Error).message,
        };
      }
    }

    return {
      name: scenario.name,
      success: true,
      stepsCompleted,
      totalSteps: scenario.steps.length,
    };
  }
}
