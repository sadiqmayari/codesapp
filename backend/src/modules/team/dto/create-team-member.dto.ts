import { IsEmail, IsIn, IsString, MinLength, MaxLength } from 'class-validator';

export class CreateTeamMemberDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsEmail()
  email!: string;

  @IsIn(['admin', 'agent'])
  role!: 'admin' | 'agent';

  @IsString()
  @MinLength(8)
  password!: string;
}
