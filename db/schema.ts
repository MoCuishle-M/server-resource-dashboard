import { sqliteTable, text, integer, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const meta = sqliteTable("meta", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
});
export const guards = sqliteTable(
  "guards",
  { id: text("id").primaryKey(), valid: integer("valid").notNull() },
  (t) => [check("valid_revision", sql`${t.valid} = 1`)],
);
// Typed payloads are versioned by the domain layer; entities have independent rows.
export const resources = sqliteTable("resources", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
});
export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
});
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
});
export const requests = sqliteTable("requests", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
});
export const bookings = sqliteTable("bookings", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
});
export const audits = sqliteTable("audits", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
});
export const siteSettings = sqliteTable("site_settings", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
});
export const adminInvitations = sqliteTable("admin_invitations", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
});
