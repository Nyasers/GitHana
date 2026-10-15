# `githana_api` — repos

27 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /orgs/{org}/repos` | metadata | read |  |
| `GET /repos/{owner}/{repo}` | metadata | read |  |
| `GET /repos/{owner}/{repo}/activity` | contents | read |  |
| `GET /repos/{owner}/{repo}/codeowners/errors` | contents | read |  |
| `DELETE /repos/{owner}/{repo}/contents/{path}` | contents or workflows | write | prefer `githana_repo` |
| `GET /repos/{owner}/{repo}/contents/{path}` | contents | read | prefer `githana_repo` |
| `PUT /repos/{owner}/{repo}/contents/{path}` | contents or workflows | write | prefer `githana_repo` |
| `GET /repos/{owner}/{repo}/contributors` | metadata | read |  |
| `POST /repos/{owner}/{repo}/dispatches` | contents | write |  |
| `GET /repos/{owner}/{repo}/forks` | metadata | read | prefer `githana_repo` |
| `GET /repos/{owner}/{repo}/hash-algorithm` | metadata | read |  |
| `GET /repos/{owner}/{repo}/issue-types` | metadata | read |  |
| `GET /repos/{owner}/{repo}/languages` | metadata | read |  |
| `GET /repos/{owner}/{repo}/private-vulnerability-reporting` | metadata | read |  |
| `GET /repos/{owner}/{repo}/properties/values` | metadata | read |  |
| `GET /repos/{owner}/{repo}/readme` | contents | read |  |
| `GET /repos/{owner}/{repo}/readme/{dir}` | contents | read |  |
| `GET /repos/{owner}/{repo}/rules/branches/{branch}` | metadata | read |  |
| `GET /repos/{owner}/{repo}/rulesets` | metadata | read |  |
| `GET /repos/{owner}/{repo}/rulesets/{ruleset_id}` | metadata | read |  |
| `GET /repos/{owner}/{repo}/tags` | metadata | read |  |
| `GET /repos/{owner}/{repo}/tarball/{ref}` | contents | read |  |
| `GET /repos/{owner}/{repo}/topics` | metadata | read |  |
| `GET /repos/{owner}/{repo}/zipball/{ref}` | contents | read |  |
| `GET /repositories` | metadata | read |  |
| `GET /user/repos` | metadata | read | prefer `githana_repo` |
| `GET /users/{username}/repos` | metadata | read | prefer `githana_repo` |
