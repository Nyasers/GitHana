# `githana_api` — code-scanning

7 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `POST /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/autofix/commits` | contents | write |  |
| `GET /repos/{owner}/{repo}/code-scanning/codeql/databases` | contents | read |  |
| `DELETE /repos/{owner}/{repo}/code-scanning/codeql/databases/{language}` | contents | write |  |
| `GET /repos/{owner}/{repo}/code-scanning/codeql/databases/{language}` | contents | read |  |
| `POST /repos/{owner}/{repo}/code-scanning/codeql/variant-analyses` | contents | write |  |
| `GET /repos/{owner}/{repo}/code-scanning/codeql/variant-analyses/{codeql_variant_analysis_id}` | contents | read |  |
| `GET /repos/{owner}/{repo}/code-scanning/codeql/variant-analyses/{codeql_variant_analysis_id}/repos/{repo_owner}/{repo_name}` | contents | read |  |
