import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LATE_METHODS, OVERTIME_METHODS } from '../payroll';

export class PayrollPolicyDto {
  @IsOptional()
  @IsIn(LATE_METHODS)
  lateMethod?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  latesPerAbsent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  lateFixedAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(600)
  halfDayAfterMin?: number;

  @IsOptional()
  @IsIn(OVERTIME_METHODS)
  overtimeMethod?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  overtimeMultiplier?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  overtimeFlatRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(600)
  minOvertimeMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  workingDaysPerMonth?: number;
}

export class AllowanceDto {
  @IsString()
  @MaxLength(60)
  label!: string;

  @IsNumber()
  amount!: number;
}
