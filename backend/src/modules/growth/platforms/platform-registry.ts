import { Injectable, NotImplementedException } from '@nestjs/common';
import { AdPlatform, AdPlatformAdapter } from './ad-platform.types';
import { MetaAdapter } from './meta/meta.adapter';
import { GoogleAdsAdapter } from './google/google.adapter';
import { TikTokAdsAdapter } from './tiktok/tiktok.adapter';
import { SnapAdsAdapter } from './snap/snap.adapter';

/** Resolves the adapter for a platform. The single place a new platform plugs in. */
@Injectable()
export class PlatformRegistry {
  private readonly map: Record<AdPlatform, AdPlatformAdapter>;

  constructor(meta: MetaAdapter, google: GoogleAdsAdapter, tiktok: TikTokAdsAdapter, snap: SnapAdsAdapter) {
    this.map = { meta, google, tiktok, snap };
  }

  get(platform: string): AdPlatformAdapter {
    const a = this.map[platform as AdPlatform];
    if (!a) throw new NotImplementedException(`Unknown ad platform '${platform}'`);
    return a;
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
