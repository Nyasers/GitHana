# `githana_api` — secret-scanning

1 endpoint reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `POST /repos/{owner}/{repo}/secret-scanning/push-protection-bypasses` | contents | write |  |
