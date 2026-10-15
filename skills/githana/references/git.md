# `githana_api` — git

13 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `POST /repos/{owner}/{repo}/git/blobs` | contents | write |  |
| `GET /repos/{owner}/{repo}/git/blobs/{file_sha}` | contents | read |  |
| `POST /repos/{owner}/{repo}/git/commits` | contents | write |  |
| `GET /repos/{owner}/{repo}/git/commits/{commit_sha}` | contents | read |  |
| `GET /repos/{owner}/{repo}/git/matching-refs/{ref}` | contents | read |  |
| `GET /repos/{owner}/{repo}/git/ref/{ref}` | contents | read |  |
| `POST /repos/{owner}/{repo}/git/refs` | contents or workflows | write |  |
| `DELETE /repos/{owner}/{repo}/git/refs/{ref}` | contents | write |  |
| `PATCH /repos/{owner}/{repo}/git/refs/{ref}` | contents or workflows | write |  |
| `POST /repos/{owner}/{repo}/git/tags` | contents | write |  |
| `GET /repos/{owner}/{repo}/git/tags/{tag_sha}` | contents | read |  |
| `POST /repos/{owner}/{repo}/git/trees` | contents | write |  |
| `GET /repos/{owner}/{repo}/git/trees/{tree_sha}` | contents | read |  |
