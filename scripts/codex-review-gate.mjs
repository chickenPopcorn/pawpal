// Run only from trusted default-branch code. This helper reads review metadata;
// it never checks out or executes a pull request's contents.
const STATUS_CONTEXT = "Codex review gate";
const CHECKPOINT_CONTEXT = "Codex review checkpoint";
const SUMMARY_MARKER = "<!-- codex-pull-request-review-summary -->";
const TRUSTED_BOT = {
  id: 199175422,
  login: "chatgpt-codex-connector[bot]",
  type: "Bot",
  appId: 1144995,
  appSlug: "chatgpt-codex-connector",
};
const FAILED_REVIEW_STATES = new Set([
  "error",
  "errored",
  "failed",
  "failure",
  "canceled",
  "cancelled",
  "timed_out",
]);
const REQUEST_ASSOCIATIONS = new Set(["OWNER", "COLLABORATOR", "MEMBER"]);
const REVIEW_LABELS = {
  code_review: "Code Review",
  security_review: "Security Review",
};

function timestamp(value) {
  // A known trigger with an unreadable date cannot be proved older than a review.
  return Date.parse(value) || Number.MAX_SAFE_INTEGER;
}

function* reviewCommands(body) {
  let fence;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        /^[ \t]*$/.test(marker[2])
      )
        fence = undefined;
      continue;
    }
    if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = marker[1];
      continue;
    }
    // Four-space or tab indentation denotes a literal code example.
    const command = line.match(
      /^ {0,3}@codex[ \t]+(security[ \t]+)?review(?:[ \t]|$)/i,
    );
    if (command) yield command;
  }
}

function requestBarriers(checkpoint, comments, events, context) {
  for (const event of events)
    if (event.event === "base_ref_changed")
      checkpoint.b = Math.max(checkpoint.b, timestamp(event.created_at));
  if (context.payload.changes?.base)
    checkpoint.b = Math.max(
      checkpoint.b,
      timestamp(context.payload.pull_request?.updated_at),
    );
  // Include the triggering comment as well: deletion or an eventually
  // consistent listComments response must not ignore a new review request.
  const comment = context.payload.comment;
  const previous = context.payload.changes?.body?.from;
  const candidates = [...comments, comment];
  if (comment && previous) candidates.push({ ...comment, body: previous });
  for (const comment of candidates.filter(Boolean)) {
    if (!REQUEST_ASSOCIATIONS.has(comment.author_association)) continue;
    for (const command of reviewCommands(comment.body)) {
      const at = timestamp(comment.updated_at ?? comment.created_at);
      // Repository policy runs Security Review alongside a requested Code Review.
      if (!command[1]) checkpoint.c = Math.max(checkpoint.c, at);
      checkpoint.s = Math.max(checkpoint.s, at);
    }
  }
}

function reviewTime(summary, kind) {
  // The structured v1 state has no completion timestamps. Read each review's
  // own timestamp from the trusted summary table, never comment.updated_at:
  // completing Security Review can update a table with an old Code Review.
  const rows = summary.body
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("|") && line.includes(`**${REVIEW_LABELS[kind]}**`),
    );
  if (rows.length !== 1) return 0;
  const times = [...rows[0].matchAll(/<relative-time\s+datetime="([^"]+)"/g)];
  return times.length === 1 ? Date.parse(times[0][1]) || 0 : 0;
}

function readCheckpoint(statuses, number) {
  const checkpoints = statuses
    .filter(
      (status) =>
        status.context === CHECKPOINT_CONTEXT &&
        status.state === "success" &&
        status.creator?.id === 41898282 &&
        status.creator?.login === "github-actions[bot]" &&
        status.creator?.type === "Bot",
    )
    .sort(
      (a, b) =>
        (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) ||
        b.id - a.id,
    );
  for (const status of checkpoints) {
    const checkpoint = JSON.parse(status.description);
    if (checkpoint.p !== number) continue;
    if (
      checkpoint.v !== 1 ||
      ["b", "c", "s", "rc", "rs"].some(
        (key) => !Number.isSafeInteger(checkpoint[key]) || checkpoint[key] < 0,
      )
    )
      throw new Error(
        "Unrecognized Codex review checkpoint; cannot verify freshness.",
      );
    return checkpoint;
  }
  return { v: 1, p: number, b: 0, c: 0, s: 0, rc: 0, rs: 0 };
}

