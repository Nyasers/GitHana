# `githana_api` — activity

5 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/events` | metadata | read |  |
| `GET /repos/{owner}/{repo}/stargazers` | contents | write |  |
| `GET /repos/{owner}/{repo}/stargazers/count` | metadata | read |  |
| `GET /repos/{owner}/{repo}/stargazers/history` | metadata | read |  |
| `GET /repos/{owner}/{repo}/subscribers` | contents | write |  |
