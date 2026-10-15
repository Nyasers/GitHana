# `githana_api` — metrics

6 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/community/profile` | contents | read |  |
| `GET /repos/{owner}/{repo}/stats/code_frequency` | metadata | read |  |
| `GET /repos/{owner}/{repo}/stats/commit_activity` | metadata | read |  |
| `GET /repos/{owner}/{repo}/stats/contributors` | metadata | read |  |
| `GET /repos/{owner}/{repo}/stats/participation` | metadata | read |  |
| `GET /repos/{owner}/{repo}/stats/punch_card` | metadata | read |  |
