'use client';

// /admin/requests interactive shell — R47.2.
//
// One client component owns the entire interactive surface:
//   • Filter bar (search box, date range presets, category dropdown,
//     status pills, archive-toggle, sort key/direction).
//   • Sortable table with per-row checkboxes, whole-row click-to-open,
//     and a ⋯ action menu (archive, re-run extractor, retry unreached).
//   • Sticky bulk-action bar that appears when ≥1 row is selected.
//
// Why one component instead of three? Because the bulk-action bar
// needs to know which row IDs are selected, the table owns the
// checkbox state, and the filter bar shares URL-param updates with
// every other piece. Splitting them would mean lifting state to a
// shared parent anyway, so we keep them together and let the
// page.tsx (server component) hand us the pre-filtered rows + the
// pagination math.
//
// URL contract (every change debounces or fires immediately into
// router.replace, so back/forward works):
//   ?q=…             — free-text search
//   ?from=YYYY-MM-DD — created_at >=
//   ?to=YYYY-MM-DD   — created_at <=
//   ?category=slug   — service_categories.slug
//   ?status=…        — quote_requests.status enum
//   ?include_archived=1
//   ?sort=created_at|status|calls|quotes|location
//   ?dir=asc|desc
//   ?page=N
//
// Server component (page.tsx) is the single source of truth for the
// rows shown. We do NOT re-filter client-side — every interaction
// pushes a URL change and the server re-renders. That keeps the
// query authoritative and the state model boring.

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  bulkArchive,
  setRequestArchived,
  retryUnreachedBusinesses,
  rerunExtractor,
} from '@/lib/actions/admin';

// ── Types kept loose — we accept what the server sends. ───────────
export type ExplorerRow = {
  id: string;
  status: string;
  city: string;
  state: string;
  zip_code: string;
  total_businesses_to_call: number | null;
  total_calls_completed: number | null;
  total_quotes_collected: number | null;
  archived_at: string | null;
  created_at: string;
  category_name: string | null;
  contact_name: string | null;
  contact_email_masked: string | null;
};

export type ExplorerCategory = { slug: string; name: string };

export type SortKey = 'created_at' | 'status' | 'calls' | 'quotes' | 'location';
export type SortDir = 'asc' | 'desc';

const STATUSES = [
  'all',
  'pending_payment',
  'paid',
  'calling',
  'processing',
  'completed',
  'failed',
] as const;

// Date presets: relative ranges that map to absolute YYYY-MM-DD
// strings at click time. "Custom" reveals two date inputs.
type DatePreset = 'all' | 'today' | '7d' | '30d' | 'custom';

