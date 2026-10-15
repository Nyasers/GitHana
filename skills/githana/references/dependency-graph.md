# `githana_api` — dependency-graph

5 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/dependency-graph/compare/{basehead}` | contents | read |  |
| `GET /repos/{owner}/{repo}/dependency-graph/sbom` | contents | read |  |
| `GET /repos/{owner}/{repo}/dependency-graph/sbom/fetch-report/{sbom_uuid}` | contents | read |  |
| `GET /repos/{owner}/{repo}/dependency-graph/sbom/generate-report` | contents | read |  |
| `POST /repos/{owner}/{repo}/dependency-graph/snapshots` | contents | write |  |
