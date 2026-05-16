import { IsString, MinLength } from 'class-validator';

export class Step3AccessTokenDto {
  @IsString()
  @MinLength(10)
  accessToken!: string;
}
