import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import type { Octokit } from "octokit";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import type { ProviderEventAcceptance } from "../../db/types.js";
import { logger } from "../../logger.js";
import { logProviderEventIntake } from "../audit.js";
import type { TriggerHandler, TriggerSource } from "../index.js";

/**
 * GitHub notification emails as a trigger source, for repositories where the App can't be
 * installed. The email is only a pointer: its Message-ID names the repository, item, and comment.
 * Hub acts on it only if the notifications API confirms GitHub notified the account about that
 * item, then fetches the content from the API with the personal token.
 *
 * ponytail: covers issue/PR openings, conversation comments, and reviews. Inline review comments
 * arrive inside their review; pushes, labels, and CI mails are skipped. Add parsers when needed.
 */
export type NotificationRef =
  | { kind: "issue_opened" | "pull_request_opened"; owner: string; repo: string; number: number }
  | { kind: "comment"; owner: string; repo: string; number: number; commentId: number }
  | { kind: "review"; owner: string; repo: string; number: number; reviewId: number };

// <owner/repo/issues/12@github.com>, <owner/repo/pull/12/c345@github.com>,
// <owner/repo/issues/12/345@github.com>, <owner/repo/pull/12/review/678@github.com>
const MESSAGE_ID =
  /^<?([^/\s<>]+)\/([^/\s<>]+)\/(issues|pull)\/(\d+)(?:\/c?(\d+)|\/review\/(\d+))?@github\.com>?$/u;

export function parseNotificationMessageId(messageId: string): NotificationRef | undefined {
  const match = MESSAGE_ID.exec(messageId.trim());
  if (match === null) return undefined;
  const [, owner, repo, type, number, commentId, reviewId] = match;
  const base = { owner: owner!, repo: repo!, number: Number(number) };
  if (commentId !== undefined) return { kind: "comment", ...base, commentId: Number(commentId) };
  if (reviewId !== undefined) {
    return type === "pull" ? { kind: "review", ...base, reviewId: Number(reviewId) } : undefined;
  }
  return { kind: type === "pull" ? "pull_request_opened" : "issue_opened", ...base };
}

const NOTIFIED_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether GitHub itself notified the token's account about this issue or PR recently. Anyone can
 * send the mailbox a forged Message-ID; only a real notification thread proves GitHub sent it.
 */
export async function githubNotified(
  octokit: Pick<Octokit, "request">,
  ref: NotificationRef,
  now: number = Date.now(),
): Promise<boolean> {
  const threads = await octokit.request("GET /repos/{owner}/{repo}/notifications", {
    owner: ref.owner,
    repo: ref.repo,
    all: true,
    since: new Date(now - NOTIFIED_WITHIN_MS).toISOString(),
    per_page: 50,
  });
  const subject = new RegExp(`/(?:issues|pulls)/${ref.number}$`, "u");
  return threads.data.some((thread) => subject.test(thread.subject.url ?? ""));
}

/**
 * Identifies the GitHub content, not the email, so differently spelled mails (renamed repository,
 * other casing) can't replay it. Both opening shapes share one key.
 */
export function notificationDeliveryId(ref: NotificationRef, repositoryId: number): string {
  let detail: number | string = "";
  if (ref.kind === "comment") detail = ref.commentId;
  if (ref.kind === "review") detail = ref.reviewId;
  const kind = ref.kind === "comment" || ref.kind === "review" ? ref.kind : "opened";
  return `email:${repositoryId}/${kind}/${ref.number}/${detail}`;
}

/** The fetched content must belong to the item the email names and be recent, or it's a replay. */
function boundToRef(
  parentUrl: string | null | undefined,
  createdAt: string | null | undefined,
  expectedParent: string,
  now: number,
): boolean {
  return parentUrl === expectedParent && Date.parse(createdAt ?? "") >= now - NOTIFIED_WITHIN_MS;
}

/**
 * Rebuilds the webhook-shaped event GitHub would have delivered for this notification, or
 * `undefined` when the referenced content doesn't belong to the named item or is too old.
 */
export async function eventForNotification(
  octokit: Pick<Octokit, "request">,
  ref: NotificationRef,
  installationId: number,
  now: number = Date.now(),
): Promise<NormalizedGitHubEvent | undefined> {
  const target = { owner: ref.owner, repo: ref.repo };
  const repository = (await octokit.request("GET /repos/{owner}/{repo}", target)).data;
  // Exact API URLs under the canonical repository, so content can't come from another repository.
  const issueUrl = `${repository.url}/issues/${ref.number}`;
  const pullUrl = `${repository.url}/pulls/${ref.number}`;
  const common = { repository, installation: { id: installationId } };
  let type: string;
  let payload: Record<string, unknown>;
  if (ref.kind === "comment") {
    const [comment, issue] = await Promise.all([
      octokit.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        ...target,
        comment_id: ref.commentId,
      }),
      octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        ...target,
        issue_number: ref.number,
      }),
    ]);
    if (!boundToRef(comment.data.issue_url, comment.data.created_at, issueUrl, now))
      return undefined;
    type = "issue_comment";
    payload = {
      action: "created",
      comment: comment.data,
      issue: issue.data,
      sender: comment.data.user,
    };
  } else if (ref.kind === "review") {
    const [review, pullRequest] = await Promise.all([
      octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}", {
        ...target,
        pull_number: ref.number,
        review_id: ref.reviewId,
      }),
      octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...target,
        pull_number: ref.number,
      }),
    ]);
    if (!boundToRef(review.data.pull_request_url, review.data.submitted_at, pullUrl, now))
      return undefined;
    type = "pull_request_review";
    payload = {
      action: "submitted",
      review: review.data,
      pull_request: pullRequest.data,
      sender: review.data.user,
    };
  } else if (ref.kind === "pull_request_opened") {
    const pullRequest = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      ...target,
      pull_number: ref.number,
    });
    if (!boundToRef(pullRequest.data.url, pullRequest.data.created_at, pullUrl, now))
      return undefined;
    type = "pull_request";
    payload = { action: "opened", pull_request: pullRequest.data, sender: pullRequest.data.user };
  } else {
    const issue = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      ...target,
      issue_number: ref.number,
    });
    // The issues API also returns pull requests; a PR's opening mail uses the /pull/ id.
    // A pull request reached through the /issues/ form is not a new issue.
    if (
      issue.data.pull_request !== undefined ||
      !boundToRef(issue.data.url, issue.data.created_at, issueUrl, now)
    )
      return undefined;
    type = "issues";
    payload = { action: "opened", issue: issue.data, sender: issue.data.user };
  }
  return {
    id: notificationDeliveryId(ref, repository.id),
    type,
    repo: repository.full_name,
    repositoryId: repository.id,
    installationId,
    payload: { ...payload, ...common },
    createdAt: new Date().toISOString(),
  };
}

