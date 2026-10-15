# `githana_api` — users

4 endpoints reachable with this App's permission set.
Any endpoint outside this list needs a permission this App does not declare, so `api` gets a 403.

| Endpoint | Permission | Action | Notes |
|---|---|---|---|
| `GET /user/gpg_keys` | gpg_keys | read | prefer `settings page` |
| `POST /user/gpg_keys` | gpg_keys | write | prefer `settings page` |
| `DELETE /user/gpg_keys/{gpg_key_id}` | gpg_keys | write | prefer `settings page` |
| `GET /user/gpg_keys/{gpg_key_id}` | gpg_keys | read | prefer `settings page` |
