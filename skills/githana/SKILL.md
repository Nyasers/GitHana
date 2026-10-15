---
name: githana
description: "GitHana: local git and GitHub operations. Read before any githana_git / githana_repo / githana_pr / githana_issue / githana_release / githana_run / githana_workflow / githana_cache / githana_label / githana_api call — per-action parameters, when to use each action, examples, the capability boundary with its escape hatch, and the permission gaps."
---

# githana: usage manual

GitHana is an **App-shaped implementation of the gh CLI**: `gh <group> <verb>` corresponds to
`githana_<group>(action="<verb>")`, and `--flag` corresponds to that action's parameter; `gh auth` /
`gh config` are taken over by the settings page, and TTY interaction is taken over by the approval
card. The tool surface is split by **gh's groups** into ten noun tools — each tool has its own
parameter table.

## Tool surface

| Tool | Permission tier | Verbs |
|---|---|---|
| `githana_git` | `external_side_effect` (approval required) | `exec` · `commit` · `push` |
| `githana_repo` | `external_side_effect` | `create` · `list` · `view` · `clone` · `fork` · `sync` · `gitignore` · `license` · `read-dir` · `read-file` |
| `githana_pr` | `external_side_effect` | `create` · `list` · `view` · `status` · `diff` · `checks` · `ready` · `merge` · `review` · `comment` · `close` · `reopen` · `revert` · `edit` · `checkout` · `lock` · `unlock` · `update-branch` |
| `githana_issue` | `external_side_effect` | `create` · `list` · `view` · `status` · `edit` · `comment` · `close` · `reopen` · `delete` · `develop` · `transfer` · `lock` · `unlock` · `pin` · `unpin` |
| `githana_release` | `external_side_effect` | `create` · `list` · `view` · `edit` · `delete` · `upload` · `download` · `delete-asset` · `verify` · `verify-asset` |
| `githana_run` | `external_side_effect` | `list` · `view` · `watch` · `rerun` · `cancel` · `delete` · `download` |
| `githana_workflow` | `external_side_effect` | `list` · `view` · `run` · `enable` · `disable` |
| `githana_cache` | `external_side_effect` | `list` · `delete` |
| `githana_label` | `external_side_effect` | `clone` · `create` · `edit` · `delete` · `list` |
| `githana_api` | `external_side_effect` | single verb, **takes no `action`**, `path` required |

`githana_git` is **not** a gh group; it is our own tool (local git; gh never handles local commits).
`githana_api` is the escape hatch (the counterpart of `gh api`, which gh keeps for itself too).

The call shape is "tool name + action + that action's parameters":

```jsonc
{ "action": "status", "repo": "liliMozi/openhanako", "prNumber": 21 }        // githana_pr
{ "action": "commit", "cwd": "E:\\workspace\\my-repo", "message": "…" }      // githana_git
{ "path": "/user/repos?per_page=50", "paginate": true }                      // githana_api (no action)
```

`action` is declared only on tools with ≥ 2 verbs; for `githana_api` only `path` is required.

## Per action: when to use it

The tool surface is re-read in every new context, and there are no accumulated habits to rely on —
so what each verb gets here is the **basis for choosing a value** (not a restatement of the
parameter list). Parameter shapes are whatever the tool's own `parameters` say.

### githana_git (local git)

| action | When to use | Key parameters |
|---|---|---|
| `exec` | Passthrough for any git subcommand: local operations the common verbs do not cover (`pull` / `stash` / `checkout -b` / `show` / `log --stat`). **It appends no signature**, pure passthrough | `cwd` required; `args` required (array, no shell interpolation) |
| `commit` | Whenever a commit is to be produced, **always go through it** (`exec` appends no Co-authored-by). Automatic CoA + OpenPGP signing | `cwd` required; `message` required (via stdin, multi-line/Chinese text preserved losslessly); `paths` / `amend` / `allowEmpty` |
| `push` | When local commits are to be sent to the remote. Authenticates with the App token when logged in (see "Remote credentials" below) | `cwd` required; `branch` / `remote` / `setUpstream` / `force` / `dryRun` |

The dividing line between `commit` and `exec` is **signature governance**: to get CoA and signing use
`commit`, to get git's raw behaviour use `exec`. Read-only details such as `git diff` also go through
`exec` (`commit` carries no diff output).

### githana_repo (repositories)

