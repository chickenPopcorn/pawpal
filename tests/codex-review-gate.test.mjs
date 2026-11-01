import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodexReviewGate } from "../scripts/codex-review-gate.mjs";

const HEAD = "1".repeat(40);
const OLD_HEAD = "2".repeat(40);
const PR_URL = "https://github.com/chickenPopcorn/pawpal/pull/7";
const cleanReview = (sha = HEAD) => ({
  commit_sha: sha,
  status: "completed",
  has_any_findings: false,
  has_unresolved_findings: false,
});
const summary = (
  state = {
    code_review: cleanReview(),
    security_review: cleanReview(),
  },
  id = 10,
  updatedAt = "2026-10-17T06:00:00Z",
) => ({
  id,
  user: {
    id: 199175422,
    login: "chatgpt-codex-connector[bot]",
    type: "Bot",
  },
  performed_via_github_app: { id: 1144995, slug: "chatgpt-codex-connector" },
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify(state)} -->`,
  updated_at: updatedAt,
  html_url: `${PR_URL}#issuecomment-${id}`,
});
const BEFORE = "2026-10-17T06:00:00Z";
const REQUEST = "2026-10-17T06:01:00Z";
const START = "2026-10-17T06:02:00Z";
const FINISH = "2026-10-17T06:03:00Z";
const withTimes = (state, code = FINISH, security = FINISH) => {
  const comment = summary(state, 10, FINISH);
  comment.body += `\n| 📝 **Code Review** | ${state.code_review?.status} <relative-time datetime="${code}">${code}</relative-time> |\n| 🔒 **Security Review** | ${state.security_review?.status} <relative-time datetime="${security}">${security}</relative-time> |`;
  return comment;
};
const completed = () => ({
  code_review: cleanReview(),
  security_review: cleanReview(),
});
const running = () => ({
  code_review: { ...cleanReview(), status: "running" },
  security_review: { ...cleanReview(), status: "running" },
});
const command = (body = "@codex review", association = "OWNER") => ({
  id: 20,
  body,
  author_association: association,
  created_at: REQUEST,
  updated_at: REQUEST,
});
const checkpoint = (values = {}) => ({
  context: "Codex review checkpoint",
  state: "success",
  creator: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
  description: JSON.stringify({
    v: 1,
    p: 7,
    b: 0,
    c: 0,
    s: 0,
    rc: 0,
    rs: 0,
    ...values,
  }),
  created_at: FINISH,
  id: 100,
});
const nullCodeState = () => ({
  code_review: {
    ...cleanReview(),
    has_any_findings: true,
    has_unresolved_findings: null,
  },
  security_review: cleanReview(),
});
const receipt = (overrides = {}) => ({
  id: "review-1",
  databaseId: 101,
  comments: { totalCount: 1 },
  submittedAt: FINISH,
  state: "COMMENTED",
  body: "<!-- codex-review-receipt:v1 -->\nCode Review",
  commit: { oid: HEAD },
  author: {
    __typename: "Bot",
    login: "chatgpt-codex-connector",
    databaseId: 199175422,
  },
  ...overrides,
});
const receiptPage = (
  nodes = [receipt()],
  hasNextPage = false,
  endCursor = null,
) => ({
  repository: {
    pullRequest: { reviews: { nodes, pageInfo: { hasNextPage, endCursor } } },
  },
});
const reviewThread = (overrides = {}) => ({
  isResolved: true,
  isOutdated: false,
  comments: {
    nodes: [
      {
        databaseId: 201,
        body: "A finding\n<!-- codex-code-review-finding:v1 -->",
        pullRequestReview: receipt(),
        author: {
          __typename: "Bot",
          login: "chatgpt-codex-connector",
          databaseId: 199175422,
        },
      },
    ],
  },
  ...overrides,
});
const threadPage = (
  nodes = [reviewThread()],
  hasNextPage = false,
  endCursor = null,
) => ({
  repository: {
    pullRequest: {
      reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } },
    },
  },
});
const savedCheckpoint = (publish) =>
  JSON.parse(
    publish.mock.calls.findLast(
      ([status]) => status.context === "Codex review checkpoint",
    )[0].description,
  );

function setup(comments = [], events = [], statuses = []) {
  const pullRequest = {
    state: "open",
    head: { sha: HEAD },
    base: { ref: "main" },
    html_url: PR_URL,
  };
  const get = vi.fn().mockResolvedValue({ data: pullRequest });
  const publish = vi.fn().mockResolvedValue({});
  const listComments = vi.fn();
  const listCommentsForReview = vi.fn();
  const listEvents = vi.fn();
  const listCommitStatusesForRef = vi.fn();
  const github = {
    graphql: vi.fn(),
    rest: {
      pulls: { get, listCommentsForReview },
      issues: { listComments, listEvents },
      repos: {
        createCommitStatus: publish,
        listCommitStatusesForRef,
        getCommit: vi.fn().mockResolvedValue({ data: { sha: HEAD } }),
      },
    },
    paginate: vi
      .fn()
      .mockImplementation((method) =>
        Promise.resolve(
          method === listEvents
            ? events
            : method === listComments
              ? comments
              : statuses,
        ),
      ),
  };
  const context = {
    repo: { owner: "chickenPopcorn", repo: "pawpal" },
    payload: { pull_request: { number: 7 } },
  };
  const core = { info: vi.fn() };
  return {
    run: (options = {}) =>
      runCodexReviewGate({ github, context, core, ...options }),
    context,
    github,
    get,
    publish,
    pullRequest,
  };
}

const findingComment = (overrides = {}) => ({
  id: 201,
  body: "A finding\n<!-- codex-code-review-finding:v1 -->",
  pull_request_review_id: 101,
  original_commit_id: HEAD,
  user: { id: 199175422, login: "chatgpt-codex-connector[bot]", type: "Bot" },
  ...overrides,
});

function setupFallback(state = nullCodeState()) {
  const fixture = setup(
    [withTimes(state)],
    [],
    [checkpoint({ rc: Date.parse(START) })],
  );
  const originalPaginate = fixture.github.paginate.getMockImplementation();
  const reviewComments = vi.fn().mockResolvedValue([findingComment()]);
  fixture.github.paginate.mockImplementation((method, parameters) =>
    method === fixture.github.rest.pulls.listCommentsForReview
      ? reviewComments(parameters)
      : originalPaginate(method, parameters),
  );
  const reviewGraphql = vi.fn().mockResolvedValue(receiptPage());
  const threadGraphql = vi.fn();
  fixture.github.graphql.mockImplementation((query, variables) =>
    query.includes("reviews(first:100")
      ? reviewGraphql(query, variables)
      : threadGraphql(query, variables),
  );
  return { ...fixture, reviewGraphql, threadGraphql, reviewComments };
}

