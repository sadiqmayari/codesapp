import { IsString, MaxLength, MinLength } from 'class-validator';

export class AddLabelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  label!: string;
}
