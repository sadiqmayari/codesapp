import { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
export declare class SuperAdminIpGuard implements CanActivate {
    private readonly config;
    private readonly logger;
    constructor(config: ConfigService);
    canActivate(context: ExecutionContext): boolean;
    private inCidr;
    private toLong;
    private suggestCidr;
}
