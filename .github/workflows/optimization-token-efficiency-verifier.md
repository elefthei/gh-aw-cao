---
emoji: ":mag:"

description: "Review-only verification of one authoritative applied token-efficiency intervention"

name: "AW Optimization / Token Efficiency Verifier"

max-ai-credits: 50
max-daily-ai-credits: -1

on:
  bots: ["github-actions[bot]", "cao-githubnext-gh-aw-cao-write[bot]"]
  workflow_dispatch:
    inputs:
      target_repo:
        required: true
        type: string
      safe_output_repo:
        required: true
        type: string
      max_repos:
        type: number
      rollout_percent:
        type: number
      safe_output_mode:
        type: string
      correlation_id:
        type: string
      central_repo:
        type: string
      control_plane_run_url:
        type: string
      batch_label:
        type: string
      opportunity_id:
        required: true
        type: string
      intervention_id:
        required: true
        type: string
      evidence_cutoff:
        required: true
        type: string
  permissions:
    contents: read
    actions: read

env:
  GH_AW_SAFE_OUTPUT_MODE: ${{ inputs.safe_output_mode || 'review' }}
  REVIEW_OUTPUT_REPO: ${{ inputs.safe_output_repo || github.repository }}
  SAFE_OUTPUT_REPO: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || inputs.target_repo }}
  TARGET_REPO: ${{ inputs.target_repo || '' }}

if: needs.pre_activation.outputs.cao_authorized == 'true'

jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}
  activation:
    outputs:
      verification_eligible: ${{ steps.verification_eligibility.outputs.eligible }}
      verification_reason: ${{ steps.verification_eligibility.outputs.reason }}
    pre-steps:
      - name: Checkout control repository
        uses: actions/checkout@v7.0.1
      - name: Validate one matured applied intervention
        id: verification_eligibility
        env:
          TARGET_REPOSITORY: ${{ inputs.target_repo }}
          OPPORTUNITY_ID: ${{ inputs.opportunity_id }}
          INTERVENTION_ID: ${{ inputs.intervention_id }}
          EVIDENCE_CUTOFF: ${{ inputs.evidence_cutoff }}
          REQUESTED_MODE: ${{ inputs.safe_output_mode }}
        run: |
          set -euo pipefail
          claim_directory="$RUNNER_TEMP/token-efficiency-verifier"
          mkdir -p "$claim_directory"
          db="$RUNNER_TEMP/cao-activity/gh-aw-logs.sqlite"
          eligible=false
          reason=invalid-verification-evidence

          if [ -f activity/cao.mjs ]; then
            cao_script=activity/cao.mjs
          elif [ -f .github/aw/activity/cao.mjs ]; then
            cao_script=.github/aw/activity/cao.mjs
          else
            cao_script=
          fi

          if [ -n "$REQUESTED_MODE" ] && [ "$REQUESTED_MODE" != review ]; then
            reason=review-mode-required
          elif [ -z "$cao_script" ] || [ ! -s "$db" ]; then
            reason=activity-cache-unavailable
          elif ! jq -en \
              --arg target "$TARGET_REPOSITORY" \
              --arg opportunity "$OPPORTUNITY_ID" \
              --arg intervention "$INTERVENTION_ID" \
              --arg cutoff "$EVIDENCE_CUTOFF" '
                ($target | test("^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$"))
                and ($opportunity | startswith("token-opportunity:"))
                and ($intervention | startswith("token-intervention:" + $opportunity + ":"))
                and ($cutoff | fromdateiso8601? != null)
              ' >/dev/null; then
            reason=invalid-verification-selectors
          else
            set +e
            interventions="$(node "$cao_script" query \
              --database "$db" \
              --collection events \
              --where type=token_efficiency.intervention 2>/dev/null)"
            query_status=$?
            set -e
            if [ "$query_status" -ne 0 ] || ! jq -e 'type == "array"' <<<"$interventions" >/dev/null; then
              reason=intervention-history-unavailable
            elif ! jq -e \
                --arg target "$TARGET_REPOSITORY" \
                --arg opportunity "$OPPORTUNITY_ID" \
                --arg intervention "$INTERVENTION_ID" '
                  [.[]?
                    | select(
                      .type == "token_efficiency.intervention"
                      and .targetRepo == $target
                      and .opportunityId == $opportunity
                      and .interventionId == $intervention
                    )]
                  | sort_by(.observedAt)
                  | last
                  | .recommendationDisposition == "applied"
                    and (.interventionState | IN("running", "verified", "regressed", "inconclusive"))
                    and (.implementationChangeId | type == "string" and length > 0)
                    and (.implementationCompletedAt | fromdateiso8601? != null)
                ' <<<"$interventions" >/dev/null; then
              reason=authoritative-applied-implementation-required
            else
              eligible=true
              reason=eligible
              jq -cn \
                --arg targetRepo "$TARGET_REPOSITORY" \
                --arg opportunityId "$OPPORTUNITY_ID" \
                --arg interventionId "$INTERVENTION_ID" \
                --arg evidenceCutoff "$EVIDENCE_CUTOFF" \
                --arg controlRepository "$GITHUB_REPOSITORY" \
                --arg verifierRunId "$GITHUB_RUN_ID" \
                --arg verifierRunAttempt "$GITHUB_RUN_ATTEMPT" \
                '{
                  schemaVersion: 1,
                  targetRepo: $targetRepo,
                  opportunityId: $opportunityId,
                  interventionId: $interventionId,
                  evidenceCutoff: $evidenceCutoff,
                  controlRepository: $controlRepository,
                  verifierRunId: $verifierRunId,
                  verifierRunAttempt: ($verifierRunAttempt | tonumber)
                }' \
                > "$claim_directory/token-efficiency-verification-claim.json"
            fi
          fi

          echo "eligible=$eligible" >> "$GITHUB_OUTPUT"
          echo "reason=$reason" >> "$GITHUB_OUTPUT"
      - name: Publish immutable verification selectors
        if: ${{ steps.verification_eligibility.outputs.eligible == 'true' }}
        uses: actions/upload-artifact@v7.0.1
        with:
          name: token-efficiency-verification-claim
          path: ${{ runner.temp }}/token-efficiency-verifier/token-efficiency-verification-claim.json
          if-no-files-found: error
          retention-days: 90
  agent:
    if: ${{ false }}

imports:
  - uses: shared/control.md
    with:
      package: optimization
      role: worker
      worker: token-efficiency-verifier
  - uses: shared/activity-cache.md

permissions:
  contents: read
  actions: read
  copilot-requests: write

strict: true

network:
  allowed:
    - defaults
    - github

run-name: "Token Efficiency Verifier · ${{ inputs.target_repo }} · review"

concurrency:
  group: "${{ github.workflow }}-${{ inputs.intervention_id }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: true

tracker-id: optimization-token-efficiency-verifier

tools:
  github:
    mode: gh-proxy
    toolsets: [actions]
  bash:
    - "*"

timeout-minutes: 10

source: githubnext/gh-aw-cao/.github/workflows/optimization-token-efficiency-verifier.md@main
---

# AW Optimization / Token Efficiency Verifier

This workflow has no model task. The activation job publishes immutable
selectors. Activity independently resolves those selectors against retained
authoritative records before it can produce comparison or lifecycle
observations. It never checks out or writes to the target repository.

{{#runtime-import? .github/cao/optimization.md}}