function summaryState(summary) {
  if (!summary) return null;
  const markers = [
    ...summary.body.matchAll(
      /<!--\s*codex-review-state:v1\s+([\s\S]*?)\s*-->/g,
    ),
  ];
  if (markers.length !== 1) return null;
  try {
    const state = JSON.parse(markers[0][1]);
    return state && typeof state === "object" && !Array.isArray(state)
      ? state
      : null;
  } catch {
    return null;
  }
}

function acknowledgeStarts(checkpoint, summary, sha, context) {
  const candidates = [summary];
  const comment = context.payload.comment;
  const previousBody = context.payload.changes?.body?.from;
  // A completed edit may supersede the queued workflow for its Running edit.
  // GitHub's signed event includes that previous body, with the same bot identity.
  if (comment && previousBody && isTrustedSummary(comment)) {
    const previous = { ...comment, body: previousBody };
    if (isTrustedSummary(previous)) candidates.push(previous);
  }
  for (const candidate of candidates) {
    const state = summaryState(candidate);
    for (const [kind, key] of [
      ["code_review", "rc"],
      ["security_review", "rs"],
    ])
      if (
        state?.[kind]?.commit_sha === sha &&
        ["running", "in_progress"].includes(state[kind].status)
      )
        checkpoint[key] = Math.max(
          checkpoint[key],
          reviewTime(candidate, kind),
        );
  }
}

function pullRequestNumber(context) {
  const value =
    context.payload.pull_request?.number ??
    context.payload.issue?.number ??
    context.payload.inputs?.pull_request_number;
  const number =
    typeof value === "string" && /^[1-9]\d*$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error("A positive pull request number is required.");
  return number;
}

function isTrustedCodexComment(comment) {
  return (
    comment.user?.id === TRUSTED_BOT.id &&
    comment.user?.login === TRUSTED_BOT.login &&
    comment.user?.type === TRUSTED_BOT.type &&
    comment.performed_via_github_app?.id === TRUSTED_BOT.appId &&
    comment.performed_via_github_app?.slug === TRUSTED_BOT.appSlug &&
    typeof comment.body === "string"
  );
}

function isTrustedSummary(comment) {
  return (
    isTrustedCodexComment(comment) &&
    comment.body.trimStart().startsWith(SUMMARY_MARKER)
  );
}

function latestSummary(comments, context) {
  const byId = new Map(
    comments.filter(isTrustedSummary).map((comment) => [comment.id, comment]),
  );
  const current = context.payload.comment;
  if (context.payload.action === "deleted") byId.delete(current?.id);
  else if (current && isTrustedSummary(current)) {
    const listed = byId.get(current.id);
    // REST may lag the signed webhook, including same-second edits. Prefer
    // that event's current body on a tie, but never roll back a newer REST copy.
    if (
      !listed ||
      (Date.parse(current.updated_at) || 0) >=
        (Date.parse(listed.updated_at) || 0)
    )
      byId.set(current.id, current);
  }
  return [...byId.values()].sort((a, b) => {
    const updated =
      (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0);
    return updated || b.id - a.id;
  })[0];
}

function evaluateSummary(
  summary,
  sha,
  checkpoint,
  codeThreadsResolved = false,
  securityReceiptVerified = false,
) {
  const pending = {
    state: "pending",
    description: "Waiting for Code Review and Security Review on this commit.",
  };
  const state = summaryState(summary);
  if (!state) return pending;
  const kinds = Object.keys(REVIEW_LABELS);
  const reviews = kinds.map((kind) =>
    kind === "code_review" && codeThreadsResolved
      ? { ...state[kind], has_unresolved_findings: false }
      : kind === "security_review" && securityReceiptVerified
        ? { ...state[kind], has_unresolved_findings: false }
        : state[kind],
  );
  // An older clean result must never satisfy a newer commit or a split review.
  if (reviews.some((review) => !review || review.commit_sha !== sha))
    return pending;
  if (
    reviews.some(
      (review) =>
        FAILED_REVIEW_STATES.has(review.status) ||
        review.has_unresolved_findings === true,
    )
  )
    return {
      state: "failure",
      description: "Codex review failed or has unresolved findings.",
    };
  if (
    reviews.every(
      (review) =>
        review.status === "completed" &&
        review.has_unresolved_findings === false,
    ) &&
    kinds.every((kind) => {
      const isCode = kind === "code_review";
      const barrier = Math.max(checkpoint.b, checkpoint[isCode ? "c" : "s"]);
      const started = checkpoint[isCode ? "rc" : "rs"];
      // Completion after a retarget is insufficient: an older run can finish
      // later while reviewing the old diff. Require a fresh acknowledged start.
      // The connector exposes recorded Running times, not run creation or trigger IDs.
      return (
        !barrier || (started > barrier && reviewTime(summary, kind) >= started)
      );
    })
  )
    return {
      state: "success",
      description:
        "Code Review and Security Review completed with no unresolved findings.",
    };
  return pending;
}

