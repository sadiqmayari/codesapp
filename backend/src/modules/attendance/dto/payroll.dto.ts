import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';
import { AUTO_CHECKOUT_PENALTIES, DAY_RATE_BASES, LATE_METHODS, OVERTIME_METHODS } from '../payroll';
import { ADJUSTMENT_KINDS } from '../payroll-math';

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

  @IsOptional()
  @IsIn(DAY_RATE_BASES)
  dayRateBasis?: string;

  @IsOptional()
  @IsBoolean()
  otOnlyAfterShiftEnd?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(44640)
  otMonthlyCapMin?: number;

  @IsOptional()
  @IsIn(AUTO_CHECKOUT_PENALTIES)
  autoCheckoutPenalty?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => StatutoryDto)
  statutory?: StatutoryDto[];

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;
}

export class StatutoryDto {
  @IsString()
  @MaxLength(60)
  label!: string;

  @IsIn(['fixed', 'percent'])
  type!: 'fixed' | 'percent';

  @IsNumber()
  @Min(0)
  value!: number;
}

export class AdjustmentDto {
  @IsInt()
  userId!: number;

  @IsString()
  month!: string;

  @IsIn(ADJUSTMENT_KINDS as unknown as string[])
  kind!: string;

  @IsString()
  @MaxLength(120)
  label!: string;

  @IsNumber()
  @Min(0.01)
  @Max(100000000)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

export class HolidayDto {
  @IsString()
  date!: string;

  @IsString()
  @MaxLength(120)
  name!: string;
}

export class AllowanceDto {
  @IsString()
  @MaxLength(60)
  label!: string;

  @IsNumber()
  @Min(0)
  amount!: number;
}
