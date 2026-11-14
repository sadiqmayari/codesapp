import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

/** A change list: [{kind:'patch',level,entityId,patch}] | [{kind:'scale',campaignId,pct}]. Shape is checked in AdManageService. */
export class ManageChangesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  changes!: Array<Record<string, unknown>>;
}

export class ManageUndoDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  logId?: number;

  @IsOptional()
  @IsUUID()
  batchId?: string;
}

export class ManageEntityDto {
  @IsIn(['campaign', 'adset', 'ad'])
  level!: 'campaign' | 'adset' | 'ad';

  @IsString()
  @MaxLength(64)
  entityId!: string;
}

export class ManageLogDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class CreateAccountDto {
  @Type(() => Number)
  @IsInt()
  accountId!: number;
}

export class CitySearchDto extends CreateAccountDto {
  @IsString()
  @MaxLength(80)
  q!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;
}

export class CreateCampaignDto extends CreateAccountDto {
  @IsObject()
  draft!: Record<string, unknown>;
}

export class SaveDraftDto {
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown> | null;
}

export class TargetQueryDto {
  @IsString()
  @MaxLength(7)
  month!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  storeId?: number;
}

export class SetTargetDto extends TargetQueryDto {
  /** null / 0 clears the target. */
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  netSalesTarget!: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ordersTarget?: number | null;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  adBudget?: number | null;
}
