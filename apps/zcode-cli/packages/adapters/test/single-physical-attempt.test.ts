import assert from "node:assert/strict";
import test from "node:test";
import { ModelRetryBudget } from "@zcode/contracts";
import {
  isSinglePhysicalAttemptBudget,
  retryBudgetAllows,
  retryAttemptLoopContinues,
  retryBudgetMaxAttempts,
} from "../src/model/retry-budget.js";
import { retryAllowedByFailurePolicy } from "../src/model/workflow-model-failure-policy.js";
import { canRetryEmptyCompletion } from "../src/model/empty-completion-retry.js";
import type { ClassifiedModelFailure } from "../src/model/failure-classifier.js";

test("G15 & G16: Single physical attempt adapter policy disables all retry loops", () => {
  const budget = ModelRetryBudget.SinglePhysicalAttempt;

  assert.equal(isSinglePhysicalAttemptBudget(budget), true);

  // retryBudgetAllows: must strictly return false under single physical attempt
  assert.equal(retryBudgetAllows(budget, 1, 10), false);
  assert.equal(retryBudgetAllows(budget, 0, 10), false);

  // retryAttemptLoopContinues: allowed for attempt 1, blocked for attempt > 1
  assert.equal(retryAttemptLoopContinues(budget, 1, 10), true);
  assert.equal(retryAttemptLoopContinues(budget, 2, 10), false);

  // retryBudgetMaxAttempts reports 1
  assert.equal(retryBudgetMaxAttempts(budget, 10), 1);

  // canRetryEmptyCompletion is disabled
  assert.equal(
    canRetryEmptyCompletion({
      attempt: 1,
      maxAttempts: 10,
      retryCount: 0,
      singlePhysicalAttempt: true,
    }),
    false,
  );

  // retryAllowedByFailurePolicy strictly returns false
  const retryableFailure: ClassifiedModelFailure = {
    code: "transient_error",
    message: "Network glitch",
    reason: "network_reset",
    retryReason: "network_reset",
    retryable: true,
  };
  assert.equal(
    retryAllowedByFailurePolicy(retryableFailure, ModelRetryBudget.SinglePhysicalAttempt, undefined),
    false,
  );
});
