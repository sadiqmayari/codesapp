import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateTicketEventDto {
  @IsString()
  @MaxLength(5000)
  body!: string;
}
