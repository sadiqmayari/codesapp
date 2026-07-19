import { IsArray, IsObject, IsOptional } from 'class-validator';

/**
 * Loose shape — the service deep-merges these onto DEFAULT_GAME_CONFIG and
 * sanitizes every field (numbers coerced/clamped, unknown keys dropped), so the
 * DTO only needs to gate the top-level types. See GamificationService.updateConfig.
 */
export class UpdateGameConfigDto {
  @IsOptional()
  @IsObject()
  points?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  speed?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  badges?: Array<Record<string, unknown>>;
}
