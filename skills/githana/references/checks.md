# `githana_api` — checks

12 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `POST /repos/{owner}/{repo}/check-runs` | checks | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/check-runs/{check_run_id}` | checks | read | prefer `githana_pr` |
| `PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}` | checks | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations` | checks | read | prefer `githana_pr` |
| `POST /repos/{owner}/{repo}/check-runs/{check_run_id}/rerequest` | checks | write | prefer `githana_pr` |
| `POST /repos/{owner}/{repo}/check-suites` | checks | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/check-suites/{check_suite_id}` | checks | read | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/check-suites/{check_suite_id}/check-runs` | checks | read | prefer `githana_pr` |
| `POST /repos/{owner}/{repo}/check-suites/{check_suite_id}/rerequest` | checks | write | prefer `githana_pr` |
| `PATCH /repos/{owner}/{repo}/check-suites/preferences` | checks | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` | checks | read |  |
| `GET /repos/{owner}/{repo}/commits/{ref}/check-suites` | checks | read |  |
