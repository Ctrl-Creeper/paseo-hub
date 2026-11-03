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
  /** The App installation whose connection receives emailed events for routing. */
  installationId?: number;
}

const userSchema = z.object({ id: z.number().int().positive(), login: z.string().min(1) });
const LEASE_MS = 60 * 60 * 1000;

export function readPersonalGitHubEnvironment(
  environment: NodeJS.ProcessEnv,
): PersonalGitHubEnvironment | undefined {
  const token = environment["GITHUB_PERSONAL_TOKEN"]?.trim();
  if (!token) return undefined;
  const imapUrl = environment["GITHUB_NOTIFY_IMAP_URL"]?.trim();
  if (!imapUrl) return { token };
  return {
    token,
    imapUrl,
    installationId: positiveInteger(environment, "GITHUB_NOTIFY_INSTALLATION_ID"),
  };
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string): number {
  const value = Number(environment[name]?.trim());
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new Error(`${name} must be a positive integer when GITHUB_NOTIFY_IMAP_URL is set`);
  }
  return value;
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
