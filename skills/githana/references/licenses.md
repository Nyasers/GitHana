# `githana_api` — licenses

1 endpoint reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/license` | metadata | read |  |
