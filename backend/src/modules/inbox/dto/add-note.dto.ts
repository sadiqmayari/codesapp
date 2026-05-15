import { IsString, MaxLength, MinLength } from 'class-validator';

export class AddNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8192)
  body!: string;
}
