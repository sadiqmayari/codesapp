import { completedEntityKeys } from './growth-query.service';

const d = (s: string) => new Date(s);
const now = d('2026-11-22T12:00:00Z').getTime();

describe('completedEntityKeys', () => {
  it('marks ended ad sets, their campaign and ads; keeps running ones', () => {
    const keys = completedEntityKeys(
      [
        { level: 'campaign', external_id: 'c1', parent_external_id: null, campaign_id: 'c1', end_time: null },
        { level: 'adset', external_id: 's1', parent_external_id: 'c1', campaign_id: 'c1', end_time: d('2026-09-28T00:00:00Z') },
        { level: 'ad', external_id: 'a1', parent_external_id: 's1', campaign_id: 'c1', end_time: null },
        { level: 'campaign', external_id: 'c2', parent_external_id: null, campaign_id: 'c2', end_time: null },
        { level: 'adset', external_id: 's2', parent_external_id: 'c2', campaign_id: 'c2', end_time: null },
        { level: 'adset', external_id: 's3', parent_external_id: 'c2', campaign_id: 'c2', end_time: d('2026-01-01T00:00:00Z') },
        { level: 'campaign', external_id: 'c3', parent_external_id: null, campaign_id: 'c3', end_time: d('2026-10-01T00:00:00Z') },
      ],
      now,
    );
    expect([...keys].sort()).toEqual(['ad:a1', 'adset:s1', 'adset:s3', 'campaign:c1', 'campaign:c3']);
  });
});
