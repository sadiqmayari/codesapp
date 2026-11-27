import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AD_PLATFORMS } from '../platforms/ad-platform.types';
import { MODELS } from '../attribution/attribution';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Every Growth read takes tenant-local calendar days (YYYY-MM-DD). */
export class GrowthRangeDto {
  @Matches(DAY, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @Matches(DAY, { message: 'to must be YYYY-MM-DD' })
  to!: string;

  @IsOptional()
  @IsIn(['prev', 'yoy', 'none'])
  compare?: 'prev' | 'yoy' | 'none';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  storeId?: number;

  @IsOptional()
  @IsIn(MODELS)
  model?: (typeof MODELS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 7, 28])
  win?: number;
}

export class GrowthStoreDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  storeId?: number;
}

export class ConnectAdAccountDto {
  @IsIn(AD_PLATFORMS)
  platform!: (typeof AD_PLATFORMS)[number];

  @IsString()
  @Matches(/^(act_)?[\w-]{3,64}$/, { message: 'Enter the ad account id' })
  externalId!: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  token?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  storeId?: number | null;
}

export class UpdateAdAccountDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  syncIntervalMin?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  storeId?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  token?: string | null;

  @IsOptional()
  @IsBoolean()
  capiEnabled?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^\d{5,32}$/, { message: 'Dataset (pixel) id is numeric' })
  capiDatasetId?: string | null;
}

class AskTurnDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(4000)
  text!: string;
}

export class AskGrowthDto extends GrowthRangeDto {
  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  question!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AskTurnDto)
  history?: AskTurnDto[];
}

export class GoogleAuthUrlDto {
  @IsIn(['ads', 'youtube'])
  purpose!: 'ads' | 'youtube';
}

export class GoogleExchangeDto {
  @IsString()
  @MinLength(4)
  @MaxLength(1024)
  code!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(512)
  state!: string;
}

export class GoogleConnectDto {
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  pickId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  customerIds!: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  storeId?: number | null;
}

export class YoutubeConnectDto {
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  pickId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  channelIds!: string[];
}

export class YoutubeOverviewDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  channelId?: number;
}

export class TikTokExchangeDto {
  @IsString()
  @MinLength(4)
  @MaxLength(512)
  authCode!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(512)
  state!: string;
}

export class TikTokConnectDto {
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  pickId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  advertiserIds!: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  storeId?: number | null;
}
