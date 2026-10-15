# `githana_api` — releases

12 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/releases` | contents | read | prefer `githana_release` |
| `POST /repos/{owner}/{repo}/releases` | contents or workflows | write | prefer `githana_release` |
| `DELETE /repos/{owner}/{repo}/releases/{release_id}` | contents | write | prefer `githana_release` |
| `GET /repos/{owner}/{repo}/releases/{release_id}` | contents | read | prefer `githana_release` |
| `PATCH /repos/{owner}/{repo}/releases/{release_id}` | contents or workflows | write | prefer `githana_release` |
| `GET /repos/{owner}/{repo}/releases/{release_id}/assets` | contents | read | prefer `githana_release` |
| `DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}` | contents | write | prefer `githana_release` |
| `GET /repos/{owner}/{repo}/releases/assets/{asset_id}` | contents | read | prefer `githana_release` |
| `PATCH /repos/{owner}/{repo}/releases/assets/{asset_id}` | contents | write | prefer `githana_release` |
| `POST /repos/{owner}/{repo}/releases/generate-notes` | contents | write | prefer `githana_release` |
| `GET /repos/{owner}/{repo}/releases/latest` | contents | read | prefer `githana_release` |
| `GET /repos/{owner}/{repo}/releases/tags/{tag}` | contents | read | prefer `githana_release` |
