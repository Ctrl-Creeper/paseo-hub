/** The YAML filter keys the form knows how to qualify. */
export type QualifierKey =
  | "label"
  | "repo"
  | "contains"
  | "exclude_contains"
  | "pattern"
  | "labels"
  | "exclude_labels"
  | "workspace"
  | "guild"
  | "channels"
  | "project"
  | "states"
  | "assignees";

/** Draft values for the qualifiers declared by the selected event; lists are comma-separated. */
export type QualifierValues = Partial<Record<QualifierKey, string>>;

export interface QualifierDefinition {
  key: QualifierKey;
  /** `list` is typed comma-separated and written as a YAML sequence. */
  kind: "string" | "list";
  label: string;
  description: string;
  required: boolean;
}

/**
 * Who may invoke a trigger, as the form offers it. `members` and `contributors` are GitHub
 * repository associations; `everyone` and `specific` are the allowlist every provider has.
 */
export type TriggerAudience = "members" | "contributors" | "everyone" | "specific";

interface EventDefinition {
  provider: "github" | "slack" | "discord" | "linear" | "manual" | "schedule" | "webhook";
  label: string;
  origin: "hub" | "provider";
  qualifiers: readonly QualifierDefinition[];
  /** The audiences the form offers for this event, default first. Empty when Hub is the source. */
  audiences: readonly TriggerAudience[];
}

const ALLOWLIST: readonly TriggerAudience[] = ["everyone", "specific"];

/** GitHub reports the actor's repository association on these events, so they start at members. */
const ASSOCIATION: readonly TriggerAudience[] = ["members", "contributors", ...ALLOWLIST];

function qualifier(
  key: QualifierKey,
  kind: QualifierDefinition["kind"],
  label: string,
  description: string,
  required = false,
): QualifierDefinition {
  return { key, kind, label, description, required };
}

const ADDED_LABEL = qualifier(
  "label",
  "string",
  "Added label",
  "Match the label added by this event, not labels already on the issue or pull request.",
  true,
);

const GITHUB_REPO = qualifier(
  "repo",
  "string",
  "Repository",
  "owner/name. Empty matches every repository the connection can see.",
);

const GITHUB_TEXT = [
  qualifier("contains", "string", "Text contains", "Only events whose text includes this."),
  qualifier(
    "exclude_contains",
    "string",
    "Text excludes",
    "Skip events whose text includes this, such as a command another trigger owns.",
  ),
  qualifier(
    "labels",
    "list",
    "Required labels",
    "Comma-separated. The issue or pull request must carry every one.",
  ),
] as const;

const GITHUB = [GITHUB_REPO, ...GITHUB_TEXT] as const;

const COMMAND = qualifier(
  "pattern",
  "string",
  "Command",
  "Only messages whose text after the mention starts with this word.",
);

const SLACK = [
  qualifier("workspace", "string", "Workspace ID", "Empty matches every workspace."),
  qualifier("channels", "list", "Channel IDs", "Comma-separated. Empty matches every channel."),
  COMMAND,
] as const;

const DISCORD = [
  qualifier("guild", "string", "Server ID", "Empty matches every server."),
  qualifier(
    "channels",
    "list",
    "Channel IDs",
    "Comma-separated. A thread matches its parent channel. Empty matches every channel.",
  ),
  COMMAND,
] as const;

function linear(projectRequired: boolean): readonly QualifierDefinition[] {
  return [
    qualifier(
      "project",
      "string",
      "Project ID",
      projectRequired ? "The Linear project an issue enters." : "Empty matches every project.",
      projectRequired,
    ),
    qualifier("states", "list", "State IDs", "Comma-separated workflow state IDs."),
    qualifier("assignees", "list", "Assignee IDs", "Comma-separated Linear user IDs."),
    qualifier(
      "labels",
      "list",
      "Required label IDs",
      "Comma-separated. The issue must carry every one.",
    ),
    qualifier(
      "exclude_labels",
      "list",
      "Excluded label IDs",
      "Comma-separated. Skip issues carrying any.",
    ),
  ];
}

const LINEAR_COMMENT = [
  ...linear(false),
  qualifier("pattern", "string", "Starts with", "Only comments that start with this."),
  qualifier("contains", "string", "Text contains", "Only comments that include this."),
];

function event(
  provider: EventDefinition["provider"],
  label: string,
  { qualifiers = [], audiences }: Partial<Pick<EventDefinition, "qualifiers" | "audiences">> = {},
): EventDefinition {
  const origin =
    provider === "manual" || provider === "schedule" || provider === "webhook" ? "hub" : "provider";
  return {
    provider,
    label,
    qualifiers,
    origin,
    audiences: audiences ?? (origin === "hub" ? [] : ALLOWLIST),
  };
}

