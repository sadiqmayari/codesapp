'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import {
  GameMetric,
  METRIC_LABELS,
  PERIOD_LABELS,
  TargetPeriod,
  setTarget,
} from '@/lib/gamification';

const METRICS: GameMetric[] = [
  'orders',
  'revenue',
  'chats',
  'conversion',
  'carts',
  'points',
];
const PERIODS: TargetPeriod[] = ['daily', 'weekly', 'monthly'];

export function TargetModal({
  open,
  agents,
  onClose,
  onSaved,
}: {
  open: boolean;
  agents: Array<{ id: number; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [userId, setUserId] = useState<number | ''>(agents[0]?.id ?? '');
  const [metric, setMetric] = useState<GameMetric>('orders');
  const [periodType, setPeriodType] = useState<TargetPeriod>('monthly');
  const [targetValue, setTargetValue] = useState('');
  const [saving, setSaving] = useState(false);

  const canSave = userId !== '' && targetValue.trim() !== '' && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await setTarget({
        userId: Number(userId),
        metric,
        periodType,
        targetValue: Number(targetValue),
      });
      toast.success('Target assigned');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to assign target');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Assign target"
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
            {saving ? 'Saving…' : 'Assign'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Agent">
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : '')}
            className="gm-input"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Metric">
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as GameMetric)}
              className="gm-input"
            >
              {METRICS.map((m) => (
                <option key={m} value={m}>
                  {METRIC_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Period">
            <select
              value={periodType}
              onChange={(e) => setPeriodType(e.target.value as TargetPeriod)}
              className="gm-input"
            >
              {PERIODS.map((p) => (
                <option key={p} value={p}>
                  {PERIOD_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Target value">
          <input
            type="number"
            min={0}
            value={targetValue}
            onChange={(e) => setTargetValue(e.target.value)}
            placeholder={metric === 'conversion' ? 'e.g. 0.3 (=30%)' : 'e.g. 50'}
            className="gm-input"
          />
        </Field>
        {metric === 'conversion' && (
          <p className="text-xs text-gray-400">
            Conversion is a ratio — enter 0.3 for a 30% target.
          </p>
        )}
      </div>

      <style jsx>{`
        :global(.gm-input) {
          width: 100%;
          border: 1px solid rgb(209 213 219);
          border-radius: 0.5rem;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
        }
        :global(.gm-input:focus) {
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