| action | When to use | Key parameters |
|---|---|---|
| `view` | Look at the metadata of **one known repository** (default branch, visibility, fork relationship). Use it to derive the repository from the current directory | `repo` or `cwd` |
| `list` | **Find** repositories / list a batch (your own, or a given owner's). When you want to know "what exists" rather than "what this one is" | `owner` / `visibility` / `limit`; **does not accept `repo`** |
| `create` | Create a new repository (**only under the currently logged-in account**). Creating repositories under an organization is outside the capability surface, see "Capability boundary and escape hatch" | `name` required; `private` / `autoInit` / `gitignore` / `license` / `homepage` / `description` |
| `clone` | When the repository is to **land on local disk** (the only way to produce "a local repository you can keep committing / pushing from"). Note that `cwd` here is the **parent directory** | `repo` required (not inferred); `cwd` required; `directory` / `branch` / `depth` |
| `fork` | Fork someone else's repository into **your own account**. Forking into an organization is outside the capability surface | `repo` or `cwd`; `name` / `defaultBranchOnly` |
| `sync` | Align a fork with upstream (local `fetch` + merge). **Touches only the local clone, does not push** — you still need `push` afterwards | `cwd` required; `branch` / `strategy` (`merge` / `ff-only` / `rebase`) / `remote` |
| `gitignore` | Look up `.gitignore` template names before creating a repository (without `template` it lists all names; with it, it shows that template's body) | `template` optional; no other keys accepted |
| `license` | Look up license template keys before creating a repository (the `license` parameter of `create` takes a value from here, e.g. `mit`) | `full` (by default lists only the three columns key / name / SPDX ID; `true` prints the full response); `timeoutSec` |
| `read-dir` | Read the file listing of a directory in a **remote** repository (no need to clone first) | `repo` or `cwd`; `path` / `ref` |
| `read-file` | Read the body of a file in a **remote** repository (no need to clone first) | `repo` or `cwd`; `path` required; `ref` |

`view` / `list` are often confused: **use `list` to find, `view` to look**. `list` does not accept
`repo` (what it lists is a set), while `view` needs one specific repository. The dividing line between
`read-dir` / `read-file` and `clone` is **whether you need a local copy**: to read content only use
the former, to change code use the latter.

### githana_pr (Pull Requests)

| action | When to use | Key parameters |
|---|---|---|
| `view` | **Look at** one PR's details (including reviews): when you need the body, review state, merge state | `prNumber` (default = the PR associated with the current branch, in which case `cwd` is needed) |
| `list` | **Find** PRs: list a batch filtered by state, when you do not know the number yet | `state` / `limit`; does not accept `prNumber` |
| `status` | PR **status at a glance** (including review and check counts): when you only want a one-line conclusion, not the body | `prNumber` may be omitted |
| `diff` | When you need the **patch body** (what changed) | `prNumber`; `format` (`diff` / `patch`) |
| `checks` | Only the **CI check** status (no code, no reviews) | `prNumber` may be omitted |
| `create` | Open a new PR. **Does not push the branch automatically**: if the head branch has not been pushed it reports an explicit error and points you to `push` first | `cwd` effectively required (used to take head and the default title); `base` defaults to the default branch; `title` / `body` / `draft` |
| `ready` | The **state-bit toggle** between draft PR ↔ ready for review (`undo=true` flips it back to a draft). Changing the title/body is not it | `prNumber`; `undo` |
| `merge` | Merge (**irreversible**). To abandon the changes use `close` | `prNumber` required; `method` (`merge` / `squash` / `rebase`); `deleteBranch` |
| `review` | Submit a **review verdict** (approve / request changes / leave comments), optionally with inline comments | `event` required; `body` (required for `request-changes`); `comments[]` |
| `comment` | Only **leave one comment** on the timeline (not a review verdict, does not affect reviewDecision) | `body` required |
| `close` | Close a PR (restorable with `reopen`). **Deletes neither the branch nor history** | `prNumber` may be omitted |
| `reopen` | Reopen a closed PR | `prNumber` may be omitted |
| `edit` | Change a PR's **metadata**: title / body / base branch / state bit | `title` / `body` / `base` / `state` — give at least one |
| `revert` | Revert a **merged** PR (local revert + new branch + open the revert PR). If it was never merged there is nothing to revert | `cwd` required; `prNumber` required; `branch` / `title` / `body` / `draft` / `remote` |
| `checkout` | **Fetch the PR's source branch to local and check it out** (when you need to change this PR's code on this machine) | `cwd` required; `prNumber` required; `branch` / `remote` / `force` |
| `lock` / `unlock` | Lock / unlock the conversation (blocks comments from non-collaborators) | `prNumber`; `lock` additionally has `reason` |
| `update-branch` | **Merge the base branch into the PR's source branch** (the equivalent of the "Update branch" button) | `prNumber`; `expectedHeadSha` (optimistic concurrency guard) |

Four easily confused dividing lines: **find `list` / look `view` / glance `status` / patch `diff`**.
To "wait for CI to reach a terminal state" use `githana_run(action="watch")`, not `checks` (the
latter reports only this moment).

### githana_issue (Issues)

| action | When to use | Key parameters |
|---|---|---|
| `view` | View an issue's details (including comments) | `issueNumber` required; `comments` |
| `list` | List issues (by default **excludes PRs**; for PRs use `githana_pr(action="list")`) | `state` / `labels` / `assignee` / `includePrs` / `limit` |
| `status` | Issue status at a glance (reports state only, does not fetch the body or comments) | `issueNumber` required |
| `create` | Create a new issue | `title` required; `body` / `labels` / `assignees` |
| `edit` | Change title / body / labels / assignees / milestone | `issueNumber` required; `labels` (whole replacement) is mutually exclusive with `addLabels` / `removeLabels` |
| `comment` | Add a comment to an issue | `body` required |
| `close` / `reopen` | Close / reopen (optionally with one explanatory comment attached; comments first, then changes the state) | `issueNumber`; `comment` |
| `delete` | Delete an issue (**irreversible**, requires `confirm=true`) | `issueNumber` required; `confirm` |
| `develop` | **Create a linked development branch** from the issue (branch name defaults to `<number>-<title-in-hyphenated-form>`) | `issueNumber` required; `name` / `base` |
| `transfer` | Transfer the issue to **another repository** | `issueNumber` required; `targetRepo` required |
| `lock` / `unlock` | Lock / unlock the conversation | `issueNumber`; `lock` additionally has `reason` |
| `pin` / `unpin` | Pin / unpin to the top of the repository | `issueNumber` required |

The dividing line between `comment` and `edit`: `comment` only appends to the timeline, while `edit`
changes the issue's own fields.

### githana_release (releases)

| action | When to use | Key parameters |
|---|---|---|
| `view` | View the details of **one** release (including the asset list) | `tag` defaults to the most recent release (excluding drafts/prereleases); or `releaseId` |
| `list` | List releases (by default **filters out drafts**; pass `includeDrafts=true` for drafts) | `limit` / `includeDrafts` |
| `create` | Create a release (if the tag does not exist, creates it from `target`) | `tag` required; `name` / `body` / `draft` / `prerelease` / `target` / `generateNotes` / `latest` |
| `edit` | Change only the **state bits**: `draft` / `prerelease` / `latest` (changing the title/body is not it) | give at least one state bit; `tag` or `releaseId` **must be named explicitly** |
| `delete` | Delete a release (**irreversible**, requires `confirm=true`; **does not delete the tag**) | `tag` required; `confirm` |
| `upload` | Upload a local file as a release asset (the last step of the release pipeline). **Streams bytes** to `uploads.github.com` | `tag` + `file` required (`file` must be an **absolute** path); `assetName` / `contentType` / `assetLabel` |
| `download` | **Fetch release assets to local disk**. By default fetches all assets of that release | `tag` required; `assetName` / `assetId`; `path` (single file) or `dir` (directory); `overwrite` |
| `delete-asset` | Delete one asset in a release (**irreversible**, requires `confirm=true`) | `tag` + `assetName` required |
| `verify` | Verify a release's **integrity**: the asset sha256 listing, optionally compared against local files | `tag` required; `files[]` |
| `verify-asset` | Verify **one** asset's digest (optionally compared against a local file) | `tag` + `assetName` required; `file` |

The `list` vs `view` trade-off is the same as for PRs: use `list` to enumerate a batch, `view` to look
at one. What `verify` checks is the **release's own integrity** (the `digest` GitHub records vs the
local sha256), **not** gh's "attestation" verification — that layer is out of reach (see "Capability
boundary and escape hatch").

