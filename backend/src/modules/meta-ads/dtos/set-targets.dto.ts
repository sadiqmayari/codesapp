import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ProductTargetItemDto {
  @IsString()
  @MaxLength(255)
  productKey!: string;

  @IsNumber()
  @Min(0)
  targetValue!: number;

  @IsNumber()
  @Min(0)
  targetUnits!: number;
}

export class SetTargetsDto {
  // Calendar month the targets apply to, "YYYY-MM".
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'month must be "YYYY-MM"' })
  month!: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ProductTargetItemDto)
  items!: ProductTargetItemDto[];
}
