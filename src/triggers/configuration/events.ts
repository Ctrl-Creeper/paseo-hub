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

interface EventDefinition {
  provider: "github" | "slack" | "discord" | "linear" | "manual" | "schedule";
  label: string;
  origin: "hub" | "provider";
  qualifiers: readonly QualifierDefinition[];
}

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
  qualifiers: readonly QualifierDefinition[] = [],
): EventDefinition {
  return {
    provider,
    label,
    qualifiers,
    origin: provider === "manual" || provider === "schedule" ? "hub" : "provider",
  };
}

const EVENTS = {
  "slack.mention": event("slack", "Slack mention", SLACK),
  "discord.mention": event("discord", "Discord mention", DISCORD),
  "github.issue_created": event("github", "GitHub issue created", GITHUB),
  "github.pull_request_created": event("github", "GitHub pull request created", GITHUB),
  "github.pull_request_ready_for_review": event(
    "github",
    "GitHub pull request ready for review",
    GITHUB,
  ),
  "github.pull_request_synchronized": event(
    "github",
    "GitHub pull request updated with new commits",
    GITHUB,
  ),
  "github.issue_comment_created": event("github", "GitHub issue comment created", GITHUB),
  "github.pull_request_comment_created": event(
    "github",
    "GitHub pull request comment created",
    GITHUB,
  ),
  "github.issue_label_added": event("github", "GitHub issue label added", [ADDED_LABEL, ...GITHUB]),
  "github.pull_request_label_added": event("github", "GitHub pull request label added", [
    ADDED_LABEL,
    ...GITHUB,
  ]),
  "github.issue_comment": event("github", "GitHub issue or PR comment webhook", GITHUB),
  "github.issues": event("github", "GitHub issue webhook", GITHUB),
  "github.pull_request": event("github", "GitHub pull request webhook", GITHUB),
  "github.pull_request_review": event("github", "GitHub pull request review webhook", GITHUB),
  "github.pull_request_review_comment": event("github", "GitHub review comment webhook", GITHUB),
  "github.push": event("github", "GitHub push", [GITHUB_REPO]),
  "linear.issue_entered_scope": event("linear", "Linear issue entered scope", linear(true)),
  "linear.issue_assigned": event("linear", "Linear issue assigned", linear(false)),
  "linear.comment_created": event("linear", "Linear comment created", LINEAR_COMMENT),
  "schedule.tick": event("schedule", "Schedule"),
  "manual.run": event("manual", "Manual run"),
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
