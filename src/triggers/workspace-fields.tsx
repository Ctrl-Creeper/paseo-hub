/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- workspace controls bind their own configuration */
import { useState } from "react";
import { CheckboxField } from "../components/app/checkbox-field.js";
import { Disclosure } from "../components/app/disclosure.js";
import { FormField } from "../components/app/form-field.js";
import { SegmentedControl, type SegmentedOption } from "../components/app/segmented-control.js";
import type { TriggerFieldErrors, TriggerFormValue } from "./configuration/editor.js";

type WorkspaceTextField =
  | "worktreeMode"
  | "worktreeBranch"
  | "worktreeBase"
  | "worktreePr"
  | "title"
  | "startupTimeout";

/** Where in the checkout a run works, and what is left of it afterwards. */
export function WorkspaceFields({
  form,
  errors,
  onChange,
}: {
  form: TriggerFormValue;
  errors: TriggerFieldErrors;
  onChange: (value: TriggerFormValue) => void;
}) {
  // Open when the trigger already departs from the defaults, so nothing it does is hidden.
  const [workspaceExpanded, setWorkspaceExpanded] = useState(
    form.worktreeMode !== "" ||
      form.title !== "" ||
      form.startupTimeout !== "" ||
      !form.autoArchive ||
      form.background,
  );
  const update = <Key extends keyof TriggerFormValue>(key: Key, value: TriggerFormValue[Key]) =>
    onChange({ ...form, [key]: value });
  const text = (key: WorkspaceTextField) => (value: string) => update(key, value);
  const fieldError = (key: WorkspaceTextField) => {
    const error = errors[key];
    return error === undefined ? {} : { error };
  };
  return (
    <Disclosure
      id="trigger-workspace"
      open={workspaceExpanded}
      onOpenChange={setWorkspaceExpanded}
      title="Workspace"
      description="Where in the checkout the agent works, and what happens to it afterwards."
    >
      <SegmentedControl
        label="Worktree"
        description="Worktree"
        value={form.worktreeMode === "" ? "none" : form.worktreeMode}
        onChange={(mode) => update("worktreeMode", mode === "none" ? "" : mode)}
        options={WORKTREE_OPTIONS}
      />
      {form.worktreeMode === "" || form.worktreeMode === "checkout-pr" ? null : (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id="trigger-worktree-branch"
            label={form.worktreeMode === "branch-off" ? "New branch" : "Branch"}
            description="Expressions such as ${{ paseo.execution.id }} are allowed."
            kind="text"
            name="worktreeBranch"
            value={form.worktreeBranch}
            onChange={text("worktreeBranch")}
            required
            {...fieldError("worktreeBranch")}
          />
          {form.worktreeMode === "branch-off" ? (
            <FormField
              id="trigger-worktree-base"
              label="Base"
              description="The ref to branch from, for example origin/main. Empty uses the checkout's default."
              kind="text"
              name="worktreeBase"
              value={form.worktreeBase}
              onChange={text("worktreeBase")}
            />
          ) : null}
        </div>
      )}
      {form.worktreeMode === "checkout-pr" ? (
        <FormField
          id="trigger-worktree-pr"
          label="Pull request number"
          kind="text"
          name="worktreePr"
          value={form.worktreePr}
          onChange={text("worktreePr")}
          required
          {...fieldError("worktreePr")}
        />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id="trigger-title"
          label="Workspace title"
          description="Literal text plus ${{ paseo.execution.id }}. Empty lets the daemon name it."
          kind="text"
          name="title"
          value={form.title}
          onChange={text("title")}
        />
        <FormField
          id="trigger-startup-timeout"
          label="Startup timeout"
          description="How long the agent may take to start, for example 3m. Empty uses the default."
          kind="text"
          name="startupTimeout"
          value={form.startupTimeout}
          onChange={text("startupTimeout")}
        />
      </div>
      <CheckboxField
        id="trigger-auto-archive"
        label="Archive the workspace when the run ends"
        description="Unticked, the workspace stays open on the daemon after the run."
        checked={form.autoArchive}
        onChange={(checked) => update("autoArchive", checked)}
      />
      <CheckboxField
        id="trigger-background"
        label="Background workspace"
        description="Hidden from workspace listings unless a client asks for background workspaces. Daemons without support ignore it."
        checked={form.background}
        onChange={(checked) => update("background", checked)}
      />
    </Disclosure>
  );
}

const WORKTREE_OPTIONS: readonly SegmentedOption[] = [
  { value: "none", label: "None", hint: "Work in the working directory itself." },
  {
    value: "branch-off",
    label: "New branch",
    hint: "Create a worktree on a new branch from a base ref.",
  },
  { value: "checkout-branch", label: "Branch", hint: "Create a worktree on an existing branch." },
  {
    value: "checkout-pr",
    label: "Pull request",
    hint: "Create a worktree on a pull request's head.",
  },
];
