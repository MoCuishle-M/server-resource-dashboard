import test from "node:test";
import assert from "node:assert/strict";
import { emptyState, mutate, serializePublic } from "../lib/domain";
import { enrollAdmin } from "../lib/admin-enrollment";
import type { Actor } from "../lib/types";
const now = "2026-10-21T00:00:00.000Z";
const admin: Actor = { userId: "a", email: "a@example.test", displayName: "管理员A", role: "admin", groupId: "", employeeId: "" };
function initial() {
  const state = emptyState();
  state.accounts.push({ id: "account-a", ...admin, role: "admin", status: "approved", createdAt: now });
  return state;
}
test("only admins can publish public text or manage admin invitations", () => {
  for (const role of ["visitor", "member", "contact"] as const) {
    const actor = { ...admin, role };
    for (const action of [
      { type: "site.settings", announcement: "x" }, { type: "admin.invite", email: "b@example.test" },
      { type: "admin.revoke", id: "account-a" }, { type: "admin.cancelInvitation", id: "i" },
    ]) assert.throws(() => mutate(initial(), actor, action, now), /仅服务器管理员/);
  }
  let s = mutate(initial(), admin, { type: "site.settings", announcement: "维护安排\n周末升级 <script>文本</script>", authorSignature: "作者A" }, now);
  assert.equal(s.settings.authorSignature, "作者A");
  assert.equal(s.audits.at(-1)!.action, "修改网站信息");
  assert.equal(serializePublic(s, { ...admin, role: "visitor" }, now, true).settings.announcement, s.settings.announcement);
  assert.throws(() => mutate(s, admin, { type: "site.settings", announcement: "x".repeat(4001) }, now), /4000/);
  s = mutate(s, admin, { type: "site.settings", announcement: "", authorSignature: "" }, now);
  assert.deepEqual(s.settings, { announcement: "", authorSignature: "" });
});
test("invitations validate email, prevent duplicates and bind only the trusted matching login", () => {
  assert.throws(() => mutate(initial(), admin, { type: "admin.invite", email: "invalid" }, now), /有效/);
  let s = mutate(initial(), admin, { type: "admin.invite", email: " B@Example.Test ", displayName: "管理员B" }, now);
  assert.equal(s.invitations[0].email, "b@example.test");
  assert.throws(() => mutate(s, admin, { type: "admin.invite", email: "b@example.test" }, now), /已有/);
  assert.strictEqual(enrollAdmin(s, { userId: "wrong", email: "wrong@example.test", displayName: "wrong" }, [], now), s);
  assert.strictEqual(enrollAdmin(s, null, [], now), s);
  const next = enrollAdmin(s, { userId: "b-stable", email: "B@example.test", displayName: "Native B" }, [], now);
  assert.equal(next.accounts.find(a => a.userId === "b-stable")!.role, "admin");
  assert.equal(next.invitations[0].status, "accepted");
  assert.equal(s.invitations[0].status, "pending");
  assert.strictEqual(enrollAdmin(next, { userId: "b-stable", email: "B@example.test", displayName: "Native B" }, [], now), next);
  const visitor = serializePublic(next, { ...admin, role: "visitor", userId: "" }, now, true);
  assert.deepEqual(visitor.invitations, []);
  assert.deepEqual(visitor.accounts, []);
  assert(!JSON.stringify(visitor).includes("b@example.test"));
  s = mutate(s, admin, { type: "admin.cancelInvitation", id: s.invitations[0].id }, now);
  assert.strictEqual(enrollAdmin(s, { userId: "b-stable", email: "b@example.test", displayName: "B" }, [], now), s);
});
test("known accounts can be promoted; revocation protects self and last admin and cannot bootstrap again", () => {
  let s = initial();
  s.accounts.push({ id: "contact", userId: "b", email: "b@example.test", displayName: "B", groupId: "g1", employeeId: "B1", role: "contact", status: "approved", createdAt: now });
  s = mutate(s, admin, { type: "admin.invite", email: "b@example.test" }, now);
  assert.equal(s.accounts[1].role, "admin");
  assert.equal(s.invitations.length, 0);
  assert.throws(() => mutate(s, admin, { type: "admin.revoke", id: "account-a" }, now), /自己/);
  s = mutate(s, admin, { type: "admin.revoke", id: "contact" }, now);
  assert.equal(s.accounts[1].status, "rejected");
  assert.strictEqual(enrollAdmin(s, { userId: "b", email: "b@example.test", displayName: "B" }, ["b@example.test"], now), s);
  assert.throws(() => mutate(s, { ...admin, userId: "b", role: "member" }, { type: "account.apply", groupId: "g1", employeeId: "B1", displayName: "B" }, now), /身份已撤销/);
  assert.throws(() => mutate(s, admin, { type: "admin.revoke", id: "account-a" }, now), /保留/);
});
test("invited existing users keep their account ID and bootstrap is idempotent", () => {
  const fresh = enrollAdmin(emptyState(), { userId: "a", email: admin.email, displayName: admin.displayName }, [admin.email], now);
  assert.equal(fresh.accounts[0].role, "admin");
  assert.strictEqual(enrollAdmin(fresh, { userId: "a", email: admin.email, displayName: admin.displayName }, [admin.email], now), fresh);
  const s = initial();
  s.accounts.push({ id: "old", userId: "b", email: "old@example.test", displayName: "B", groupId: "g1", employeeId: "B1", role: "contact", status: "rejected", createdAt: now });
  const invited = mutate(s, admin, { type: "admin.invite", email: "new@example.test" }, now);
  const enrolled = enrollAdmin(invited, { userId: "b", email: "new@example.test", displayName: "B" }, [], now);
  assert.equal(enrolled.accounts.length, 2);
  assert.equal(enrolled.accounts[1].id, "old");
  assert.equal(enrolled.accounts[1].role, "admin");
});