### githana_run (Actions runs)

| action | When to use | Key parameters |
|---|---|---|
| `view` | View a run's details **at this moment** (including each job's status). To "wait for it to finish" use `watch` | `runId` or `branch`; `job` (filter by name) |
| `list` | List runs (filter by branch / status / workflow / actor) | `branch` / `workflow` / `actor` / `limit` |
| `watch` | When you need to **wait for CI to reach a terminal state** and get the conclusion. **Returns a background task handle, not the conclusion** | `runId` or `branch`; `intervalSec` / `watchSec` |
| `rerun` | Re-run (`failedOnly=true` re-runs only the failed jobs) | `runId` or `branch`; `failedOnly` / `debugLogging` |
| `cancel` | Cancel an in-progress run (best effort) | `runId` or `branch` |
| `delete` | Delete a run record (**irreversible**, requires `confirm=true`) | `runId` **required** (no "most recent one" default accepted); `confirm` |
| `download` | **Fetch a run's logs / artifacts to local disk** (zip byte stream, streamed to disk) | `runId` or `branch`; `what` (`logs` / `artifacts`) / `artifactName`; `path` or `dir`; `overwrite` |

The dividing line between `view` and `watch` is **whether you need to wait**: `view` reports this
moment (to get an update, just look again yourself), while `watch` reports the conclusion at the
moment of the terminal state and does not occupy the caller's turn. For details on `watch`, see
"Three verbs with unusual shapes" below.

### githana_workflow (workflows)

| action | When to use | Key parameters |
|---|---|---|
| `list` | List the repository's workflows (disabled ones included by default; pass `enabledOnly=true` for enabled only) | `enabledOnly` / `limit` |
| `view` | View **one** workflow's definition (without the YAML body) | `workflow` required (numeric ID or file name) |
| `run` | **Trigger manually** (`workflow_dispatch`). Triggers synchronously and **does not wait for CI** (to wait, follow up with `githana_run(action="watch")`) | `workflow` required; `ref` |
| `enable` | Enable (restores its natural triggers) | `workflow` required |
| `disable` | Disable (blocks natural triggers, **does not block a manual dispatch**) | `workflow` required |

The dividing line between `workflow run` and `run rerun`: the former starts a new one by **workflow**,
the latter goes again by **an existing run number**.

### githana_cache (build caches)

| action | When to use | Key parameters |
|---|---|---|
| `list` | See which caches a repository has (filter by key / ref, sort by size or time — usually to free up quota) | `key` / `ref` / `sort` / `direction` / `limit` |
| `delete` | Delete caches: one entry by `id`, or a whole family by `key` (+`ref`) | `id` or `key`; by key without `ref` requires `confirm=true` |

### githana_label (labels)

| action | When to use | Key parameters |
|---|---|---|
| `list` | List the repository's labels (to get the exact names; other verbs reference labels by name) | `limit` |
| `create` | Create a label (an existing name returns 422) | `name` required; `color` / `description` |
| `edit` | Change an **existing** label (rename with `newName`) | `name` required (used to locate it); `newName` / `color` / `description` |
| `delete` | Delete a label (it is removed from every issue / PR that carries it; requires `confirm=true`) | `name` required; `confirm` |
| `clone` | Copy **another repository**'s whole label set over | `fromRepo` **required** (source); `repo` (target, defaults to what is inferred from cwd) |

