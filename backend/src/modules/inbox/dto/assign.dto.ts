import { IsInt, IsPositive, ValidateIf } from 'class-validator';

export class AssignDto {
  // null = unassign. A positive int = assign to that company user.
  @ValidateIf((o) => o.userId !== null)
  @IsInt()
  @IsPositive()
  userId!: number | null;
}
