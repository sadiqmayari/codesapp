import { IsInt, IsPositive } from 'class-validator';

export class AssignDto {
  @IsInt()
  @IsPositive()
  userId!: number;
}