### githana_api (escape hatch, single verb)

| When to use | Key parameters |
|---|---|
| Long-tail capabilities the typed verbs do not cover (see the endpoint tables in "Capability boundary and escape hatch"). **Do not fill in `action`** | `path` required (the path after api.github.com, with a leading slash); `method` (default `GET`); `body` (JSON, `POST` / `PATCH` / `PUT`); `repo` (replaces the `{owner}` / `{repo}` placeholders in `path`); `paginate` (follows Link pagination, capped at 10 pages) |

The query string goes directly into `path` (`/repos/o/r/issues?state=all&per_page=50`). It **does no
cwd inference**: `repo` is only used to replace placeholders. `POST /graphql` goes through the same
`path` (both GraphQL and REST are endpoints; the action picks internally by "which one can implement
it" and does not expose the channel difference to the outside).

**Which endpoint to hit — read `references/`.** `api` has no parameter surface of its own: you have
to know the path and the permission it needs. This skill's `references/` directory holds one file per
category, listing every endpoint this App's permission set can actually reach, with the supporting
permission and the action's read/write level:

| Read | When |
|---|---|
| `references/INDEX.md` | First stop: category → endpoint count → file name. |
| `references/<category>.md` | Before composing a call you are not sure about. Each file is small enough to read in one go, and marks entries that already have a typed verb (`prefer \`githana_pr\``) so you do not hand-roll a call the tool already covers. |

These files are generated from GitHub's official permission table filtered by this App's authorized
permissions (`node scripts/derive/index.mjs api-reference`). An endpoint **absent** from them needs a
permission this App does not declare, so `api` gets a 403 there — the absence is the answer, not an
oversight. The tables in "Capability boundary" below record the *gaps* (what is missing and what to
do instead); `references/` records the *reachable surface*.

## Three verbs with unusual shapes

These three have shapes different from the other verbs in their tools, and are easy to call wrong out
of habit, so they are spelled out separately.

### `githana_pr(action="ready")` — turn a draft PR ready (reversible)

```jsonc
{ "action": "ready", "repo": "liliMozi/openhanako", "prNumber": 42 }              // draft → ready for review
{ "action": "ready", "repo": "liliMozi/openhanako", "prNumber": 42, "undo": true } // ready for review → draft
```

- **Does not expose the channel difference**: internally it first does REST `GET /pulls/{n}` to get
  `node_id`, then sends a GraphQL mutation (`markPullRequestReadyForReview` /
  `convertPullRequestToDraft`). The reason is a measured fact: **un-drafting can only be done with
  GraphQL** — REST `PATCH /pulls/{n}` with `{draft:false}` returns 200 but `isDraft` is still `true`
  (silently has no effect), while `POST /pulls/{n}/ready_for_review` returns 404.
- **Idempotent**: if it is already in the target state it sends no mutation and honestly reports "it
  already was", rather than sending a request that is bound to be rejected.
- **When to use it**: use this when the draft is finished and you want someone to review it (`undo`
  default); use `undo=true` when it is finished but cannot be merged yet and should be hidden first.
  Use `edit` to change the title / body; merging is not it.
- Supporting permission `pull_requests: write`.

### `githana_release(action="edit")` — change a release's state bits

```jsonc
{ "action": "edit", "repo": "liliMozi/openhanako", "tag": "v1.3.0", "draft": false }        // draft → published
{ "action": "edit", "repo": "liliMozi/openhanako", "tag": "v1.3.0", "prerelease": true, "latest": "false" }
{ "action": "edit", "repo": "liliMozi/openhanako", "releaseId": 12345678, "latest": "legacy" }
```

- **`legacy` is not "unset latest"**: its literal meaning is "use the legacy algorithm to decide
  which release is latest" (REST's `make_latest` takes exactly these three values). Treating it as
  `false` would change the semantics.
- **One call needs at least one state bit**; giving none returns guidance rather than sending a
  request that is bound to 422.
- **There is no "most recent release" default**: changing state bits does not take dangerous
  defaults — you must name `tag` or `releaseId`.
- **Setting `latest=true` together with `draft` / `prerelease` is rejected on the spot**: GitHub does
  not accept a draft or prerelease as latest. Split it into two calls.
- **State bits only**: title / body / moving the tag are release **content** and go through
  `githana_api` hitting `PATCH /repos/{owner}/{repo}/releases/{id}` (the endpoint is on the
  capability surface).
- Supporting permission `contents: write`.

### `githana_run(action="watch")` — watch CI to a terminal state (**returns a handle, not a conclusion**)

```jsonc
{ "action": "watch", "repo": "liliMozi/openhanako", "runId": 1234567890 }
{ "action": "watch", "repo": "liliMozi/openhanako", "branch": "fix/x", "intervalSec": 30, "watchSec": 7200 }
```

- **What it returns is a task handle, not a CI conclusion.** The receipt gives `taskId` and the run
  state at this moment, and the call ends there; when CI reaches a terminal state the host posts the
  **conclusion back to this session's next input point** (the host background task's `next-step`
  slot). So do not end your turn in order to wait for it, and do not `watch` again after a while.
