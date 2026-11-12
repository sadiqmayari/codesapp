'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Ban,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Eraser,
  FileText,
  History,
  Info,
  LifeBuoy,
  MoreVertical,
  PhoneCall,
  Pin,
  PinOff,
  RotateCcw,
  Search,
  StickyNote,
  Tag,
  UserCheck,
  UserMinus,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { avatarColor, initialsOf } from '@/lib/avatar';
import { apiFetch } from '@/lib/api';
import { Dropdown, type DropdownItem } from '@/components/ui/dropdown';
import { Modal } from '@/components/ui/modal';
import type { ConversationDetail } from '@/lib/inbox-types';
import type { TeamMember } from '@/lib/crm-types';

/**
 * Inbox-v2 chat header. One row: [back] avatar · name + status / phone ·
 * labels — then the window countdown, assignee picker, Resolve menu and
 * same-size icon actions. Desktop and mobile share ONE menu definition
 * (`menuItems`) so the parity rule ("every header action exists on both")
 * can't drift.
 */

type ConvoStatus = ConversationDetail['status'];

export interface ThreadHeaderProps {
  convo: ConversationDetail | null;
  /** Window expiry ISO (drives the countdown pill). */
  windowExpiresAt: string | null | undefined;
  now: number;
  meId: number | undefined;
  canManageAssign: boolean;
  members: TeamMember[];
  panelOpen: boolean;
  searchOpen: boolean;
  canCall: boolean;
  callDisabled: boolean;
  /** Desktop-only chips (ticket, orders) rendered after the name block. */
  chips?: React.ReactNode;
  onBack: () => void;
  onTogglePanel: () => void;
  onAssign: (userId: number | null) => void;
  onSetStatus: (s: ConvoStatus) => void;
  onCall: () => void;
  onToggleSearch: () => void;
  onTogglePin: () => void;
  onClear: () => void;
  onBlock: () => void;
  onAudit: () => void;
  onNotes: () => void;
  onTicket: () => void;
  onSendTemplate: () => void;
  onAddLabel: (label: string) => Promise<void> | void;
  onRemoveLabel: (label: string) => Promise<void> | void;
  /** Bumped by a keyboard shortcut to open the assignee picker. */
  assignSignal?: number;
}

/** 24h customer-service window as a countdown: green → amber (<2h) → closed. */
export function WindowPill({
  expiresAt,
  now,
  compact,
  onSendTemplate,
}: {
  expiresAt: string | null | undefined;
  now: number;
  compact?: boolean;
  onSendTemplate?: () => void;
}) {
  const ms = expiresAt ? new Date(expiresAt).getTime() - now : -1;
  const open = Number.isFinite(ms) && ms > 0;
  if (!open) {
    return (
      <button
        type="button"
        onClick={onSendTemplate}
        disabled={!onSendTemplate}
        title="The 24-hour window is closed — only approved templates can be sent"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:cursor-default"
      >
        <Clock size={13} aria-hidden />
        {compact ? 'Closed' : 'Window closed'}
        {!compact && onSendTemplate && (
          <span className="underline underline-offset-2">Send template</span>
        )}
      </button>
    );
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const urgent = ms < 2 * 3_600_000;
  const pct = Math.max(4, Math.min(100, (ms / (24 * 3_600_000)) * 100));
  return (
    <span
      title="Time left to reply freely (WhatsApp 24-hour window)"
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums',
        urgent ? 'bg-amber-50 text-amber-800' : 'bg-brand-50 text-brand-800',
      )}
    >
      <Clock size={13} aria-hidden />
      {compact ? `${h}h ${m}m` : `${h}h ${m}m left`}
      {!compact && (
        <span
          className={cn(
            'hidden h-1.5 w-10 overflow-hidden rounded-full lg:inline-block',
            urgent ? 'bg-amber-200' : 'bg-brand-100',
          )}
          aria-hidden
        >
          <span
            className={cn('block h-full rounded-full', urgent ? 'bg-amber-600' : 'bg-brand-600')}
            style={{ width: `${pct}%` }}
          />
        </span>
      )}
    </span>
  );
}

