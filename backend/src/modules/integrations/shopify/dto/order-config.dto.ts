import {
  IsArray,
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

  @IsOptional()
  @IsInt()
  @Min(1)
  abandonedCartDelayMinutes?: number;

  // Multi-step abandoned-cart recovery sequence. Each step: delay + approved
  // template + variable map. Empty/absent = single legacy template.
  @IsOptional()
  @IsArray()
  abandonedCartSteps?: Array<{
    delayMinutes?: number;
    templateId?: number | null;
    variableMap?: Record<string, string>;
  }>;

}

/**
 * Block 5 — the MANUAL abandoned-cart message template (per-row "Send message"
 * button). Its own endpoint, like the order-confirmation template; the timed
 * auto-send stays under delivery notifications. Null templateId clears it.
 */
export class ShopifyAbandonedTemplateDto {
  @IsOptional()
  @IsInt()
  templateId?: number | null;

  @IsOptional()
  variableMap?: Record<string, string>;
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