- **Why it cannot simply wait**: CI is measured in minutes, and holding the tool callback to wait
  would block the host channel (tool callbacks have a timeout). This verb therefore puts the
  "waiting" into a host background task: `ctx.tasks.create({ scope: "session",
  delivery: "next-step", chipVisibility: "show" })`. This path needs the manifest capability
  `app/tasks.manage`.
- **When the capability is not granted**: it returns a readable error that names the missing
  `app/tasks.manage` and gives an alternative (use `view` to see the state at this moment),
  **without spinning idle**.
- **Stopping it midway**: cancel it in the session's background task entry. Each poll first reads the
  host task record, and once the task is already terminal it stops fetching data and stops posting
  back.
- **Recovery after an App reload**: the watch coordinates are written into the host task record's
  `metadata.githana`, and after an App generation change the `apply` phase reattaches unfinished
  records with `ctx.tasks.list()`. This App **writes no private state file**.
- **Window elapsed without a terminal state**: at the end of the window the task settles as failed
  and gives the original text (`watch window elapsed`), explaining that this is not a CI failure and
  that to keep watching you call `watch` again.
- Supporting permission `actions: write` (polling only reads runs and jobs).

## The cwd convention

`cwd` is always the **absolute path of the repository** (e.g. `E:\\workspace\\my-repo`); there is no
implicit working-directory inference.

| Verb | cwd |
|---|---|
| `githana_git`'s `exec` / `commit` / `push` | **required** |
| `githana_repo`'s `clone` (**parent directory**) / `sync` | **required** |
| `githana_pr`'s `checkout` / `revert` | **required** (git operations are to be done locally) |
| `githana_pr`'s `create` | effectively required (head takes its current branch; the `title` default reads it too) |
| `githana_pr`'s `view` / `status` / `ready` etc. | optional, but required when you want the "PR associated with the current branch" default |
| the remaining GitHub verbs | optional (used only when `repo` was not passed, to infer the repository from the git remote) |
| `githana_api` | **not accepted**: it hits endpoints purely by `path`, and `repo` is only used to replace placeholders |

Repository context for GitHub actions: **an explicit `repo` (owner/repo) wins**; if not passed it is
inferred from the git remote at `cwd`; if neither is available → it reports an error with guidance
rather than guessing (`githana_api` excepted).

### Local paths: relative paths are meaningless here

`githana_release(action="upload" / "download")` and `githana_run(action="download")` take **local
paths**, and always require **absolute** paths (`C:\...` / `/...`):

| Parameter | Used on | Meaning |
|---|---|---|
| `file` | release `upload` | the local file to upload (**required**, absolute path) |
| `path` | release / run `download` | target **file** path (configures only one asset / artifact; mutually exclusive with `dir`, and `path` wins) |
| `dir` | release / run `download` | target **directory**; the file name is taken from the asset name (for run logs `run-<id>-logs.zip`, for artifacts `<artifact name>.zip`) |
| `overwrite` | release / run `download` | whether to overwrite when the target already exists (default **false = do not overwrite**; in that case it errors and tells you to rename or overwrite explicitly) |

When neither `path` nor `dir` is given it lands in **this process's current directory** (`gh release
download` also defaults to the current directory). But that directory is not necessarily within the
worker's writable range, so that failure is reported explicitly and asks you to give `dir`
explicitly — **where bytes can be written is the caller's call**, and the tool does not guess.

## Capability boundary and escape hatch

The tool surface's boundary is set by the **App permissions**: every typed verb has an authorized
permission supporting it. So everything "gh has but we do not" (no permission / no corresponding
semantics) is registered item by item below, in five tiers — **what is missing and how to work around
it can both be looked up here**, without having to learn by hitting walls. Tier four now records not
a gap but the **usage and boundaries of the binary channel** (its shape differs from other verbs: it
needs local paths, writes to disk, and has a hard per-file limit).

The escape hatch is `githana_api`: it hits `path` directly against `api.github.com`. **Endpoint
paths, parameters and response shapes follow the GitHub REST documentation**
(`https://docs.github.com/rest`) — the endpoints below are an index for locating things, not a
substitute for the contract. **Endpoints beyond the permission surface are rejected directly by
GitHub (403)**, and `api` passthrough does not get past that either.

**This section records the gaps; `references/` records the reachable surface.** Before composing an
`api` call, `references/INDEX.md` → `references/<category>.md` lists every endpoint the App's
permissions actually cover. The tiers below are what is *missing* and what to do instead.

### 1. Untyped: gh semantics exist, but we declare no tool for them (use `githana_api`)

