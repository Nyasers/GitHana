# `githana_api` — issues

58 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/assignees` | issues or pull_requests | read |  |
| `GET /repos/{owner}/{repo}/assignees/{assignee}` | issues or pull_requests | read |  |
| `GET /repos/{owner}/{repo}/issues` | issues | read | prefer `githana_issue` |
| `POST /repos/{owner}/{repo}/issues` | issues | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}` | issues | read | prefer `githana_issue` |
| `PATCH /repos/{owner}/{repo}/issues/{issue_number}` | issues or pull_requests | write | prefer `githana_issue` |
| `DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees` | issues or pull_requests | write | prefer `githana_issue` |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/assignees` | issues or pull_requests | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/assignees/{assignee}` | issues or pull_requests | read | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/comments` | issues or pull_requests | read | prefer `githana_issue` |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` | issues or pull_requests | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` | issues | read | prefer `githana_issue` |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` | issues | write | prefer `githana_issue` |
| `DELETE /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by/{issue_id}` | issues | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking` | issues | read | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/events` | issues or pull_requests | read | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values` | issues | read | prefer `githana_issue` |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values` | issues or pull_requests | write | prefer `githana_issue` |
| `PUT /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values` | issues or pull_requests | write | prefer `githana_issue` |
| `DELETE /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values/{issue_field_id}` | issues or pull_requests | write | prefer `githana_issue` |
| `DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels` | issues or pull_requests | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/labels` | issues or pull_requests | read | prefer `githana_issue` |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/labels` | issues or pull_requests | write | prefer `githana_issue` |
| `PUT /repos/{owner}/{repo}/issues/{issue_number}/labels` | issues or pull_requests | write | prefer `githana_issue` |
| `DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}` | issues or pull_requests | write | prefer `githana_issue` |
| `DELETE /repos/{owner}/{repo}/issues/{issue_number}/lock` | issues or pull_requests | write | prefer `githana_issue` |
| `PUT /repos/{owner}/{repo}/issues/{issue_number}/lock` | issues or pull_requests | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/parent` | issues | read | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/relates_to` | issues | read | prefer `githana_issue` |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/relates_to` | issues | write | prefer `githana_issue` |
| `DELETE /repos/{owner}/{repo}/issues/{issue_number}/relates_to/{issue_id}` | issues | write | prefer `githana_issue` |
| `DELETE /repos/{owner}/{repo}/issues/{issue_number}/sub_issue` | issues | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` | issues | read | prefer `githana_issue` |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` | issues | write | prefer `githana_issue` |
| `PATCH /repos/{owner}/{repo}/issues/{issue_number}/sub_issues/priority` | issues | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/suggestions` | issues or pull_requests | read | prefer `githana_issue` |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/suggestions/{suggestion_id}/approve` | issues or pull_requests | write | prefer `githana_issue` |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/suggestions/{suggestion_id}/dismiss` | issues or pull_requests | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/timeline` | issues or pull_requests | read | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/comments` | issues or pull_requests | read | prefer `githana_issue` |
| `DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}` | issues or pull_requests | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/comments/{comment_id}` | issues or pull_requests | read | prefer `githana_issue` |
| `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` | issues or pull_requests | write | prefer `githana_issue` |
| `DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/pin` | issues | write | prefer `githana_issue` |
| `PUT /repos/{owner}/{repo}/issues/comments/{comment_id}/pin` | issues | write | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/events` | issues | read | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/issues/events/{event_id}` | issues or pull_requests | read | prefer `githana_issue` |
| `GET /repos/{owner}/{repo}/labels` | issues or pull_requests | read | prefer `githana_label` |
| `POST /repos/{owner}/{repo}/labels` | issues or pull_requests | write | prefer `githana_label` |
| `DELETE /repos/{owner}/{repo}/labels/{name}` | issues or pull_requests | write | prefer `githana_label` |
| `GET /repos/{owner}/{repo}/labels/{name}` | issues or pull_requests | read | prefer `githana_label` |
| `PATCH /repos/{owner}/{repo}/labels/{name}` | issues or pull_requests | write | prefer `githana_label` |
| `GET /repos/{owner}/{repo}/milestones` | issues or pull_requests | read |  |
| `POST /repos/{owner}/{repo}/milestones` | issues or pull_requests | write |  |
| `DELETE /repos/{owner}/{repo}/milestones/{milestone_number}` | issues or pull_requests | write |  |
| `GET /repos/{owner}/{repo}/milestones/{milestone_number}` | issues or pull_requests | read |  |
| `PATCH /repos/{owner}/{repo}/milestones/{milestone_number}` | issues or pull_requests | write |  |
| `GET /repos/{owner}/{repo}/milestones/{milestone_number}/labels` | issues or pull_requests | read |  |
