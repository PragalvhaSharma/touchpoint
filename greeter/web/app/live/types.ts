// The profile stream's message type, shared by the route (writer) and the panel (reader).
import type { UIMessage } from "ai";
import type { Identity, Project, RoleItem, School, Win } from "../api/talk/profile/build";
import type { Meet, Repo } from "../api/talk/data/store";

export type { Identity, Org, Project, RoleItem, School, Win } from "../api/talk/profile/build";
export type { Meet, Repo } from "../api/talk/data/store";

export type ProfileData = {
  status: { step: string; label: string };
  identity: Identity;
  school: School;
  roles: { now: RoleItem[]; past: RoleItem[]; leading: RoleItem[] };
  projects: Project[];
  wins: { wins: Win[]; awards: string[] };
  points: string[];
  repos: Repo[];
  meet: Meet[];
};

export type ProfileMessage = UIMessage<never, ProfileData>;

/** What the panel holds for one person: every card that has arrived, by name. */
export type Profile = { [K in Exclude<keyof ProfileData, "status">]?: ProfileData[K] };

