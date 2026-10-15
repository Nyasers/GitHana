# `githana_api` — migrations

8 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `DELETE /repos/{owner}/{repo}/import` | contents | write |  |
| `GET /repos/{owner}/{repo}/import` | contents | read |  |
| `PATCH /repos/{owner}/{repo}/import` | contents | write |  |
| `PUT /repos/{owner}/{repo}/import` | contents | write |  |
| `GET /repos/{owner}/{repo}/import/authors` | contents | read |  |
| `PATCH /repos/{owner}/{repo}/import/authors/{author_id}` | contents | write |  |
| `GET /repos/{owner}/{repo}/import/large_files` | contents | read |  |
| `PATCH /repos/{owner}/{repo}/import/lfs` | contents | write |  |
