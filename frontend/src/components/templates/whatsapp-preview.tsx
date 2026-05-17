'use client';

import type { TemplateComponent } from '@/lib/crm-types';

/** Renders a Meta `components` array as a WhatsApp-style green bubble. */
export function WhatsAppPreview({
  components,
}: {
  components: TemplateComponent[];
}) {
  const header = components.find((c) => c.type === 'HEADER');
  const body = components.find((c) => c.type === 'BODY');
  const footer = components.find((c) => c.type === 'FOOTER');
  const buttons = components.find((c) => c.type === 'BUTTONS');

  return (
    <div className="bg-[#e5ddd5] rounded-xl p-4 min-h-[200px]">
      <div className="max-w-[85%] bg-white rounded-lg shadow-sm overflow-hidden">
        {header && (
          <div>
            {header.format === 'TEXT' ? (
              <p className="px-3 pt-2 font-semibold text-gray-900 text-sm">
                {header.text || 'Header text'}
              </p>
            ) : (
              <div className="bg-gray-200 h-28 flex items-center justify-center text-xs text-gray-500">
                {header.format} header
              </div>
            )}
          </div>
        )}
        <p className="px-3 py-2 text-sm text-gray-800 whitespace-pre-wrap break-words">
          {body?.text || 'Body text appears here…'}
        </p>
        {footer?.text && (
          <p className="px-3 pb-2 text-xs text-gray-500">{footer.text}</p>
        )}
        <p className="px-3 pb-1 text-[10px] text-gray-400 text-right">
          12:00
        </p>
        {buttons?.buttons && buttons.buttons.length > 0 && (
          <div className="border-t border-gray-200 divide-y divide-gray-200">
            {buttons.buttons.map((b, i) => (
              <div
                key={i}
                className="py-2 text-center text-sm text-[#00a5f4] font-medium"
              >
                {b.text || 'Button'}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
