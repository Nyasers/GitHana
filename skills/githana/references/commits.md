# `githana_api` — commits

11 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/comments` | metadata | read |  |
| `DELETE /repos/{owner}/{repo}/comments/{comment_id}` | contents | write |  |
| `GET /repos/{owner}/{repo}/comments/{comment_id}` | metadata | read |  |
| `PATCH /repos/{owner}/{repo}/comments/{comment_id}` | contents | write |  |
| `GET /repos/{owner}/{repo}/commits` | contents | read |  |
| `GET /repos/{owner}/{repo}/commits/{commit_sha}/branches-where-head` | contents | read |  |
| `GET /repos/{owner}/{repo}/commits/{commit_sha}/comments` | metadata | read |  |
| `POST /repos/{owner}/{repo}/commits/{commit_sha}/comments` | contents | read |  |
| `GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls` | pull_requests | read |  |
| `GET /repos/{owner}/{repo}/commits/{ref}` | contents | read |  |
| `GET /repos/{owner}/{repo}/compare/{basehead}` | contents | read |  |
