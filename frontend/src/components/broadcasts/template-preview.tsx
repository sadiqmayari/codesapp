'use client';

import { ExternalLink, Phone, Reply } from 'lucide-react';
import {
  getBodyText,
  getButtons,
  getFooterText,
  getHeaderText,
  renderWithValues,
  SAMPLE_CONTACT,
  type SampleContact,
} from '@/lib/broadcast-utils';
import type { Template } from '@/lib/crm-types';

/**
 * WhatsApp-style live preview of a template with {{n}} placeholders resolved
 * against a sample contact (so personalization is visible before sending).
 */
export function TemplatePreview({
  template,
  variables,
  sample = SAMPLE_CONTACT,
}: {
  template: Template | null;
  variables: Record<string, string>;
  sample?: SampleContact;
}) {
  if (!template) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-xs text-gray-400">
        Select a template to preview it.
      </div>
    );
  }

  const header = renderWithValues(getHeaderText(template), variables, sample);
  const body = renderWithValues(getBodyText(template), variables, sample);
  const footer = getFooterText(template);
  const buttons = getButtons(template);

  return (
    <div className="rounded-xl bg-[#e5ddd5] p-4">
      <div className="max-w-[20rem] ml-auto">
        <div className="relative rounded-lg rounded-tr-none bg-[#dcf8c6] px-3 py-2 shadow-sm">
          {header && (
            <p className="text-sm font-semibold text-gray-900 mb-1 whitespace-pre-wrap break-words">
              {header}
            </p>
          )}
          <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
            {body || '—'}
          </p>
          {footer && (
            <p className="text-[11px] text-gray-500 mt-1 whitespace-pre-wrap break-words">
              {footer}
            </p>
          )}
          <span className="block text-[10px] text-gray-400 text-right mt-1">
            12:00
          </span>
        </div>

        {buttons.length > 0 && (
          <div className="mt-1 space-y-1">
            {buttons.map((b, i) => (
              <div
                key={i}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm text-[#00a5f4] shadow-sm"
              >
                {b.type === 'URL' ? (
                  <ExternalLink size={14} />
                ) : b.type === 'PHONE_NUMBER' ? (
                  <Phone size={14} />
                ) : (
                  <Reply size={14} />
                )}
                {b.text}
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="text-[10px] text-gray-500 mt-2 text-center">
        Preview uses sample data ({sample.name}). Each recipient sees their own
        details.
      </p>
    </div>
  );
}