| gh group | Main REST endpoints | Missing permission |
|---|---|---|
| `secret` | `PUT /repos/{o}/{r}/actions/secrets/{name}`, `GET …/actions/secrets` | `secrets: write` |
| `variable` | `POST/PATCH/DELETE /repos/{o}/{r}/actions/variables` | `actions_variables: write` |
| `ssh-key` | `GET/POST /user/keys`, `DELETE /user/keys/{id}` | `keys: write` (account) |
| `gist` | `GET/POST /gists`, `PATCH/DELETE /gists/{id}` | `gists: write` (account) |
| `codespace` | `GET/POST /user/codespaces`, `POST …/{name}/start` | `codespaces: write` |
| `webhook` | `GET/POST /repos/{o}/{r}/hooks`, `PATCH/DELETE …/hooks/{id}` | `repository_hooks: write` |
| `attestation` | `GET /repos/{o}/{r}/attestations/{subject_digest}` | `attestations: write` (the endpoint is still Preview) |
| `discussion` | GraphQL: `repository.discussions` (very little REST coverage) | `discussions` |
| `project` | GraphQL: `POST /graphql` (Projects V2) | `repository_projects` |
| `ruleset` | `GET/POST /repos/{o}/{r}/rulesets` | some need no permission (read-only works on public repositories) |
| `gpg-key` | `GET/POST /user/gpg_keys`, `DELETE /user/gpg_keys/{id}` | **yes** `gpg_keys: write` — but already taken over by a settings-page pipeline (see below) |
| `licenses` | `GET /licenses`, `GET /licenses/{license}` | none (public endpoint); already typed as `githana_repo(action="license")` |
| `org` | `GET /orgs/{org}`, `GET /orgs/{org}/repos` | organization permissions **0 items (never requested)** |
| `status` | `GET /repos/{o}/{r}/commits/{ref}/status` | `statuses` not authorized |

`gpg-key` is the only exception in this tier: **it has permissions but does not enter the tool
surface** — key generation and public-key publication are done by one settings-page pipeline
(generate = generate + upload, remove = delete remotely + clear locally), which is safer than
splitting them into verbs the model calls step by step. To look at / add a public key directly, use
the two endpoints above.

### 2. Verbs without permission: deleted from the zod definition (they are absent from the `action` candidates)

The authorized set contains **no** `administration`, so operations on the repository entity itself
are outside the capability surface. These verbs are **not** among `githana_repo`'s `action`
candidates (zod is the single source for both the model surface and runtime validation, so deleting
them makes them disappear from both at once), and calling them is therefore reported as
`unknown action` — that is deliberate: it saves a call that is bound to 403.

| gh verb | Which permission is missing | What to do now |
|---|---|---|
| `repo edit` (change description / visibility / default branch) | `administration: write` | Do it on the web; `githana_api` hitting `PATCH /repos/{o}/{r}` also gets 403 |
| `repo delete` / `rename` | `administration: write` | same as above (deleting a repository or renaming one cannot be done in this App) |
| `repo archive` / `unarchive` | `administration: write` | same as above |
| `repo set-default` / `autolink` / `deploy-key` | `administration: write` | same as above |
| `repo create --org <org>` | `administration: write` + organization permissions | can only create under the currently logged-in account (`POST /user/repos`) |
| `repo fork --org <org>` | organization permissions (0 items) | can only fork into the currently logged-in account |
| the organization form of `repo list` | organization permissions | use `owner="<org name>"` against `/users/{owner}/repos` (public repositories only) |

The **difference between this tier and tier one is the action**: tier one is "the tool does not
exist, use `api` to hit the endpoint"; this tier is "the tool exists, but that verb was deleted, so
hitting the endpoint with `api` gets 403". What the two tiers share is that the gaps are all written
down here rather than disguised as nonexistence.

### 3. Discarded: no corresponding remote semantics, or already taken over by the App shape (**not applicable**, no need to look)

| gh group | Why |
|---|---|
| `auth` · `config` | taken over by the settings page (login / signing identity / runtime environment) |
| `alias` | the verb table is fixed; there is no need for aliases |
| `completion` · `extension` · `preview` · `copilot` | gh CLI local-machine features, with no remote semantics |
| `browse` | opening a browser is the UI slot's business |
| `skill` | the Hana side has its own skill system |

### 4. Binary channel: **available** (the former "cannot fetch bytes" is gone)

Release asset upload / download and run download really do move bytes now. They are **no longer**
capability gaps — they are registered here to make clear **how this channel is used and where its
boundaries are**, because its shape differs from other verbs (it needs local paths, writes to disk,
and has a hard per-file limit).

| Tool | action | What it does | Key constraints |
|---|---|---|---|
| `githana_release` | `upload` | local file → `uploads.github.com`, **streamed**, returns 201 | `file` must be an **absolute** path; a single file must be **< 2 GiB** (over the limit it is rejected **before upload**, nothing is uploaded for nothing); an asset with the same name already existing returns 422 |
| `githana_release` | `download` | asset → local disk, **streamed writes** | when the target already exists it is **not overwritten** (unless `overwrite=true`); `path` configures only one asset at a time |
| `githana_run` | `download` | run logs (`what=logs`, one zip for the whole run) / artifacts (`what=artifacts`, one zip per artifact) → local disk | artifact zips 302 to `*.blob.core.windows.net` (already allowlisted); expired artifacts return no content |

```jsonc
// upload an artifact (tag required, file must be an absolute path)
{ "action": "upload", "repo": "o/r", "tag": "v1.2.0", "file": "E:\\build\\app.zip" }
// fetch it back: a single file goes through path, several go through dir
{ "action": "download", "repo": "o/r", "tag": "v1.2.0", "assetName": "app.zip", "path": "E:\\dl\\app.zip" }
{ "action": "download", "repo": "o/r", "tag": "v1.2.0", "dir": "E:\\dl" }        // all assets
{ "action": "download", "repo": "o/r", "runId": 123, "what": "logs", "dir": "E:\\dl" }
```

Mechanism (each item can be checked against the source):

