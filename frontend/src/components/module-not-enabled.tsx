import { Lock } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * Shown in place of a page whose module the CodesApp super-admin hasn't
 * granted to this workspace. Nothing is deleted — data comes back when the
 * module is switched on again.
 */
export function ModuleNotEnabled({ label }: { label: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <EmptyState
        icon={Lock}
        title={`${label} isn't enabled for your workspace`}
        description="Your CodesApp account manager switches modules on for your workspace. Your data is kept — nothing is deleted."
      />
    </div>
  );
}
