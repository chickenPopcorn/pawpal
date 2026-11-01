# Deployment

[← Back to the README](../README.md)

The production output is the static `dist/` directory. GitHub Pages deployment is
prepared for **https://piano.pollos.us/**: the Pages workflow validates and deploys
pushes to `main`, and Cloudflare supplies the subdomain’s DNS record. See
[the GitHub Pages setup](github-pages.md) for the one-time repository settings,
exact DNS record, HTTPS and verification steps. **Deployment is pending**; these
changes do not enable Pages or update DNS on their own.

The build reads the two Supabase values from the repository's GitHub Actions
variables; see [Supabase setup](accounts.md#supabase-setup).

The separate checks workflow still uploads `dist/` and `.openai/hosting.json` as a
`cadence-static` artifact. That manifest remains available for ChatGPT Sites;
the earlier Sites registration attempt returned `Project owner is not linked to
an account`, with no deployed URL.

## Merge queue for `main`

The `project main` ruleset requires `test-and-build` (the checks workflow) and
`Codex review gate` (a commit status from the Codex review gate workflow). Both
also report on a merge queue's merge commits. The checks workflow runs on
`merge_group`, and skips push runs on the queue's `gh-readonly-queue/*`
branches, which would repeat it. A pull request joins the queue only after its
own Codex review gate passed. The gate can change while the pull request waits,
so `codex-merge-group.yml` reads the pull request's gate again when the queue
builds its merge commit and copies that state there; anything but success drops
it from the queue. A review requested after that read can still finish after
the merge, so take a pull request out of the queue before asking for another
review. That workflow runs on `merge_group` only. A job skipped on pull
requests would leave a check run on the pull request that could stand in for
the real gate.

The queue is not enabled yet. Merge these workflows into `main` first, then a
repository admin turns it on:

1. Open **Settings → Rules → Rulesets → project main**.
2. Turn on **Require merge queue**. Choose **Squash** as the merge method, as
   the history uses, and keep **Only merge non-failing pull requests** on. The
   other defaults work; the status check timeout (60 minutes) leaves room for
   the `e2e` job's 20-minute limit.
3. Under **Require status checks to pass**, keep `test-and-build` and
   `Codex review gate`. Add `e2e`, from the E2E tests workflow
   (`.github/workflows/e2e.yml`), with GitHub Actions as its source. Add it
   only once that workflow is on `main`, or the queue waits for a check that
   never runs. On pull requests the `e2e` job is skipped, which lets them into
   the queue; the browser suite then runs on the queue's merge commit.
4. Save the ruleset. Pull requests then show **Merge when ready**, which adds
   them to the queue.

## Security review receipts

Some Codex Security Review runs complete with blank findings flags in the
summary and publish their explicit result as a PR conversation comment. The
gate accepts the known “no security issues” receipt only from the verified
Codex app, within the current security run's recorded time window. GitHub must
resolve the receipt's abbreviated commit to the exact PR head, and every Codex
finding thread must be resolved. Missing, edited, stale, contradictory or
unrecognized receipts do not pass. A completed review alone is insufficient.

Webhook runs always execute the gate from the default branch. For a reviewed
gate repair that needs to run before it can merge, a maintainer can manually
dispatch `codex-review-gate.yml` on the repair branch, with
`pull_request_number` set to its PR. Only this explicit dispatch uses the
selected workflow revision, pinned to `github.sha`; webhook events never run
PR code with permission to publish statuses. Check the selected revision and
its tests before dispatching.

## Verification

See [the verification record](verification.md) for checks run, limitations, and
the local hardware acceptance procedure.

Local Chrome verification confirmed automatic connection to the available USB MIDI
input after refresh, fullscreen autoplay, score seeking and the bear-paw guide.
This does not establish end-to-end physical-key timing or published-origin MIDI
compatibility. See the verification document for that distinction.