export interface EmailSourceOptions {
  /** imaps://user:pass@host:993 — the mailbox Gmail forwards GitHub notifications into. */
  imapUrl: string;
  installationId: number;
  octokit: Pick<Octokit, "request">;
  accept(input: {
    installationId: number;
    repositoryId: number;
    deliveryId: string;
    signatureHash: string;
    source: string;
    repo: string;
    payload: unknown;
    receivedAt: Date;
  }): Promise<ProviderEventAcceptance>;
}

const RECONNECT_MS = 30_000;

export function createEmailSource(options: EmailSourceOptions): TriggerSource {
  const handlers = new Set<TriggerHandler>();
  const url = new URL(options.imapUrl);
  if (url.protocol !== "imaps:" && url.protocol !== "imap:") {
    throw new Error("GITHUB_NOTIFY_IMAP_URL must use imaps:// or imap://");
  }
  let client: ImapFlow | undefined;
  let stopped = true;
  let reconnect: NodeJS.Timeout | undefined;
  let draining: Promise<void> = Promise.resolve();

  async function handleMessage(messageId: string): Promise<void> {
    const ref = parseNotificationMessageId(messageId);
    if (ref === undefined) {
      logger.debug({ messageId }, "skipping email that is not a supported GitHub notification");
      return;
    }
    if (!(await githubNotified(options.octokit, ref))) {
      logger.warn({ messageId }, "dropping email with no matching GitHub notification");
      return;
    }
    const event = await eventForNotification(options.octokit, ref, options.installationId);
    if (event === undefined) {
      logger.warn({ messageId }, "dropping email whose content is stale or belongs elsewhere");
      return;
    }
    const deliveryId = event.id;
    const source = `github.${event.type}`;
    const acceptance = await options.accept({
      installationId: event.installationId,
      repositoryId: event.repositoryId,
      deliveryId,
      signatureHash: createHash("sha256").update(deliveryId).digest("hex"),
      source,
      repo: event.repo,
      payload: event,
      receivedAt: new Date(event.createdAt),
    });
    logProviderEventIntake({
      provider: "github",
      source,
      deliveryId,
      repository: event.repo,
      resourceId: String(event.repositoryId),
      acceptance,
    });
    if (acceptance.status !== "accepted") return;
    await Promise.all(
      acceptance.events.flatMap((trigger) => Array.from(handlers, (handler) => handler(trigger))),
    );
  }

  /** Processes every unseen message. A message stays unseen when handling fails, so it retries. */
  async function drain(imap: ImapFlow): Promise<void> {
    const uids = (await imap.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids) {
      const message = await imap.fetchOne(String(uid), { envelope: true }, { uid: true });
      if (message === false) continue;
      try {
        const messageId = message.envelope?.messageId;
        if (messageId !== undefined) await handleMessage(messageId);
        await imap.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      } catch (error) {
        logger.warn({ err: error, uid }, "github notification email failed; will retry");
      }
    }
  }

  function scheduleDrain(imap: ImapFlow) {
    draining = draining
      .then(() => drain(imap))
      .catch((error: unknown) => logger.warn({ err: error }, "github notification drain failed"));
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const imap = new ImapFlow({
      host: url.hostname,
      port: Number(url.port || (url.protocol === "imaps:" ? 993 : 143)),
      secure: url.protocol === "imaps:",
      auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) },
      logger: false,
    });
    client = imap;
    imap.on("error", (error: unknown) =>
      logger.warn({ err: error }, "github notification imap error"),
    );
    imap.on("close", () => {
      if (client === imap) client = undefined;
      if (!stopped) reconnect = setTimeout(() => void connect(), RECONNECT_MS);
    });
    // The server announces new mail while imapflow idles on the selected mailbox.
    imap.on("exists", () => scheduleDrain(imap));
    try {
      await imap.connect();
      await imap.mailboxOpen("INBOX");
      logger.info({ host: url.hostname }, "listening for github notification emails");
      scheduleDrain(imap);
    } catch (error) {
      logger.warn({ err: error }, "github notification imap connect failed");
      imap.close();
    }
  }

  return {
    async start(handler) {
      handlers.add(handler);
      if (!stopped) return;
      stopped = false;
      // A slow or unreachable mail server must not hold up Hub startup; connect() retries.
      void connect();
    },
    async stop() {
      stopped = true;
      handlers.clear();
      clearTimeout(reconnect);
      const imap = client;
      client = undefined;
      await draining;
      await imap?.logout().catch(() => imap.close());
    },
  };
}
