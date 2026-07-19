'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import {
  Contest,
  GameMetric,
  METRIC_LABELS,
  createContest,
  updateContest,
} from '@/lib/gamification';

const METRICS: GameMetric[] = ['orders', 'revenue', 'chats', 'conversion', 'points'];

/** ISO instant → value for a <input type="datetime-local"> (local wall time). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function ContestModal({
  open,
  existing,
  onClose,
  onSaved,
}: {
  open: boolean;
  existing?: Contest | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [metric, setMetric] = useState<GameMetric>(existing?.metric ?? 'orders');
  const [targetValue, setTargetValue] = useState(
    existing?.targetValue != null ? String(existing.targetValue) : '',
  );
  const [prize, setPrize] = useState(existing?.prize ?? '');
  const [startsAt, setStartsAt] = useState(
    existing ? toLocalInput(existing.startsAt) : toLocalInput(new Date().toISOString()),
  );
  const [endsAt, setEndsAt] = useState(
    existing ? toLocalInput(existing.endsAt) : '',
  );
  const [saving, setSaving] = useState(false);

  const canSave =
    name.trim().length > 0 && startsAt !== '' && endsAt !== '' && !saving;

  const save = async () => {
    if (!canSave) return;
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (end <= start) {
      toast.error('End must be after the start.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        metric,
        targetValue: targetValue.trim() ? Number(targetValue) : undefined,
        prize: prize.trim() || undefined,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
      };
      if (existing) await updateContest(existing.id, body);
      else await createContest(body);
      toast.success(existing ? 'Contest updated' : 'Contest created');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to save contest');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? 'Edit contest' : 'New contest'}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="px-4 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : existing ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. October Sales Sprint"
            className="input"
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="input resize-none"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Compete on">
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as GameMetric)}
              className="input"
            >
              {METRICS.map((m) => (
                <option key={m} value={m}>
                  {METRIC_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Goal (optional)">
            <input
              type="number"
              min={0}
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
              placeholder="e.g. 100"
              className="input"
            />
          </Field>
        </div>
        <Field label="Prize (optional)">
          <input
            value={prize}
            onChange={(e) => setPrize(e.target.value)}
            placeholder="e.g. Rs 10,000 bonus"
            className="input"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts">
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Ends">
            <input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className="input"
            />
          </Field>
        </div>
      </div>

      <style jsx>{`
        :global(.input) {
          width: 100%;
          border: 1px solid rgb(209 213 219);
          border-radius: 0.5rem;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
        }
        :global(.input:focus) {
          outline: none;
          border-color: rgb(22 163 74);
          box-shadow: 0 0 0 1px rgb(22 163 74);
        }
      `}</style>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-600 mb-1 block">{label}</span>
      {children}
    </label>
  );
}
