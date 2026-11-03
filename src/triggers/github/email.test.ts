import { describe, expect, it } from "vitest";
import { classifyGitHubEvent } from "./classification.js";
import { eventForNotification, githubNotified, parseNotificationMessageId } from "./email.js";

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
      "GET /repos/{owner}/{repo}": { id: 99, full_name: "octo/hub" },
      "GET /repos/{owner}/{repo}/issues/comments/{comment_id}": {
        id: 345,
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
    const event = await eventForNotification(octokit, ref, 42, "email:x");
    expect(event).toMatchObject({
      type: "issue_comment",
      repo: "octo/hub",
      repositoryId: 99,
      installationId: 42,
    });
    expect(classifyGitHubEvent(event)).toMatchObject({
      semanticEvent: "github.pull_request_comment_created",
      actor: "maintainer",
      text: "/paseo fix it",
      item: { type: "pull_request", number: 7 },
    });
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
});
