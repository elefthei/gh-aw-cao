import { jobId, repositoryId, runId, sourceId, workflowId } from '../model/ids.js';
import { canonicalTimestamp, ENTITY_KINDS, requiredString } from '../model/schema.js';

export const SQL_EXPORT_CONTRACT = 'gh-aw-cao.dashboard-sql-export';
export const SQL_EXPORT_VERSION = 1;

/** @param {unknown} value @param {string} field */
function objectValue(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} field */
function identifier(value, field) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) {
    throw new TypeError(`${field} is required`);
  }
  return String(value).trim();
}

/** @param {unknown} value @param {string} field */
function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`${field} must be a positive integer`);
  return number;
}

/** @param {unknown} value */
function optionalString(value) {
  return value === undefined || value === null ? undefined : String(value);
}

/** @param {unknown} value @param {string} field */
function optionalStringArray(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((item, index) => identifier(item, `${field}[${index}]`));
}

/** @param {unknown} value @param {string} field */
function optionalNumber(value, field) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${field} must be a finite number`);
  return number;
}

/** @param {unknown} value @param {string} field */
function nullableNumber(value, field) {
  return optionalNumber(value, field) ?? null;
}

/** @param {unknown} value @param {string} field */
function optionalBoolean(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

/** @param {unknown} value @param {string} field */
function optionalTimestamp(value, field) {
  return value === undefined || value === null
    ? undefined
    : canonicalTimestamp(value, field);
}

/** @param {unknown} value @param {string} field @param {string[]} allowed */
function optionalEnum(value, field, allowed) {
  const normalized = optionalString(value);
  if (normalized !== undefined && !allowed.includes(normalized)) {
    throw new TypeError(`${field} must be one of ${allowed.join(', ')}`);
  }
  return normalized;
}

/**
 * Converts rows exported from the versioned CAO SQL interchange view. Database
 * owners map their schema to this contract before publishing the static JSON.
 *
 * @param {unknown} input
 * @returns {{ observations: import('../model/schema.js').CanonicalObservation[] }}
 */
export function adaptSqlExport(input) {
  const document = objectValue(input, 'SQL export');
  if (document.contract !== SQL_EXPORT_CONTRACT) {
    throw new TypeError(`SQL export contract must be ${SQL_EXPORT_CONTRACT}`);
  }
  if (document.schema_version !== SQL_EXPORT_VERSION) {
    throw new TypeError(`Unsupported SQL export schema version: ${String(document.schema_version)}`);
  }
  const exportedAt = canonicalTimestamp(document.exported_at, 'SQL export exported_at');
  const source = `sql:${requiredString(document.source, 'SQL export source')}`;
  if (!Array.isArray(document.rows)) throw new TypeError('SQL export rows must be an array');

  /** @type {import('../model/schema.js').CanonicalObservation[]} */
  const observations = [];
  for (const [index, candidate] of document.rows.entries()) {
    const row = objectValue(candidate, `SQL export row ${index}`);
    const kind = requiredString(row.entity_kind, `SQL export row ${index}.entity_kind`);
    if (!ENTITY_KINDS.includes(/** @type {import('../model/schema.js').EntityKind} */ (kind))) {
      throw new TypeError(`Unsupported SQL export entity kind: ${kind}`);
    }
    const sourceRecordId = requiredString(row.source_id, `SQL export row ${index}.source_id`);
    const observedAt = canonicalTimestamp(row.observed_at ?? exportedAt, `SQL export row ${index}.observed_at`);
    /** @type {Record<string, unknown>} */
    let data;

    switch (kind) {
      case 'package':
        data = {
          slug: requiredString(row.package_slug, 'package_slug'),
          name: requiredString(row.package_name, 'package_name'),
          description: optionalString(row.package_description) ?? '',
          icon: optionalString(row.package_icon) ?? 'package',
          mode: optionalString(row.package_mode) ?? 'unknown',
          enabled: row.package_enabled !== false
        };
        break;
      case 'repository': {
        const owner = requiredString(row.repository_owner, 'repository_owner');
        const name = requiredString(row.repository_name, 'repository_name');
        data = {
          githubId: identifier(row.github_repository_id, 'github_repository_id'),
          owner,
          name,
          fullName: `${owner}/${name}`,
          visibility: optionalString(row.repository_visibility) ?? 'unknown'
        };
        break;
      }
      case 'workflow':
        data = {
          githubId: identifier(row.github_workflow_id, 'github_workflow_id'),
          repositoryId: repositoryId(identifier(row.github_repository_id, 'github_repository_id')),
          name: requiredString(row.workflow_name, 'workflow_name'),
          path: requiredString(row.workflow_path, 'workflow_path'),
          state: optionalString(row.workflow_state) ?? 'unknown',
          packageId: row.package_source_id === undefined || row.package_source_id === null
            ? undefined
            : sourceId('package', source, requiredString(row.package_source_id, 'package_source_id')),
          package: optionalString(row.package_slug)
        };
        break;
      case 'run': {
        const githubRunId = identifier(row.github_run_id, 'github_run_id');
        const attempt = positiveInteger(row.run_attempt, 'run_attempt');
        data = {
          githubRunId,
          attempt,
          repositoryId: repositoryId(identifier(row.github_repository_id, 'github_repository_id')),
          workflowId: workflowId(identifier(row.github_workflow_id, 'github_workflow_id')),
          event: optionalString(row.run_event) ?? 'unknown',
          status: optionalString(row.run_status) ?? 'unknown',
          conclusion: optionalString(row.run_conclusion) ?? null,
          createdAt: optionalString(row.run_created_at) ?? null,
          startedAt: optionalString(row.run_started_at) ?? null,
          completedAt: optionalString(row.run_completed_at) ?? null,
          headSha: optionalString(row.run_head_sha) ?? null,
          headBranch: optionalString(row.run_head_branch) ?? null
        };
        break;
      }
      case 'job':
        data = {
          githubJobId: identifier(row.github_job_id, 'github_job_id'),
          runId: runId(identifier(row.github_run_id, 'github_run_id'), positiveInteger(row.run_attempt, 'run_attempt')),
          name: requiredString(row.job_name, 'job_name'),
          status: optionalString(row.job_status) ?? 'unknown',
          conclusion: optionalString(row.job_conclusion) ?? null,
          startedAt: optionalString(row.job_started_at) ?? null,
          completedAt: optionalString(row.job_completed_at) ?? null
        };
        break;
      case 'session': {
        const sessionId = sourceId('session', source, sourceRecordId);
        data = {
          id: sessionId,
          runId: runId(identifier(row.github_run_id, 'github_run_id'), positiveInteger(row.run_attempt, 'run_attempt')),
          jobId: row.github_job_id === undefined || row.github_job_id === null
            ? undefined
            : jobId(identifier(row.github_job_id, 'github_job_id')),
          kind: requiredString(row.session_kind, 'session_kind'),
          status: optionalString(row.session_status) ?? 'unknown',
          startedAt: optionalString(row.session_started_at) ?? null,
          completedAt: optionalString(row.session_completed_at) ?? null
        };
        break;
      }
      case 'event': {
        if (row.source_sequence !== undefined && row.source_sequence !== null
          && (!Number.isInteger(Number(row.source_sequence)) || Number(row.source_sequence) < 0)) {
          throw new TypeError('source_sequence must be a non-negative integer');
        }
        const eventType = requiredString(row.event_type, 'event_type');
        const lifecycle = eventType === 'token_efficiency.intervention'
          && row.event_source === 'token-intervention-lifecycle';
        const comparison = eventType === 'token_efficiency.comparison'
          && row.event_source === 'token-efficiency-verifier';
        const tokenEfficiencyEvent = lifecycle || comparison;
        const comparisonNumber = comparison ? nullableNumber : optionalNumber;
        const targetRepo = tokenEfficiencyEvent
          ? requiredString(row.optimization_target_repo, 'optimization_target_repo')
          : optionalString(row.optimization_target_repo);
        const targetCoordinates = targetRepo?.split('/');
        if (targetCoordinates && (
          targetCoordinates.length !== 2
          || !targetCoordinates[0]
          || !targetCoordinates[1]
        )) {
          throw new TypeError('optimization_target_repo must be an owner/repository coordinate');
        }
        data = {
          sessionId: sourceId('session', source, requiredString(row.session_source_id, 'session_source_id')),
          timestamp: canonicalTimestamp(row.event_timestamp ?? observedAt, 'event_timestamp'),
          source: requiredString(row.event_source, 'event_source'),
          type: eventType,
          summary: optionalString(row.event_summary),
          correlationId: optionalString(row.correlation_id),
          payloadRef: optionalString(row.payload_ref),
          safeOutputType: optionalString(row.safe_output_type),
          githubEntityType: optionalString(row.github_entity_type),
          targetRepo,
          targetOrganization: targetCoordinates?.[0],
          targetRepository: targetCoordinates?.[1],
          targetWorkflowPath: tokenEfficiencyEvent
            ? requiredString(row.optimization_workflow_path, 'optimization_workflow_path')
            : optionalString(row.optimization_workflow_path),
          opportunityId: tokenEfficiencyEvent
            ? requiredString(row.optimization_opportunity_id, 'optimization_opportunity_id')
            : optionalString(row.optimization_opportunity_id),
          opportunityKind: optionalString(row.optimization_opportunity_kind),
          assignmentRunId: optionalString(row.optimization_assignment_run_id),
          evidenceWindowStart: optionalTimestamp(
            row.optimization_evidence_window_start,
            'optimization_evidence_window_start'
          ),
          evidenceWindowEnd: optionalTimestamp(
            row.optimization_evidence_window_end,
            'optimization_evidence_window_end'
          ),
          evidenceConfidence: optionalNumber(
            row.optimization_evidence_confidence,
            'optimization_evidence_confidence'
          ),
          costGrain: optionalString(row.optimization_cost_grain),
          evidenceProvenance: row.optimization_evidence_provenance,
          attributableRunIds: optionalStringArray(
            row.optimization_attributable_run_ids,
            'optimization_attributable_run_ids'
          ),
          interventionId: tokenEfficiencyEvent
            ? requiredString(row.optimization_intervention_id, 'optimization_intervention_id')
            : optionalString(row.optimization_intervention_id),
          lifecycleObservationId: lifecycle
            ? requiredString(
              row.optimization_lifecycle_observation_id,
              'optimization_lifecycle_observation_id'
            )
            : optionalString(row.optimization_lifecycle_observation_id),
          comparisonId: comparison
            ? requiredString(row.optimization_comparison_id, 'optimization_comparison_id')
            : optionalString(row.optimization_comparison_id),
          verificationComparisonId: optionalString(row.optimization_verification_comparison_id),
          previousInterventionState: optionalEnum(
            row.optimization_previous_intervention_state,
            'optimization_previous_intervention_state',
            ['proposed', 'accepted', 'running', 'verified', 'regressed', 'inconclusive', 'rejected']
          ),
          interventionState: optionalEnum(
            row.optimization_intervention_state,
            'optimization_intervention_state',
            ['proposed', 'accepted', 'running', 'verified', 'regressed', 'inconclusive', 'rejected']
          ),
          previousRecommendationDisposition: optionalEnum(
            row.optimization_previous_recommendation_disposition,
            'optimization_previous_recommendation_disposition',
            ['applied', 'superseded', 'outdated', 'duplicate', 'unapplied', 'failed-start', 'rejected']
          ),
          recommendationDisposition: optionalEnum(
            row.optimization_recommendation_disposition,
            'optimization_recommendation_disposition',
            ['applied', 'superseded', 'outdated', 'duplicate', 'unapplied', 'failed-start', 'rejected']
          ),
          supersedesInterventionId: optionalString(row.optimization_supersedes_intervention_id),
          supersededByInterventionId: optionalString(row.optimization_superseded_by_intervention_id),
          experimentId: optionalString(row.optimization_experiment_id),
          controlVariant: optionalString(row.optimization_control_variant),
          optimizedVariant: optionalString(row.optimization_optimized_variant),
          proposedSavingsAic: optionalNumber(
            row.optimization_proposed_savings_aic,
            'optimization_proposed_savings_aic'
          ),
          evaluatorDigest: comparison
            ? requiredString(row.optimization_evaluator_digest, 'optimization_evaluator_digest')
            : optionalString(row.optimization_evaluator_digest),
          verifierRunAttempt: row.optimization_verifier_run_attempt === undefined
            || row.optimization_verifier_run_attempt === null
            ? undefined
            : positiveInteger(
              row.optimization_verifier_run_attempt,
              'optimization_verifier_run_attempt'
            ),
          verifierWorkflowPath: optionalString(row.optimization_verifier_workflow_path),
          verifierWorkflowName: optionalString(row.optimization_verifier_workflow_name),
          baselineWindow: row.optimization_baseline_window,
          optimizedWindow: row.optimization_optimized_window,
          sourceGenerations: row.optimization_source_generations,
          baselineAicPerAcceptedOutcome: comparisonNumber(
            row.optimization_baseline_aic_per_accepted_outcome,
            'optimization_baseline_aic_per_accepted_outcome'
          ),
          optimizedAicPerAcceptedOutcome: comparisonNumber(
            row.optimization_optimized_aic_per_accepted_outcome,
            'optimization_optimized_aic_per_accepted_outcome'
          ),
          baselineAcceptedTargetOutcomeCount: comparisonNumber(
            row.optimization_baseline_accepted_target_outcome_count,
            'optimization_baseline_accepted_target_outcome_count'
          ),
          optimizedAcceptedTargetOutcomeCount: comparisonNumber(
            row.optimization_optimized_accepted_target_outcome_count,
            'optimization_optimized_accepted_target_outcome_count'
          ),
          acceptedTargetOutcomeCount: comparisonNumber(
            row.optimization_accepted_target_outcome_count,
            'optimization_accepted_target_outcome_count'
          ),
          baselineFailureRate: comparisonNumber(
            row.optimization_baseline_failure_rate,
            'optimization_baseline_failure_rate'
          ),
          optimizedFailureRate: comparisonNumber(
            row.optimization_optimized_failure_rate,
            'optimization_optimized_failure_rate'
          ),
          outcomeQualityPreserved: optionalBoolean(
            row.optimization_outcome_quality_preserved,
            'optimization_outcome_quality_preserved'
          ),
          reliabilityPreserved: optionalBoolean(
            row.optimization_reliability_preserved,
            'optimization_reliability_preserved'
          ),
          grossRealizedSavingsAic: comparisonNumber(
            row.optimization_gross_realized_savings_aic,
            'optimization_gross_realized_savings_aic'
          ),
          optimizationOverheadAic: comparisonNumber(
            row.optimization_overhead_aic,
            'optimization_overhead_aic'
          ),
          netRealizedSavingsAic: comparisonNumber(
            row.optimization_net_realized_savings_aic,
            'optimization_net_realized_savings_aic'
          ),
          verifiedNetGain: comparisonNumber(
            row.optimization_verified_net_gain,
            'optimization_verified_net_gain'
          ),
          attributableOverheadRunIds: optionalStringArray(
            row.optimization_attributable_overhead_run_ids,
            'optimization_attributable_overhead_run_ids'
          ),
          baselineInputTokens: comparisonNumber(row.optimization_baseline_input_tokens, 'optimization_baseline_input_tokens'),
          optimizedInputTokens: comparisonNumber(row.optimization_optimized_input_tokens, 'optimization_optimized_input_tokens'),
          baselineOutputTokens: comparisonNumber(row.optimization_baseline_output_tokens, 'optimization_baseline_output_tokens'),
          optimizedOutputTokens: comparisonNumber(row.optimization_optimized_output_tokens, 'optimization_optimized_output_tokens'),
          baselineCacheReadTokens: comparisonNumber(row.optimization_baseline_cache_read_tokens, 'optimization_baseline_cache_read_tokens'),
          optimizedCacheReadTokens: comparisonNumber(row.optimization_optimized_cache_read_tokens, 'optimization_optimized_cache_read_tokens'),
          baselineCacheWriteTokens: comparisonNumber(row.optimization_baseline_cache_write_tokens, 'optimization_baseline_cache_write_tokens'),
          optimizedCacheWriteTokens: comparisonNumber(row.optimization_optimized_cache_write_tokens, 'optimization_optimized_cache_write_tokens'),
          baselineReasoningTokens: comparisonNumber(row.optimization_baseline_reasoning_tokens, 'optimization_baseline_reasoning_tokens'),
          optimizedReasoningTokens: comparisonNumber(row.optimization_optimized_reasoning_tokens, 'optimization_optimized_reasoning_tokens'),
          maturityAt: optionalTimestamp(row.optimization_maturity_at, 'optimization_maturity_at'),
          maturityStatus: optionalString(row.optimization_maturity_status),
          evidenceCutoff: optionalTimestamp(row.optimization_evidence_cutoff, 'optimization_evidence_cutoff'),
          evidenceLinks: optionalStringArray(row.optimization_evidence_links, 'optimization_evidence_links'),
          recommendationChurnCount: optionalNumber(
            row.optimization_recommendation_churn_count,
            'optimization_recommendation_churn_count'
          ),
          recommendationChurnRate: optionalNumber(
            row.optimization_recommendation_churn_rate,
            'optimization_recommendation_churn_rate'
          ),
          evidenceState: optionalEnum(
            row.optimization_evidence_state,
            'optimization_evidence_state',
            ['complete', 'incomplete', 'incomparable', 'unmatured', 'unavailable']
          ),
          missingReason: optionalString(row.optimization_missing_reason),
          safeOutputId: optionalString(row.optimization_safe_output_id),
          safeOutputUrl: optionalString(row.optimization_safe_output_url),
          implementationChangeId: optionalString(row.optimization_implementation_change_id),
          implementationPullRequestUrl: optionalString(
            row.optimization_implementation_pull_request_url
          ),
          implementationRunIds: optionalStringArray(
            row.optimization_implementation_run_ids,
            'optimization_implementation_run_ids'
          ),
          optimizerRunAttempt: row.optimization_optimizer_run_attempt === undefined
            || row.optimization_optimizer_run_attempt === null
            ? undefined
            : positiveInteger(
              row.optimization_optimizer_run_attempt,
              'optimization_optimizer_run_attempt'
            ),
          optimizerWorkflowPath: optionalString(row.optimization_optimizer_workflow_path),
          optimizerWorkflowName: optionalString(row.optimization_optimizer_workflow_name),
          claimRunId: lifecycle
            ? identifier(row.optimization_claim_run_id, 'optimization_claim_run_id')
            : optionalString(row.optimization_claim_run_id),
          claimRunAttempt: row.optimization_claim_run_attempt === undefined
            || row.optimization_claim_run_attempt === null
            ? undefined
            : positiveInteger(
              row.optimization_claim_run_attempt,
              'optimization_claim_run_attempt'
            ),
          actor: lifecycle
            ? requiredString(row.optimization_actor, 'optimization_actor')
            : optionalString(row.optimization_actor),
          sourceProvenance: lifecycle
            ? objectValue(row.optimization_source_provenance, 'optimization_source_provenance')
            : row.optimization_source_provenance,
          acceptedAt: optionalTimestamp(row.optimization_accepted_at, 'optimization_accepted_at'),
          implementationStartedAt: optionalTimestamp(
            row.optimization_implementation_started_at,
            'optimization_implementation_started_at'
          ),
          implementationCompletedAt: optionalTimestamp(
            row.optimization_implementation_completed_at,
            'optimization_implementation_completed_at'
          ),
          rejectedAt: optionalTimestamp(row.optimization_rejected_at, 'optimization_rejected_at'),
          supersededAt: optionalTimestamp(
            row.optimization_superseded_at,
            'optimization_superseded_at'
          ),
          sourceSequence: row.source_sequence === undefined || row.source_sequence === null
            ? undefined
            : Number(row.source_sequence)
        };
        if (lifecycle) {
          data.previousInterventionState = requiredString(
            data.previousInterventionState,
            'optimization_previous_intervention_state'
          );
          data.interventionState = requiredString(
            data.interventionState,
            'optimization_intervention_state'
          );
          data.previousRecommendationDisposition = requiredString(
            data.previousRecommendationDisposition,
            'optimization_previous_recommendation_disposition'
          );
          data.recommendationDisposition = requiredString(
            data.recommendationDisposition,
            'optimization_recommendation_disposition'
          );
          data.evidenceState = requiredString(
            data.evidenceState,
            'optimization_evidence_state'
          );
          data.safeOutputId = requiredString(
            data.safeOutputId,
            'optimization_safe_output_id'
          );
          data.safeOutputUrl = requiredString(
            data.safeOutputUrl,
            'optimization_safe_output_url'
          );
        }
        if (comparison) {
          data.costGrain = requiredString(data.costGrain, 'optimization_cost_grain');
          data.controlVariant = requiredString(data.controlVariant, 'optimization_control_variant');
          data.optimizedVariant = requiredString(data.optimizedVariant, 'optimization_optimized_variant');
          data.verifierRunAttempt = positiveInteger(
            data.verifierRunAttempt,
            'optimization_verifier_run_attempt'
          );
          data.verifierWorkflowPath = requiredString(
            data.verifierWorkflowPath,
            'optimization_verifier_workflow_path'
          );
          data.verifierWorkflowName = requiredString(
            data.verifierWorkflowName,
            'optimization_verifier_workflow_name'
          );
          data.implementationChangeId = requiredString(
            data.implementationChangeId,
            'optimization_implementation_change_id'
          );
          data.evidenceState = requiredString(data.evidenceState, 'optimization_evidence_state');
          data.maturityAt = canonicalTimestamp(data.maturityAt, 'optimization_maturity_at');
          data.maturityStatus = requiredString(
            data.maturityStatus,
            'optimization_maturity_status'
          );
          data.evidenceCutoff = canonicalTimestamp(
            data.evidenceCutoff,
            'optimization_evidence_cutoff'
          );
        }
        break;
      }
      default:
        throw new TypeError(`Unsupported SQL export entity kind: ${kind}`);
    }

    observations.push({
      kind: /** @type {import('../model/schema.js').EntityKind} */ (kind),
      source,
      sourceId: sourceRecordId,
      observedAt,
      data
    });
  }

  return { observations };
}