export function RequestsExplorer({
  rows,
  total,
  page,
  pageSize,
  pages,
  categories,
  initial,
}: {
  rows: ExplorerRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  categories: ExplorerCategory[];
  initial: {
    q: string;
    from: string;
    to: string;
    category: string;
    status: string;
    includeArchived: boolean;
    sort: SortKey;
    dir: SortDir;
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [, startTransition] = useTransition();

  // ── URL helpers ─────────────────────────────────────────────────
  // pushParams merges patches into the current URL. Empty / falsy
  // values delete the param so the URL stays clean.
  const pushParams = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const params = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '' || v === 'all' || v === 'false') {
          params.delete(k);
        } else {
          params.set(k, v);
        }
      }
      // Any filter / sort change resets pagination — page=2 of an
      // empty filter is a confusing dead-end.
      if (Object.keys(patch).some((k) => k !== 'page')) {
        params.delete('page');
      }
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname);
      });
    },
    [pathname, router, sp]
  );

  // ── Search input — debounced 300ms so we don't refetch on every
  //    keystroke but the URL still tracks recent input.
  const [qLocal, setQLocal] = useState(initial.q);
  const qDebounce = useRef<number | null>(null);
  useEffect(() => {
    if (qDebounce.current) window.clearTimeout(qDebounce.current);
    qDebounce.current = window.setTimeout(() => {
      if (qLocal !== initial.q) pushParams({ q: qLocal || null });
    }, 300);
    return () => {
      if (qDebounce.current) window.clearTimeout(qDebounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qLocal]);

  // ── Date preset → from/to ───────────────────────────────────────
  const datePreset: DatePreset = useMemo(() => {
    if (!initial.from && !initial.to) return 'all';
    const today = new Date().toISOString().slice(0, 10);
    const d7 = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const d30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    if (initial.from === today && !initial.to) return 'today';
    if (initial.from === d7 && !initial.to) return '7d';
    if (initial.from === d30 && !initial.to) return '30d';
    return 'custom';
  }, [initial.from, initial.to]);

  const applyDatePreset = (p: DatePreset) => {
    if (p === 'all') return pushParams({ from: null, to: null });
    const today = new Date().toISOString().slice(0, 10);
    if (p === 'today') return pushParams({ from: today, to: null });
    if (p === '7d') {
      const d = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      return pushParams({ from: d, to: null });
    }
    if (p === '30d') {
      const d = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      return pushParams({ from: d, to: null });
    }
    // custom: leave existing values, the inputs will appear
  };

  // ── Selection state ─────────────────────────────────────────────
  // Selected ids are local — re-rendering on URL change keeps the
  // selection only for ids still on the visible page. That's the
  // right behavior: changing filter + then bulk-archive should not
  // apply to off-page rows the user never saw.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set<string>();
      for (const r of rows) if (prev.has(r.id)) next.add(r.id);
      return next;
    });
  }, [rows]);

  const allOnPageSelected =
    rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someOnPageSelected = rows.some((r) => selected.has(r.id));

  const toggleAll = () => {
    if (allOnPageSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => r.id)));
    }
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Sort header click → flip dir if same key, default desc on
  //    new key. created_at default direction is desc; everything
  //    else defaults to asc on first click.
  const headerSortClick = (key: SortKey) => {
    if (initial.sort === key) {
      pushParams({ dir: initial.dir === 'asc' ? 'desc' : 'asc' });
    } else {
      pushParams({ sort: key, dir: key === 'created_at' ? 'desc' : 'asc' });
    }
  };
  const sortGlyph = (key: SortKey): string =>
    initial.sort === key ? (initial.dir === 'asc' ? '▲' : '▼') : '';

  // ── Bulk archive ────────────────────────────────────────────────
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkNote, setBulkNote] = useState<string | null>(null);

  // Mixed selections (some archived, some not) → archive all.
  // Pure archived → unarchive all. Pure active → archive all.
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const allSelectedArchived =
    selectedRows.length > 0 && selectedRows.every((r) => r.archived_at);
  const bulkAction: 'archive' | 'unarchive' = allSelectedArchived
    ? 'unarchive'
    : 'archive';

  const handleBulk = async () => {
    setBulkError(null);
    setBulkNote(null);
    setBulkPending(true);
    try {
      const ids = Array.from(selected);
      const res = await bulkArchive(ids, bulkAction === 'archive');
      if (res.ok) {
        setSelected(new Set());
        setBulkNote(res.note ?? 'Done.');
      } else {
        setBulkError(res.error);
      }
    } finally {
      setBulkPending(false);
    }
  };

  // ── Per-row action menu ────────────────────────────────────────
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<{
    id: string;
    note?: string;
    err?: string;
  } | null>(null);

  // Close the open menu when clicking outside.
  const tableRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openMenuId) return;
    const onDoc = (e: MouseEvent) => {
      if (!tableRef.current) return;
      if (!tableRef.current.contains(e.target as Node)) setOpenMenuId(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [openMenuId]);

  const runRowAction = async (
    rowId: string,
    fn: () => Promise<{ ok: true; note?: string } | { ok: false; error: string }>
  ) => {
    setOpenMenuId(null);
    setRowBusy(rowId);
    setRowMsg(null);
    try {
      const res = await fn();
      if (res.ok) setRowMsg({ id: rowId, note: res.note ?? 'Done.' });
      else setRowMsg({ id: rowId, err: res.error });
    } finally {
      setRowBusy(null);
    }
  };

  // ── Open row on click of any cell except the checkbox / menu. ───
  const openRow = (id: string) => router.push(`/admin/requests/${id}`);

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div ref={tableRef}>
      {/* ── Filter bar ─────────────────────────────────────────── */}
      <div className="mb-4 grid gap-3 rounded-md border-2 border-foreground/20 bg-card p-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        {/* Search */}
        <label className="block">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Search
          </span>
          <input
            type="search"
            value={qLocal}
            onChange={(e) => setQLocal(e.target.value)}
            placeholder="city, contact name, email…"
            className="mt-1 w-full rounded-md border-2 border-foreground/40 bg-background px-3 py-1.5 text-sm focus:border-foreground focus:outline-none"
          />
        </label>

        {/* Category */}
        <label className="block">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Category
          </span>
          <select
            value={initial.category}
            onChange={(e) => pushParams({ category: e.target.value || null })}
            className="mt-1 rounded-md border-2 border-foreground/40 bg-background px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        {/* Date preset */}
        <div>
          <span className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Date
          </span>
          <div className="mt-1 flex flex-wrap gap-1">
            {(['all', 'today', '7d', '30d', 'custom'] as DatePreset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => applyDatePreset(p)}
                className={
                  'rounded-md border-2 px-2 py-1 font-mono text-[11px] uppercase tracking-widest ' +
                  (datePreset === p
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-foreground/40 hover:bg-lime')
                }
              >
                {p === 'all' ? 'All' : p === 'today' ? 'Today' : p === '7d' ? '7d' : p === '30d' ? '30d' : 'Custom'}
              </button>
            ))}
          </div>
          {datePreset === 'custom' ? (
            <div className="mt-1 flex gap-1">
              <input
                type="date"
                value={initial.from}
                onChange={(e) => pushParams({ from: e.target.value || null })}
                className="rounded-md border-2 border-foreground/40 bg-background px-2 py-1 text-xs"
              />
              <input
                type="date"
                value={initial.to}
                onChange={(e) => pushParams({ to: e.target.value || null })}
                className="rounded-md border-2 border-foreground/40 bg-background px-2 py-1 text-xs"
              />
            </div>
          ) : null}
        </div>

        {/* Status pills + archive toggle (full width below the grid) */}
        <div className="flex flex-wrap items-center gap-1.5 sm:col-span-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Status
          </span>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => pushParams({ status: s === 'all' ? null : s })}
              className={
                'rounded-md border-2 px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest ' +
                ((initial.status || 'all') === s
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-foreground/40 hover:bg-lime')
              }
            >
              {s}
            </button>
          ))}
          <span className="mx-1 text-muted-foreground/60">·</span>
          <button
            type="button"
            onClick={() =>
              pushParams({
                include_archived: initial.includeArchived ? null : '1',
              })
            }
            className={
              'rounded-md border-2 px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest ' +
              (initial.includeArchived
                ? 'border-foreground bg-foreground text-background'
                : 'border-foreground/40 hover:bg-lime')
            }
          >
            {initial.includeArchived ? '↩ hide archived' : '+ include archived'}
          </button>
        </div>
      </div>

      {/* ── Result count + pagination summary ─────────────────── */}
      <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">
        {total.toLocaleString()} result{total === 1 ? '' : 's'} · page {page} of{' '}
        {pages}
        {selected.size > 0 ? ` · ${selected.size} selected` : ''}
      </p>

      {/* ── Table ─────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-md border-2 border-foreground/80">
        <table className="w-full text-sm">
          <thead className="bg-foreground/5 text-left font-mono text-[11px] uppercase tracking-widest">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={allOnPageSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allOnPageSelected && someOnPageSelected;
                  }}
                  onChange={toggleAll}
                />
              </th>
              <SortableHeader label="Created" sortKey="created_at" current={initial.sort} dir={initial.dir} onSort={headerSortClick} glyph={sortGlyph('created_at')} />
              <th className="px-3 py-2">Category</th>
              <SortableHeader label="Location" sortKey="location" current={initial.sort} dir={initial.dir} onSort={headerSortClick} glyph={sortGlyph('location')} />
              <th className="px-3 py-2">Contact</th>
              <SortableHeader label="Status" sortKey="status" current={initial.sort} dir={initial.dir} onSort={headerSortClick} glyph={sortGlyph('status')} />
              <SortableHeader label="Calls" sortKey="calls" current={initial.sort} dir={initial.dir} onSort={headerSortClick} glyph={sortGlyph('calls')} align="right" />
              <SortableHeader label="Quotes" sortKey="quotes" current={initial.sort} dir={initial.dir} onSort={headerSortClick} glyph={sortGlyph('quotes')} align="right" />
              <th className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-12 text-center">
                  <p className="text-base">No requests match these filters.</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Try clearing the search or widening the date range.
                  </p>
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const isSelected = selected.has(r.id);
                const isBusy = rowBusy === r.id;
                const isArchived = !!r.archived_at;
                const msg = rowMsg?.id === r.id ? rowMsg : null;
                return (
                  <tr
                    key={r.id}
                    onClick={(e) => {
                      // Ignore clicks that originated inside the
                      // checkbox cell or action menu.
                      const tgt = e.target as HTMLElement;
                      if (tgt.closest('[data-row-noclick]')) return;
                      openRow(r.id);
                    }}
                    className={
                      'cursor-pointer border-t border-foreground/10 transition-colors hover:bg-lime/30 ' +
                      (isArchived ? 'opacity-60 ' : '') +
                      (isSelected ? 'bg-lime/40 ' : '')
                    }
                  >
                    <td className="px-3 py-2" data-row-noclick>
                      <input
                        type="checkbox"
                        aria-label={`Select request ${r.id.slice(0, 8)}`}
                        checked={isSelected}
                        onChange={() => toggleOne(r.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {new Date(r.created_at).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {isArchived ? (
                        <span className="ml-1 rounded-sm bg-foreground/10 px-1 py-0.5 text-[9px] uppercase tracking-widest text-muted-foreground">
                          archived
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">{r.category_name ?? '—'}</td>
                    <td className="px-3 py-2">
                      {r.city}, {r.state} {r.zip_code}
                    </td>
                    <td className="px-3 py-2">
                      <div>{r.contact_name ?? '—'}</div>
                      {r.contact_email_masked ? (
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {r.contact_email_masked}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-mono text-[10px] uppercase tracking-widest">
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {r.total_calls_completed ?? 0}/{r.total_businesses_to_call ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {r.total_quotes_collected ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right" data-row-noclick>
                      <RowActionMenu
                        rowId={r.id}
                        archived={isArchived}
                        busy={isBusy}
                        open={openMenuId === r.id}
                        onToggle={() =>
                          setOpenMenuId((cur) => (cur === r.id ? null : r.id))
                        }
                        onArchive={() =>
                          runRowAction(r.id, () =>
                            setRequestArchived(r.id, !isArchived)
                          )
                        }
                        onRerun={() =>
                          runRowAction(r.id, () => rerunExtractor(r.id))
                        }
                        onRetry={() =>
                          runRowAction(r.id, () => retryUnreachedBusinesses(r.id))
                        }
                      />
                      {msg ? (
                        <p
                          className={
                            'mt-1 text-[10px] ' +
                            (msg.err
                              ? 'text-destructive'
                              : 'text-muted-foreground')
                          }
                        >
                          {msg.err ?? msg.note}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ─────────────────────────────────────────── */}
      {pages > 1 ? (
        <div className="mt-4 flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => pushParams({ page: String(page - 1) })}
            className="rounded-md border-2 border-foreground/60 px-3 py-1 hover:bg-lime disabled:cursor-not-allowed disabled:border-foreground/20 disabled:text-muted-foreground disabled:hover:bg-transparent"
          >
            ← Prev
          </button>
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          <button
            type="button"
            disabled={page >= pages}
            onClick={() => pushParams({ page: String(page + 1) })}
            className="rounded-md border-2 border-foreground/60 px-3 py-1 hover:bg-lime disabled:cursor-not-allowed disabled:border-foreground/20 disabled:text-muted-foreground disabled:hover:bg-transparent"
          >
            Next →
          </button>
          <span className="ml-2 text-muted-foreground">
            ({pageSize}/page)
          </span>
        </div>
      ) : null}

      {/* ── Sticky bulk action bar ────────────────────────────── */}
      {selected.size > 0 ? (
        <div
          role="region"
          aria-label="Bulk actions"
          className="fixed inset-x-0 bottom-0 z-30 border-t-2 border-foreground bg-cream shadow-[0_-4px_0_0_hsl(var(--foreground))]"
        >
          <div className="container flex flex-wrap items-center gap-3 py-3">
            <span className="font-mono text-xs uppercase tracking-widest">
              {selected.size} selected
            </span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-md border-2 border-foreground/40 px-3 py-1 font-mono text-xs uppercase tracking-widest hover:bg-foreground/5"
            >
              Clear
            </button>
            <div className="ml-auto flex items-center gap-3">
              {bulkNote ? (
                <span className="text-xs text-muted-foreground">{bulkNote}</span>
              ) : null}
              {bulkError ? (
                <span className="text-xs text-destructive">{bulkError}</span>
              ) : null}
              <button
                type="button"
                onClick={handleBulk}
                disabled={bulkPending}
                className={
                  'rounded-md border-2 border-foreground bg-lime px-4 py-1.5 font-mono text-xs uppercase tracking-widest hover:bg-lime-deep disabled:opacity-50 ' +
                  (bulkAction === 'archive' ? '' : 'bg-cream hover:bg-foreground/5')
                }
              >
                {bulkPending
                  ? '…'
                  : bulkAction === 'archive'
                    ? `Archive ${selected.size}`
                    : `Unarchive ${selected.size}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Sortable header cell ──────────────────────────────────────────
function SortableHeader({
  label,
  sortKey,
  current,
  dir,
  onSort,
  glyph,
  align,
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  glyph: string;
  align?: 'right' | 'left';
}) {
  void current;
  void dir;
  return (
    <th className={'px-3 py-2 ' + (align === 'right' ? 'text-right' : '')}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 font-mono uppercase tracking-widest hover:text-foreground"
      >
        <span>{label}</span>
        {glyph ? <span className="text-[9px]">{glyph}</span> : null}
      </button>
    </th>
  );
}

// ── Row ⋯ action menu ─────────────────────────────────────────────
function RowActionMenu({
  rowId,
  archived,
  busy,
  open,
  onToggle,
  onArchive,
  onRerun,
  onRetry,
}: {
  rowId: string;
  archived: boolean;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onArchive: () => void;
  onRerun: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        aria-label="Row actions"
        aria-expanded={open}
        className="rounded-md border-2 border-foreground/40 px-2 py-1 font-mono text-xs hover:bg-lime disabled:opacity-50"
      >
        {busy ? '…' : '⋯'}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border-2 border-foreground/80 bg-background shadow-[4px_4px_0_0_hsl(var(--foreground))]"
        >
          <Link
            href={`/admin/requests/${rowId}`}
            role="menuitem"
            className="block px-3 py-2 text-left text-sm hover:bg-lime/60"
          >
            Open detail →
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={onArchive}
            className="block w-full px-3 py-2 text-left text-sm hover:bg-lime/60"
          >
            {archived ? 'Unarchive' : 'Archive'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={onRerun}
            className="block w-full px-3 py-2 text-left text-sm hover:bg-lime/60"
          >
            Re-run extractor
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={onRetry}
            className="block w-full px-3 py-2 text-left text-sm hover:bg-lime/60"
          >
            Retry unreached
          </button>
        </div>
      ) : null}
    </div>
  );
}