describe("Codex review merge gate", () => {
  it("keeps a fresh PR pending and publishes the explicit status on its head", async () => {
    const { run, github, get, publish } = setup();
    await expect(run()).resolves.toMatchObject({ state: "pending", sha: HEAD });
    expect(get).toHaveBeenCalledWith({
      owner: "chickenPopcorn",
      repo: "pawpal",
      pull_number: 7,
    });
    expect(github.paginate).toHaveBeenCalledWith(
      github.rest.issues.listComments,
      {
        owner: "chickenPopcorn",
        repo: "pawpal",
        issue_number: 7,
        per_page: 100,
      },
    );
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenLastCalledWith({
      owner: "chickenPopcorn",
      repo: "pawpal",
      sha: HEAD,
      context: "Codex review gate",
      state: "pending",
      description: expect.any(String),
      target_url: PR_URL,
    });
  });

  it("succeeds only when both trusted reviews completed cleanly on the latest head", async () => {
    const comment = summary();
    const { run, publish } = setup([comment]);
    await expect(run()).resolves.toMatchObject({ state: "success", sha: HEAD });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: HEAD,
        context: "Codex review gate",
        state: "success",
        target_url: comment.html_url,
      }),
    );
  });

  it.each([
    {
      code_review: cleanReview(OLD_HEAD),
      security_review: cleanReview(OLD_HEAD),
    },
    { code_review: cleanReview(), security_review: cleanReview(OLD_HEAD) },
    { code_review: cleanReview(OLD_HEAD), security_review: cleanReview() },
    { code_review: cleanReview() },
    { security_review: cleanReview() },
    {},
    null,
    [],
  ])(
    "does not accept missing, stale or split-commit reviews: %j",
    async (state) => {
      await expect(setup([summary(state)]).run()).resolves.toMatchObject({
        state: "pending",
      });
    },
  );

  it.each(["code_review", "security_review"])(
    "blocks unresolved findings from %s even if its review completed",
    async (kind) => {
      const state = {
        code_review: cleanReview(),
        security_review: cleanReview(),
        [kind]: { ...cleanReview(), has_unresolved_findings: true },
      };
      await expect(setup([summary(state)]).run()).resolves.toMatchObject({
        state: "failure",
      });
    },
  );

  it("allows completed findings that are all explicitly resolved", async () => {
    await expect(
      setup([
        summary({
          code_review: { ...cleanReview(), has_any_findings: true },
          security_review: cleanReview(),
        }),
      ]).run(),
    ).resolves.toMatchObject({ state: "success" });
  });

  it.each(["error", "failed", "failure", "canceled", "cancelled", "timed_out"])(
    "fails closed when the newest review retry reports %s",
    async (status) => {
      const oldSuccess = summary(undefined, 100, "2026-10-17T05:00:00Z");
      const newerRetry = summary(
        {
          code_review: { ...cleanReview(), status },
          security_review: cleanReview(),
        },
        10,
      );
      await expect(
        setup([newerRetry, oldSuccess]).run(),
      ).resolves.toMatchObject({ state: "failure" });
    },
  );

  it.each(["queued", "running", "in_progress", "skipped", "unknown"])(
    "keeps a newer %s retry pending instead of accepting an older success",
    async (status) => {
      const oldSuccess = summary(undefined, 100, "2026-10-17T05:00:00Z");
      const retry = summary({
        code_review: cleanReview(),
        security_review: { ...cleanReview(), status },
      });
      await expect(setup([oldSuccess, retry]).run()).resolves.toMatchObject({
        state: "pending",
      });
    },
  );

  it("requires an explicit false unresolved-findings flag", async () => {
    await expect(
      setup([
        summary({
          code_review: { commit_sha: HEAD, status: "completed" },
          security_review: cleanReview(),
        }),
      ]).run(),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it.each([
    { user: { id: 123, login: "chatgpt-codex-connector[bot]", type: "Bot" } },
    { user: { id: 199175422, login: "spoof", type: "Bot" } },
    {
      user: {
        id: 199175422,
        login: "chatgpt-codex-connector[bot]",
        type: "User",
      },
    },
    { performed_via_github_app: { id: 123, slug: "chatgpt-codex-connector" } },
    { performed_via_github_app: { id: 1144995, slug: "spoof" } },
    { performed_via_github_app: undefined },
  ])("ignores spoofed completion identity: %j", async (identity) => {
    const comment = { ...summary(), ...identity };
    await expect(setup([comment]).run()).resolves.toMatchObject({
      state: "pending",
    });
  });

  it("does not treat completion text quoted in an ordinary bot comment as a summary", async () => {
    const comment = summary();
    comment.body = `Here is code from the PR:\n${comment.body}`;
    await expect(setup([comment]).run()).resolves.toMatchObject({
      state: "pending",
    });
  });

  it.each([
    "<!-- codex-pull-request-review-summary -->",
    "<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 invalid -->",
    `${summary().body}\n${summary().body}`,
  ])("keeps a malformed latest summary pending", async (body) => {
    const malformed = { ...summary(), body };
    await expect(
      setup([summary(undefined, 100, "2026-10-17T05:00:00Z"), malformed]).run(),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it("uses the newest comment ID to break equal updated-time ties", async () => {
    const pending = summary(
      {
        code_review: { ...cleanReview(), status: "running" },
        security_review: cleanReview(),
      },
      11,
    );
    await expect(setup([pending, summary()]).run()).resolves.toMatchObject({
      state: "pending",
    });
  });

  it("does not let a later untrusted comment override the trusted summary", async () => {
    const spoof = {
      ...summary({}, 20, "2026-10-17T07:00:00Z"),
      user: { id: 123, login: "attacker", type: "User" },
    };
    await expect(setup([summary(), spoof]).run()).resolves.toMatchObject({
      state: "success",
    });
  });

  it("publishes pending on a new head if a push races the comments request", async () => {
    const { run, get, pullRequest, publish } = setup([summary()]);
    get.mockResolvedValueOnce({ data: pullRequest }).mockResolvedValueOnce({
      data: { ...pullRequest, head: { sha: OLD_HEAD } },
    });
    await expect(run()).resolves.toMatchObject({
      state: "pending",
      sha: OLD_HEAD,
    });
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ sha: OLD_HEAD, state: "pending" }),
    );
  });

  it.each(["initial", "refresh"])(
    "skips a PR closed at the %s read without posting a status",
    async (when) => {
      const { run, get, github, pullRequest, publish } = setup([summary()]);
      if (when === "initial")
        get.mockResolvedValue({ data: { ...pullRequest, state: "closed" } });
      else
        get.mockResolvedValueOnce({ data: pullRequest }).mockResolvedValueOnce({
          data: { ...pullRequest, state: "closed" },
        });
      await expect(run()).resolves.toEqual({ skipped: true });
      if (when === "initial") {
        expect(publish).not.toHaveBeenCalled();
        expect(github.paginate).not.toHaveBeenCalled();
      } else {
        expect(publish).toHaveBeenCalledTimes(2);
        expect(publish).toHaveBeenCalledWith(
          expect.objectContaining({ state: "pending" }),
        );
      }
    },
  );

  it.each(["comments", "refresh"])(
    "replaces prior success with failure when the %s API cannot verify reviews",
    async (failedRequest) => {
      const { run, get, github, pullRequest, publish } = setup([summary()]);
      const error = new Error("GitHub unavailable");
      if (failedRequest === "comments")
        github.paginate.mockRejectedValue(error);
      else
        get
          .mockResolvedValueOnce({ data: pullRequest })
          .mockRejectedValueOnce(error);
      await expect(run()).rejects.toBe(error);
      expect(publish).toHaveBeenLastCalledWith(
        expect.objectContaining({ sha: HEAD, state: "failure" }),
      );
    },
  );

  it("propagates a failed status publication without claiming success", async () => {
    const { run, publish } = setup([summary()]);
    publish.mockRejectedValue(new Error("Status write rejected"));
    await expect(run()).rejects.toThrow("Status write rejected");
  });

  it.each([{ issue: { number: 7 } }, { inputs: { pull_request_number: "7" } }])(
    "accepts comment and manual dispatch PR numbers: %j",
    async (payload) => {
      const { run, context } = setup();
      context.payload = payload;
      await expect(run()).resolves.toMatchObject({ pullRequestNumber: 7 });
    },
  );

  it.each([undefined, "", "7x", "1.5", "-1", 0, -1, 1.5, "9007199254740992"])(
    "rejects invalid PR numbers before API calls: %j",
    async (value) => {
      const { run, context, get } = setup();
      context.payload = { inputs: { pull_request_number: value } };
      await expect(run()).rejects.toThrow("positive pull request number");
      expect(get).not.toHaveBeenCalled();
    },
  );

  it("does not overwrite a shared head's status for a PR targeting another branch", async () => {
    const { run, get, github, pullRequest, publish } = setup([summary()]);
    get.mockResolvedValue({
      data: { ...pullRequest, base: { ref: "release" } },
    });
    await expect(run()).resolves.toEqual({ skipped: true });
    expect(github.paginate).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("cannot pass if the base changes away from main during verification", async () => {
    const { run, get, pullRequest, publish } = setup([summary()]);
    get.mockResolvedValueOnce({ data: pullRequest }).mockResolvedValueOnce({
      data: { ...pullRequest, base: { ref: "release" } },
    });
    await expect(run()).resolves.toEqual({ skipped: true });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ context: "Codex review checkpoint" }),
    );
    expect(publish).not.toHaveBeenCalledWith(
      expect.objectContaining({
        context: "Codex review gate",
        state: "success",
      }),
    );
  });

  it("retains retarget barriers across later refreshes and requires fresh starts for both reviews", async () => {
    const events = [{ event: "base_ref_changed", created_at: REQUEST }];
    const first = setup([withTimes(completed())], events);
    await expect(first.run()).resolves.toMatchObject({ state: "pending" });
    const saved = savedCheckpoint(first.publish);
    expect(saved.b).toBe(Date.parse(REQUEST));
    const next = setup([withTimes(completed())], [], [checkpoint(saved)]);
    await expect(next.run()).resolves.toMatchObject({ state: "pending" });
    const fresh = setup([withTimes(running(), START, START)], events, [
      checkpoint(saved),
    ]);
    await expect(fresh.run()).resolves.toMatchObject({ state: "pending" });
    const finished = setup([withTimes(completed())], events, [
      checkpoint(savedCheckpoint(fresh.publish)),
    ]);
    await expect(finished.run()).resolves.toMatchObject({ state: "success" });
  });

  it("does not accept an old run that finishes after a retarget", async () => {
    const oldStart = withTimes(running(), BEFORE, BEFORE);
    const result = setup(
      [withTimes(completed())],
      [{ event: "base_ref_changed", created_at: REQUEST }],
    );
    result.context.payload.comment = withTimes(completed());
    result.context.payload.changes = { body: { from: oldStart.body } };
    await expect(result.run()).resolves.toMatchObject({ state: "pending" });
    expect(savedCheckpoint(result.publish)).toMatchObject({
      rc: Date.parse(BEFORE),
      rs: Date.parse(BEFORE),
    });
  });

  it("recovers fresh running starts from the trusted completed edit's previous body", async () => {
    const finished = withTimes(completed());
    const { run, context, publish } = setup(
      [finished],
      [{ event: "base_ref_changed", created_at: REQUEST }],
    );
    context.payload.comment = finished;
    context.payload.changes = {
      body: { from: withTimes(running(), START, START).body },
    };
    await expect(run()).resolves.toMatchObject({ state: "success" });
    expect(savedCheckpoint(publish)).toMatchObject({
      rc: Date.parse(START),
      rs: Date.parse(START),
    });
  });

  it("requires both starts after retarget, even when both completion times are new", async () => {
    const { run } = setup(
      [withTimes(completed())],
      [],
      [
        checkpoint({
          b: Date.parse(REQUEST),
          rc: Date.parse(START),
          rs: Date.parse(BEFORE),
        }),
      ],
    );
    await expect(run()).resolves.toMatchObject({ state: "pending" });
  });

  it("uses the base-change payload immediately before issue events are visible", async () => {
    const { run, context, publish } = setup([withTimes(completed())]);
    context.payload.pull_request.updated_at = REQUEST;
    context.payload.changes = { base: { ref: { from: "release" } } };
    await expect(run()).resolves.toMatchObject({ state: "pending" });
    expect(savedCheckpoint(publish).b).toBe(Date.parse(REQUEST));
  });

  it.each(["OWNER", "COLLABORATOR", "MEMBER"])(
    "invalidates both reviews when an authorized %s requests Code Review",
    async (association) => {
      const { run, publish } = setup([
        withTimes(completed()),
        command("@codex review", association),
      ]);
      await expect(run()).resolves.toMatchObject({ state: "pending" });
      expect(savedCheckpoint(publish)).toMatchObject({
        c: Date.parse(REQUEST),
        s: Date.parse(REQUEST),
      });
    },
  );

  it("keeps code-triggered Security Review pending when only a fresh Code Review has run", async () => {
    const { run } = setup(
      [withTimes(completed()), command()],
      [],
      [checkpoint({ rc: Date.parse(START) })],
    );
    await expect(run()).resolves.toMatchObject({ state: "pending" });
  });

  it("a Security Review command requires only a fresh security run", async () => {
    const { run, publish } = setup(
      [withTimes(completed(), BEFORE), command("@codex security review")],
      [],
      [checkpoint({ rs: Date.parse(START) })],
    );
    await expect(run()).resolves.toMatchObject({ state: "success" });
    expect(savedCheckpoint(publish)).toMatchObject({
      c: 0,
      s: Date.parse(REQUEST),
    });
  });

  it("a deleted request remains pending on subsequent bot updates", async () => {
    const first = setup([withTimes(completed())]);
    first.context.payload.comment = command();
    first.context.payload.action = "deleted";
    await expect(first.run()).resolves.toMatchObject({ state: "pending" });
    const saved = savedCheckpoint(first.publish);
    await expect(
      setup([withTimes(completed())], [], [checkpoint(saved)]).run(),
    ).resolves.toMatchObject({ state: "pending" });
    const fresh = setup([withTimes(completed())], [], [checkpoint(saved)]);
    fresh.context.payload.comment = withTimes(completed());
    fresh.context.payload.changes = {
      body: { from: withTimes(running(), START, START).body },
    };
    await expect(fresh.run()).resolves.toMatchObject({ state: "success" });
  });

  it("preserves a command edited out of the triggering comment", async () => {
    const { run, context, publish } = setup([withTimes(completed())]);
    context.payload.comment = command("Thanks");
    context.payload.changes = { body: { from: "@codex review" } };
    await expect(run()).resolves.toMatchObject({ state: "pending" });
    expect(savedCheckpoint(publish).c).toBe(Date.parse(REQUEST));
  });

  it.each([
    command("@codex review", "NONE"),
    command("Please see `@codex review`"),
    command("> @codex review"),
  ])(
    "does not invalidate clean reviews for an unauthorized or quoted request",
    async (comment) => {
      await expect(setup([summary(), comment]).run()).resolves.toMatchObject({
        state: "success",
      });
    },
  );

  it("does not use a later summary edit time as a review completion timestamp", async () => {
    const comment = withTimes(completed(), BEFORE, FINISH);
    comment.updated_at = FINISH;
    await expect(
      setup(
        [comment],
        [],
        [
          checkpoint({
            c: Date.parse(REQUEST),
            rc: Date.parse(START),
          }),
        ],
      ).run(),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it("missing per-review timestamps cannot satisfy a freshness barrier", async () => {
    await expect(
      setup(
        [summary()],
        [],
        [
          checkpoint({
            c: Date.parse(REQUEST),
            rc: Date.parse(START),
          }),
        ],
      ).run(),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it("ignores spoofed previous-body metadata when acknowledging fresh starts", async () => {
    const { run, context } = setup([withTimes(completed()), command()]);
    context.payload.comment = {
      ...withTimes(completed()),
      user: { id: 123, login: "attacker", type: "User" },
    };
    context.payload.changes = {
      body: { from: withTimes(running(), START, START).body },
    };
    await expect(run()).resolves.toMatchObject({ state: "pending" });
  });

  it("does not acknowledge a running review of a different commit", async () => {
    const oldRun = running();
    oldRun.code_review.commit_sha = OLD_HEAD;
    const { run, context, publish } = setup([
      withTimes(completed()),
      command(),
    ]);
    context.payload.comment = withTimes(completed());
    context.payload.changes = {
      body: { from: withTimes(oldRun, START, START).body },
    };
    await expect(run()).resolves.toMatchObject({ state: "pending" });
    expect(savedCheckpoint(publish).rc).toBe(0);
  });

  it("binds checkpoints to the PR number on this commit", async () => {
    const other = checkpoint({ p: 8, b: Date.parse(REQUEST) });
    await expect(setup([summary()], [], [other]).run()).resolves.toMatchObject({
      state: "success",
    });
  });

  it("ignores a spoofed checkpoint that claims fresh running starts", async () => {
    const spoof = checkpoint({ rc: Date.parse(START), rs: Date.parse(START) });
    spoof.creator.id = 123;
    await expect(
      setup([withTimes(completed()), command()], [], [spoof]).run(),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it.each([
    "invalid json",
    JSON.stringify({ v: 2, p: 7, b: 0, c: 0, s: 0, rc: 0, rs: 0 }),
    JSON.stringify({ v: 1, p: 7, b: 0, c: -1, s: 0, rc: 0, rs: 0 }),
  ])("fails closed for a malformed trusted checkpoint", async (description) => {
    const status = { ...checkpoint(), description };
    const { run, publish } = setup([summary()], [], [status]);
    await expect(run()).rejects.toBeInstanceOf(Error);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: "Codex review gate",
        state: "failure",
      }),
    );
  });

  it("serializes maximum timestamp barriers within GitHub's 140-character limit", async () => {
    const { run, publish } = setup(
      [summary(), { ...command(), updated_at: "unreadable" }],
      [{ event: "base_ref_changed", created_at: "unreadable" }],
    );
    await expect(run()).resolves.toMatchObject({ state: "pending" });
    const status = publish.mock.calls.find(
      ([value]) => value.context === "Codex review checkpoint",
    )[0];
    expect(status.description.length).toBeLessThanOrEqual(140);
    expect(savedCheckpoint(publish)).toMatchObject({
      b: Number.MAX_SAFE_INTEGER,
      c: Number.MAX_SAFE_INTEGER,
      s: Number.MAX_SAFE_INTEGER,
    });
  });

  it.each(["listEvents", "listCommitStatusesForRef"])(
    "fails the gate when %s cannot verify persisted freshness",
    async (method) => {
      const { run, github, publish } = setup([summary()]);
      const error = new Error("GitHub unavailable");
      const target = github.rest.issues[method] ?? github.rest.repos[method];
      github.paginate.mockImplementation((called) =>
        called === target ? Promise.reject(error) : Promise.resolve([]),
      );
      await expect(run()).rejects.toBe(error);
      expect(publish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          context: "Codex review gate",
          state: "failure",
        }),
      );
    },
  );

  it("cannot publish a passing gate if saving the checkpoint fails", async () => {
    const { run, publish } = setup([summary()]);
    publish
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Checkpoint rejected"));
    await expect(run()).rejects.toThrow("Checkpoint rejected");
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: "Codex review gate",
        state: "failure",
      }),
    );
  });

  it("evaluates a completed webhook when REST still returns Running in the same second", async () => {
    const stale = withTimes(running(), START, START);
    const current = withTimes(completed());
    // Both API representations can share updated_at's second-level precision.
    stale.updated_at = current.updated_at;
    const { run, context } = setup(
      [stale],
      [{ event: "base_ref_changed", created_at: REQUEST }],
    );
    context.payload.action = "edited";
    context.payload.comment = current;
    context.payload.changes = { body: { from: stale.body } };
    await expect(run()).resolves.toMatchObject({ state: "success" });
  });

  it("uses a newly created trusted summary absent from the REST response", async () => {
    const { run, context } = setup();
    context.payload.action = "created";
    context.payload.comment = summary();
    await expect(run()).resolves.toMatchObject({ state: "success" });
  });

  it("does not reuse REST's old clean result after the webhook reports Running", async () => {
    const current = withTimes(running(), START, START);
    const { run, context, publish } = setup([summary()]);
    context.payload.action = "edited";
    context.payload.comment = current;
    await expect(run()).resolves.toMatchObject({ state: "pending" });
    expect(savedCheckpoint(publish)).toMatchObject({
      rc: Date.parse(START),
      rs: Date.parse(START),
    });
  });

  it("ignores an untrusted current payload even if it claims a newer clean completion", async () => {
    const { run, context } = setup([withTimes(running(), START, START)]);
    context.payload.comment = {
      ...withTimes(completed()),
      user: { id: 123, login: "attacker", type: "User" },
    };
    await expect(run()).resolves.toMatchObject({ state: "pending" });
  });

  it("does not let an older delayed webhook roll back newer REST failure metadata", async () => {
    const failed = completed();
    failed.code_review.has_unresolved_findings = true;
    const listed = withTimes(failed);
    const oldPayload = summary();
    const { run, context } = setup([listed]);
    context.payload.comment = oldPayload;
    await expect(run()).resolves.toMatchObject({ state: "failure" });
  });

  it("does not resurrect a deleted summary from either its payload or stale REST copy", async () => {
    const removed = summary();
    const { run, context } = setup([removed]);
    context.payload.action = "deleted";
    context.payload.comment = removed;
    await expect(run()).resolves.toMatchObject({ state: "pending" });
  });

  it.each([
    "```\n@codex review\n```",
    "```text\n@codex security review\n```",
    "~~~markdown\n@codex review\n~~~",
    "````\n```\n@codex review\n````",
    "  ~~~\n@codex review\n  ~~~~",
    "```\n~~~\n@codex review\n```",
    "```\n@codex review",
    "    @codex review",
    "\t@codex security review",
    " \t@codex review",
  ])("ignores a literal review command example: %j", async (body) => {
    await expect(
      setup([summary(), command(body)]).run(),
    ).resolves.toMatchObject({ state: "success" });
  });

  it.each(["```", "~~~~"])(
    "recognizes a real request after a %s fenced example closes",
    async (fence) => {
      const body = `${fence}text\n@codex security review\n${fence}\n   @codex review`;
      const { run, publish } = setup([summary(), command(body)]);
      await expect(run()).resolves.toMatchObject({ state: "pending" });
      expect(savedCheckpoint(publish)).toMatchObject({
        c: Date.parse(REQUEST),
        s: Date.parse(REQUEST),
      });
    },
  );

  it("accepts null unresolved metadata only with complete resolved Codex finding threads", async () => {
    const { run, threadGraphql, get } = setupFallback();
    threadGraphql.mockResolvedValue(threadPage());
    await expect(run()).resolves.toMatchObject({ state: "success" });
    expect(threadGraphql).toHaveBeenCalledTimes(1);
    expect(threadGraphql).toHaveBeenCalledWith(
      expect.stringContaining("reviewThreads(first:100"),
      {
        owner: "chickenPopcorn",
        name: "pawpal",
        number: 7,
        cursor: null,
      },
    );
    expect(get).toHaveBeenCalledTimes(3);
  });

  describe("a clean Code Review that records no findings flag", () => {
    // Some connector versions report has_any_findings and
    // has_unresolved_findings as null, and publish no review, when the Code
    // Review found nothing.
    const silentState = () => {
      const state = nullCodeState();
      state.code_review.has_any_findings = null;
      return state;
    };

    // Long enough after FINISH for GitHub's views to show a published review.
    const SETTLED = Date.parse(FINISH) + 10 * 60 * 1000;
    afterEach(() => {
      vi.useRealTimers();
    });

    it("passes once every Codex thread is resolved and GitHub has settled", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(SETTLED);
      const { run, reviewGraphql, threadGraphql } =
        setupFallback(silentState());
      reviewGraphql.mockResolvedValue(receiptPage([]));
      threadGraphql.mockResolvedValue(threadPage([]));
      await expect(run()).resolves.toMatchObject({ state: "success" });
    });

    it("waits out the settle time itself, then passes", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(SETTLED - 60000);
      const { run, reviewGraphql, threadGraphql, publish } =
        setupFallback(silentState());
      reviewGraphql.mockResolvedValue(receiptPage([]));
      threadGraphql.mockResolvedValue(threadPage([]));
      const sleep = vi.fn(async (ms) => vi.setSystemTime(Date.now() + ms));
      await expect(run({ sleep })).resolves.toMatchObject({
        state: "success",
      });
      expect(sleep).toHaveBeenCalledExactlyOnceWith(61000);
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "pending",
          description: "Waiting for GitHub to show any Codex review first.",
        }),
      );
    });

    it("stays pending if a review appears while it waits", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(SETTLED - 1);
      const { run, reviewGraphql, threadGraphql } =
        setupFallback(silentState());
      reviewGraphql.mockResolvedValueOnce(receiptPage([]));
      threadGraphql.mockResolvedValue(threadPage([]));
      // The published review shows up during the wait.
      const sleep = vi.fn(async (ms) => vi.setSystemTime(Date.now() + ms));
      await expect(run({ sleep })).resolves.toMatchObject({
        state: "pending",
      });
      expect(sleep).toHaveBeenCalledOnce();
    });

    it("checks only once more after waiting", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(SETTLED - 1);
      const { run, reviewGraphql, threadGraphql } =
        setupFallback(silentState());
      reviewGraphql.mockResolvedValue(receiptPage([]));
      threadGraphql.mockResolvedValue(threadPage([]));
      // A clock that does not move: the recheck is still inside the window.
      const sleep = vi.fn(async () => {});
      await expect(run({ sleep })).resolves.toMatchObject({
        state: "pending",
      });
      expect(sleep).toHaveBeenCalledOnce();
    });

    it("stays pending without a known completion time for the run", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(SETTLED);
      const { run, reviewGraphql, threadGraphql, github } =
        setupFallback(silentState());
      // A summary whose table lost the Code Review's time.
      github.paginate.mockImplementationOnce(async () => [
        summary(silentState(), 10, FINISH),
      ]);
      reviewGraphql.mockResolvedValue(receiptPage([]));
      threadGraphql.mockResolvedValue(threadPage([]));
      await expect(run()).resolves.toMatchObject({ state: "pending" });
    });

    it("stays pending when a review on this commit is dated after the completion", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(SETTLED);
      const { run, reviewGraphql, threadGraphql } =
        setupFallback(silentState());
      reviewGraphql.mockResolvedValue(
        receiptPage([receipt({ submittedAt: "2026-10-17T06:05:00Z" })]),
      );
      threadGraphql.mockResolvedValue(threadPage([]));
      await expect(run()).resolves.toMatchObject({ state: "pending" });
    });

    it("still fails while an older Codex finding is unresolved", async () => {
      const { run, reviewGraphql, threadGraphql } =
        setupFallback(silentState());
      reviewGraphql.mockResolvedValue(receiptPage([]));
      const old = reviewThread({ isResolved: false });
      old.comments.nodes[0].pullRequestReview = receipt({
        id: "review-0",
        commit: { oid: OLD_HEAD },
        submittedAt: BEFORE,
      });
      threadGraphql.mockResolvedValue(threadPage([old]));
      await expect(run()).resolves.toMatchObject({ state: "failure" });
    });

    it("verifies findings as usual when the run did publish a review", async () => {
      const { run, threadGraphql } = setupFallback(silentState());
      threadGraphql.mockResolvedValue(threadPage([]));
      await expect(run()).resolves.toMatchObject({ state: "pending" });
    });

    it("requires an observed Code Review start", async () => {
      const { run, github } = setup([withTimes(silentState())]);
      await expect(run()).resolves.toMatchObject({ state: "pending" });
      expect(github.graphql).not.toHaveBeenCalled();
    });
  });

  it("requires an observed Code Review start before attempting null-metadata fallback", async () => {
    const { run, github } = setup([withTimes(nullCodeState())]);
    await expect(run()).resolves.toMatchObject({ state: "pending" });
    expect(github.graphql).not.toHaveBeenCalled();
  });

  it.each(["missing", "unresolved", "resolved"])(
    "verifies every finding in the selected review when another thread is %s",
    async (state) => {
      const { run, reviewGraphql, threadGraphql, reviewComments, github } =
        setupFallback();
      reviewGraphql.mockResolvedValue(
        receiptPage([receipt({ comments: { totalCount: 2 } })]),
      );
      reviewComments.mockResolvedValue([
        findingComment(),
        findingComment({ id: 202 }),
      ]);
      const threads = [reviewThread()];
      if (state !== "missing") {
        const second = reviewThread({ isResolved: state === "resolved" });
        second.comments.nodes[0].databaseId = 202;
        threads.push(second);
      }
      threadGraphql.mockResolvedValue(threadPage(threads));
      await expect(run()).resolves.toMatchObject({
        state:
          state === "missing"
            ? "pending"
            : state === "unresolved"
              ? "failure"
              : "success",
      });
      expect(github.paginate).toHaveBeenCalledWith(
        github.rest.pulls.listCommentsForReview,
        {
          owner: "chickenPopcorn",
          repo: "pawpal",
          pull_number: 7,
          review_id: 101,
          per_page: 100,
        },
      );
    },
  );

  it("keeps partial REST comment propagation pending even when the visible thread is resolved", async () => {
    const { run, reviewGraphql, threadGraphql } = setupFallback();
    reviewGraphql.mockResolvedValue(
      receiptPage([receipt({ comments: { totalCount: 2 } })]),
    );
    threadGraphql.mockResolvedValue(threadPage());
    await expect(run()).resolves.toMatchObject({ state: "pending" });
  });

  it("rejects a thread set that contains an unenumerated current finding", async () => {
    const { run, threadGraphql } = setupFallback();
    const second = reviewThread();
    second.comments.nodes[0].databaseId = 202;
    threadGraphql.mockResolvedValue(threadPage([reviewThread(), second]));
    await expect(run()).resolves.toMatchObject({ state: "pending" });
  });

  it("requires a marked trusted finding in the complete receipt comment set", async () => {
    const { run, threadGraphql, reviewComments } = setupFallback();
    reviewComments.mockResolvedValue([
      findingComment({ body: "Not a finding" }),
    ]);
    threadGraphql.mockResolvedValue(threadPage());
    await expect(run()).resolves.toMatchObject({ state: "pending" });
  });

  it.each([
    { body: "An unclassified comment" },
    { user: { id: 123, login: "someone", type: "User" } },
    { in_reply_to_id: 201 },
  ])(
    "does not silently exclude an unexpected receipt comment: %j",
    async (extra) => {
      const { run, reviewGraphql, threadGraphql, reviewComments } =
        setupFallback();
      reviewGraphql.mockResolvedValue(
        receiptPage([receipt({ comments: { totalCount: 2 } })]),
      );
      reviewComments.mockResolvedValue([
        findingComment(),
        findingComment({ id: 202, ...extra }),
      ]);
      threadGraphql.mockResolvedValue(threadPage());
      await expect(run()).resolves.toMatchObject({ state: "pending" });
    },
  );

  it.each([
    undefined,
    [findingComment({ pull_request_review_id: 999 })],
    [findingComment({ original_commit_id: OLD_HEAD })],
    [findingComment({ user: null })],
    [findingComment({ id: null })],
    [findingComment(), findingComment()],
  ])(
    "fails closed for incomplete finding comment lists: %j",
    async (comments) => {
      const { run, reviewComments, publish } = setupFallback();
      reviewComments.mockResolvedValue(comments);
      await expect(run()).rejects.toThrow();
      expect(publish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          context: "Codex review gate",
          state: "failure",
        }),
      );
    },
  );

  it("fails closed when fetching the complete review comment list fails", async () => {
    const { run, reviewComments } = setupFallback();
    reviewComments.mockRejectedValue(new Error("Review comments unavailable"));
    await expect(run()).rejects.toThrow("Review comments unavailable");
  });

  it.each([
    { commit: { oid: OLD_HEAD } },
    { submittedAt: BEFORE },
    { submittedAt: START },
    { submittedAt: "2026-10-17T06:04:00Z" },
    { state: "PENDING" },
    { body: "A quoted or unrelated review receipt" },
    { author: { __typename: "Bot", login: "attacker", databaseId: 199175422 } },
    {
      author: {
        __typename: "Bot",
        login: "chatgpt-codex-connector",
        databaseId: 123,
      },
    },
  ])(
    "does not count receipts from another head, run or author: %j",
    async (values) => {
      const { run, reviewGraphql, threadGraphql } = setupFallback();
      reviewGraphql.mockResolvedValue(receiptPage([receipt(values)]));
      threadGraphql.mockResolvedValue(threadPage());
      await expect(run()).resolves.toMatchObject({ state: "pending" });
    },
  );

  it.each(["COMMENTED", "DISMISSED"])(
    "keeps task completion independent of a %s GitHub review decision",
    async (state) => {
      const { run, reviewGraphql, threadGraphql } = setupFallback();
      reviewGraphql.mockResolvedValue(receiptPage([receipt({ state })]));
      threadGraphql.mockResolvedValue(threadPage());
      await expect(run()).resolves.toMatchObject({ state: "success" });
      threadGraphql.mockResolvedValue(
        threadPage([reviewThread({ isResolved: false })]),
      );
      await expect(run()).resolves.toMatchObject({ state: "failure" });
    },
  );

  it.each([
    { commit: { oid: OLD_HEAD } },
    { id: "earlier-review", submittedAt: BEFORE },
    { id: "earlier-run", submittedAt: "2026-10-17T06:02:30Z" },
  ])(
    "historical resolved threads cannot replace missing current findings: %j",
    async (values) => {
      const thread = reviewThread();
      thread.comments.nodes[0].pullRequestReview = receipt(values);
      const { run, threadGraphql } = setupFallback();
      threadGraphql.mockResolvedValue(threadPage([thread]));
      await expect(run()).resolves.toMatchObject({ state: "pending" });
    },
  );

  it("still blocks an unresolved finding from an older commit", async () => {
    const old = reviewThread({ isResolved: false, isOutdated: true });
    old.comments.nodes[0].pullRequestReview = receipt({
      id: "old-review",
      commit: { oid: OLD_HEAD },
      submittedAt: BEFORE,
    });
    const { run, threadGraphql } = setupFallback();
    threadGraphql.mockResolvedValue(threadPage([reviewThread(), old]));
    await expect(run()).resolves.toMatchObject({ state: "failure" });
  });

  it("selects the latest current receipt across every review page", async () => {
    const { run, reviewGraphql, threadGraphql } = setupFallback();
    reviewGraphql
      .mockResolvedValueOnce(
        receiptPage(
          [receipt({ id: "old-review", submittedAt: BEFORE })],
          true,
          "review-page-2",
        ),
      )
      .mockResolvedValueOnce(receiptPage());
    threadGraphql.mockResolvedValue(threadPage());
    await expect(run()).resolves.toMatchObject({ state: "success" });
    expect(reviewGraphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ cursor: "review-page-2" }),
    );
  });

  it("ignores old timestamp ties once a newer unambiguous receipt arrives", async () => {
    const { run, reviewGraphql, threadGraphql } = setupFallback();
    reviewGraphql
      .mockResolvedValueOnce(
        receiptPage(
          [
            receipt({ id: "old-a", submittedAt: BEFORE }),
            receipt({ id: "old-b", submittedAt: BEFORE }),
          ],
          true,
          "next",
        ),
      )
      .mockResolvedValueOnce(receiptPage());
    threadGraphql.mockResolvedValue(threadPage());
    await expect(run()).resolves.toMatchObject({ state: "success" });
  });

  it("fails closed for two distinct latest receipts sharing a submission time", async () => {
    const { run, reviewGraphql } = setupFallback();
    reviewGraphql.mockResolvedValue(
      receiptPage([receipt(), receipt({ id: "ambiguous" })]),
    );
    await expect(run()).rejects.toThrow("Ambiguous latest");
  });

  it.each([
    undefined,
    { repository: null },
    { errors: [{ message: "Partial result" }], ...receiptPage() },
    receiptPage([null]),
    receiptPage([receipt({ submittedAt: null })]),
    receiptPage([receipt({ databaseId: null })]),
    receiptPage([receipt({ comments: { totalCount: null } })]),
    receiptPage([receipt({ commit: null })]),
    receiptPage([receipt({ author: null })]),
    receiptPage([receipt()], true, null),
  ])("fails closed on malformed receipt responses: %j", async (response) => {
    const { run, reviewGraphql, publish } = setupFallback();
    reviewGraphql.mockResolvedValue(response);
    await expect(run()).rejects.toThrow();
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: "Codex review gate",
        state: "failure",
      }),
    );
  });

  it("fails closed if receipt pagination repeats or later fails", async () => {
    const loop = setupFallback();
    loop.reviewGraphql.mockResolvedValue(receiptPage([], true, "loop"));
    await expect(loop.run()).rejects.toThrow("pagination");
    const failure = setupFallback();
    failure.reviewGraphql
      .mockResolvedValueOnce(receiptPage([receipt()], true, "next"))
      .mockRejectedValueOnce(new Error("Receipts unavailable"));
    await expect(failure.run()).rejects.toThrow("Receipts unavailable");
  });

  it.each([
    null,
    receipt({ id: null }),
    receipt({ submittedAt: null }),
    receipt({ commit: null }),
    receipt({ author: null }),
  ])(
    "fails closed on malformed finding review provenance: %j",
    async (review) => {
      const thread = reviewThread();
      thread.comments.nodes[0].pullRequestReview = review;
      const { run, threadGraphql } = setupFallback();
      threadGraphql.mockResolvedValue(threadPage([thread]));
      await expect(run()).rejects.toThrow("provenance");
    },
  );

  it.each([
    { code: { has_unresolved_findings: true }, expected: "failure" },
    { code: { has_any_findings: false }, expected: "pending" },
    { code: { has_unresolved_findings: undefined }, expected: "pending" },
    { code: { commit_sha: OLD_HEAD }, expected: "pending" },
    { code: { status: "running" }, expected: "pending" },
    { security: { has_unresolved_findings: null }, expected: "pending" },
    { security: { has_unresolved_findings: true }, expected: "failure" },
    { security: { commit_sha: OLD_HEAD }, expected: "pending" },
    { security: { status: "running" }, expected: "pending" },
  ])(
    "never broadens the thread fallback prerequisites: %j",
    async ({ code, security, expected }) => {
      const state = nullCodeState();
      Object.assign(state.code_review, code);
      Object.assign(state.security_review, security);
      const { run, github } = setup(
        [withTimes(state)],
        [],
        [checkpoint({ rc: Date.parse(START) })],
      );
      await expect(run()).resolves.toMatchObject({ state: expected });
      expect(github.graphql).not.toHaveBeenCalled();
    },
  );

  it("does not use thread resolution to bypass review freshness", async () => {
    const { run, github } = setup(
      [withTimes(nullCodeState())],
      [],
      [checkpoint({ b: Date.parse(REQUEST) })],
    );
    await expect(run()).resolves.toMatchObject({ state: "pending" });
    expect(github.graphql).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "unresolved Codex threads fail even when outdated=%s",
    async (isOutdated) => {
      const { run, threadGraphql } = setupFallback();
      threadGraphql.mockResolvedValue(
        threadPage([
          reviewThread(),
          reviewThread({ isResolved: false, isOutdated }),
        ]),
      );
      await expect(run()).resolves.toMatchObject({ state: "failure" });
    },
  );

  it("includes unmarked unresolved Codex threads once findings provenance is established", async () => {
    const unmarked = reviewThread({ isResolved: false });
    unmarked.comments.nodes[0].body = "Another Codex thread";
    const { run, threadGraphql } = setupFallback();
    threadGraphql.mockResolvedValue(threadPage([reviewThread(), unmarked]));
    await expect(run()).resolves.toMatchObject({ state: "failure" });
  });

  it.each([
    { threads: [] },
    {
      threads: [
        reviewThread({
          comments: {
            nodes: [
              {
                databaseId: 202,
                body: "No finding marker",
                pullRequestReview: receipt(),
                author: {
                  __typename: "Bot",
                  login: "chatgpt-codex-connector",
                  databaseId: 199175422,
                },
              },
            ],
          },
        }),
      ],
    },
  ])(
    "requires at least one proven Codex finding, not merely an empty clean thread list",
    async ({ threads }) => {
      const { run, threadGraphql } = setupFallback();
      threadGraphql.mockResolvedValue(threadPage(threads));
      await expect(run()).resolves.toMatchObject({ state: "pending" });
    },
  );

  it.each([
    {
      __typename: "User",
      login: "chatgpt-codex-connector",
      databaseId: 199175422,
    },
    { __typename: "Bot", login: "chatgpt-codex-connector", databaseId: 123 },
    { __typename: "Bot", login: "attacker", databaseId: 199175422 },
  ])("rejects spoofed finding authors: %j", async (author) => {
    const thread = reviewThread();
    thread.comments.nodes[0].author = author;
    const { run, threadGraphql } = setupFallback();
    threadGraphql.mockResolvedValue(threadPage([thread]));
    await expect(run()).resolves.toMatchObject({ state: "pending" });
  });

  it("reads all thread pages before passing and checks later unresolved findings", async () => {
    const { run, threadGraphql } = setupFallback();
    threadGraphql
      .mockResolvedValueOnce(threadPage([reviewThread()], true, "page-2"))
      .mockResolvedValueOnce(
        threadPage([reviewThread({ isResolved: false, isOutdated: true })]),
      );
    await expect(run()).resolves.toMatchObject({ state: "failure" });
    expect(threadGraphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ cursor: "page-2" }),
    );
  });

  it("accepts resolved findings only after every page finishes successfully", async () => {
    const { run, threadGraphql } = setupFallback();
    threadGraphql
      .mockResolvedValueOnce(threadPage([reviewThread()], true, "next"))
      .mockResolvedValueOnce(threadPage([reviewThread({ isOutdated: true })]));
    await expect(run()).resolves.toMatchObject({ state: "success" });
    expect(threadGraphql).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined,
    { repository: null },
    { errors: [{ message: "Partial result" }], ...threadPage() },
    threadPage([null]),
    threadPage([reviewThread({ comments: { nodes: [] } })]),
    threadPage([reviewThread({ isResolved: null })]),
    threadPage([
      reviewThread({
        comments: { nodes: [{ body: "missing author", author: null }] },
      }),
    ]),
    threadPage([
      reviewThread({
        comments: {
          nodes: [
            {
              databaseId: 202,
              body: "unknown bot",
              author: {
                __typename: "Bot",
                login: "chatgpt-codex-connector",
                databaseId: null,
              },
            },
          ],
        },
      }),
    ]),
    threadPage([reviewThread()], true, null),
  ])(
    "fails closed for partial or malformed thread responses: %j",
    async (response) => {
      const { run, threadGraphql, publish } = setupFallback();
      threadGraphql.mockResolvedValue(response);
      await expect(run()).rejects.toThrow();
      expect(publish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          context: "Codex review gate",
          state: "failure",
        }),
      );
    },
  );

  it("fails closed if a later thread page errors after resolved findings were read", async () => {
    const { run, threadGraphql, publish } = setupFallback();
    threadGraphql
      .mockResolvedValueOnce(threadPage([reviewThread()], true, "next"))
      .mockRejectedValueOnce(new Error("GraphQL unavailable"));
    await expect(run()).rejects.toThrow("GraphQL unavailable");
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: "Codex review gate",
        state: "failure",
      }),
    );
  });

  it("fails closed if pagination repeats a cursor", async () => {
    const { run, threadGraphql } = setupFallback();
    threadGraphql.mockResolvedValue(threadPage([reviewThread()], true, "loop"));
    await expect(run()).rejects.toThrow("pagination");
    expect(threadGraphql).toHaveBeenCalledTimes(2);
  });

  it.each(["head", "base", "closed"])(
    "rechecks the PR after thread resolution when its %s changes",
    async (change) => {
      const { run, threadGraphql, get, pullRequest, publish } = setupFallback();
      const current =
        change === "head"
          ? { ...pullRequest, head: { sha: OLD_HEAD } }
          : change === "base"
            ? { ...pullRequest, base: { ref: "release" } }
            : { ...pullRequest, state: "closed" };
      get
        .mockResolvedValueOnce({ data: pullRequest })
        .mockResolvedValueOnce({ data: pullRequest })
        .mockResolvedValueOnce({ data: current });
      threadGraphql.mockResolvedValue(threadPage());
      await expect(run()).resolves.toMatchObject(
        change === "head"
          ? { state: "pending", sha: OLD_HEAD }
          : { skipped: true },
      );
      expect(publish).not.toHaveBeenCalledWith(
        expect.objectContaining({
          context: "Codex review gate",
          state: "success",
        }),
      );
    },
  );
});

