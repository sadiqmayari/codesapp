import { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
export declare class HttpExceptionFilter implements ExceptionFilter {
    private readonly logger;
    private readonly isProduction;
    constructor();
    catch(exception: unknown, host: ArgumentsHost): void;
}
