import { IsEmail, IsIn, IsString, MinLength, MaxLength } from 'class-validator';

export class CreateTeamMemberDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsEmail()
  email!: string;

  @IsIn(['admin', 'agent', 'finance'])
  role!: 'admin' | 'agent' | 'finance';

  @IsString()
  @MinLength(8)
  password!: string;
}
