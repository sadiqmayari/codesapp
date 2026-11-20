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
    'creative_executive',
    'social_media_executive',
    'videographer',
    'graphic_designer',
    'member',
    'hr_manager',
  ])
  role?:
    | 'admin'
    | 'agent'
    | 'finance'
    | 'fulfillment'
    | 'content_manager'
    | 'pr_manager'
    | 'creative_executive'
    | 'social_media_executive'
    | 'videographer'
    | 'graphic_designer'
    | 'member'
    | 'hr_manager';

  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';
}
