import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);
  private readonly isProduction: boolean;

  constructor() {
    // ConfigService is not injected here because this filter is used globally
    // before the DI container is fully set up in some edge cases.
    this.isProduction = process.env.NODE_ENV === 'production';
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    // Machine-readable error code (+ its extra fields) when a handler throws
    // `new XException({ code, message, ... })` — e.g. WORK_HOURS_LOCKED.
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : (exceptionResponse as { message?: string }).message ??
            exception.message;
      if (exceptionResponse && typeof exceptionResponse === 'object') {
        const { code: c, message: _m, statusCode: _s, error: _e, ...rest } = exceptionResponse as Record<string, unknown>;
        if (typeof c === 'string') {
          code = c;
          details = rest;
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    }

    response.status(status).json({
      success: false,
      data: null,
      message: Array.isArray(message) ? message.join('; ') : message,
      ...(code ? { code, details } : {}),
    });
  }
}
