import { parseScopeId, scopeId } from "../types.ts";

type Params = Readonly<Record<string, string>>;

export type ManagerAccess =
  | { kind: "allow" }
  | { kind: "deny" }
  | { kind: "scope"; orgMeansEveryScope: boolean; target?: (params: Params) => string }
  | { kind: "narrowed" };

export interface ManagerRule {
  method: string;
  path: string;
  access: ManagerAccess;
}

const allow: ManagerAccess = { kind: "allow" };
const deny: ManagerAccess = { kind: "deny" };
const narrowed: ManagerAccess = { kind: "narrowed" };
const requestedScope: ManagerAccess = { kind: "scope", orgMeansEveryScope: false };
const everyScope: ManagerAccess = { kind: "scope", orgMeansEveryScope: true };
const scopeParam = (target: (params: Params) => string): ManagerAccess => ({
  kind: "scope",
  orgMeansEveryScope: false,
  target,
});

const personalScopeOf = scopeParam((p) => scopeId("personal", p.principalId ?? ""));

const rule = (method: string, path: string, access: ManagerAccess): ManagerRule => ({ method, path, access });

export const MANAGER_RULES: readonly ManagerRule[] = [
  rule("GET", "/v1/admin/whoami", allow),
  rule("GET", "/v1/admin/slack-installation", allow),
  rule("PUT", "/v1/admin/slack-installation", allow),
  rule("DELETE", "/v1/admin/slack-installation", allow),
  rule("POST", "/v1/admin/slack-installation/start", allow),
  rule("GET", "/v1/admin/slack-emoji", allow),
  rule("GET", "/v1/admin/model-providers", allow),
  rule("PUT", "/v1/admin/model-providers/:provider", allow),
  rule("DELETE", "/v1/admin/model-providers/:provider", allow),
  rule("GET", "/v1/admin/mcp-servers", allow),
  rule("PUT", "/v1/admin/mcp-servers/:id", allow),
  rule("DELETE", "/v1/admin/mcp-servers/:id", allow),
  rule("POST", "/v1/admin/model-registry/lookup", allow),
  rule("POST", "/v1/admin/model-registry/:model/enable", allow),
  rule("GET", "/v1/admin/model-registry", allow),
  rule("PUT", "/v1/admin/model-registry/:model", allow),
  rule("DELETE", "/v1/admin/model-registry/:model", allow),
  rule("GET", "/v1/admin/custom-providers", allow),
  rule("PUT", "/v1/admin/custom-providers/:provider", allow),
  rule("DELETE", "/v1/admin/custom-providers/:provider", allow),
  rule("GET", "/v1/admin/resources", allow),
  rule("GET", "/v1/admin/retention", allow),
  rule("GET", "/v1/admin/users", allow),
  rule("GET", "/v1/admin/directory", allow),
  rule("GET", "/v1/admin/principal-links", allow),
  rule("POST", "/v1/admin/external-users", allow),
  rule("DELETE", "/v1/admin/external-users/:email", allow),
  rule("POST", "/v1/admin/skill-packs", allow),
  rule("GET", "/v1/admin/skill-packs", allow),
  rule("GET", "/v1/admin/skill-packs/:id/catalog", allow),
  rule("DELETE", "/v1/admin/skill-packs/:id", allow),
  rule("POST", "/v1/admin/skill-packs/:id/import", allow),
  rule("POST", "/v1/admin/skill-packs/:id/sync", allow),
  rule("PATCH", "/v1/admin/skill-packs/:id", allow),
  rule("POST", "/v1/auth/broker/sessions/revoke", allow),
  rule("GET", "/v1/admin/spend", allow),

  rule("GET", "/v1/admin/scopes/:scope", requestedScope),
  rule("GET", "/v1/admin/scopes/:scope/credential-usage", requestedScope),
  rule("PUT", "/v1/admin/scopes/:scope/:resource", requestedScope),
  rule("GET", "/v1/admin/memory", requestedScope),
  rule("POST", "/v1/admin/memory", requestedScope),
  rule("PATCH", "/v1/admin/memory", requestedScope),
  rule("DELETE", "/v1/admin/memory", requestedScope),
  rule("GET", "/v1/admin/files/read", requestedScope),
  rule("GET", "/v1/admin/files/download", requestedScope),
  rule("POST", "/v1/admin/files/upload", requestedScope),
  rule("*", "/v1/admin/deployments/:id/proxy/*", requestedScope),
  rule("GET", "/v1/admin/users/:principalId", personalScopeOf),
  rule("PUT", "/v1/admin/users/:principalId/onboarding", personalScopeOf),
  rule("POST", "/v1/admin/users/:principalId/reset", personalScopeOf),
  rule(
    "GET",
    "/v1/admin/sandboxes/:scopeId",
    scopeParam((p) => p.scopeId ?? ""),
  ),
  rule(
    "POST",
    "/v1/admin/sandboxes/:scopeId",
    scopeParam((p) => p.scopeId ?? ""),
  ),

  rule("GET", "/v1/admin/sessions", everyScope),
  rule("GET", "/v1/admin/runs", everyScope),
  rule("GET", "/v1/admin/errors", everyScope),
  rule("GET", "/v1/admin/audit", everyScope),
  rule("GET", "/v1/admin/egress", everyScope),
  rule("GET", "/v1/admin/metrics", everyScope),
  rule("GET", "/v1/admin/deliveries/shadow", everyScope),

  rule("GET", "/v1/admin/scopes", narrowed),
  rule("GET", "/v1/admin/memory/scopes", narrowed),
  rule("GET", "/v1/admin/files", narrowed),
  rule("GET", "/v1/admin/crons", narrowed),
  rule("GET", "/v1/admin/deployments", narrowed),
  rule("GET", "/v1/admin/skills", narrowed),
  rule("GET", "/v1/admin/sessions/:id", narrowed),
  rule("GET", "/v1/admin/skills/:id", narrowed),
  rule("DELETE", "/v1/admin/skills/:id", narrowed),
  rule("PUT", "/v1/admin/crons/:id/runtime", narrowed),
  rule("PUT", "/v1/admin/crons/:id/destination", narrowed),

  rule("GET", "/v1/admin/sessions/:id/llm", deny),
  rule("POST", "/v1/admin/scopes/:scope/auto-flagger/test", deny),
  rule("GET", "/v1/admin/keychain", deny),
  rule("GET", "/v1/admin/security/flags", deny),
  rule("GET", "/v1/admin/slack-mirror", deny),
  rule("GET", "/v1/admin/slack-mirror/messages", deny),
  rule("GET", "/v1/admin/ambient-judgments", deny),
  rule("GET", "/v1/admin/ack-emoji-picks", deny),
  rule("POST", "/v1/admin/grants", deny),
  rule("DELETE", "/v1/admin/grants/:principalId", deny),
  rule("POST", "/v1/admin/impersonate", deny),
  rule("POST", "/v1/admin/impersonate/stop", deny),
  rule("POST", "/v1/admin/users/invite", deny),
  rule("POST", "/v1/admin/principal-links", deny),
  rule("DELETE", "/v1/admin/principal-links/:principalId", deny),
];