/** A GitHub event where GitHub guarantees the sender authored the created object it carries. */
function authored(label: string, qualifiers: readonly QualifierDefinition[]): EventDefinition {
  return event("github", label, { qualifiers, audiences: ASSOCIATION });
}

// The order is the event picker's. The events Hub sends itself come first because they work
// before any integration is connected.
const EVENTS = {
  "webhook.received": event("webhook", "Webhook received"),
  "schedule.tick": event("schedule", "Schedule"),
  "manual.run": event("manual", "Manual run"),
  "slack.mention": event("slack", "Slack mention", { qualifiers: SLACK }),
  "discord.mention": event("discord", "Discord mention", { qualifiers: DISCORD }),
  "github.issue_created": authored("GitHub issue created", GITHUB),
  "github.pull_request_created": authored("GitHub pull request created", GITHUB),
  // A maintainer can mark another author's draft pull request ready or push to their fork branch;
  // in both cases GitHub reports only the pull request author's association, not the sender's.
  "github.pull_request_ready_for_review": event("github", "GitHub pull request ready for review", {
    qualifiers: GITHUB,
  }),
  "github.pull_request_synchronized": event(
    "github",
    "GitHub pull request updated with new commits",
    {
      qualifiers: GITHUB,
    },
  ),
  "github.issue_comment_created": authored("GitHub issue comment created", GITHUB),
  "github.pull_request_comment_created": authored("GitHub pull request comment created", GITHUB),
  // GitHub lets only people with triage access label, and the labeler is rarely the author
  // whose association the event reports, so these keep the plain allowlist.
  "github.issue_label_added": event("github", "GitHub issue label added", {
    qualifiers: [ADDED_LABEL, ...GITHUB],
  }),
  "github.pull_request_label_added": event("github", "GitHub pull request label added", {
    qualifiers: [ADDED_LABEL, ...GITHUB],
  }),
  // Raw multi-action webhooks also fire when a maintainer acts on another person's issue, pull
  // request, comment, or review, where GitHub omits the sender's association.
  "github.issue_comment": event("github", "GitHub issue or PR comment webhook", {
    qualifiers: GITHUB,
  }),
  "github.issues": event("github", "GitHub issue webhook", { qualifiers: GITHUB }),
  "github.pull_request": event("github", "GitHub pull request webhook", { qualifiers: GITHUB }),
  "github.pull_request_review": event("github", "GitHub pull request review webhook", {
    qualifiers: GITHUB,
  }),
  "github.pull_request_review_comment": event("github", "GitHub review comment webhook", {
    qualifiers: GITHUB,
  }),
  // GitHub restricts pushing to writers and reports no association on a push.
  "github.push": event("github", "GitHub push", { qualifiers: [GITHUB_REPO] }),
  "linear.issue_entered_scope": event("linear", "Linear issue entered scope", {
    qualifiers: linear(true),
  }),
  "linear.issue_assigned": event("linear", "Linear issue assigned", { qualifiers: linear(false) }),
  "linear.comment_created": event("linear", "Linear comment created", {
    qualifiers: LINEAR_COMMENT,
  }),
};

export type EditorEvent = keyof typeof EVENTS;
export const EDITOR_EVENTS = Object.keys(EVENTS).filter(isEditorEvent);

export function isEditorEvent(value: string): value is EditorEvent {
  return Object.hasOwn(EVENTS, value);
}

export function parseEditorEvent(value: string): EditorEvent {
  return isEditorEvent(value) ? value : "manual.run";
}

export function eventDefinition(eventId: EditorEvent): EventDefinition {
  return EVENTS[eventId];
}

const PROVIDERS: readonly EventDefinition["provider"][] = [
  "github",
  "slack",
  "discord",
  "linear",
  "manual",
  "schedule",
  "webhook",
];

/**
 * Where an event comes from. An event the editor offers says so itself; a YAML-only event such as
 * `discord.message` is named for its provider, and only an event from no provider Hub knows
 * counts as manual.
 */
export function eventProvider(eventId: string): EventDefinition["provider"] {
  if (isEditorEvent(eventId)) return EVENTS[eventId].provider;
  const prefix = eventId.split(".")[0];
  return PROVIDERS.find((provider) => provider === prefix) ?? "manual";
}

/** The audience a new trigger for this event starts with. */
export function defaultAudience(eventId: EditorEvent): TriggerAudience {
  return EVENTS[eventId].audiences[0] ?? "everyone";
}
