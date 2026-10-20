export type Priority = "normal" | "high" | "urgent";
export type SharingMode = "exclusive" | "shared";
export type Resource = {
  id: string;
  name: string;
  type: string;
  ip: string;
  accessMode: "bare" | "lingshu";
  sharingMode: SharingMode;
  location: string;
  note: string;
  status: "available" | "maintenance";
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
};
export type Group = {
  id: string;
  name: string;
  contactName: string;
  employeeId: string;
};
export type Account = {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  employeeId: string;
  groupId: string;
  role: "admin" | "contact";
  status: "pending" | "approved" | "rejected";
  createdAt: string;
};
export type UsageRequest = {
  id: string;
  groupId: string;
  resourceIds: string[];
  startAt: string;
  endAt: string;
  purpose: string;
  priority: Priority;
  status: "pending" | "approved" | "rejected" | "cancelled";
  applicantId: string;
  applicantName: string;
  createdAt: string;
  reviewedAt: string;
  reviewer: string;
  reviewNote: string;
};
export type Booking = {
  id: string;
  requestId: string;
  resourceId: string;
  groupId: string;
  startAt: string;
  endAt: string;
  purpose: string;
  priority: Priority;
  status: "scheduled" | "cancelled" | "preempted" | "released";
  parentId: string;
  createdAt: string;
  updatedAt: string;
};
export type Audit = {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  before: string;
  after: string;
};
export type State = {
  revision: number;
  resources: Resource[];
  groups: Group[];
  accounts: Account[];
  requests: UsageRequest[];
  bookings: Booking[];
  audits: Audit[];
};
export type Actor = {
  userId: string;
  displayName: string;
  email: string;
  role: "visitor" | "member" | "contact" | "admin";
  groupId: string;
  employeeId: string;
};
export type PublicState = State & {
  actor: Actor;
  now: string;
  adminConfigured: boolean;
  demo?: boolean;
};
export type Action = { type: string; [key: string]: unknown };
