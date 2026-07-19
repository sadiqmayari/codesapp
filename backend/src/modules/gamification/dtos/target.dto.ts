import { IsIn, IsInt, IsNumber, Min } from 'class-validator';
import { GAME_METRICS, GameMetric } from '../gamification.constants';

export type TargetPeriod = 'daily' | 'weekly' | 'monthly';
export const TARGET_PERIODS: TargetPeriod[] = ['daily', 'weekly', 'monthly'];

export class SetTargetDto {
  @IsInt()
  @Min(1)
  userId!: number;

  @IsIn(GAME_METRICS)
  metric!: GameMetric;

  @IsNumber()
  @Min(0)
  targetValue!: number;

  @IsIn(TARGET_PERIODS)
  periodType!: TargetPeriod;
}