1. **Binary request body**: the worker accepts the `file` (local path) form, uses
   `fs.createReadStream` as the fetch body and **explicitly sends `Content-Length`** — the file does
   not enter memory and chunked encoding is not used. The release asset endpoint wants a raw binary
   body (not multipart).
2. **Binary response body**: the worker accepts the `toFile` (local path) form, streams the response
   into that file, without UTF-8 decoding and without that 2MB bounded read. If it fails halfway (the
   network drops) it deletes the partial file and **does not pretend success**.
3. **Allowlist**: the outbound allowlist includes the upload endpoint `uploads.github.com`; the
   redirect allowlist includes `release-assets.githubusercontent.com` /
   `objects.githubusercontent.com`, plus the **suffix** `*.blob.core.windows.net` (Azure storage
   accounts sit in the subdomain position and cannot all be listed). Per-hop validation is unchanged,
   and **credentials are not carried along** after leaving `api.github.com`.
4. **Directory grants**: the worker is spawned by us, so the host's permission roots do not constrain
   it — but `rest.js` must add `--allow-fs-read` / `--allow-fs-write` for the paths this request
   names (by **directory**; node's flags only accept directories). So "which file gets sent /
   received" is the caller's call, and a wrong path is a readable failure, not a silent one.
5. **No chunks, no resumable transfer**: GitHub's asset API has no such semantics, and a retry is a
   resend. The < 2 GiB per-file cap cannot be worked around either (which is why over-limit is
   rejected before the request is sent).

**Large files need a large timeout**: `timeoutSec` defaults to 60 seconds (shared by all GitHub
actions), and uploads / downloads of hundreds of MB often do not finish in that window — they get
terminated, and **half the transfer has already happened** (a timeout does not roll back the remote
half). Give `timeoutSec` explicitly when sending / receiving large assets (max 600).

`githana_api` **does not move bytes**: its payload is JSON / text, and the binary in/out work is done
by the three verbs above.

> `githana_release`'s `verify` / `verify-asset` have a different scope from gh's same-named command —
> what they check is the **release's own integrity** (the `digest` GitHub records against the local
> file's sha256), whereas gh's "attestation" verification is not achievable: the `attestations`
> permission is not in the authorized set, and sigstore signature verification would need a signature
> verification implementation, which conflicts with "zero npm dependencies on the server side". For
> that layer use `gh attestation verify`.

### 5. Reserved slots: currently empty

`createSurface`'s `reserved` channel is still kept (`tools/lib/surface.js`), for the next time a verb
appears that is "recognizable, but whose parameter contract is not settled yet": putting such a value
into the candidates only gives the model a trial-and-error entry point, since it neither explains how
to use it nor returns anything but `not implemented`. The `ci_status` / `ci_watch` reserved slots on
the old `githana_read` / `githana` entry points were removed together with those two tools — CI is now
the three real verb groups `githana_run` / `githana_workflow` / `githana_cache`.

### Reference table: the authorized permissions (the five tiers above are checked against it)

8 repository items: `actions` / `checks` / `contents` / `issues` / `metadata` / `pull_requests` /
`repository_creation` / `workflows` (for write/read see spec D7); 1 account item: `gpg_keys`;
organization and enterprise are **0 items each**. **After the App's permissions are changed, existing
users must go through the device flow again** to get the new scopes — without re-authorizing, the new
verbs will 403.

## Remote credentials (git transport layer)

Git actions that access github.com (`push` / `fetch` / `pull` / `clone` / `ls-remote`) go through a
**git remote helper written by this App**; the remote-fetching actions inside `clone` / `sync` /
`pr checkout` / `pr revert` go through it too.

- **Two schemes**: the fetch side (`ls-remote` / `clone` / `fetch` / `pull`) uses `githana::`
  (`url.githana::.insteadOf`) and the helper advertises `stateless-connect`; the push side uses
  `githana-push::` (`url.githana-push::.pushInsteadOf` + `url.githana-push::.insteadOf`) and the
  helper advertises `connect`. **Both sides go through the helper**; neither is a native transport.
  These prefix rewrites are **injected only for the corresponding side per subcommand**: on push,
  `githana::` is not injected, otherwise a repository with an explicit `pushurl` would send the push
  to the fetch-side helper (which only does `stateless-connect git-upload-pack` and cannot push).
- **git hands the whole transport layer to `git-remote-githana`**, and the helper resolves the token
  from the App data directory itself and makes the HTTPS request itself. **git never touches the
  token** — the token does not enter the command line, the configuration visible via `git remote -v`,
  the isolated gitconfig, or **the git subprocess's env**. The wiring is in
  `tools/lib/remote-helper-shim.js` (per-subcommand selection of one side's prefix rewrites + `PATH`
  prefixing + appending `--allow-net` to `NODE_OPTIONS`, all going in and out together). So you can
  push/fetch even on another machine that has no credentials for that remote.
- The capabilities the helper advertises are **split per side**: the fetch side `stateless-connect`
  (that stdin/stdout is the native protocol pipe between git and the remote service; the App only
  moves bytes + adds `Authorization`, **one pipe handling both reading and writing**); the push side
  `connect` (stateful full duplex, so the packfile comes in on stdin — in practice, when advertising
  `push`, git never sends the packfile into the helper's stdin).
- The **injection scope** is the five subcommands above (the criterion is `remoteHelperSubcommand` in
  `tools/lib/remote-helper-shim.js`), and the command line carries none of the forms that can rewrite
  the runtime environment, such as `-c` / `--config-env` / `--exec-path` / `ext::`. When
  `githana_git(action="exec")` runs read-only commands (`status` / `log` / `diff` / `remote -v`)
  there is neither a token nor helper wiring.
- **When not logged in**: github.com remotes **do not fall back to system credentials** — the helper
  reports an explicit error and points you to "go to the settings page and click 'Sign in with
  GitHub'", **without failing silently**.
- **Remotes that are not github.com** (GitLab, self-hosted, ssh): the prefix rewrites match only
  github.com https URLs, so these remotes are entirely unaffected and go through git's native path
  with system credentials.
- A push carrying `.github/workflows/*` changes needs `workflows: write`. It is in the current
  authorized set and is **already in place**; if GitHub rejects it, that means the token was issued
  before that permission was added — log in again from the settings page.

## Error guidance

| Symptom | Meaning and what to do |
|---|---|
| `missing action` / `unknown action` | The error **lists this tool's available values**; it does not guess and does not fall back to a default branch |
| `… belongs to githana_x` | Cross-noun misrouting: that action lives on **another tool**, and the error names the tool you should use directly (when a same-named verb appears in several places they are all listed — pick by the object you want to act on) |
| `parameter validation failed (N issues)` | The parameter shape is wrong (extra keys, wrong type, out of enum range). What follows is **all** the issues, one per line in the form `field path [code] original English message` — fix them one by one by path and retry |
| `not implemented` | That action is a reserved slot (currently empty, see tier 5 of "Capability boundary and escape hatch") |
| `cannot create a background task: the host has not granted the app/tasks.manage capability` | `githana_run(action="watch")` needs the host's background task surface. Use `githana_run(action="view")` to see the state at this moment |
| `GitHub App authorization not completed` | Go to the GitHana settings page, click "Sign in with GitHub", and retry |
| `re-authorization required` | The last token refresh failed (the refresh_token expired or the authorization was revoked); re-authorize on the settings page |
| `the current directory is not a git repository` | `cwd` points to the wrong place, or the directory has not been `git init`-ed yet |
| `git committer identity is not configured` | First `git config user.name / user.email` (you can use `exec`) |
| `the remote rejected the fast-forward push` | Fetch and merge first, or use `push`'s `force=true` (`--force-with-lease`) to overwrite safely |
| Remote authentication failure | See "Remote credentials" above: for github.com remotes the App token is the only path, and when not logged in the helper gives sign-in guidance (**no fallback to system credentials**); only non-github remotes use system credentials |
| `the source branch … does not exist on the remote or has no new commits` | The branch has not been pushed yet: `githana_git(action="push")` first, then create the PR |
| `path must start with /` | `api`'s `path` is the path after api.github.com (with a leading slash) |
| `must be given an **absolute** path` | release `upload`'s `file` and release / run `download`'s `path` / `dir`: this path is used by the worker subprocess, whose working directory is not your repository, so a relative path would point somewhere else |
| `the target file already exists` | `download` does not overwrite existing files by default. To overwrite, pass `overwrite=true`, or use a different `path` / `dir` |
| `exceeds GitHub's per-file hard limit (< 2 GiB)` | It is rejected before upload, **so nothing is uploaded for nothing**. This is GitHub's hard limit and there is no chunking / resumption to work around it — split it into several smaller files, or trim the big parts first |
| `write to disk failed — <path>` | The worker cannot write to that location (parent directory missing / no write permission / the path is a directory). Pass a writable `dir` or `path` explicitly |
| GitHub 403 | You have crossed the App's permission surface: consult "Capability boundary and escape hatch" to see which permission that endpoint is missing, and do not retry |

> **Every action accepts only the fields it declares.** The parameter table is generated from the zod
> definition and runtime validation uses the same one, so passing an extra key that does not belong to
> that action is rejected on the spot (with the issues listed) rather than silently ignored.

## Other conventions

- Tokens and private keys **do not enter** tool return values, logs or settings-page echoes. GitHub
  requests are sent directly in a subprocess by the bundled REST worker, with the token passed to the
  worker over stdin; on the git side the token is read by the remote helper itself from
  `<dataDir>/credential.json` and DPAPI-decrypted — **it is not in the git subprocess's env** (nor in
  the command line or config files either). **Upload / download URLs contain no token either** —
  credentials go in the `Authorization` header.
- **The binary channel's reads and writes are done on the App's behalf by the worker**: at spawn time
  `rest.js` adds `--allow-fs-read` / `--allow-fs-write` for the paths this request names (**by
  directory**). So things the App process itself cannot read (asset files outside the permission
  roots) can still be sent / written to disk, and the allowed scope is exactly the directories the
  caller gave — not the whole disk. This **adds no manifest capability**; it is a node runtime flag
  (the same tier as `--allow-net`).
- This App requests `app/tools.expose-to-model`, `app/process.spawn` and `app/tasks.manage` (the last
  one for `githana_run(action="watch")`'s background task), and has **no** `network` declaration
  (that is a host-sent channel, where the token would cross IPC).
- GPG key generation and public-key viewing are **not on the tool surface**: generation is
  irreversible and is triggered only by the user clicking a button on the settings page.
