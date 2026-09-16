import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adaptCachedGhAwJsonl } from '../../src/data/adapters/gh-aw-logs.js';
import { adaptSqlExport } from '../../src/data/adapters/sql-export.js';
import { relationshipErrors } from '../../src/data/model/schema.js';
import { normalize } from '../../src/data/normalize/index.js';

function fixture() {
  return JSON.parse(readFileSync(resolve('test/fixtures/sql-export-v1.json'), 'utf8'));
}

describe('SQL export adapter', () => {
  it('converts a versioned static export into a complete ordered canonical graph', () => {
    const adapted = adaptSqlExport(fixture());
    const batch = normalize(adapted.observations);

    expect(relationshipErrors(batch)).toEqual([]);
    expect(batch).toMatchObject({
      repositories: [{ id: 'github:repository:101', fullName: 'githubnext/gh-aw-cao' }],
      workflows: [{ id: 'github:workflow:202', repositoryId: 'github:repository:101' }],
      runs: [{
        id: 'github:run:303:attempt:1',
        repositoryId: 'github:repository:101',
        workflowId: 'github:workflow:202'
      }],
      jobs: [{ id: 'github:job:404', runId: 'github:run:303:attempt:1' }],
      sessions: [{
        id: 'session:sql%3Aenterprise-warehouse:session-505',
        runId: 'github:run:303:attempt:1',
        jobId: 'github:job:404'
      }]
    });
    expect(batch.events.map((event) => [event.sequence, event.type])).toEqual([
      [0, 'message.user'],
      [1, 'firewall.request.allowed']
    ]);
    expect(batch.events[0]).toMatchObject({
      safeOutputType: 'create_issue',
      githubEntityType: 'issue'
    });
  });

  it('rejects unknown schema versions', () => {
    expect(() => adaptSqlExport({ ...fixture(), schema_version: 2 }))
      .toThrow('Unsupported SQL export schema version: 2');
  });

  it('preserves token intervention lifecycle identity and evidence', () => {
    const input = fixture();
    input.rows.push({
      entity_kind: 'event',
      source_id: 'event-token-lifecycle',
      observed_at: '2026-09-09T05:00:00Z',
      session_source_id: 'session-505',
      event_timestamp: '2026-09-09T04:00:03Z',
      event_source: 'token-intervention-lifecycle',
      event_type: 'token_efficiency.intervention',
      source_sequence: 3,
      optimization_target_repo: 'octo/example',
      optimization_workflow_path: '.github/workflows/review.md',
      optimization_opportunity_id: 'token-opportunity:1',
      optimization_opportunity_kind: 'unbounded-context-growth',
      optimization_assignment_run_id: '6999',
      optimization_evidence_window_start: '2026-09-01T00:00:00Z',
      optimization_evidence_window_end: '2026-09-08T00:00:00Z',
      optimization_evidence_confidence: 0.9,
      optimization_cost_grain: 'invocation',
      optimization_evidence_provenance: [{ source: 'activity', runId: '6999' }],
      optimization_attributable_run_ids: ['6999', '7001'],
      optimization_intervention_id: 'token-intervention:1',
      optimization_lifecycle_observation_id: 'token-lifecycle:1',
      optimization_previous_intervention_state: 'accepted',
      optimization_intervention_state: 'running',
      optimization_previous_recommendation_disposition: 'unapplied',
      optimization_recommendation_disposition: 'applied',
      optimization_evidence_state: 'complete',
      optimization_safe_output_id: 'github:issue:githubnext/gh-aw-cao:11861',
      optimization_safe_output_url: 'https://github.com/githubnext/gh-aw-cao/issues/11861',
      optimization_implementation_change_id: 'github:pull-request:octo/example:42',
      optimization_implementation_pull_request_url: 'https://github.com/octo/example/pull/42',
      optimization_implementation_run_ids: ['7001'],
      optimization_optimizer_run_attempt: 1,
      optimization_optimizer_workflow_path: '.github/workflows/optimization-token-optimizer.md',
      optimization_optimizer_workflow_name: 'AW Optimization / Token Optimizer',
      optimization_claim_run_id: '1189001',
      optimization_claim_run_attempt: 1,
      optimization_actor: 'maintainer',
      optimization_source_provenance: {
        kind: 'workflow-dispatch-claim',
        sourceId: 'github-actions-run:githubnext/gh-aw-cao:1189001:attempt:1'
      },
      optimization_accepted_at: '2026-09-08T04:00:00Z',
      optimization_implementation_started_at: '2026-09-08T05:00:00Z',
      optimization_implementation_completed_at: '2026-09-09T04:00:00Z'
    });

    const event = normalize(adaptSqlExport(input).observations).events
      .find((candidate) => candidate.type === 'token_efficiency.intervention');
    expect(event).toMatchObject({
      targetRepo: 'octo/example',
      targetWorkflowPath: '.github/workflows/review.md',
      opportunityId: 'token-opportunity:1',
      opportunityKind: 'unbounded-context-growth',
      assignmentRunId: '6999',
      evidenceWindowStart: '2026-09-01T00:00:00.000Z',
      evidenceWindowEnd: '2026-09-08T00:00:00.000Z',
      evidenceConfidence: 0.9,
      costGrain: 'invocation',
      evidenceProvenance: [{ source: 'activity', runId: '6999' }],
      attributableRunIds: ['6999', '7001'],
      interventionId: 'token-intervention:1',
      lifecycleObservationId: 'token-lifecycle:1',
      interventionState: 'running',
      recommendationDisposition: 'applied',
      implementationRunIds: ['7001'],
      claimRunId: '1189001',
      claimRunAttempt: 1,
      actor: 'maintainer',
      sourceProvenance: {
        kind: 'workflow-dispatch-claim',
        sourceId: 'github-actions-run:githubnext/gh-aw-cao:1189001:attempt:1'
      }
    });
  });

  it('normalizes token comparisons equivalently to the Activity adapter', () => {
    const input = fixture();
    input.rows.push({
      entity_kind: 'event',
      source_id: 'event-token-comparison',
      observed_at: '2026-10-02T00:02:00Z',
      session_source_id: 'session-505',
      event_timestamp: '2026-10-02T00:02:00Z',
      event_source: 'token-efficiency-verifier',
      event_type: 'token_efficiency.comparison',
      source_sequence: 4,
      optimization_target_repo: 'octo/example',
      optimization_workflow_path: '.github/workflows/review.md',
      optimization_opportunity_id: 'token-opportunity:1',
      optimization_intervention_id: 'token-intervention:1',
      optimization_comparison_id: 'token-comparison:1',
      optimization_implementation_change_id: 'github:pull-request:octo/example:42',
      optimization_experiment_id: 'review-context-v1',
      optimization_evaluator_digest: 'quality:sha256',
      optimization_evidence_state: 'complete',
      optimization_cost_grain: 'invocation',
      optimization_control_variant: 'control',
      optimization_optimized_variant: 'optimized',
      optimization_verifier_run_attempt: 1,
      optimization_verifier_workflow_path: '.github/workflows/optimization-token-efficiency-verifier.md',
      optimization_verifier_workflow_name: 'AW Optimization / Token Efficiency Verifier',
      optimization_baseline_aic_per_accepted_outcome: 10,
      optimization_optimized_aic_per_accepted_outcome: 5,
      optimization_baseline_accepted_target_outcome_count: 2,
      optimization_optimized_accepted_target_outcome_count: 2,
      optimization_accepted_target_outcome_count: 2,
      optimization_baseline_failure_rate: 0,
      optimization_optimized_failure_rate: 0,
      optimization_outcome_quality_preserved: true,
      optimization_reliability_preserved: true,
      optimization_gross_realized_savings_aic: 10,
      optimization_overhead_aic: 3,
      optimization_net_realized_savings_aic: 7,
      optimization_verified_net_gain: 0.35,
      optimization_baseline_input_tokens: 2000,
      optimization_optimized_input_tokens: 1000,
      optimization_maturity_at: '2026-09-30T00:00:00Z',
      optimization_maturity_status: 'mature',
      optimization_evidence_cutoff: '2026-10-01T00:00:00Z'
    });

    const event = normalize(adaptSqlExport(input).observations).events
      .find((candidate) => candidate.comparisonId === 'token-comparison:1');
    expect(event).toMatchObject({
      type: 'token_efficiency.comparison',
      targetRepo: 'octo/example',
      evidenceState: 'complete',
      baselineAicPerAcceptedOutcome: 10,
      optimizedAicPerAcceptedOutcome: 5,
      outcomeQualityPreserved: true,
      netRealizedSavingsAic: 7,
      verifiedNetGain: 0.35,
      baselineInputTokens: 2000,
      optimizedInputTokens: 1000,
      maturityStatus: 'mature'
    });
  });

  it('uses null for missing comparison measures in SQL and Activity projections', () => {
      const comparison = {
        schemaVersion: 1,
        comparisonId: 'token-comparison:incomplete',
        observedAt: '2026-10-02T00:02:00Z',
        verifierRunId: '1199201',
        verifierRunAttempt: 1,
        verifierWorkflowPath: '.github/workflows/optimization-token-efficiency-verifier.md',
        verifierWorkflowName: 'AW Optimization / Token Efficiency Verifier',
        targetRepo: 'octo/example',
        workflowPath: '.github/workflows/review.md',
        opportunityId: 'token-opportunity:1',
        interventionId: 'token-intervention:1',
        implementationChangeId: 'github:pull-request:octo/example:42',
        experimentId: 'review-context-v1',
        evaluatorDigest: 'quality:sha256',
        evidenceState: 'incomplete',
        missingReason: 'authoritative-outcome-evidence-absent',
        costGrain: 'invocation',
        controlVariant: 'control',
        optimizedVariant: 'optimized',
        maturityAt: '2026-09-30T00:00:00Z',
        maturityStatus: 'mature',
        evidenceCutoff: '2026-10-01T00:00:00Z'
      };
      const sqlInput = fixture();
      sqlInput.rows.push({
        entity_kind: 'event',
        source_id: 'event-token-comparison-incomplete',
        observed_at: comparison.observedAt,
        session_source_id: 'session-505',
        event_timestamp: comparison.observedAt,
        event_source: 'token-efficiency-verifier',
        event_type: 'token_efficiency.comparison',
        source_sequence: 5,
        optimization_target_repo: comparison.targetRepo,
        optimization_workflow_path: comparison.workflowPath,
        optimization_opportunity_id: comparison.opportunityId,
        optimization_intervention_id: comparison.interventionId,
        optimization_comparison_id: comparison.comparisonId,
        optimization_implementation_change_id: comparison.implementationChangeId,
        optimization_experiment_id: comparison.experimentId,
        optimization_evaluator_digest: comparison.evaluatorDigest,
        optimization_evidence_state: comparison.evidenceState,
        optimization_missing_reason: comparison.missingReason,
        optimization_cost_grain: comparison.costGrain,
        optimization_control_variant: comparison.controlVariant,
        optimization_optimized_variant: comparison.optimizedVariant,
        optimization_verifier_run_attempt: comparison.verifierRunAttempt,
        optimization_verifier_workflow_path: comparison.verifierWorkflowPath,
        optimization_verifier_workflow_name: comparison.verifierWorkflowName,
        optimization_maturity_at: comparison.maturityAt,
        optimization_maturity_status: comparison.maturityStatus,
        optimization_evidence_cutoff: comparison.evidenceCutoff
      });
      const activity = [
        {
          schema_version: 2,
          kind: 'token_efficiency_run_context',
          run: {
            run_id: 1199201,
            run_attempt: 1,
            organization: 'githubnext',
            repository: 'githubnext/gh-aw-cao',
            workflow_name: comparison.verifierWorkflowName,
            workflow_path: comparison.verifierWorkflowPath,
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-10-02T00:00:00Z',
            updated_at: comparison.observedAt
          }
        },
        { schema_version: 2, kind: 'token_efficiency_comparison_observation', observation: comparison }
      ].map((record) => JSON.stringify(record)).join('\n');
      const sqlEvent = normalize(adaptSqlExport(sqlInput).observations).events
        .find((event) => event.comparisonId === comparison.comparisonId);
      const activityEvent = normalize(adaptCachedGhAwJsonl(activity).observations).events
        .find((event) => event.comparisonId === comparison.comparisonId);
      if (!sqlEvent || !activityEvent) throw new Error('incomplete comparison fixtures were not normalized');
      const fields = [
        'baselineAicPerAcceptedOutcome',
        'optimizedAicPerAcceptedOutcome',
        'baselineAcceptedTargetOutcomeCount',
        'optimizedAcceptedTargetOutcomeCount',
        'grossRealizedSavingsAic',
        'optimizationOverheadAic',
        'netRealizedSavingsAic',
        'verifiedNetGain',
        'baselineInputTokens',
        'optimizedInputTokens',
        'baselineOutputTokens',
        'optimizedOutputTokens',
        'baselineCacheReadTokens',
        'optimizedCacheReadTokens',
        'baselineCacheWriteTokens',
        'optimizedCacheWriteTokens',
        'baselineReasoningTokens',
        'optimizedReasoningTokens'
      ];
    expect(Object.fromEntries(fields.map((field) => [field, sqlEvent[field]])))
      .toEqual(Object.fromEntries(fields.map((field) => [field, activityEvent[field]])));
    expect(fields.every((field) => sqlEvent[field] === null)).toBe(true);
  });
});