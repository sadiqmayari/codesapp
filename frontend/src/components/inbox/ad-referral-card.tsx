'use client';

import { ExternalLink, Megaphone } from 'lucide-react';
import type { ConversationReferral } from '@/lib/inbox-types';
import { mediaUrl } from '@/lib/utils';

/**
 * Click-to-WhatsApp attribution banner shown at the top of a thread when the
 * chat started from a Meta ad or a FB/IG post (the `referral` object Meta
 * attaches to the first inbound message). Mirrors how WhatsApp/Meta surfaces
 * "this chat started from an ad". Renders nothing when there's no referral.
 */
export default function AdReferralCard({
  referral,
}: {
  referral: ConversationReferral | null | undefined;
}) {
  if (!referral) return null;
  const isAd = (referral.source_type || '').toLowerCase() === 'ad';
  const thumb = mediaUrl(
    referral.thumb_path || referral.thumbnail_url || referral.image_url || null,
  );
  const title =
    referral.headline?.trim() ||
    (isAd ? 'Started from an ad' : 'Started from a post');
  const hasBody = !!referral.body?.trim();

  return (
    <div className="bg-white border-b border-gray-100 px-4 py-2">
      <div className="flex items-center gap-3 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt=""
            className="w-11 h-11 rounded-lg object-cover bg-indigo-100 shrink-0"
          />
        ) : (
          <div className="w-11 h-11 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-500 shrink-0">
            <Megaphone size={18} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-700">
              <Megaphone size={12} />
              {isAd ? 'From Ad' : 'From Post'}
            </span>
          </div>
          <p className="text-sm font-medium text-gray-900 truncate">{title}</p>
          {hasBody && (
            <p className="text-xs text-gray-500 truncate">{referral.body}</p>
          )}
        </div>
        {referral.source_url && (
          <a
            href={referral.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-1 text-xs font-medium text-indigo-700 hover:text-indigo-900"
            title="View the source ad/post"
          >
            View <ExternalLink size={13} />
          </a>
        )}
      </div>
    </div>
  );
}