/** Searchable assignee list (desktop popover + mobile modal share it). */
function AssigneeList({
  members,
  currentId,
  meId,
  onPick,
}: {
  members: TeamMember[];
  currentId: number | null;
  meId: number | undefined;
  onPick: (id: number | null) => void;
}) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const active = members.filter((m) => m.status === 'active' || m.id === currentId);
    const sorted = [...active].sort((a, b) =>
      a.id === meId ? -1 : b.id === meId ? 1 : a.name.localeCompare(b.name),
    );
    const needle = q.trim().toLowerCase();
    return needle ? sorted.filter((m) => m.name.toLowerCase().includes(needle)) : sorted;
  }, [members, currentId, meId, q]);
  return (
    <div className="flex flex-col">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && list[0]) onPick(list[0].id);
        }}
        placeholder="Find a teammate"
        aria-label="Find a teammate"
        className="mx-2 mb-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
        {currentId != null && (
          <li>
            <button
              role="option"
              aria-selected={false}
              onClick={() => onPick(null)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted hover:bg-sunken"
            >
              <UserMinus size={16} /> Unassign
            </button>
          </li>
        )}
        {list.map((m) => (
          <li key={m.id}>
            <button
              role="option"
              aria-selected={m.id === currentId}
              onClick={() => onPick(m.id)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-sunken',
                m.id === currentId && 'bg-brand-50',
              )}
            >
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white',
                  avatarColor(m.name),
                )}
                aria-hidden
              >
                {initialsOf(m.name)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {m.name}
                {m.id === meId ? ' (me)' : ''}
              </span>
              <span className="text-xs capitalize text-muted">{m.role}</span>
              {m.id === currentId && <Check size={14} className="text-brand-600" />}
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="px-3 py-2 text-sm text-muted">No match</li>}
      </ul>
    </div>
  );
}

/** Inline label editor with autocomplete from labels already in use. */
export function LabelEditor({
  labels,
  onAdd,
  onRemove,
}: {
  labels: string[];
  onAdd: (l: string) => Promise<void> | void;
  onRemove: (l: string) => Promise<void> | void;
}) {
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<string[]>([]);
  useEffect(() => {
    apiFetch<{ label: string }[]>('/inbox/labels')
      .then((r) => setOptions(Array.isArray(r) ? r.map((x) => x.label) : []))
      .catch(() => {});
  }, []);
  const lower = labels.map((l) => l.toLowerCase());
  const needle = q.trim().toLowerCase();
  const suggestions = options
    .filter((o) => !lower.includes(o.toLowerCase()) && (!needle || o.toLowerCase().includes(needle)))
    .slice(0, 8);
  const add = async (l: string) => {
    const v = l.trim();
    if (!v || lower.includes(v.toLowerCase())) {
      setQ('');
      return;
    }
    await onAdd(v);
    setQ('');
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {labels.length === 0 && <span className="text-sm text-muted">No labels yet.</span>}
        {labels.map((l) => (
          <span key={l} className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-800">
            {l}
            <button
              type="button"
              onClick={() => void onRemove(l)}
              aria-label={`Remove label ${l}`}
              className="rounded-full p-0.5 hover:bg-sky-100"
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <div>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add(suggestions.find((s) => s.toLowerCase() === needle) ?? q);
            }
          }}
          placeholder="Add a label and press Enter"
          aria-label="Add a label"
          maxLength={60}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        {suggestions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void add(s)}
                className="rounded-full border border-dashed border-line px-2.5 py-1 text-xs text-muted hover:border-brand-500 hover:text-brand-700"
              >
                + {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink disabled:opacity-40',
        active && 'bg-brand-50 text-brand-700 hover:bg-brand-50 hover:text-brand-700',
      )}
    >
      {children}
    </button>
  );
}

