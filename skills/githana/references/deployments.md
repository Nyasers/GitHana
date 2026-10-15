# `githana_api` — deployments

6 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/environments` | actions | read |  |
| `GET /repos/{owner}/{repo}/environments/{environment_name}` | actions | read |  |
| `GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules` | actions | read |  |
| `GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/{protection_rule_id}` | actions | read |  |
| `GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies` | actions | read |  |
| `GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}` | actions | read |  |
