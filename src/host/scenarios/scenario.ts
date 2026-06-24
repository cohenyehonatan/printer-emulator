/**
 * Scenario model.
 *
 * A scenario is a named sequence of steps run by the IPP client against a live
 * printer. Each step performs one client verb and asserts on the response.
 * Mirrors pectab's scenario shape so the runner can report step counts.
 */

import type { IppClient } from '../ipp-client.js';

export interface ScenarioStep {
  name: string;
  run: (client: IppClient) => Promise<void>;
}

export interface Scenario {
  name: string;
  description: string;
  steps: ScenarioStep[];
}

export interface ScenarioResult {
  name: string;
  success: boolean;
  stepsCompleted: number;
  totalSteps: number;
  error?: string;
}
