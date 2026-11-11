import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { z } from "zod";
import type { Octokit } from "octokit";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import type { ProviderEventAcceptance } from "../../db/types.js";
import { logger } from "../../logger.js";
import { logProviderEventIntake } from "../audit.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
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
  /^<?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)(?:\/c?(\d+)|\/review\/(\d+))?@github\.com>?$/u;

export function parseNotificationMessageId(messageId: string): NotificationRef | undefined {
  const match = MESSAGE_ID.exec(messageId.trim());
  if (match === null) return undefined;
  const [, owner, repo, type, number, commentId, reviewId] = match;
  // "." and ".." would turn the API path into a different endpoint.
  if (/^\.+$/u.test(owner!) || /^\.+$/u.test(repo!)) return undefined;
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
  /** When the email was sent; the thread was updated no earlier than shortly before it. */
  sentAt?: Date,
): Promise<boolean> {
  const earliest = now - NOTIFIED_WITHIN_MS;
  const sent = sentAt?.getTime();
  const since =
    sent === undefined || Number.isNaN(sent) ? earliest : Math.max(earliest, sent - 10 * 60_000);
  const subject = new RegExp(`/(?:issues|pulls)/${ref.number}$`, "u");
  // ponytail: up to 500 threads; a repository busier than that within the window is out of scope.
  for (let page = 1; page <= 10; page += 1) {
    const threads = await octokit.request("GET /repos/{owner}/{repo}/notifications", {
      owner: ref.owner,
      repo: ref.repo,
      all: true,
      since: new Date(since).toISOString(),
      per_page: 50,
      page,
    });
    if (threads.data.some((thread) => subject.test(thread.subject.url ?? ""))) return true;
    if (threads.data.length < 50) return false;
  }
  return false;
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
  /** Repositories the App is installed on already deliver webhooks; their emails are skipped. */
  appInstalled(repositoryId: number): Promise<boolean>;
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
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
}

const RECONNECT_MIN_MS = 30_000;
const RECONNECT_MAX_MS = 15 * 60_000;
/**
 * IDLE alone missed mail: a connection the server or a NAT dropped silently raised no `close`, so
 * nothing new was ever announced. A periodic drain both catches what IDLE missed and, by issuing a
 * command, surfaces a dead socket so it closes and reconnects.
 */
const POLL_MS = 2 * 60_000;

/**
 * Whether retrying can't help: the content is gone, never existed, or is forbidden. Rate limits
 * (429, and 403 with no remaining quota) are transient and stay unread for a later drain.
 */
const GitHubFailureSchema = z.object({
  status: z.number(),
  response: z.object({ headers: z.record(z.string(), z.unknown()).optional() }).optional(),
});

export function permanentGitHubFailure(error: unknown): boolean {
  const parsed = GitHubFailureSchema.safeParse(error);
  if (!parsed.success) return false;
  const { status, response } = parsed.data;
  if (status < 400 || status >= 500 || status === 429) return false;
  return status !== 403 || response?.headers?.["x-ratelimit-remaining"] !== "0";
}

export function createEmailSource(options: EmailSourceOptions): TriggerSource {
  const handlers = new Set<TriggerHandler>();
  const url = new URL(options.imapUrl);
  // The URL carries the mailbox password, so it is never sent in clear.
  if (url.protocol !== "imaps:") {
    throw new Error("GITHUB_NOTIFY_IMAP_URL must use imaps://");
  }
  let client: ImapFlow | undefined;
  let stopped = true;
  let reconnect: NodeJS.Timeout | undefined;
  let reconnectDelay = RECONNECT_MIN_MS;
  let draining: Promise<void> = Promise.resolve();

  async function handleMessage(messageId: string, sentAt: Date | undefined): Promise<void> {
    const ref = parseNotificationMessageId(messageId);
    if (ref === undefined) {
      logger.debug({ messageId }, "skipping email that is not a supported GitHub notification");
      return;
    }
    if (!(await githubNotified(options.octokit, ref, Date.now(), sentAt))) {
      logger.warn({ messageId }, "dropping email with no matching GitHub notification");
      return;
    }
    const event = await eventForNotification(options.octokit, ref, options.installationId);
    if (event === undefined) {
      logger.warn({ messageId }, "dropping email whose content is stale or belongs elsewhere");
      return;
    }
    if (await options.appInstalled(event.repositoryId)) {
      logger.debug({ messageId }, "skipping email for a repository the App delivers by webhook");
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
      // Accepted with no handler would never start a run; record why instead.
      ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" as const } : {}),
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

  /**
   * Processes every unseen message. A transient failure leaves it unseen so a later drain retries;
   * a permanent one (deleted or forged content) marks it seen so it can't be replayed forever.
   */
  async function drain(imap: ImapFlow): Promise<void> {
    const uids = (await imap.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids) {
      if (stopped) return;
      const range = String(uid);
      try {
        const message = await imap.fetchOne(range, { envelope: true }, { uid: true });
        if (message === false) continue;
        const messageId = message.envelope?.messageId;
        if (messageId !== undefined)
          await handleMessage(messageId, sentDate(message.envelope?.date));
        await imap.messageFlagsAdd(range, ["\\Seen"], { uid: true });
      } catch (error) {
        if (!permanentGitHubFailure(error)) {
          logger.warn({ err: error, uid }, "github notification email failed; will retry");
          continue;
        }
        logger.warn({ err: error, uid }, "dropping github notification email GitHub refused");
        await imap.messageFlagsAdd(range, ["\\Seen"], { uid: true }).catch(() => undefined);
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
      port: Number(url.port || 993),
      secure: true,
      auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) },
      logger: false,
    });
    client = imap;
    let poll: ReturnType<typeof setInterval> | undefined;
    imap.on("error", (error: unknown) =>
      logger.warn({ err: error }, "github notification imap error"),
    );
    imap.on("close", () => {
      clearInterval(poll);
      // Only the current connection reconnects, so a stop and start can't leave two running.
      if (client !== imap) return;
      client = undefined;
      if (stopped) return;
      reconnect = setTimeout(() => void connect(), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    });
    // The server announces new mail while imapflow idles on the selected mailbox.
    imap.on("exists", () => scheduleDrain(imap));
    try {
      await imap.connect();
      await imap.mailboxOpen("INBOX");
      logger.info({ host: url.hostname }, "listening for github notification emails");
      reconnectDelay = RECONNECT_MIN_MS;
      scheduleDrain(imap);
      poll = setInterval(() => scheduleDrain(imap), POLL_MS);
    } catch (error) {
      logger.error(
        { err: error, retryInMs: reconnectDelay },
        "github notification imap connect failed; check GITHUB_NOTIFY_IMAP_URL",
      );
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

function sentDate(value: Date | string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