export const MANAGER_RESOURCES: ReadonlyMap<string, boolean> = new Map([
  ["security-posture", true],
  ["sharing-posture", true],
  ["auto-flagger", true],
  ["approval-grant-modes", true],
  ["command-policy", true],
  ["command-policy-simulate", true],
  ["soul", true],
  ["ambient-policy", true],
  ["egress", true],
  ["feature-flags", true],
  ["unfulfilled-insights", true],
  ["external-slack-participants", true],
  ["internal-member-overrides", true],
  ["channel-header-pin-default", true],
  ["org-ambient", true],
  ["interactive-fast-mode", true],
  ["individual-model-auth", true],
  ["memory-embedding-model", true],
  ["base-model", true],
  ["runtime", true],
  ["cron-runtime", true],
  ["subagent-runtime", true],
  ["fallback-runtime", true],
  ["approved-harnesses", true],
  ["webui-models", true],
  ["people-directory-url", true],
  ["ack-emoji", true],
  ["branding", true],
  ["browse-model", true],
  ["browse-max-steps", true],
  ["connectors", true],
  ["service-credentials", true],
  ["decisions", false],
  ["teams", false],
]);

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function matchPath(pattern: string, pathname: string): Params | null {
  const want = pattern.split("/");
  const have = pathname.split("/");
  const rest = want[want.length - 1] === "*";
  const fixed = rest ? want.length - 1 : want.length;
  if (rest ? have.length < fixed : have.length !== fixed) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < fixed; i++) {
    const w = want[i]!;
    const h = have[i]!;
    if (w.startsWith(":")) {
      const value = decodeSegment(h);
      if (value === null || !value) return null;
      params[w.slice(1)] = value;
    } else if (w !== h) return null;
  }
  return params;
}

export function managerAccessFor(
  method: string,
  pathname: string,
): { rule: ManagerRule; access: ManagerAccess; params: Params } | null {
  for (const r of MANAGER_RULES) {
    if (r.method !== "*" && r.method !== method) continue;
    const params = matchPath(r.path, pathname);
    if (params) return { rule: r, access: r.access, params };
  }
  return null;
}

const MANAGER_ACTION_REFUSED = "this admin action is limited to org admins";
const MANAGER_PICK_A_SCOPE = "choose a specific scope to view this";
export const MANAGER_SCOPE_REFUSED = "you don't have access to this scope";

export async function managerRefusal(
  req: { method?: string; url?: string },
  requested: string,
  canRead: (scope: string) => Promise<boolean>,
): Promise<string | null> {
  const pathname = new URL(req.url ?? "/", "http://core.invalid").pathname;
  const found = managerAccessFor(req.method ?? "GET", pathname);
  if (!found || found.access.kind === "deny") return MANAGER_ACTION_REFUSED;
  const { access, params } = found;
  if (params.resource !== undefined && MANAGER_RESOURCES.get(params.resource) !== true) return MANAGER_ACTION_REFUSED;
  if (access.kind === "allow") return null;
  const target = access.kind === "scope" && access.target ? access.target(params) : requested;
  if (parseScopeId(target).kind === "org") {
    return access.kind === "scope" && access.orgMeansEveryScope ? MANAGER_PICK_A_SCOPE : null;
  }
  return (await canRead(target)) ? null : MANAGER_SCOPE_REFUSED;
}
