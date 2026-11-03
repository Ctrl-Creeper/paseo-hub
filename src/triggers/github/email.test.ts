import { describe, expect, it } from "vitest";
import { classifyGitHubEvent } from "./classification.js";
import {
  eventForNotification,
  githubNotified,
  notificationDeliveryId,
  parseNotificationMessageId,
  permanentGitHubFailure,
} from "./email.js";
import { HUB_AUTHORED_MARKER } from "./classification.js";
import { matchTriggers } from "./match.js";

describe("github notification emails", () => {
  it("parses the Message-ID shapes GitHub uses", () => {
    expect(parseNotificationMessageId("<octo/hub/issues/12@github.com>")).toEqual({
      kind: "issue_opened",
      owner: "octo",
      repo: "hub",
      number: 12,
    });
    expect(parseNotificationMessageId("<octo/hub/pull/7@github.com>")?.kind).toBe(
      "pull_request_opened",
    );
    expect(parseNotificationMessageId("<octo/hub/pull/7/c345@github.com>")).toMatchObject({
      kind: "comment",
      commentId: 345,
    });
    expect(parseNotificationMessageId("<octo/hub/issues/12/345@github.com>")).toMatchObject({
      kind: "comment",
      commentId: 345,
    });
    expect(parseNotificationMessageId("<octo/hub/pull/7/review/9@github.com>")).toMatchObject({
      kind: "review",
      reviewId: 9,
    });
    expect(
      parseNotificationMessageId("<octo/hub/pull/7/before/abc/after/def@github.com>"),
    ).toBeUndefined();
    expect(parseNotificationMessageId("<random@gmail.com>")).toBeUndefined();
  });

  it("rebuilds a pull request comment the classifier understands", async () => {
    const responses: Record<string, unknown> = {
      "GET /repos/{owner}/{repo}": {
        id: 99,
        full_name: "octo/hub",
        url: "https://api.github.com/repos/octo/hub",
      },
      "GET /repos/{owner}/{repo}/issues/comments/{comment_id}": {
        id: 345,
        issue_url: "https://api.github.com/repos/octo/hub/issues/7",
        created_at: "2026-11-01T00:00:00Z",
        body: "/paseo fix it",
        user: { login: "maintainer" },
      },
      "GET /repos/{owner}/{repo}/issues/{issue_number}": {
        number: 7,
        title: "Fix",
        pull_request: { url: "x" },
        labels: [],
        user: { login: "me" },
      },
    };
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a route-keyed fake cannot satisfy Octokit's overloaded request type
    const octokit = {
      request: (route: string) => Promise.resolve({ data: responses[route] }),
    } as unknown as Parameters<typeof eventForNotification>[0];
    const ref = parseNotificationMessageId("<octo/hub/pull/7/c345@github.com>")!;
    const now = Date.parse("2026-11-03T00:00:00Z");
    const event = await eventForNotification(octokit, ref, 42, now);
    expect(event).toMatchObject({
      type: "issue_comment",
      repo: "octo/hub",
      repositoryId: 99,
      installationId: 42,
    });
    expect(classifyGitHubEvent(event!)).toMatchObject({
      semanticEvent: "github.pull_request_comment_created",
      actor: "maintainer",
      text: "/paseo fix it",
      item: { type: "pull_request", number: 7 },
    });

    // A forged mail pairing a notified thread with a comment from another item, or an old one.
    const elsewhere = parseNotificationMessageId("<octo/hub/pull/8/c345@github.com>")!;
    await expect(eventForNotification(octokit, elsewhere, 42, now)).resolves.toBeUndefined();
    const later = now + 8 * 24 * 60 * 60 * 1000;
    await expect(eventForNotification(octokit, ref, 42, later)).resolves.toBeUndefined();
    expect(event!.id).toBe("email:99/comment/7/345");

    // The /issues/ form of a pull request is not a new issue, and both forms share one key.
    const issueForm = parseNotificationMessageId("<octo/hub/issues/7@github.com>")!;
    await expect(eventForNotification(octokit, issueForm, 42, now)).resolves.toBeUndefined();
    const pullForm = parseNotificationMessageId("<OCTO/Hub/pull/7@github.com>")!;
    expect(notificationDeliveryId(issueForm, 99)).toBe(notificationDeliveryId(pullForm, 99));
  });

  it("only trusts emails GitHub actually sent a notification for", async () => {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a route-keyed fake cannot satisfy Octokit's overloaded request type
    const octokit = {
      request: () =>
        Promise.resolve({
          data: [{ subject: { url: "https://api.github.com/repos/octo/hub/pulls/7" } }],
        }),
    } as unknown as Parameters<typeof githubNotified>[0];
    const notified = parseNotificationMessageId("<octo/hub/pull/7/c345@github.com>")!;
    const forged = parseNotificationMessageId("<octo/hub/issues/70/c345@github.com>")!;
    await expect(githubNotified(octokit, notified)).resolves.toBe(true);
    await expect(githubNotified(octokit, forged)).resolves.toBe(false);
  });

  it("rejects owner or repository names that would change the API path", () => {
    expect(parseNotificationMessageId("<../hub/issues/1@github.com>")).toBeUndefined();
    expect(parseNotificationMessageId("<octo/../issues/1@github.com>")).toBeUndefined();
    expect(parseNotificationMessageId("<oc%2Fto/hub/issues/1@github.com>")).toBeUndefined();
    expect(parseNotificationMessageId("<octo/hub.js/issues/1@github.com>")?.repo).toBe("hub.js");
  });

  it("drops refused content but retries rate limits and outages", () => {
    const rateLimited = { status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } };
    expect(permanentGitHubFailure({ status: 404 })).toBe(true);
    expect(permanentGitHubFailure({ status: 403, response: { headers: {} } })).toBe(true);
    expect(permanentGitHubFailure(rateLimited)).toBe(false);
    expect(permanentGitHubFailure({ status: 429 })).toBe(false);
    expect(permanentGitHubFailure({ status: 502 })).toBe(false);
    expect(permanentGitHubFailure(new Error("socket hang up"))).toBe(false);
  });

  it("checks notifications from shortly before the email, page by page", async () => {
    const calls: Record<string, unknown>[] = [];
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a route-keyed fake cannot satisfy Octokit's overloaded request type
    const octokit = {
      request: (_route: string, params: Record<string, unknown>) => {
        calls.push(params);
        const data =
          params["page"] === 1
            ? Array.from({ length: 50 }, (_, index) => ({
                subject: { url: `https://api.github.com/repos/octo/hub/issues/${100 + index}` },
              }))
            : [{ subject: { url: "https://api.github.com/repos/octo/hub/pulls/7" } }];
        return Promise.resolve({ data });
      },
    } as unknown as Parameters<typeof githubNotified>[0];
    const ref = parseNotificationMessageId("<octo/hub/pull/7/c345@github.com>")!;
    const now = Date.parse("2026-11-03T12:00:00Z");
    await expect(githubNotified(octokit, ref, now, new Date("2026-11-03T11:00:00Z"))).resolves.toBe(
      true,
    );
    expect(calls.map((call) => [call["page"], call["since"]])).toEqual([
      [1, "2026-11-03T10:50:00.000Z"],
      [2, "2026-11-03T10:50:00.000Z"],
    ]);
  });

  it("never lets a comment Hub posted as the account start another run", () => {
    const event = {
      id: "delivery",
      type: "issue_comment",
      repo: "octo/hub",
      repositoryId: 99,
      installationId: 42,
      createdAt: "2026-11-03T00:00:00Z",
      payload: {
        action: "created",
        comment: { id: 1, body: `@paseo done\n\n${HUB_AUTHORED_MARKER}`, user: { login: "me" } },
        issue: { number: 7, labels: [] },
        sender: { login: "me" },
      },
    };
    const trigger = {
      name: "mention",
      on: "github.issue_comment_created",
      filters: { from_users: ["me"], contains: "@paseo" },
    };
    const run = (body: string) =>
      matchTriggers(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only the filter fields matter here
        { triggers: [trigger] } as unknown as Parameters<typeof matchTriggers>[0],
        { ...event, payload: { ...event.payload, comment: { ...event.payload.comment, body } } },
      ).length;
    expect(run("@paseo do it")).toBe(1);
    expect(run(`@paseo done\n\n${HUB_AUTHORED_MARKER}`)).toBe(0);
  });
});
