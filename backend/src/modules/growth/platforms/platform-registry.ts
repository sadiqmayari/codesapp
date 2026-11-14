import { Injectable, NotImplementedException } from '@nestjs/common';
import { AdPlatform, AdPlatformAdapter, PLATFORM_LABEL } from './ad-platform.types';
import { AdPlatformWriter } from './ad-writer.types';
import { MetaAdapter } from './meta/meta.adapter';
import { MetaWriter } from './meta/meta.writer';
import { GoogleAdsAdapter } from './google/google.adapter';
import { TikTokAdsAdapter } from './tiktok/tiktok.adapter';
import { SnapAdsAdapter } from './snap/snap.adapter';

/** Resolves the adapter (read) and writer (manage) for a platform — the single place a platform plugs in. */
@Injectable()
export class PlatformRegistry {
  private readonly map: Record<AdPlatform, AdPlatformAdapter>;
  private readonly writers: Partial<Record<AdPlatform, AdPlatformWriter>>;

  constructor(
    meta: MetaAdapter,
    google: GoogleAdsAdapter,
    tiktok: TikTokAdsAdapter,
    snap: SnapAdsAdapter,
    metaWriter: MetaWriter,
  ) {
    this.map = { meta, google, tiktok, snap };
    this.writers = { meta: metaWriter };
  }

  get(platform: string): AdPlatformAdapter {
    const a = this.map[platform as AdPlatform];
    if (!a) throw new NotImplementedException(`Unknown ad platform '${platform}'`);
    return a;
  }

  /** Writer for ad management; 501 for platforms that can't be managed from CodesApp yet. */
  writer(platform: string): AdPlatformWriter {
    const w = this.writers[platform as AdPlatform];
    if (!w) {
      const label = PLATFORM_LABEL[platform as AdPlatform] ?? platform;
      throw new NotImplementedException(`Managing ${label} from CodesApp isn't available yet — use its ads manager for now.`);
    }
    return w;
  }

  canManage(platform: string): boolean {
    return !!this.writers[platform as AdPlatform];
  }

  availability(): Record<AdPlatform, boolean> {
    return {
      meta: this.map.meta.available,
      google: this.map.google.available,
      tiktok: this.map.tiktok.available,
      snap: this.map.snap.available,
    };
  }
}
