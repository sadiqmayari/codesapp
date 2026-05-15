import { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { JobQueueService } from '../../common/services/job-queue.service';
export declare class MetaWebhookController {
    private readonly config;
    private readonly jobQueue;
    private readonly logger;
    constructor(config: ConfigService, jobQueue: JobQueueService);
    verify(mode: string, token: string, challenge: string, res: Response): void;
    receive(req: RawBodyRequest<Request>, signature: string | undefined, res: Response): Promise<void>;
    verifySignature(signatureHeader: string, rawBody: Buffer, appSecret: string): boolean;
}
