# `githana_api` — pulls

35 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/pulls` | pull_requests | read | prefer `githana_pr` |
| `POST /repos/{owner}/{repo}/pulls` | pull_requests | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/pulls/{pull_number}` | contents or pull_requests | read | prefer `githana_pr` |
| `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` | pull_requests | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments` | pull_requests | read | prefer `githana_pr` |
| `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments` | pull_requests | write | prefer `githana_pr` |
| `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies` | pull_requests | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/pulls/{pull_number}/commits` | pull_requests | read | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/pulls/{pull_number}/files` | pull_requests | read | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/pulls/{pull_number}/merge` | pull_requests | read | prefer `githana_pr` |
| `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` | contents | write | prefer `githana_pr` |
| `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async` | contents | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/pulls/{pull_number}/merge-async/{uuid}` | contents | write | prefer `githana_pr` |
| `DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers` | pull_requests | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers` | pull_requests | read | prefer `githana_pr` |
| `POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers` | pull_requests | write | prefer `githana_pr` |
| `POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers/rerequest` | pull_requests | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` | pull_requests | read | prefer `githana_pr` |
| `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` | pull_requests | write | prefer `githana_pr` |
| `DELETE /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}` | pull_requests | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}` | pull_requests | read | prefer `githana_pr` |
| `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}` | pull_requests | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments` | pull_requests | read | prefer `githana_pr` |
| `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals` | pull_requests | write | prefer `githana_pr` |
| `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events` | pull_requests | write | prefer `githana_pr` |
| `PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch` | pull_requests | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/pulls/comments` | pull_requests | read | prefer `githana_pr` |
| `DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}` | pull_requests | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/pulls/comments/{comment_id}` | pull_requests | read | prefer `githana_pr` |
| `PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}` | pull_requests | write | prefer `githana_pr` |
| `GET /repos/{owner}/{repo}/stacks` | pull_requests | read |  |
| `POST /repos/{owner}/{repo}/stacks` | pull_requests | write |  |
| `GET /repos/{owner}/{repo}/stacks/{stack_number}` | pull_requests | read |  |
| `POST /repos/{owner}/{repo}/stacks/{stack_number}/add` | pull_requests | write |  |
| `POST /repos/{owner}/{repo}/stacks/{stack_number}/unstack` | pull_requests | write |  |
