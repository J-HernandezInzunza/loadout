// PR write mode (WRITE-07..12, rebuilt per architecture.md §5.5): a protected catalog only changes
// through pull requests. The edit is made in a temporary single-branch clone, committed on a new
// branch and pushed; then the PR is opened through the host's API when an account is connected,
// else the result carries the compare URL to open it by hand. An API failure is a warning with the
// compare URL; a PR that already exists is its URL (Q2). The temp clone is always removed.
import type { Accounts } from "../accounts/accounts.ts";
import type { ApiBases } from "../accounts/apiBases.ts";
import { catalogUrls } from "../catalogs/catalogs.ts";
import type { CallOpts, GitClient } from "../git/git.ts";
import { createOperation, type Operation } from "../git/operation.ts";
import { createPullRequest } from "../git/pullRequests.ts";
import type { Host } from "../host.ts";
import { err, ok, type Result, type Warning } from "../model/model.ts";
import type { CatalogState } from "../registry/registry.ts";
import { remoteWeb } from "../source/source.ts";
import { editCopy } from "./copy.ts";
import { applyCatalogEdit, planCatalogEdit, type CatalogEdit, type EditPlan, type WriteResult } from "./edit.ts";

export interface PrCtx {
  host: Host;
  git: GitClient;
  /** absent or not connected: the result is manual, with the compare URL */
  accounts?: Pick<Accounts, "tokenFor">;
  apiBases?: ApiBases;
}

type RemoteRef = Extract<CatalogState["ref"], { kind: "remote" }>;

export interface PrPlan {
  edit: CatalogEdit;
  plan: EditPlan;
  dryRun: boolean;
  /** the temporary clone, inside `op` */
  clone: string;
  op: Operation;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** WRITE-08 (rebuild) for a catalog edit. */
export function prBranchName(edit: CatalogEdit, now: Date): string {
  const [op, name] =
    edit.op === "add"
      ? edit.entries.length === 1
        ? ["add", edit.entries[0]!.name]
        : ["add-batch", `${edit.entries.length}-entries`]
      : [edit.op, edit.name];
  return branchName(op, name, now);
}

/** WRITE-08 (rebuild): `library/<op>-<name>-<local %Y%m%dT%H%M%S>`. */
export function branchName(op: string, name: string, now: Date): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `library/${op}-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}-${stamp}`;
}

/** WRITE-10: where to open the PR by hand; null for a host Loadout doesn't know. */
export function compareUrl(repo: string, base: string, branch: string): string | null {
  const web = remoteWeb(repo);
  if (!web) return null;
  const [host, owner, name] = web;
  if (host === "github.com") return `https://github.com/${owner}/${name}/compare/${base}...${branch}?expand=1`;
  if (host === "bitbucket.org") return `https://bitbucket.org/${owner}/${name}/pull-requests/new?source=${branch}&dest=${base}`;
  return null;
}

export async function planPrWrite(ctx: PrCtx, catalog: CatalogState, edit: CatalogEdit, opts: CallOpts & { dryRun?: boolean } = {}): Promise<Result<PrPlan>> {
  if (catalog.ref.kind !== "remote") return err({ code: "REFUSED", message: `catalog '${catalog.ref.id}' is local; it is written in place` });
  const ref = catalog.ref;
  const op = await createOperation(ctx.host, ctx.git);
  const clone = op.path("pr");
  const cloned = await ctx.git.clone(await catalogUrls(ctx.git, ref), clone, { ...opts, branch: ref.branch });
  if (!cloned.ok) {
    await op.dispose();
    return err({ code: "GIT_FAILED", message: `failed to clone ${ref.repo} for the write: ${cloned.error.message}` });
  }
  const planned = await planCatalogEdit(ctx.host, { file: `${clone}/${ref.yamlPath}`, displayName: ref.yamlPath }, edit);
  if (!planned.ok) {
    await op.dispose();
    return planned;
  }
  return ok({ edit, plan: planned.value, dryRun: opts.dryRun ?? false, clone, op });
}

/** WRITE-08 (A15 fix): a branch name not yet on the remote, adding -2, -3, … when taken. */
export async function freeBranch(git: GitClient, clone: string, wanted: string): Promise<string> {
  const origin = [await git.originUrl(clone)];
  for (let n = 1; ; n++) {
    const name = n === 1 ? wanted : `${wanted}-${n}`;
    if ((await git.lsRemoteHead(origin, name)) === null) return name;
  }
}

export async function applyPrWrite(ctx: PrCtx, catalog: CatalogState, pr: PrPlan, opts: CallOpts = {}): Promise<Result<WriteResult>> {
  const ref = catalog.ref as RemoteRef;
  const id = ref.id;
  try {
    if (!pr.plan.changed) return ok({ mode: "pr", catalog: id, changed: false, method: "manual", branch: null });
    const written = await applyCatalogEdit(ctx.host, pr.plan);
    if (!written.ok) return written;

    const copy = editCopy(pr.edit);
    const branch = await freeBranch(ctx.git, pr.clone, prBranchName(pr.edit, ctx.host.now()));
    const checkedOut = await ctx.git.checkoutBranch(pr.clone, branch);
    if (!checkedOut.ok) return checkedOut;
    const committed = await ctx.git.commit(pr.clone, [ref.yamlPath], copy.commit);
    if (!committed.ok) return committed;
    // WRITE-17: a dry run shows the commit it would push, and pushes nothing.
    if (pr.dryRun) return ok({ mode: "pr", catalog: id, changed: true, method: "manual", branch, diff: await ctx.git.showHead(pr.clone) });

    const opened = await pushAndOpenPr(ctx, pr.clone, { repo: ref.repo, base: ref.branch, branch, title: copy.title, body: copy.body }, opts);
    return opened.ok ? { ...opened, value: { mode: "pr", catalog: id, changed: true, ...opened.value } } : opened;
  } finally {
    await pr.op.dispose();
  }
}

export type OpenedPr = { method: "api" | "manual"; branch: string; prUrl?: string; compareUrl: string | null };

/**
 * WRITE-09..11: pushes the checked-out `branch` of `clone` (`-u`), then opens its PR into `base` through
 * the host's API when an account is connected; otherwise, or when the API fails (a warning), the
 * result is manual with the compare URL.
 */
export async function pushAndOpenPr(
  ctx: PrCtx,
  clone: string,
  pr: { repo: string; base: string; branch: string; title: string; body: string },
  opts: CallOpts = {},
): Promise<Result<OpenedPr>> {
  const { repo, base, branch } = pr;
  const pushed = await ctx.git.push(clone, branch, { ...opts, args: ["-u"] });
  if (!pushed.ok) return pushed;

  const compare = compareUrl(repo, base, branch);
  const manual = { method: "manual" as const, branch, compareUrl: compare };
  const web = remoteWeb(repo);
  const kind = web?.[0] === "github.com" ? "github" : web?.[0] === "bitbucket.org" ? "bitbucket" : null;
  if (!kind || !web || !ctx.accounts) return ok(manual);

  const opened = await createPullRequest(
    { host: ctx.host, accounts: ctx.accounts, ...(ctx.apiBases && { apiBases: ctx.apiBases }) },
    { kind, org: web[1], repo: web[2] },
    { base, head: branch, title: pr.title, body: pr.body },
  );
  if (opened.ok) return ok({ method: "api", branch, prUrl: opened.value.url, compareUrl: compare });
  if (opened.error.code === "NOT_CONNECTED") return ok(manual);
  const warning: Warning = { message: `the branch is pushed, but the pull request couldn't be opened (${opened.error.message}); open it from ${compare ?? "the host"}` };
  return ok(manual, [warning]);
}
