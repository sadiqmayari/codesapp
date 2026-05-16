import { IsString, MinLength } from 'class-validator';

export class Step1MetaAppDto {
  @IsString()
  @MinLength(1)
  metaAppId!: string;
}
