import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// Block 1 — Credentials (webhook secret / admin token / domain / version).
export class ShopifyCredentialsDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  webhookSecret?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  adminToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  shopDomain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  apiVersion?: string;
}

// Block 2 — Template (approved template + variable mapping + enabled).
export class ShopifyTemplateDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsInt()
  templateId?: number | null;

  @IsObject()
  variableMap!: Record<string, string>;
}

// Delivery notifications — master toggle + a per-event config map keyed by
// event_key (order_fulfilled, order_cancelled, out_for_delivery, delivered,
// attempted, failed). Each value: { templateId, variableMap, enabled }.
export class ShopifyProactiveDto {
  @IsBoolean()
  enabled!: boolean;

  @IsObject()
  notifications!: Record<
    string,
    {
      templateId?: number | null;
      variableMap?: Record<string, string>;
      enabled?: boolean;
    }
  >;
}

// Block 3 — Tags (confirm / cancel / pending + decision window).
export class ShopifyTagsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  confirmTag!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  cancelTag!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  pendingTag?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  decisionWindowMinutes?: number;
}