function needsThreadResolution(
  summary,
  sha,
  checkpoint,
  securityReceiptVerified,
) {
  const state = summaryState(summary);
  const code = state?.code_review;
  const security = state?.security_review;
  return (
    code?.commit_sha === sha &&
    code.status === "completed" &&
    (code.has_any_findings === true || code.has_any_findings === null) &&
    code.has_unresolved_findings === null &&
    checkpoint.rc > 0 &&
    security?.commit_sha === sha &&
    security.status === "completed" &&
    (security.has_unresolved_findings === false || securityReceiptVerified) &&
    evaluateSummary(summary, sha, checkpoint, true, securityReceiptVerified)
      .state === "success"
  );
}

/**
 * Newer Security Review runs leave the summary's findings flags null and post
 * a clean receipt as an issue comment instead. Accept only the observed clean
 * receipt format, from the same app as the summary and within this run's
 * recorded start/completion window. Unknown formats remain pending.
 */
async function securityReceiptResolution(
  github,
  repo,
  number,
  sha,
  summary,
  checkpoint,
  comments,
) {
  const security = summaryState(summary)?.security_review;
  const started = checkpoint.rs;
  const completed = summary && reviewTime(summary, "security_review");
  if (
    security?.commit_sha !== sha ||
    security.status !== "completed" ||
    security.has_any_findings !== null ||
    security.has_unresolved_findings !== null ||
    !(started > 0) ||
    started <= Math.max(checkpoint.b, checkpoint.s) ||
    !(completed >= started)
  )
    return undefined;

  // Take the latest Security Review receipt, not the latest *clean* one.
  // A newer, unknown result must not revive an older clean result.
  const receipts = comments.filter(
    (comment) =>
      isTrustedCodexComment(comment) &&
      comment.body.trimStart().startsWith("<!-- codex-review-receipt:v1 -->") &&
      /^### 🛡️ Codex Security Review\s*$/m.test(comment.body),
  );
  for (const receipt of receipts) {
    if (
      !Number.isSafeInteger(receipt.id) ||
      receipt.id <= 0 ||
      !Date.parse(receipt.created_at) ||
      !Date.parse(receipt.updated_at)
    )
      throw new Error("Incomplete Security Review receipt metadata.");
  }
  receipts.sort(
    (a, b) =>
      Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id,
  );
  const receipt = receipts[0];
  if (!receipt) return "pending";
  const created = Date.parse(receipt.created_at);
  if (
    created < started ||
    created > completed ||
    receipt.updated_at !== receipt.created_at
  )
    return "pending";

  const lines = receipt.body
    .trim()
    .split("<details>")[0]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const commit = /^\*\*Reviewed commit:\*\* `([a-f0-9]{10,40})`$/.exec(
    lines[3] ?? "",
  );
  if (
    lines.length !== 6 ||
    lines[0] !== "<!-- codex-review-receipt:v1 -->" ||
    lines[1] !== "### 🛡️ Codex Security Review" ||
    lines[2] !==
      "Security review completed. No security issues were found in this pull request." ||
    !commit ||
    !/^\[View security finding report\]\(https:\/\/chatgpt\.com\/codex\/cloud\/tasks\/task_e_[A-Za-z0-9_-]+\)$/.test(
      lines[4],
    ) ||
    lines[5] !==
      "_Only the user who started this review can view the report in Codex._"
  )
    return "pending";

  // Never match an abbreviated SHA by prefix alone: GitHub must resolve it
  // unambiguously to this PR's full head SHA.
  const { data: reviewed } = await github.rest.repos.getCommit({
    ...repo,
    ref: commit[1],
  });
  if (typeof reviewed?.sha !== "string")
    throw new Error("Incomplete reviewed commit response.");
  if (reviewed.sha !== sha) return "pending";

  const query = `query securityReceiptThreads($owner:String!,$name:String!,$number:Int!,$cursor:String) {
    repository(owner:$owner,name:$name) {
      pullRequest(number:$number) {
        reviewThreads(first:100,after:$cursor) {
          nodes {
            isResolved
            comments(first:1) {
              nodes { author { __typename login ... on Bot { databaseId } } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;
  let cursor = null;
  const seen = new Set();
  do {
    const response = await github.graphql(query, {
      owner: repo.owner,
      name: repo.repo,
      number,
      cursor,
    });
    const threads = response?.repository?.pullRequest?.reviewThreads;
    if (
      (response?.errors &&
        (!Array.isArray(response.errors) || response.errors.length > 0)) ||
      !Array.isArray(threads?.nodes) ||
      typeof threads.pageInfo?.hasNextPage !== "boolean"
    )
      throw new Error("Incomplete Security Review thread response.");
    for (const thread of threads.nodes) {
      const roots = thread?.comments?.nodes;
      const author = roots?.[0]?.author;
      if (
        typeof thread?.isResolved !== "boolean" ||
        !Array.isArray(roots) ||
        roots.length !== 1 ||
        typeof author?.__typename !== "string" ||
        typeof author.login !== "string" ||
        (author.__typename === "Bot" &&
          !Number.isSafeInteger(author.databaseId))
      )
        throw new Error("Incomplete Security Review thread author.");
      if (isCodexActor(author) && !thread.isResolved) return "failure";
    }
    if (!threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
    if (typeof cursor !== "string" || !cursor || seen.has(cursor))
      throw new Error("Incomplete Security Review thread pagination.");
    seen.add(cursor);
  } while (true);
  return "success";
}

function isCodexActor(author) {
  return (
    author?.__typename === "Bot" &&
    author.databaseId === TRUSTED_BOT.id &&
    author.login === "chatgpt-codex-connector"
  );
}

async function latestCodexReceipt(github, repo, number, sha) {
  const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
    repository(owner:$owner,name:$name) {
      pullRequest(number:$number) {
        reviews(first:100,after:$cursor,author:"chatgpt-codex-connector[bot]",states:[COMMENTED,APPROVED,CHANGES_REQUESTED,DISMISSED]) {
          nodes {
            id databaseId submittedAt state body commit { oid }
            comments(first:1) { totalCount }
            author { __typename login ... on Bot { databaseId } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;
  let latest;
  let ambiguous = false;
  let cursor = null;
  const seen = new Set();
  do {
    const response = await github.graphql(query, {
      owner: repo.owner,
      name: repo.repo,
      number,
      cursor,
    });
    const reviews = response?.repository?.pullRequest?.reviews;
    if (
      (response?.errors &&
        (!Array.isArray(response.errors) || response.errors.length > 0)) ||
      !Array.isArray(reviews?.nodes) ||
      typeof reviews.pageInfo?.hasNextPage !== "boolean"
    )
      throw new Error("Incomplete GitHub review-receipt response.");
    for (const review of reviews.nodes) {
      if (
        typeof review?.id !== "string" ||
        !review.id ||
        !Number.isSafeInteger(review.databaseId) ||
        review.databaseId <= 0 ||
        !Number.isSafeInteger(review.comments?.totalCount) ||
        review.comments.totalCount < 0 ||
        typeof review.body !== "string" ||
        typeof review.state !== "string" ||
        typeof review.commit?.oid !== "string" ||
        typeof review.submittedAt !== "string" ||
        !Date.parse(review.submittedAt) ||
        typeof review.author?.__typename !== "string" ||
        typeof review.author.login !== "string" ||
        (review.author.__typename === "Bot" &&
          !Number.isSafeInteger(review.author.databaseId))
      )
        throw new Error("Incomplete GitHub review receipt.");
      if (
        isCodexActor(review.author) &&
        review.commit.oid === sha &&
        review.body.trimStart().startsWith("<!-- codex-review-receipt:v1 -->")
      ) {
        const at = Date.parse(review.submittedAt);
        if (!latest || at > Date.parse(latest.submittedAt)) {
          latest = review;
          ambiguous = false;
        } else if (
          at === Date.parse(latest.submittedAt) &&
          review.id !== latest.id
        )
          ambiguous = true;
      }
    }
    if (!reviews.pageInfo.hasNextPage) break;
    cursor = reviews.pageInfo.endCursor;
    if (typeof cursor !== "string" || !cursor || seen.has(cursor))
      throw new Error("Incomplete GitHub review-receipt pagination.");
    seen.add(cursor);
  } while (true);
  if (ambiguous) throw new Error("Ambiguous latest Codex review receipt.");
  return latest;
}

/**
 * How long after a Code Review completes GitHub's views can still be missing
 * the review it published. Only after this may the absence of a review count
 * as a clean run. Nothing triggers the gate again once it has passed, so a
 * run that is only waiting for it sleeps until then and checks once more.
 */
const SILENT_REVIEW_SETTLE_MS = 10 * 60 * 1000;

async function codexThreadResolution(
  github,
  repo,
  number,
  sha,
  started,
  completed,
  findingsRecorded,
) {
  const latest = await latestCodexReceipt(github, repo, number, sha);
  // A dismissal changes GitHub's review decision, not the Codex task's
  // completion. The summary is the completion authority; this receipt only
  // identifies its published findings, all of which still need resolution.
  const currentReview =
    latest &&
    ["COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(
      latest.state,
    ) &&
    Date.parse(latest.submittedAt) > started &&
    Date.parse(latest.submittedAt) <= completed
      ? latest
      : undefined;
  const expectedFindings = new Set();
  let commentsComplete = false;
  if (currentReview) {
    const comments = await github.paginate(
      github.rest.pulls.listCommentsForReview,
      {
        ...repo,
        pull_number: number,
        review_id: currentReview.databaseId,
        per_page: 100,
      },
    );
    if (!Array.isArray(comments))
      throw new Error("Incomplete GitHub review-comment response.");
    const ids = new Set();
    for (const comment of comments) {
      if (
        !Number.isSafeInteger(comment?.id) ||
        comment.id <= 0 ||
        ids.has(comment.id) ||
        typeof comment.body !== "string" ||
        !Number.isSafeInteger(comment.user?.id) ||
        comment.user.id <= 0 ||
        typeof comment.user.login !== "string" ||
        typeof comment.user.type !== "string" ||
        comment.pull_request_review_id !== currentReview.databaseId
      )
        throw new Error("Incomplete GitHub review comment.");
      ids.add(comment.id);
      if (
        comment.in_reply_to_id == null &&
        comment.user?.id === TRUSTED_BOT.id &&
        comment.user.login === TRUSTED_BOT.login &&
        comment.user.type === TRUSTED_BOT.type &&
        comment.body.includes("<!-- codex-code-review-finding:v1 -->")
      ) {
        if (comment.original_commit_id !== sha)
          throw new Error("Mismatched Codex finding commit.");
        expectedFindings.add(comment.id);
      }
    }
    // Unknown comment kinds cannot be silently excluded from this narrow
    // fallback: every published comment must be a trusted finding root.
    commentsComplete =
      comments.length === currentReview.comments.totalCount &&
      expectedFindings.size === comments.length;
  }
  const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
    repository(owner:$owner,name:$name) {
      pullRequest(number:$number) {
        reviewThreads(first:100,after:$cursor) {
          nodes {
            isResolved isOutdated
            comments(first:1) {
              nodes {
                databaseId body author { __typename login ... on Bot { databaseId } }
                pullRequestReview {
                  id submittedAt commit { oid }
                  author { __typename login ... on Bot { databaseId } }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;
  let cursor = null;
  const findings = new Set();
  let unresolved = false;
  const seen = new Set();
  do {
    const response = await github.graphql(query, {
      owner: repo.owner,
      name: repo.repo,
      number,
      cursor,
    });
    const threads = response?.repository?.pullRequest?.reviewThreads;
    if (
      (response?.errors &&
        (!Array.isArray(response.errors) || response.errors.length > 0)) ||
      !Array.isArray(threads?.nodes) ||
      typeof threads.pageInfo?.hasNextPage !== "boolean"
    )
      throw new Error("Incomplete GitHub review-thread response.");
    for (const thread of threads.nodes) {
      const roots = thread?.comments?.nodes;
      const root = roots?.[0];
      if (
        typeof thread?.isResolved !== "boolean" ||
        typeof thread.isOutdated !== "boolean" ||
        !Array.isArray(roots) ||
        roots.length !== 1 ||
        !Number.isSafeInteger(root?.databaseId) ||
        root.databaseId <= 0 ||
        typeof root?.body !== "string" ||
        typeof root.author?.__typename !== "string" ||
        typeof root.author.login !== "string" ||
        (root.author.__typename === "Bot" &&
          (!Number.isSafeInteger(root.author.databaseId) ||
            root.author.databaseId <= 0))
      )
        throw new Error("Incomplete GitHub review-thread root.");
      if (isCodexActor(root.author)) {
        const review = root.pullRequestReview;
        if (
          typeof review?.id !== "string" ||
          typeof review.commit?.oid !== "string" ||
          !Date.parse(review.submittedAt) ||
          !isCodexActor(review.author)
        )
          throw new Error("Incomplete Codex finding review provenance.");
        if (
          currentReview &&
          review.id === currentReview.id &&
          review.commit.oid === sha &&
          review.submittedAt === currentReview.submittedAt &&
          root.body.includes("<!-- codex-code-review-finding:v1 -->")
        )
          findings.add(root.databaseId);
        // Outdated findings still need an explicit resolution.
        if (!thread.isResolved) unresolved = true;
      }
    }
    if (!threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
    if (typeof cursor !== "string" || !cursor || seen.has(cursor))
      throw new Error("Incomplete GitHub review-thread pagination.");
    seen.add(cursor);
  } while (true);
  if (unresolved) return "failure";
  // Some connector versions record nothing at all for a clean Code Review: no
  // findings flag and no review on GitHub. A review it did publish can take a
  // moment to appear in GitHub's views, so absence counts as clean only once
  // that has had time to settle, measured from a known completion of this
  // run, and every Codex thread is resolved. Any review on this commit since
  // the run started, even one dated after the summary's completion, means
  // the run was not silent.
  if (!findingsRecorded && !currentReview) {
    const publishedSinceStart =
      latest && Date.parse(latest.submittedAt) > started;
    if (publishedSinceStart || completed <= 0 || completed < started)
      return "pending";
    return Date.now() - completed >= SILENT_REVIEW_SETTLE_MS
      ? "success"
      : "settling";
  }
  return commentsComplete &&
    expectedFindings.size > 0 &&
    findings.size === expectedFindings.size &&
    [...expectedFindings].every((id) => findings.has(id))
    ? "success"
    : "pending";
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runCodexReviewGate(
  { github, context, core, sleep = wait },
  recheck = false,
) {
  const number = pullRequestNumber(context);
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const getPullRequest = () =>
    github.rest.pulls.get({ ...repo, pull_number: number });
  let { data: pullRequest } = await getPullRequest();
  if (pullRequest.state !== "open") {
    core.info(`Skipping closed pull request #${number}.`);
    return { skipped: true };
  }
  const initialSha = pullRequest.head.sha;
  const publish = async (result, targetUrl = pullRequest.html_url) => {
    await github.rest.repos.createCommitStatus({
      ...repo,
      sha: pullRequest.head.sha,
      context: STATUS_CONTEXT,
      ...result,
      target_url: targetUrl,
    });
    core.info(`${STATUS_CONTEXT}: ${result.state} (${pullRequest.head.sha})`);
    return { ...result, sha: pullRequest.head.sha, pullRequestNumber: number };
  };
  if (pullRequest.base?.ref !== "main") {
    // Commit statuses are shared by all PRs on this SHA. An unrelated non-main
    // PR must not overwrite the gate belonging to a PR that targets main.
    core.info(`Skipping pull request #${number}: it does not target main.`);
    return { skipped: true };
  }
  // Clear any earlier green status before further reads: a retry, deletion, or
  // API outage must not leave an old completion usable while we verify it.
  await publish({
    state: "pending",
    description: "Verifying the latest Code Review and Security Review.",
  });
  let summary;
  let checkpoint;
  let threadResolution;
  let securityResolution;
  try {
    const parameters = { ...repo, issue_number: number, per_page: 100 };
    const [comments, events, statuses] = await Promise.all([
      github.paginate(github.rest.issues.listComments, parameters),
      github.paginate(github.rest.issues.listEvents, parameters),
      github.paginate(github.rest.repos.listCommitStatusesForRef, {
        ...repo,
        ref: initialSha,
        per_page: 100,
      }),
    ]);
    summary = latestSummary(comments, context);
    checkpoint = readCheckpoint(statuses, number);
    requestBarriers(checkpoint, comments, events, context);
    acknowledgeStarts(checkpoint, summary, initialSha, context);
    const description = JSON.stringify(checkpoint);
    if (description.length > 140)
      throw new Error(
        "Codex review checkpoint exceeds the status description limit.",
      );
    await github.rest.repos.createCommitStatus({
      ...repo,
      sha: initialSha,
      context: CHECKPOINT_CONTEXT,
      state: "success",
      description,
      target_url: pullRequest.html_url,
    });
    // A push during the comments request must get a fresh pending result, not
    // inherit the successful result we just read for the previous head.
    ({ data: pullRequest } = await getPullRequest());
    if (
      pullRequest.state === "open" &&
      pullRequest.base?.ref === "main" &&
      pullRequest.head.sha === initialSha
    ) {
      const receiptComments = new Map(
        comments.map((comment) => [comment.id, comment]),
      );
      const current = context.payload.comment;
      if (context.payload.action === "deleted")
        receiptComments.delete(current?.id);
      else if (current) {
        const listed = receiptComments.get(current.id);
        if (
          !listed ||
          Date.parse(current.updated_at) >= Date.parse(listed.updated_at)
        )
          receiptComments.set(current.id, current);
      }
      securityResolution = await securityReceiptResolution(
        github,
        repo,
        number,
        initialSha,
        summary,
        checkpoint,
        [...receiptComments.values()],
      );
      if (securityResolution !== undefined)
        ({ data: pullRequest } = await getPullRequest());
    }
    if (
      pullRequest.state === "open" &&
      pullRequest.base?.ref === "main" &&
      pullRequest.head.sha === initialSha &&
      needsThreadResolution(
        summary,
        initialSha,
        checkpoint,
        securityResolution === "success",
      )
    ) {
      // Some connector versions emit null after findings are resolved, or
      // for a clean review. Only those states may fall back to complete,
      // trusted GitHub thread data.
      threadResolution = await codexThreadResolution(
        github,
        repo,
        number,
        initialSha,
        checkpoint.rc,
        reviewTime(summary, "code_review"),
        summaryState(summary).code_review.has_any_findings === true,
      );
      ({ data: pullRequest } = await getPullRequest());
    }
  } catch (error) {
    await publish({
      state: "failure",
      description: "Unable to verify the latest Codex review. Retry the gate.",
    });
    throw error;
  }
  if (pullRequest.state !== "open") {
    core.info(`Skipping closed pull request #${number}.`);
    return { skipped: true };
  }
  if (pullRequest.base?.ref !== "main") {
    core.info(`Skipping pull request #${number}: it no longer targets main.`);
    return { skipped: true };
  }
  if (pullRequest.head.sha !== initialSha)
    return publish({
      state: "pending",
      description:
        "Pull request changed; waiting for Codex reviews of the new commit.",
    });
  if (threadResolution === "failure" || securityResolution === "failure")
    return publish(
      {
        state: "failure",
        description: "Codex finding threads still require resolution.",
      },
      summary?.html_url,
    );
  if (threadResolution === "settling" && !recheck) {
    // A clean run that records nothing: wait until any review it published
    // would show on GitHub, then verify everything again, once.
    await publish(
      {
        state: "pending",
        description: "Waiting for GitHub to show any Codex review first.",
      },
      summary?.html_url,
    );
    const settled =
      reviewTime(summary, "code_review") + SILENT_REVIEW_SETTLE_MS;
    await sleep(Math.max(settled - Date.now(), 0) + 1000);
    return runCodexReviewGate({ github, context, core, sleep }, true);
  }
  return publish(
    evaluateSummary(
      summary,
      initialSha,
      checkpoint,
      threadResolution === "success",
      securityResolution === "success",
    ),
    summary?.html_url,
  );
}
