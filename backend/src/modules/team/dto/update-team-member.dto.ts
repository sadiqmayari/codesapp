import { IsIn, IsOptional } from 'class-validator';

export class UpdateTeamMemberDto {
  @IsOptional()
  @IsIn(['admin', 'agent', 'finance', 'fulfillment'])
  role?: 'admin' | 'agent' | 'finance' | 'fulfillment';

  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';
}
