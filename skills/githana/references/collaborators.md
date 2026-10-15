# `githana_api` — collaborators

3 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/collaborators` | metadata | read |  |
| `GET /repos/{owner}/{repo}/collaborators/{username}` | metadata | read |  |
| `GET /repos/{owner}/{repo}/collaborators/{username}/permission` | metadata | read |  |
