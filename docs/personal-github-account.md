# Acting as your own GitHub account

A GitHub App can only be installed by an owner or admin of the account it is installed on, so it
cannot reach repositories you only contribute to. Hub can also act as your own GitHub account,
using a personal access token, and learn about activity on those repositories from the
notification emails GitHub sends you.

The App and your account work side by side. Each workflow step chooses which one it acts as, and
the App keeps handling installation, webhooks, and configuration sync.

## Configure the Hub

| Variable                        | Purpose                                                                                                                                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_PERSONAL_TOKEN`         | A classic personal access token with the `repo` scope. Fine-grained tokens cannot write to repositories owned by someone else. Give it an expiry.                                                                                                                                      |
| `GITHUB_NOTIFY_IMAP_URL`        | Optional. `imaps://<user>:<password>@<host>:993` for the mailbox that receives your GitHub notification emails. Percent-encode `@` in the user as `%40`. Only `imaps://` is accepted.                                                                                                  |
| `GITHUB_NOTIFY_INSTALLATION_ID` | Required with `GITHUB_NOTIFY_IMAP_URL`. The App installation whose connection receives emailed events for routing; find it at github.com/settings/installations → Configure, as the number at the end of the URL. Emailed events reach the projects of that connection's organization. |

Set them as secrets, never in configuration files. Without `GITHUB_PERSONAL_TOKEN`, Hub behaves
exactly as before and steps asking for the account fail with a clear error.

## Choose the identity per step

```yaml
github:
  connection: my-github
  identity: account
```

- `identity: app` (the default) mints a short-lived installation token limited to `repositories`
  and `permissions`. Commits come from the App's bot. See
  [workflow authority](workflow-authority.md).
- `identity: account` puts the personal access token in `GH_TOKEN` and commits as your account,
  with your login and noreply address. The token reaches everything your account can, for as long
  as it is valid, so `repositories`, `permissions`, and `duration` are rejected rather than
  silently ignored. Hub never revokes it.

The trigger editor shows the same choice as **Act as: GitHub App / My account**. A step can also
read the token directly with `${{ paseo.connections.<slug>.account_token }}`; `token` remains
the App installation token.

## Replies and reactions

Hub's own `github.reply` output, failure notices, and progress reactions use the App on
repositories the App is installed on, and your account everywhere else. Comments Hub posts as your
account end with a hidden `<!-- paseo-hub -->` marker, and an event whose text contains it never
matches a trigger, so a reply cannot start another run.

That guard covers comments Hub posts. An agent that comments with `gh` as your account is not
marked; give such triggers a command prefix (`pattern`) or `exclude_contains` its replies cannot
satisfy.

## Receive events by email

GitHub only sends webhooks for repositories whose admins configure them, but it emails you about
activity on threads you take part in or repositories you watch. Forward those emails to a mailbox
Hub can read over IMAP:

1. Make sure GitHub sends notifications to an address you control (Settings → Notifications →
   Default notifications email).
2. Forward `from:notifications@github.com` to the Hub mailbox. In Gmail, add the mailbox under
   Settings → Forwarding and POP/IMAP, confirm it, then create a filter that forwards matching
   mail. Leave forwarding of all mail off.
3. Set `GITHUB_NOTIFY_IMAP_URL` and `GITHUB_NOTIFY_INSTALLATION_ID`.

Hub idles on the inbox and handles new mail within seconds. Each email is only a pointer:

- its `Message-ID` names the repository, item, and comment or review;
- Hub confirms through your notifications API that GitHub really notified you about that item;
- it fetches the content with your token and requires it to belong to that item and be under
  seven days old;
- the result enters the trigger pipeline exactly like a webhook delivery.

Supported: new issues, new pull requests, issue and pull request comments, and reviews. Pushes,
labels, and CI emails are skipped. Emails for repositories the App is installed on are skipped too,
because the webhook already delivered them. Mail GitHub refuses (deleted or forged content) is
marked read and dropped; rate limits and outages leave it unread and it is retried later.

GitHub never notifies you about your own actions, so your own comments on those repositories do
not start runs; other people's do.

### Writing triggers for emailed repositories

- Leave out `filters.repo`. It resolves against the App's repository catalog, which does not
  contain repositories the App is not installed on; a trigger without it matches every repository
  whose notifications reach you.
- `from_users` lists who may start a run, as usual.

## What this costs

- Every `identity: account` step can do anything your account can. Anyone who can merge workflow
  configuration into a connected project can write such a step.
- While a run is active, its token is stored unencrypted in the Hub database with its other
  credentials. A personal token lives far longer than an installation token, so protect database
  backups and set an expiry on the token.
