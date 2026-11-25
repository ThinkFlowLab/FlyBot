import type { ServerResponse } from "node:http";
import { assert } from "../errors.js";
import type { OtContext } from "./core.js";

const WAIT_MS = 4_000;
const PRESENCE_TTL_MS = 16_000;
const MAX_WAITERS = 256;
const MAX_OWNER_WAITERS = 8;
const MAX_PRESENCE_DOCUMENTS = 256;
const MAX_DOCUMENT_TABS = 32;
const MAX_OWNER_TABS = 4;

type Tab = { owner: string; editing: boolean; expires: number };

// The document and its revision remain authoritative in SQLite. These maps
// only wake bounded requests and track which authenticated tabs are open.
export function studioLiveState(ot: OtContext) {
  const pending = new Map<string, Set<() => void>>();
  const ownerWaiters = new Map<string, number>();
  const presence = new Map<string, Map<string, Tab>>();
  let waiting = 0;
  let nextSweep = 0;

  function wait(document: string, owner: string, response: ServerResponse) {
    const ownerCount = ownerWaiters.get(owner) ?? 0;
    assert(waiting < MAX_WAITERS && ownerCount < MAX_OWNER_WAITERS,
      429, "studio_live_busy", "Too many open Studio watches");
    const callbacks = pending.get(document) ?? new Set<() => void>();
    pending.set(document, callbacks);
    ownerWaiters.set(owner, ownerCount + 1);
    waiting += 1;
    return new Promise<void>(resolve => {
      const timer = setTimeout(finish, WAIT_MS);
      function finish() {
        if (!callbacks.delete(finish)) return;
        clearTimeout(timer);
        response.off("close", finish);
        if (!callbacks.size) pending.delete(document);
        waiting -= 1;
        const remaining = (ownerWaiters.get(owner) ?? 1) - 1;
        if (remaining) ownerWaiters.set(owner, remaining);
        else ownerWaiters.delete(owner);
        resolve();
      }
      callbacks.add(finish);
      response.once("close", finish);
      if (response.destroyed) finish();
    });
  }

  function update(document: string, removed = false) {
    if (removed) presence.delete(document);
    for (const finish of pending.get(document) ?? []) finish();
  }

  function prune(document: string, tabs: Map<string, Tab>, now: number) {
    for (const [key, tab] of tabs) {
      if (tab.expires <= now) tabs.delete(key);
    }
    if (!tabs.size) presence.delete(document);
  }

  function touch(document: string, owner: string, session: string, active: boolean, editing: boolean) {
    const now = ot.now();
    if (now >= nextSweep) {
      for (const [id, tabs] of presence) prune(id, tabs, now);
      nextSweep = now + PRESENCE_TTL_MS;
    }
    const key = JSON.stringify([owner, session]);
    const tabs = presence.get(document) ?? new Map<string, Tab>();
    prune(document, tabs, now);
    const prior = tabs.get(key);
    if (active) {
      assert((tabs.size > 0 || presence.size < MAX_PRESENCE_DOCUMENTS) &&
        (prior || (tabs.size < MAX_DOCUMENT_TABS &&
          [...tabs.values()].filter(tab => tab.owner === owner).length < MAX_OWNER_TABS)),
      429, "studio_presence_busy", "Too many open Studio editors");
      tabs.set(key, {owner, editing, expires: now + PRESENCE_TTL_MS});
      presence.set(document, tabs);
      if (!prior || prior.editing !== editing) update(document);
    } else {
      tabs.delete(key);
      if (!tabs.size) presence.delete(document);
      if (prior) update(document);
    }
  }

  function editors(document: string, team: string, viewer: string) {
    const tabs = presence.get(document);
    if (!tabs) return [];
    prune(document, tabs, ot.now());
    const owners = new Map<string, boolean>();
    for (const tab of tabs.values()) {
      if (tab.owner !== viewer) owners.set(tab.owner, tab.editing || owners.get(tab.owner) === true);
    }
    if (!owners.size) return [];
    const members = ot.all<{ owner_id: string; name: string }>(`
      SELECT member.owner_id, COALESCE(NULLIF(profile.display_name,''), profile.handle, '团队成员') AS name
      FROM ot_team_members member LEFT JOIN ot_profiles profile ON profile.owner_id=member.owner_id
      WHERE member.team_id=? AND member.suspended=0
        AND member.owner_id IN (${[...owners.keys()].map(() => "?").join(",")})
      ORDER BY name, member.owner_id`, team, ...owners.keys());
    return members.map(member => ({ name: member.name, editing: owners.get(member.owner_id) === true }));
  }

  return {wait, update, touch, editors};
}
