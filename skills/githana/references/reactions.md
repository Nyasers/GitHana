# `githana_api` — reactions

12 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/comments/{comment_id}/reactions` | metadata | read |  |
| `POST /repos/{owner}/{repo}/comments/{comment_id}/reactions` | contents | write |  |
| `DELETE /repos/{owner}/{repo}/comments/{comment_id}/reactions/{reaction_id}` | contents | write |  |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/reactions` | issues | read | prefer `githana_issue` |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/reactions` | issues | write | prefer `githana_issue` |
| `DELETE /repos/{owner}/{repo}/issues/{issue_number}/reactions/{reaction_id}` | issues | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions` | issues | read | prefer `githana_issue` |
| `POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions` | issues | write | prefer `githana_issue` |
| `DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}` | issues | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions` | pull_requests | read | prefer `githana_pr` |
| `POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions` | pull_requests | write | prefer `githana_pr` |
| `DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions/{reaction_id}` | pull_requests | write | prefer `githana_pr` |
