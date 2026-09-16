#!/usr/bin/env bash

set -uo pipefail

repository="${GITHUB_REPOSITORY:-}"
shard_directory="${REPORT_GH_AW_LOGS_SHARDS:-_activity/gh-aw-logs-shards}"
control_settings_path="${REPORT_CONTROL_SETTINGS:-}"
output_directory="${REPORT_AIC_CACHE:-_activity/gh-aw-logs}"
exit_code_path="${REPORT_GH_AW_LOGS_EXIT_CODE:-_activity/gh-aw-logs-exit-code}"
drain3_weights_path="${REPORT_DRAIN3_WEIGHTS:-}"
window_days="${REPORT_RUN_WINDOW_DAYS:-30}"
run_limit="${REPORT_RUN_LIMIT:-10}"
request_timeout="${REPORT_LOG_TIMEOUT:-10}"
rate_limit="${REPORT_MAX_GITHUB_API_RATE_LIMIT:--2000}"
max_storage="${REPORT_MAX_STORAGE:-1200}"

mkdir -p "$output_directory" "$shard_directory" "$(dirname "$exit_code_path")"

repositories=()
add_repository() {
  local candidate="$1"
  local normalized_candidate
  [[ "$candidate" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] || return
  normalized_candidate="$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]')"
  for existing in "${repositories[@]:-}"; do
    [[ -n "$existing" ]] || continue
    [[ "$(printf '%s' "$existing" | tr '[:upper:]' '[:lower:]')" == "$normalized_candidate" ]] && return
  done
  repositories+=("$candidate")
}

if [[ -n "$control_settings_path" && -f "$control_settings_path" ]]; then
  while IFS= read -r allowed_repository; do
    add_repository "$allowed_repository"
  done < <(jq -r '.allowed_repositories[]?' "$control_settings_path")
fi
add_repository "$repository"

exit_code=0
drain3_args=()
if [[ -n "$drain3_weights_path" && -f "$drain3_weights_path" ]]; then
  drain3_args+=(--drain3-weights "$drain3_weights_path")
fi
for target_repository in "${repositories[@]}"; do
  cache_name="${target_repository//\//-}"
  if [[ "$(printf '%s' "$target_repository" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$repository" | tr '[:upper:]' '[:lower:]')" ]]; then
    shard_prefix="$shard_directory/logs-"
  else
    shard_prefix="$shard_directory/${cache_name}-logs-"
  fi
  set +e
  gh aw logs --audit \
    --repo "$target_repository" \
    --output "$output_directory/$cache_name" \
    --summary-file "" \
    --cached-logs "${shard_prefix}*" \
    --artifacts usage \
    --start-date "-${window_days}d" \
    --cache-before "-${window_days}d" \
    --count "$run_limit" \
    --timeout "$request_timeout" \
    --max-github-api-rate-limit "$rate_limit" \
    --max-storage "$max_storage" \
    --prune-older-runs \
    "${drain3_args[@]+"${drain3_args[@]}"}"
  repository_exit_code=$?
  set -e
  generated_weights="$output_directory/$cache_name/drain3_weights.json"
  if [[ -n "$drain3_weights_path" && -f "$generated_weights" ]]; then
    mv "$generated_weights" "$drain3_weights_path"
    drain3_args=(--drain3-weights "$drain3_weights_path")
  fi
  if [[ $repository_exit_code -ne 0 ]]; then
    exit_code=$repository_exit_code
  fi
done

observation_shard="$shard_directory/token-efficiency-observations.jsonl"
observation_tmp="$observation_shard.tmp"
: > "$observation_tmp"
observation_complete=false
if [[ $exit_code -eq 0 ]]; then
  set +e
  gh api "repos/$repository/actions/artifacts?name=token-efficiency-observation&per_page=$run_limit" \
    --jq '.artifacts[]
      | select(.expired == false and .name == "token-efficiency-observation")
      | select((now - (.created_at | fromdateiso8601)) <= ('"$window_days"' * 86400))
      | [.id, .workflow_run.id, .archive_download_url, .created_at]
      | @tsv' \
    | while IFS=$'\t' read -r artifact_id workflow_run_id archive_url created_at; do
        [[ -n "$artifact_id" && -n "$workflow_run_id" && -n "$archive_url" ]] || continue
        workflow_path="$(gh api "repos/$repository/actions/runs/$workflow_run_id" --jq '.path' 2>/dev/null || true)"
        [[ "$workflow_path" == ".github/workflows/optimization-token-optimizer.lock.yml" ]] || continue
        archive="$output_directory/token-efficiency-observation-$artifact_id.zip"
        extracted="$output_directory/token-efficiency-observation-$artifact_id"
        if ! gh api "$archive_url" > "$archive"; then
          exit 1
        fi
        mkdir -p "$extracted"
        if ! unzip -qq -o "$archive" -d "$extracted"; then
          exit 1
        fi
        file="$extracted/token-efficiency-observation.json"
        if jq -e --arg run "$workflow_run_id" --arg repository "$repository" '
            .schemaVersion == 1
            and .optimizerRunId == $run
            and .controlRepository == $repository
            and (.targetRepo | type == "string")
            and (.workflowPath | type == "string")
            and .evidenceState == "complete"
            and .costGrain == "invocation"
          ' "$file" >/dev/null 2>&1; then
          jq -c --arg createdAt "$created_at" \
            '{schema_version: 2, kind: "token_efficiency_observation", created_at: $createdAt, observation: .}' \
            "$file" >> "$observation_tmp"
        else
          exit 1
        fi
      done
  observation_status=("${PIPESTATUS[@]}")
  set -e
  if [[ ${observation_status[0]} -eq 0 && ${observation_status[1]} -eq 0 ]]; then
    observation_complete=true
  else
    exit_code=1
  fi
fi
if [[ "$observation_complete" == true ]]; then
  mv "$observation_tmp" "$observation_shard"
else
  rm -f "$observation_tmp"
fi

printf '%s\n' "$exit_code" > "$exit_code_path"

# The shard directory is persisted by the caller so each repository reuses
# known runs; out-of-range shards are pruned by `--cache-before`.
