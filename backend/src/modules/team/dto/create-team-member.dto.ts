import { IsEmail, IsIn, IsString, MinLength, MaxLength } from 'class-validator';

export class CreateTeamMemberDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsEmail()
  email!: string;

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
  ])
  role!:
    | 'admin'
    | 'agent'
    | 'finance'
    | 'fulfillment'
    | 'content_manager'
    | 'pr_manager'
    | 'creative_executive'
    | 'social_media_executive'
    | 'videographer'
    | 'graphic_designer';

  @IsString()
  @MinLength(8)
  password!: string;
}
