import { isHrAdmin, isPrivileged, teamManageError } from './roles';
import { FeatureService } from '../services/feature.service';

describe('roles', () => {
  it('groups', () => {
    expect(isPrivileged('owner')).toBe(true);
    expect(isPrivileged('admin')).toBe(true);
    expect(isPrivileged('hr_manager')).toBe(false);
    expect(isHrAdmin('hr_manager')).toBe(true);
    expect(isHrAdmin('agent')).toBe(false);
  });

  it('owner manages anyone except the owner', () => {
    expect(teamManageError('owner', 'admin', 'agent')).toBeNull();
    expect(teamManageError('owner', null, 'admin')).toBeNull();
    expect(teamManageError('owner', 'owner')).not.toBeNull();
  });

  it('admin cannot touch other admins or create admins', () => {
    expect(teamManageError('admin', 'admin')).not.toBeNull();
    expect(teamManageError('admin', 'agent', 'admin')).not.toBeNull();
    expect(teamManageError('admin', 'agent', 'hr_manager')).toBeNull();
    expect(teamManageError('admin', 'hr_manager')).toBeNull();
  });

  it('hr manager only manages non-privileged staff', () => {
    expect(teamManageError('hr_manager', 'agent', 'fulfillment')).toBeNull();
    expect(teamManageError('hr_manager', null, 'member')).toBeNull();
    expect(teamManageError('hr_manager', 'admin')).not.toBeNull();
    expect(teamManageError('hr_manager', 'hr_manager')).not.toBeNull();
    expect(teamManageError('hr_manager', 'agent', 'admin')).not.toBeNull();
    expect(teamManageError('hr_manager', null, 'hr_manager')).not.toBeNull();
  });

  it('other roles manage nobody', () => {
    expect(teamManageError('agent', 'member')).not.toBeNull();
  });
});

describe('FeatureService.resolve', () => {
  it('grant keys default off, on only when granted', () => {
    const r = FeatureService.resolve({ feature_overrides: { growth: 'on', tickets: 'off' } });
    expect(r.modules.growth).toBe(true);
    expect(r.modules.tickets).toBe(false);
    expect(r.modules.calls).toBe(false);
  });

  it('legacy columns: override wins, else column', () => {
    const r = FeatureService.resolve({
      feature_overrides: { pr: 'off' },
      content_enabled: true,
      pr_enabled: true,
      inventory_enabled: false,
    });
    expect(r.modules.content).toBe(true);
    expect(r.modules.pr).toBe(false);
    expect(r.modules.inventory).toBe(false);
  });

  it('sub-switches need their parent', () => {
    expect(FeatureService.resolve({ feature_overrides: { growth_publish: 'on' } }).modules.growth_publish).toBe(false);
    expect(FeatureService.resolve({ feature_overrides: { growth: 'on', growth_publish: 'on' } }).modules.growth_publish).toBe(true);
    expect(FeatureService.resolve({ feature_overrides: { payroll: 'on' } }).modules.payroll).toBe(false);
  });

  it('calls seat cap', () => {
    expect(FeatureService.resolve({ feature_overrides: { calls_max_agents: 5 } }).callsMaxAgents).toBe(5);
    expect(FeatureService.resolve({ feature_overrides: null }).callsMaxAgents).toBeNull();
  });
});
