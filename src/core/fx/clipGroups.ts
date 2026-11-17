// Group FX: one filter chain shared by several clips. Each member clip points to the group
// (Clip.fxGroup) and plays through its own copy of the chain, after its own clip filters, so
// changing the group's settings changes every member at once. Pure: returns new projects.
import type { Clip, ClipFxGroup, Fx, Project } from '../../shared/types';
import { uid } from '../../shared/time';

const GROUP_PREFIX = 'group:';

/** The filter target of a group FX chain (see core/fx/stack.ts). */
export function groupTarget(groupId: string): string {
  return GROUP_PREFIX + groupId;
}

/** The group id of a group target, or null for any other target. */
export function targetGroupId(target: string): string | null {
  return target.startsWith(GROUP_PREFIX) ? target.slice(GROUP_PREFIX.length) : null;
}

export function findGroup(project: Project, groupId: string | undefined): ClipFxGroup | undefined {
  return groupId ? project.clipFxGroups?.find((g) => g.id === groupId) : undefined;
}

/** The group FX chain a clip belongs to (none when its group no longer exists). */
export function clipGroup(project: Project, clip: Clip): ClipFxGroup | undefined {
  return findGroup(project, clip.fxGroup);
}

/** Every clip of the group, in track and timeline order. */
export function groupMembers(project: Project, groupId: string): Array<{ trackId: string; clip: Clip }> {
  const out: Array<{ trackId: string; clip: Clip }> = [];
  for (const t of project.tracks) for (const c of t.clips) if (c.fxGroup === groupId) out.push({ trackId: t.id, clip: c });
  return out;
}

/** The filters a clip plays through besides its track's: its own, then its group's. */
export function effectiveClipFx(project: Project, clip: Clip): Fx[] | undefined {
  const group = clipGroup(project, clip);
  if (!group?.fx.length) return clip.fx;
  return clip.fx?.length ? [...clip.fx, ...group.fx] : group.fx;
}

/**
 * The project as the mixer plays it: every grouped clip carries its own filters followed by the
 * group's in Clip.fx. Clips and tracks without a group keep their identity, so nothing else changes.
 */
export function resolveClipFxGroups(project: Project): Project {
  if (!project.clipFxGroups?.length) return project;
  let changed = false;
  const tracks = project.tracks.map((t) => {
    if (!t.clips.some((c) => clipGroup(project, c)?.fx.length)) return t;
    changed = true;
    return {
      ...t,
      clips: t.clips.map((c) => {
        const group = clipGroup(project, c);
        return group?.fx.length ? { ...c, fx: effectiveClipFx(project, c) } : c;
      }),
    };
  });
  return changed ? { ...project, tracks } : project;
}

function mapClips(project: Project, fn: (c: Clip) => Clip): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) => {
      let changed = false;
      const clips = t.clips.map((c) => {
        const n = fn(c);
        if (n !== c) changed = true;
        return n;
      });
      return changed ? { ...t, clips } : t;
    }),
  };
}

/** Groups no clip points to any more are dropped; clips pointing to a missing group leave it. */
export function pruneClipFxGroups(project: Project): Project {
  const groups = project.clipFxGroups ?? [];
  const known = new Set(groups.map((g) => g.id));
  const used = new Set<string>();
  const inTakes = new Set<string>();
  for (const t of project.tracks) {
    for (const c of t.clips) if (c.fxGroup && known.has(c.fxGroup)) used.add(c.fxGroup);
    // take lanes keep the group of the clips they were cut from, so swiping a take back keeps it
    for (const tk of t.takes ?? []) for (const c of tk.clips ?? []) if (c.fxGroup && known.has(c.fxGroup)) inTakes.add(c.fxGroup);
  }
  let p = mapClips(project, (c) => {
    if (c.fxGroup === undefined || known.has(c.fxGroup)) return c;
    const { fxGroup: _gone, ...rest } = c;
    return rest;
  });
  const keep = groups.filter((g) => used.has(g.id) || inTakes.has(g.id));
  if (keep.length !== groups.length || (project.clipFxGroups && !keep.length)) {
    p = { ...p, clipFxGroups: keep };
    if (!keep.length) delete p.clipFxGroups;
  }
  return p;
}

const sameStack = (a: Fx[] | undefined, b: Fx[] | undefined) =>
  JSON.stringify((a ?? []).map(({ id: _id, ...f }) => f)) === JSON.stringify((b ?? []).map(({ id: _id, ...f }) => f));

export interface GroupResult {
  project: Project;
  groupId: string;
  /** What happened, for a toast: 'open' (already one group), 'added' (joined an existing group) or 'created'. */
  action: 'open' | 'added' | 'created';
}

/**
 * The FX button of several selected clips: the group FX chain they share.
 * - All in one group already: that group, nothing changes.
 * - Some in exactly one group, the others in none: the others join that group.
 * - Otherwise a new group is made for them (leaving any group they were in). When they all have
 *   the same filters of their own, those move into the new group, so nothing sounds different.
 * Returns null with fewer than two existing clips.
 */
export function groupClips(project: Project, clipIds: Iterable<string>): GroupResult | null {
  const ids = new Set(clipIds);
  const clips = project.tracks.flatMap((t) => t.clips.filter((c) => ids.has(c.id)));
  if (clips.length < 2) return null;
  const groupsOf = new Set(clips.map((c) => (clipGroup(project, c) ? c.fxGroup! : '')));
  if (groupsOf.size === 1 && !groupsOf.has('')) return { project, groupId: clips[0].fxGroup!, action: 'open' };
  const existing = [...groupsOf].filter((g) => g);
  if (existing.length === 1) {
    const groupId = existing[0];
    const p = mapClips(project, (c) => (ids.has(c.id) && c.fxGroup !== groupId ? { ...c, fxGroup: groupId } : c));
    return { project: pruneClipFxGroups(p), groupId, action: 'added' };
  }
  const groupId = uid('fxg');
  const first = clips[0].fx;
  const moveOwn = !!first?.length && clips.every((c) => sameStack(c.fx, first));
  const fx = moveOwn ? first!.map((f) => ({ ...f, id: uid('fx') })) : [];
  let p = mapClips(project, (c) => {
    if (!ids.has(c.id)) return c;
    const n: Clip = { ...c, fxGroup: groupId };
    if (moveOwn) delete n.fx;
    return n;
  });
  p = { ...p, clipFxGroups: [...(p.clipFxGroups ?? []), { id: groupId, fx }] };
  return { project: pruneClipFxGroups(p), groupId, action: 'created' };
}

/** Takes clips out of their group FX chain; a group left without clips is dropped. */
export function ungroupClips(project: Project, clipIds: Iterable<string>): Project {
  const ids = new Set(clipIds);
  const p = mapClips(project, (c) => {
    if (!ids.has(c.id) || c.fxGroup === undefined) return c;
    const { fxGroup: _gone, ...rest } = c;
    return rest;
  });
  return pruneClipFxGroups(p);
}

/** Replaces the filter list of a group. */
export function withGroupList(project: Project, groupId: string, fn: (list: Fx[]) => Fx[]): Project {
  return { ...project, clipFxGroups: (project.clipFxGroups ?? []).map((g) => (g.id === groupId ? { ...g, fx: fn(g.fx) } : g)) };
}
