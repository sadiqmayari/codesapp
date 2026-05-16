import { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
export declare class CronGuard implements CanActivate {
    private readonly config;
    constructor(config: ConfigService);
    private static safeEqual;
    canActivate(context: ExecutionContext): boolean;
}
