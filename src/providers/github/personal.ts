import { Octokit } from "octokit";
import { z } from "zod";

/**
 * A personal GitHub account Hub acts as instead of the App bot: agent `GH_TOKEN`, git identity,
 * replies, and reactions. The App stays responsible for installations, webhooks, and
 * configuration sync.
 *
 * ponytail: a personal access token cannot be narrowed per run, so every run gets the account's
 * full access. `github.repositories` / `permissions` still route and validate, but do not scope
 * the token. Fine-grained tokens can't write to repositories the account doesn't own; use classic.
 */
export interface PersonalGitHubAccount {
  token: string;
  octokit: Octokit;
  identity(): Promise<{ id: number; login: string }>;
  /** Leases need an expiry; the PAT itself outlives it and is never revoked by Hub. */
  lease(): { token: string; expiresAt: number };
}

export interface PersonalGitHubEnvironment {
  token: string;
  /** imaps://user:pass@host:993 — the mailbox Gmail forwards GitHub notifications into. */
  imapUrl?: string;
  /**
   * The only App installation whose connection may use the account: its projects can ask for
   * `identity: account` or `account_token`, Hub replies as the account on its events, and emailed
   * events are routed to it. Any other organization on the Hub never sees the token.
   */
  installationId: number;
}

const userSchema = z.object({ id: z.number().int().positive(), login: z.string().min(1) });
const LEASE_MS = 60 * 60 * 1000;

export function readPersonalGitHubEnvironment(
  environment: NodeJS.ProcessEnv,
): PersonalGitHubEnvironment | undefined {
  const token = environment["GITHUB_PERSONAL_TOKEN"]?.trim();
  if (!token) return undefined;
  const installationId = Number(environment["GITHUB_PERSONAL_INSTALLATION_ID"]?.trim());
  if (!(Number.isSafeInteger(installationId) && installationId > 0)) {
    throw new Error(
      "GITHUB_PERSONAL_INSTALLATION_ID must name the App installation allowed to use GITHUB_PERSONAL_TOKEN",
    );
  }
  const imapUrl = environment["GITHUB_NOTIFY_IMAP_URL"]?.trim();
  return { token, installationId, ...(imapUrl ? { imapUrl } : {}) };
}

export function createPersonalGitHubAccount(
  token: string,
  fetchOverride?: typeof fetch,
): PersonalGitHubAccount {
  const octokit = new Octokit({
    auth: token,
    ...(fetchOverride === undefined ? {} : { request: { fetch: fetchOverride } }),
  });
  let identity: Promise<{ id: number; login: string }> | undefined;
  return {
    token,
    octokit,
    identity() {
      identity ??= octokit.request("GET /user").then(
        (response) => userSchema.parse(response.data),
        (error: unknown) => {
          identity = undefined;
          throw error;
        },
      );
      return identity;
    },
    lease: () => ({ token, expiresAt: Date.now() + LEASE_MS }),
  };
}