describe("Security Review issue-comment receipts", () => {
  const CREATED = "2026-10-17T06:02:59Z";
  const state = () => ({
    code_review: cleanReview(),
    security_review: {
      ...cleanReview(),
      has_any_findings: null,
      has_unresolved_findings: null,
    },
  });
  const cleanReceipt = (overrides = {}) => ({
    ...summary(undefined, 30, CREATED),
    created_at: CREATED,
    body: `<!-- codex-review-receipt:v1 -->\n\n### 🛡️ Codex Security Review\n\nSecurity review completed. No security issues were found in this pull request.\n\n**Reviewed commit:** \`${HEAD.slice(0, 10)}\`\n\n[View security finding report](https://chatgpt.com/codex/cloud/tasks/task_e_example)\n\n_Only the user who started this review can view the report in Codex._\n\n<details>More information</details>`,
    ...overrides,
  });
  const fixture = (
    receipts = [cleanReceipt()],
    reviewState = state(),
    cp = { rs: Date.parse(START) },
  ) => {
    const f = setup(
      [withTimes(reviewState), ...receipts],
      [],
      [checkpoint(cp)],
    );
    f.github.graphql.mockResolvedValue(threadPage([]));
    return f;
  };

  it("accepts the explicit trusted clean receipt after resolving its abbreviated commit", async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({
      state: "success",
      sha: HEAD,
    });
    expect(f.github.rest.repos.getCommit).toHaveBeenCalledExactlyOnceWith({
      owner: "chickenPopcorn",
      repo: "pawpal",
      ref: HEAD.slice(0, 10),
    });
    expect(f.github.graphql).toHaveBeenCalledWith(
      expect.stringContaining("query securityReceiptThreads"),
      { owner: "chickenPopcorn", name: "pawpal", number: 7, cursor: null },
    );
  });

  it("does not interpret completion without a receipt as clean", async () => {
    const f = fixture([]);
    await expect(f.run()).resolves.toMatchObject({ state: "pending" });
    expect(f.github.rest.repos.getCommit).not.toHaveBeenCalled();
  });

  it.each([
    { user: { id: 123, login: "chatgpt-codex-connector[bot]", type: "Bot" } },
    { user: { id: 199175422, login: "attacker", type: "Bot" } },
    {
      user: {
        id: 199175422,
        login: "chatgpt-codex-connector[bot]",
        type: "User",
      },
    },
    { performed_via_github_app: { id: 123, slug: "chatgpt-codex-connector" } },
    { performed_via_github_app: { id: 1144995, slug: "other" } },
    { created_at: BEFORE, updated_at: BEFORE },
    { created_at: "2026-10-17T06:04:00Z", updated_at: "2026-10-17T06:04:00Z" },
    { updated_at: FINISH },
  ])(
    "rejects untrusted, stale, future or edited receipts: %j",
    async (overrides) => {
      const f = fixture([cleanReceipt(overrides)]);
      await expect(f.run()).resolves.toMatchObject({ state: "pending" });
      expect(f.github.rest.repos.getCommit).not.toHaveBeenCalled();
    },
  );

  it.each([
    (body) =>
      body.replace("### 🛡️ Codex Security Review", "### Codex Code Review"),
    (body) =>
      body.replace(
        "### 🛡️ Codex Security Review",
        "    ### 🛡️ Codex Security Review",
      ),
    (body) =>
      body.replace(
        "No security issues were found",
        "Some security issues were found",
      ),
    (body) => body.replace("**Reviewed commit:**", "**Suggested commit:**"),
    (body) => body.replace(HEAD.slice(0, 10), HEAD.slice(0, 7)),
    (body) => body.replace("https://chatgpt.com/", "https://attacker.example/"),
    (body) =>
      body.replace(
        "\n\n<details>",
        "\nA security finding remains unresolved.\n\n<details>",
      ),
    (body) =>
      body.replace(
        "<!-- codex-review-receipt:v1 -->",
        "Quoted: <!-- codex-review-receipt:v1 -->",
      ),
  ])("rejects unknown or contradictory receipt bodies %#", async (change) => {
    const receipt = cleanReceipt();
    receipt.body = change(receipt.body);
    const f = fixture([receipt]);
    await expect(f.run()).resolves.toMatchObject({ state: "pending" });
  });

  it("does not revive an earlier clean receipt after a newer unknown result", async () => {
    const old = cleanReceipt({
      id: 29,
      created_at: "2026-10-17T06:02:58Z",
      updated_at: "2026-10-17T06:02:58Z",
    });
    const latest = cleanReceipt();
    latest.body = latest.body.replace(
      "No security issues were found",
      "Security issues were found",
    );
    await expect(fixture([old, latest]).run()).resolves.toMatchObject({
      state: "pending",
    });
  });

  it("does not reuse an older clean receipt when a newer security receipt changes its heading", async () => {
    const old = cleanReceipt({
      id: 29,
      created_at: "2026-10-17T06:02:58Z",
      updated_at: "2026-10-17T06:02:58Z",
    });
    const latest = cleanReceipt();
    latest.body = latest.body.replace(
      "### 🛡️ Codex Security Review",
      "## Security Review result",
    );
    await expect(fixture([old, latest]).run()).resolves.toMatchObject({
      state: "pending",
    });
  });

  it.each([
    { rs: 0 },
    { rs: Date.parse(BEFORE), s: Date.parse(REQUEST) },
    { rs: Date.parse(BEFORE), b: Date.parse(REQUEST) },
  ])("requires a fresh observed security-review start: %j", async (cp) => {
    const f = fixture(undefined, undefined, cp);
    await expect(f.run()).resolves.toMatchObject({ state: "pending" });
    expect(f.github.rest.repos.getCommit).not.toHaveBeenCalled();
  });

  it.each([
    { status: "running" },
    { status: "failed" },
    { commit_sha: OLD_HEAD },
    { has_any_findings: true },
    { has_unresolved_findings: true },
    { has_unresolved_findings: undefined },
  ])(
    "does not override missing, adverse or stale security metadata: %j",
    async (patch) => {
      const s = state();
      Object.assign(s.security_review, patch);
      const f = fixture(undefined, s);
      await expect(f.run()).resolves.toMatchObject({
        state:
          patch.status === "failed" || patch.has_unresolved_findings === true
            ? "failure"
            : "pending",
      });
      expect(f.github.rest.repos.getCommit).not.toHaveBeenCalled();
    },
  );

  it("rejects a commit abbreviation that resolves to another full SHA", async () => {
    const f = fixture();
    f.github.rest.repos.getCommit.mockResolvedValue({
      data: { sha: OLD_HEAD },
    });
    await expect(f.run()).resolves.toMatchObject({ state: "pending" });
    expect(f.github.graphql).not.toHaveBeenCalled();
  });

  it("fails closed when GitHub cannot resolve the commit", async () => {
    const f = fixture();
    f.github.rest.repos.getCommit.mockRejectedValue(new Error("Ambiguous SHA"));
    await expect(f.run()).rejects.toThrow("Ambiguous SHA");
    expect(f.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "failure" }),
    );
  });

  it("checks later thread pages and blocks unresolved old findings", async () => {
    const f = fixture();
    f.github.graphql
      .mockResolvedValueOnce(threadPage([], true, "next"))
      .mockResolvedValueOnce(
        threadPage([reviewThread({ isResolved: false, isOutdated: true })]),
      );
    await expect(f.run()).resolves.toMatchObject({ state: "failure" });
    expect(f.github.graphql).toHaveBeenCalledTimes(2);
  });

  it.each([
    { errors: { message: "Partial" }, ...threadPage([]) },
    threadPage([], true, null),
    threadPage([{}]),
  ])("fails closed on incomplete thread responses %#", async (response) => {
    const f = fixture();
    f.github.graphql.mockResolvedValue(response);
    await expect(f.run()).rejects.toThrow(/Security Review/);
    expect(f.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "failure" }),
    );
  });

  it("accepts a trusted receipt from the webhook before REST sees it", async () => {
    const f = fixture([]);
    f.context.payload.action = "created";
    f.context.payload.comment = cleanReceipt();
    await expect(f.run()).resolves.toMatchObject({ state: "success" });
  });

  it("removes a deleted receipt even while REST still lists it", async () => {
    const f = fixture();
    f.context.payload.action = "deleted";
    f.context.payload.comment = cleanReceipt();
    await expect(f.run()).resolves.toMatchObject({ state: "pending" });
  });

  it("never publishes success for a head that changed during verification", async () => {
    const f = fixture();
    const original = f.github.rest.repos.getCommit.getMockImplementation();
    f.github.rest.repos.getCommit.mockImplementation(async (...args) => {
      const result = await original(...args);
      f.pullRequest.head = { sha: OLD_HEAD };
      return result;
    });
    await expect(f.run()).resolves.toMatchObject({
      state: "pending",
      sha: OLD_HEAD,
    });
    expect(f.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({
        context: "Codex review gate",
        state: "success",
      }),
    );
  });
});
