import { IsDateString } from 'class-validator';

export class ScheduleBroadcastDto {
  @IsDateString()
  runAt!: string;
}
