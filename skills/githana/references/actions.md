# `githana_api` — actions

43 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/actions/artifacts` | actions | read | prefer `githana_run` |
| `DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}` | actions | write | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}` | actions | read | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}` | actions | read | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/cache/storage-limit` | actions | read |  |
| `GET /repos/{owner}/{repo}/actions/cache/usage` | actions | read |  |
| `DELETE /repos/{owner}/{repo}/actions/caches` | actions | write | prefer `githana_cache` |
| `GET /repos/{owner}/{repo}/actions/caches` | actions | read | prefer `githana_cache` |
| `DELETE /repos/{owner}/{repo}/actions/caches/{cache_id}` | actions | write | prefer `githana_cache` |
| `GET /repos/{owner}/{repo}/actions/concurrency_groups` | actions | read |  |
| `GET /repos/{owner}/{repo}/actions/concurrency_groups/{concurrency_group_name}` | actions | read |  |
| `GET /repos/{owner}/{repo}/actions/jobs/{job_id}` | actions | read |  |
| `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` | actions | read |  |
| `POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun` | actions | write |  |
| `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/steps/{step_number}/logs` | actions | read |  |
| `GET /repos/{owner}/{repo}/actions/oidc/customization/sub` | actions | read |  |
| `PUT /repos/{owner}/{repo}/actions/oidc/customization/sub` | actions | write |  |
| `GET /repos/{owner}/{repo}/actions/runs` | actions | read | prefer `githana_run` |
| `DELETE /repos/{owner}/{repo}/actions/runs/{run_id}` | actions | write | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}` | actions | read | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals` | actions | read | prefer `githana_run` |
| `POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve` | actions | write | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts` | actions | read | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}` | actions | read | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs` | actions | read | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/logs` | actions | read | prefer `githana_run` |
| `POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel` | actions | write | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/concurrency_groups` | actions | read | prefer `githana_run` |
| `POST /repos/{owner}/{repo}/actions/runs/{run_id}/force-cancel` | actions | write | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` | actions | read | prefer `githana_run` |
| `DELETE /repos/{owner}/{repo}/actions/runs/{run_id}/logs` | actions | write | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs` | actions | read | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments` | actions | read | prefer `githana_run` |
| `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun` | actions | write | prefer `githana_run` |
| `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs` | actions | write | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}/timing` | actions | read | prefer `githana_run` |
| `GET /repos/{owner}/{repo}/actions/workflows` | actions | read | prefer `githana_workflow` |
| `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}` | actions | read | prefer `githana_workflow` |
| `PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable` | actions | write | prefer `githana_workflow` |
| `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` | actions | write | prefer `githana_workflow` |
| `PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable` | actions | write | prefer `githana_workflow` |
| `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs` | actions | read | prefer `githana_workflow` |
| `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/timing` | actions | read | prefer `githana_workflow` |
