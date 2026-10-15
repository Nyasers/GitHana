# `githana_api` — branches

5 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/branches` | contents | read |  |
| `GET /repos/{owner}/{repo}/branches/{branch}` | contents | read |  |
| `POST /repos/{owner}/{repo}/branches/{branch}/rename` | contents | write |  |
| `POST /repos/{owner}/{repo}/merge-upstream` | contents | write |  |
| `POST /repos/{owner}/{repo}/merges` | contents | write |  |
