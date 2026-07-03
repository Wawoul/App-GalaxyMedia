import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Assignment, Company, Group, Layout, Playlist, Screen } from '../types';

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon…Sun
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PX_PER_HOUR = 30;
const SNAP_MIN = 30;

const BLACKOUT = 'blackout'; // pseudo-playlist value for "Black Screen"

/** Content select values: "<uuid>" playlist, "l:<uuid>" layout, "blackout". */
function decodeContent(value: string): { playlistId: string | null; layoutId: string | null; blackout: boolean } {
  if (value === BLACKOUT) return { playlistId: null, layoutId: null, blackout: true };
  if (value.startsWith('l:')) return { playlistId: null, layoutId: value.slice(2), blackout: false };
  return { playlistId: value, layoutId: null, blackout: false };
}

/** Stable pastel color per playlist; Black Screen is, well, black. */
function playlistColor(id: string | null): string {
  if (!id) return '#000';
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 55% 45%)`;
}

const toMin = (t: string) => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};
const toTime = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

interface Draft {
  id?: string; // set when editing an existing slot
  days: number[];
  startMin: number;
  endMin: number;
  playlistId: string;
  priority: number; // 10 normal · 20 high · 100 takeover
  repeat: number | 'once'; // week interval, or a one-off date
  anchorDate: string; // start date (anchor for intervals / the date for one-offs)
  endDate: string;
}

/** Existing assignment -> pre-filled dialog state. */
function draftFromAssignment(a: Assignment): Draft {
  const oneOff = !!a.start_date && a.start_date.slice(0, 10) === a.end_date?.slice(0, 10);
  const endMin = toMin(a.end_time!.slice(0, 5));
  return {
    id: a.id,
    days: a.days_of_week?.length ? a.days_of_week : [0, 1, 2, 3, 4, 5, 6],
    startMin: toMin(a.start_time!.slice(0, 5)),
    endMin: endMin === 0 ? 24 * 60 : endMin,
    playlistId: a.blackout || (!a.playlist_id && !a.layout_id)
      ? BLACKOUT
      : a.layout_id
        ? `l:${a.layout_id}`
        : a.playlist_id!,
    priority: a.priority,
    repeat: oneOff ? 'once' : a.week_interval,
    anchorDate: a.start_date?.slice(0, 10) ?? '',
    endDate: oneOff ? '' : (a.end_date?.slice(0, 10) ?? ''),
  };
}

/** Next calendar date (YYYY-MM-DD, local) falling on the given day-of-week. */
function nextDateForDay(dow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function Schedule({ company, canEdit }: { company: Company; canEdit: boolean }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [screens, setScreens] = useState<Screen[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [target, setTarget] = useState(''); // "g:<id>" | "s:<id>"
  const [error, setError] = useState('');
  const [defaultPlaylist, setDefaultPlaylist] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  // in-progress drag
  const dragRef = useRef<{ day: number; anchorMin: number; colTop: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ day: number; startMin: number; endMin: number } | null>(null);

  const load = useCallback(async () => {
    const [g, s, p, l, a] = await Promise.all([
      api<Group[]>(`/api/companies/${company.id}/groups`),
      api<Screen[]>(`/api/screens?companyId=${company.id}`),
      api<Playlist[]>(`/api/companies/${company.id}/playlists`),
      api<Layout[]>(`/api/companies/${company.id}/layouts`),
      api<Assignment[]>(`/api/companies/${company.id}/assignments`),
    ]);
    setGroups(g);
    setScreens(s);
    setPlaylists(p);
    setLayouts(l);
    setAssignments(a);
    setTarget((t) => t || (g[0] ? `g:${g[0].id}` : s[0] ? `s:${s[0].id}` : ''));
  }, [company.id]);

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : 'failed'));
  }, [load]);

  const [targetType, targetId] = target ? (target.split(':') as [string, string]) : ['', ''];
  const forTarget = assignments.filter((a) =>
    targetType === 'g' ? a.group_id === targetId : a.screen_id === targetId,
  );
  const defaults = forTarget.filter((a) => !a.start_time);
  const timed = forTarget.filter((a) => a.start_time && a.end_time);

  const createAssignment = async (body: Record<string, unknown>) => {
    setError('');
    try {
      await api(`/api/companies/${company.id}/assignments`, {
        body: {
          screenId: targetType === 's' ? targetId : null,
          groupId: targetType === 'g' ? targetId : null,
          ...body,
        },
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  };

  const removeAssignment = async (a: Assignment) => {
    if (confirm(`Remove "${a.playlist_name}" from this schedule?`)) {
      await api(`/api/assignments/${a.id}`, { method: 'DELETE' });
      await load();
    }
  };

  // ── drag-to-create ────────────────────────────────────────────────────────

  const yToMin = (clientY: number, colTop: number) => {
    const min = Math.round(((clientY - colTop) / PX_PER_HOUR) * 60 / SNAP_MIN) * SNAP_MIN;
    return Math.max(0, Math.min(24 * 60, min));
  };

  const onColMouseDown = (day: number) => (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canEdit || draft) return;
    const colTop = e.currentTarget.getBoundingClientRect().top;
    const start = yToMin(e.clientY, colTop);
    dragRef.current = { day, anchorMin: start, colTop };
    setDragPreview({ day, startMin: start, endMin: start + SNAP_MIN });
    e.preventDefault();
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const at = yToMin(e.clientY, drag.colTop);
      setDragPreview({
        day: drag.day,
        startMin: Math.min(drag.anchorMin, at),
        endMin: Math.max(drag.anchorMin + SNAP_MIN, at),
      });
    };
    const up = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      setDragPreview((preview) => {
        if (preview) {
          setDraft({
            days: [preview.day],
            startMin: preview.startMin,
            endMin: Math.max(preview.endMin, preview.startMin + SNAP_MIN),
            playlistId: '',
            priority: 10,
            repeat: 1,
            anchorDate: nextDateForDay(preview.day),
            endDate: '',
          });
        }
        return null;
      });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  // Blocks to paint per day (overnight windows split across midnight).
  const blocksFor = (day: number) => {
    const blocks: { a: Assignment; startMin: number; endMin: number }[] = [];
    for (const a of timed) {
      const days = a.days_of_week?.length ? a.days_of_week : [0, 1, 2, 3, 4, 5, 6];
      const start = toMin(a.start_time!);
      const end = toMin(a.end_time!);
      if (start <= end) {
        if (days.includes(day)) blocks.push({ a, startMin: start, endMin: end });
      } else {
        if (days.includes(day)) blocks.push({ a, startMin: start, endMin: 24 * 60 });
        const prev = (day + 6) % 7; // overnight tail lands on the next calendar day
        if (days.includes(prev)) blocks.push({ a, startMin: 0, endMin: end });
      }
    }
    return blocks;
  };

  return (
    <>
      <h2>Schedule</h2>

      <div className="panel row">
        <span className="muted">Show schedule for</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <optgroup label="Groups">
            {groups.map((g) => <option key={g.id} value={`g:${g.id}`}>{g.name}</option>)}
          </optgroup>
          <optgroup label="Screens">
            {screens.map((s) => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}
          </optgroup>
        </select>
        {canEdit && <span className="muted"> - drag on the calendar to add a time slot</span>}
      </div>

      {error && <div className="error">{error}</div>}

      {target && (
        <>
          <div className="panel">
            <strong>Default (plays when nothing is scheduled)</strong>
            <div className="row" style={{ marginTop: 8 }}>
              {defaults.map((a) => (
                <span key={a.id} className="badge" style={{ background: playlistColor(a.playlist_id ?? a.layout_id), color: '#fff' }}>
                  {a.playlist_name}
                  {canEdit && (
                    <span style={{ cursor: 'pointer', marginLeft: 8 }} onClick={() => removeAssignment(a)}>✕</span>
                  )}
                </span>
              ))}
              {defaults.length === 0 && <span className="muted">None - the screen is idle outside scheduled slots.</span>}
              {canEdit && (
                <>
                  <select value={defaultPlaylist} onChange={(e) => setDefaultPlaylist(e.target.value)}>
                    <option value="">Add default…</option>
                    <optgroup label="Playlists">
                      {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </optgroup>
                    {layouts.length > 0 && (
                      <optgroup label="Layouts">
                        {layouts.map((l) => <option key={l.id} value={`l:${l.id}`}>{l.name}</option>)}
                      </optgroup>
                    )}
                    <option value={BLACKOUT}>Black Screen (simulates TV off)</option>
                  </select>
                  <button className="secondary" disabled={!defaultPlaylist}
                    onClick={async () => {
                      await createAssignment({
                        ...decodeContent(defaultPlaylist),
                        priority: 0,
                      });
                      setDefaultPlaylist('');
                    }}>
                    Add
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="panel" style={{ overflowX: 'auto' }}>
            <div className="cal">
              <div className="cal-gutter">
                <div className="cal-head"></div>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="cal-hour-label" style={{ height: PX_PER_HOUR }}>
                    {String(h).padStart(2, '0')}:00
                  </div>
                ))}
              </div>
              {DAY_ORDER.map((day) => (
                <div key={day} className="cal-day">
                  <div className="cal-head">{DAY_NAMES[day]}</div>
                  <div className="cal-col" style={{ height: 24 * PX_PER_HOUR }} onMouseDown={onColMouseDown(day)}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <div key={h} className="cal-hour-line" style={{ top: h * PX_PER_HOUR }} />
                    ))}
                    {blocksFor(day).map(({ a, startMin, endMin }, i) => (
                      <div key={`${a.id}-${i}`} className="cal-block"
                        style={{
                          top: (startMin / 60) * PX_PER_HOUR,
                          height: Math.max(14, ((endMin - startMin) / 60) * PX_PER_HOUR - 2),
                          background: playlistColor(a.playlist_id ?? a.layout_id),
                        }}
                        title={`${a.playlist_name} · ${a.start_time!.slice(0, 5)}-${a.end_time!.slice(0, 5)}${
                          a.week_interval > 1 ? ` · every ${a.week_interval} weeks` : ''
                        }${a.start_date && a.start_date === a.end_date ? ` · one-off ${a.start_date.slice(0, 10)}` : ''}${
                          a.priority >= 100 ? ' · takeover' : a.priority >= 20 ? ' · high' : ''
                        }${canEdit ? ' - click to edit' : ''}`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => canEdit && setDraft(draftFromAssignment(a))}>
                        <span>{a.playlist_name}</span>
                        <span className="cal-block-time">{a.start_time!.slice(0, 5)}-{a.end_time!.slice(0, 5)}</span>
                      </div>
                    ))}
                    {dragPreview?.day === day && (
                      <div className="cal-block cal-drag"
                        style={{
                          top: (dragPreview.startMin / 60) * PX_PER_HOUR,
                          height: ((dragPreview.endMin - dragPreview.startMin) / 60) * PX_PER_HOUR,
                        }}>
                        <span>{toTime(dragPreview.startMin)}-{toTime(dragPreview.endMin)}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {draft && (
        <div className="modal-backdrop" onClick={() => setDraft(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              {draft.id ? 'Edit slot' : 'New slot'}
              <span className="muted" style={{ fontWeight: 400 }}>
                {' '}· {toTime(draft.startMin)}-{toTime(draft.endMin % (24 * 60))}
              </span>
            </div>

            <div className="form-grid">
              <label className="form-field form-wide">
                <span>Playlist</span>
                <select value={draft.playlistId} autoFocus
                  onChange={(e) => setDraft({ ...draft, playlistId: e.target.value })}>
                  <option value="">Choose content…</option>
                  <optgroup label="Playlists">
                    {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </optgroup>
                  {layouts.length > 0 && (
                    <optgroup label="Layouts">
                      {layouts.map((l) => <option key={l.id} value={`l:${l.id}`}>{l.name}</option>)}
                    </optgroup>
                  )}
                  <option value={BLACKOUT}>Black Screen (simulates TV off)</option>
                </select>
              </label>

              <label className="form-field">
                <span>From</span>
                <input type="time" value={toTime(draft.startMin)}
                  onChange={(e) => setDraft({ ...draft, startMin: toMin(e.target.value) })} />
              </label>
              <label className="form-field">
                <span>To</span>
                <input type="time" value={toTime(draft.endMin % (24 * 60))}
                  onChange={(e) => setDraft({ ...draft, endMin: toMin(e.target.value) || 24 * 60 })} />
              </label>

              <label className="form-field">
                <span>Repeats</span>
                <select value={String(draft.repeat)}
                  onChange={(e) =>
                    setDraft({ ...draft, repeat: e.target.value === 'once' ? 'once' : Number(e.target.value) })
                  }>
                  <option value="1">Every week</option>
                  <option value="2">Every 2 weeks</option>
                  <option value="3">Every 3 weeks</option>
                  <option value="4">Every 4 weeks</option>
                  <option value="once">One-off (single date)</option>
                </select>
              </label>

              <label className="form-field">
                <span>If slots overlap</span>
                <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}>
                  <option value={10}>Normal</option>
                  <option value={20}>High - beats Normal</option>
                  <option value={100}>Takeover - beats everything</option>
                </select>
              </label>

              {draft.repeat === 'once' ? (
                <label className="form-field">
                  <span>On date</span>
                  <input type="date" value={draft.anchorDate}
                    onChange={(e) => setDraft({ ...draft, anchorDate: e.target.value })} />
                </label>
              ) : (
                <div className="form-field form-wide">
                  <span>On days</span>
                  <div className="chip-row">
                    {DAY_ORDER.map((d) => (
                      <button key={d} type="button"
                        className={`chip ${draft.days.includes(d) ? 'chip-on' : ''}`}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            days: draft.days.includes(d)
                              ? draft.days.filter((x) => x !== d)
                              : [...draft.days, d].sort(),
                          })
                        }>
                        {DAY_NAMES[d]}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {draft.repeat !== 'once' && typeof draft.repeat === 'number' && draft.repeat > 1 && (
                <label className="form-field">
                  <span>Starting week of</span>
                  <input type="date" value={draft.anchorDate}
                    onChange={(e) => setDraft({ ...draft, anchorDate: e.target.value })} />
                </label>
              )}
              {draft.repeat !== 'once' && (
                <label className="form-field">
                  <span>Stop after (optional)</span>
                  <input type="date" value={draft.endDate}
                    onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} />
                </label>
              )}
            </div>

            <div className="modal-actions">
              {draft.id && (
                <button className="danger" style={{ marginRight: 'auto' }}
                  onClick={async () => {
                    if (confirm('Remove this slot from the schedule?')) {
                      await api(`/api/assignments/${draft.id}`, { method: 'DELETE' });
                      setDraft(null);
                      await load();
                    }
                  }}>
                  Delete slot
                </button>
              )}
              <button className="secondary" onClick={() => setDraft(null)}>Cancel</button>
              <button
                disabled={
                  !draft.playlistId ||
                  draft.endMin <= draft.startMin ||
                  (draft.repeat === 'once' ? !draft.anchorDate : draft.days.length === 0) ||
                  (typeof draft.repeat === 'number' && draft.repeat > 1 && !draft.anchorDate)
                }
                onClick={async () => {
                  const oneOff = draft.repeat === 'once';
                  const interval = oneOff ? 1 : (draft.repeat as number);
                  const body = {
                    ...decodeContent(draft.playlistId),
                    priority: draft.priority,
                    daysOfWeek: oneOff ? null : draft.days.length < 7 ? draft.days : null,
                    startTime: toTime(draft.startMin),
                    endTime: toTime(draft.endMin % (24 * 60)),
                    startDate: oneOff || interval > 1 ? draft.anchorDate : null,
                    endDate: oneOff ? draft.anchorDate : draft.endDate || null,
                    weekInterval: interval,
                  };
                  if (draft.id) {
                    setError('');
                    try {
                      await api(`/api/assignments/${draft.id}`, { method: 'PATCH', body });
                      await load();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'failed');
                    }
                  } else {
                    await createAssignment(body);
                  }
                  setDraft(null);
                }}>
                {draft.id ? 'Save changes' : 'Add to schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
