import { IsIn, IsOptional } from 'class-validator';

export class UpdateTeamMemberDto {
  @IsOptional()
  @IsIn([
    'admin',
    'agent',
    'finance',
    'fulfillment',
    'content_manager',
    'pr_manager',
  ])
  role?:
    | 'admin'
    | 'agent'
    | 'finance'
    | 'fulfillment'
    | 'content_manager'
    | 'pr_manager';

  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';
}