export default function ThreadHeader(p: ThreadHeaderProps) {
  const c = p.convo;
  const name = c?.contact?.name || c?.contact?.phone || 'Conversation';
  const status = c?.status ?? 'open';
  const blocked = c?.contact?.status === 'blocked';
  const assigned = c?.assigned_user ?? null;
  const isMine = !!assigned && assigned.id === p.meId;
  const labels = (c?.labels ?? []).map((l) => l.label);

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignModal, setAssignModal] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const assignRef = useRef<HTMLDivElement>(null);

  // Keyboard "A" (from the page) opens the assignee picker.
  const firstSignal = useRef(p.assignSignal);
  useEffect(() => {
    if (p.assignSignal === firstSignal.current) return;
    if (p.canManageAssign) {
      if (window.matchMedia?.('(min-width: 768px)').matches) setAssignOpen(true);
      else setAssignModal(true);
    } else if (!isMine && p.meId) p.onAssign(p.meId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.assignSignal]);

  useEffect(() => {
    if (!assignOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (assignRef.current && !assignRef.current.contains(e.target as Node)) setAssignOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAssignOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [assignOpen]);

  const pick = (id: number | null) => {
    setAssignOpen(false);
    setAssignModal(false);
    p.onAssign(id);
  };

  const statusItems: DropdownItem[] = [
    status !== 'resolved'
      ? { key: 'resolve', label: 'Resolve', icon: CheckCircle2, onSelect: () => p.onSetStatus('resolved') }
      : { key: 'reopen', label: 'Reopen', icon: RotateCcw, onSelect: () => p.onSetStatus('open') },
    status !== 'pending'
      ? { key: 'pending', label: 'Mark pending', icon: Clock, onSelect: () => p.onSetStatus('pending') }
      : { key: 'open', label: 'Mark open', icon: RotateCcw, onSelect: () => p.onSetStatus('open') },
  ];

  // Shared overflow actions (desktop ⋯ + mobile ⋯).
  const menuItems: DropdownItem[] = [
    { key: 'pin', label: c?.pinned_at ? 'Unpin conversation' : 'Pin to top', icon: c?.pinned_at ? PinOff : Pin, onSelect: p.onTogglePin },
    { key: 'labels', label: 'Labels…', icon: Tag, onSelect: () => setLabelsOpen(true) },
    { key: 'notes', label: 'Internal notes', icon: StickyNote, onSelect: p.onNotes },
    { key: 'ticket', label: 'Support ticket', icon: LifeBuoy, onSelect: p.onTicket },
    { key: 'template', label: 'Send template', icon: FileText, onSelect: p.onSendTemplate },
    { key: 'audit', label: 'Why this reply?', icon: History, onSelect: p.onAudit },
    { key: 'clear', label: 'Clear chat', icon: Eraser, onSelect: p.onClear },
    { key: 'block', label: blocked ? 'Unblock contact' : 'Block contact', icon: Ban, danger: !blocked, onSelect: p.onBlock },
  ];
  const mobileItems: DropdownItem[] = [
    p.canManageAssign
      ? { key: 'assign', label: assigned ? `Assigned: ${assigned.name.split(' ')[0]}` : 'Assign…', icon: UserCheck, onSelect: () => setAssignModal(true) }
      : isMine
        ? { key: 'mine', label: 'Assigned to you', icon: UserCheck, disabled: true, onSelect: () => {} }
        : { key: 'assign-me', label: 'Assign to me', icon: UserCheck, onSelect: () => p.meId && p.onAssign(p.meId) },
    ...statusItems,
    ...(p.canCall
      ? [{ key: 'call', label: 'Call on WhatsApp', icon: PhoneCall, disabled: p.callDisabled, onSelect: p.onCall }]
      : []),
    { key: 'search', label: 'Search in chat', icon: Search, onSelect: p.onToggleSearch },
    ...menuItems,
  ];

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line bg-surface px-2 py-2 md:px-4">
        <button
          type="button"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-sunken md:hidden"
          onClick={p.onBack}
          aria-label="Back to conversations"
        >
          <ArrowLeft size={20} />
        </button>
        <button
          type="button"
          onClick={p.onTogglePanel}
          aria-label={`Contact details for ${name}`}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-0.5 text-left hover:bg-sunken/60"
        >
          <span
            aria-hidden
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white',
              avatarColor(name),
            )}
          >
            {initialsOf(name)}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-semibold text-ink">{name}</span>
              {status !== 'open' && (
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 text-xs font-semibold',
                    status === 'pending' ? 'bg-amber-100 text-amber-800' : 'bg-sunken text-muted',
                  )}
                >
                  {status === 'pending' ? 'Pending' : 'Resolved'}
                </span>
              )}
              {blocked && (
                <span className="shrink-0 rounded bg-red-50 px-1.5 text-xs font-semibold text-red-700">Blocked</span>
              )}
              {c?.ai_autoreply === true && (
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-emerald-50 px-1.5 text-xs font-semibold text-emerald-700" title="AI auto-pilot is on for this chat">
                  <Bot size={12} /> <span className="hidden sm:inline">Auto-pilot</span>
                </span>
              )}
            </span>
            <span className="flex items-center gap-1.5 truncate text-xs text-muted">
              <span className="truncate">{c?.contact?.phone}</span>
              {labels.slice(0, 2).map((l) => (
                <span key={l} className="hidden shrink-0 rounded bg-sky-50 px-1.5 font-medium text-sky-800 lg:inline">
                  {l}
                </span>
              ))}
              {labels.length > 2 && <span className="hidden lg:inline">+{labels.length - 2}</span>}
            </span>
          </span>
        </button>

        <div className="flex items-center gap-2">{p.chips}</div>

        <span className="md:hidden">
          <WindowPill expiresAt={p.windowExpiresAt} now={p.now} compact />
        </span>
        <span className="hidden md:inline-flex">
          <WindowPill expiresAt={p.windowExpiresAt} now={p.now} onSendTemplate={p.onSendTemplate} />
        </span>

        {/* Desktop actions */}
        <div className="hidden items-center gap-1 md:flex">
          {p.canManageAssign ? (
            <div ref={assignRef} className="relative">
              <button
                type="button"
                onClick={() => setAssignOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={assignOpen}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-2 text-sm font-medium hover:bg-sunken"
              >
                {assigned ? (
                  <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white', avatarColor(assigned.name))} aria-hidden>
                    {initialsOf(assigned.name)}
                  </span>
                ) : (
                  <UserCheck size={15} className="text-muted" />
                )}
                <span className="max-w-[7rem] truncate">{assigned ? (isMine ? 'Me' : assigned.name.split(' ')[0]) : 'Assign'}</span>
                <ChevronDown size={14} className="text-muted" />
              </button>
              {assignOpen && (
                <div className="absolute right-0 z-40 mt-1 w-64 rounded-xl border border-line bg-surface pt-2 shadow-lg">
                  <AssigneeList members={p.members} currentId={assigned?.id ?? null} meId={p.meId} onPick={pick} />
                </div>
              )}
            </div>
          ) : !isMine ? (
            <button
              type="button"
              onClick={() => p.meId && p.onAssign(p.meId)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm font-medium hover:bg-sunken"
            >
              <UserCheck size={15} /> Assign to me
            </button>
          ) : null}

          <div className="flex items-center">
            <button
              type="button"
              onClick={() => p.onSetStatus(status === 'resolved' ? 'open' : 'resolved')}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-l-lg px-3 text-sm font-semibold',
                status === 'resolved'
                  ? 'border border-line text-ink hover:bg-sunken'
                  : 'bg-brand-600 text-white hover:bg-brand-700',
              )}
            >
              {status === 'resolved' ? <RotateCcw size={15} /> : <CheckCircle2 size={15} />}
              {status === 'resolved' ? 'Reopen' : 'Resolve'}
            </button>
            <Dropdown
              label="More status options"
              items={statusItems.slice(1)}
              trigger={
                <span
                  className={cn(
                    'flex h-9 w-7 items-center justify-center rounded-r-lg border-l',
                    status === 'resolved'
                      ? 'border border-l-0 border-line text-muted hover:bg-sunken'
                      : 'border-brand-700 bg-brand-600 text-white hover:bg-brand-700',
                  )}
                >
                  <ChevronDown size={14} />
                </span>
              }
            />
          </div>

          {p.canCall && (
            <IconBtn label="Call on WhatsApp" onClick={p.onCall} disabled={p.callDisabled}>
              <PhoneCall size={18} />
            </IconBtn>
          )}
          <IconBtn label="Search in chat (Ctrl+F)" onClick={p.onToggleSearch} active={p.searchOpen}>
            <Search size={18} />
          </IconBtn>
          <IconBtn label="Contact info (I)" onClick={p.onTogglePanel} active={p.panelOpen}>
            <Info size={18} />
          </IconBtn>
          <Dropdown
            label="More actions"
            items={menuItems}
            trigger={
              <span className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink">
                <MoreVertical size={18} />
              </span>
            }
          />
        </div>

        {/* Mobile actions */}
        <div className="flex items-center md:hidden">
          <IconBtn label="Contact info" onClick={p.onTogglePanel} active={p.panelOpen}>
            <Info size={19} />
          </IconBtn>
          <Dropdown
            label="More actions"
            items={mobileItems}
            trigger={
              <span className="flex h-9 w-9 items-center justify-center rounded-lg text-muted">
                <MoreVertical size={20} />
              </span>
            }
          />
        </div>
      </div>

      <Modal open={assignModal} onClose={() => setAssignModal(false)} title="Assign conversation">
        <AssigneeList members={p.members} currentId={assigned?.id ?? null} meId={p.meId} onPick={pick} />
      </Modal>
      <Modal open={labelsOpen} onClose={() => setLabelsOpen(false)} title="Labels">
        <LabelEditor labels={labels} onAdd={p.onAddLabel} onRemove={p.onRemoveLabel} />
      </Modal>
    </>
  );
}
