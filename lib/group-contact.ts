import type { State } from "./types";

// Group profiles are editable independently of account permissions. Only remove
// a profile matching a rejected account, and preserve a matching active contact.
export function currentGroupContacts(s: Pick<State, "groups" | "accounts">) {
  return s.groups.map((g) => {
    const matching = s.accounts.filter((a) => a.role === "contact" &&
      a.groupId === g.id && a.employeeId === g.employeeId && a.displayName === g.contactName);
    return matching.some((a) => a.status === "rejected") &&
      !matching.some((a) => a.status === "approved")
      ? { ...g, contactName: "", employeeId: "" }
      : g;
  });
}
